#!/usr/bin/env python3
"""浏览器扩展桥接 e2e 冒烟：**真 Chrome + 真扩展 + 本地 mock 站点 + 真引擎**。

**不进 verify-all**（SPEC §6.2：可选执行）。文件名刻意不叫 `test_*.py`，
所以 `unittest discover -s tests` 不会带上它——它需要真浏览器，跑在 CI 上会又慢又脆。

## 运行前提

1. `pip install playwright && playwright install chromium`
2. 引擎依赖已装（flask 等），且用**装了依赖的那个解释器**跑（见 AGENTS.md 的 3.13 说明）
3. 有可用的图形会话（Windows 桌面 / 带 X 的 Linux）。扩展只能在**有头**的
   Chromium 里加载——playwright 的 `headless=True` 走的是 headless_shell，不支持扩展。

## 用法

    python tests/e2e_ext_bridge.py              # 全跑
    python tests/e2e_ext_bridge.py -k multipart # 只跑名字含关键词的用例
    python tests/e2e_ext_bridge.py -v           # 逐条打印

## 覆盖的断言（SPEC §6.2 的 1/2/3/4/5/6/10/11，另加 (B) 未脱敏与 SW 回收）

| # | 断言 | 用例 |
|---|---|---|
| 1 | ① LLM 路径 JSON body 出网已打码 | `test_01_llm_json_body_is_masked_outbound` |
| 2 | ② SSE 劈 chunk 占位符还原 + 续帧 JSON 可解析 | `test_02_sse_split_placeholder` |
| 3 | ③ 登录表单 email 原样到达（不能只断言 password） | `test_03_login_form_email_verbatim` |
| 4 | ④ 埋点响应未被包装 | `test_04_beacon_response_not_wrapped` |
| 5 | ⑤ 纯文本 SSE 无 `\\"` 垃圾 + 空 `data:` 首帧仍按 JSON 还原 | `test_05_plaintext_sse_and_empty_frame` |
| 6 | 双流并发 stream_id 隔离 | `test_06_two_streams_isolated` |
| 7 | 熔断：面板关开关 → 直通**且未脱敏**；(A) 阻断 | `test_07_disabled_passthrough_unmasked` / `test_07b_engine_failure_blocks` |
| 8 | SW 回收后签发表存活 | `test_08_sid_table_survives_sw_recycle` |
| 9 | 包装响应的 url/type/redirected 不变（框架兼容形状） | `test_09_wrapped_response_intact` |
| 10 | 默认桶：无 `blocking` 的 403 / 500 一律直通 | `test_10_default_bucket_passthrough` |
| 11 | multipart 守卫：FormData 原样放行 | `test_11_multipart_guard` |

**未自动覆盖**（需人工/真站点，SPEC §7 步骤 9）：真实 ChatGPT / Claude 联调、
**流进行中**的 SW 回收（见 `test_08` 内注释说明为何只测「回收后仍可用」）、
React / Svelte 真框架页面渲染。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import socket
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from werkzeug.serving import WSGIRequestHandler

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "engine"))
sys.path.insert(0, str(ROOT))

EXT_DIR = ROOT / "extension"

PHONE = "13812345678"
EMAIL = "zhang@example.com"
FORM_PASSWORD = "p@ssw0rd-looks-real-0000"
EXT_TOKEN = "ext-token-e2e-0000"

# 页面脚本把每次请求的原始响应/文本交回来做断言。
# 注意：这些 helper 跑在 **MAIN world**（page.evaluate 默认就是页面上下文），
# 所以看到的就是被 hook 之后的 fetch——这正是我们要验的东西。
PAGE_JS = r"""
window.__mk = {
  post(path, body, headers) {
    return fetch(path, {
      method: 'POST',
      headers: headers || { 'Content-Type': 'application/json' },
      body,
    }).then(async (r) => ({
      ok: true, status: r.status, type: r.type, url: r.url, redirected: r.redirected,
      ct: r.headers.get('content-type') || '', text: await r.text(),
      bodyIsStream: !!(r.body && typeof r.body.getReader === 'function'),
    })).catch((e) => ({ ok: false, error: String(e && e.name || e) }));
  },
  async stream(path, body) {
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let out = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += dec.decode(value, { stream: true });
    }
    out += dec.decode();
    return {
      ok: true, status: r.status, ct: r.headers.get('content-type') || '', text: out,
      cl: r.headers.get('content-length') || '', ce: r.headers.get('content-encoding') || '',
    };
  },
};
"""


class _Site(BaseHTTPRequestHandler):
    """mock 站点。记录每一个收到的请求体——「出网到底发了什么」由它作证。"""

    seen: list = []
    server_version = "MaskitMock/1.0"

    def log_message(self, *a):  # 静音
        pass

    # ── helpers ────────────────────────────────────────────────────────────
    def _read(self) -> bytes:
        n = int(self.headers.get("content-length") or 0)
        return self.rfile.read(n) if n else b""

    def _send(self, status: int, payload: dict, ct="application/json"):
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", ct)
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _record(self, raw: bytes, route: str):
        _Site.seen.append({
            "path": route,
            "ct": self.headers.get("content-type") or "",
            "body": raw.decode("utf-8", "replace"),
            "raw_len": len(raw),
        })

    def _token_in(self, body: str, label: str = "PHONE") -> str:
        m = re.search(r"\{\{" + label + r"_[a-z]{6}\}\}", body)
        return m.group(0) if m else ""

    def _sse(self, chunks):
        """按给定分片原样下发 SSE；每个分片之间 flush（模拟真实逐帧到达）。"""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()
        for c in chunks:
            self.wfile.write(c.encode("utf-8"))
            self.wfile.flush()
            time.sleep(0.03)
        self.close_connection = True

    # ── 路由 ───────────────────────────────────────────────────────────────
    #
    # ⚠️ 所有被测路径都必须是扩展 `isLLMRequest()` 白名单命中的形态
    # （`/(v1/)?(chat|completions|messages|responses)`），否则扩展根本不打码，
    # 用例会「因为没走桥而通过」——第一版把 SSE 放在 `/v1/stream` 就踩了这个坑。
    # 所以统一挂在 `/v1/chat/completions` 上，用 query 区分行为。
    def do_POST(self):
        route = self.path.split("?")[0]
        query = self.path.split("?", 1)[1] if "?" in self.path else ""
        raw = self._read()
        body = raw.decode("utf-8", "replace")
        self._record(raw, route)
        tok = self._token_in(body)
        email_tok = self._token_in(body, "EMAIL")

        if route == "/v1/chat/completions":
            if "split=1" in query:
                # ② 占位符劈 chunk：第一片切断在占位符中间，第二片补齐并带引号
                if not tok:
                    self._send(200, {"error": "no_placeholder"})
                    return
                cut = tok.index("_") + 3        # {{PHONE_kbx|rqz}}
                self._sse([
                    'data: {"delta":"' + tok[:cut],
                    tok[cut:] + '"}\n\n',
                    "data: [DONE]\n\n",
                ])
                return
            if "text=1" in query:
                # ⑤ 纯文本 SSE：data 行以 ASCII 字母开头 → escape 翻 false，`\"` 原样保留
                self._sse([
                    'data: hello \\"quoted\\" ' + (tok or email_tok or "") + "\n\n",
                    "data: [DONE]\n\n",
                ])
                return
            if "empty=1" in query:
                # ⑤b 空 data 首帧 → 维持 JSON 上下文（默认 true）
                self._sse([
                    "data:\n\n",
                    'data: {"delta":"' + (tok or "ok") + '"}\n\n',
                    "data: [DONE]\n\n",
                ])
                return
            if "reject=1" in query:
                self._send(403, {"error": "origin_rejected"})      # 无 blocking → (B)
                return
            if "boom=1" in query:
                self._send(500, {"error": "server_error"})         # 无 blocking → (B)
                return
            # 默认：回显收到的 body（非流式 JSON 响应 → 扩展做一次非流式还原）
            self._send(200, {"ok": True, "received": body})
            return

        if route == "/track":
            # ④ 埋点：非 LLM 路径。响应里塞一个占位符形态的串，断言页面拿到的是**原样**
            self._send(200, {"ok": True, "note": "{{PHONE_deadbe}}", "echo": body[:40]})
            return

        # 其它（含 /login）：原样回显
        self._send(200, {"ok": True, "received": body})

    def do_GET(self):
        route = self.path.split("?")[0]
        if route == "/":
            html = ("<!doctype html><meta charset=utf-8><title>mock</title>"
                    "<body><h1>mock</h1><script>" + PAGE_JS + "</script></body>")
            raw = html.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
            return
        if route == "/__seen":
            self._send(200, {"seen": _Site.seen})
            return
        if route == "/__clear":
            _Site.seen.clear()
            self._send(200, {"ok": True})
            return
        self._send(404, {"error": "not_found"})


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _start_site() -> tuple:
    port = _free_port()
    srv = ThreadingHTTPServer(("127.0.0.1", port), _Site)
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, port


class _QuietHandler(WSGIRequestHandler):
    """关掉 werkzeug 逐请求访问日志：面板每个 mask/restore 都刷一行，会把用例输出彻底冲没。"""

    def log_request(self, *a, **kw):
        pass


class _Engine:
    """把 panel 跑成一个真 HTTP 服务（扩展只能打真端口，Flask test_client 不够）。"""

    def __init__(self, tmp: Path):
        from werkzeug.serving import make_server

        os.environ["LLM_SHIELD_DATA_DIR"] = str(tmp)
        self.port = _free_port()
        os.environ["LLM_SHIELD_PANEL_PORT"] = str(self.port)
        import panel  # noqa: E402  —— 必须在 env 设好之后 import

        self.panel = panel
        panel.CONFIG_PATH = tmp / "config.json"
        self._write_cfg({"ext_bridge_enabled": True, "ext_token": EXT_TOKEN,
                         "ext_record_events": True, "ext_block_when_engine_down": False})
        self.srv = make_server("127.0.0.1", self.port, panel.app, threaded=True,
                               request_handler=_QuietHandler)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.port}"

    def _write_cfg(self, patch: dict):
        cfg = self.panel.load_config()
        cfg.update(patch)
        self.panel.save_config(cfg)
        try:
            self.panel._sync_runtime_config(cfg)
        except Exception:
            pass

    def set(self, **patch):
        self._write_cfg(patch)

    def seen(self) -> list:
        import urllib.request
        with urllib.request.urlopen(f"{self.base}/api/ext/ping",
                                    headers={"X-Shield-Token": EXT_TOKEN}) as r:
            json.load(r)
        return _Site.seen


_LOCK = threading.Lock()


class ExtBridgeE2E(unittest.TestCase):
    """全类共用一个浏览器 + 引擎 + mock 站点（启动成本高，逐用例重建太慢）。"""

    ctx = None
    pw = None
    engine: _Engine | None = None
    tmp: Path | None = None
    sw = None
    start_error = ""

    # ── 生命周期 ───────────────────────────────────────────────────────────
    @classmethod
    def setUpClass(cls):
        if not EXT_DIR.exists():
            raise unittest.SkipTest("extension/ 不存在")
        try:
            from playwright.sync_api import sync_playwright  # noqa: F401
        except Exception as e:  # pragma: no cover
            raise unittest.SkipTest(f"playwright 未安装：{e}")

        cls.tmp = Path(tempfile.mkdtemp(prefix="maskit-e2e-"))
        cls.engine = _Engine(cls.tmp)
        cls.site_srv, cls.site_port = _start_site()

        from playwright.sync_api import sync_playwright
        cls.pw = sync_playwright().start()
        profile = cls.tmp / "chrome-profile"
        try:
            cls.ctx = cls.pw.chromium.launch_persistent_context(
                str(profile),
                headless=False,
                args=[
                    f"--disable-extensions-except={EXT_DIR}",
                    f"--load-extension={EXT_DIR}",
                    "--no-first-run",
                    "--no-default-browser-check",
                ],
            )
        except Exception as e:  # pragma: no cover
            cls.start_error = str(e)
            raise unittest.SkipTest(f"无法启动带扩展的 Chromium（需要图形会话）：{e}")

        cls.sw = cls._wait_sw()
        # 配置扩展：面板地址 + 令牌 + 把 mock 站点加入白名单
        cls.sw.evaluate(
            """(cfg) => chrome.storage.local.set(cfg)""",
            {"token": EXT_TOKEN, "panelUrl": cls.engine.base, "enabled": True,
             "enabledSites": ["chatgpt.com", "claude.ai", "127.0.0.1"]},
        )
        # 动态注册（onInstalled 已跑过一次，但白名单是刚写的 → 手动重同步）
        cls.sw.evaluate("() => self.syncDynamicScripts()")

    @classmethod
    def _wait_sw(cls, timeout=20):
        """取 SW 句柄（**只能用来确认它存在**，不要 `evaluate`）。

        ⚠️ 实测结论（一次性探针，2026-09-15）：
        · `ctx.service_workers` **恒只有一个条目**（回收前后都一样）；
        · 它的 `evaluate` **必定报 "Execution context was destroyed"**，即使刚刚
          用 CDP `stopAllWorkers` 回收过、之后又跑过一次真实往返、CDP 的
          `Target.getTargets` 也报 `attached: true` —— Playwright 侧的 Worker
          句柄在这套 harness 里**读不到 JS 上下文**；
        · 更糟的是探活 `evaluate` 会**挂住不抛**（实测整个用例集 10s → 2min 被超时杀）。

        所以：**要读扩展内部状态（storage 等），走扩展自己的页面**
        `chrome-extension://<id>/options.html`（见 `_ext_id` / `_storage_dump`）；
        本方法只保留给「确认 SW 起过」这类存在性判断。
        """
        deadline = time.time() + timeout
        while time.time() < deadline:
            workers = list(cls.ctx.service_workers)
            if workers:
                return workers[-1]
            try:
                cls.ctx.wait_for_event("serviceworker", timeout=2000)
            except Exception:
                pass
        raise unittest.SkipTest("等了 20s 没等到扩展 service worker")

    def _ext_id(self):
        """扩展 ID：从 CDP 的 target 列表里取。

        Playwright 没有公开「取扩展 ID」的 API，而扩展 ID **取决于加载路径的绝对路径哈希**
        （manifest 无 `key`），所以每次跑临时目录都会变 —— 不能硬编码。
        CDP `Target.getTargets` 是纯协议调用，不涉及 Playwright 的 Worker 句柄，
        不会挂（这正是它优于 `sw.evaluate` 的原因）。
        """
        cdp = self.ctx.new_cdp_session(self.page)
        try:
            for t in cdp.send("Target.getTargets").get("targetInfos", []):
                url = str(t.get("url") or "")
                if url.startswith("chrome-extension://"):
                    return url.split("//", 1)[1].split("/", 1)[0]
        finally:
            try:
                cdp.detach()
            except Exception:
                pass
        raise unittest.SkipTest("拿不到扩展 ID（CDP 列表里没有 chrome-extension:// target）")

    def _storage_dump(self) -> str:
        """在扩展页面里把两个 storage 域整个 dump 成 JSON 字符串（存断言用）。"""
        page = self.ctx.new_page()
        try:
            page.goto(f"chrome-extension://{self._ext_id()}/options.html",
                      wait_until="load", timeout=10000)
            return page.evaluate(
                """async () => {
                     const s = await chrome.storage.session.get(null);
                     const l = await chrome.storage.local.get(null);
                     return JSON.stringify({ session: s, local: l });
                   }"""
            )
        finally:
            try:
                page.close()
            except Exception:
                pass

    @classmethod
    def tearDownClass(cls):
        try:
            if cls.ctx:
                cls.ctx.close()
        except Exception:
            pass
        try:
            if cls.pw:
                cls.pw.stop()
        except Exception:
            pass
        try:
            cls.site_srv.shutdown()
        except Exception:
            pass
        try:
            if cls.engine:
                cls.engine.srv.shutdown()
        except Exception:
            pass
        if cls.tmp:
            import shutil
            shutil.rmtree(cls.tmp, ignore_errors=True)

    # ── per-test ───────────────────────────────────────────────────────────
    def setUp(self):
        with _LOCK:
            _Site.seen.clear()
        self.page = self.ctx.new_page()
        self.url = f"http://127.0.0.1:{self.site_port}/"
        self.page.goto(self.url, wait_until="load")
        self.page.wait_for_function("() => !!window.__mk", timeout=10000)

    def tearDown(self):
        try:
            self.page.close()
        except Exception:
            pass

    # ── 工具 ──────────────────────────────────────────────────────────────

    def _ext_eval(self, js, arg=None):
        """在**扩展自己的页面**里跑一段 JS 并取回结果。

        不要用 `self.sw.evaluate`：SW 句柄在这套 harness 里一旦被
        `ServiceWorker.stopAllWorkers` 回收过就会**挂住不抛**（见 `_wait_sw` 的实测
        说明），用例间会互相污染。开一个 `chrome-extension://<id>/options.html`
        页面来读/写扩展状态与顺序无关，代价只是一次本地页面加载。
        """
        page = self.ctx.new_page()
        try:
            page.goto(f"chrome-extension://{self._ext_id()}/options.html",
                      wait_until="load", timeout=10000)
            return page.evaluate(js, arg) if arg is not None else page.evaluate(js)
        finally:
            try:
                page.close()
            except Exception:
                pass

    def _sw_status(self) -> dict:
        """SW 里的 `maskit:status`（引擎状态机当前形态：ok/down/error/invalid_token/…）。"""
        raw = self._ext_eval(
            """async () => {
                 const s = await chrome.storage.session.get('maskit:status');
                 return JSON.stringify(s['maskit:status'] || {});
               }"""
        )
        try:
            return json.loads(raw or "{}")
        except Exception:
            return {}

    def _count_reject_lines(self, reason: str) -> int:
        """panel 「运行日志」里 `_guard_reject` 的拒绝行数（按 reason 过滤）。

        这是"日志有没有被刷爆"的**唯一可信来源**：读过 800 行环形缓冲的 tail，
        而不是去看扩展侧自己记的计数（那只能证明扩展以为发生了什么）。
        """
        import urllib.request

        req = urllib.request.Request(
            f"{self.engine.base}/api/logs?limit=1",
            headers={"X-Shield-Token": self.engine.panel.API_TOKEN},
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            data = json.load(r)
        needle = f"reason={reason}"
        return sum(1 for line in (data.get("tail") or []) if needle in str(line))

    def _post(self, path, body, headers=None):
        return self.page.evaluate(
            "([p, b, h]) => window.__mk.post(p, b, h)", [path, body, headers])

    def _stream(self, path, body):
        return self.page.evaluate("([p, b]) => window.__mk.stream(p, b)", [path, body])

    def _last(self, path):
        for rec in reversed(_Site.seen):
            if rec["path"] == path:
                return rec
        return None

    @staticmethod
    def _llm_body(text: str) -> str:
        """> 80 字符的 JSON body（bridge-main 的 MIN_MASKABLE_LEN=80）。"""
        return json.dumps({"model": "gpt-x", "messages": [{"role": "user", "content": text}]},
                          ensure_ascii=False) + '"pad":"' + "x" * 60 + '"'

    # ══ 1 ══════════════════════════════════════════════════════════════════
    def test_01_llm_json_body_is_masked_outbound(self):
        """① LLM 路径 JSON body：**出网的那份**已打码（在 mock 站点侧作证）。"""
        body = self._llm_body(f"客户 {PHONE} 与 {EMAIL} 请联系")
        res = self._post("/v1/chat/completions", body)
        self.assertTrue(res["ok"], res)

        rec = self._last("/v1/chat/completions")
        self.assertIsNotNone(rec, "mock 站点没收到请求")
        self.assertRegex(rec["body"], r"\{\{PHONE_[a-z]{6}\}\}", "出网 body 未打码")
        self.assertRegex(rec["body"], r"\{\{EMAIL_[a-z]{6}\}\}")
        self.assertNotIn(PHONE, rec["body"], "明文手机号出网了")
        self.assertNotIn(EMAIL, rec["body"], "明文邮箱出网了")
        # 页面侧拿回的是还原后的原文（非流式也要还原）
        self.assertIn(PHONE, res["text"])
        self.assertIn(EMAIL, res["text"])

    # ══ 2 ══════════════════════════════════════════════════════════════════
    def test_02_sse_split_placeholder(self):
        """② 占位符劈 chunk + 续帧含引号：拼起来还原且 JSON 合法。"""
        body = self._llm_body(f"电话 {PHONE}")
        res = self._stream("/v1/chat/completions?split=1", body)
        self.assertTrue(res["ok"], res)
        self.assertIn(PHONE, res["text"], "劈半的占位符没还原")

        # 续帧 JSON 必须可解析（escape=true 下引号处理正确）
        payloads = [l[len("data: "):] for l in res["text"].splitlines()
                    if l.startswith("data: ") and not l.endswith("[DONE]")]
        self.assertTrue(payloads, "没有 SSE data 帧")
        for p in payloads:
            json.loads(p)          # 抛异常即失败

    # ══ 3 ══════════════════════════════════════════════════════════════════
    def test_03_login_form_email_verbatim(self):
        """③ 登录表单（非 LLM 路径、body>80）：email 原样到达。

        只断言 password 是恒绿的——SECRET 默认关，password 本来就不会被打码。
        """
        body = json.dumps({"email": EMAIL, "password": FORM_PASSWORD,
                           "remember": True, "csrf": "x" * 40})
        self.assertGreater(len(body), 80)
        res = self._post("/login", body)
        self.assertTrue(res["ok"], res)

        rec = self._last("/login")
        self.assertIsNotNone(rec)
        self.assertIn(EMAIL, rec["body"], "登录表单的 email 被误伤了")
        self.assertNotIn("{{EMAIL_", rec["body"])

    # ══ 4 ══════════════════════════════════════════════════════════════════
    def test_04_beacon_response_not_wrapped(self):
        """④ 埋点（非 LLM 路径）：响应对象未被包装，内容原样。"""
        res = self._post("/track", json.dumps({"evt": "click", "pad": "y" * 80}))
        self.assertTrue(res["ok"], res)
        self.assertIn("{{PHONE_deadbe}}", res["text"], "非 LLM 响应被误还原/包装了")

    # ══ 5 ══════════════════════════════════════════════════════════════════
    def test_05_plaintext_sse_and_empty_frame(self):
        """⑤ 纯文本 SSE 无 `\\"` 垃圾；空 `data:` 首帧仍按 JSON 上下文还原。"""
        body = self._llm_body(f"电话 {PHONE}")

        plain = self._stream("/v1/chat/completions?text=1", body)
        self.assertTrue(plain["ok"], plain)
        self.assertIn(r'\"quoted\"', plain["text"],
                      "纯文本上下文 escape 未翻 false，引号被吃掉了")

        empty = self._stream("/v1/chat/completions?empty=1", body)
        self.assertTrue(empty["ok"], empty)
        self.assertIn(PHONE, empty["text"], "空 data 首帧后按纯文本处理了，导致漏还原")

    # ══ 6 ══════════════════════════════════════════════════════════════════
    def test_06_two_streams_isolated(self):
        """⑥ 双流并发：两条 SSE 各自的 stream_id/sid 隔离，互不串号。"""
        bodyA = self._llm_body(f"甲 {PHONE}")
        bodyB = self._llm_body(f"乙 {PHONE}")

        out = self.page.evaluate(
            """async ([a, b]) => {
                 const [ra, rb] = await Promise.all([window.__mk.stream('/v1/stream', a),
                                                     window.__mk.stream('/v1/stream', b)]);
                 return [ra.text, rb.text];
               }""",
            [bodyA, bodyB],
        )
        for text in out:
            self.assertIn(PHONE, text)
            self.assertNotIn("{{", text)

    # ══ 7 ══════════════════════════════════════════════════════════════════
    def test_07_disabled_passthrough_unmasked(self):
        """⑦ 面板关开关 → (B) 直通，**且是未脱敏**（SPEC §5.4 的核心语义）。"""
        self.engine.set(ext_bridge_enabled=False)
        try:
            body = self._llm_body(f"客户 {PHONE}")
            res = self._post("/v1/chat/completions", body)
            self.assertTrue(res["ok"], f"关开关不该断网：{res}")
            rec = self._last("/v1/chat/completions")
            self.assertIn(PHONE, rec["body"], "直通时正文应保持明文（这就是未脱敏）")
            self.assertNotIn("{{PHONE_", rec["body"])
        finally:
            self.engine.set(ext_bridge_enabled=True)
        # 恢复后立刻可用
        res = self._post("/v1/chat/completions", self._llm_body(f"客户 {PHONE}"))
        self.assertTrue(res["ok"], res)
        self.assertRegex(self._last("/v1/chat/completions")["body"], r"\{\{PHONE_")

    def test_07b_token_invalid_passthrough(self):
        """⑦b token 打错 → 403 invalid_token → (B) 直通（同样未脱敏），不阻断。"""
        self.sw.evaluate("() => chrome.storage.local.set({ token: 'wrong-token-0000' })")
        try:
            body = self._llm_body(f"客户 {PHONE}")
            res = self._post("/v1/chat/completions", body)
            self.assertTrue(res["ok"], f"token 失效不该断网：{res}")
            self.assertIn(PHONE, self._last("/v1/chat/completions")["body"])
        finally:
            self.sw.evaluate("(t) => chrome.storage.local.set({ token: t })", EXT_TOKEN)

    def test_07c_auth_backoff_throttles_reject_flood(self):
        """⑦c token 失效后的**退避降速**：面板「运行日志」不再被每次调用刷一行。

        缺陷背景（实测）：restore 是**每 SSE chunk 一次**调用。token 失效时每个 chunk
        都会打到 panel，每次经 `_guard_reject` 写一行 `[panel] 拒绝 … reason=invalid_token`
        → 800 行环形缓冲被一条回答冲干净，「运行日志」里崩溃现场的 Traceback 全没了
        （SPEC §5.4 的诊断能力直接归零）。

        判据是**可观测的后果**，不是"实现里有个 if"：
          ① 退避期内连打 N 次真实 LLM 请求，panel 侧的 invalid_token 拒绝行远少于 N；
          ② 拒绝行**仍然有**（不是把日志关了——那不是修好，那是把证据丢掉）；
          ③ 状态仍是 `invalid_token`（红标语义没被降级成「引擎未运行」黄标）；
          ④ 令牌改回来后**秒级自愈**（低速探测），不用盲等整段窗口。
        """
        wrong = "wrong-token-0000"
        self._ext_eval("(t) => chrome.storage.local.set({ token: t })", wrong)
        try:
            before = self._count_reject_lines("invalid_token")
            calls = 0
            for i in range(12):
                res = self._post("/v1/chat/completions", self._llm_body(f"退避测试 {i} {PHONE}"))
                self.assertTrue(res["ok"], f"退避期内不该断网：{res}")
                calls += 1
                self.assertIn(PHONE, self._last("/v1/chat/completions")["body"],
                              "退避期仍必须是明文直通（未脱敏），不能变成阻断")
            new_rejects = self._count_reject_lines("invalid_token") - before

            # ① 降速生效：12 次请求（每次至少 1 次 mask + 1 次 restore 调用）不该产生
            #    十几行拒绝。上限给到 4：首次拒绝 1 行 + ping 探测 1 行 + 5s 探测 1~2 行。
            self.assertLessEqual(
                new_rejects, 4,
                f"退避没生效：{calls} 次请求产生了 {new_rejects} 行 invalid_token 拒绝 —— "
                f"每 chunk 一行会把 800 行环形缓冲冲干净（SPEC §5.4 的诊断能力归零）",
            )
            # ② 反向断言：拒绝**必须仍然被记录**。把日志关掉/不再记录不是修复，是丢证据。
            # ② 反向断言：拒绝**必须仍然被记录**。把日志关掉/不再记录不是修复，是丢证据。
            #    这里看**总数**而不是本次增量：前一条用例（07b）已经用错 token 打过一次
            #    403，进入退避后探测频率被压到 5s 一次，紧接着跑的本用例完全可能一行都不
            #    新增（实测：单独跑绿、整套跑红 —— 写成增量就是次序相关断言）。
            self.assertGreater(self._count_reject_lines("invalid_token"), 0,
                               "退避把拒绝日志一起吞了 —— 用户将无从归因（不能静默）")
            # ③ 状态语义：红标「token 失效」而不是黄标「引擎未运行」
            st = self._sw_status()
            self.assertEqual(st.get("engine"), "invalid_token",
                             f"退避后状态被改成了 {st.get('engine')!r}，"
                             f"把「你配置错了」说成了「引擎没起来」（SPEC §3.6）")

            # ④ 自愈：改回正确令牌后，最迟几秒内（低速探测命中）就恢复脱敏
            self._ext_eval("(t) => chrome.storage.local.set({ token: t })", EXT_TOKEN)
            recovered = False
            for i in range(10):
                self._post("/v1/chat/completions", self._llm_body(f"自愈 {i} {PHONE}"))
                if "{{PHONE_" in (self._last("/v1/chat/completions")["body"] or ""):
                    recovered = True
                    break
                time.sleep(1)
            self.assertTrue(recovered,
                            "令牌改回后 10s 内没有恢复脱敏 —— 低速探测没生效，"
                            "用户修复后仍要盲等一整段退避窗口（期间流量是静默未脱敏的）")
        finally:
            self._ext_eval("(t) => chrome.storage.local.set({ token: t })", EXT_TOKEN)

    # ══ 8 ══════════════════════════════════════════════════════════════════
    def test_08_sid_table_survives_sw_recycle(self):
        """⑧ SW 回收后签发表存活（chrome.storage.session 的立命之本）。

        只测「回收 → 重新可用」。**流进行中**被回收不在此覆盖：那时扩展侧的
        `postMessage` 通道已断，该 chunk 的 restore 会等到 3s 超时按直通发出——
        这是设计上的取舍（宁可一个 chunk 不还原，也不能卡住用户的流），
        要稳定复现得靠人工在 chrome://serviceworker-internals 上做，见模块 docstring。
        """
        # 先跑一次，确保签名表里有东西
        self._post("/v1/chat/completions", self._llm_body(f"客户 {PHONE}"))

        cdp = self.ctx.new_cdp_session(self.page)
        try:
            cdp.send("ServiceWorker.enable")
            cdp.send("ServiceWorker.stopAllWorkers")
        except Exception as e:
            self.skipTest(f"CDP 不支持停 SW：{e}")
        time.sleep(1.5)
        # 只确认 SW 又起来了（句柄本身已不可 evaluate，见 _wait_sw 的实测说明）
        self._wait_sw()

        res = self._post("/v1/chat/completions", self._llm_body(f"回收后 {EMAIL}"))
        self.assertTrue(res["ok"], f"SW 回收后不可用：{res}")
        self.assertRegex(self._last("/v1/chat/completions")["body"], r"\{\{EMAIL_")
        self.assertIn(EMAIL, res["text"], "SW 回收后还原失败——签名表没活过回收")

    # ══ 9 ══════════════════════════════════════════════════════════════════
    def test_09_wrapped_response_intact(self):
        """⑨ 包装响应仍是合法 Response 形状（框架不报错的必要条件）。"""
        res = self._stream("/v1/chat/completions?split=1", self._llm_body(f"电话 {PHONE}"))
        self.assertTrue(res["ok"])
        clean = self._post("/v1/chat/completions", self._llm_body(f"电话 {PHONE}"))
        self.assertEqual(clean["type"], "basic")
        self.assertTrue(clean["url"].endswith("/v1/chat/completions"))
        self.assertFalse(clean["redirected"])
        self.assertTrue(clean["bodyIsStream"], "body 不是可读流，框架读不了")
        # SSE 还原后长度已变：content-length / content-encoding 必须已被删除（交回 chunked），
        # 留着会让浏览器按旧长度截断或按 gzip 解压已解码的流。
        self.assertEqual(res["cl"], "", "包装后仍带旧的 content-length")
        self.assertEqual(res["ce"], "", "包装后仍带旧的 content-encoding")

    # ══ 10 ═════════════════════════════════════════════════════════════════
    def test_10_default_bucket_passthrough(self):
        """⑩ 默认桶：无 `blocking` 的 403 与 500 一律直通，**不得 reject**。

        这条是防「v2.1 全站断网」回归的关键：枚举状态码必然漏，
        所以只有引擎显式标了 `blocking: true` 才算 (A)。
        """
        for path, status in (("/v1/chat/completions?reject=1", 403), ("/v1/chat/completions?boom=1", 500)):
            res = self._post(path, self._llm_body(f"客户 {PHONE}"))
            self.assertTrue(res["ok"], f"{path} 被当成 (A) 阻断了：{res}")
            self.assertEqual(res["status"], status)

    # ══ 11 ═════════════════════════════════════════════════════════════════
    def test_11_multipart_guard(self):
        """⑪ multipart 守卫：FormData 原样放行（body 未被字符串化、boundary 未变）。"""
        out = self.page.evaluate(
            """async () => {
                 const fd = new FormData();
                 fd.append('file', new Blob(['x'.repeat(200)], { type: 'text/plain' }), 'a.txt');
                 fd.append('note', '客户 13812345678');
                 const r = await fetch('/v1/chat/completions', { method: 'POST', body: fd });
                 return { status: r.status, text: await r.text() };
               }"""
        )
        self.assertEqual(out["status"], 200, out)
        rec = self._last("/v1/chat/completions")
        self.assertIn("multipart/form-data", rec["ct"], "Content-Type 变了")
        self.assertIn("boundary=", rec["ct"], "boundary 丢了")
        # 契约已随实现变更（见 `extension/bridge-main.js` 的 maskMultipart）：
        # 文本字段要打码、文件字段走 /api/ext/mask-file，**不再**整体原样放行。
        # 原断言「body 里必须有原文」与实现相反，于是长期红着——它真正要守的是
        # 「multipart 结构不能被破坏」：体仍是合法 multipart、boundary 与头一致、
        # 无敏感内容的附件字节原样、文本字段已打码。
        boundary = rec["ct"].split("boundary=", 1)[1].split(";")[0].strip().strip('"')
        body = rec["body"] or ""
        self.assertTrue(body.startswith("--" + boundary), "multipart 起始边界不合法")
        self.assertTrue(body.rstrip().endswith("--" + boundary + "--"),
                        "multipart 结束边界丢了（上游会 400）")
        self.assertIn('filename="a.txt"', body, "附件头被破坏")
        self.assertIn("x" * 200, body, "无敏感内容的附件不得被改写/截断")
        self.assertNotIn(PHONE, body, "multipart 里的文本字段必须已打码")
        self.assertRegex(body, r"\{\{PHONE_")

    # ══ 12 ═════════════════════════════════════════════════════════════════
    def test_12_extension_storage_holds_no_plaintext(self):
        """⑫ 隐私红线：扩展存储里**不得出现正文或占位符**（只允许元数据）。

        为什么必须单独钉一条（审计补）：SW 的 `chrome.storage.session` 存两样东西——
        sid 签发表与「最近请求」缓冲，后者要展示给用户看，因此是**最容易被后人
        "顺手加个 preview/body 便于排查"**的地方；一旦加进去，等于把 PII 与
        「原文↔占位符」的映射写进浏览器 profile（落盘、可被 profile 备份/取证带出），
        而这条红线在单测里根本够不着（Python 侧看不到扩展存储）。
        做法：先跑一条含手机号/邮箱的真实往返，再把两个 storage 域整个 dump 出来扫。
        """
        body = self._llm_body(f"客户 {PHONE} 与 {EMAIL} 请联系")
        res = self._post("/v1/chat/completions", body)
        self.assertTrue(res["ok"], res)
        self.assertIn(PHONE, res["text"], "前置条件：往返必须真的还原过，否则本用例扫的是空集合")

        # 在**扩展自己的页面**里读（SW 句柄在这套 harness 里不可 evaluate，见 _wait_sw）
        dump = self._storage_dump()
        self.assertNotIn(PHONE, dump, "扩展存储里出现了明文手机号")
        self.assertNotIn(EMAIL, dump, "扩展存储里出现了明文邮箱")
        self.assertNotRegex(dump, r"\{\{[A-Z0-9]+_[a-z]{6}\}\}",
                            "扩展存储里出现了占位符（只该存 sid，不该存原文↔占位符映射）")
        # 反向断言：dump 必须是「有内容」的，否则上面三条是空集合上的假绿
        self.assertIn("maskit:recent", dump, "元数据缓冲没落存储，本用例失去鉴别力")
        self.assertIn("maskit:daily", dump, "日计数没落存储，本用例失去鉴别力")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("-k", dest="pattern", default="", help="只跑名字含该关键词的用例")
    ap.add_argument("-v", dest="verbose", action="store_true", help="逐条打印")
    args = ap.parse_args()

    loader = unittest.TestLoader()
    if args.pattern:
        loader.testMethodPrefix = "test"
    suite = loader.loadTestsFromTestCase(ExtBridgeE2E)
    if args.pattern:
        suite = unittest.TestSuite(
            t for t in suite if args.pattern.lower() in t.id().lower())
    res = unittest.TextTestRunner(verbosity=2 if args.verbose else 1).run(suite)
    return 0 if res.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main())
