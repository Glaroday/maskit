"""扩展链路的流式还原必须按「帧」切分，而不是把整段 SSE 原文当文本处理。

回归的缺陷（2026-09-16 真机往返实测定位）：

模型逐 token 输出时，占位符会被 SSE **事件边界**切开——

    event A  content = "{{EMAIL"
    event B  content = "_dsszcd}}"

扩展链路原先把整段 SSE 原文（含 `data: {...}` 外壳）直接交给
`transparent.restore()`。`restore()` 看到的缓冲区结尾是 `"}}]}\\n\\n` 而不是半截
占位符，于是「半截正好落在缓冲区结尾」的判据（`_PARTIAL_RX`）永不成立，两半各自
原样下发 → 页面上留下裸 `{{EMAIL_dsszcd}}`。

引擎侧的表现是 RESTORE 事件 `restored=0 unresolved=0`（`{{{` 从没进过替换阶段），
所以「未还原数」这个诊断也帮不上忙——这是当时最难判的一点。

**为什么此前测试全绿**：mock 的 SSE 把完整占位符放在单个事件里，恰好绕过了这个
缺陷。所以这里的用例必须显式构造「跨事件」与「跨 TCP chunk」两种切分。
"""
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "engine"))
import transparent as tr

TOKEN = "{{EMAIL_dsszcd}}"
ORIG = "zhangsan@example.com"
CT = "text/event-stream"
STREAM = "s1"


def evt(text):
    """构造一个 OpenAI 形态的增量事件（含结尾空行，即一个完整帧）。"""
    payload = {"choices": [{"delta": {"content": text}}]}
    return "data: " + json.dumps(payload, ensure_ascii=False) + "\n\n"


