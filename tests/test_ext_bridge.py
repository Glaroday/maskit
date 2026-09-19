"""浏览器扩展桥接（Browser Bridge v1）后端测试 T1-T19。

规格：`ai-coding/ext-bridge/EXT-BRIDGE-DEV-SPEC.md` v2.6（§2 后端改造 / §5 可观测性 / §6.1 用例表）。

关键约定（踩过的坑，改测试前先读）：
- T13/T16 的 TTL **不能**直接 `tr.SESSION_TTL = 5`：端点每次 mask 都会
  `tr._maybe_reload(force=True)`，而它会用配置里的 session_ttl 覆盖模块全局，
  直接赋值会被静默还原、断言失去鉴别力。正确做法是把 TTL 写进隔离数据目录的
  `config.json`（本文件的 `_save_cfg()` 就是这条路）。
- (A)/(B) 判据只有一条：响应带 `blocking is True` 才是 (A)。403
  `ext_bridge_disabled` / `ext_bridge_disabled` 之流属 (B)，**响应里不许出现 blocking**。
"""
import json
import os
import re
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "engine"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import event_store  # noqa: E402
import panel  # noqa: E402
import transparent as tr  # noqa: E402

PLACEHOLDER_RX = re.compile(r"\{\{[A-Z0-9]{1,12}_[a-z]{6}\}\}")

# 导入时抓一份 `ext_frames` 上限快照。**不能**在断言里现读 `tr._EXT_FRAMES_MAX`：
# 负向对照会把它 patch 成 10^9 来模拟「修复被回退」，现读现用的话断言会跟着变宽、
# 永远绿（第一版就是这么写的，负向对照当场把它揪出来了）。
_FRAMES_CAP_AT_IMPORT = tr._EXT_FRAMES_MAX

# 一条“标准”的 LLM 请求体：手机号 + 邮箱 + 凭据前缀 key
FULL_BODY = (
    '{"model":"gpt-4o","messages":[{"role":"user","content":'
    '"联系人张三，电话 13812345678，邮箱 zhang@example.com，'
    'key 是 sk-abcdefghijklmnopqrstuvwxyz012345"}]}'
)


class _IterationWindowDict(dict):
    """把「迭代期被改大小」的时序窗口从**靠调度运气**变成**必然事件**。

    为什么必须显式打开这个窗口（实测结论）：`_prune_recent` 的快照是
    `list(_RECENT_FWD.items())`，在 CPython 3.13 上整个 `list()` 是持有 GIL 的
    单个 C 调用，实测 20 万条目 + 高频并发插入 **0 次** RuntimeError ——
    也就是说 SPEC §6.1 T15 说的「不加锁必须能稳定复现 RuntimeError」
    **靠调度复现不出来**。

    初版做法是「后台线程狂插 + 每条目 `time.sleep(0)` 让出 GIL」。那是竞态：
    单独跑必现、进全量套件就偶发不触发（2026-09-15 全量门禁实测就红在这里），
    而且狂插线程会把 `_RECENT_FWD` 撑到极大、单测耗时从 30s 飙到 368s。
    现在改成两种确定性手段：

    - `injector`（T15a 用）：迭代到第 `inject_at` 条时调它，由它在**另一个线程**
      完成插入并**等插入真的落地**（`Event.wait` 会让出 GIL）。插入点落在窗口内
      因此是必然事件，不再看调度脸色。
    - `yield_gil=True`（T15c 用）：逐条 `time.sleep(0)` 让出 GIL，让「持锁时插入方
      能否挤进来」这件事有真实的可乘之机 —— 断言的是**不抛**，是稳定属性。
    """

    def __init__(self, *a, injector=None, inject_at=1, wait=5.0, yield_gil=False, **kw):
        super().__init__(*a, **kw)
        self._injector = injector
        self._inject_at = inject_at
        self._wait = wait
        self._yield_gil = yield_gil

    def items(self):
        for i, item in enumerate(dict.items(self)):
            if i == self._inject_at and self._injector is not None:
                self._injector(self._wait)
            if self._yield_gil:
                time.sleep(0)      # 显式让出 GIL
            yield item


class ExtBridgeTestCase(unittest.TestCase):
    """公共基座：把 panel / transparent / event_store 三方数据目录一起隔离到临时目录。"""

    EXT_TOKEN = "ext-test-token-0123456789"

    @staticmethod
    def _flush_and_drain_events():
        """先把在途批次落库（落到**当前** DB_PATH），再清空残留队列。

        为什么不能在切 DB_PATH 之后再管（实测踩过）：写线程是 `while True` 永不
        退出的（`_reset_writer` 只是丢引用，老线程继续跑）。它在**出队那一刻**取走
        记录、过完 `_BATCH_WINDOW` 才真正写库，而落库用的是**那时**的
        `event_store.DB_PATH` —— 若这期间 setUp 把 DB_PATH 换成下一个用例的临时
        目录，上一条事件就凭空长在下一个用例的库里。实测症状：T14 从事件库预热时
        读到了别的用例写的 `a@b.com` 映射，断言随机失败。
        `flush_event_queue()` 内部是 `queue.join()`，在批次 finally 的 task_done
        之后才返回，因此在 join 之后切路径是安全的。
        """
        try:
            event_store.flush_event_queue()
        except Exception:
            pass
        try:
            event_store._reset_writer()
            while True:
                event_store._event_queue.get_nowait()
                event_store._event_queue.task_done()
        except Exception:
            pass

    def setUp(self):
        # 队列在本模块用例之间应当是空的（每个 teardown 都 flush 过）；
        # 这里再跑一次只是兜底，空队列时 join() 直接返回、不碰 DB。
        self._flush_and_drain_events()
        self.tmp = Path(tempfile.mkdtemp(prefix="maskit-ext-test-"))
        self.addCleanup(self._cleanup_tmp)
        self._saved = {
            "config_path": panel.CONFIG_PATH,
            "data_root": tr._DATA_ROOT,
            "db_path": event_store.DB_PATH,
            "origin_check": panel._origin_check_enabled,
            "remote": panel.REMOTE_MODE,
            "disable_origin": panel._DISABLE_ORIGIN_CHECK_ENV,
        }
        panel.CONFIG_PATH = self.tmp / "config.json"
        tr._DATA_ROOT = self.tmp
        event_store.DB_PATH = self.tmp / "shield-events.sqlite3"
        event_store._reset_writer()
        panel._origin_check_enabled = True
        panel.REMOTE_MODE = False
        panel._DISABLE_ORIGIN_CHECK_ENV = False
        self.client = panel.app.test_client()

        # 清运行时全局，避免用例间串味（transparent 是进程级全局态）
        tr.sessions.clear()
        tr._RECENT_FWD.clear()
        tr._RECENT_REV.clear()
        tr._RECENT_SUFFIX.clear()
        panel._EXT_STATS.update({"mask": 0, "restore": 0})
        panel._EXT_LAST_SWEEP = 0.0
        self.addCleanup(self._teardown_state)

        self._save_cfg({"ext_bridge_enabled": True, "ext_token": self.EXT_TOKEN})

    def _teardown_state(self):
        # 必须在恢复 DB_PATH **之前** flush：本用例的事件要落在本用例的库里
        self._flush_and_drain_events()
        panel.CONFIG_PATH = self._saved["config_path"]
        tr._DATA_ROOT = self._saved["data_root"]
        event_store.DB_PATH = self._saved["db_path"]
        panel._origin_check_enabled = self._saved["origin_check"]
        panel.REMOTE_MODE = self._saved["remote"]
        panel._DISABLE_ORIGIN_CHECK_ENV = self._saved["disable_origin"]
        event_store._reset_writer()
        tr.sessions.clear()
        tr._RECENT_FWD.clear()
        tr._RECENT_REV.clear()

    def _cleanup_tmp(self):
        for p in sorted(self.tmp.glob("**/*"), reverse=True):
            try:
                p.unlink()
            except Exception:
                pass
        try:
            self.tmp.rmdir()
        except Exception:
            pass

    # ── 配置与请求helper ───────────────────────────────────────────────
    def _save_cfg(self, patch):
        """把 patch 合并进当前配置并落盘（会同步 panel 运行时状态 + tr 的 config.json）。"""
        cfg = panel.default_config()
        if panel.CONFIG_PATH.exists():
            try:
                cfg.update(json.loads(panel.CONFIG_PATH.read_text(encoding="utf-8")))
            except Exception:
                pass
        cfg.update(patch)
        panel.save_config(cfg)
        return cfg

    def _ext(self, path, payload=None, token=None, method="post"):
        headers = {"X-Shield-Token": self.EXT_TOKEN if token is None else token}
        if method == "post":
            return self.client.post(path, json=payload or {}, headers=headers)
        return self.client.get(path, headers=headers)

    def _mask(self, text, host="chatgpt.com"):
        return self._ext("/api/ext/mask", {"text": text, "host": host})

    def _restore(self, text, sid, stream_id="s1", final=False, escape=True):
        return self._ext("/api/ext/restore", {
            "text": text, "sid": sid, "stream_id": stream_id,
            "final": final, "escape": escape, "host": "chatgpt.com",
        })

    # ── 便捷断言 ──────────────────────────────────────────────────────
    def _assert_no_blocking(self, resp, why=""):
        body = resp.get_json() or {}
        self.assertIsNot(body.get("blocking"), True,
                         f"(B) 类响应里不许出现 blocking:true —— {why}；body={body}")


# ============================== T5 / T6 ==============================

