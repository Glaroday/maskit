"""S9 危险动作的「恒落库」门槛例外（W2-1 G1 契约 / Q6）。

背景：S9 `dangerous_action` 恒 LOW，而全局默认 `severity_floor=MEDIUM`——
按原逻辑它连**写都不写**。于是「命令拦截默认只记录、不改写、不阻断」这条承诺
在默认配置下根本不成立，「高风险操作时间线」（W2-5）会是空壳。

契约（只改落库、不改档位）：
1. `dangerous_action` 在**任意** floor 下都落库（severity 仍 LOW）；
2. 例外只认信号名，**不能退化成「所有 LOW 都放行」**——否则整个门槛机制失效，
   默认视图会重新被低档噪音灌满；
3. floor 对其它信号照旧生效（把门槛调到 LOW 才看得到它们）。
"""
import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "engine"))
sys.path.insert(0, str(ROOT))

import transparent as tr


class AlwaysRecordFloorExceptionTests(unittest.TestCase):
    def _run(self, signal_name, floor):
        """跑一次 `_audit_response`，返回被写库的 finding 列表。"""
        captured = []
        sid = "floor-exception"
        tr._new_session(sid)
        flow = SimpleNamespace(
            request=SimpleNamespace(
                host="api.openai.com", method="POST", path="/v1/chat/completions",
                content=json.dumps({"model": "gpt-4o",
                                    "messages": [{"role": "user", "content": "hi"}]}).encode("utf-8"),
            ),
            response=SimpleNamespace(
                status_code=200,
                headers={"content-type": "application/json"},
                content=json.dumps({"choices": [{"message": {"content": "ok"}}]}).encode("utf-8"),
            ),
            metadata={"session_id": sid},
        )
        finding = [{"signal": signal_name, "severity": tr._audit.LOW,
                    "evidence": "fake: evidence", "kind": "fake"}]
        # 只留 S9 一个信号，避免其它扫描器往 findings 里掺东西
        signals = {k: (k == "dangerous_action") for k in tr.DEFAULT_AUDIT_SIGNALS}
        with mock.patch.object(tr, "AUDIT_ENABLED", True), \
             mock.patch.object(tr, "AUDIT_SEVERITY_FLOOR", floor), \
             mock.patch.object(tr, "AUDIT_SIGNALS", signals), \
             mock.patch.object(tr._audit, "scan_dangerous_action", lambda *a, **k: list(finding)), \
             mock.patch.object(tr, "enqueue_audit_event", lambda ev: captured.append(ev)):
            tr._audit_response(flow, sid, "api.openai.com", "POST",
                               "/v1/chat/completions", {})
        tr._drop(sid)
        return captured

    def test_dangerous_action_is_recorded_under_medium_floor(self):
        """默认 floor=MEDIUM（LOW 本应被拦）下仍必须落库 —— 否则时间线是空壳。"""
        evs = self._run("dangerous_action", "MEDIUM")
        self.assertEqual([e["signal_type"] for e in evs], ["dangerous_action"])
        self.assertEqual(evs[0]["severity"], "LOW", "例外只改落库，不改档位")

    def test_exception_does_not_leak_to_other_low_signals(self):
        """例外只认信号名：别的 LOW 信号在 MEDIUM 门槛下仍不得入库。"""
        self.assertEqual(self._run("response_poison", "MEDIUM"), [])

    def test_floor_still_applies_normally_when_lowered(self):
        """把门槛调到 LOW 后，其它 LOW 信号照旧可见（门槛机制没被例外破坏）。"""
        evs = self._run("response_poison", "LOW")
        self.assertEqual([e["signal_type"] for e in evs], ["response_poison"])

    def test_allowlist_is_exactly_dangerous_action(self):
        """白名单是**策略常量**，不是散在代码里的字面量：多加一项要有意识。"""
        self.assertEqual(set(tr.AUDIT_ALWAYS_RECORD), {"dangerous_action"})


if __name__ == "__main__":
    unittest.main()