class ExtStreamFramingTests(unittest.TestCase):
    def setUp(self):
        for name in ("sessions", "_RECENT_FWD", "_RECENT_REV"):
            patcher = mock.patch.object(tr, name, {})
            patcher.start()
            self.addCleanup(patcher.stop)
        self.sid = "ext:framing-test"
        tr._new_session(self.sid)
        tr.sessions[self.sid]["rev"][TOKEN] = ORIG

    def feed(self, chunks, content_type=CT):
        """模拟扩展侧逐 chunk 调用，最后一块带 final=True。"""
        out = []
        for i, chunk in enumerate(chunks):
            out.append(tr.restore_stream_chunk(
                chunk, self.sid, STREAM,
                content_type=content_type, final=(i == len(chunks) - 1)))
        return "".join(out)

    @staticmethod
    def contents(text):
        """把还原后的流文本里所有增量 content 拼起来，即客户端最终看到的正文。"""
        vals = []
        for line in text.splitlines():
            if line.startswith("data: ") and line.strip() != "data: [DONE]":
                data = json.loads(line[6:])
                for choice in data.get("choices", []) or []:
                    delta = choice.get("delta") or {}
                    vals.append(delta.get("content") or "")
        return "".join(vals)

    def test_placeholder_split_across_two_events(self):
        """占位符被切成两个独立事件——真机往返实测到的形态。"""
        got = self.contents(self.feed([evt("{{EMAIL"), evt("_dsszcd}}")]))
        self.assertEqual(got, ORIG)
        self.assertNotIn("{{", got)

    def test_single_event_split_across_two_chunks(self):
        """整个事件被 chunk 边界切成两半：半帧必须留在缓冲里等后续数据。"""
        whole = evt(TOKEN)
        cut = len(whole) // 2
        got = self.contents(self.feed([whole[:cut], whole[cut:]]))
        self.assertEqual(got, ORIG)

    def test_split_placeholder_and_split_chunks_combined(self):
        """两种切分同时发生，且 chunk 边界按固定字节硬切（模拟真实 TCP 分片）。"""
        raw = evt("{") + evt('"phone":"') + evt("{{EMAIL") + evt("_dsszcd}}") + evt('"}')
        chunks = [raw[i:i + 7] for i in range(0, len(raw), 7)]
        got = self.contents(self.feed(chunks))
        self.assertIn('"phone":"' + ORIG + '"', got)
        self.assertNotIn("{{", got)

    def test_restore_counted_once_without_unresolved(self):
        """整串还原记 1 次；半截那一步绝不能记成「未还原」（否则诊断误导）。"""
        self.feed([evt("{{EMAIL"), evt("_dsszcd}}")])
        s = tr.sessions[self.sid]
        self.assertEqual(s.get("restored"), 1)
        self.assertEqual(s.get("unresolved", 0), 0)

    def test_frame_buffer_released_after_final(self):
        """流结束必须释放帧缓冲，否则长会话里 stream_id 会不断堆积。"""
        self.feed([evt("{{EMAIL")])
        self.assertFalse(tr.sessions[self.sid].get("ext_frames"))

    def test_crlf_framing(self):
        """CRLF 上游：不统一换行符就会攒到流结束才处理（表现为卡住不吐字）。"""
        chunks = ["data: " + json.dumps({"choices": [{"delta": {"content": "{{EMAIL"}}]}) + "\r\n\r\n",
                  "data: " + json.dumps({"choices": [{"delta": {"content": "_dsszcd}}"}}]}) + "\r\n\r\n"]
        got = self.contents(self.feed(chunks))
        self.assertEqual(got, ORIG)

    def test_non_stream_json_body_still_restores(self):
        """非流式整体路径不能被分帧改动带坏。"""
        body = json.dumps({"phone": TOKEN}, ensure_ascii=False)
        got = tr.restore_stream_chunk(body, self.sid, STREAM,
                                      content_type="application/json", final=True)
        self.assertIn(ORIG, got)
        self.assertNotIn("{{", got)

    def test_non_stream_json_split_across_chunks_restores(self):
        """非流式 JSON 被 TCP 分片（多个 chunk，最后 final=True）：占位符跨 chunk 仍能拼回。"""
        body = json.dumps({"phone": TOKEN}, ensure_ascii=False)
        cut = body.find(TOKEN[:6]) + 6
        c1, c2 = body[:cut], body[cut:]
        out1 = tr.restore_stream_chunk(c1, self.sid, STREAM,
                                       content_type="application/json", final=False)
        out2 = tr.restore_stream_chunk(c2, self.sid, STREAM,
                                       content_type="application/json", final=True)
        got = out1 + out2
        self.assertIn(ORIG, got)
        self.assertNotIn("{{", got)

    def test_unknown_session_returns_text_unchanged(self):
        """会话缺失时恒透传（红线 3），不能抛异常。"""
        raw = evt(TOKEN)
        self.assertEqual(
            tr.restore_stream_chunk(raw, "ext:does-not-exist", STREAM, content_type=CT),
            raw)

    def test_doubao_custom_envelope_split_across_events(self):
        """豆包式自定义信封：负载含 content: "{\"text\":\"...\"}"，跨事件切半占位符能够拼回。"""
        def evt_db(text):
            payload = json.dumps({"message_id": "m1", "type": "chunk",
                                  "content": json.dumps({"text": text}, ensure_ascii=False)},
                                 ensure_ascii=False)
            return "id: 0\nevent: CHUNK\ndata: " + payload + "\n\n"

        chunks = [evt_db(TOKEN[:6]), evt_db(TOKEN[6:])]
        res = self.feed(chunks)
        # 从输出提取 content 里的 text
        texts = []
        for line in res.splitlines():
            if line.startswith("data: "):
                d = json.loads(line[6:])
                inner = json.loads(d.get("content", "{}"))
                texts.append(inner.get("text", ""))
        got = "".join(texts)
        self.assertEqual(got, ORIG)
        self.assertNotIn("{{", got)

    def test_doubao_custom_envelope_truncated_flush_preserves_sse_framing(self):
        """豆包信封中途在半个占位符处异常中断：收尾补发必须生成合法的 data: 帧，不得退化为裸文本。"""
        def evt_db(text):
            payload = json.dumps({"message_id": "m1", "type": "chunk",
                                  "content": json.dumps({"text": text}, ensure_ascii=False)},
                                 ensure_ascii=False)
            return "id: 0\nevent: CHUNK\ndata: " + payload + "\n\n"

        # chunk 1 发送半个占位符；流结束 final=True
        res = self.feed([evt_db("前缀 " + TOKEN[:6])])
        # 验证所有输出行（除去空行）都必须是合法的 SSE 行（以 data:、id:、event: 开头），绝不能出现裸占位符文本行
        non_empty = [ln for ln in res.splitlines() if ln.strip()]
        for ln in non_empty:
            self.assertTrue(
                ln.startswith(("data:", "id:", "event:")),
                f"输出退化为非 SSE 裸文本行: {ln!r}")


if __name__ == "__main__":
    unittest.main()
