#!/usr/bin/env python3
"""自动组装 Tauri 更新元数据 latest.json。

在指定目录下查找已签名的安装包（*.exe.sig），解析签名与版本信息，
生成符合 tauri-plugin-updater 规范的 latest.json。

用法：
  python scripts/generate-latest-json.py <目录路径> [--tag <tag>] [--repo <owner/repo>]
"""
import argparse
import datetime
import glob
import json
import os
import sys
from pathlib import Path


def _release_notes(tag: str, changelog_path: Path | None = None) -> str:
    """从 CHANGELOG 的对应版本章节生成**简短**中英双语更新说明。

    为什么不用整章：更新器弹窗只有几行高度，0.4.0 的章节有 2509 字节双语条目，
    全部塞进去用户得滚半天才看完，反而没人读。所以只取「新增/修复/优化」的条数做
    摘要，细节留给 Release 页（那里的 body 由 render-release-notes.py 切出全文）。

    找不到章节/文件时（例如刚建的仓库或手工打的 tag）回退到通用文案 ——
    说明文案不完整可以接受，但绝不能因此让发版流程失败。
    """
    fallback = f"Data Maskit {tag} 发布更新。"
    try:
        # 默认从仓库根的 CHANGELOG 读；参数用于单测注入临时文件。
        changelog = changelog_path or (Path(__file__).resolve().parent.parent / "CHANGELOG.md")
        text = changelog.read_text(encoding="utf-8")
    except OSError:
        return fallback

    import re as _re
    ver = tag.lstrip("v")
    sec = _re.search(
        rf"^##\s*\[{_re.escape(ver)}\][^\n]*\n(.*?)(?=^##\s*\[|\Z)",
        text, _re.S | _re.M,
    )
    if not sec:
        return fallback
    body = sec.group(1)

    # 分节标题要**中英都能认**：CHANGELOG 用的是「### 新增 / Added」这种双语标题，
    # 但只带英文（### Added）或只带中文的写法也可能出现，因此两者任意命中即可。
    # 英文侧用词干（add / fix / chang）而不是全词：标题里可能是 Fixed 也可能是
    # Fixes、Changed 或 Changes，写死全词会整节漏算（漏一节只是摘要少一项，
    # 但那是静默的错数字，比报错更难发现）。
    labels = (("新增", "add", "Added"), ("修复", "fix", "Fixed"), ("优化", "chang", "Changed"))
    parts_cn: list[str] = []
    parts_en: list[str] = []
    for cn, en_kw, en_out in labels:
        m = _re.search(
            rf"^###[^\n]*(?:{cn}|{en_kw})[^\n]*\n(.*?)(?=^###|\Z)",
            body, _re.S | _re.M | _re.I,
        )
        if not m:
            continue
        n = len(_re.findall(r"^- ", m.group(1), _re.M))
        if n:
            parts_cn.append(f"{cn} {n} 项")
            parts_en.append(f"{n} {en_out.lower()}")
    if not parts_cn:
        return fallback

    return (f"Data Maskit {tag}：{'、'.join(parts_cn)}。详见 Release 页。\n"
            f"Data Maskit {tag}: {', '.join(parts_en)}. See the release page for details.")


def main():
    parser = argparse.ArgumentParser(description="生成 latest.json 更新元数据")
    parser.add_argument("dir", help="包含安装包及 .sig 文件的目录")
    parser.add_argument("--tag", default="", help="版本标签（如 v0.2.2，默认从环境变量或文件名解析）")
    parser.add_argument("--repo", default="xiaYuTian11/maskit", help="GitHub 仓库名（owner/repo）")
    args = parser.parse_args()

    root = Path(args.dir).resolve()
    if not root.exists():
        print(f"Directory not found: {root}", file=sys.stderr)
        return 1

    repo = args.repo or os.environ.get("GITHUB_REPOSITORY", "xiaYuTian11/maskit")

    # 1. 查找签名文件
    win_sigs = list(root.glob("**/*.exe.sig"))
    mac_sigs = (
        list(root.glob("**/*.app.tar.gz.sig"))
        or list(root.glob("**/*aarch64*.sig"))
        or list(root.glob("**/*darwin*.sig"))
        or list(root.glob("**/*.dmg.sig"))
        or [s for s in root.glob("**/*.sig") if not s.name.endswith(".exe.sig")]
    )

    if not win_sigs and not mac_sigs:
        print(f"No *.sig signature files found in {root}; skipping latest.json", file=sys.stderr)
        return 0

    # 2. 确定 tag 版本
    tag = args.tag or os.environ.get("GITHUB_REF_NAME", "")
    if not tag:
        sample = (win_sigs or mac_sigs)[0].name
        import re
        m = re.search(r"(\d+\.\d+\.\d+)", sample)
        if m:
            tag = f"v{m.group(1)}"
        else:
            tag = "latest"

    # 3. 组装平台数据
    platforms = {}

    # 1) Windows x86_64
    if win_sigs:
        sig_path = win_sigs[0]
        sig_content = sig_path.read_text(encoding="utf-8").strip()
        exe_name = sig_path.with_suffix("").name
        platforms["windows-x86_64"] = {
            "signature": sig_content,
            "url": f"https://github.com/{repo}/releases/download/{tag}/{exe_name}",
        }

    # 2) macOS aarch64 (Apple Silicon)
    if mac_sigs:
        sig_path = mac_sigs[0]
        sig_content = sig_path.read_text(encoding="utf-8").strip()
        bundle_name = sig_path.with_suffix("").name
        platforms["darwin-aarch64"] = {
            "signature": sig_content,
            "url": f"https://github.com/{repo}/releases/download/{tag}/{bundle_name}",
        }

    pub_date = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    data = {
        "version": tag,
        "notes": _release_notes(tag),
        "pub_date": pub_date,
        "platforms": platforms,
    }

    out_path = root / "latest.json"
    out_path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Successfully generated {out_path} for {tag}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
