"""NER 覆盖度测量：语义实体到底脱干净了没有（2026-09-24 审计工具）。

不进单测套件（要加载模型、跑几十秒），手动/发版前跑：
    python tests/measure_ner_coverage.py                # 用当前策略，期望 0 泄漏
    python tests/measure_ner_coverage.py --budget 2.0    # 复现旧策略的漏检
    python tests/measure_ner_coverage.py --sizes 60,200,600

**为什么需要它**：`_ner_doc_budget` 这类限流参数写错时，症状是**静默降级** ——
正则能抓的东西照常打码，只有 NER 能识别的中文实体（人名/机构/详细地址）明文上行，
而事件行、日志、单测全都正常。固定 2.0s 的总预算就是这么漏的：实测 200 条/43KB 的
会话里 **96/200 个 NER-only 中文人名明文出网**，60 条/13KB 时却一个不漏（成本没到 2s）。
这种「只在长会话上出现」的洞，只有按体积标定的测量才能发现。

判据：
  1. 人名明文出网数必须为 0（当前策略下）；
  2. 单条超长叶子（旧上限 2000 字、实测真实流量里出现过 6208 字）里的实体也必须被打码；
  3. 顺带打印每档体积的耗时，用于标定 `transparent._ner_req_budget` 的取值。
"""
import argparse
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "engine"))
sys.path.insert(0, str(ROOT))

import transparent as tr          # noqa: E402
import ner_engine                 # noqa: E402

SUR = list("陈赵林黄吴郑许曾赖洪沈范简龚温骆柏戚邹宋唐冯于董萧程曹袁邓傅彭蒋韩杨朱秦尤何吕施张孔严金魏陶姜")
GIV = ["阿明", "慧敏", "嘉豪", "志强", "佩珊", "文杰", "雅婷", "子睿", "俊宏", "淑芬",
       "国华", "美玲", "柏翰", "子涵", "佩君", "雅雯", "家豪", "俊杰", "志豪", "美惠",
       "雅玲", "文豪", "佩玲", "嘉玲"]
