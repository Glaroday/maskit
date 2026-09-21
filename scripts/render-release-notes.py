"""从 CHANGELOG.md 提取指定版本的完整章节，作为 GitHub Release body。

CHANGELOG.md 本身就是双语（中上英下），写一次就够；发版时按版本号截取对应章节作为
Release 的 markdown body，避免每个 tag 都人工维护两套文案。

用法：
    python3 scripts/render-release-notes.py <version-without-v>

示例：
    python3 scripts/render-release-notes.py 0.2.7

除了 CHANGELOG 正文，还会在末尾附一句「本次发版需不需要重新加载浏览器扩展」。
扩展与客户端是两套独立代码，客户端升级**不会**动到已安装的扩展，所以大多数发版
用户什么都不用做；但扩展代码真的改了、用户又没重载时，会**静默失效**（页面无异常，
只是不再脱敏）。这个提示由 git 历史自动判定，不靠发布者手写。
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

# CHANGELOG.md 的二级章节标题严格是 `## [<version>]`（带方括号，便于 git diff 不混淆）。
# `## [Unreleased]` 不参与渲染——它面向下次发版，不该出现在线上 Release 页。
_HEADING_PREFIX = "## ["

# 「是否需要重载扩展」的三种措辞（双语，与 CHANGELOG 的同一条约定一致）。
# 三态而非两态：拿不到 git 历史时我们**并不知道**扩展有没有变，把它当成「没变」
# 会让用户在契约真变了的时候以为不用重载——而这正是本机制要防的事。
_EXT_NOTICE = {
    "changed": (
        "---\n\n"
        "**扩展更新提示 / Extension update notice**\n\n"
        "> ⚠️ 本次发版**扩展有改动**：请在 `chrome://extensions` 重新加载扩展"
        "（若提示新增站点权限，点允许）。\n"
        "> ⚠️ **The browser extension changed** in this release: reload it at "
        "`chrome://extensions` (allow the new site permission if prompted)."
    ),
    "unchanged": (
        "---\n\n"
        "**扩展更新提示 / Extension update notice**\n\n"
        "> ✅ 本次发版扩展无改动：已安装的扩展**无需**重新加载。\n"
        "> ✅ The browser extension did not change: **no need** to reload it."
    ),
    "unknown": (
        "---\n\n"
        "**扩展更新提示 / Extension update notice**\n\n"
        "> ℹ️ 无法自动判定扩展是否需要重新加载（缺少 git 历史或上一个版本 tag）；"
        "如扩展有改动请手动重新加载。\n"
        "> ℹ️ Could not determine whether the extension changed (missing git history "
        "or previous tag); reload it manually if it did."
    ),
}


def _git(args: list[str], cwd: Path) -> tuple[int, str]:
    """跑一条 git 命令，返回 (退出码, stdout)。git 不可用/不是仓库时返回 (127, '')。"""
    try:
        p = subprocess.run(
            ["git", *args], cwd=str(cwd), capture_output=True, text=True, timeout=20
        )
        return p.returncode, (p.stdout or "").strip()
    except (OSError, subprocess.SubprocessError):
        return 127, ""


def _prev_tag(root: Path) -> str | None:
    """发版提交的「上一个版本 tag」；取不到返回 None（不猜）。

    用 `describe --abbrev=0 HEAD^` 而不是 `tag --sort=-v:refname | head`：后者会把
    **全部** tag 按版本排序取最大的，若历史上有不连续的分支 tag 会挑错对象，
    从而把「扩展变没变」算成别的区间的结果。

    **故意不回退到 `HEAD`**：浅克隆下 `HEAD^` 取不到（release workflow 若漏了
    `fetch-depth: 0` 就是浅克隆），而 `describe HEAD` 会拿到**当前 tag 自己**，
    紧接着 `git diff <当前tag> HEAD -- extension/` 恒为空 → 把「扩展大改」算成
    「扩展无改动」的假阴性——正是这个机制要防的事。取不到就返回 None（= unknown）。
    """
    code, out = _git(["describe", "--tags", "--abbrev=0", "HEAD^"], root)
    if code == 0 and out:
        return out
    return None


def extension_changed(prev_tag: str | None, root: Path) -> bool | None:
    """相对 `prev_tag`，`extension/` 目录是否有改动。**三态**。

    返回 None 表示**无法判定**（浅克隆 / 非 git 仓库 / 没有上一个 tag），
    调用方必须把它当成「不知道」，不能退化成「没变」。
    """
    if not prev_tag:
        return None
    code, _ = _git(["diff", "--quiet", prev_tag, "HEAD", "--", "extension/"], root)
    if code == 0:
        return False
    if code == 1:
        return True
    return None


def render(
    version: str,
    changelog: Path = Path("CHANGELOG.md"),
    ext_status: str = "unknown",
) -> str:
    """返回 `## [<version>]` 标题之下、下一节标题之上的全部文本（不含标题行）。"""
    # 显式拒绝 Unreleased：它面向下次发版，不该出现在线上 Release 页。
    # 不能只靠「章节为空」兜底 —— Unreleased 一旦写进条目（发版前的正常状态），
    # 那条兜底就不再成立，误传 'Unreleased' 会把未发布内容渲染成 Release body。
    if str(version).strip().lower() == "unreleased":
        raise SystemExit(
            "render-release-notes: 'Unreleased' 不是版本号（该章节面向下次发版，"
            "不该出现在线上 Release 页）——发版前请先把条目移到正式版本章节"
        )
    text = changelog.read_text(encoding="utf-8")
    needle = f"## [{version}]"

    lines = text.splitlines()
    start = next(
        (i + 1 for i, line in enumerate(lines) if line.startswith(needle)),
        None,
    )
    if start is None:
        raise SystemExit(f"render-release-notes: version {version!r} not found in {changelog}")

    end = len(lines)
    for j in range(start, len(lines)):
        if lines[j].startswith(_HEADING_PREFIX):
            end = j
            break

    body = "\n".join(lines[start:end]).rstrip()
    if not body.strip():
        raise SystemExit(
            f"render-release-notes: version {version!r} section is empty in {changelog}"
        )
    return body + "\n\n" + _EXT_NOTICE.get(ext_status, _EXT_NOTICE["unknown"])


def main(argv: list[str]) -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "version",
        help="版本号，例如 0.2.7（不要带 v 前缀，CI 会从 GITHUB_REF_NAME 自己剥）",
    )
    parser.add_argument(
        "--changelog",
        default="CHANGELOG.md",
        type=Path,
        help="CHANGELOG 文件路径（默认 ./CHANGELOG.md）",
    )
    parser.add_argument(
        "--repo-root",
        default=".",
        type=Path,
        help="仓库根目录（默认当前目录）；用于定位 extension/ 与 git 历史",
    )
    args = parser.parse_args(argv)

    root = args.repo_root
    changed = extension_changed(_prev_tag(root), root)
    ext_status = {True: "changed", False: "unchanged"}.get(changed, "unknown")

    sys.stdout.write(render(args.version, args.changelog, ext_status))
    sys.stdout.write("\n")


if __name__ == "__main__":
    main(sys.argv[1:])