class TokenAndSwitchTests(ExtBridgeTestCase):
    """T5 token 鉴权 / T6 开关语义。"""

    def test_wrong_token_gets_403(self):
        r = self._ext("/api/ext/ping", {}, token="wrong-token-000000", method="get")
        self.assertEqual(r.status_code, 403)
        self.assertEqual((r.get_json() or {}).get("error"), "invalid_token")

    def test_ext_token_accepted_and_api_token_also_accepted(self):
        r = self._ext("/api/ext/ping", method="get")
        self.assertEqual(r.status_code, 200, r.get_data(as_text=True))
        self.assertTrue(r.get_json().get("ok"))
        r2 = self._ext("/api/ext/ping", token=panel.API_TOKEN, method="get")
        self.assertEqual(r2.status_code, 200, "API_TOKEN 与控制面共用，扩展端点必须也接受")

    def test_ext_token_not_valid_elsewhere(self):
        """ext_token 只对三个精确白名单端点有效：打 /api/config 必须 403。"""
        r = self._ext("/api/config", token=self.EXT_TOKEN, method="get")
        self.assertEqual(r.status_code, 403)
        self.assertEqual((r.get_json() or {}).get("error"), "invalid_token")

    def test_ping_reports_switches_and_stats(self):
        body = self._ext("/api/ext/ping", method="get").get_json()
        self.assertEqual(body["version"], panel.__version__)
        self.assertFalse(body["block_when_down"])
        self.assertTrue(body["record_events"])
        self.assertEqual(body["stats"], {"mask": 0, "restore": 0})

    def test_disabled_bridge_403_without_blocking(self):
        """T6：面板关开关 → 403 且**不带 blocking**（(B) 类，扩展直通，红线 2）。"""
        self._save_cfg({"ext_bridge_enabled": False})
        r = self._ext("/api/ext/ping", method="get")
        self.assertEqual(r.status_code, 403)
        self.assertEqual((r.get_json() or {}).get("error"), "ext_bridge_disabled")
        self._assert_no_blocking(r, "面板关开关属于 (B) 直通")
        self.assertNotIn("blocking", r.get_data(as_text=True))

    def test_disabled_bridge_denies_each_endpoint(self):
        self._save_cfg({"ext_bridge_enabled": False})
        for path in ("/api/ext/ping", "/api/ext/mask", "/api/ext/restore"):
            method = "get" if path.endswith("ping") else "post"
            r = self._ext(path, {"text": "x", "sid": "ext:0000000000000000",
                                 "stream_id": "s", "final": True}, method=method)
            self.assertEqual(r.status_code, 403, f"{path} 应 403")
            self._assert_no_blocking(r, path)

    def test_empty_ext_token_never_authorizes(self):
        """ext_token 为空时恒 403 —— 不允许「没设 token 就全放行」。"""
        self._save_cfg({"ext_bridge_enabled": False})
        panel._ext_cfg_state["ext_token"] = ""
        r = self.client.post("/api/ext/mask", json={"text": "abc"},
                             headers={"X-Shield-Token": ""})
        self.assertEqual(r.status_code, 403)

    def test_enabling_bridge_auto_generates_token(self):
        cfg = panel.default_config()
        cfg["ext_bridge_enabled"] = True
        cfg["ext_token"] = ""
        panel.save_config(cfg)
        written = json.loads(panel.CONFIG_PATH.read_text(encoding="utf-8"))
        self.assertTrue(written.get("ext_token"), "启用桥接时必须自动生成并固化 token")
        self.assertEqual(written["ext_token"], panel._ext_cfg_state["ext_token"])


# ============================== 扩展 Origin 放行（e2e 实测回归） ==============================

class ExtOriginTests(ExtBridgeTestCase):
    """扩展 SW 的 POST **会带** `Origin: chrome-extension://<扩展ID>`。

    这条是 e2e（tests/e2e_ext_bridge.py）在真 Chrome 上抓出来的：SPEC §3.2 的注释
    「SW 的 fetch 不带 Origin（实测 C1）」只在 GET/HEAD 上成立。若 guard 不放行扩展
    scheme，每个 mask/restore 都被 `origin_rejected` 403 打回，扩展按 (B) 直通 →
    **全站静默未脱敏**（页面看起来完全正常）。所以这里钉死两个方向。
    """

    def _with_origin(self, path, origin, payload=None, method="post"):
        headers = {"X-Shield-Token": self.EXT_TOKEN}
        if origin is not None:
            headers["Origin"] = origin
        if method == "post":
            return self.client.post(path, json=payload or {}, headers=headers)
        return self.client.get(path, headers=headers)

    def test_extension_scheme_origin_is_allowed(self):
        for origin in ("chrome-extension://lifbdjlbpgcmbaakbjncjhekbgbkonfo",
                       "moz-extension://6a1e0f2c-0000-4a5b-9c1d-000000000000"):
            r = self._with_origin("/api/ext/ping", origin, method="get")
            self.assertEqual(r.status_code, 200, f"{origin} 被拦：{r.get_data(as_text=True)}")
            # mask 是 POST —— 真正带 Origin 的那条路径
            j = self._with_origin("/api/ext/mask", origin,
                                  {"text": "联系 13812345678"}).get_json()
            self.assertTrue(j.get("ok"), f"{origin} mask 失败：{j}")

    def test_null_origin_rejected_on_ext_endpoints(self):
        """`Origin: null` 必须被拒（2026-09-15 收紧）。

        `null` 只来自沙箱 iframe / `data:` / `file://` 这类**无来源**上下文，扩展上下文
        恒有 `chrome-extension://<id>`（真机 e2e 实测）。原先为了"求稳"额外放行 null，
        等于给「任意本地 HTML 文件 + 已知 token」多开一道门，而它没有任何合法调用方。
        """
        r = self._with_origin("/api/ext/mask", "null", {"text": "联系 13812345678"})
        self.assertEqual(r.status_code, 403,
                         "Origin: null 未被拒 —— 无来源上下文不该能调扩展端点")
        self.assertEqual((r.get_json() or {}).get("error"), "origin_rejected")

    def test_web_page_origin_still_rejected_on_ext_endpoints(self):
        """Web 页面 Origin 仍被拒：万一 token 外泄，跨源页面也用不上这个端点。"""
        r = self._with_origin("/api/ext/mask", "https://evil.example",
                              {"text": "联系 13812345678"})
        self.assertEqual(r.status_code, 403)
        self.assertEqual((r.get_json() or {}).get("error"), "origin_rejected")

    def test_extension_origin_not_allowed_on_non_ext_endpoints(self):
        """放行只对三个精确白名单端点生效，不许外溢到 /api/config 等控制面。"""
        ext_origin = "chrome-extension://lifbdjlbpgcmbaakbjncjhekbgbkonfo"
        # ① 拿 ext_token 打控制面：先被 token 拦下（本来就轮不到 Origin 校验）
        r = self.client.get("/api/config", headers={"X-Shield-Token": self.EXT_TOKEN,
                                                   "Origin": ext_origin})
        self.assertEqual(r.status_code, 403)
        self.assertEqual((r.get_json() or {}).get("error"), "invalid_token")
        # ② 拿**合法** API_TOKEN 再打一次：token 过了，就必须被 Origin 拦下——
        #    证明「放行扩展 scheme」没有顺手把控制面的 Origin 防线也拆了
        r2 = self.client.get("/api/config", headers={"X-Shield-Token": panel.API_TOKEN,
                                                    "Origin": ext_origin})
        self.assertEqual(r2.status_code, 403)
        self.assertEqual((r2.get_json() or {}).get("error"), "origin_rejected")


# ============================== T1-T4 / T7 / T8 / T11-T14 ==============================

class MaskRestoreTests(ExtBridgeTestCase):
    """T1 mask→restore 闭环 / T2 跨 chunk 劈半 / T3 final 冲刷 / T4 孤儿占位符。"""

    def test_t1_roundtrip_phone_email_secret(self):
        j = self._mask(FULL_BODY).get_json()
        self.assertTrue(j["ok"], j)
        masked, sid = j["masked_text"], j["sid"]
        self.assertNotIn("13812345678", masked)
        self.assertNotIn("zhang@example.com", masked)
        self.assertNotIn("sk-abcdefghijklmnopqrstuvwxyz012345", masked)
        self.assertRegex(masked, r"\{\{PHONE_[a-z]{6}\}\}")
        self.assertRegex(masked, r"\{\{EMAIL_[a-z]{6}\}\}")
        out = self._restore(masked, sid, final=True, escape=True).get_json()["text"]
        self.assertEqual(out, FULL_BODY, "JSON 上下文 escape=true 还原后必须与原文一致")

    def test_t2_split_placeholder_across_chunks_with_quoted_original(self):
        """占位符被 chunk 边界劈开；续帧里有 JSON 转义的引号，拼起来必须仍可解析。"""
        self._save_cfg({"sensitive": {"TERM": ['"VIP"']}})
        original = '{"delta":"联系 13812345678 备注 \\"VIP\\""}'
        j = self._mask(original).get_json()
        masked, sid = j["masked_text"], j["sid"]
        pos = masked.index("{{PHON")
        cut = pos + 6                                  # 切在占位符中间
        chunk1 = "data: " + masked[:cut]
        chunk2 = masked[cut:] + "\n\n"

        r1 = self._restore(chunk1, sid, stream_id="t2", final=False, escape=True)
        r2 = self._restore(chunk2, sid, stream_id="t2", final=False, escape=True)
        r3 = self._restore("", sid, stream_id="t2", final=True, escape=True)
        self.assertEqual(r1.status_code, 200)
        concat = r1.get_json()["text"] + r2.get_json()["text"] + r3.get_json()["text"]

        payload = concat.split("data: ", 1)[1].strip()
        data = json.loads(payload)                     # 劈半拼接后仍必须是合法 JSON
        self.assertEqual(data["delta"], '联系 13812345678 备注 "VIP"')
        # 引号必须是**转义形态**回来的，否则 JSON 早就坏了
        self.assertIn('\\"VIP\\"', concat)

    def test_t3_final_flush_and_full_restore(self):
        j = self._mask('{"c":"13812345678"}').get_json()
        masked, sid = j["masked_text"], j["sid"]
        half = masked[: masked.index("{{PHON") + 6]     # 恰好切在 `{{PHON` 后
        self.assertTrue(half.endswith("{{PHON"))
        out = self._restore(half, sid, stream_id="t3a", final=True, escape=True)
        self.assertEqual(out.status_code, 200)
        self.assertIn("{{PHON", out.get_json()["text"], "半截占位符 final 后应原样下发")
        # 换一个通道拿完整文本，仍应完整还原
        full = self._restore(masked, sid, stream_id="t3b", final=True, escape=True)
        self.assertEqual(full.get_json()["text"], '{"c":"13812345678"}')

    def test_t4_orphan_placeholder_kept_and_counted(self):
        sid = self._mask('{"c":"13812345678"}').get_json()["sid"]
        orphan = '{"c":"{{PHONE_qqqqqq}}"}'
        r = self._restore(orphan, sid, stream_id="t4", final=True, escape=True)
        self.assertEqual(r.status_code, 200)
        self.assertIn("{{PHONE_qqqqqq}}", r.get_json()["text"], "查不到原文必须原样返回，绝不猜")
        self.assertEqual(tr.sessions[sid].get("unresolved"), 1)


