"""共享态并发压测（长时跑）：脱敏搬进专职线程后的多线程正确性验收。

不进单测套件（默认要跑几十秒），手动/发版前跑：
    python tests/stress_shared_state.py --seconds 60
    python tests/stress_shared_state.py --seconds 300 --threads 12 --ner

线程角色一一对应真实进程里的三类线程：

  signer   ×N  代理脱敏专职线程（`_MASK_POOL`）/ panel 扩展桥接 Flask 线程：
               反复 mask 文本 → 签发占位符、写复用表与后缀索引、读词表与规则表
  pruner   ×1  事件循环侧的会话回收：直接调 `_prune_recent`（**不节流**，走全语义）
  reloader ×1  面板保存配置触发的热重载：反复改写 config.json + `_maybe_reload(force=True)`
  ner      ×1  语义识别缓存读写（`--ner` 才开；模型缺失自动跳过）
  monitor  ×1  持续采样，记录是否出现「半填充词表」等不一致

判定（任一不满足即退出码 1）：

  1. 任何线程抛异常（含 `dictionary changed size during iteration`）；
  2. `_RECENT_FWD` / `_RECENT_REV` 不互逆，或后缀索引出现歧义标记；
  3. 采样到的 `CUSTOM_WORDS` 长度不是「两代之一」—— 半填充词表的直接证据，
     对应真实后果：那一轮少脱敏用户自定义词，明文上行；
  4. **热重载进行中也不得漏脱敏**：mask 结果里不许出现任何一个原文敏感词
     （这些词在两代配置里都存在，所以不换代的说法不能作为借口）；
  5. `ner_engine._CACHE_CHARS` 与实际键长之和一致。
"""
import argparse
import json
import sys
import tempfile
import threading
import time
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "engine"))
sys.path.insert(0, str(ROOT))

import transparent as tr           # noqa: E402
import ner_engine                  # noqa: E402

# 两代配置都包含这 20 个词（只在数量与标签上换代）→ 任何时候都不许原文出现。
# 注意形状是 `label -> [词...]`（反了就会把标签当词、词当标签，实测会直接漏脱敏）。
BASE_WORDS = ["敏感词%02d" % i for i in range(20)]
GEN_A = {"甲类": list(BASE_WORDS)}
GEN_B = {"乙类": list(BASE_WORDS) + ["额外%02d" % i for i in range(30)]}
ALLOWED_WORD_COUNTS = {sum(len(v) for v in g.values()) for g in (GEN_A, GEN_B)}


