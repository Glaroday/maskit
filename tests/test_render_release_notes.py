"""`scripts/render-release-notes.py` 回归测试。

release.yml 的 release-draft job 用这个脚本从 CHANGELOG.md 取双语章节作为
Release body，本地门禁完全覆盖不到它 —— 如果脚本坏了，线上 Release 页会出现
空白 body 或者截到下一章节，发布流程会走完但用户看不到变更说明。

所以这里锁的是：
1. 给定真实版本号能取到双语正文（中英成对，不含 `## [version]` 标题本身，
   也不会跨过下一节标题）；
2. Unreleased 章节不会被错误地当作某个版本号返回（它面向下次发版）；
3. 找不到版本 / 章节为空都要 SystemExit，不要悄悄返回空字符串（否则 GitHub
   Release body 会变成空，看起来像发版出错）。
"""
import contextlib
import importlib.util
import io
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]

# 文件名带连字符，不能当模块 import，只能按路径加载
_spec = importlib.util.spec_from_file_location(
    "render_release_notes", ROOT / "scripts" / "render-release-notes.py"
)
rrn = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(rrn)


class RenderReleaseNotesTests(unittest.TestCase):
    def test_real_changelog_0_2_7_has_bilingual_body(self):
        """取真实 CHANGELOG.md 的 0.2.7 章节：双语成对、含三类分节。"""
        body = rrn.render("0.2.7", ROOT / "CHANGELOG.md")

        self.assertNotIn("## [0.2.7]", body, "不能包含自己的标题行（body 顶部不重复）")
        self.assertNotIn("## [0.2.6]", body, "不能跨进上一节或下一节")
        self.assertIn("### 新增 / Features", body)
        self.assertIn("### 修复 / Bug Fixes", body)
        self.assertIn("### 优化 / Improvements", body)
        # 双语：每条 feature/fix 都有中文条目 + 紧随其后的英文 *...*
        self.assertRegex(body, r"\*Fix: ")
        self.assertRegex(body, r"\*Feature: ")
        # 0.2.7 摘要（双语）
        self.assertIn("macOS (Apple Silicon) 原生 DMG", body)
        self.assertIn("Harden placeholder restoration", body)

    def test_real_changelog_0_2_6_does_not_leak_0_2_7(self):
        """取 0.2.6 章节：必须停在 ## [0.2.6] 之前，不应吞进 0.2.7 内容。"""
        body = rrn.render("0.2.6", ROOT / "CHANGELOG.md")
        self.assertNotIn("Harden placeholder restoration", body)
        self.assertNotIn("## [0.2.7]", body)
        # 0.2.6 的特征：CI 单测死锁修复
        self.assertIn("socketserver", body)

    def test_unreleased_is_not_pickable_as_a_version(self):
        """Unreleased 章节面向下次发版，不能通过 'Unreleased' 当成版本号取出来。"""
        with self.assertRaises(SystemExit):
            rrn.render("Unreleased", ROOT / "CHANGELOG.md")