class SidAndLimitTests(ExtBridgeTestCase):
    """T7 sid 闭环 / T8 超限 403 语义 / T5+T9 的 token 面（见 TokenAndSwitchTests）。"""

    def test_t7_sid_is_server_issued_and_validated(self):
        j1 = self._mask(FULL_BODY).get_json()
        j2 = self._mask(FULL_BODY).get_json()
        sid, masked = j1["sid"], j1["masked_text"]
        self.assertRegex(sid, r"^ext:[0-9a-f]{16}$", "sid 必须服务端签发且形如 ext:<hex16>")
        self.assertNotEqual(sid, j2["sid"], "每个请求一个新 sid")
        self.assertEqual(self._restore(masked, sid, final=True).get_json()["text"], FULL_BODY)
        # 自造 sid：查不到映射，占位符原样返回
        fake = "ext:" + "0" * 16
        out = self._restore(masked, fake, final=True)
        self.assertEqual(out.status_code, 200)
        self.assertIn("{{", out.get_json()["text"])

    def test_t7_client_supplied_sid_is_ignored(self):
        """扩展传进来的 host/sid 一律不可信：mask 响应里的 sid 必须由服务端生成。"""
        r = self.client.post("/api/ext/mask",
                             json={"text": FULL_BODY, "sid": "ext:deadbeefdeadbeef",
                                   "host": "evil.example.com"},
                             headers={"X-Shield-Token": self.EXT_TOKEN})
        self.assertNotEqual(r.get_json()["sid"], "ext:deadbeefdeadbeef")

    def test_t8_oversize_request_gets_413_blocking(self):
        r = self.client.post(
            "/api/ext/mask", data=b'{"text":"x"}',
            headers={"X-Shield-Token": self.EXT_TOKEN, "Content-Type": "application/json"},
            environ_overrides={"CONTENT_LENGTH": str(33 * 1024 * 1024)},
        )
        self.assertEqual(r.status_code, 413)
        self.assertIs(r.get_json().get("blocking"), True, "(A) 类必须带 blocking")
        self.assertEqual(r.get_json().get("error"), "payload_too_large")

    def test_bad_request_paths_are_blocking(self):
        """text 缺失/非字符串 → 400 + blocking（(A) 类）。"""
        for payload in ({}, {"text": ""}, {"text": 123}):
            r = self._ext("/api/ext/mask", payload)
            self.assertEqual(r.status_code, 400, payload)
            self.assertIs(r.get_json().get("blocking"), True, payload)
        # restore 侧参数错误恒透传（无 blocking）
        r = self._ext("/api/ext/restore", {"text": "x", "sid": "bad-sid", "stream_id": "s"})
        self.assertEqual(r.status_code, 400)
        self._assert_no_blocking(r, "restore 参数错误不属 (A) 阻断类")


class JsonAwarenessTests(ExtBridgeTestCase):
    """T11 JSON 感知 + 字节级一致性 / T12 escape 双向。"""

    BODY = ('{"tool_calls":[{"id":"call_ACME_9x","type":"function","function":'
            '{"name":"lookup","arguments":"{\\"phone\\":\\"13812345678\\"}"}}],'
            '"email":"zhang@example.com","note":"  spaced  1e-05  ",'
            '"b64":"iVBORw0KGgoAAAANSUhEUg==","stream":true}')

    def test_t11_keys_and_correlation_ids_survive(self):
        j = self._mask(self.BODY).get_json()
        masked, sid = j["masked_text"], j["sid"]
        self.assertIn('"id":"call_ACME_9x"', masked, "关联 ID 必须逐字保留（改了必断链）")
        self.assertIn('"name":"lookup"', masked, "协议位置的工具名白名单")
        self.assertIn('"email":', masked, "键名不脱敏")
        self.assertIn("{{PHONE_", masked, "arguments 是业务区，必须扫描")
        self.assertIn("iVBORw0KGgoAAAANSUhEUg==", masked, "base64 不得破坏")
        self.assertIn("  spaced  1e-05  ", masked, "排版/数字写法不得被重序列化抹掉")

        # 字节级：把占位符换回原文后必须与输入**逐字节一致**
        back = masked
        for orig, tok in (tr.sessions[sid]["fwd"] or {}).items():
            back = back.replace(tok, orig)
        self.assertEqual(back, self.BODY,
                         "除命中区间外字节必须一致（splice 就地替换的意义）")

    def test_t12_escape_true_in_json_context(self):
        self._save_cfg({"sensitive": {"TERM": ['"VIP"']}})
        body = '{"c":"备注 \\"VIP\\" 电话 13812345678"}'
        j = self._mask(body).get_json()
        out = self._restore(j["masked_text"], j["sid"], final=True, escape=True).get_json()["text"]
        parsed = json.loads(out)                       # 不可解析就是失败
        self.assertEqual(parsed["c"], '备注 "VIP" 电话 13812345678')
        self.assertIn('\\"VIP\\"', out)

    def test_t12_escape_false_in_plain_text_context(self):
        plain = "第一行 13812345678\n第二行含 \"引号\" 与 \\ 反斜杠"
        j = self._mask(plain).get_json()
        self.assertNotIn("13812345678", j["masked_text"])
        out = self._restore(j["masked_text"], j["sid"], final=True, escape=False).get_json()["text"]
        self.assertEqual(out, plain, "纯文本上下文 escape=false 必须逐字一致（不带转义垃圾）")

    def test_t12_plain_text_with_escape_true_produces_escape_garbage(self):
        """反面确认（SPEC C9）：纯文本体若被误判成 JSON 上下文，还原值里的引号会被
        JSON 转义成 `\\"` 垃圾——这正是扩展侧必须按上下文判定 escape 的理由
        （§3.3 detectEscape 默认 true / 明确纯文本才 false），端点侧不替它决定。"""
        self._save_cfg({"sensitive": {"TERM": ['"你好"']}})
        plain = '他说 "你好" 然后挂了'
        j = self._mask(plain).get_json()
        self.assertNotIn('"你好"', j["masked_text"])
        esc = self._restore(j["masked_text"], j["sid"], stream_id="esc",
                            final=True, escape=True).get_json()["text"]
        raw = self._restore(j["masked_text"], j["sid"], stream_id="raw",
                            final=True, escape=False).get_json()["text"]
        self.assertIn('\\"', esc, "escape=true 在纯文本上下文会带出转义垃圾")
        self.assertEqual(raw, plain, "escape=false 才是纯文本上下文的正确选择")


# ============================== T13-T17 / T19 ==============================

def _log_lines():
    return "\n".join(list(panel.log_buf))


class SessionLifecycleTests(ExtBridgeTestCase):
    """T13 inflight 存活（TTL 注入走配置文件，不直接改模块全局）。"""

    def test_t13_config_ttl_is_the_injection_point(self):
        """先证明「TTL 只能靠 config 注入」这条约束：直接改 tr.SESSION_TTL 会被下一次
        mask 的 _maybe_reload(force=True) 静默还原成配置值。"""
        self._save_cfg({"session_ttl": 30})
        self._mask('{"c":"13812345678"}')
        self.assertEqual(tr.SESSION_TTL, 30, "端点 mask 后 TTL 必须等于配置值")
        tr.SESSION_TTL = 5                      # 直接改全局
        self._mask('{"c":"13812345679"}')
        self.assertEqual(tr.SESSION_TTL, 30, "直接赋值会被 _maybe_reload 还原（断言失去鉴别力）")

    def test_t13_inflight_survives_ttl_sweep(self):
        text = '{"c":"13812345678 与 a@b.com"}'
        j = self._mask(text).get_json()
        sid, masked = j["sid"], j["masked_text"]
        self.assertIn(sid, tr.sessions, "端点必须显式建会话（否则 inflight 写在临时 dict 上）")
        self.assertIs(tr.sessions[sid].get("inflight"), True,
                      "inflight 必须落在真会话上，否则 _sweep 会把会话收掉 → 占位符泄漏")
        # 时间戳推到 SESSION_TTL 之外、但仍在 _INFLIGHT_MAX_IDLE(900s) 之内 ——
        # 这个区间正是「没有 inflight 保护就会被 TTL 收掉」的区间
        idle = tr.SESSION_TTL + 10
        self.assertLess(idle, tr._INFLIGHT_MAX_IDLE,
                        "本用例依赖 SESSION_TTL < _INFLIGHT_MAX_IDLE 才有鉴别力")
        tr.sessions[sid]["ts"] = time.time() - idle
        with panel._EXT_LOCK:
            tr._sweep()
        self.assertIn(sid, tr.sessions, "inflight 会话不得被 _sweep 按 TTL 回收")
        # 反向对照：摘掉 inflight 标记，同一时间戳下必须被收掉
        tr.sessions[sid]["inflight"] = False
        tr.sessions[sid]["ts"] = time.time() - idle
        with panel._EXT_LOCK:
            tr._sweep()
        self.assertNotIn(sid, tr.sessions, "对照：没有 inflight 保护时该被回收（证明用例有鉴别力）")
        # 复原：重新 mask 拿一个可还原的会话
        j2 = self._mask(text).get_json()
        sid, masked = j2["sid"], j2["masked_text"]
        out = self._restore(masked, sid, final=True, escape=True)
        self.assertEqual(out.get_json()["text"], text)
        self.assertIs(tr.sessions[sid].get("inflight"), False, "final 后必须解除 inflight")


