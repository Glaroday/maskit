"""PT（透传兜底层）真实转发 socket 编排测试。

此前只有属性级锚点（timeout/Nagle/do_HEAD 可调用），转发行为无 socket 级用例。
本文件起真实 `_PassthroughHTTPServer` + 本地 dummy 上游，验证：
- GET/POST/HEAD 全方法转发与响应回传；
- 同名多值请求头合并转发（不丢值）；
- 请求侧 accept-encoding 透传（不再强制非压缩）；
- 出口代理 CONNECT 隧道路径（含 https 代理的手工 TLS 编排在 mock 层验证）。
"""
import http.server
import json
import threading
import unittest
from contextlib import closing
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
import sys
sys.path.insert(0, str(ROOT / "engine"))

import panel


class _DummyUpstream(http.server.BaseHTTPRequestHandler):
    """本地假上游：回显请求方法/头/body，供 PT 转发断言。"""

    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _echo(self):
        if self.path.startswith("/gz"):
            # gzip 端点：验证 PT 解压链路（还原为空映射时也应正确转发明文）
            import gzip as _gzip
            payload = _gzip.compress(b'{"ok": true, "data": "gzip-response"}')
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Encoding", "gzip")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(payload)
            return
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        payload = json.dumps({
            "method": self.command,
            "path": self.path,
            "x_multi": self.headers.get("X-Multi", ""),
            "accept_encoding": self.headers.get("Accept-Encoding", ""),
            "ua_present": bool(self.headers.get("User-Agent")),
            "body": body.decode("utf-8", "replace"),
        }).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(payload)

    do_GET = _echo
    do_POST = _echo
    do_HEAD = _echo


def _start_server(handler_cls, host="127.0.0.1", port=0):
    srv = http.server.ThreadingHTTPServer((host, port), handler_cls)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    return srv, t


def _http_request(port, method, path, headers=None, body=b""):
    """裸 socket HTTP 请求：绕开 http.client 的自动头处理，精确断言收到的字节。"""
    import socket
    with closing(socket.create_connection(("127.0.0.1", port), timeout=10)) as s:
        req = f"{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n"
        for k, v in (headers or {}).items():
            req += f"{k}: {v}\r\n"
        if body:
            req += f"Content-Length: {len(body)}\r\n"
        req += "Connection: close\r\n\r\n"
        s.sendall(req.encode() + body)
        chunks = []
        while True:
            data = s.recv(65536)
            if not data:
                break
            chunks.append(data)
    return b"".join(chunks)


class PassthroughForwardTests(unittest.TestCase):
    """真实 socket 转发行为：PT 端口 → dummy 上游 → 客户端。"""

    @classmethod
    def setUpClass(cls):
        cls.upstream, _ = _start_server(_DummyUpstream)
        cls.upstream_port = cls.upstream.server_address[1]
        # 无代理直连形态：PT handler 指向 dummy 上游
        cls.ptsrv, _ = _start_server(
            panel._make_passthrough_handler(f"http://127.0.0.1:{cls.upstream_port}"))
        cls.pt_port = cls.ptsrv.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.ptsrv.shutdown()
        cls.upstream.shutdown()
        cls.ptsrv.server_close()
        cls.upstream.server_close()

    def test_get_forwards_and_echoes(self):
        raw = _http_request(self.pt_port, "GET", "/v1/models?api-version=1")
        self.assertIn(b"200", raw.split(b"\r\n", 1)[0])
        body = raw.split(b"\r\n\r\n", 1)[1]
        echoed = json.loads(body)
        self.assertEqual(echoed["method"], "GET")
        self.assertEqual(echoed["path"], "/v1/models?api-version=1")
        self.assertTrue(echoed["ua_present"], "UA 必须保留（Cloudflare 按 UA 拦截）")

    def test_post_body_forwarded_intact(self):
        body = json.dumps({"model": "test", "messages": []}).encode()
        raw = _http_request(self.pt_port, "POST", "/v1/chat/completions",
                            {"Content-Type": "application/json"}, body)
        echoed = json.loads(raw.split(b"\r\n\r\n", 1)[1])
        self.assertEqual(echoed["method"], "POST")
        self.assertEqual(json.loads(echoed["body"]), json.loads(body))

    def test_head_returns_headers_without_body(self):
        raw = _http_request(self.pt_port, "HEAD", "/v1/models")
        head, _, rest = raw.partition(b"\r\n\r\n")
        self.assertIn(b"200", head.split(b"\r\n", 1)[0])
        self.assertEqual(rest, b"", "HEAD 不得带 body")

    def test_duplicate_headers_joined_not_dropped(self):
        # 裸 socket 发两个同名 X-Multi 头：PT 必须合并转发（此前 dict 覆盖只留最后一个）
        import socket
        with closing(socket.create_connection(("127.0.0.1", self.pt_port), timeout=10)) as s:
            req = (b"GET /v1/models HTTP/1.1\r\n"
                   + f"Host: 127.0.0.1:{self.pt_port}\r\n".encode()
                   + b"X-Multi: aaa\r\nX-Multi: bbb\r\nConnection: close\r\n\r\n")
            s.sendall(req)
            chunks = []
            while True:
                data = s.recv(65536)
                if not data:
                    break
                chunks.append(data)
        echoed = json.loads(b"".join(chunks).split(b"\r\n\r\n", 1)[1])
        self.assertEqual(echoed["x_multi"], "aaa, bbb",
                         "同名多值头必须合并（与 mitmproxy 模式行为一致）")

    def test_accept_encoding_forwarded(self):
        raw = _http_request(self.pt_port, "GET", "/v1/models",
                            {"Accept-Encoding": "gzip, deflate"})
        echoed = json.loads(raw.split(b"\r\n\r\n", 1)[1])
        self.assertEqual(echoed["accept_encoding"], "gzip, deflate",
                         "accept-encoding 必须原样透传（不再强制全站非压缩）")

    def test_gzip_passthrough_when_no_restore_map(self):
        """还原映射为空（透传期无占位符）时：gzip 响应原样透传——Content-Encoding
        与 Content-Length 保留（客户端自己解压，keep-alive 不被打断）。解压只在
        还原激活时才有意义，纯解压透传白白破坏连接复用（复审 #8）。"""
        import gzip as _gzip
        raw = _http_request(self.pt_port, "GET", "/gz",
                            {"Accept-Encoding": "gzip"})
        head, _, body = raw.partition(b"\r\n\r\n")
        self.assertIn(b"content-encoding: gzip", head.lower(),
                      "无还原期望时不得剥 Content-Encoding")
        # 客户端侧解压验证透传字节完整
        self.assertEqual(json.loads(_gzip.decompress(body)),
                         {"ok": True, "data": "gzip-response"})


