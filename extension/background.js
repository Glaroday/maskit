/* Data Maskit Browser Bridge — Service Worker
 *
 * 职责：**唯一**与本地引擎（panel，默认 http://127.0.0.1:5801）通信的一方。
 * token 只存在本文件的存储里，绝不进页面上下文、绝不进 postMessage。
 *
 * 安全红线（违反即返工）：
 *  1. 100% 本地：只向 127.0.0.1 / localhost 发请求，不接任何遥测、上报、云端日志；
 *  2. 不用 `chrome.storage.sync`（sync 会把数据同步到账号 = 外传）；
 *  3. 什么都不 `console.log(body)`：MV3 SW 会被回收，且等于把 PII 写进浏览器 profile；
 *  4. `chrome.storage.session` **只存元数据**：sid 签发表 {tabId,host,issuedAt} 与
 *     最近请求缓冲 {ts,host,path,action,count,status}。绝不存 body / 占位符 / 原文 /
 *     响应文本；
 *  5. sid 与 host 都由服务端签发 / SW 从 sender.tab 推导，payload 里的同名字段一律忽略。
 *
 * manifest 故意**不写** `default_locale`：它必须与 `_locales/` 目录同进同出，
 * 只声明字段不建目录会让扩展加载直接失败。UI 文案走文件内的中英对照表。
 */

'use strict';

// 扩展内共享常量与纯函数（STATIC_SITES / UNSUPPORTED_REASON / siteMatchPattern…
// 的唯一来源，见 shared.js 头部说明为何必须收敛成一份）。
importScripts('shared.js');
const { STATIC_SITES, siteMatchPattern, siteCovers } = self.MASKIT_SHARED;

const DEFAULTS = {
  token: '',
  panelUrl: 'http://127.0.0.1:5801',
  enabledSites: STATIC_SITES.slice(),
  enabled: true,
  /**
   * 拦截范围：`true` = 同站 POST 一律送引擎（广泛模式，实验性）；
   *           `false` = 只处理已知对话接口路径（精准模式，默认，无数据污染风险）。
   * 由 bridge-main.js 通过 `config` 消息在首次请求时取一次并缓存（刷新页面生效）。
   */
  wideMode: false,
};

/**
 * 引擎未安装 / 未启动时的引导入口。
 *
 * 为什么必须有：扩展**不能独立工作**——规则引擎、占位符复用表、还原都在本地程序里，
 * 扩展只是把页面请求转发过去。引擎不在时扩展「默默什么都不做」，页面完全正常但内容
 * 裸着发出去，用户根本不知道自己没被保护。这比报错糟糕得多，所以必须**明说**去哪装。
 */
// 从 manifest 的 `homepage_url` 推出来，**不在 JS 里写外域字面 URL** —— 扩展代码里出现
// 非本机主机一律被 `check-extension.mjs` 判失败（那条规则防的正是"扩展偷偷外发"）。
// 这个地址只会被渲染成给用户点开的 `<a href>`，扩展自己永不 fetch 它。
const MANIFEST_HOME = String((chrome.runtime.getManifest && chrome.runtime.getManifest() || {}).homepage_url || '').replace(/\/+$/, '');
const DOWNLOAD_URL = MANIFEST_HOME ? MANIFEST_HOME + '/releases/latest' : '';

/** sid 签发表条目存活上限：对齐引擎复用表 RECENT_TTL(24h)，留 1h 余量。 */
const SID_TTL_MS = 25 * 3600 * 1000;
const PRUNE_INTERVAL_MS = 3600 * 1000;

const RECENT_KEY = 'maskit:recent';
const RECENT_MAX = 50;
/** 最近请求缓冲**只允许**这些字段落库（违反即返工：不得存正文/占位符/原文）。 */
const RECENT_FIELDS = ['ts', 'host', 'path', 'action', 'count', 'status'];

const STATUS_KEY = 'maskit:status';
const UNMATCHED_KEY = 'maskit:unmatched';
const UNMATCHED_MAX = 40;
/** 本页「带文件上传的请求」标记：{tabId: {image, count, at}}。只存有没有、是什么类型。 */
const ATTACH_KEY = 'maskit:attach';

/**
 * 今日计数（**只有计数，绝无正文**）。popup 的「今日计数」需要按日归零，而
 * `/api/ext/ping` 的 `_EXT_STATS` 是 panel 进程启动以来的累计值（进程重启即清零），
 * 口径不同不能混用，所以扩展侧自己记一份日计数。
 * 放 session：跨 SW 回收存活、不落盘；浏览器重启即归零，故 popup 上标明口径。
 */
const DAILY_KEY = 'maskit:daily';

/** (B) 类连接失败后的直通期：期间不再发网络请求，popup 显示「已直通 Ns」。 */
const DOWN_WINDOW_MS = 60000;
const PING_TTL_MS = 60000;
const CALL_TIMEOUT_MS = 15000;

