#!/usr/bin/env python3
"""按标签定向清理事件库的 `daily_words` 词级明细（运维工具，默认只读演练）。

**为什么需要它**：面板的「清空日志」走 `event_store.clear_events()`，删的是
**全部日期**的 `daily_words` —— 只想清掉某一类误报词条时太钝；而 `daily_words`
在引擎运行时被写线程持续增量维护，直接手写 SQL 改库容易撞上并发写。

**它不做什么**（刻意的）：
- 不碰 `daily_stats` / `daily_status` / `daily_tokens`。这三张是纯数字表，项目口径是
  「清日志不清统计」。代价是**今日脱敏总数不会跟着变小**，词明细的合计会与它不一致——
  脚本会把差额打出来，别以为脚本没生效。
- 不改 `events`（原始事件明细）。要清明细请用面板的「清空日志」。

**用法**：

    # 演练（默认）：只打印将要删除的行，不写库
    python scripts/purge-daily-words.py

    # 真删：清掉今天所有 CONNSTR 词条
    python scripts/purge-daily-words.py --yes

    # 清掉全部保留期内的 CONNSTR 词条（误报会跨天累积时用）
    python scripts/purge-daily-words.py --day all --yes

    # 指定库文件 / 指定标签
    python scripts/purge-daily-words.py --db "%APPDATA%\\Maskit\\shield-events.sqlite3" --label EMAIL --yes

库文件解析顺序：`--db` → 环境变量 `LLM_SHIELD_DATA_DIR`（与引擎同口径）→
`%APPDATA%\\Maskit\\shield-events.sqlite3`（桌面版默认）→ `engine/shield-events.sqlite3`（源码态）。
脚本总会先打印实际选中的库，选错了就在第一行看出来。

写库前会：① 检查引擎是否在运行（`shield.pid`），在跑就拒绝，除非 `--force`；
② 通过 SQLite 在线备份（`conn.backup`）生成自洽快照 `<库名>.bak-purge-<时间戳>`（WAL 模式安全），失败即中止。
"""
import argparse
import os
import shutil
import sqlite3
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_LABEL = "CONNSTR"


def resolve_db(explicit: str) -> Path:
    """按「显式参数 → 引擎同款环境变量 → 桌面版默认 → 源码态默认」解析库文件。"""
    if explicit:
        return Path(explicit).expanduser().resolve()
    env = os.environ.get("LLM_SHIELD_DATA_DIR")
    if env:
        return (Path(env) / "shield-events.sqlite3").resolve()
    appdata = os.environ.get("APPDATA")
    if appdata:
        packaged = Path(appdata) / "Maskit" / "shield-events.sqlite3"
        if packaged.exists():
            return packaged.resolve()
    return (ROOT / "engine" / "shield-events.sqlite3").resolve()


def engine_running(db: Path) -> bool:
    """同目录下 shield.pid 指向的进程是否还活着（探活失败一律按「没在跑」处理）。"""
    pid_file = db.parent / "shield.pid"
    try:
        pid = int(pid_file.read_text(encoding="utf-8").strip())
    except Exception:
        return False
    if pid <= 0:
        return False
    if os.name == "nt":
        try:
            out = os.popen(f'tasklist /FI "PID eq {pid}" /NH').read()
        except Exception:
            return False
        return str(pid) in out
    try:
        os.kill(pid, 0)
        return True
    except Exception:
        return False


def label_summary(conn, where: str, params) -> list:
    return conn.execute(
        f"SELECT day, COUNT(*), SUM(cnt) FROM daily_words WHERE {where} GROUP BY day ORDER BY day",
        params,
    ).fetchall()