class SweepThrottleTests(ExtBridgeTestCase):
    """T16 _sweep 节流 + 节流路径异常不得被端点静默吞掉。"""

    def test_t16_sweep_is_throttled_per_chunk(self):
        calls = []
        with mock.patch.object(tr, "_sweep", lambda: calls.append(1)):
            j = self._mask('{"c":"13812345678 a@b.com"}').get_json()
            sid, masked = j["sid"], j["masked_text"]
            panel._EXT_LAST_SWEEP = 0.0            # mask 已经跑过一次 sweep，重新起算
            for i in range(100):
                r = self._restore(masked, sid, stream_id="thr", final=False, escape=True)
                self.assertEqual(r.status_code, 200, f"第 {i} 个 chunk 的节流路径必须零异常")
        self.assertGreaterEqual(len(calls), 1, "首次必须真的跑一次，否则会话永不回收")
        self.assertLessEqual(len(calls), 100 // 10 + 2, "100 个 chunk 不该跑满 100 次全表扫")

    def test_t16_throttle_exception_is_visible_not_swallowed(self):
        """守住 v2.3 的 NameError 类缺陷：节流 helper 抛异常时必须是 (A) 阻断 + 有日志，
        而不是被端点的 except 吞掉后仍返回 200（或恒阻断且无痕迹）。"""
        def boom(_tr):
            raise RuntimeError("sweep_throttled_boom")

        with mock.patch.object(panel, "_sweep_throttled", boom):
            r = self._mask('{"c":"13812345678"}')
        self.assertEqual(r.status_code, 503)
        self.assertIs(r.get_json().get("blocking"), True)
        self.assertIn("ext mask 失败: RuntimeError", _log_lines())


class FailureVisibilityTests(ExtBridgeTestCase):
    """T19 失败路径留痕（只记异常类型名，不记 message）。"""

    def test_t19_mask_failure_logs_type_only(self):
        def boom(*_a, **_kw):
            raise RuntimeError("SECRET_MESSAGE_MARKER 13812345678")

        before = _log_lines()
        with mock.patch.object(tr, "mask_body", boom):
            r = self._mask('{"c":"13812345678"}')
        self.assertEqual(r.status_code, 503)
        self.assertIs(r.get_json().get("blocking"), True, "(A) 类：管线异常必须阻断")
        after = _log_lines()
        self.assertIn("ext mask 失败: RuntimeError", after)
        self.assertNotIn("SECRET_MESSAGE_MARKER", after,
                         "异常 message 可能带请求正文片段，绝不能进 log_buf（会被诊断包带走）")
        self.assertNotEqual(before, after, "失败路径必须有可见痕迹")

    def test_t19_restore_failure_logs_only_on_final(self):
        j = self._mask('{"c":"13812345678"}').get_json()
        sid, masked = j["sid"], j["masked_text"]

        def boom(*_a, **_kw):
            raise RuntimeError("restore_boom")

        with mock.patch.object(tr, "restore", boom):
            for i in range(5):
                r = self._restore(masked, sid, stream_id=f"t19-{i}", final=False)
                self.assertEqual(r.status_code, 200)
                self.assertEqual(r.get_json()["text"], masked, "还原方向恒透传")
            self.assertNotIn("ext restore 失败", _log_lines(),
                             "非 final 的逐 chunk 失败不记日志（否则冲掉 800 行环形缓冲）")
            r = self._restore(masked, sid, stream_id="t19-final", final=True)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.get_json()["text"], masked)
        self.assertIn("ext restore 失败(final): RuntimeError", _log_lines())

    def test_mask_file_docx_and_xlsx(self):
        """测试 Office 文档（.docx / .xlsx）解包打码端点 /api/ext/mask-file。"""
        import io
        import zipfile
        import base64

        # 1. 构造含手机号和邮箱的 docx 结构
        doc_xml = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p>
      <w:r><w:t>联系电话：13812345678</w:t></w:r>
      <w:r><w:t>，工作邮箱：test@example.com</w:t></w:r>
    </w:p>
  </w:body>
</w:document>"""
        in_buf = io.BytesIO()
        with zipfile.ZipFile(in_buf, "w", compression=zipfile.ZIP_DEFLATED) as z:
            z.writestr("word/document.xml", doc_xml.encode("utf-8"))
        b64_in = base64.b64encode(in_buf.getvalue()).decode("ascii")

        # 调端点打码
        r = self._ext("/api/ext/mask-file", {"filename": "test.docx", "base64": b64_in})
        self.assertEqual(r.status_code, 200)
        j = r.get_json() or {}
        self.assertTrue(j.get("ok"))
        self.assertGreater(j.get("hit_count", 0), 0)
        sid = j.get("sid")
        self.assertTrue(sid.startswith("ext:"))

        # 解开打码后的 docx 验证
        masked_bytes = base64.b64decode(j.get("base64"))
        with zipfile.ZipFile(io.BytesIO(masked_bytes), "r") as zout:
            masked_xml = zout.read("word/document.xml").decode("utf-8")
            self.assertNotIn("13812345678", masked_xml)
            self.assertNotIn("test@example.com", masked_xml)
            self.assertIn("{{PHONE_", masked_xml)
            self.assertIn("{{EMAIL_", masked_xml)

        # 2. 构造含共享字符串的 xlsx 结构
        sst_xml = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="1">
  <si><t>客户热线：13812345678</t></si>
</sst>"""
        wb_buf = io.BytesIO()
        with zipfile.ZipFile(wb_buf, "w", compression=zipfile.ZIP_DEFLATED) as z:
            z.writestr("xl/sharedStrings.xml", sst_xml.encode("utf-8"))
        b64_wb = base64.b64encode(wb_buf.getvalue()).decode("ascii")

        r_wb = self._ext("/api/ext/mask-file", {"filename": "data.xlsx", "base64": b64_wb, "sid": sid})
        self.assertEqual(r_wb.status_code, 200)
        j_wb = r_wb.get_json() or {}
        self.assertTrue(j_wb.get("ok"))
        masked_wb_bytes = base64.b64decode(j_wb.get("base64"))
        with zipfile.ZipFile(io.BytesIO(masked_wb_bytes), "r") as zout:
            masked_sst = zout.read("xl/sharedStrings.xml").decode("utf-8")
            self.assertNotIn("13812345678", masked_sst)
            self.assertIn("{{PHONE_", masked_sst)


class StatsSwitchTests(ExtBridgeTestCase):
    """T17 ext_record_events 开关：只停持久化。"""

    def test_t17_record_events_off_only_stops_persistence(self):
        # 先记一条，确认通路正常
        self._mask('{"c":"13812345678"}')
        event_store.flush_event_queue()
        self.assertTrue([e for e in event_store.fetch_events(limit=50) if e.get("type") == "MASK"])

        self._save_cfg({"ext_record_events": False})
        before_stats = event_store.today_stats()
        before_counter = dict(panel._EXT_STATS)        # 内存计数是累计值，比增量
        watermark = event_store.db_max_event_id()      # 只检查这之后有没有新事件
        body = '{"c":"13812345678 zhang@example.com"}'
        j = self._mask(body).get_json()
        self.assertTrue(j["ok"], "关统计不得影响脱敏功能")
        self.assertNotIn("13812345678", j["masked_text"])
        out = self._restore(j["masked_text"], j["sid"], final=True, escape=True)
        self.assertEqual(out.get_json()["text"], body, "关统计不得影响还原功能")
        event_store.flush_event_queue()

        self.assertEqual(event_store.today_stats(), before_stats,
                         "关统计后 daily_* 不许变动")
        self.assertFalse([e for e in event_store.fetch_events(since=watermark, limit=50)
                          if str(e.get("path") or "").startswith("/ext/")],
                         "关统计后事件表不许再有 ext 事件")
        self.assertEqual(panel._EXT_STATS["mask"] - before_counter["mask"], 1,
                         "内存计数照常（否则 popup 变瞎）")
        self.assertEqual(panel._EXT_STATS["restore"] - before_counter["restore"], 1)
        self.assertFalse(self._ext("/api/ext/ping", method="get").get_json()["record_events"])


