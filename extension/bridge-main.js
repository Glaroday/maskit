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
  // 文本 body 的**下限**：短于它连一次桥都不值得走（审计 M4）。
  //
  // 原值是 80，理由是「滤掉 GET 语义的查询串」。但那个理由早已不成立——
  // 上面的 fetch hook 现在**先按方法过滤**（只放行 POST/PUT/PATCH），GET 查询串根本到不了这里。
  // 于是 80 只剩下一个效果：≤80 字符的写请求**不打码、不记录、无提示**，
  // 与 multipart 分支（无长度阈值）自相矛盾，属「静默未脱敏」。
  //
  // 取 8 而不是 0：短于 8 字符的 body（`{}`、`{"a":1}`、abort 请求）不可能承载任何
  // 现实中的敏感值——最短的现实 PII 是 11 位手机号 / 18 位身份证 / 9 字符邮箱，
  // 全都在 8 之上。保留这个下限只为省掉这些必然无命中的桥调用，
  // 而**它不再能掩盖任何有意义的请求**。
  const MIN_MASKABLE_LEN = 8;

  // 单份 Office 附件的原始字节上限，**必须与引擎侧闸门对齐**（审计 M5）。
  //
  // `panel._EXT_MAX_BODY = 32MB` 是请求体（JSON 信封）上限，而整份文件要 base64 后
  // 塞进去，膨胀 4/3 —— 原值 25MB 恰好卡在边界之上：25MB 原始文件 ≈ 33.3MB 请求体
  // → 413 + `blocking:true` → 扩展按 (A) 类无条件阻断 → 页面**网络错误**
  // （不是降级直通）。用户传一个 24–25MB 的 docx 会看到整页请求失败。
  //
  // 反推：`4 * ceil(n/3) + 信封 ≈ 32MB` → n 上限约 24.0MB。这里取 23MB，
  // 留约 1.4MB 余量给文件名/headers 等开销。超限的文件会落到 `kind:'raw'` 分支
  // **原样透传并由 `attachment` note 诚实上报「未脱敏 N 个」**——
  // 页面能用，用户也知道它没被保护。这比「硬失败」和「静默放行」都好。
  const MAX_OOXML_BYTES = 23 * 1024 * 1024;

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

  // ─── 文本类文件扩展名与单文件上限（支持拖拽上传脱敏） ───
  const TEXT_FILE_EXTS = new Set([
    'txt', 'text', 'md', 'markdown', 'mdown', 'csv', 'tsv', 'json', 'jsonl', 'ndjson',
    'xml', 'yaml', 'yml', 'py', 'pyw', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx',
    'html', 'htm', 'xhtml', 'css', 'scss', 'sass', 'less', 'sql', 'sh', 'bash', 'zsh',
    'bat', 'cmd', 'ps1', 'psm1', 'c', 'h', 'cpp', 'hpp', 'cc', 'hh', 'cxx', 'hxx',
    'cs', 'java', 'kt', 'kts', 'go', 'rs', 'php', 'rb', 'lua', 'r', 'swift', 'm', 'mm',
    'log', 'env', 'ini', 'conf', 'cfg', 'toml', 'properties', 'diff', 'patch', 'vue', 'svelte'
  ]);
  const MAX_TEXT_FILE_SIZE = 8 * 1024 * 1024; // 8MB 单文件上限

  const isMaskableTextAttachment = (v) => {
    if (!v || typeof v !== 'object') return false;
    const size = typeof v.size === 'number' ? v.size : 0;
    if (size <= 0 || size > MAX_TEXT_FILE_SIZE) return false;
    const name = String(v.name || '').trim();
    if (name.includes('.')) {
      const ext = name.split('.').pop().toLowerCase();
      if (TEXT_FILE_EXTS.has(ext)) return true;
    }
    const type = String(v.type || '').toLowerCase();
    if (type.startsWith('text/')) return true;
    if (
      type.includes('json') ||
      type.includes('xml') ||
      type.includes('yaml') ||
      type.includes('javascript') ||
      type.includes('typescript')
    ) {
      return true;
    }
    return false;
  };

  /** 附件是否是图片（仅用于「未脱敏文件里有图片」的诚实提示）。 */
  const isImageItem = (item) => {
    const v = item && item.value;
    return !!(v && typeof v.type === 'string' && v.type.startsWith('image/'));
  };

  // ─── Office OpenXML 格式识别与二进制/Base64 互转 ───
  const OOXML_FILE_EXTS = new Set(['docx', 'xlsx', 'pptx', 'wps', 'et', 'dps']);
  const isOOXMLAttachment = (v) => {
    if (!v || typeof v !== 'object') return false;
    const size = typeof v.size === 'number' ? v.size : 0;
    if (size <= 0 || size > MAX_OOXML_BYTES) return false;  // 上限见 MAX_OOXML_BYTES 注释
    const name = String(v.name || '').trim();
    if (!name.includes('.')) return false;
    const ext = name.split('.').pop().toLowerCase();
    return OOXML_FILE_EXTS.has(ext);
  };

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }

  function base64ToUint8Array(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  /**
   * multipart 打码：文本字段、常见文本附件与 Office 文档（.docx/.xlsx/.pptx）打码，其它二进制/图片原样透传。
   *
   * 为什么可以这么做：`Request.formData()` 会把 multipart 解析成 [name, string|File] 条目，
   * 我们用打码后的字符串 + 重新组装的 File 拼一个 FormData，再交给 fetch 自动生成**新的**
   * boundary —— 不存在手写 boundary 写坏的问题。
   *
   * 为什么必须显式删掉 `content-type`：见 `new Request(resource, {body})` 那处注释。
   * 旧头里是**旧 boundary**，留着等于告诉上游按一条已经不存在的分隔线去切分实体 → 400。
   *
   * 文本类附件（.txt/.md/.csv/.py/.json 等）：通过 `file.text()` 读取其纯文本并连同
   * 提示词一起打码，用打码后的文本构造同名 `new File` 替换原文件；
   * Office 文档（.docx/.xlsx/.pptx）：送引擎原生解包替换内部 XML 文本并封包回写；
   * 图片与其它格式：保持原样透传，若有未脱敏文件则通过 popup 提醒用户。
   */
  const FIELD_SEP = '\u0001\u0002__MASKIT_PART__\u0002\u0001';
  async function maskMultipart(fd) {
    const entries = [...fd.entries()];
    const items = [];
    const texts = [];

    for (const [k, v] of entries) {
      if (typeof v === 'string') {
        items.push({ kind: 'string', key: k, value: v });
        texts.push(v);
      } else if (isMaskableTextAttachment(v)) {
        let content = null;
        try {
          content = await v.text();
        } catch (e) {
          content = null;
        }
        if (typeof content === 'string') {
          items.push({ kind: 'textFile', key: k, file: v });
          texts.push(content);
        } else {
          items.push({ kind: 'raw', key: k, value: v });
        }
      } else if (isOOXMLAttachment(v)) {
        items.push({ kind: 'ooxmlFile', key: k, file: v });
      } else {
        items.push({ kind: 'raw', key: k, value: v });
      }
    }

    const hasOOXML = items.some((item) => item.kind === 'ooxmlFile');
    if (!texts.length && !hasOOXML) {
      const raws = items.filter((item) => item.kind === 'raw');
      if (raws.length) {
        bridge.notify('note', {
          kind: 'attachment',
          image: raws.some(isImageItem),
          count: raws.length,
          maskedCount: 0,
        });
      }
      return null;                                  // 没有可打码的文本或文档
    }

    let sid = null;
    let parts = [];
    if (texts.length > 0) {
      const joined = texts.join(FIELD_SEP);
      if (joined) {
        const r = await bridge.call('mask', { text: joined });
        if (r && r.blocking) return { blocking: true };  // (A) 无条件阻断，交给调用方抛
        if (r && r.ok) {
          sid = r.sid;
          parts = String(r.masked_text || '').split(FIELD_SEP);
        }
      }
    }

    const out = new FormData();
    let textIdx = 0;
    for (const item of items) {
      if (item.kind === 'string') {
        out.append(item.key, parts.length === texts.length ? parts[textIdx++] : item.value);
      } else if (item.kind === 'textFile') {
        const orig = item.file;
        if (parts.length === texts.length) {
          const maskedContent = parts[textIdx++];
          let replacement;
          if (typeof File !== 'undefined' && orig instanceof File) {
            replacement = new File([maskedContent], orig.name, {
              type: orig.type || 'text/plain',
              lastModified: orig.lastModified || Date.now(),
            });
          } else {
            replacement = new Blob([maskedContent], { type: (orig && orig.type) || 'text/plain' });
          }
          out.append(item.key, replacement, (orig && orig.name) || 'attachment.txt');
          item.masked = true;                     // 只有真的换了内容才算已脱敏
        } else {
          out.append(item.key, orig, orig && orig.name);
        }
      } else if (item.kind === 'ooxmlFile') {
        const orig = item.file;
        let replaced = false;
        try {
          const buf = await orig.arrayBuffer();
          const b64 = arrayBufferToBase64(buf);
          const r = await bridge.call('mask_file', { filename: orig.name, base64: b64, sid });
          if (r && r.blocking) return { blocking: true };  // (A) 必须立即阻断，严禁把未脱敏原文件漏传出网
          if (r && r.ok && r.base64) {
            sid = sid || r.sid;
            const bytes = base64ToUint8Array(r.base64);
            let replacement;
            if (typeof File !== 'undefined' && orig instanceof File) {
              replacement = new File([bytes], orig.name, {
                type: orig.type || 'application/octet-stream',
                lastModified: orig.lastModified || Date.now(),
              });
            } else {
              replacement = new Blob([bytes], { type: (orig && orig.type) || 'application/octet-stream' });
            }
            out.append(item.key, replacement, orig.name);
            item.masked = true;                   // 解包-替换-封包全部成功才算已脱敏
            replaced = true;
          }
        } catch (e) {
          replaced = false;
        }
        if (!replaced) {
          out.append(item.key, orig, orig && orig.name);
        }
      } else {
        out.append(item.key, item.value, item.value && item.value.name);
      }
    }

    // 计数**只认真的替换成功的文件**（标记见上面 append 循环）。此处是「诚实上报」的
    // 唯一关键点：此前在进入循环前就乐观累加 maskedFileCount，于是引擎超时、文本掩码
    // 失败、OOXML 解包失败时，文件原样上行、popup 却告诉用户「已脱敏 N 个文件」——
    // 把最危险的失败模式（以为被保护了，其实没有）包装成成功，比不提示更糟。
    let maskedCount = 0;
    let unmaskedCount = 0;
    let hasUnmaskedImage = false;
    for (const item of items) {
      if (item.kind === 'string') continue;
      if (item.masked) {
        maskedCount++;
      } else {
        unmaskedCount++;
        if (isImageItem(item)) hasUnmaskedImage = true;
      }
    }
    if (unmaskedCount > 0 || maskedCount > 0) {
      bridge.notify('note', {
        kind: 'attachment',
        image: hasUnmaskedImage,
        count: unmaskedCount,
        maskedCount: maskedCount,
      });
    }
    return { body: out, sid: sid };
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
    // 只有带 body 的写方法值得过桥。**方法过滤是这里的主判据**——GET 语义的查询串
    // 在进任何长度判断之前就被挡掉了（MIN_MASKABLE_LEN 原先兼着这个职责，现已退回
    // 它真正的含义：只是一个「短到不可能有 PII」的下限，见其定义处）。
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
