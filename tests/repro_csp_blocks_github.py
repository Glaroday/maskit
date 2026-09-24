"""实测：面板 CSP 是否拦掉浏览器对 api.github.com 的直连。

这是本次 NetworkError 的根因验证，不是推测——
用真实浏览器加载真实面板页面（含真实 CSP 响应头），
在页面上下文里发一条到 api.github.com 的 fetch，看它是被 CSP 拦掉还是真的出网。

判定：
  - 旧 CSP `connect-src 'self'`  → fetch 抛 TypeError，且控制台有 CSP 拦截日志；
  - 新 CSP（放行 api.github.com）→ fetch 能拿到 HTTP 状态（403 也算通，说明出网了）。
"""
import json
import socket
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "engine"))

OLD_CSP = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
           "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'")
NEW_CSP = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
           "img-src 'self' data:; connect-src 'self' https://api.github.com; frame-ancestors 'none'")

PROBE_JS = """
async () => {
  try {
    const r = await fetch('https://api.github.com/repos/xiaYuTian11/maskit/releases/latest',
                          { headers: { Accept: 'application/vnd.github.v3+json' } });
    return { ok: true, status: r.status };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
"""


def _free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _serve(csp, port, log):
    index = (ROOT / "frontend" / "dist" / "index.html").read_text(encoding="utf-8")

    class H(BaseHTTPRequestHandler):
        def do_GET(self):
            body = index.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Security-Policy", csp)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):
            pass

    srv = ThreadingHTTPServer(("127.0.0.1", port), H)
    log.append(srv)
    threading.Thread(target=srv.serve_forever, daemon=True).start()


def probe(csp, label):
    port = _free_port()
    holder = []
    _serve(csp, port, holder)
    time.sleep(0.3)
    csp_events = []
    try:
        with sync_playwright() as p:
            b = p.chromium.launch()
            pg = b.new_page()
            pg.on("console", lambda m: csp_events.append(m.text)
                  if "Content Security Policy" in m.text or "CSP" in m.text else None)
            pg.goto(f"http://127.0.0.1:{port}/", wait_until="domcontentloaded")
            res = pg.evaluate(PROBE_JS)
            b.close()
    finally:
        holder[0].shutdown()

    print(f"\n=== {label} ===")
    print("CSP:", csp)
    print("fetch 结果:", json.dumps(res, ensure_ascii=False))
    for e in csp_events:
        print("控制台:", e[:160])
    return res


if __name__ == "__main__":
    old = probe(OLD_CSP, "旧 CSP：connect-src 'self'（修复前）")
    new = probe(NEW_CSP, "新 CSP：放行 api.github.com（修复后）")
    print("\n" + "=" * 60)
    print(f"修复前：{'被 CSP 拦截' if not old.get('ok') else '出网成功'}")
    print(f"修复后：{'出网成功 (HTTP %s)' % new.get('status') if new.get('ok') else '仍失败'}")