/**
 * 403「配置性拒绝」的退避策略（token 失效 / 面板关开关）。
 *
 * **为什么必须退避**：restore 是**每 SSE chunk 一次**调用。token 失效时每个 chunk 都
 * 会打到 panel → 引擎侧每次经 `_guard_reject` 写一行拒绝日志 → 800 行环形缓冲被一条
 * 回答冲干净，「运行日志」里崩溃现场的 Traceback 全没了（SPEC §5.4 的诊断能力归零）。
 * 实测一条几十 chunk 的回答就能把缓冲刷满，所以这不是理论风险。
 *
 * **为什么不复用 `downUntil`**：那个窗口的语义是「引擎没起来」，popup 显示黄标
 * 「引擎未运行，已直通 Ns」；而 token 失效是**用户配置错了**，必须持续红标
 * 「token 失效，请到设置更新」（SPEC §3.6）。合并成一个窗口等于把「你配置错了」
 * 说成「引擎没起来」，排查方向直接被带偏——这正是 SPEC 反复强调的不对称代价。
 *
 * **为什么不干脆"整段不发请求"**：那会让用户在修复后（改对 token / 打开面板开关）
 * 盲等最多一整段窗口，而等待期内页面流量是**静默未脱敏**的。所以退避期里保留
 * **低速探测**：最多每 `AUTH_PROBE_MS` 发一次真实请求，命中即刻自愈。
 * 上限从"每 chunk 一次"降到"每 5s 一次"，日志不再被冲掉，恢复又几乎是即时的。
 */
const AUTH_HOLD_MS = 60000;
const AUTH_PROBE_MS = 5000;

/**
 * R10：`chrome.storage.session` 配额**随 Chrome 版本变**——manifest 定的最低版本 111 上
 * 只有约 1MB（官方文档明示 "Before Chrome 112, the quota was approximately 1 MB"），
 * 112+ 才是约 10MB。所以按 1MB 做预算展示，并只往里放小对象（sid 签发表 + 50 条元数据），
 * 绝不把 session 当通用缓存（popup 里也不塞请求体）。
 */
const SESSION_QUOTA_HINT = 1024 * 1024;

// ── 内存缓存 ────────────────────────────────────────────────────────────────
// 丢了也没关系（可从 panel 重新问），所以放内存；**sid 签发表绝不放这里**：
// MV3 SW 空闲 ~30s 就被终止，内存 Map 必丢，推理模型思考几十秒不吐 chunk 是常态。
let cache = { alive: null, version: '', blockWhenDown: false, recordEvents: true, stats: null, at: 0 };
let downUntil = 0;
// 403 配置性拒绝的退避状态（见 AUTH_HOLD_MS 注释）。与 downUntil 分开记：两者展示
// 语义不同（一个黄标「引擎未运行」、一个红标「token 失效/扩展已关闭」），但**都**
// 在 ping 成功时一起清除（自愈）。
let authHoldUntil = 0;
let authHoldErr = '';
// 退避期内下一次允许真实探测的时间：把"每 chunk 打一次 panel"降到"每 AUTH_PROBE_MS 一次"。
let authProbeAt = 0;
let lastStatus = { engine: 'unknown', detail: '', at: 0 };

// ── 配置 ────────────────────────────────────────────────────────────────────

async function getConfig() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...stored };
}

async function getPanelUrl() {
  const cfg = await getConfig();
  return String(cfg.panelUrl || DEFAULTS.panelUrl).replace(/\/+$/, '');
}

// ── 状态与元数据缓冲（都只存元数据） ─────────────────────────────────────────

async function setStatus(engine, detail) {
  const next = { engine, detail: String(detail || '').slice(0, 80), at: Date.now() };
  // 幂等短路：`safeCall` 每 SSE chunk 都会走一遍状态设置，重复写 storage 是纯浪费
  // （一次回答几十上百次 `chrome.storage.session.set`）。状态没变就不落盘，只刷内存。
  const unchanged = lastStatus.engine === next.engine && lastStatus.detail === next.detail;
  lastStatus = next;
  if (unchanged) return;
  try {
    await chrome.storage.session.set({ [STATUS_KEY]: lastStatus });
  } catch (e) {
    /* 状态写不进去不能影响主链路 */
  }
}

async function readStatus() {
  try {
    const got = await chrome.storage.session.get(STATUS_KEY);
    return got[STATUS_KEY] || lastStatus;
  } catch (e) {
    return lastStatus;
  }
}

/**
 * 写「本页最近请求」环形缓冲。**只写元数据**，字段由 RECENT_FIELDS 白名单强制。
 * 目的：回答「到底生效没有」——(B) 类直通是**静默不脱敏**，不点开 popup 完全无感。
 * 失败静默：缓冲写不进去绝不能影响主链路。
 */