class ConcurrencyTests(ExtBridgeTestCase):
    """T15 并发：无锁必炸（握手式确定性复现）→ 持 _EXT_LOCK 零异常、无串号。"""

    def setUp(self):
        super().setUp()
        self._orig_fwd = tr._RECENT_FWD
        self._orig_rev = tr._RECENT_REV
        self._orig_max = tr._RECENT_MAX
        self.addCleanup(self._restore_recent_globals)

    def _restore_recent_globals(self):
        tr._RECENT_FWD = self._orig_fwd
        tr._RECENT_REV = self._orig_rev
        tr._RECENT_MAX = self._orig_max

    def test_t15a_unlocked_snapshot_races_with_insertion(self):
        """鉴别力基线：快照构造期被并发插入打断 → RuntimeError。

        `_IterationWindowDict` 保证「迭代到第 1 条时，另一个线程已经真的插进来了」，
        所以这条断言**不依赖线程调度**（初版靠 `time.sleep(0)` 赌调度，全量套件里
        偶发不触发，已改掉）。

        ⚠️ 维护约定：本条断言的是「`_prune_recent` 自身不防御、必须由调用方持
        `_EXT_LOCK`」这个**现状**。若日后把 `_prune_recent` 内部加固（自己取锁或
        改用不惧并发改大小的快照），本条会变成**假告警** —— 那时应当改成本条断言
        加固后的新行为，**不要**为了让门禁变绿而把实现改回脆弱的版本。
        """
        injected = {"done": False}

        def inject(wait):
            done = threading.Event()

            def do_insert():
                tr._RECENT_FWD[f"orig-{time.time_ns()}"] = ["{{PHONE_aaaaaa}}", "PHONE", time.time()]
                done.set()

            threading.Thread(target=do_insert, daemon=True).start()
            injected["done"] = done.wait(timeout=wait)

        tr._RECENT_FWD = _IterationWindowDict(
            {"seed": ["{{PHONE_seed01}}", "PHONE", time.time()]}, injector=inject, inject_at=0)
        tr._RECENT_REV = {}

        raised = None
        try:
            tr._prune_recent()
        except RuntimeError as e:
            raised = e
        # 先证「窗口真的被打开了」，再证「产品在无锁下确实会炸」——顺序反过来的话，
        # 注入失败会伪装成「鉴别力丢失」，把环境问题误报成产品问题。
        self.assertTrue(injected["done"], "注入线程未能在窗口内完成插入（环境异常，非产品缺陷）")
        self.assertIsNotNone(raised, "无锁快照未在并发插入下暴露 RuntimeError（鉴别力丢失）")

    def test_t15b_locked_endpoint_concurrency_is_clean(self):
        tr._RECENT_MAX = 4                       # SPEC §6.1：调小到 4 + 每次灌 5+ 条新原文
        errors = []
        results = {}
        barrier = threading.Barrier(6)

        def worker(idx):
            try:
                barrier.wait(timeout=10)
                for k in range(40):
                    text = ('{"c":"%d-%d 1381234%04d u%d-%d@e.com '
                            'sk-%d%04dabcdefghijklmnop"}' % (idx, k, k % 10000, idx, k, idx, k))
                    r = self._mask(text)
                    if r.status_code != 200:
                        errors.append(f"mask {r.status_code} {r.get_data(as_text=True)[:80]}")
                        return
                    j = r.get_json()
                    back = self._restore(j["masked_text"], j["sid"],
                                         stream_id=f"w{idx}-{k}", final=True, escape=True)
                    if back.status_code != 200:
                        errors.append(f"restore {back.status_code}")
                        return
                    if back.get_json()["text"] != text:
                        errors.append(f"cross-talk idx={idx} k={k}: {back.get_json()['text']!r}")
                        return
                results[idx] = "ok"
            except Exception as e:                       # noqa: BLE001
                errors.append(f"{type(e).__name__}: {e}")

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(6)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=60)
        self.assertEqual(errors, [], f"持 _EXT_LOCK 时不得出现异常或串号：{errors[:3]}")
        self.assertEqual(sorted(results), list(range(6)))

    def test_t15c_lock_closes_the_interleaving_window(self):
        """同一个时序窗口，走端点（持锁）时不再触发 —— 即锁真的封住了它。

        这里用 `yield_gil=True` 而不是 `injector`：断言的是「不抛」（稳定属性），
        窗口只需要真实存在、让其余线程有可乘之机即可。
        """
        tr._RECENT_FWD = _IterationWindowDict(yield_gil=True)
        tr._RECENT_REV = {}
        errors = []
        barrier = threading.Barrier(3)

        def worker(i):
            try:
                barrier.wait(timeout=10)
                for k in range(15):
                    text = '{"c":"%d-%d 1381234%04d a%d-%d@e.com"}' % (i, k, k % 10000, i, k)
                    r = self._mask(text)
                    if r.status_code != 200:
                        errors.append(f"{r.status_code}: {r.get_data(as_text=True)[:120]}")
                        return
            except Exception as e:                       # noqa: BLE001
                errors.append(f"{type(e).__name__}: {e}")

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(3)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=60)
        self.assertEqual(errors, [], f"_EXT_LOCK 必须挡住快照期的并发插入：{errors[:3]}")


class WarmupTests(ExtBridgeTestCase):
    """T14 items 同构 + 引擎重启后 48h 预热。"""

    def test_t14_items_are_isomorphic_and_warmup_restores(self):
        body = ('{"c":"电话 13812345678，邮箱 zhang@example.com，'
                'key sk-abcdefghijklmnopqrstuvwxyz012345"}')
        j = self._mask(body).get_json()
        sid = j["sid"]
        items = tr._mask_event_items(sid)
        by_label = {it["label"]: it for it in items}
        self.assertIn("PHONE", by_label)
        self.assertIn("EMAIL", by_label)
        for it in items:
            for key in ("tok", "label", "hash", "length", "preview"):
                self.assertIn(key, it, f"items 必须与代理路径同构，缺 {key}")
            self.assertRegex(it["tok"], r"^\{\{[A-Z0-9]{1,12}_[a-z]{6}\}\}$")
        # 非凭据 PII 带 original；凭据类只有 digest + preview，绝无 original
        self.assertIn("original", by_label["PHONE"])
        cred = [it for it in items if it.get("cred")]
        self.assertTrue(cred, "sk- 前缀必须被识别为凭据类")
        for it in cred:
            self.assertIn("digest", it)
            self.assertNotIn("original", it, "凭据类恒不明文落库")

        # 事件库里的 items 也必须同构（落库真的带上了）
        event_store.flush_event_queue()
        self.assertTrue([e for e in event_store.fetch_events(limit=20) if e.get("type") == "MASK"])

        # 模拟引擎重启：清空进程级映射，从事件库预热
        phone_tok = by_label["PHONE"]["tok"]
        email_tok = by_label["EMAIL"]["tok"]
        tr._RECENT_FWD.clear()
        tr._RECENT_REV.clear()
        tr._RECENT_SUFFIX.clear()
        tr.sessions.clear()
        with mock.patch.dict(os.environ, {"LLM_SHIELD_DATA_DIR": str(self.tmp)}):
            tr._warmup_recent_from_db()
        new_sid = "ext:" + "f" * 16
        tr._new_session(new_sid)
        warm = tr.restore(f'{{"c":"{phone_tok} 与 {email_tok}"}}', new_sid,
                          channel="warm", escape=False, final=True)
        self.assertIn("13812345678", warm)
        self.assertIn("zhang@example.com", warm)


# ============================== T18 入口维度 ==============================

