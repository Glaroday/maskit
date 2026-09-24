"""事故复现与验证：脱敏在跑时，代理的其他连接会不会被冻住（2026-09-24）。

不进单测套件（要起真实 mitmdump + 假上游 + 固定端口），手动跑：
    python tests/repro_mask_freeze.py            # 修复后：B 应当很快返回
    python tests/repro_mask_freeze.py --control  # 反例：把钩子改回同步阻塞，B 必然被冻

复现的是当时的现象：一条长会话脱敏实测 20+ 秒，期间代理端口上的其他请求全部拿不到
响应；在途请求的上游连接被上游判死断开，客户端看到引擎自己渲染的 502
（`<p>connection closed</p>`）。

这里用「在 `_mask_pipeline_worker` 里注入固定 sleep」代替真实长会话——要复现的是
**脱敏占用事件循环**这件事，不是 NER 本身，注入固定时长比依赖 NER 成本更稳。

判定标准：
  ① A（POST /v1/chat/completions）触发慢脱敏；
  ② A 进入脱敏后，另一条连接上的 B（GET /v1/models，只读、不脱敏）必须
     远早于慢脱敏结束就拿到响应 —— 这才是「不冻住整机」。
反例对照（--control）把 request 钩子换成同步阻塞版本，B 必然被拖到整个 sleep 之后，
证明这套判定确实能抓到冻结，而不是空转。
"""
import json
import os
import socket
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
TRANSPARENT_PY = ROOT / "engine" / "transparent.py"
WORK = ROOT / "_smoke_data" / "offload"
UPSTREAM_PORT = 18993
PROXY_PORT = 18994
SLOW_MASK_S = 3.0

CONTROL = "--control" in sys.argv

# 注入器：单独生成的 addon。
# ⚠️ 必须是**唯一**的 `-s`：mitmproxy 用 SourceFileLoader 手动 exec_module，不往
# `sys.modules` 里注册，所以再写一个 `-s` 去 `import transparent` 拿到的是另一份副本，
# 改它没有任何效果（实测踩过）。这里由本模块自己 import transparent 并转发钩子，
# 保证改的就是真正在跑的那份模块。
INJECTOR_PY = WORK / "mask_slowdown.py"
INJECTOR_SRC = '''
import os, sys, time

sys.path.insert(0, r"%s")
import transparent as T

_DELAY = float(os.environ.get("MASKIT_REPRO_DELAY", "3"))

if os.environ.get("MASKIT_REPRO_CONTROL") == "1":
    # 反例：request 钩子同步阻塞（修复前的形态）——事件循环被占住。
    def request(flow):
        time.sleep(_DELAY)
else:
    _orig = T._mask_pipeline_worker

    def _slow_worker(*a, **k):
        time.sleep(_DELAY)
        return _orig(*a, **k)

    T._mask_pipeline_worker = _slow_worker
    request = T.request

response = T.response
responseheaders = T.responseheaders
error = T.error
''' % (ROOT / "engine")


class FakeUpstream(BaseHTTPRequestHandler):
    """假上游：GET 立即回；POST 回一个个 JSON，够客户端判断 200 即可。"""

    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _send(self, code, payload: bytes):
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        self._send(200, b'{"data":[{"id":"m"}]}')

    def do_POST(self):
        n = int(self.headers.get("content-length") or 0)
        body = self.rfile.read(n) if n else b""
        self.server.last_body = body
        self._send(200, json.dumps({"choices": [{"message": {"content": "ok"}}]}).encode())


def wait_port(port, timeout=25):
    end = time.time() + timeout
    while time.time() < end:
        with socket.socket() as s:
            s.settimeout(0.4)
            if s.connect_ex(("127.0.0.1", port)) == 0:
                return True
        time.sleep(0.2)
    return False