async function pushRecent(entry) {
  try {
    const meta = {};
    for (const k of RECENT_FIELDS) {
      if (entry[k] !== undefined) meta[k] = entry[k];
    }
    meta.ts = meta.ts || Date.now();
    await bumpDaily(meta.action);
    const got = await chrome.storage.session.get(RECENT_KEY);
    const list = Array.isArray(got[RECENT_KEY]) ? got[RECENT_KEY] : [];
    list.unshift(meta);
    await chrome.storage.session.set({ [RECENT_KEY]: list.slice(0, RECENT_MAX) });
  } catch (e) {
    /* 同上 */
  }
}

/** 本机日期（本地时区），用于日计数归零判定。 */
function todayKey() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function bumpDaily(action) {
  try {
    const day = todayKey();
    const got = await chrome.storage.session.get(DAILY_KEY);
    const prev = got[DAILY_KEY];
    const cur = prev && prev.day === day ? prev : { day, mask: 0, restore: 0, skip: 0 };
    const key = action === 'restore' ? 'restore' : action === 'mask' ? 'mask' : 'skip';
    cur[key] = (cur[key] || 0) + 1;
    await chrome.storage.session.set({ [DAILY_KEY]: cur });
  } catch (e) {
    /* 计数写不进去不影响主链路 */
  }
}

/** 记录「本页 POST 未命中路径白名单」的 path，popup 展示供用户反馈。 */
async function pushUnmatched(tabId, path) {
  try {
    if (!path) return;
    const got = await chrome.storage.session.get(UNMATCHED_KEY);
    const all = got[UNMATCHED_KEY] && typeof got[UNMATCHED_KEY] === 'object' ? got[UNMATCHED_KEY] : {};
    const list = Array.isArray(all[tabId]) ? all[tabId] : [];
    if (!list.includes(path)) list.push(path);
    all[tabId] = list.slice(-UNMATCHED_MAX);
    await chrome.storage.session.set({ [UNMATCHED_KEY]: all });
  } catch (e) {
    /* 同上 */
  }
}

/**
 * 记录「本页有请求带文件上传」。
 *
 * 只记**有没有 + 是不是图片**，绝不记文件名 / 内容 / 数量以外的任何东西。
 * 用途是让 popup 能明说「文件内容不会被脱敏」——静默放行是最坏的一种失败：
 * 用户以为上传的合同/截图也被打过码了，实际上原样进了对方服务器。
 */
async function pushAttachment(tabId, payload) {
  if (!tabId) return;
  try {
    const got = await chrome.storage.session.get(ATTACH_KEY);
    const all = got[ATTACH_KEY] && typeof got[ATTACH_KEY] === 'object' ? got[ATTACH_KEY] : {};
    const prev = all[tabId] || { image: false, count: 0, at: 0 };
    all[tabId] = {
      image: !!prev.image || !!payload.image,
      count: Number(payload.count) || prev.count || 0,
      at: Date.now(),
    };
    await chrome.storage.session.set({ [ATTACH_KEY]: all });
  } catch (e) {
    /* 同上 */
  }
}

// ── sid 签发表（chrome.storage.session：跨 SW 重启存活、不落盘） ───────────────

async function rememberSid(sid, tabId, host) {
  if (!sid) return;
  try {
    await chrome.storage.session.set({ [sid]: { tabId, host, issuedAt: Date.now() } });
    const got = await chrome.storage.session.get('maskit:pruneAt');
    const at = Number(got['maskit:pruneAt'] || 0);
    if (Date.now() - at > PRUNE_INTERVAL_MS) {
      await chrome.storage.session.set({ 'maskit:pruneAt': Date.now() });
      await pruneSids();
    }
  } catch (e) {
    /* 登记失败只影响还原，不影响打码 */
  }
}

/** 清理 issuedAt 超 25h 的签名条目（对齐引擎 RECENT_TTL 的滑动窗口）。 */
async function pruneSids() {
  try {
    const all = await chrome.storage.session.get(null);
    const now = Date.now();
    const stale = [];
    for (const [k, v] of Object.entries(all)) {
      if (!v || typeof v !== 'object' || typeof v.issuedAt !== 'number') continue;
      if (now - v.issuedAt > SID_TTL_MS) stale.push(k);
    }
    if (stale.length) await chrome.storage.session.remove(stale);
  } catch (e) {
    /* ignore */
  }
}

/** 还原前的 sid 校验：必须是本 tab 的、且未过期。storage.session 是异步 API。 */
async function validateSid(sid, tabId) {
  if (!sid) return false;
  try {
    const got = await chrome.storage.session.get(sid);
    const rec = got[sid];
    if (!rec || typeof rec !== 'object') return false;
    return rec.tabId === tabId && Date.now() - rec.issuedAt <= SID_TTL_MS;
  } catch (e) {
    return false;
  }
}

// ── 与 panel 通信 ────────────────────────────────────────────────────────────

