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
    call(action, payload, timeoutMs = BRIDGE_TIMEOUT_MS) {
      return new Promise((resolve) => {
        const nonce = (crypto.randomUUID && crypto.randomUUID()) || String(Math.random()).slice(2);
        const timer = setTimeout(() => {
          pending.delete(nonce);
          resolve(null);                       // 超时按 (B) 直通处理
        }, timeoutMs);
        pending.set(nonce, { resolve, timer });
        window.postMessage({ type: 'MASKIT_BRIDGE_REQ', nonce, action, payload }, location.origin);
      });
    },
    notify(action, payload) {
      window.postMessage({ type: 'MASKIT_BRIDGE_REQ', nonce: null, action, payload }, location.origin);
    },
  };

  // ─── mask 的专用调用：更长超时 + 一次重试 ───
  //
  // `mask` 是整条链路上**唯一**「桥超时 = 明文出网」的调用：桥一超时，MAIN 侧拿不到
  // `r.sid` 会走 (B) 分支把**原始请求体**发出去（未脱敏），而且**整条响应也不会被还原**
  // （`sid` 为空 → 不包 wrapResponse）。restore 超时只是少还原几个字，代价完全不同。
  //
  // 3s 对 mask 太紧：引擎侧 `/api/ext/*` 走一把全局锁串行（`panel._EXT_LOCK`），
  // 多标签页并发、或 NER 冷启动时，单次 mask 超过 3s 很正常。这里给 6s，并在失败时
  // 重试一次。重试成功的第一个 sid 会在引擎侧成为孤儿会话，由会话 TTL 自然回收。
  const MASK_TIMEOUT_MS = 6000;
  const maskOnce = (text) => bridge.call('mask', { text }, MASK_TIMEOUT_MS);
  const callMask = async (text) => {
    // ⚠️ `blocking`（引擎 413 超限 / 503 管线失败 / 400 参数错）是**确定性拒绝**，
    // **绝不重试**：重试只会拿同一份负载再打一次，既慢又白烧。它必须原样上抛给
    // 调用点去 `throw new TypeError('Failed to fetch')`，走 fail-closed
    // —— 宁可页面报网络错误，也绝不放行未脱敏明文出网。
    const first = await maskOnce(text);
    if (first && first.blocking) return first;
    if (first) return first;
    // 桥超时/失败 → 重试一次（覆盖引擎全局锁排队与 NER 冷启动的偶发超时）。
    return await maskOnce(text);
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
    /\/api\/.*conversation/i,
    /\/backend-api\//i,
    /\/(?:v[0-9]+\/)?(?:chat|completions?|messages|responses)/i, // completions? 兼容单复数，覆盖 Claude/DeepSeek/Kimi 等
    /\/samantha\/chat\//i,                                        // 豆包（Doubao）
    /\/api\/(?:v[0-9]+\/)?chat\//i,                               // Kimi / 通义千问等
    /\/_\/BardChatUi\//i,   // Google Gemini（含 StreamGenerate / batchexecute）
    /\/app-chat\//i,        // Grok（xAI）：/rest/app-chat/conversations/…
    /\/rest\/sse\//i,       // Perplexity：/rest/sse/perplexity_ask
    /\/api\/gql/i,          // Poe：GraphQL 端点 /api/gql_POST
    // ── 文件/附件上传端点（ChatGPT / Claude / 各主流 Web AI / 豆包） ──
    /\/(?:api|backend-api|alice|v[0-9]+)\/.*(?:upload|files?|attachment|resource|convert|doc)/i,
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
  const getWideMode = async () => {
    if (!wideModePromise) {
      wideModePromise = bridge.call('config', {})
        .then((r) => (r && typeof r.wideMode === 'boolean' ? { wideMode: r.wideMode } : null))
        .catch(() => null);
    }
    const res = await wideModePromise;
    if (!res) {
      wideModePromise = null;          // 拿不到就重试，不把「未知」固化成「精准模式」
      return { wideMode: false };      // 本次仍按精准模式（保守），但不写进缓存
    }
    return res;
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
  const initBodyIsBlob = (init) =>
    !!init && typeof Blob !== 'undefined' && init.body instanceof Blob;
  const initBodyIsArrayBuffer = (init) =>
    !!init && (init.body instanceof ArrayBuffer || (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(init.body)));

  // ─── 文件/存储桶与上传端点判定 ───
  const STORAGE_OR_UPLOAD_HOSTS = [
    /\.oaiusercontent\.com$/i,
    /\.s3[.-][a-z0-9-]+\.amazonaws\.com$/i,
    /\.s3\.amazonaws\.com$/i,
    /\.blob\.core\.windows\.net$/i,
    /\.storage\.googleapis\.com$/i,
    /\.aliyuncs\.com$/i,
    /\.myqcloud\.com$/i,
    /\.volces\.com$/i,
    /\.volccdn\.com$/i,
    /claude\.ai$/i,
    /chatgpt\.com$/i,
    /doubao\.com$/i,
    /deepseek\.com$/i,
  ];

  const isUploadOrStorageUrl = (url) => {
    let u;
    try {
      u = new URL(url, location.href);
    } catch (e) {
      return false;
    }
    if (STORAGE_OR_UPLOAD_HOSTS.some((rx) => rx.test(u.hostname))) return true;
    if (LLM_PATH_HINTS.some((rx) => rx.test(u.pathname))) return true;
    return false;
  };

  /** 是否该对文件/附件类请求打码（包含跨域对象存储桶直传）。 */
  const shouldMaskFileUrl = (url, wide) => {
    return shouldMaskUrl(url, wide) || isUploadOrStorageUrl(url);
  };

  // ─── Office 二进制格式清单 ───
  //
  // ⚠️ 必须定义在 `isMaskableTextAttachment` **之前**，并被它**优先排除**。
  // 原因：Office 的 MIME 是 `application/vnd.openxmlformats-officedocument...`，
  // 其中 `openxmlformats` 含子串 `xml` —— 任何 `type.includes('xml')` 式的子串匹配
  // 都会把 docx/xlsx/pptx 全部误判成文本附件（真机实测，见下方判定函数注释）。
  const OOXML_FILE_EXTS = new Set(['docx', 'xlsx', 'pptx', 'wps', 'et', 'dps', 'doc', 'xls']);

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

  /** 明确属于文本的 `application/*` 类型。**精确列举，禁止子串匹配**（理由见下方判定函数）。 */
  const TEXT_APP_MIMES = new Set([
    'application/json', 'application/x-ndjson', 'application/ndjson', 'application/jsonl',
    'application/xml', 'application/xhtml+xml', 'application/x-yaml', 'application/yaml',
    'application/toml', 'application/sql', 'application/javascript', 'application/x-javascript',
    'application/ecmascript', 'application/x-sh', 'application/x-httpd-php',
    'application/x-latex', 'application/x-tex', 'application/rtf',
  ]);

  const isMaskableTextAttachment = (v) => {
    if (!v || typeof v !== 'object') return false;
    const size = typeof v.size === 'number' ? v.size : 0;
    if (size <= 0 || size > MAX_TEXT_FILE_SIZE) return false;
    const name = String(v.name || '').trim();
    if (name.includes('.')) {
      const ext = name.split('.').pop().toLowerCase();
      // Office 二进制**必须先排除**：它的 MIME 含 `openxmlformats` 子串，走 MIME 判定必被误判。
      if (OOXML_FILE_EXTS.has(ext)) return false;
      if (TEXT_FILE_EXTS.has(ext)) return true;
    }
    // MIME 兜底只认**精确**文本类型，禁止子串匹配。
    //
    // 旧写法 `type.includes('json'|'xml'|'yaml')` 是本仓库最隐蔽的一处误判：
    // `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`（xlsx）与
    // docx/pptx 的 MIME 全都含 `xml` → 全部被当成文本附件 → `file.text()` 把二进制 zip
    // 按 UTF-8 解码（非法字节变 U+FFFD）再编码回写，文件当场损坏。
    // 真机实测：6488 字节的 xlsx 经此路径变成 11044 字节的非 zip，上传到
    // ChatGPT/Claude 表现为「附件解析失败」，而扩展侧一切"正常"、无任何告警。
    const type = String(v.type || '').toLowerCase().split(';')[0].trim();
    if (!name || !type) return false;
    return type.startsWith('text/') || TEXT_APP_MIMES.has(type);
  };

  /** 附件是否是图片（仅用于「未脱敏文件里有图片」的诚实提示）。 */
  const isImageItem = (item) => {
    const v = item && item.value;
    return !!(v && typeof v.type === 'string' && v.type.startsWith('image/'));
  };

  // ─── 文本附件的「等长对齐」 ───
  //
  // 真机实测（2026-09-20）：上游（ChatGPT `/backend-api/files/process_upload_stream`）
  // 按**上传前声明的字节数**校验实收字节数，差一个字节就回 `file_size_mismatch`
  // 把整个附件拒收。Office 分支能过，是因为引擎侧 `_pad_zip_to_size` 把重压缩后的
  // zip 补回了原始大小；文本分支没有对应机制，脱敏一改长度（占位符 `{{LABEL_后缀}}`
  // 通常比手机号、短密钥长）上传就失败 —— 真机表现就是「Excel / Word 能传，txt 传不了」。
  //
  // 这里在扩展侧补上同样的对齐语义：
  //   ① 脱敏后更短 → 尾部补空格（空白对 LLM 无副作用，也不引入任何新语义）
  //   ② 恰好等长 → 直接用
  //   ③ 脱敏后更长 → 无法缩短。**放弃脱敏、原样上传**，宁可不上码也不能让用户
  //      传不了文件。注意这不是「静默跳过」：返回 masked=false，调用方会把它
  //      计入 unmaskedCount 并在提示里如实体现，不会谎报成已保护。
  const TEXT_ENCODER = new TextEncoder();

  function alignTextToSize(maskedContent, originalContent, orig) {
    const changed = maskedContent !== originalContent;
    // 目标长度取**文件对象自身的 size**（= 站点向服务端声明的那个数），
    // 而不是重新编码后的长度：原始文件若是非 UTF-8 编码，两者会不相等，
    // 那时只有 orig.size 才是服务端真正比对的基准。
    const target = (orig && typeof orig.size === 'number' && orig.size > 0)
      ? orig.size
      : TEXT_ENCODER.encode(originalContent).length;
    const maskedBytes = TEXT_ENCODER.encode(maskedContent).length;
    if (maskedBytes === target) {
      return { content: maskedContent, masked: changed };
    }
    if (maskedBytes < target) {
      return { content: maskedContent + ' '.repeat(target - maskedBytes), masked: changed };
    }
    return { content: originalContent, masked: false };
  }

  // ─── Office 格式识别与二进制/Base64 互转 ───
  // `OOXML_FILE_EXTS` 定义见上方（必须先于文本判定生效，理由见其注释）。
  const OOXML_MIME_MAP = {
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    'application/msword': 'doc',
    'application/vnd.ms-excel': 'xls',
    'application/vnd.ms-powerpoint': 'pptx',
  };

  function resolveFileExt(v, urlHint) {
    if (v && typeof v.name === 'string' && v.name.includes('.')) {
      return v.name.split('.').pop().toLowerCase().trim();
    }
    if (v && typeof v.type === 'string') {
      const mime = v.type.toLowerCase().split(';')[0].trim();
      if (OOXML_MIME_MAP[mime]) return OOXML_MIME_MAP[mime];
      if (mime === 'text/plain') return 'txt';
      if (mime === 'text/csv') return 'csv';
      if (mime === 'text/markdown') return 'md';
      if (mime === 'application/json') return 'json';
    }
    if (urlHint) {
      try {
        const p = new URL(urlHint, location.href).pathname;
        if (p.includes('.')) return p.split('.').pop().toLowerCase().trim();
      } catch (e) { /* ignore */ }
    }
    return '';
  }

  const isOOXMLAttachment = (v, urlHint) => {
    if (!v || typeof v !== 'object') return false;
    const size = typeof v.size === 'number' ? v.size : 0;
    if (size <= 0 || size > MAX_OOXML_BYTES) return false;  // 上限见 MAX_OOXML_BYTES 注释
    const ext = resolveFileExt(v, urlHint);
    return OOXML_FILE_EXTS.has(ext);
  };

  /** 快速检查二进制前4字节是否为 ZIP 魔数 PK\x03\x04 */
  function isZipMagic(bytes) {
    if (!bytes || bytes.length < 4) return false;
    return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  }

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
      } else if (isOOXMLAttachment(v)) {
        // Office 二进制**必须排在文本判定之前**：文本分支会把二进制按 UTF-8 读坏
        // （见 `isMaskableTextAttachment` 注释）。顺序反了 = Office 打码永不生效。
        items.push({ kind: 'ooxmlFile', key: k, file: v });
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
      } else if (v && typeof v === 'object' && typeof v.slice === 'function' && v.size > 0 && v.size <= MAX_OOXML_BYTES) {
        // ZIP 魔数兜底：即使文件名被抹除或 MIME 类型为二进制流，只要前4字节为 PK\x03\x04 即按 OOXML 处理
        let isZip = false;
        try {
          const headBuf = await v.slice(0, 4).arrayBuffer();
          isZip = isZipMagic(new Uint8Array(headBuf));
        } catch (e) {
          isZip = false;
        }
        if (isZip) {
          items.push({ kind: 'ooxmlFile', key: k, file: v });
        } else {
          items.push({ kind: 'raw', key: k, value: v });
        }
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
    // 任一字符串字段/附件被真正改写？用于零触碰判定（一个敏感值都没命中就不重建请求）。
    let textChanged = false;
    if (texts.length > 0) {
      const joined = texts.join(FIELD_SEP);
      if (joined) {
        const r = await callMask(joined);
        if (r && r.blocking) return { blocking: true };  // (A) 无条件阻断，交给调用方抛
        if (r && r.ok) {
          sid = r.sid;
          parts = String(r.masked_text || '').split(FIELD_SEP);
          if (String(r.masked_text || '') !== joined) textChanged = true;
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
          const maskedContent = parts[textIdx];
          const originalContent = texts[textIdx];
          textIdx++;
          // 脱敏后必须与原始文件**等字节数**，否则上游按声明的 file_size 校验会拒收
          // （见 alignTextToSize 注释：这是「Excel / Word 能传、txt 传不了」的根因）。
          const aligned = alignTextToSize(maskedContent, originalContent, orig);
          let replacement;
          if (typeof File !== 'undefined' && orig instanceof File) {
            replacement = new File([aligned.content], orig.name, {
              type: orig.type || 'text/plain',
              lastModified: orig.lastModified || Date.now(),
            });
          } else {
            replacement = new Blob([aligned.content], { type: (orig && orig.type) || 'text/plain' });
          }
          out.append(item.key, replacement, (orig && orig.name) || 'attachment.txt');
          // 内容**真的变了**才算已脱敏：引擎没命中敏感词时会原样回传，
          // 那时报成已脱敏，就是把「未保护」包装成「已保护」。
          // 对齐失败（脱敏后反而更长）时 aligned.masked 恒为 false，同样如实计入未脱敏。
          if (aligned.masked) item.masked = true;
        } else {
          out.append(item.key, orig, orig && orig.name);
        }
      } else if (item.kind === 'ooxmlFile') {
        const orig = item.file;
        let replaced = false;
        try {
          const buf = await orig.arrayBuffer();
          const b64 = arrayBufferToBase64(buf);
          const fName = (orig && typeof orig.name === 'string' && orig.name) || 'attachment.xlsx';
          const r = await bridge.call('mask_file', { filename: fName, base64: b64, sid });
          if (r && r.blocking) return { blocking: true };  // (A) 必须立即阻断，严禁把未脱敏原文件漏传出网
          if (r && r.ok && r.base64) {
            sid = sid || r.sid;
            const bytes = base64ToUint8Array(r.base64);
            let defaultMime = 'application/octet-stream';
            const fExt = resolveFileExt(orig, '');
            if (fExt === 'xlsx') defaultMime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
            else if (fExt === 'docx') defaultMime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
            else if (fExt === 'pptx') defaultMime = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

            let replacement;
            if (typeof File !== 'undefined' && orig instanceof File) {
              replacement = new File([bytes], fName, {
                type: orig.type || defaultMime,
                lastModified: orig.lastModified || Date.now(),
              });
            } else {
              replacement = new Blob([bytes], { type: (orig && orig.type) || defaultMime });
            }
            out.append(item.key, replacement, fName);
            // 引擎在「无敏感信息」或「体积无法对齐而放弃脱敏」时会原样回传字节，
            // 只有 hit_count > 0 才说明内容真被改写过，才敢报「已脱敏」。
            if (typeof r.hit_count === 'number' && r.hit_count > 0) item.masked = true;
            replaced = true;
          }
        } catch (e) {
          console.warn('[Maskit Bridge] OOXML mask error:', e);
          replaced = false;
        }
        if (!replaced) {
          out.append(item.key, orig, (orig && orig.name) || 'attachment.xlsx');
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
    // 零触碰原则（与文本 / Blob 分支一致）：一个敏感值都没命中时**不要重建 FormData**——
    // 重建会换掉 boundary、改变请求字节指纹，对签名敏感的站点是纯风险而收益为零。
    // 返回 null = 调用方原样放行原始请求（顺带也就不存在「需要还原的响应」）。
    // 主域（claude.ai / chatgpt.com …）被整体当作上传域，所以这里能拦下域内**所有**
    // FormData POST，零触碰也因此变成了必要而非可选项。
    if (!textChanged && maskedCount === 0) return null;
    return { body: out, sid: sid, masked: true };
  }

  /**
   * 单文件（Blob / File）直传打码：覆盖对象存储直传（S3 / OSS / OAI）与单文件 POST/PUT。
   * 支持 Office 文档（.docx / .xlsx / .pptx）与常见文本附件（.txt / .csv / .json 等）。
   */
  async function maskSingleFile(blob, urlHint) {
    if (!blob || typeof Blob === 'undefined' || !(blob instanceof Blob)) return null;

    let ext = resolveFileExt(blob, urlHint);
    let isOOXML = OOXML_FILE_EXTS.has(ext);
    let isText = isMaskableTextAttachment(blob);

    // ZIP 魔数兜底：当没有明确扩展名或 MIME 类型为通用的 application/octet-stream 时，
    // 检查前4字节是否为 PK\x03\x04 (ZIP)。若符合且大小在合法范围内，则强制按 OOXML 处理。
    if (!isOOXML && !isText && blob.size > 4 && blob.size <= MAX_OOXML_BYTES) {
      try {
        const headBuf = await blob.slice(0, 4).arrayBuffer();
        if (isZipMagic(new Uint8Array(headBuf))) {
          isOOXML = true;
          ext = 'xlsx';
        }
      } catch (e) { /* ignore */ }
    }

    if (!isOOXML && !isText) {
      if (blob.type && blob.type.startsWith('image/')) {
        bridge.notify('note', { kind: 'attachment', image: true, count: 1, maskedCount: 0 });
      }
      return null;
    }

    const filename = (blob && typeof blob.name === 'string' && blob.name)
      || (ext ? `attachment.${ext}` : 'attachment.bin');

    // 1. Office 文档处理分支
    if (isOOXML) {
      if (blob.size > MAX_OOXML_BYTES) {
        bridge.notify('note', { kind: 'attachment', image: false, count: 1, maskedCount: 0 });
        return null;
      }
      try {
        const buf = await blob.arrayBuffer();
        const bytes = new Uint8Array(buf);
        if (!isZipMagic(bytes)) return null;

        let defaultMime = 'application/octet-stream';
        if (ext === 'xlsx') defaultMime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
        else if (ext === 'docx') defaultMime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
        else if (ext === 'pptx') defaultMime = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

        const b64 = arrayBufferToBase64(buf);
        const r = await bridge.call('mask_file', { filename, base64: b64 });
        if (r && r.blocking) return { blocking: true };
        if (r && r.ok && r.base64) {
          // 引擎在「无敏感信息」或「体积无法对齐而放弃脱敏」时会**原样回传**字节。
          // 那种情况下既不重建请求（保持零触碰，不动站点的签名相关字节），
          // 也绝不报「已脱敏」——把「未保护」说成「已保护」是最危险的一类谎报。
          if (!(typeof r.hit_count === 'number' && r.hit_count > 0)) return null;
          const maskedBytes = base64ToUint8Array(r.base64);
          let replacement;
          if (typeof File !== 'undefined' && blob instanceof File) {
            replacement = new File([maskedBytes], filename, {
              type: blob.type || defaultMime,
              lastModified: blob.lastModified || Date.now(),
            });
          } else {
            replacement = new Blob([maskedBytes], { type: blob.type || defaultMime });
          }
          bridge.notify('note', { kind: 'attachment', image: false, count: 0, maskedCount: 1 });
          return { body: replacement, sid: r.sid, masked: true };
        }
      } catch (e) {
        return null;
      }
      return null;
    }

    // 2. 文本类附件处理分支
    if (isText) {
      try {
        const content = await blob.text();
        if (content && content.length > 0) {
          const r = await callMask(content);
          if (r && r.blocking) return { blocking: true };
          if (r && r.ok && typeof r.masked_text === 'string') {
            // 无命中时引擎原样回传：不重建请求（零触碰）、不报「已脱敏」。
            if (r.masked_text === content) return null;
            // 与 multipart 分支同一套对齐语义：脱敏后字节数必须与原始文件一致，
            // 否则上游按声明的 file_size 校验会拒收（见 alignTextToSize 注释）。
            const aligned = alignTextToSize(r.masked_text, content, blob);
            // 对齐失败（脱敏后反而更长）：宁可不上码，也不能让用户的文件传不上去。
            // 这里返回 null = 完全不碰请求，站点看到的是原始文件，与「未脱敏」一致。
            if (!aligned.masked) return null;
            let replacement;
            if (typeof File !== 'undefined' && blob instanceof File) {
              replacement = new File([aligned.content], filename, {
                type: blob.type || 'text/plain',
                lastModified: blob.lastModified || Date.now(),
              });
            } else {
              replacement = new Blob([aligned.content], { type: blob.type || 'text/plain' });
            }
            bridge.notify('note', { kind: 'attachment', image: false, count: 0, maskedCount: 1 });
            return { body: replacement, sid: r.sid, masked: true };
          }
        }
      } catch (e) {
        return null;
      }
    }

    return null;
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
    const isUrlMaskable = shouldMaskUrl(url, cfg.wideMode);
    const isFileUrlMaskable = shouldMaskFileUrl(url, cfg.wideMode);

    if (!isUrlMaskable && !isFileUrlMaskable) {
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
      // ── multipart：文本字段打码，文件打码 ──
      if (isMultipart(resource)) {
        const fd = await resource.clone().formData().catch(() => null);
        if (fd) {
          const m = await maskMultipart(fd);
          if (m && m.blocking) throw new TypeError('Failed to fetch');   // (A)
          if (m) {
            // 必须删掉 content-type（旧 boundary）和 content-length（打码后体积已变）
            const h = new Headers(resource.headers);
            h.delete('content-type');
            h.delete('content-length');
            resource = new Request(resource, { body: m.body, headers: h, signal: resource.signal });
            const res = await origFetch.call(this, resource);
            // 文件上传响应为普通 JSON 元数据，绝不可走 wrapResponse（避免删除 Content-Length 或插入 TransformStream）
            return (m.sid && m.masked) ? wrapResponse(res, m.sid) : res;
          }
        }
        return origFetch.apply(this, args);
      }

      // ── 单文件直传（仅当请求发往上传/存储桶端点时，识别 Blob 附件）──
      if (isUploadOrStorageUrl(url)) {
        const ct = (resource.headers.get('content-type') || '').toLowerCase();
        if (ct.includes('application/') || ct.includes('text/') || ct === '') {
          const cloned = resource.clone();
          const blob = await cloned.blob().catch(() => null);
          if (blob && (isOOXMLAttachment(blob, url) || isMaskableTextAttachment(blob))) {
            const m = await maskSingleFile(blob, url);
            if (m && m.blocking) throw new TypeError('Failed to fetch');
            if (m && m.masked) {
              const h = new Headers(resource.headers);
              h.delete('content-length');
              resource = new Request(resource, { body: m.body, headers: h, signal: resource.signal });
              return origFetch.call(this, resource);
            }
          }
        }
      }

      // 其它非文本 body（Blob / ReadableStream / ArrayBuffer）：读成字符串再回写会破坏
      // 原有语义，一律原样放行。
      if (!isMaskableBody(resource) || !isUrlMaskable) return origFetch.apply(this, args);
      const raw = await resource.clone().text();
      if (raw.length > minLen) {
        const r = await callMask(raw);
        if (r && r.ok) {
          sid = r.sid;
          // 零触碰原则：只有当内容确实被替换脱敏时，才重新构造 Request。
          // 若内容未变，保留原生 resource 对象，防止破坏字节跳动/豆包等严格的风控签名（a_bogus）。
          if (r.masked_text !== raw) {
            resource = new Request(resource, { body: r.masked_text, signal: resource.signal });
          }
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
        h.delete('content-length');
        reqInit = { ...init, body: m.body, headers: h };
        const res = await origFetch.call(this, url, reqInit);
        return (m.sid && m.masked) ? wrapResponse(res, m.sid) : res;
      }
    } else if (initBodyIsBlob(init) && isUploadOrStorageUrl(url)) {
      const m = await maskSingleFile(init.body, url);
      if (m && m.blocking) throw new TypeError('Failed to fetch');
      if (m && m.masked) {
        const h = new Headers((init && init.headers) || {});
        h.delete('content-length');
        reqInit = { ...init, body: m.body, headers: h };
        const res = await origFetch.call(this, url, reqInit);
        return m.sid ? wrapResponse(res, m.sid) : res;
      }
    } else if (initBodyIsArrayBuffer(init)) {
      let isZip = false;
      const bytes = init.body instanceof ArrayBuffer ? new Uint8Array(init.body) : new Uint8Array(init.body.buffer, init.body.byteOffset, init.body.byteLength);
      if (bytes.length > 4 && isZipMagic(bytes)) {
        isZip = true;
      }
      if (isZip && isFileUrlMaskable) {
        // ── ArrayBuffer 格式的 Office 文档直传 ──
        try {
          const b64 = arrayBufferToBase64(bytes.buffer);
          const r = await bridge.call('mask_file', { filename: 'attachment.xlsx', base64: b64 });
          if (r && r.blocking) throw new TypeError('Failed to fetch');
          if (r && r.ok && r.base64) {
            const maskedBytes = base64ToUint8Array(r.base64);
            const h = new Headers((init && init.headers) || {});
            h.delete('content-length');
            reqInit = { ...init, body: maskedBytes, headers: h };
            return origFetch.call(this, url, reqInit);
          }
        } catch (e) { /* ignore */ }
      } else if (isUrlMaskable) {
        // ── 字节跳动/豆包 WebAssembly 文本内存字节数组脱敏分支 ──
        try {
          const dec = new TextDecoder();
          const rawText = dec.decode(init.body);
          if (rawText && rawText.length > minLen) {
            const r = await callMask(rawText);
            if (r && r.ok) {
              sid = r.sid;
              if (r.masked_text !== rawText) {
                const enc = new TextEncoder();
                const maskedBytes = enc.encode(r.masked_text);
                reqInit = { ...init, body: maskedBytes };
              }
            } else if (r && r.blocking) {
              throw new TypeError('Failed to fetch');
            }
          }
        } catch (e) { /* ignore */ }
      }
    } else if ((initBodyIsText(init) || isUrlParams) && isUrlMaskable && (isUrlParams ? init.body.toString().length : init.body.length) > minLen) {
      const textToMask = isUrlParams ? init.body.toString() : init.body;
      const r = await callMask(textToMask);
      if (r && r.ok) {
        sid = r.sid;
        // 零触碰原则：未命中敏感词时不改写 init 对象，保护签名完整性
        if (r.masked_text !== textToMask) {
          reqInit = { ...init, body: isUrlParams ? new URLSearchParams(r.masked_text) : r.masked_text };
        }
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

  // ─── XMLHttpRequest hook ───
  const origXHROpen = window.XMLHttpRequest.prototype.open;
  const origXHRSend = window.XMLHttpRequest.prototype.send;
  const origXHRSetRequestHeader = window.XMLHttpRequest.prototype.setRequestHeader;
  const origXHRAbort = window.XMLHttpRequest.prototype.abort;

  window.XMLHttpRequest.prototype.open = function (method, url, async, user, password) {
    const isAsync = async !== false;
    this._maskit = {
      method: String(method || 'GET').toUpperCase(),
      url: String(url || ''),
      headers: {},
      isAsync: isAsync,
      aborted: false,
    };
    return origXHROpen.apply(this, arguments);
  };

  window.XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (this._maskit && this._maskit.headers) {
      this._maskit.headers[String(name || '').toLowerCase()] = String(value || '');
    }
    return origXHRSetRequestHeader.apply(this, arguments);
  };

  window.XMLHttpRequest.prototype.abort = function () {
    if (this._maskit) {
      this._maskit.aborted = true;
    }
    return origXHRAbort.apply(this, arguments);
  };

  window.XMLHttpRequest.prototype.send = function (body) {
    const ctx = this._maskit;
    if (!ctx || (ctx.method !== 'POST' && ctx.method !== 'PUT' && ctx.method !== 'PATCH') || !body) {
      return origXHRSend.apply(this, arguments);
    }

    if (!ctx.isAsync) {
      return origXHRSend.apply(this, arguments);
    }

    const xhr = this;
    const isFormData = typeof FormData !== 'undefined' && body instanceof FormData;
    const isBlob = typeof Blob !== 'undefined' && body instanceof Blob;
    const isString = typeof body === 'string' && body.length > MIN_MASKABLE_LEN;
    const isArrayBuf = typeof ArrayBuffer !== 'undefined' && (body instanceof ArrayBuffer || ArrayBuffer.isView(body));

    if (!isFormData && !isBlob && !isString && !isArrayBuf) {
      return origXHRSend.apply(this, arguments);
    }

    const processAndSend = async () => {
      try {
        const cfg = await getWideMode();
        const isUrlMaskable = shouldMaskUrl(ctx.url, cfg.wideMode);
        const isFileUrlMaskable = shouldMaskFileUrl(ctx.url, cfg.wideMode);

        if (!isUrlMaskable && !isFileUrlMaskable) {
          if (!ctx.aborted) origXHRSend.call(xhr, body);
          return;
        }

        let sendBody = body;
        if (isFormData) {
          const m = await maskMultipart(body);
          if (ctx.aborted) return;
          if (m && m.blocking) {
            xhr.dispatchEvent(new ProgressEvent('error'));
            return;
          }
          if (m && m.body) {
            sendBody = m.body;
          }
        } else if (isBlob && isFileUrlMaskable) {
          const m = await maskSingleFile(body, ctx.url);
          if (ctx.aborted) return;
          if (m && m.blocking) {
            xhr.dispatchEvent(new ProgressEvent('error'));
            return;
          }
          if (m && m.masked) {
            sendBody = m.body;
          }
        } else if (isArrayBuf && (isUrlMaskable || isFileUrlMaskable)) {
          let isZip = false;
          const bytes = body instanceof ArrayBuffer ? new Uint8Array(body) : new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
          if (bytes.length > 4 && isZipMagic(bytes)) {
            isZip = true;
          }
          if (isZip && isFileUrlMaskable) {
            try {
              const b64 = arrayBufferToBase64(bytes.buffer);
              const r = await bridge.call('mask_file', { filename: 'attachment.xlsx', base64: b64 });
              if (ctx.aborted) return;
              if (r && r.blocking) {
                xhr.dispatchEvent(new ProgressEvent('error'));
                return;
              }
              if (r && r.ok && r.base64) {
                sendBody = base64ToUint8Array(r.base64);
              }
            } catch (e) { /* ignore */ }
          } else if (isUrlMaskable) {
            try {
              const dec = new TextDecoder();
              const rawText = dec.decode(body);
              if (rawText && rawText.length > MIN_MASKABLE_LEN) {
                const r = await callMask(rawText);
                if (ctx.aborted) return;
                if (r && r.blocking) {
                  xhr.dispatchEvent(new ProgressEvent('error'));
                  return;
                }
                if (r && r.ok && r.masked_text && r.masked_text !== rawText) {
                  sendBody = new TextEncoder().encode(r.masked_text);
                }
              }
            } catch (e) { /* ignore */ }
          }
        } else if (isString && isUrlMaskable) {
          const r = await callMask(body);
          if (ctx.aborted) return;
          if (r && r.blocking) {
            xhr.dispatchEvent(new ProgressEvent('error'));
            return;
          }
          if (r && r.ok && r.masked_text) {
            sendBody = r.masked_text;
          }
        }

        if (ctx.aborted) return;
        // ⚠️ **已知限制**：XHR 路径只做请求侧脱敏，不做响应侧还原。
        //
        // 不是漏了，而是在「原文映射绝不进 MAIN world」这条安全边界下**做不到**：
        // `responseText` / `response` 都是**同步** getter，而还原必须**异步**问引擎
        // （映射只存在于引擎侧；把它拉到页面就是让页面脚本拿到敏感值原文）。
        // 任何「先异步还原、再让页面读」的方案都无法保证页面在 `onload` 里同步读到
        // 还原后的值；拿旧值当缓存又会把「未还原」静默包装成「已还原」。
        //
        // 所以这里的选择是：**宁可不接管 XHR 的响应，也不造一个偶发失效的伪还原**。
        // 代价限定在「站点用 XHR 收流，且模型复述了占位符」时页面会看到 `{{...}}`；
        // 收益是请求侧该脱敏的仍然脱敏（明文绝不出网）。
        // 真需要覆盖的站点应该走 fetch 路径（主流 Web AI 都是 fetch + SSE）。
        origXHRSend.call(xhr, sendBody);
      } catch (err) {
        if (!ctx.aborted) {
          origXHRSend.call(xhr, body);
        }
      }
    };

    processAndSend();
  };
})();
