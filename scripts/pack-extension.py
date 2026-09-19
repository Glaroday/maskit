#!/usr/bin/env python3
"""把 `extension/` 打成可直接分发的 zip（Release 资产 + 本地构建产物）。

**为什么需要这个脚本**：浏览器扩展不在桌面安装包里 —— `src-tauri/tauri.conf.json`
的 `bundle.resources` 只有 `resources/engine/`，商店上架又还没走。没有这个 zip，
用户从 Release 下到手里只有桌面安装包，网页版 AI（ChatGPT / Claude）那条链路
根本用不上（这两个站点没有 Base URL 可配，只能靠扩展）。

**边界**：manifest 合法性、被引用文件是否存在、JS 语法、安全红线这些**静态规则校验
归 `scripts/check-extension.mjs`**（node，已挂在门禁里）。本脚本只管「能不能打成包、
打出来的包内容对不对」，不重复那些规则。

用法：
    python scripts/pack-extension.py                # 产出 dist_extension/Maskit_<版本>_extension.zip
    python scripts/pack-extension.py --out <目录>    # 指定产物目录
    python scripts/pack-extension.py --check        # 只打包并校验，不留产物（门禁用）

版本号取自 `engine/panel.py` 的 `__version__`（仓库唯一真相来源），产物命名与现有
安装包（`Maskit_<版本>_x64-setup.exe`）对齐。

**扩展自己的 `manifest.json` version 是独立演进的**（当前 1.0.0），不跟产品版本走：
产品版本是引擎/壳的发版节奏，扩展版本是浏览器侧的兼容性节奏，两者含义不同。
"""
from __future__ import annotations

import argparse
import pathlib
import re
import sys
import tempfile
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
EXT_DIR = ROOT / "extension"
PANEL_PY = ROOT / "engine" / "panel.py"

# zip 内统一收在这个顶层目录下：无论用户用哪种方式解压，落地的都是一个干净目录，
# 不会把扩展的九个文件散进下载目录。
ARCHIVE_ROOT = "maskit-extension"

# 构成可分发扩展的最小文件集。少任何一个，用户加载出来的都是残废扩展：
# manifest 是 Chrome 的入口，background 是 SW 入口，shared 是 SW 的 importScripts 依赖，
# 两个 bridge 是页面侧注入脚本，options/popup 是两处交互界面。
REQUIRED_FILES = (
    "manifest.json",
    "background.js",
    "shared.js",
    "bridge-main.js",
    "bridge-isolated.js",
    "options.html",
    "options.js",
    "popup.html",
    "popup.js",
)


def _product_version() -> str:
    match = re.search(
        r"^__version__\s*=\s*['\"]([^'\"]+)['\"]",
        PANEL_PY.read_text(encoding="utf-8"),
        re.MULTILINE,
    )
    if not match:
        raise SystemExit("pack-extension: 无法从 engine/panel.py 读到 __version__")
    return match.group(1)


def _collect_files() -> list[pathlib.Path]:
    if not EXT_DIR.is_dir():
        raise SystemExit(f"pack-extension: 找不到扩展目录 {EXT_DIR}")
    files = sorted(p for p in EXT_DIR.rglob("*") if p.is_file())
    present = {p.name for p in files}
    missing = [name for name in REQUIRED_FILES if name not in present]
    if missing:
        raise SystemExit("pack-extension: 扩展缺少必需文件：" + ", ".join(missing))
    return files


def _write_zip(files: list[pathlib.Path], dest: pathlib.Path) -> int:
    dest.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in files:
            archive.write(path, f"{ARCHIVE_ROOT}/{path.relative_to(EXT_DIR).as_posix()}")
    return dest.stat().st_size


def _verify_zip(dest: pathlib.Path, files: list[pathlib.Path]) -> None:
    """校验产物本身：能完整读回、清单与源目录一致、manifest 不是空文件。

    打出来的包是直接给用户下载的，坏包（截断/漏文件/空 manifest）在现场表现为
    「加载已解压的扩展程序」报错，报错文本还看不出是包坏了。这里当场卡住。
    """
    with zipfile.ZipFile(dest) as archive:
        broken = archive.testzip()
        if broken:
            raise SystemExit(f"pack-extension: 包内文件损坏：{broken}")
        names = set(archive.namelist())
        expected = {f"{ARCHIVE_ROOT}/{p.relative_to(EXT_DIR).as_posix()}" for p in files}
        if names != expected:
            diff = sorted(names ^ expected)
            raise SystemExit(f"pack-extension: 包内清单与源目录不一致：{diff}")
        if not archive.read(f"{ARCHIVE_ROOT}/manifest.json").strip():
            raise SystemExit("pack-extension: 包内 manifest.json 为空")


def main() -> int:
    parser = argparse.ArgumentParser(description="把 extension/ 打成可分发 zip")
    parser.add_argument("--out", default="dist_extension", help="产物目录（默认 dist_extension）")
    parser.add_argument("--check", action="store_true", help="只打包并校验，不保留产物（门禁用）")
    args = parser.parse_args()

    version = _product_version()
    files = _collect_files()
    name = f"Maskit_{version}_extension.zip"

    if args.check:
        with tempfile.TemporaryDirectory() as tmp:
            dest = pathlib.Path(tmp) / name
            size = _write_zip(files, dest)
            _verify_zip(dest, files)
        print(f"pack-extension: OK   {name}  {len(files)} 文件 / {size} 字节（--check，未留产物）")
        return 0

    out_dir = pathlib.Path(args.out)
    if not out_dir.is_absolute():
        out_dir = ROOT / out_dir
    dest = out_dir / name
    size = _write_zip(files, dest)
    _verify_zip(dest, files)
    print(f"pack-extension: OK   {name}  {len(files)} 文件 / {size} 字节  -> {dest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())