/**
 * 调本机 panel。
 *
 * ⚠️ **POST 会带 `Origin: chrome-extension://<扩展ID>`**（2026-09-15 真 Chrome 实测反转了
 * 「SW fetch 不带 Origin」的说法——按 Fetch 规范，非 GET/HEAD 一律附加 Origin，与是否拥有
 * host 权限无关；GET 才不带）。所以引擎侧 `api_guard` 必须为 `/api/ext/*` 放行扩展 scheme 的
 * Origin，否则**每个 mask/restore 都被 403 origin_rejected 打回，扩展按 (B) 直通 →
 * 全站静默未脱敏**（页面看起来完全正常，这是最危险的一种失败）。
 * X-Shield-Token 仍是唯一主防线。
 */
async function callPanel(path, body, method = 'POST', timeoutMs = CALL_TIMEOUT_MS) {
  const base = await getPanelUrl();
  const cfg = await getConfig();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(base + path, {
      method,
      headers: { 'X-Shield-Token': String(cfg.token || ''), 'Content-Type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(body || {}),
      signal: ctl.signal,
    });
    let data = null;
    try {
      data = await res.json();
    } catch (e) {
      data = null;      // 解析失败也算 (B)：由调用方的默认桶处理
    }
    return { http: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * (A)/(B) 判定——**白名单式，写死不许改**。
 *
 * 判 (A) 的**唯一**依据是响应里 `blocking === true`（mask 管线异常 503 / 超限 413 /
 * 参数错误 400）。**其余一切**（未枚举的 403、无 blocking 的 500、origin_rejected /
 * host_rejected、DNS/连接/超时错误、JSON 解析失败、未知字段）一律归 (B) 直通，并把
 * 原始 status/error 写进元数据缓冲供排查。
 *
 * 为什么必须这样写：漏归 (A) 只损失一次直通；(B) 误归 (A) 是「网页 AI 全站不可用」
 * 的灾难——两者代价不对称。`api_guard` 实际有四种拒绝路径，穷举天然会漏，所以靠
 * 默认桶兜底而不是靠识别。
 */
function isBlocking(data) {
  return !!(data && data.blocking === true);
}

async function isBlockOnDown() {
  if (Date.now() - cache.at > PING_TTL_MS) {
    await refreshPing().catch(() => {});
  }
  // 未知时回落 false（直通）：宁可少拦一次，也不能因为拿不到开关就把网页打断。
  return cache.blockWhenDown === true;
}

async function refreshPing() {
  let r;
  try {
    r = await callPanel('/api/ext/ping', null, 'GET', 5000);
  } catch (e) {
    // 连接拒绝 / 超时 / DNS：引擎**真的连不上**。
    //
    // 这条分支以前是空的（异常抛给 handlePing 兜底），后果是：状态停在**上一次的
    // 值**不动。上一秒还好好的 → 引擎关掉 → status 仍是 `ok`、popup 仍绿标，
    // 而实际上所有流量都在裸奔。绿标 + 不脱敏是最糟的组合，必须在这里显式标红。
    await setStatus('down', 'engine_unreachable');
    cache = { ...cache, alive: false, at: Date.now() };
    return cache;
  }
  const data = r.data;
  if (r.http === 200 && data && data.ok) {
    cache = {
      alive: true, version: data.version || '',
      blockWhenDown: data.block_when_down === true,
      recordEvents: data.record_events !== false,
      stats: data.stats || null, at: Date.now(),
    };
    // 自愈：ping 成功即证明「引擎可达 + token 有效 + 面板开关已开」三件事同时成立，
    // 两个退避窗口都没有继续存在的理由，立刻解除。
    // 不这么做的话：用户改对 token 后仍要盲等最多 60s 才恢复脱敏，而这 60s 里的流量
    // 是**静默未脱敏**的——popup 显示绿标、实际在裸奔，是最糟的组合。
    downUntil = 0;
    authHoldUntil = 0;
    authHoldErr = '';
    authProbeAt = 0;
    // 状态也要跟着清：之前可能是 invalid_token（token 填错时打的标），
    // 用户改对后如果只有退避窗口被清、状态没清，popup 会一直红着说 token 失效。
    // 实测：SW 冷启动时空 token 打默认端口必吃 403，状态会被钉在 invalid_token，
    // 不在这里清就再也绿不回来（除非真的发一次对话）。
    await setStatus('ok', '');
    return cache;
  }
  // 401 / 403：**引擎在跑**，只是不认我们（token 错 / 面板把扩展桥关了）。
  //
  // 必须跟「连不上」区分开。不区分的后果：popup 看到 `alive: false` 就显示
  // 「检测到本地引擎没运行，点这里去下载」——用户真的重装一遍，装完还是同一个 403，
  // 排查方向被彻底带偏。这里显式把状态打成 invalid_token / disabled，
  // renderGuide 据此判定「引擎在跑」从而**不**显示下载引导。
  const err = String((data && (data.error || data.reason)) || '');
  if (r.http === 401 || r.http === 403) {
    await setStatus(err === 'ext_bridge_disabled' ? 'disabled' : 'invalid_token',
                    err || ('http_' + r.http));
    // 引擎活着就不该进直通退避窗口，否则会把「token 错」伪装成「引擎挂了」
    downUntil = 0;
    cache = { ...cache, alive: false, at: Date.now() };
    return cache;
  }
  // ping 失败也走默认桶，不改缓存里的开关值（避免"拿不到就改行为"）
  cache = { ...cache, alive: false, at: Date.now() };
  return cache;
}

/**
 * 统一调用入口：熔断 + (A)/(B) 归类。
 * 返回 {ok, body} | {ok:false, blocking:true} | {ok:false, passthrough:true}
 */
async function safeCall(path, body) {
  if (Date.now() < downUntil) {
    // detail 用**稳定字符串**而不是「passthrough 45s」：倒计时由 popup 从
    // downRemainingMs 本地走字（`renderStatus` + 逐秒 tick）。把秒数写进 detail 会让
    // 每一 chunk 的状态都"变了"，既刷 storage 又让 setStatus 的幂等短路失效。
    await setStatus('down', 'engine_unreachable');
    return { ok: false, blocking: await isBlockOnDown(), passthrough: true, error: 'engine_down_window' };
  }
  if (Date.now() < authHoldUntil) {
    if (Date.now() < authProbeAt) {
      // 退避期内：不再逐 chunk 打 panel（否则每 chunk 一条 `_guard_reject` 冲掉日志），
      // 但状态**必须继续红标**，且原因与 down 窗口区分开——这正是 invalid_token 与
      // engine_unreachable 展示不同的原因（SPEC §3.6）。
      await setStatus(authHoldErr === 'ext_bridge_disabled' ? 'disabled' : 'invalid_token', authHoldErr);
      return { ok: false, blocking: await isBlockOnDown(), passthrough: true, error: authHoldErr, http: 403 };
    }
    // 到点放行一次真实请求当探测：状态一旦被修好（改对 token / 打开面板开关），
    // 下一次成功调用就会把退避清掉，用户不必盲等整段窗口。
    authProbeAt = Date.now() + AUTH_PROBE_MS;
    // 不 return，落到下面的真实调用
  }
  let r;
  try {
    r = await callPanel(path, body);
  } catch (e) {
    // 连接拒绝 / 超时 / DNS：全属 (B) 默认桶 → 进 60s 直通期
    downUntil = Date.now() + DOWN_WINDOW_MS;
    await setStatus('down', 'engine_unreachable');
    return { ok: false, blocking: await isBlockOnDown(), passthrough: true, error: 'engine_unreachable' };
  }
  const data = r.data;
  if (isBlocking(data)) {
    // (A)：立即阻断，**不熔断**（引擎活着，只是这一单失败）
    await setStatus('error', (data && data.error) || 'engine_error');
    return { ok: false, blocking: true, error: (data && data.error) || 'engine_error' };
  }
  if (r.http >= 200 && r.http < 300 && data && data.ok) {
    downUntil = 0;
    authHoldUntil = 0;
    authHoldErr = '';
    authProbeAt = 0;
    await setStatus('ok', '');
    return { ok: true, body: data };
  }
  // (B) 默认桶：403 ext_bridge_disabled / 403 invalid_token / origin_rejected /
  // host_rejected / 无 blocking 的 500 / 解析失败 …… 全部直通
  const err = (data && data.error) || `http_${r.http}`;
  if (err === 'invalid_token' || err === 'ext_bridge_disabled') {
    // 这两类 403 是**持续性**的（用户配置错了 / 面板开关关着），不会自己好，
    // 所以进退避期；否则 restore 每 chunk 一次会把引擎日志刷爆。
    // 状态分开给：invalid_token 红标「token 失效」，ext_bridge_disabled 红标「扩展已关闭」。
    authHoldUntil = Date.now() + AUTH_HOLD_MS;
    authProbeAt = Date.now() + AUTH_PROBE_MS;
    authHoldErr = err;
    await setStatus(err === 'invalid_token' ? 'invalid_token' : 'disabled', err);
  } else {
    await setStatus('passthrough', err);   // 未识别状态：元数据缓冲里能看到 status
    await pushRecent({ host: body && body.host, path, action: 'skip', count: 0, status: `passthrough:${err}` });
  }
  return { ok: false, blocking: await isBlockOnDown(), passthrough: true, error: err, http: r.http };
}

// ── 业务处理 ────────────────────────────────────────────────────────────────

async function handleMask(payload, tabId, host) {
  // payload 里的 host / sid 一律忽略（页面提供不可信）
  const text = payload && typeof payload.text === 'string' ? payload.text : '';
  if (!text) return { ok: false, passthrough: true };

  // 站点开关在这里兜底——**配置是唯一真相来源**。
  //
  // 为什么必须在这一层：chatgpt.com / claude.ai 是 manifest 里静态声明的 content script，
  // 而静态脚本**没法**用 `unregisterContentScripts` 注销（它不是动态注册的）。
  // 于是用户在设置里删掉 ChatGPT 后，脚本照样注入、照样把 body 送过来——
  // 界面显示「已删除」，实际还在打码，这是比"删不掉"更糟的一种撒谎。
  // 不在这里认账，就没有别的地方能拦住了。
  const cfg = await getConfig();
  if (!siteCovers(host, cfg.enabledSites)) {
    return { ok: false, passthrough: true, error: 'site_disabled' };
  }
  const r = await safeCall('/api/ext/mask', { text, host });
  if (r.ok) {
    await rememberSid(r.body.sid, tabId, host);
    await pushRecent({ host, path: 'mask', action: 'mask', count: 0, status: 'ok' });
    return r.body;
  }
  if (r.blocking) return { ok: false, blocking: true, error: r.error };
  await pushRecent({ host, path: 'mask', action: 'skip', count: 0, status: 'passthrough' });
  return { ok: false, passthrough: true, error: r.error };
}

async function handleRestore(payload, host) {
  const text = payload && typeof payload.text === 'string' ? payload.text : '';
  const body = {
    text,
    sid: String((payload && payload.sid) || ''),
    stream_id: String((payload && payload.stream_id) || ''),
    final: !!(payload && payload.final),
    // content-type 是**分帧方式的唯一依据**（引擎据它决定按 SSE 空行 / NDJSON 换行 /
    // 整体处理）。漏传它 → 引擎退回旧的整段文本还原 → 被事件边界切开的占位符永远
    // 拼不回来，页面露出裸 `{{...}}`。这个字段漏了不会报错，只会安静地不还原。
    content_type: String((payload && payload.content_type) || ''),
    host,                       // host 用 SW 推导值，不用 payload 里的
  };
  const r = await safeCall('/api/ext/restore', body);
  if (r.ok) {
    if (body.final) {
      await pushRecent({ host, path: 'restore', action: 'restore', count: 0, status: 'ok' });
    }
    return r.body;
  }
  // 还原方向**恒透传**（红线 3）：连 (A) 也不在这里阻断——打码那一步已经拦过了，
  // 还原失败再阻断只会让用户看到半截响应。
  if (body.final) {
    await pushRecent({ host, path: 'restore', action: 'skip', count: 0, status: 'passthrough' });
  }
  return { ok: false, text };
}

async function handlePing() {
  try {
    return await refreshPing();
  } catch (e) {
    return { alive: false, version: '', blockWhenDown: false, recordEvents: true, stats: null };
  }
}

/** popup / options 需要的汇总（只读元数据，绝不含正文）。 */
async function handleAdmin(op) {
  if (op === 'snapshot') {
    const cfg = await getConfig();
    const session = await chrome.storage.session.get(null);
    const sids = Object.entries(session).filter(([, v]) => v && typeof v === 'object' && typeof v.issuedAt === 'number');
    let bytes = null;
    try {
      // R10：manifest 定的最低版本 111 上 storage.session 配额只有 ~1MB
      // （Chrome 112 才提到 ~10MB），所以必须能量化观察占用
      bytes = await chrome.storage.session.getBytesInUse(null);
    } catch (e) {
      bytes = null;
    }
    return {
      ok: true,
      config: {
        enabled: cfg.enabled, panelUrl: cfg.panelUrl,
        enabledSites: cfg.enabledSites, hasToken: !!cfg.token,
        wideMode: cfg.wideMode === true,
      },
      status: await readStatus(),
      recent: (await chrome.storage.session.get(RECENT_KEY))[RECENT_KEY] || [],
      unmatched: (await chrome.storage.session.get(UNMATCHED_KEY))[UNMATCHED_KEY] || {},
      // 本页是否出现过带文件的请求（用于提示「附件/图片内容不脱敏」）
      attachments: (await chrome.storage.session.get(ATTACH_KEY))[ATTACH_KEY] || {},
      // 引擎不在时 popup 要给的去向——扩展不能独立工作，必须明说去哪装
      downloadUrl: DOWNLOAD_URL,
      daily: (await chrome.storage.session.get(DAILY_KEY))[DAILY_KEY] || null,
      sidCount: sids.length,
      sessionBytes: bytes,
      sessionQuotaBytes: SESSION_QUOTA_HINT,
      downRemainingMs: Math.max(0, downUntil - Date.now()),
      // 403 配置性拒绝的退避剩余：popup 据此在红标里走字「Ns 后自动重试」，
      // 否则用户改对 token 后只看到红标不变，以为没生效（见 AUTH_HOLD_MS 注释）。
      authHoldRemainingMs: Math.max(0, authHoldUntil - Date.now()),
      authHoldError: authHoldErr,
      cache,
    };
  }
  if (op === 'ping') return { ok: true, ping: await handlePing() };
  if (op === 'clearRecent') {
    await chrome.storage.session.set({ [RECENT_KEY]: [], [UNMATCHED_KEY]: {}, [STATUS_KEY]: { engine: 'unknown', detail: '', at: Date.now() } });
    return { ok: true };
  }
  if (op === 'resync') {
    const failed = await syncDynamicScripts();
    return { ok: true, failed };
  }
  // 这里**故意没有** `rotateToken`：`/api/ext/rotate-token` 是 API_TOKEN 鉴权
  // （SPEC §5.3 T9 断言「ext_token 打 rotate-token → 403」），而扩展手里只有
  // ext_token —— 这个 op 100% 失败。它原先存在，只是因为 options 页有个
  // 「在本机面板旋转」按钮在用 ext_token 去调；那个按钮已改成打开面板设置页。
  // 与其留一个必然报错的死路径，不如不留（要旋转去面板，那里才有 API_TOKEN）。
  return { ok: false, error: 'unknown_op' };
}

// ── 消息入口 ────────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || sender.id !== chrome.runtime.id) return;

  // ⚠️ 判定「是不是扩展自己的页面」**绝不能**用 `!sender.tab`。
  //
  // 实测（2026-09-16，真 Chrome）：以标签页打开的选项页，其 sender 是
  // `{ id: '<extId>', tab: {…}, url: 'chrome-extension://<extId>/options.html' }` ——
  // **`sender.tab` 是有值的**（它确实占着一个浏览器标签页）。于是 `!sender.tab` 为假，
  // admin 分支永远进不去，函数一路走到末尾返回 undefined；因为没有 `return true`，
  // 消息端口立刻关闭，页面侧恒收到：
  //     "The message port closed before a response was received."
  // 表现到界面上就是：选项页「测试连接」永远报失败、会话占用那行永远空白、
  // 添加站点后拿不到重注册确认（而 SW 侧其实一切正常）——三处症状同一个根因。
  //
  // popup 不受影响（它不是 tab），所以这个 bug 只在选项页出现，很容易被漏掉。
  const fromExtPage = String((sender && sender.url) || '').startsWith('chrome-extension:');
  if (fromExtPage) {
    // 扩展自身页面（popup / options）：只能做管理动作，且**不参与**打码链路
    // ——host 必须从真实网页的 tab 推导，所以这里不给 mask/restore。
    if (msg.action === 'admin') {
      handleAdmin(msg.op).then(sendResponse).catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }
    return;
  }

  // 打码链路：只认真实网页里的 content script。
  // 优先取 sender.url（当前 frame 自身的真实 URL），避免 iframe 嵌 AI 页面因顶层域不同被误拦
  if (!sender.tab) return;
  const host = safeHostname(sender.url || sender.tab.url);
  const tabId = sender.tab.id;
  if (msg.action === 'mask') {
    handleMask(msg.payload, tabId, host).then(sendResponse).catch((e) => sendResponse({ ok: false, passthrough: true, error: String(e) }));
    return true;
  }
  if (msg.action === 'restore') {
    // 校验 sid 属于该 tab（storage.session 异步读）
    validateSid(msg.payload && msg.payload.sid, tabId).then((ok) => {
      if (!ok) {
        sendResponse({ ok: false, text: (msg.payload && msg.payload.text) || '' });
        return;
      }
      handleRestore(msg.payload, host)
        .then(sendResponse)
        .catch((e) => sendResponse({ ok: false, text: (msg.payload && msg.payload.text) || '' }));
    });
    return true;
  }
  if (msg.action === 'ping') {
    handlePing().then(sendResponse).catch(() => sendResponse({ alive: false }));
    return true;
  }
  if (msg.action === 'note') {
    // 「本页 POST 未命中白名单」的 path（只存 path，不含 query 之外的任何内容）
    if (msg.payload && msg.payload.kind === 'unmatched_post') {
      pushUnmatched(tabId, String(msg.payload.path || '').slice(0, 200));
    }
    // 「本页有请求带文件上传」：只记类型，不记内容
    if (msg.payload && msg.payload.kind === 'attachment') {
      pushAttachment(tabId, msg.payload);
    }
    sendResponse({ ok: true });
    return true;
  }
  if (msg.action === 'config') {
    // 拦截范围下发（MAIN world 读不到 chrome.storage，只能问 SW）。
    // 只回非敏感的行为开关；token / panelUrl 一律不给页面上下文。
    getConfig()
      .then((c) => sendResponse({ wideMode: c.wideMode === true }))
      .catch(() => sendResponse({ wideMode: false }));
    return true;
  }
});

function safeHostname(url) {
  try {
    return new URL(url).hostname;
  } catch (e) {
    return '';
  }
}

// ── 动态站点注册（权限手势 + 重注册） ─────────────────────────────────────────
//
// 【未实测，按 Chrome 公开行为设计】静态 content_scripts 已覆盖默认两站；用户新增的站点
// 走动态注册：options 页在**用户手势内**先 `chrome.permissions.request({origins})`，
// 成功后让 SW 重注册（单一写入者，避免 options 与 SW 各注册一遍互相覆盖）。
// `onInstalled` + `onStartup` 都会重注册——动态注册的内容脚本在 SW 重启后**不保证**还在。
//
// 返回未能注册的脚本（未授权 / 非法 match 等），由 options 如实展示，不静默吞掉。
//
// ⚠️ 一个**实测踩过**的坑（2026-09-15，真 Chrome + Playwright）：
//   ① 字段名是 **`runAt`（驼峰）**，不是 `run_at`。manifest 里写 `run_at`，
//      但 `chrome.scripting.registerContentScripts()` 的 ScriptInjection 对象用的是
//      `runAt`。写成蛇形会抛 "Unexpected property: 'run_at'"，而它被下面的
//      `catch` 收进 failures —— **动态注册等于 100% 静默失效**（只有用户新增站点时才看到提示）。
//
// 💡 `siteMatchPattern` 已挪到 `shared.js`：它原先在这里和 `options.js` 各有一份，
//    而 `options.js` 是**申请权限**的一方、这里是**注册**的一方——两边规则不一致时
//    「权限申请成功但注册失败」，用户只看到一句 regFailed。现在同源，改一处即全改。
const REGFAIL_KEY = 'maskit:regFailures';

/**
 * 并发锁：同一时刻只允许一次重注册在跑。
 *
 * 为什么必须有（2026-09-16 真机复现）：`onInstalled` / `onStartup` / SW 被唤醒 /
 * options 的 resync 都会调它，两个调用叠在一起时时序是
 *   A 读 existing → B 读 existing（同一份）→ A 注销+注册 → B 注销+注册
 * 第二次注册时上一轮的脚本已经在了（A 刚写进去），Chrome 抛
 *   "Duplicate script ID 'maskit-main-grok.com'"
 * 于是该站点**不注入、不打码**，而 failures 只在 options 手动 resync 时才展示 ——
 * 用户看到的是「已添加」，实际是静默未脱敏。
 */
let syncInFlight = null;

async function syncDynamicScripts() {
  // 已有在跑的重注册：直接复用它的结果，不发起第二次。
  if (syncInFlight) return syncInFlight;
  syncInFlight = (async () => {
    try {
      return await doSyncDynamicScripts();
    } finally {
      syncInFlight = null;
    }
  })();
  return syncInFlight;
}

async function doSyncDynamicScripts() {
  const cfg = await getConfig();
  const sites = (cfg.enabledSites || []).filter((d) => d && !STATIC_SITES.includes(d));
  const wanted = new Map();
  for (const domain of sites) {
    wanted.set(`maskit-isolated-${domain}`, {
      id: `maskit-isolated-${domain}`,
      matches: [siteMatchPattern(domain)],
      js: ['bridge-isolated.js'],
      runAt: 'document_start',
      allFrames: true,
      world: 'ISOLATED',
    });
    wanted.set(`maskit-main-${domain}`, {
      id: `maskit-main-${domain}`,
      matches: [siteMatchPattern(domain)],
      js: ['bridge-main.js'],
      runAt: 'document_start',
      allFrames: true,
      world: 'MAIN',
    });
  }
  const existing = await chrome.scripting.getRegisteredContentScripts().catch(() => []);
  const stale = existing.filter((s) => s.id.startsWith('maskit-')).map((s) => s.id);
  if (stale.length) {
    await chrome.scripting.unregisterContentScripts({ ids: stale }).catch(() => {});
  }
  const failures = [];
  for (const script of wanted.values()) {
    try {
      await chrome.scripting.registerContentScripts([script]);
    } catch (e) {
      // 未授权的站点会被 Chrome 拒绝；逐个注册，失败记录后跳过（options 里会提示）
      failures.push({ id: script.id, error: String((e && e.message) || e) });
    }
  }
  // 落一份到 session：`onStartup`/`onInstalled` 触发的重注册没有调用方接返回值，
  // 不落盘的话「注册失败」就只剩一句没人看的 catch（上面 ① 的坑正是因为这点潜伏了一轮）。
  try {
    await chrome.storage.session.set({ [REGFAIL_KEY]: failures });
  } catch (e) {
    /* 配额/环境异常不该影响注册主流程 */
  }
  return failures;
}

chrome.runtime.onInstalled.addListener(() => {
  pruneSids();
  syncDynamicScripts();
  refreshPing().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  pruneSids();
  syncDynamicScripts();
  refreshPing().catch(() => {});
});

// SW 每次被唤醒也顺手校准一次（MV3 SW 会被回收重建，onInstalled/onStartup 不一定都跑）
pruneSids();