def main():
    WORK.mkdir(parents=True, exist_ok=True)
    INJECTOR_PY.write_text(INJECTOR_SRC, encoding="utf-8")
    cfg = {
        "capture_mode": "reverse",
        "sensitive": {"人名": ["王大锤"]},
        "upstreams": [{
            "name": "repro", "base_path": "/repro", "port": PROXY_PORT,
            "target": f"http://127.0.0.1:{UPSTREAM_PORT}",
            "paths": ["/v1/chat/completions"],
        }],
        "filter_enabled": True, "fail_closed": True, "session_ttl": 600,
    }
    (WORK / "config.json").write_text(json.dumps(cfg, ensure_ascii=False), encoding="utf-8")

    srv = HTTPServer(("127.0.0.1", UPSTREAM_PORT), FakeUpstream)
    srv.last_body = b""
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    env = {**os.environ, "LLM_SHIELD_DATA_DIR": str(WORK), "PYTHONUTF8": "1",
           "MASKIT_REPRO_DELAY": str(SLOW_MASK_S),
           "MASKIT_REPRO_CONTROL": "1" if CONTROL else "0",
           "PYTHONPATH": str(ROOT / "engine") + os.pathsep + os.environ.get("PYTHONPATH", "")}
    proc = subprocess.Popen(
        ["mitmdump", "-s", str(INJECTOR_PY),
         "--listen-host", "127.0.0.1",
         "--mode", f"reverse:http://127.0.0.1:{UPSTREAM_PORT}@{PROXY_PORT}",
         "--set", "flow_detail=0", "--set", "connection_strategy=lazy"],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        encoding="utf-8", errors="replace", env=env,
    )
    logs = []
    threading.Thread(target=lambda: [logs.append(l) for l in proc.stdout], daemon=True).start()
    try:
        if not wait_port(PROXY_PORT):
            print("FAIL: 代理端口未监听\n" + "".join(logs[-25:]))
            return 1

        a_result = {}

        def slow_request():
            payload = json.dumps({"model": "m", "stream": False,
                                  "messages": [{"role": "user", "content": "客户王大锤"}]},
                                 ensure_ascii=False).encode("utf-8")
            req = Request(f"http://127.0.0.1:{PROXY_PORT}/v1/chat/completions", data=payload,
                          headers={"content-type": "application/json"}, method="POST")
            t0 = time.time()
            try:
                with urlopen(req, timeout=60) as resp:
                    a_result["code"] = resp.status
                    a_result["body"] = resp.read(400).decode("utf-8", "replace")
            except Exception as e:
                a_result["error"] = "%s: %s" % (type(e).__name__, e)
            a_result["secs"] = time.time() - t0

        th = threading.Thread(target=slow_request, daemon=True)
        th.start()
        time.sleep(0.5)  # 让 A 真正进入脱敏

        # B：另一条连接上的只读请求，不参与脱敏
        t0 = time.time()
        try:
            with urlopen(Request(f"http://127.0.0.1:{PROXY_PORT}/v1/models"), timeout=60) as resp:
                b_code = resp.status
        except Exception as e:
            b_code = "%s: %s" % (type(e).__name__, e)
        b_secs = time.time() - t0

        th.join(timeout=60)
        mode = "反例对照（同步阻塞钩子）" if CONTROL else "修复后（脱敏 offload 到专职线程）"
        print("模式: %s" % mode)
        print("  A 慢脱敏请求耗时 : %.2fs（注入 %.1fs）%s" % (
            a_result.get("secs", -1), SLOW_MASK_S,
            a_result.get("error") or ("HTTP %s" % a_result.get("code"))))
        print("  B 只读请求耗时   : %.2fs（HTTP %s）" % (b_secs, b_code))

        ok = True
        if not CONTROL:
            if "error" in a_result or a_result.get("code") != 200:
                print("  FAIL: A 本身没成功"); ok = False
            elif b_secs >= SLOW_MASK_S * 0.5:
                print("  FAIL: B 被慢脱敏拖住了 —— 事件循环仍被占用"); ok = False
            else:
                print("  PASS: 慢脱敏期间其他连接照常服务（事件循环没被冻住）")
        else:
            if b_secs < SLOW_MASK_S * 0.5:
                print("  FAIL: 反例没复现出冻结，说明本脚本的判定不可信"); ok = False
            else:
                print("  PASS: 反例复现出冻结（说明上面的判定不是空转）")
        return 0 if ok else 1
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except Exception:
            proc.kill()
        srv.shutdown()


if __name__ == "__main__":
    sys.exit(main())