class IngressDimensionTests(ExtBridgeTestCase):
    """T18 入口维度（`ingress` = proxy / ext）。

    覆盖 SPEC §5.2(2)(3) 的六条：两条 INSERT 都落库、可按入口过滤、老数据按 proxy
    解读、词榜分组不被量级挤压、分享卡只出 proxy、`/api/logs` 认 ingress 参数。
    """

    SECRET = "sk-test-0000-aaaaaaaaaaaaaaaaaaaaaaaa"
    MAIL = "wang@example.com"

    def setUp(self):
        super().setUp()
        # 先显式建库，把 `daily_stats_created` 的时间戳**钉在本用例第一条事件之前**。
        # 不这么做的话：库里原本不存在，第一条 append_event 才会触发 _ensure_db()→init_db()，
        # 于是事件的 ts 比建库时刻**早几十微秒**，第一次 today_stats() 会把它当
        # 「摘要表上线前的历史事件」回填一次 —— daily_words 的 cnt 直接翻倍
        # （`_migrate_daily_stats` 的既有行为，真实安装路径上窗口是空的，
        #  只有"库里一条数据都没有 + 拿 time.time() 造事件"的测试才会踩到）。
        event_store.init_db()

    def _emit(self, ingress=None, items=None, typ="MASK"):
        rec = {"ts": time.time(), "type": typ, "sid": "s1", "host": "chatgpt.com",
               "path": "/ext/mask", "count": len(items or []), "items": items or []}
        if ingress is not None:
            rec["ingress"] = ingress
        event_store.append_event(rec)

    @staticmethod
    def _q(sql, params=()):
        with sqlite3.connect(event_store.DB_PATH) as conn:
            return conn.execute(sql, params).fetchall()

    def test_t18a_both_insert_paths_persist_ingress(self):
        """事件写入有**两条** INSERT：同步路径 + 写线程批量路径。

        只改一条会出现「导出里有、列表里没有」的诡异现象 —— 这条用例直接把两条
        都走一遍：`append_event` 同步写，`enqueue_event` → 队列 → `_append_many` 批量写。
        """
        self._emit()                                   # 同步路径，不传 ingress → proxy
        event_store.enqueue_event({"ts": time.time(), "type": "MASK", "ingress": "ext",
                                   "host": "chatgpt.com", "path": "/ext/mask"})
        event_store.flush_event_queue()                # 批量路径
        got = [e.get("ingress") for e in event_store.fetch_events(limit=50)]
        self.assertEqual(got, ["proxy", "ext"],
                         "两条 INSERT 都必须写 ingress 列，否则读出来是 None")

    def test_t18b_fetch_events_filters_by_ingress(self):
        self._emit()
        self._emit("ext")
        self._emit("ext")
        event_store.flush_event_queue()
        self.assertEqual(len(event_store.fetch_events(limit=50, ingress="proxy")), 1)
        self.assertEqual(len(event_store.fetch_events(limit=50, ingress="ext")), 2)
        # 不带参数 / 非法值：不过滤（老调用方语义不变）
        self.assertEqual(len(event_store.fetch_events(limit=50)), 3)
        self.assertEqual(len(event_store.fetch_events(limit=50, ingress="bogus")), 3)

    def test_t18c_legacy_null_ingress_reads_as_proxy(self):
        """升级前的事件没有 ingress（ALTER 补的列可空）→ 读取时按 proxy 解读。

        不这么做的话，「只看代理链路」会漏掉升级前的全部历史，用户会以为日志丢了。
        """
        event_store.init_db()
        with sqlite3.connect(event_store.DB_PATH) as conn:
            conn.execute("INSERT INTO events(ts, type, payload, ingress) VALUES(?,?,?,NULL)",
                         (time.time(), "MASK", "{}"))
            conn.commit()
        self.assertEqual(len(event_store.fetch_events(limit=10, ingress="proxy")), 1)
        self.assertEqual(len(event_store.fetch_events(limit=10, ingress="ext")), 0)

    def test_t18d_same_word_not_merged_across_ingress(self):
        """`daily_words` 主键必须含 ingress：否则同一明文被 ON CONFLICT 合并成一行。"""
        items = [{"label": "邮箱", "preview": "w***@***.com", "original": self.MAIL}]
        self._emit(None, items)
        self._emit("ext", items)
        event_store.flush_event_queue()
        day = time.strftime("%Y-%m-%d")
        rows = self._q("SELECT ingress, cnt FROM daily_words WHERE day=? AND word=?",
                       (day, self.MAIL))
        self.assertEqual(sorted(r[0] for r in rows), ["ext", "proxy"],
                         "两条链路必须各占一行；合并成一行说明主键没重建")
        self.assertTrue(all(int(r[1]) == 1 for r in rows))

    def test_t18e_grouped_top_words_are_not_displaced_by_ext_volume(self):
        """分组同屏的**目的**：ext 的量级不对称不得把 proxy 的业务词挤出榜单。"""
        self._emit(None, [{"label": "密钥", "preview": "sk-t***0", "original": self.SECRET}])
        for _ in range(30):
            self._emit("ext", [{"label": "邮箱", "preview": "w***@***.com", "original": self.MAIL}])
        event_store.flush_event_queue()

        stats = event_store.today_stats()
        groups = stats["words_by_ingress"]
        self.assertIn("proxy", groups)
        self.assertIn("ext", groups)
        self.assertEqual(groups["proxy"]["top_words"][0]["word"], self.SECRET)
        self.assertEqual(groups["ext"]["top_words"][0]["word"], self.MAIL)
        self.assertEqual(groups["proxy"]["label_total"], 1)
        self.assertEqual(groups["ext"]["label_total"], 30)
        # 全量视图里 ext 的高频词稳稳压过 proxy 的业务词（这就是要分组的**根因**：
        # 量级不对称，30 : 1），而分组后 proxy 组自己的 Top N 是干净的。
        self.assertEqual(stats["top_words"][0]["word"], self.MAIL)
        self.assertTrue(any(w["word"] == self.SECRET for w in stats["top_words"]))

        # 近 N 天的窗口聚合也必须有同一维度，否则「首页分组了、近 7 天没分组」
        rng = event_store.stats_range(days=1)
        self.assertEqual(rng["words_by_ingress"]["proxy"]["top_words"][0]["word"], self.SECRET)
        self.assertEqual(len(rng["words_by_ingress"]["ext"]["top_words"]), 1)

    def test_t18f_label_summary_is_proxy_only(self):
        """分享卡是全仓唯一「只看代理」成立的地方（卡面口径由前端标注）。"""
        items = [{"label": "邮箱", "preview": "w***@***.com", "original": self.MAIL}]
        self._emit(None, items)
        for _ in range(5):
            self._emit("ext", items)
        event_store.flush_event_queue()
        self.assertEqual(event_store.label_summary(days=1), {"邮箱": 1})

    def test_t18g_api_logs_accepts_ingress_param(self):
        """前端入口筛选落 URL query → `/api/logs?ingress=` 必须真的过滤。"""
        self._emit(None)
        self._emit("ext")
        self._emit("ext")
        event_store.flush_event_queue()
        with mock.patch.object(panel, "_last_log_prune", [float("inf")]):
            res = self.client.get("/api/logs", query_string={"ingress": "ext", "slim": "1"},
                                  headers={"X-Shield-Token": panel.API_TOKEN})
            self.assertEqual(res.status_code, 200)
            events = res.get_json()["events"]
            self.assertEqual(len(events), 2)
            self.assertTrue(all(e.get("ingress") == "ext" for e in events))
            res_all = self.client.get("/api/logs", query_string={"slim": "1"},
                                      headers={"X-Shield-Token": panel.API_TOKEN})
            self.assertEqual(len(res_all.get_json()["events"]), 3)


# ==================== daily_words 入口维度重建迁移 ====================

class DailyWordsIngressMigrationTests(unittest.TestCase):
    """老库重建 `daily_words`（主键 3 列 → 4 列）的迁移正确性与幂等性。

    单独一套基座：本用例要**先自己造一个旧 schema 的库**，再让 `init_db()` 去迁移，
    所以不能复用 ExtBridgeTestCase 的 setUp（它那套更重，且会先建新 schema）。
    """

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="maskit-ingress-migr-"))
        self.addCleanup(self._cleanup)
        self._saved = (event_store.DB_PATH, event_store._db_ready)
        event_store.DB_PATH = self.tmp / "shield-events.sqlite3"
        event_store._db_ready = False
        self.addCleanup(self._restore)

    def _restore(self):
        try:
            event_store.flush_event_queue()
        except Exception:
            pass
        event_store.DB_PATH, event_store._db_ready = self._saved
        event_store._reset_writer()

    def _cleanup(self):
        for p in sorted(self.tmp.glob("**/*"), reverse=True):
            try:
                p.unlink()
            except Exception:
                pass
        try:
            self.tmp.rmdir()
        except Exception:
            pass

    def _q(self, sql, params=()):
        with sqlite3.connect(event_store.DB_PATH) as conn:
            return conn.execute(sql, params).fetchall()

    def _make_legacy_db(self):
        """造一个「升级前」的库：events 无 ingress，daily_words 主键为 3 列。

        `meta` 里带上 `daily_words_pii_purged` —— 真实的旧库都跑过那次一次性 PII 清洗
        （它按 meta 标记幂等）。不带的话 `init_db()` 会先按设计把整张词表删掉，
        重建自然只剩 0 行，测的就不是重建而是那次清洗了。
        """
        conn = sqlite3.connect(event_store.DB_PATH)
        conn.executescript(
            """
            CREATE TABLE events (
                id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL NOT NULL, type TEXT NOT NULL,
                sid TEXT, host TEXT, method TEXT, path TEXT, count INTEGER DEFAULT 0,
                restored INTEGER DEFAULT 0, status TEXT, http_status INTEGER, payload TEXT NOT NULL
            );
            CREATE TABLE daily_words (
                day TEXT NOT NULL, label TEXT NOT NULL, word TEXT NOT NULL,
                cnt INTEGER DEFAULT 0, PRIMARY KEY (day, label, word)
            );
            CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
            """
        )
        conn.execute("INSERT INTO meta(key,value) VALUES('daily_words_pii_purged','1')")
        conn.execute("INSERT INTO daily_words(day,label,word,cnt) VALUES('2026-01-01','邮箱','old@x.com',3)")
        conn.execute("INSERT INTO daily_words(day,label,word,cnt) VALUES('2026-01-01','密钥','sk-old',1)")
        conn.execute("INSERT INTO events(ts,type,payload) VALUES(?,?,?)", (1.0, "MASK", "{}"))
        conn.commit()
        conn.close()

    def test_rebuild_preserves_rows_maps_proxy_and_is_idempotent(self):
        self._make_legacy_db()
        event_store.init_db()

        dw_cols = [r[1] for r in self._q("PRAGMA table_info(daily_words)")]
        self.assertIn("ingress", dw_cols, "daily_words 必须重建出 ingress 列")
        self.assertIn("ingress", [r[1] for r in self._q("PRAGMA table_info(events)")])

        rows = self._q("SELECT day, label, word, cnt, ingress FROM daily_words ORDER BY word")
        self.assertEqual(len(rows), 2, "重建不得丢行")
        self.assertEqual({r[2]: int(r[3]) for r in rows}, {"old@x.com": 3, "sk-old": 1})
        self.assertTrue(all(r[4] == "proxy" for r in rows),
                        "历史行必须标 'proxy'（当时还没有扩展链路）")
        self.assertEqual(self._q("SELECT COUNT(*) FROM events")[0][0], 1, "重建不得动 events")

        # 幂等：重复 init_db 不报错、不丢行、不重复迁移
        event_store.init_db()
        event_store.init_db()
        self.assertEqual(len(self._q("SELECT * FROM daily_words")), 2)

        keys = {r[0] for r in self._q("SELECT key FROM meta")}
        self.assertIn("daily_words_ingress_migrated", keys)
        # 不复用 daily_words_pii_purged：它是另一次语义的标记，被本次迁移覆盖成时间戳
        # 就等于把那次一次性 PII 清洗标记清掉了（下次启动会再删一遍词表）。
        purged = dict(self._q("SELECT key, value FROM meta")).get("daily_words_pii_purged")
        self.assertEqual(purged, "1", "不得覆盖既有的一次性清洗标记")

    def test_write_side_matches_rebuilt_primary_key(self):
        """写侧 SQL 必须与新主键一致——不一致是**硬失败**（主键不匹配直接报错）。"""
        self._make_legacy_db()
        event_store.init_db()
        day_ts = time.mktime(time.strptime("2026-01-01", "%Y-%m-%d"))
        event_store.append_event({
            "ts": day_ts, "type": "MASK", "ingress": "ext",
            "items": [{"label": "邮箱", "original": "old@x.com", "preview": "o**@***.com"}],
        })
        event_store.flush_event_queue()
        rows = self._q("SELECT ingress, cnt FROM daily_words WHERE word='old@x.com'")
        self.assertEqual(sorted(r[0] for r in rows), ["ext", "proxy"],
                         "同一明文在两条链路上各占一行（ext 新增行 + 迁移来的 proxy 行）")


# ============================== 审计补丁（独立复审计发现） ==============================

