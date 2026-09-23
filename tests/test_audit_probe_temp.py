"""主动探针的「临时启用 + 自动恢复」契约（W1-4）。

背景：主动探针关闭时，引擎的跨请求污染检测（S7/D1）恒判「无异常」，跑一轮
等于花钱买一份假报告，所以 `/api/audit/run` 原先直接 400。但这对用户是死路：
按钮能点、点了只报错，用户得自己去设置里翻开关。

现在的契约（2026-09-22 审批）：
1. **不带 `allow_temp_probes` 的调用方（脚本/旧客户端）仍按原逻辑 400** —— 不静默
   改变第三方调用方行为，也不让「花钱买假报告」这条路敞开；
2. UI 在确认弹窗里明示「临时启用 + 运行结束后自动恢复」，确认后带标志发起；
3. **恢复动作放后端 `finally`**：正常跑完、抛异常、用户中途取消三条路径都要恢复
   （前端恢复会被刷新/关页漏掉）；用户在扫描期间手改了开关则以用户为准；
4. **任一校验失败提前返回时，配置不能留下 active_probes=true 的脏状态** ——
   所以写盘必须排在全部校验之后。
"""
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "engine"))
import panel


class ProbeTempEnableRestoreTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        patcher = mock.patch.object(panel, "CONFIG_PATH", Path(tmp.name) / "config.json")
        patcher.start()
        self.addCleanup(patcher.stop)
        cfg = panel.default_config()
        cfg["audit"]["active_probes"] = False
        panel.save_config(cfg)
        # audit_job 是模块级单例：逐条用例前复位，避免互相串状态
        panel.audit_job.update({
            "running": False, "started_at": 0, "done": 0, "total": 0,
            "phase": "", "cancel": False, "result": None, "error": "",
            "restore_active_probes": None,
        })
        self.headers = {"X-Shield-Token": panel.API_TOKEN}

    # ---- 配置窄通道 ------------------------------------------------------

    def test_set_audit_active_probes_touches_only_that_field(self):
        before = panel.load_config()["audit"]
        panel._set_audit_active_probes(True)
        after = panel.load_config()["audit"]
        self.assertTrue(after["active_probes"])
        # 兄弟字段原样保留（写整份配置时最容易顺手覆盖掉它们）
        self.assertEqual({k: v for k, v in after.items() if k != "active_probes"},
                         {k: v for k, v in before.items() if k != "active_probes"})

    # ---- worker 的恢复（三条路径） ---------------------------------------

    def _run_worker_with(self, runner):
        panel.audit_job["restore_active_probes"] = False
        panel._set_audit_active_probes(True)
        with mock.patch.object(panel, "_run_audit_scan", side_effect=runner):
            panel._audit_scan_worker({"name": "up", "port": 5802}, "up", "m", "general",
                                     panel.load_config())

    def test_restores_original_value_on_success(self):
        self._run_worker_with(lambda *a, **k: {"ok": True})
        self.assertFalse(panel.load_config()["audit"]["active_probes"])
        self.assertIsNone(panel.audit_job.get("restore_active_probes"), "账目必须被消费掉")

    def test_restores_original_value_when_scan_raises(self):
        """异常路径同样恢复 —— 这正是把恢复放 finally 而不是 happy-path 的原因。"""
        self._run_worker_with(RuntimeError("boom"))
        self.assertFalse(panel.load_config()["audit"]["active_probes"])
        self.assertTrue(panel.audit_job["error"], "异常应被记进 job 状态")

    def test_user_change_during_scan_is_not_clobbered(self):
        """扫描期间用户手改了开关 → 以用户为准，不静默覆盖用户的安全设置。"""
        def _change_it(*_a, **_k):
            panel._set_audit_active_probes(False)  # 模拟用户在扫描期间关掉
            return {"ok": True}

        self._run_worker_with(_change_it)
        self.assertFalse(panel.load_config()["audit"]["active_probes"])

    def test_no_restore_when_we_never_touched_the_switch(self):
        """本来开着 → 本次没有临时改动 → 结束后不能被「恢复」成关闭。"""
        panel.audit_job["restore_active_probes"] = None
        panel._set_audit_active_probes(True)
        with mock.patch.object(panel, "_run_audit_scan", return_value={"ok": True}):
            panel._audit_scan_worker({"name": "up", "port": 5802}, "up", "m", "general",
                                     panel.load_config())
        self.assertTrue(panel.load_config()["audit"]["active_probes"])

    # ---- 接口层：兼容性 + 不留脏状态 -------------------------------------

    def _run_endpoint(self, body):
        with panel.app.test_client() as client:
            return client.post("/api/audit/run", json=body, headers=self.headers)

    def test_legacy_caller_without_flag_still_gets_400(self):
        r = self._run_endpoint({"confirm": True, "upstream_name": "up"})
        self.assertEqual(r.status_code, 400)
        self.assertIn("主动探针未启用", r.get_json()["error"])
        self.assertFalse(panel.load_config()["audit"]["active_probes"], "拒绝路径不得改动配置")

    def test_temp_enable_flag_but_invalid_request_leaves_config_clean(self):
        """带标志但后续校验失败（如代理未运行）→ 配置必须仍是原值。

        写盘排在全部校验之后就是为了这条：否则一次失败的点按会把用户的
        active_probes 永久留在 true（「临时」的承诺当场失效）。
        """
        with mock.patch.object(panel, "proc", {"p": None}):
            r = self._run_endpoint({"confirm": True, "upstream_name": "",
                                    "allow_temp_probes": True})
        self.assertEqual(r.status_code, 400)
        self.assertFalse(panel.load_config()["audit"]["active_probes"])


if __name__ == "__main__":
    unittest.main()