class ConnectViaProxyTests(unittest.TestCase):
    """出口代理 CONNECT 建链：http 代理按目标协议选连接类，https 代理手工 TLS 编排。"""

    def test_http_proxy_https_target_uses_https_connection(self):
        """http 代理 + https 目标必须 HTTPSConnection+set_tunnel：隧道内对目标
        做 TLS 握手。HTTPConnection 的隧道是明文，https 上游全部请求失败
        （复审 #1 回归锚点）。"""
        conn = panel._pt_connect_via_proxy("proxy.example", 8080, False,
                                           "api.example.com", 443, 30, True)
        self.assertIsInstance(conn, panel.http.client.HTTPSConnection)
        self.assertEqual(conn._tunnel_host, "api.example.com")

    def test_http_proxy_http_target_uses_plain_connection(self):
        conn = panel._pt_connect_via_proxy("proxy.example", 8080, False,
                                           "example.com", 80, 30, False)
        self.assertIsInstance(conn, panel.http.client.HTTPConnection)
        self.assertEqual(conn._tunnel_host, "example.com")

    def test_https_proxy_manual_tls_rejected_connect(self):
        """https 代理 CONNECT 被拒（非 2xx）必须抛 OSError 而非返回坏连接。

        用本地 TLS 服务模拟「先 TLS 握手再等 CONNECT」的代理：mock ssl 层
        免真实证书，socket 层真实读写。
        """
        server_hello = b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n"
        state = {"pos": 0}

        def fake_recv(n):
            # 模拟 sock.recv：按位置切片，耗尽返回 b""（Mock 默认返回 Mock 会炸拼接）
            out = server_hello[state["pos"]:state["pos"] + n]
            state["pos"] += n
            return out

        fake_sock = mock.Mock(recv=fake_recv, close=lambda: None)
        fake_ctx_instance = mock.Mock()
        fake_ctx_instance.wrap_socket = lambda raw, server_hostname=None: fake_sock
        # SSLContext 是类：调用返回实例。Mock 调用返回的是自动 Mock，
        # 必须显式设 return_value，否则 wrap_socket 落到自动 Mock 上
        fake_ctx = mock.Mock(return_value=fake_ctx_instance)
        with mock.patch("ssl.SSLContext", fake_ctx), \
             mock.patch("socket.create_connection") as create:
            create.return_value = mock.Mock()
            with self.assertRaises(OSError) as ctx:
                panel._pt_connect_via_proxy("proxy.example", 8443, True,
                                            "api.example.com", 443, 30, True)
            self.assertIn("403", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