class ExtEventFieldParityTests(ExtBridgeTestCase):
    """扩展 RESTORE 事件的字段面：**该有的必须有，不该有的绝不能有**。

    两头都会静默出错，所以两头都钉：

    ① 缺 `unresolved`/`degraded` → 日志页 `renderSummary` 读的就是这两个键，
       扩展流量里「模型把占位符改写了」这件事在面板上**完全不可见**（页面露出裸
       `{{...}}`，事件页那一行却毫无告警）。代理链路正是因为看得见，历史上才没有
       把它误判成「引擎坏了」（见 Logs.tsx 里那段注释）。这两个字段是**纯诊断**，
       `_update_stats` 一个都不消费，所以补上没有副作用。

    ② 补上 `status`/`model`/`usage` → **污染 `daily_status`/`daily_tokens`/`daily_models`**
       （判据就在 `_update_stats`：`if typ == "RESTORE" and rec.get("status")`）。
       SPEC §5.2(3) 明确要求扩展 RESTORE **不带** `status`，所以本用例把「不许带」
       也断言下来 —— 防的是后人"顺手补齐字段"这种善意改动。
    """

    def _newest_ext_event(self, typ):
        event_store.flush_event_queue()
        evs = [e for e in event_store.fetch_events(limit=200)
               if e.get("type") == typ and str(e.get("path") or "").startswith("/ext/")]
        self.assertTrue(evs, f"事件库里没有 ext 的 {typ} 事件")
        return max(evs, key=lambda e: int(e.get("seq") or 0))

    def test_restore_event_carries_unresolved_for_ui(self):
        j = self._mask('{"c":"13812345678"}').get_json()
        orphan = '{"c":"{{PHONE_qqqqqq}}"}'
        out = self._restore(orphan, j["sid"], stream_id="parity", final=True, escape=True)
        self.assertIn("{{PHONE_qqqqqq}}", out.get_json()["text"])

        ev = self._newest_ext_event("RESTORE")
        self.assertEqual(ev.get("unresolved"), 1,
                         "unresolved 必须进事件，否则日志页的「未还原」告警对扩展流量永不触发")
        self.assertEqual(ev.get("degraded"), 0, "degraded 需要有心跳值（0 也是值）")

    def test_restore_event_must_not_feed_proxy_only_aggregates(self):
        j = self._mask('{"c":"13812345678 zhang@example.com"}').get_json()
        self._restore(j["masked_text"], j["sid"], stream_id="parity2", final=True, escape=True)
        ev = self._newest_ext_event("RESTORE")

        for forbidden in ("status", "restore_status", "model", "usage"):
            self.assertNotIn(forbidden, ev,
                             f"扩展 RESTORE 不得带 {forbidden}：会污染 daily_status/"
                             f"daily_tokens/daily_models（SPEC §5.2(3) 明确要求不带）")
        # 语义断言（比字段名单更抗重构）：扩展流量不得在 daily_status 里留下任何一行
        self.assertEqual(event_store.today_stats().get("restore_by_status"), {},
                         "扩展流量污染了 daily_status（按代理口径阅读的统计表）")


class BodyLimitGateTests(ExtBridgeTestCase):
    """32MB 体积闸门必须是**对任意 framing 都生效**的硬闸（AGENTS 红线 2）。

    只判 `Content-Length` 是不够的：无该头时 `request.content_length` 是 None，
    `(None or 0) > LIMIT` 判成 False —— 闸门被整个绕过，而 `get_json` 仍会把流
    完整读进内存。实测（werkzeug）：chunked 请求的 `content_length is None`。
    """

    def _post_raw(self, payload, headers, environ=None):
        return self.client.open(
            "/api/ext/mask", method="POST",
            data=json.dumps(payload).encode("utf-8"),
            headers={"X-Shield-Token": self.EXT_TOKEN, "Content-Type": "application/json",
                     **headers},
            environ_overrides=environ or {},
        )

    def test_declared_oversize_blocked(self):
        r = self._post_raw({"text": "x"}, {},
                           environ={"CONTENT_LENGTH": str(40 * 1024 * 1024)})
        self.assertEqual(r.status_code, 413)
        self.assertIs(r.get_json().get("blocking"), True, "(A) 类必须带 blocking:true")

    def test_chunked_without_content_length_blocked(self):
        """攻击面：`Transfer-Encoding: chunked` + 无 Content-Length。"""
        # 先把「旧判据抓不住这种请求」固定下来——否则本用例只是复述实现：
        # 日后若有人删掉 chunked 分支，用例可能因为别的原因继续绿。
        with panel.app.test_request_context(
                "/api/ext/mask", method="POST",
                data=json.dumps({"text": "x"}).encode("utf-8"),
                headers={"Transfer-Encoding": "chunked"},
                environ_overrides={"CONTENT_LENGTH": ""}) as _ctx:
            from flask import request as _rq
            self.assertIsNone(_rq.content_length,
                              "本用例的前提是 content_length 拿不到（否则测的不是这条路径）")
            self.assertFalse((_rq.content_length or 0) > panel._EXT_MAX_BODY,
                             "旧判据（只比 content_length）在此必须为 False，"
                             "否则本用例无法证明 chunked 分支被覆盖")
            del _ctx
        r = self._post_raw({"text": "x"}, {"Transfer-Encoding": "chunked"},
                           environ={"CONTENT_LENGTH": ""})
        self.assertEqual(r.status_code, 413,
                         "chunked 请求绕过了体积闸门（content_length 为 None）")
        self.assertIs(r.get_json().get("blocking"), True)

    def test_normal_body_still_passes(self):
        """反向断言：正常链路不能被闸门误伤（否则整条扩展链路全 413）。"""
        r = self._post_raw({"text": '{"c":"13812345678"}'}, {})
        self.assertEqual(r.status_code, 200, r.get_data(as_text=True))
        self.assertTrue(r.get_json().get("ok"))


class ConstantParityTests(unittest.TestCase):
    """同一个红线在两个模块里各有一个常量时，**必须有一条测试钉住它们相等**。

    `panel._EXT_MAX_BODY` 与 `transparent._MAX_REQUEST_BODY` 都是 32MB（超限一律
    fail-closed 阻断，AGENTS 红线 2）。panel 端**故意不 import transparent** 取常量
    （panel 进程能否 import transparent 取决于解释器，见 panel.py 里的注释），所以
    数值只能各写一份——那就必须靠测试防漂移：改了一边忘了另一边，扩展链路与代理链路
    的体积红线就静默不一致了（示例后果：扩展能送 64MB 进 mask，代理链路 32MB 就 503）。
    """

    def test_body_limit_constants_match(self):
        self.assertEqual(
            panel._EXT_MAX_BODY, tr._MAX_REQUEST_BODY,
            "panel._EXT_MAX_BODY 与 transparent._MAX_REQUEST_BODY 已漂移："
            "两条链路的体积红线必须一致（面板端不 import transparent 是有意为之，"
            "所以只能靠本用例保证同步）",
        )

    def test_body_limit_is_32mib(self):
        """数值本身也钉住：两边一起被改成别的值时，至少还需要有人明确改这条。"""
        self.assertEqual(panel._EXT_MAX_BODY, 32 * 1024 * 1024)


class IngressAllowlistTests(unittest.TestCase):
    """`_normalize_ingress` 必须是**白名单归一化**，不是"有值就原样存"。

    读取侧的入口过滤是 `COALESCE(ingress,'proxy') = ?` 的精确等值匹配。任何非
    `proxy`/`ext` 的值都会落进一个**永远筛不出来、也永远不出现在任何分组里**的隐形
    分组 —— 事件在列表里能看见，按入口一筛就消失，比报错更难查。
    """

    def test_empty_becomes_proxy(self):
        self.assertEqual(event_store._normalize_ingress({"type": "MASK"})["ingress"], "proxy")
        self.assertEqual(event_store._normalize_ingress({"ingress": ""})["ingress"], "proxy")
        self.assertEqual(event_store._normalize_ingress({"ingress": None})["ingress"], "proxy")

    def test_known_values_kept(self):
        self.assertEqual(event_store._normalize_ingress({"ingress": "proxy"})["ingress"], "proxy")
        self.assertEqual(event_store._normalize_ingress({"ingress": "ext"})["ingress"], "ext")

    def test_case_is_folded(self):
        """大小写不一致是最容易出现的脏值（`ingress="EXT"`）——必须归一，不能留下。"""
        self.assertEqual(event_store._normalize_ingress({"ingress": "EXT"})["ingress"], "ext")
        self.assertEqual(event_store._normalize_ingress({"ingress": " Proxy "})["ingress"], "proxy")

    def test_unknown_value_falls_back_to_proxy(self):
        """不认识的值一律按 proxy 记：默认/多数路径，且**保证筛得出来**。"""
        for bad in ("extx", "browser", "PROXY2", "1", "proxy;ext"):
            got = event_store._normalize_ingress({"ingress": bad})["ingress"]
            self.assertIn(got, event_store.INGRESS_VALUES,
                          f"ingress={bad!r} 归一化成了 {got!r}，会形成筛不出来的隐形分组")
            self.assertEqual(got, "proxy", f"ingress={bad!r} 应回落到 proxy")

    def test_every_value_survives_the_read_filter(self):
        """闭环断言：归一化后的每个值都能被 `fetch_events(ingress=…)` 精确筛出来。"""
        for rec_in in ({}, {"ingress": "ext"}, {"ingress": "EXT"}, {"ingress": "bogus"}):
            got = event_store._normalize_ingress(dict(rec_in))["ingress"]
            self.assertIn(got, event_store.INGRESS_VALUES)


# ================= 审计 2026-09-19 修复项的钉死用例 =================

