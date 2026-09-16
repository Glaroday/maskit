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

  // ─── 拦截策略：广泛模式（默认，零适配）/ 窄模式（只认对话接口） ───
  //
  // 【为什么从白名单改成黑名单】原方案要求路径命中 LLM_PATH_HINTS 才打码，于是每加一个
  // 新站点都要先猜接口路径——猜错就**整站静默未脱敏**（页面毫无异常，内容裸着发出去）。
  // 2026-09-16 实测 18 站，有 4 个海外站就是这样漏掉的（Gemini/Grok/Perplexity/Poe 的
  // 路径一个关键词都不带）。逐个补路径是打地鼠：站点改版一次就失效一次。
  //
  // 广泛模式的判定是三层：
  //   ① 认证/埋点/噪声路径 → 永不打码（黑名单）
  //   ② 命中对话接口形态   → 一定打码（**跨域也算**，兜住 API 在独立域的站点）
  //   ③ 其余同站 POST      → 也送引擎（广泛模式独有；引擎没匹配到敏感信息就原样返回）
  //
  // 同站限定是关键：埋点几乎全是跨域（clarity.ms / sentry.io / volces.com / 百度统计…），
  // 一条「不同站就不碰」就能滤掉绝大部分噪声，而 AI 站点的对话请求基本都在本站或子域。
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

  /**
   * 永不打码的路径黑名单。
   *
   * ① 认证类：EMAIL/PHONE 是**默认开启**的内置规则，登录表单里 `{"email":"a@b.com"}`
   *    会被打成 `{{EMAIL_xxxxxx}}`（实测），一旦打码就登录不上——这是硬失败，必须排除。
   * ② 埋点/遥测类：不是内容，送引擎纯属浪费，且占位符混进埋点会造成数据污染。
   * ③ 只读类（history/list/detail）：不带用户新输入，没有打码价值。
   *
   * 黑名单命中就**直接放行**，不再走引擎——宁可少打一次码，也不能让登录表单坏掉。
   */
  const NEVER_MASK_PATH = [
    // 认证 / 凭据
    /(login|signin|sign-?in|signup|sign-?up|register|logout|auth|oauth|sso|session|token|password|credential|passwd|captcha|verify|verification|sms|otp|2fa|mfa)/i,
    // 埋点 / 遥测 / 监控
    /(\/|_|-|\.)(log|logs|logging|logger|beacon|telemetry|track|tracking|tracker|analytics|metric|metrics|monitor|monitoring|report|reports|collect|collector|event|events|stats|stat|perf|performance|apm|rum|sentry|clarity|error|errors|exception|crash|heartbeat|health|healthcheck|alive|ping|feedback|survey|abtest|ab-?test|experiment)($|\/|_|-|\.|\?|\d)/i,
    // 配置 / 静态字典（不含用户输入）
    /(\/|_|-|\.)(config|configs|settings|preference|preferences|i18n|locale|lang|dict|theme|version|update|upgrade|announce|notice|notification|invite|referral|share|balance|quota|billing|payment|order)($|\/|_|-|\.|\?|\d)/i,
  ];

  /** 同站判定：完全同 host，或互为子域（api.doubao.com ↔ www.doubao.com）。 */
  const isSameSite = (host) => {
    const h = String(host || '').toLowerCase();
    const p = location.hostname.toLowerCase();
    if (!h || !p) return false;
    if (h === p) return true;
    return h.endsWith('.' + p) || p.endsWith('.' + h);
  };

  /**
   * 是否该对这次请求打码。
   * 先判白名单（命中直接打码，防止 events/settings 误杀真实对话接口）；
   * 再判黑名单（排除认证/埋点/配置等非对话管理接口）；
   * 兜底：广泛模式下同站其余 POST 送引擎，默认精准模式下直接放行。
   */
  const shouldMaskUrl = (url, wide) => {
    let u, path;
    try {
      u = new URL(url, location.href);
      path = u.pathname;
    } catch (e) {
      return false;
    }
    if (LLM_PATH_HINTS.some((rx) => rx.test(path))) return true;   // 对话接口优先打码（跨域也算）
    if (NEVER_MASK_PATH.some((rx) => rx.test(path))) return false; // 认证/埋点/管理排除
    return !!wide && isSameSite(u.hostname);
  };

  // 广泛模式开关由 SW 下发（chrome.storage 在 MAIN world 不可用）。默认 false（精准对话模式）。
  // 且**只问一次**并缓存——每个请求都问一次 storage 不划算，而这个值改了刷新页面就生效。
  let wideModePromise = null;
  const getWideMode = () => {
    if (!wideModePromise) {
      wideModePromise = bridge.call('config', {}).then((r) => {
        const w = r && typeof r.wideMode === 'boolean' ? r.wideMode : false;
        return { wideMode: w };
      }).catch(() => ({ wideMode: false }));
    }
    return wideModePromise;
  };

  // ─── 可打码 body 判定（成对原则的落地点） ───
  // Request 的 body 可能是 FormData / Blob / URLSearchParams / ReadableStream —— 把它
  // clone().text() 读成字符串再 new Request(old, {body: 字符串}) 回写，会保留原来的
  // `Content-Type: multipart/form-data; boundary=…` 却把实体换成纯文本，上游直接 400。
  // 所以文本分支只吃文本类 content-type；multipart 走**独立的 FormData 分支**（见
  // maskMultipart），不再像 v1 那样整体跳过——跳过的代价是「带附件的请求完全不脱敏」。
  const MASKABLE_CT = /^(application\/json|application\/(x-)?ndjson|application\/json-seq|application\/x-www-form-urlencoded|text\/)/i;
  const MULTIPART_CT = /^multipart\/form-data/i;
  const isMaskableBody = (req) => MASKABLE_CT.test((req.headers.get('content-type') || '').trim());
  const isMultipart = (req) => MULTIPART_CT.test((req.headers.get('content-type') || '').trim());
  const initBodyIsText = (init) => !!init && typeof init.body === 'string';
  const initBodyIsURLSearchParams = (init) =>
    !!init && typeof URLSearchParams !== 'undefined' && init.body instanceof URLSearchParams;
  const initBodyIsFormData = (init) =>
    !!init && typeof FormData !== 'undefined' && init.body instanceof FormData;

  /**
   * multipart 打码：文本字段打码，**文件字段原样透传**。
   *
   * 为什么可以这么做：`Request.formData()` 会把 multipart 解析成 [name, string|File] 条目，
   * 我们用打码后的字符串 + 原 File 重新拼一个 FormData，再交给 fetch 自动生成**新的**
   * boundary —— 不存在手写 boundary 写坏的问题。
   *
   * 为什么必须显式删掉 `content-type`：见 `new Request(resource, {body})` 那处注释。
   * 旧头里是**旧 boundary**，留着等于告诉上游按一条已经不存在的分隔线去切分实体 → 400。
   *
   * 文件（含图片）里的内容**不脱敏**：要处理图片里的文字得引入 OCR，单张几百毫秒到几秒，
   * 会把它从轻量工具变成重工具。不静默放行——检测到文件就发一条 note，由 popup 明说。
   *
   * 所有字符串字段**一次拼好统一打码**，再按同一分隔符拆回：分字段各打一次会让同一
   * 个手机号在不同字段里拿到不同占位符，且请求数翻倍。
   */
  const FIELD_SEP = '\u0001';
  async function maskMultipart(fd) {
    const entries = [...fd.entries()];
    const texts = [];
    let hasFile = false, hasImage = false;
    let fileCount = 0;
    for (const [, v] of entries) {
      if (typeof v === 'string') texts.push(v);
      else {
        hasFile = true;
        fileCount++;
        if (v && typeof v.type === 'string' && v.type.startsWith('image/')) hasImage = true;
      }
    }
    if (!texts.length) {
      if (hasFile) bridge.notify('note', { kind: 'attachment', image: hasImage, count: fileCount });
      return null;                                  // 纯文件：没有文本可打码
    }
    const joined = texts.join(FIELD_SEP);
    if (!joined) return null;
    const r = await bridge.call('mask', { text: joined });
    if (r && r.blocking) return { blocking: true };  // (A) 无条件阻断，交给调用方抛
    if (!r || !r.ok) return null;
    const parts = String(r.masked_text || '').split(FIELD_SEP);
    if (parts.length !== texts.length) return null;  // 条目数对不上说明有意外，宁可放行
    const out = new FormData();
    let i = 0;
    for (const [k, v] of entries) {
      if (typeof v === 'string') out.append(k, parts[i++]);
      else out.append(k, v, v && v.name);
    }
    if (hasFile) bridge.notify('note', { kind: 'attachment', image: hasImage, count: fileCount });
    return { body: out, sid: r.sid };
  }

  // ─── escape 由引擎按槽位判定 ───
  // 这里原先有一段「读首个 data: 行的首字符，猜整条流要不要 JSON 转义」的启发式。
  // 它已删除，原因有两条：
  //   1. **粒度错了**。escape 的语义是「这个值是不是要放进 JSON 字符串里」，
  //      而同一条流里 `choices[].delta.content`（正文，不转义）与
  //      `tool_calls[].function.arguments`（JSON 文本，必须转义）是**并存**的，
  //      整条流只能猜出一个值，必然有一个是错的。
  //   2. **它永远猜不准 SSE**。首帧往往只是 `data: {"choices":[...`，末尾的续帧
  //      不以 `data:` 开头，靠首帧推出来的值要一路用到流结束。
  // 现在由引擎 `_sse_text_slots()` 逐槽位给出 escape（与代理链路同一份实现）。
  // 扩展只需要告诉引擎 content-type —— 分帧方式（SSE 空行 / NDJSON 换行 / 整体）
  // 也由引擎判定，避免同一套规则在两边各写一遍然后悄悄漂移。

  const streamLike = (ct) =>
    ct.includes('text/event-stream') || ct.includes('application/json') || ct.includes('ndjson') || ct.includes('json-seq');

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
    // 只有带 body 的写方法值得过桥；GET 语义的查询串不处理（历史上 MIN_MASKABLE_LEN
    // 就是为滤掉这类短请求，现在进一步按方法先过滤，省掉绝大部分无谓判定）。
    if (method !== 'POST' && method !== 'PUT' && method !== 'PATCH') {
      return origFetch.apply(this, args);
    }

    const cfg = await getWideMode();
    if (!shouldMaskUrl(url, cfg.wideMode)) {
      // 不打码不包装（成对原则）。窄模式下记一条「未命中对话接口的 POST」供反馈——
      // 广泛模式不记：它本就把同站 POST 全收了，记下来的全是跨域埋点，纯噪音。
      if (!cfg.wideMode) {
        try {
          const p = new URL(url, location.href).pathname;
          if (!NEVER_MASK_PATH.some((rx) => rx.test(p))) {
            bridge.notify('note', { kind: 'unmatched_post', path: p });
          }
        } catch (e) { /* ignore */ }
      }
      return origFetch.apply(this, args);
    }
    const minLen = MIN_MASKABLE_LEN;

    let sid = null;
    if (isReq) {
      // ── multipart：文本字段打码，文件原样 ──
      if (isMultipart(resource)) {
        const fd = await resource.clone().formData().catch(() => null);
        if (fd) {
          const m = await maskMultipart(fd);
          if (m && m.blocking) throw new TypeError('Failed to fetch');   // (A)
          if (m) {
            // 必须删掉 content-type：旧值是**旧 boundary**，留着上游按不存在的分隔线
            // 切分实体 → 400。新 FormData 由 fetch 自动补正确的 boundary。
            const h = new Headers(resource.headers);
            h.delete('content-type');
            resource = new Request(resource, { body: m.body, headers: h, signal: resource.signal });
            return wrapResponse(await origFetch.call(this, resource), m.sid);
          }
        }
        return origFetch.apply(this, args);
      }
      // 其它非文本 body（Blob / ReadableStream / ArrayBuffer）：读成字符串再回写会破坏
      // 原有语义，一律原样放行。
      if (!isMaskableBody(resource)) return origFetch.apply(this, args);
      const raw = await resource.clone().text();
      if (raw.length > minLen) {
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
    const isUrlParams = initBodyIsURLSearchParams(init);
    if (initBodyIsFormData(init)) {
      const m = await maskMultipart(init.body);
      if (m && m.blocking) throw new TypeError('Failed to fetch');       // (A)
      if (m) {
        const h = new Headers((init && init.headers) || {});
        h.delete('content-type');
        reqInit = { ...init, body: m.body, headers: h };
        return wrapResponse(await origFetch.call(this, url, reqInit), m.sid);
      }
    } else if ((initBodyIsText(init) || isUrlParams) && (isUrlParams ? init.body.toString().length : init.body.length) > minLen) {
      const textToMask = isUrlParams ? init.body.toString() : init.body;
      const r = await bridge.call('mask', { text: textToMask });
      if (r && r.ok) {
        sid = r.sid;
        reqInit = { ...init, body: isUrlParams ? new URLSearchParams(r.masked_text) : r.masked_text };
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

    const transformed = res.body.pipeThrough(new TransformStream({
      async transform(chunk, ctrl) {
        // chunk 边界与 SSE 事件边界**无关**：一个 chunk 可能只有半个事件，也可能含
        // 三个事件加半个。分帧必须是引擎的事（`restore_stream_chunk` 按 stream_id
        // 持有半帧缓冲），这里只做字节→文本解码，**绝不自己切帧**。
        //
        // 这一层曾经把整段 SSE 原文直接送去还原，于是被事件边界切开的占位符
        // （`content:"{{EMAIL"` + `content:"_dsszcd}}"`）永远拼不回来，页面上留下
        // 裸 `{{EMAIL_dsszcd}}`。真机往返才暴露——mock 的 SSE 恰好把完整占位符
        // 放在单个事件里，绕过了这个缺陷。
        const text = dec.decode(chunk, { stream: true });
        const r = await bridge.call('restore', {
          sid, stream_id: streamId, text, final: false, content_type: ct,
        });
        ctrl.enqueue(enc.encode(r && r.ok ? r.text : text));   // 还原失败恒透传
      },
      async flush(ctrl) {
        const tail = dec.decode();
        const r = await bridge.call('restore', {
          sid, stream_id: streamId, text: tail, final: true, content_type: ct,
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