NAMES = [SUR[i % len(SUR)] + GIV[(i // len(SUR)) % len(GIV)] for i in range(1200)]
FILLER = "今天先把设计稿最后两页过一遍，确认配色与间距没有偏差，然后同步给团队。" * 2


def _prepare():
    """只留「正则抓不到、只能靠 NER」的场景：清空自定义词与禁用集。"""
    tr.NER_ENABLED = True
    tr.CUSTOM_WORDS.clear()
    tr._CUSTOM_WORD_FWD.clear()
    tr._CUSTOM_WORD_REV.clear()
    tr._CUSTOM_WORDS_SORTED = ()
    tr._CUSTOM_WORD_RX_CACHE.clear()
    tr.SENSITIVE_DISABLED = set()
    tr.SENSITIVE_WORD_DISABLED = {}
    tr.SENSITIVE_WORD_WHOLE = set()
    tr.BUILTIN_RULES = dict(tr.DEFAULT_BUILTIN_RULES)
    tr.sessions.clear()


def _measure(n_msgs, budget):
    leaves = ["%s %s" % (NAMES[i % len(NAMES)], FILLER) for i in range(n_msgs)]
    names = NAMES[:min(n_msgs, len(NAMES))]
    ner_engine._CACHE.clear()                 # 冷缓存：最坏情况
    ner_engine._CACHE_CHARS = 0
    tr._RECENT_FWD.clear()
    tr._RECENT_REV.clear()
    tr._RECENT_SUFFIX.clear()
    body_bytes = sum(len(t.encode("utf-8")) for t in leaves)
    sid = "coverage-%d-%s" % (n_msgs, budget)
    t0 = time.perf_counter()
    if budget:
        with tr._ner_doc_budget(budget):
            outs = [tr.mask(t, sid) for t in leaves]
    else:
        with tr._ner_doc_budget(tr._ner_req_budget(body_bytes)):
            outs = [tr.mask(t, sid) for t in leaves]
    took = time.perf_counter() - t0
    leaks = [n for n in names if any(n in o for o in outs)]
    skips = ner_engine.request_skips()
    return body_bytes, leaks, len(names), took, skips


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sizes", default="60,200,600", help="会话条数（逗号分隔）")
    ap.add_argument("--budget", type=float, default=None,
                    help="固定预算（秒）；缺省用当前策略 _ner_req_budget(体积)")
    ap.add_argument("--old-limits", action="store_true",
                    help="反例对照：复现修复前口径（总预算固定 2.0s + 单条上限 2000 字）")
    args = ap.parse_args()

    if args.old_limits:
        args.budget = 2.0
        ner_engine.MAX_TEXT_CHARS = 2000

    _prepare()
    if not ner_engine.is_ner_available():
        print("SKIP: 本地没有语义模型，无法测量")
        return 0
    print("策略：%s | 单条上限 %d 字 | 单次调用上限 %.1fs"
          % ("固定 %.1fs" % args.budget if args.budget else
             "按体积伸缩 base=%.0fs +%.0fs/MB cap=%.0fs"
             % (tr._NER_REQ_BUDGET_BASE_S, tr._NER_REQ_BUDGET_PER_MB_S, tr._NER_REQ_BUDGET_MAX_S),
             ner_engine.MAX_TEXT_CHARS, ner_engine.CALL_BUDGET_S))
    print("%-16s %-10s %-9s %-8s %s" % ("会话规模", "体积", "耗时", "人名泄漏", "跳过原因"))

    ok = True
    for n in [int(x) for x in args.sizes.split(",") if x.strip()]:
        body_bytes, leaks, total, took, skips = _measure(n, args.budget)
        print("%-16s %-10s %-9s %-8s %s"
              % ("%d 条" % n, "%.1fKB" % (body_bytes / 1024.0), "%.2fs" % took,
                 "%d/%d" % (len(leaks), total), skips or "-"))
        if leaks and args.budget is None:
            ok = False
            print("   FAIL: 前几个泄漏的人名 %s" % leaks[:5])

    # 单条超长叶子（旧上限 2000 字；真实流量里出现过 6208 字）。
    # ⚠️ 必须真的超过旧上限，否则这条检查对「整条不做 NER」的旧行为没有鉴别力。
    long_name = NAMES[7]
    long_leaf = "%s %s" % (long_name, FILLER * 90)   # ≈6.3k 字，对齐真实流量
    assert len(long_leaf) > 2000
    with tr._ner_doc_budget(tr._ner_req_budget(len(long_leaf.encode()))):
        out = tr.mask(long_leaf, "coverage-long")
    masked_ok = long_name not in out
    print("单条 %d 字长叶子：%s" % (len(long_leaf), "已打码" if masked_ok else "FAIL 未打码"))
    ok = ok and masked_ok

    # 超长**无实体**叶子的缓存行为：这是一条很贵的稳态陷阱。
    # 单次调用上限若小于「跑完这么长的成本」，每次都是 complete=False → 负缓存**不写**
    # （见 ner_engine.extract_entities 的注释）→ 下一轮同一段文本又从头冷推。
    # 实测：旧 CALL_BUDGET_S=2.0 + MAX_TEXT_CHARS=20000 → 2123ms / 2013ms / 2049ms，
    # 缓存条数恒为 0。真实流量里的长系统提示词恰好就是这种「长且无实体」的文本。
    unit = ("本系统提示词描述了工具调用规范、错误处理约定与输出格式要求，"
            "请在回答时严格遵守以下流程：先分析再结论，结论要给出依据。")
    n_max = ner_engine.MAX_TEXT_CHARS
    long_noent = (unit * (n_max // len(unit) + 1))[:n_max]
    ner_engine._CACHE.clear()
    ner_engine._CACHE_CHARS = 0
    times = []
    with tr._ner_doc_budget(tr._ner_req_budget(len(long_noent.encode()))):
        for _ in range(3):
            t0 = time.perf_counter()
            tr.mask(long_noent, "coverage-longcache")
            times.append((time.perf_counter() - t0) * 1000)
    # 第 2、3 轮必须走缓存（毫秒级）；否则说明单次上限不够跑完，每轮都在重付
    cache_ok = times[-1] < max(200.0, times[0] * 0.1)
    print("无实体长叶子(%d 字，上限内) 三轮耗时 %s ms → %s"
          % (n_max, " / ".join("%.0f" % t for t in times),
             "已进缓存" if cache_ok else "FAIL 每轮重付冷推理"))
    ok = ok and cache_ok

    print("MEASURE OK" if ok else "MEASURE FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
