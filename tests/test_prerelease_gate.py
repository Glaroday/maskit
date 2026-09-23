"""预发布判定口径守卫的回归测试（`scripts/check-workflows.py` 的 `_check_prerelease_gate`）。

为什么单独立一个文件锁它：这三处判定**只在打 tag 的那一刻生效**，本地门禁全绿也
不代表它们对，而判错的后果不可撤回 ——

  `bump-version.py 1.2.3-dev` 实测返回 Success 并改写 6 处版本文件（版本工具链
  接受任意后缀），若 `release.yml` 只枚举 `-beta`/`-alpha`/`-rc`，这个 tag 就会：
    ① Release 不标 Pre-release → GitHub 把它当「最新正式版」；
    ② 生成并上传 `latest.json` → 现网所有正式版客户端的更新端点被指向它；
    ③ `ghcr.io/...:latest` 被非正式构建覆盖。
  而 ①②③ 都是用户可见、且发出去就收不回的。

所以这里锁两件事：
1. 当前仓库的三个落点都满足口径（tag 含 `-` 即预发布）；
2. 守卫**真的有牙**：把任一处改回枚举法（两种引号风格都要抓）或删掉判据，
   `_check_prerelease_gate` 必须报错。缺第 2 条就是「守卫自己悄悄失效」。
"""
import importlib.util
import pathlib
import shutil
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]

try:
    import yaml  # noqa: F401  （check-workflows 的模块级依赖）
    _HAS_YAML = True
except Exception:  # pragma: no cover - 极简环境
    _HAS_YAML = False


def _load_check_workflows():
    """文件名带连字符不能直接 import，按路径加载（与 test_release_metadata.py 同法）。"""
    spec = importlib.util.spec_from_file_location(
        "check_workflows", ROOT / "scripts" / "check-workflows.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@unittest.skipUnless(_HAS_YAML, "需要 pyyaml（check-workflows 的依赖）")
class PrereleaseGateTests(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.mod = _load_check_workflows()

    def _run_guard_on(self, mutate=None, fname="release.yml", newname=None):
        """把 workflow 目录复制到临时目录，可选地篡改一个文件，然后跑守卫。"""
        with tempfile.TemporaryDirectory() as tmp:
            dest = pathlib.Path(tmp) / "workflows"
            shutil.copytree(ROOT / ".github" / "workflows", dest)
            if mutate is not None:
                target = dest / (newname or fname)
                target.write_text(mutate(target.read_text(encoding="utf-8")),
                                  encoding="utf-8")
            errors = []
            old = self.mod.WORKFLOWS
            try:
                self.mod.WORKFLOWS = dest
                self.mod._check_prerelease_gate(errors)
            finally:
                self.mod.WORKFLOWS = old
            return errors

    def test_current_workflows_pass_the_gate(self):
        self.assertEqual(self._run_guard_on(), [], "当前三处判定必须满足口径")

    def test_enumeration_in_bash_is_rejected(self):
        """回归复现：把 is_prerelease 改回枚举（双引号风格）→ 必须报错。"""
        errors = self._run_guard_on(lambda t: t.replace(
            'if [[ "$GITHUB_REF_NAME" == *"-"* ]]; then',
            'if [[ "$GITHUB_REF_NAME" == *"-beta"* || "$GITHUB_REF_NAME" == *"-alpha"* ]]; then'))
        self.assertTrue(errors, "退回枚举法必须被拦住，否则 vX.Y.Z-dev 会当正式版发布")
        self.assertTrue(any("枚举后缀" in e or "缺少判据" in e for e in errors), errors)

    def test_enumeration_in_docker_enable_is_rejected(self):
        """回归复现：docker 的 latest enable 改回枚举（单引号风格）→ 必须报错。"""
        errors = self._run_guard_on(lambda t: t.replace(
            "!contains(github.ref_name, '-')",
            "!contains(github.ref_name, '-beta')"))
        self.assertTrue(errors, "docker latest 别名退回枚举同样必须被拦住")

    def test_manual_publish_workflow_is_also_guarded(self):
        """手动发布（docker-publish.yml）漏改也必须报错——它同样能覆盖 latest。"""
        errors = self._run_guard_on(
            lambda t: t.replace("!contains(inputs.tag, '-')",
                                "!contains(inputs.tag, '-beta')"),
            fname="docker-publish.yml")
        self.assertTrue(errors, "手动发布路径的 latest 别名漏改必须被拦住")

    def test_missing_judgement_is_rejected(self):
        """判据整段删掉（不是改错）也要报错，否则守卫会静默失效。"""
        errors = self._run_guard_on(lambda t: t.replace('if [[ "$GITHUB_REF_NAME" == *"-"* ]]; then',
                                                        'if false; then'))
        self.assertTrue(errors, "判据缺失必须报错")
        self.assertTrue(any("缺少判据" in e for e in errors), errors)


if __name__ == "__main__":
    unittest.main()