def _write_cfg(tmp, gen):
    (tmp / "config.json").write_text(
        json.dumps({"sensitive": gen, "fail_closed": True}, ensure_ascii=False),
        encoding="utf-8")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seconds", type=float, default=30.0)
    ap.add_argument("--threads", type=int, default=8)
    ap.add_argument("--ner", action="store_true", help="同时压 NER 缓存读写（需模型）")
    args = ap.parse_args()

    tmp = Path(tempfile.mkdtemp())
    tr._DATA_ROOT = tmp
    _write_cfg(tmp, GEN_A)
    tr._maybe_reload(force=True)
    tr._emit = lambda *a, **k: None
    tr.sessions.clear()
    tr._RECENT_FWD.clear()
    tr._RECENT_REV.clear()
    tr._RECENT_SUFFIX.clear()

    errors = []
    stats = Counter()
    observed_words_len = Counter()
    reload_ms = []
    stop = threading.Event()
    text = "客户%s 联系%s" % (BASE_WORDS[0], BASE_WORDS[1])

    def signer(tid):
        try:
            i = 0
            while not stop.is_set():
                out = tr.mask("编号%d %s %s" % (i, text, BASE_WORDS[2]), "st-%d" % tid)
                # 4) 热重载进行中也不许漏脱敏
                for w in BASE_WORDS[:3]:
                    if w in out:
                        errors.append("漏脱敏: %r 出现在输出里（tid=%d）" % (w, tid))
                        stop.set()
                        return
                i += 1
                stats["mask"] += 1
        except Exception as e:                                    # pragma: no cover
            errors.append("signer: %s: %s" % (type(e).__name__, e))
            stop.set()

    def pruner():
        try:
            while not stop.is_set():
                tr._prune_recent()          # 全语义清理（不节流）
                stats["prune"] += 1
        except Exception as e:                                    # pragma: no cover
            errors.append("pruner: %s: %s" % (type(e).__name__, e))
            stop.set()

    def reloader():
        try:
            gen = GEN_B
            while not stop.is_set():
                _write_cfg(tmp, gen)
                t0 = time.perf_counter()
                tr._maybe_reload(force=True)
                reload_ms.append((time.perf_counter() - t0) * 1000)
                gen = GEN_A if gen is GEN_B else GEN_B
                stats["reload"] += 1
                time.sleep(0.02)
        except Exception as e:                                    # pragma: no cover
            errors.append("reloader: %s: %s" % (type(e).__name__, e))
            stop.set()

    def ner_load():
        try:
            if not ner_engine.is_ner_available():
                stats["ner_skipped"] += 1
                return
            i = 0
            while not stop.is_set():
                for k in range(20):
                    ner_engine._cache_put("压测文本%d-%d" % (i, k), [])
                stats["ner"] += 1
                i += 1
        except Exception as e:                                    # pragma: no cover
            errors.append("ner: %s: %s" % (type(e).__name__, e))
            stop.set()

    def monitor():
        try:
            while not stop.is_set():
                observed_words_len[len(tr.CUSTOM_WORDS)] += 1
                time.sleep(0.001)
        except Exception as e:                                    # pragma: no cover
            errors.append("monitor: %s: %s" % (type(e).__name__, e))
            stop.set()

    threads = [threading.Thread(target=signer, args=(t,), daemon=True)
               for t in range(args.threads)]
    threads += [threading.Thread(target=pruner, daemon=True),
                threading.Thread(target=reloader, daemon=True),
                threading.Thread(target=monitor, daemon=True)]
    if args.ner:
        threads.append(threading.Thread(target=ner_load, daemon=True))

    print("压测 %ss：%d 个 signer + pruner + reloader%s + monitor"
          % (args.seconds, args.threads, " + ner" if args.ner else ""))
    t0 = time.perf_counter()
    for t in threads:
        t.start()
    time.sleep(args.seconds)
    stop.set()
    for t in threads:
        t.join(timeout=30)
    took = time.perf_counter() - t0

    # ---- 终局不变量 ----
    ok = True
    allowed = ALLOWED_WORD_COUNTS
    bad_lens = sorted(set(observed_words_len) - allowed)
    if bad_lens:
        ok = False
        print("FAIL: 采样到非换代长度 %s（应为 %s）→ 词表被就地改写/半填充"
              % (bad_lens, sorted(allowed)))
    if tr._SUFFIX_AMBIGUOUS in tr._RECENT_SUFFIX.values():
        ok = False
        print("FAIL: 后缀索引出现歧义标记（同一后缀指向多个 token）")
    bad_pairs = [o for o, rec in list(tr._RECENT_FWD.items())
                 if tr._RECENT_REV.get(rec[0], [None])[0] != o]
    if bad_pairs:
        ok = False
        print("FAIL: FWD/REV 不互逆 %d 例，例如 %r" % (len(bad_pairs), bad_pairs[:3]))
    if ner_engine._CACHE_CHARS != sum(len(k) for k in ner_engine._CACHE):
        ok = False
        print("FAIL: NER 缓存字符计数漂移（%d vs %d）"
              % (ner_engine._CACHE_CHARS, sum(len(k) for k in ner_engine._CACHE)))
    if errors:
        ok = False
        print("FAIL: 线程异常 %d 例：" % len(errors))
        for e in errors[:5]:
            print("   -", e)

    print("耗时 %.1fs｜mask %d 次｜prune %d 次｜reload %d 次｜ner %d 批%s"
          % (took, stats["mask"], stats["prune"], stats["reload"], stats["ner"],
             "（模型缺失已跳过）" if stats["ner_skipped"] else ""))
    if reload_ms:
        print("热重载耗时 min/avg/max = %.1f / %.1f / %.1f ms（锁争用下的等待也含在内）"
              % (min(reload_ms), sum(reload_ms) / len(reload_ms), max(reload_ms)))
    print("CUSTOM_WORDS 采样长度分布: %s（允许 %s）"
          % (dict(observed_words_len), sorted(allowed)))
    print("终局：_RECENT_FWD=%d 条，后缀索引=%d 条，NER 缓存=%d 条"
          % (len(tr._RECENT_FWD), len(tr._RECENT_SUFFIX), len(ner_engine._CACHE)))
    print("STRESS OK" if ok else "STRESS FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