class ExtensionUpdateNoticeTests(unittest.TestCase):
    """「本次发版需不需要重载扩展」的自动判定。

    为什么必须有：扩展与客户端是两套独立代码，客户端升级**不会**动到已安装的扩展，
    所以大多数发版用户什么都不用做。但扩展真改了、用户又没重载时会**静默失效**
    ——页面毫无异常，只是不再脱敏。靠发布者每次记得手写这句提示，必然会漏。
    """

    def test_render_appends_bilingual_notice_for_all_three_states(self):
        cases = (("changed", "扩展有改动"),
                 ("unchanged", "扩展无改动"),
                 ("unknown", "无法自动判定"))
        for state, needle in cases:
            with self.subTest(state=state):
                body = rrn.render("0.2.7", ROOT / "CHANGELOG.md", state)
                self.assertIn(needle, body, f"{state} 的中文措辞缺失")
                # 双语：每种状态都必须中英成对（Release 页面向海内外用户）。
                # 注意变体选择符 U+FE0F 是可选的：`⚠️` / `ℹ️` 带它，而 `✅` 不带，
                # 强行要求它存在会只放过两种状态（第一版就这么写的）。
                self.assertRegex(body, r"(?s)> [⚠✅ℹ]️?.*\n> [⚠✅ℹ]️? .*[A-Za-z]")

    def test_unknown_never_reads_as_no_change_needed(self):
        """无法判定时**绝不能**说成「无改动」。

        这是本机制最容易腐化的地方：一句 `except: return False` 就能让「不知道」
        变成一句安心的「无需重新加载」，而它恰好会在契约真变了、最需要用户重载时骗人。
        """
        body = rrn.render("0.2.7", ROOT / "CHANGELOG.md", "unknown")
        self.assertNotIn("无需", body)
        self.assertNotIn("no need", body)

    def test_extension_changed_is_none_without_a_ref(self):
        """没有上一个 tag 时必须返回 None（三态），不能退化成 False。"""
        self.assertIsNone(rrn.extension_changed(None, ROOT))

    def test_extension_changed_returns_bool_on_real_history(self):
        """真实仓库上必须能给出确定的 True/False，而不是恒 None。

        只在有 git 历史时跑：浅克隆下 `_prev_tag` 拿不到东西，那是预期的 None。
        """
        prev = rrn._prev_tag(ROOT)
        if not prev:
            self.skipTest("无 git 历史（浅克隆），无法判定是预期行为")
        self.assertIn(rrn.extension_changed(prev, ROOT), (True, False))

    def test_prev_tag_never_falls_back_to_head(self):
        """`HEAD^` 取不到时必须返回 None，**绝不能回退到 HEAD**。

        浅克隆下（release job 的 checkout 若漏了 `fetch-depth: 0`）`describe HEAD`
        会拿到**当前 tag 自己**，紧接着 `git diff <当前tag> HEAD -- extension/`
        恒为空 → 把「扩展大改」算成「扩展无改动」，正是这个机制要防的假阴性。
        用 mock 固定这一分支，不依赖 CI 的克隆深度。
        """

        def fake_git(args, cwd):
            if args[-1] == "HEAD^":
                return 128, ""          # 浅克隆：fatal: Not a valid object name HEAD^
            if args[-1] == "HEAD":
                return 0, "v9.9.9"      # 回退就会拿到这个（当前 tag 自己）
            return 128, ""

        with mock.patch.object(rrn, "_git", fake_git):
            self.assertIsNone(rrn._prev_tag(ROOT))

    def test_prev_tag_reads_parent_commit_not_current_tag(self):
        """正常历史下取的是 HEAD^ 的 tag，而不是 HEAD 自己。"""
        seen = []

        def fake_git(args, cwd):
            seen.append(args[-1])
            return (0, "v0.3.2") if args[-1] == "HEAD^" else (0, "v0.3.3")

        with mock.patch.object(rrn, "_git", fake_git):
            self.assertEqual(rrn._prev_tag(ROOT), "v0.3.2")
        self.assertEqual(seen[0], "HEAD^", "必须先查 HEAD^，且只查它")

    def test_missing_version_raises(self):
        """找不到版本号要 SystemExit，不能返回空字符串（否则 Release body 会空白）。"""
        with self.assertRaises(SystemExit):
            rrn.render("9.9.9-not-real", ROOT / "CHANGELOG.md")

    def test_empty_section_raises(self):
        """章节存在但内容为空要 SystemExit —— 不能让 GitHub Release body 变成空白。"""
        with tempfile.TemporaryDirectory() as d:
            fake = Path(d) / "CHANGELOG.md"
            fake.write_text(
                "## [Unreleased]\n\n## [1.0.0] - 2099-01-01\n## [0.9.0] - 2098-01-01\n"
                "old text\n",
                encoding="utf-8",
            )
            with self.assertRaises(SystemExit):
                rrn.render("1.0.0", fake)

    def test_main_prints_body_and_exits_zero(self):
        """CLI：直接调用 main(argv) 应把 body 写到 stdout 并正常返回。"""
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = rrn.main(["0.2.7"])
        self.assertIsNone(rc)
        self.assertIn("Harden placeholder restoration", buf.getvalue())
        self.assertTrue(buf.getvalue().endswith("\n"), "输出末尾应有换行")


if __name__ == "__main__":
    unittest.main()