class ExtCredentialScrubTests(ExtBridgeTestCase):
    """审计 B1：扩展链路的事件对象整体都不许带凭据原文。

    ⚠️ 判据是**整个事件对象**，不是 `items[]`。B1 之所以漏，正是因为 `items[]`
    一直合规（凭据项只有 digest + preview），而同一个 payload 里的
    `dialog` / `req_preview` / `resp_preview` 是直接写 `text[:N]` 的原文切片。
    只断言 `items[]` 的用例会全绿放过它 —— 所以下面的断言遍历 payload 的**全部字符串**。
    """

    # 凭据形态（必须被清洗）+ 普通 PII（必须保留，用户明确要求详情弹窗能看到原文）
    CRED = "sk-abcdefghijklmnopqrstuvwxyz012345"
    PHONE = "13812345678"
    NAME = "张三"

    def _flatten_strings(self, obj, out=None):
        """把事件对象里所有字符串摊平，供「全字段」级断言使用。"""
        if out is None:
            out = []
        if isinstance(obj, str):
            out.append(obj)
        elif isinstance(obj, dict):
            for v in obj.values():
                self._flatten_strings(v, out)
        elif isinstance(obj, (list, tuple)):
            for v in obj:
                self._flatten_strings(v, out)
        return out

    def _mask_and_read_event(self):
        body = json.dumps({
            "model": "gpt-4o",
            "messages": [{"role": "user", "content":
                          f"联系人{self.NAME}，电话 {self.PHONE}，key 是 {self.CRED}"}],
        }, ensure_ascii=False)
        j = self._mask(body).get_json()
        self.assertTrue(j.get("ok"), f"mask 必须成功，实际 {j}")
        event_store.flush_event_queue()
        evs = [e for e in event_store.fetch_events(limit=50)
               if str(e.get("path") or "") == "/ext/mask"]
        self.assertTrue(evs, "扩展 mask 事件必须落库（否则本用例什么都没测到）")
        return body, j, evs[-1]

    def test_credential_plaintext_nowhere_in_event_object(self):
        _body, j, ev = self._mask_and_read_event()
        blob = "\n".join(self._flatten_strings(ev))
        self.assertNotIn(self.CRED, blob,
                         f"凭据原文出现在事件对象的某个字段里（B1 复发）。payload={ev}")
        # 顺带钉住「凭据本身确实被脱敏了」——否则上面的断言可能只是因为整条都没落库
        self.assertNotIn(self.CRED, j["masked_text"])
        self.assertIn("{{APIKEY_", j["masked_text"])

    def test_non_credential_plaintext_still_visible_in_detail_dialog(self):
        """反向锁：**不许**把清洗扩大到普通 PII。

        用户明确要求「弹窗查看要能看到脱敏的明文是什么」。详情弹窗的
        「脱敏 ↔ 原文」对照靠的就是 dialog / items[].original 里的普通 PII 原文；
        一旦有人把 `_redact_credentials` 换成更激进的清洗，这条会立刻红。
        """
        _body, _j, ev = self._mask_and_read_event()
        blob = "\n".join(self._flatten_strings(ev))
        self.assertIn(self.PHONE, blob,
                      "普通 PII（手机号）原文必须留在事件里，详情弹窗要靠它做对照")
        origs = [it.get("original") for it in (ev.get("items") or [])]
        self.assertIn(self.PHONE, origs,
                      "普通 PII 的 items[].original 必须保留（凭据类才是只有 digest+preview）")

    def test_credential_items_carry_no_original(self):
        _body, _j, ev = self._mask_and_read_event()
        cred_items = [it for it in (ev.get("items") or [])
                      if str(it.get("label") or "").upper() in
                      {"APIKEY", "API_KEY", "TOKEN", "SECRET", "JWT",
                       "ACCESSKEY", "PRIVATEKEY", "CONNSTR"}]
        self.assertTrue(cred_items, f"本用例的请求必然产生凭据项，实际 items={ev.get('items')}")
        for it in cred_items:
            self.assertNotIn("original", it, f"凭据项不许带 original：{it}")

    def test_credential_straddling_truncation_boundary_is_redacted(self):
        """凭据跨越 4000/800 字符截断边界时，必须先清洗再截断，绝不留半截明文残片。"""
        # 构造刚好跨越 4000 字符边界的长文本，带 PHONE 确保命中
        prefix = ("a" * 3975) + f" 电话{self.PHONE} "
        body = json.dumps({"content": prefix + self.CRED + " tail"}, ensure_ascii=False)
        j = self._mask(body).get_json()
        self.assertTrue(j.get("ok"))
        event_store.flush_event_queue()
        evs = [e for e in event_store.fetch_events(limit=50)
               if str(e.get("path") or "") == "/ext/mask"]
        self.assertTrue(evs)
        dialog = evs[-1].get("dialog") or ""
        # 截断后的 dialog 绝对不能包含凭据原文
        self.assertNotIn(self.CRED, dialog, "跨截断边界的凭据绝不许残留明文")


class RestoreSizeGateTests(ExtBridgeTestCase):
    """审计 M2：`/api/ext/restore` 的体积闸门与 `ext_frames` 条目上限。

    ⚠️ **用例里不许「现读现用」被保护的那个常量**。负向对照会把
    `panel._EXT_MAX_BODY` / `tr._EXT_FRAMES_MAX` patch 掉来模拟「修复被回退」，
    如果断言是从同一个属性现读的阈值，patch 之后断言会跟着一起变宽，
    用例就变成永远绿（实测踩过，第一版就是这么写的）。
    所以下面两个常量都在**模块导入时**抓快照。
    """

    def test_oversize_restore_is_passthrough_not_blocking(self):
        """超限必须回**不带 blocking** 的失败，让扩展按 (B) 桶把原文交回页面。

        这里刻意与 `/api/ext/mask` 的 413+blocking 相反：mask 方向阻断是安全的
        （明文不出网），restore 方向阻断只会让用户看到半截响应（红线 3 恒透传）。

        做法是把闸门**调小**到 256 字节再发 1KB 的 body —— 不必真造 32MB 请求体，
        而且断言的是闸门特有的错误码，比「ok 是 false」强得多：
        没有闸门时端点会照常还原并回 `ok:true`，这里立刻红。
        """
        j = self._mask('{"c":"13812345678"}').get_json()
        sid, masked = j["sid"], j["masked_text"]
        with mock.patch.object(panel, "_EXT_MAX_BODY", 256):
            r = self._ext("/api/ext/restore", {
                "text": masked + ("x" * 1024), "sid": sid,
                "stream_id": "m2", "final": True,
            })
        body = r.get_json() or {}
        self.assertIsNot(body.get("blocking"), True,
                         "(B) 类：restore 超限绝不许阻断，否则页面看到半截响应")
        self.assertEqual(body.get("error"), "payload_too_large",
                         f"必须命中体积闸门本身（没有闸门时会回 ok:true），实际 {body}")

    def test_normal_restore_still_works_after_gate(self):
        """闸门不能误伤正常链路（加闸门最常见的回归就是「顺手把正常路径也挡了」）。"""
        body = '{"c":"13812345678"}'
        j = self._mask(body).get_json()
        r = self._restore(j["masked_text"], j["sid"], final=True)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.get_json()["text"], body)

    def _restore_sse(self, text, sid, stream_id, final):
        """走 **SSE 分帧**路径的 restore。

        必须显式带 `content_type`：不带时引擎走「非流式整体」分支提前 return，
        `ext_frames` 一个条目都不会建 —— 那样写出来的上限用例会**永远绿**
        （实测踩过，第一版就是这么写的）。
        同理 `final=False` 也是必需的：`final=True` 会在返回前
        `frames.pop(stream_id)`，条目同样留不下来。
        """
        return self._ext("/api/ext/restore", {
            "text": text, "sid": sid, "stream_id": stream_id,
            "final": final, "content_type": "text/event-stream",
        })

    def test_ext_frames_is_capped(self):
        """`ext_frames` 是客户端可控字典：不设上限就能用大量 stream_id 撑大引擎内存。"""
        cap = _FRAMES_CAP_AT_IMPORT
        self.assertGreater(cap, 0)
        self.assertLess(cap, 4096, "上限本身要是个「小数字」，否则等于没有上限")
        j = self._mask('{"c":"13812345678"}').get_json()
        sid = j["sid"]
        # 每个新 stream_id 都会新增一个条目；非 final 才会留在 frames 里
        for i in range(cap + 20):
            r = self._restore_sse("data: {}\n\n", sid, f"cap-{i}", final=False)
            self.assertEqual(r.status_code, 200)
        frames = tr.sessions.get(sid, {}).get("ext_frames")
        self.assertIsInstance(frames, dict,
                              "这些 stream_id 必然建出 ext_frames，字典不该缺席")
        self.assertGreater(len(frames), 0,
                           "条目数为 0 说明这条路径根本没建帧缓冲，本用例没测到东西")
        self.assertLessEqual(
            len(frames), cap,
            f"ext_frames 必须有条目上限（cap={cap}），实际 {len(frames)} 条 —— 淘汰没生效")

    def test_streaming_restore_survives_eviction(self):
        """淘汰之后**新** stream_id 仍必须能正常还原（淘汰的是别人的帧，不是自己的）。"""
        j = self._mask('{"c":"13812345678"}').get_json()
        sid, masked = j["sid"], j["masked_text"]
        for i in range(_FRAMES_CAP_AT_IMPORT + 10):
            self._restore_sse("data: {}\n\n", sid, f"churn-{i}", final=False)
        # 跨两个 SSE 事件切开占位符，验证新流自己的缓冲是干净的（不串别人的残留）
        cut = masked.index("}}") + 2
        first, second = masked[:cut], masked[cut:]
        r1 = self._restore_sse("data: " + json.dumps({"t": first}) + "\n\n",
                               sid, "churn-final", final=False)
        r2 = self._restore_sse("data: " + json.dumps({"t": second}) + "\n\ndata: [DONE]\n\n",
                               sid, "churn-final", final=True)
        self.assertEqual(r1.status_code, 200)
        self.assertEqual(r2.status_code, 200)
        out = r1.get_json()["text"] + r2.get_json()["text"]
        self.assertNotIn("{{", out, f"跨事件切开的占位符必须拼回来，实际 {out!r}")
        self.assertIn("13812345678", out)


if __name__ == "__main__":
    unittest.main()