def main() -> int:
    ap = argparse.ArgumentParser(description="按标签定向清理 daily_words（默认只演练）")
    ap.add_argument("--db", help="事件库路径；默认按引擎同款顺序自动解析")
    ap.add_argument("--label", default=DEFAULT_LABEL, help=f"标签，默认 {DEFAULT_LABEL}")
    ap.add_argument("--day", default=time.strftime("%Y-%m-%d"),
                    help="日期 YYYY-MM-DD，或 all（全部保留期），默认今天")
    ap.add_argument("--yes", action="store_true", help="真的写库；不给则只演练")
    ap.add_argument("--force", action="store_true", help="引擎在运行时也强行写库（不推荐）")
    args = ap.parse_args()

    db = resolve_db(args.db)
    print(f"事件库: {db}")
    if not db.exists():
        print("!! 库文件不存在。桌面版请加 --db 指向 %APPDATA%\\Maskit\\shield-events.sqlite3")
        return 2
    stat = db.stat()
    print(f"        {stat.st_size / 1048576:.1f} MB, mtime {time.strftime('%Y-%m-%d %H:%M', time.localtime(stat.st_mtime))}")

    if not args.yes:
        print("模式: 演练（只读，不会写库）")
    elif engine_running(db) and not args.force:
        print("!! 引擎正在运行（shield.pid 存活）。请先在面板停止/退出引擎，或加 --force")
        return 3

    if args.day == "all":
        where, params = "label = ?", (args.label,)
        scope = "全部保留期"
    else:
        where, params = "day = ? AND label = ?", (args.day, args.label)
        scope = args.day

    conn = sqlite3.connect(f"file:{db}?mode={'rw' if args.yes else 'ro'}", uri=True, timeout=5)
    try:
        conn.execute("PRAGMA busy_timeout=5000")
        rows = label_summary(conn, where, params)
        if not rows:
            print(f"\n{scope} 下没有 label={args.label} 的词条，无需清理。")
            return 0

        total = sum(r[2] or 0 for r in rows)
        print(f"\n将删除 {scope} 的 label={args.label} 词条：")
        for day, n_words, n_hits in rows:
            print(f"  {day}  {n_words} 个词条 / {n_hits} 次命中")
        print(f"  合计 {len(rows)} 天、{total} 次命中")

        if args.day != "all":
            n_mask = conn.execute(
                "SELECT COALESCE(SUM(count_sum), 0) FROM daily_stats WHERE day = ? AND type = 'MASK'",
                (args.day,),
            ).fetchone()[0]
            print(f"\n注意: daily_stats（纯数字表）本脚本不动它 —— {args.day} 的脱敏总数仍是 "
                  f"{n_mask}，不会跟着变小；词明细的合计会与它对不上，这是预期结果。")
        else:
            print("\n注意: daily_stats（纯数字表）本脚本不动它 —— 各日「脱敏总数」不会跟着变小，"
                  "词明细的合计会与它对不上，这是预期结果。")

        if not args.yes:
            print("\n演练结束。确认无误后加 --yes 执行。")
            return 0

        backup = db.with_name(f"{db.name}.bak-purge-{time.strftime('%Y%m%d-%H%M%S')}")
        try:
            bck_conn = sqlite3.connect(backup)
            with bck_conn:
                conn.backup(bck_conn)
            bck_conn.close()
        except Exception as e:
            print(f"!! 备份失败: {e}，已中止（未写库）")
            if backup.exists():
                try:
                    backup.unlink()
                except OSError:
                    pass
            return 4

        if not backup.exists() or backup.stat().st_size == 0:
            print("!! 备份校验失败（产物为空），已中止（未写库）")
            return 4
        print(f"\n已备份: {backup}")

        cur = conn.execute(f"DELETE FROM daily_words WHERE {where}", params)
        conn.commit()
        print(f"已删除 {cur.rowcount} 行")
        rest = conn.execute(
            "SELECT COUNT(*), COALESCE(SUM(cnt), 0) FROM daily_words WHERE label = ?", (args.label,)
        ).fetchone()
        print(f"库中剩余 label={args.label} 词条: {rest[0]} 行 / {rest[1]} 次命中")
    finally:
        conn.close()

    print("\n完成。若引擎跑的还是旧版脱敏逻辑，同样的模板会被重新计入。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
