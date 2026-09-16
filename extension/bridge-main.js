/* Data Maskit Browser Bridge — MAIN world hook 层
 *
 * 跑在**页面上下文**（world:"MAIN", run_at:"document_start"，实测先于页面脚本 hook 成功）。
 * 这里没有 chrome.* 特权，所有特权操作经 postMessage（带 nonce）转给 ISOLATED 层。
 *
 * ⚠️ MAIN world 的一切都视为**可被页面读取**：token 绝不经过这里，请求/响应原文也不外发，
 *    只把文本交给扩展侧打码/还原（打码只进不出）。
 */
(() => {
  'use strict';
  if (window.__MASKIT_BRIDGE__) return;
  window.__MASKIT_BRIDGE__ = true;

  const BRIDGE_TIMEOUT_MS = 3000;
  const MIN_MASKABLE_LEN = 80;      // 短 body（GET 语义的查询等）不值得过一次桥

  // ─── postMessage 桥（nonce 校验） ───
  const pending = new Map();
  const bridge = {
    call(action, payload) {
      return new Promise((resolve) => {
        const nonce = (crypto.randomUUID && crypto.randomUUID()) || String(Math.random()).slice(2);
        const timer = setTimeout(() => {
          pending.delete(nonce);
          resolve(null);                       // 超时按 (B) 直通处理
        }, BRIDGE_TIMEOUT_MS);
        pending.set(nonce, { resolve, timer });
        window.postMessage({ type: 'MASKIT_BRIDGE_REQ', nonce, action, payload }, location.origin);
      });
    },
    notify(action, payload) {
      window.postMessage({ type: 'MASKIT_BRIDGE_REQ', nonce: null, action, payload }, location.origin);
    },
  };
  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin) return;
    if (!e.data || e.data.type !== 'MASKIT_BRIDGE_RESP') return;
    const p = pending.get(e.data.nonce);
    if (p) {
      clearTimeout(p.timer);
      pending.delete(e.data.nonce);
      p.resolve(e.data.result);
    }
  });

  // ─── AI 请求路径白名单 ───
  // EMAIL / PHONE 内置规则默认开启，登录表单默认会被误伤（实测：{"email":"a@b.com"}
  // → {{EMAIL_xxxxxx}}），所以**路径白名单是默认行为下的必需品**，不是优化。
  const LLM_PATH_HINTS = [
    /\/api\/.*conversation/i, /\/backend-api\//i, /\/(v1\/)?(chat|completions|messages|responses)/i,
    // ── 下面四条是 2026-09-16 真机逐站验证补的 ──
    // 前三条的 `--` 分割的 RPC 形态（Gemini/Grok/Poe）与 `/rest/sse/`（Perplexity）
    // 一个关键词都不带，不补的话这四站**整站静默未脱敏**：页面完全正常，
    // 只是内容裸着发出去了——这是最难被发现的一类失败。
    /\/_\/BardChatUi\//i,   // Google Gemini（含 StreamGenerate / batchexecute）
    /\/app-chat\//i,        // Grok（xAI）：/rest/app-chat/conversations/…
    /\/rest\/sse\//i,       // Perplexity：/rest/sse/perplexity_ask
    /\/api\/gql/i,          // Poe：GraphQL 端点 /api/gql_POST
  ];
  const AUTH_PATH_BLOCKLIST = [
    /login|signin|sign-in|signup|register|auth|session|token|password|credential|oauth|sso/i,
  ];
  const isLLMRequest = (url) => {
    let path;
    try {
      path = new URL(url, location.href).pathname;
    } catch (e) {
      return false;
    }
    if (AUTH_PATH_BLOCKLIST.some((rx) => rx.test(path))) return false;
    return LLM_PATH_HINTS.some((rx) => rx.test(path));
  };

  // ─── 可打码 body 判定（成对原则的落地点） ───
  // Request 的 body 可能是 FormData / Blob / URLSearchParams / ReadableStream —— 把它
  // clone().text() 读成字符串再 new Request(old, {body: 字符串}) 回写，会保留原来的
  // `Content-Type: multipart/form-data; boundary=…` 却把实体换成纯文本，上游直接 400。
  // LLM 路径上的附件上传正是 multipart（走 /backend-api/），所以这条守卫是**必需**的。
  // 只按 content-type 前缀判定，不解析内容。
  const MASKABLE_CT = /^(application\/json|application\/(x-)?ndjson|application\/json-seq|text\/)/i;
  const isMaskableBody = (req) => MASKABLE_CT.test((req.headers.get('content-type') || '').trim());
  const initBodyIsText = (init) => !!init && typeof init.body === 'string';
  // 注：`init` 分支**故意不套用** isMaskableBody —— `init.body` 是字符串本身就证明是文本
  // （无需看 content-type），套上去反而会让「忘了带 content-type 的 JSON 字符串体」漏打码。
  // 两个分支守卫不同不是笔误。

  // ─── escape 上下文判定：SSE 默认 true，明确纯文本才 false ───
  // 依据：续帧（上一 chunk 的 JSON 未完）不以 `data: {` 开头，「遇 { 才翻 true」会漏掉
  // 续帧里替换的占位符。默认站的 SSE 都是 JSON，JSON-first 更稳。
  // 载荷首字符**只有明确是普通文本（以字母开头）才翻 false**：空帧 `data:`（很多站先发
  // 一个空 data 行）与一切非字母开头（含 `{` `[` `"` 数字 `-`）维持默认 true。
  // 裸字面量帧（null/true/false）会被判成纯文本，但那类帧里不含占位符，无影响。
  const firstDataLine = (chunk) =>
    chunk.split(/\r?\n/).find((l) => l.trim().startsWith('data:')) || '';
  const escapeForDataLine = (line) => {
    const payload = line.replace(/^\s*data:\s?/, '').trim();
    if (!payload) return true;                        // 空帧 → 维持默认（安全方向）
    return !/^[A-Za-z]/.test(payload);                // 字母开头=普通文本；否则当 JSON
  };
  /**
   * 只在 `content-type` 含 `text/event-stream` 时调用（见 wrapResponse 的
   * `!escapeDecided && ct.includes('text/event-stream')` 守卫）。
   *
   * 因此**不存在**"content-type 既不是 JSON 也不是 SSE"的分支——原先那个
   * `return false` 兜底永远不可达。留着一个不可达分支比删掉它更糟：后来人会把
   * 它当"未知类型的安全默认"，可 `escape` 的语义取决于**目标槽位是不是 JSON 字符串
   * 内部**（transparent.restore 的 escape 参数），根本不取决于 content-type。
   * 若将来真出现新的调用点（比如支持 `application/json-seq`），必须**重新推导**
   * escape 语义，而不是顺手复用这里的返回值。
   */
  const detectEscape = (ct, chunk) => {
    if (ct.includes('application/json')) return true;   // 防未来误用：JSON 恒需转义
    const line = firstDataLine(chunk);
    if (!line) return true;                            // 未出现 data 行 → 维持默认 true
    return escapeForDataLine(line);
  };

  const streamLike = (ct) =>
    ct.includes('text/event-stream') || ct.includes('application/json');

  // ─── fetch hook ───
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    let [resource, init] = args;
    let isReq = false;
    let url = '';
    let method = 'GET';
    try {
      isReq = resource instanceof Request;
      url = isReq ? resource.url : String(resource);
      method = (isReq ? resource.method : (init && init.method) || 'GET').toUpperCase();
    } catch (e) {
      return origFetch.apply(this, args);             // 任何解析意外：原样放行
    }
    if (method !== 'POST' || !isLLMRequest(url)) {
      // 白名单外：不打码不包装（成对原则）。同时记一条「未命中白名单的 POST」供反馈。
      if (method === 'POST') {
        try {
          const p = new URL(url, location.href).pathname;
          if (!AUTH_PATH_BLOCKLIST.some((rx) => rx.test(p))) {
            bridge.notify('note', { kind: 'unmatched_post', path: p });
          }
        } catch (e) { /* ignore */ }
      }
      return origFetch.apply(this, args);
    }

    let sid = null;
    if (isReq) {
      // 非文本 body 整体跳过（否则会把 multipart 写坏，见 isMaskableBody 说明）
      if (!isMaskableBody(resource)) return origFetch.apply(this, args);
      const raw = await resource.clone().text();
      if (raw.length > MIN_MASKABLE_LEN) {
        const r = await bridge.call('mask', { text: raw });
        if (r && r.ok) {
          sid = r.sid;
          // 显式带上 signal —— `new Request(old, {body})` **不会**继承旧 signal，
          // 页面 AbortController.abort() 后底层请求不再被取消（init 分支因 {...init}
          // 天然保留）。与「重构造丢内部标志」同族。
          resource = new Request(resource, { body: r.masked_text, signal: resource.signal });
        } else if (r && r.blocking) {
          throw new TypeError('Failed to fetch');      // (A) 无条件阻断
        }
        // r.passthrough / r === null（桥超时）→ 原样放行（(B)）
      }
      return sid
        ? wrapResponse(await origFetch.call(this, resource), sid)
        : origFetch.call(this, resource);
    }

    let reqInit = init;
    if (initBodyIsText(init) && init.body.length > MIN_MASKABLE_LEN) {
      const r = await bridge.call('mask', { text: init.body });
      if (r && r.ok) {
        sid = r.sid;
        reqInit = { ...init, body: r.masked_text };
      } else if (r && r.blocking) {
        throw new TypeError('Failed to fetch');        // (A)
      }
    }
    return sid
      ? wrapResponse(await origFetch.call(this, url, reqInit), sid)
      : origFetch.call(this, url, reqInit);
  };

  // ─── 响应包装（仅已打码请求；sid=null 不碰） ───
  const wrapResponse = (res, sid) => {
    // 204/205/304 等 null-body 状态，new Response(body, {status}) 会抛 TypeError →
    // fetch 整体 reject → 页面网络错误。这类状态直接原样返回。
    if ([204, 205, 304].includes(res.status)) return res;
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (!res.body || !streamLike(ct)) return res;

    const streamId = (crypto.randomUUID && crypto.randomUUID()) || String(Math.random()).slice(2);
    const dec = new TextDecoder();
    const enc = new TextEncoder();
    let escape = ct.includes('application/json');      // SSE 待首个 data 行判定（默认 true）
    let escapeDecided = escape;

    const transformed = res.body.pipeThrough(new TransformStream({
      async transform(chunk, ctrl) {
        const text = dec.decode(chunk, { stream: true });
        if (!escapeDecided && ct.includes('text/event-stream')) {
          if (firstDataLine(text)) {
            escape = detectEscape(ct, text);
            escapeDecided = true;
          }
          // 没出现 data: 行前保持 true（默认站全是 JSON；纯文本流会在首个 data 行翻 false）
        }
        const r = await bridge.call('restore', {
          sid, stream_id: streamId, text, final: false, escape,
        });
        ctrl.enqueue(enc.encode(r && r.ok ? r.text : text));   // 还原失败恒透传
      },
      async flush(ctrl) {
        const tail = dec.decode();
        const r = await bridge.call('restore', {
          sid, stream_id: streamId, text: tail, final: true, escape,
        });
        const out = r && r.ok ? r.text : tail;
        if (tail || out) ctrl.enqueue(enc.encode(out || ''));
      },
    }));

    // 还原后长度已变，原始 content-length 是错的；content-encoding（gzip/br）也不适用
    // 于已解码的流。两者都删，交给浏览器按 chunked 处理。
    const headers = new Headers(res.headers);
    headers.delete('content-length');
    headers.delete('content-encoding');
    let wrapped;
    try {
      wrapped = new Response(transformed, {
        status: res.status, statusText: res.statusText, headers,
      });
    } catch (e) {
      return res;                                      // 构造失败宁可原样返回，不阻断页面
    }
    // new Response() 会丢内部标志：url / type（变 "default"）/ redirected（变 false）。
    // 页面若依赖它们（如 res.redirected 判定登录跳转）会静默走错分支，按需补回。
    const restore = (prop, value) => {
      try {
        Object.defineProperty(wrapped, prop, { value, configurable: true });
      } catch (e) { /* ignore */ }
    };
    restore('url', res.url);
    restore('type', res.type);
    restore('redirected', res.redirected);
    return wrapped;
  };

  // XHR hook：v1 不做（v1.1 完整范围项）。v1 阶段 XHR 请求整体透传（成对原则）。
})();
