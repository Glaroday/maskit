#!/usr/bin/env node
/*
 * 浏览器扩展（extension/）静态门禁。
 *
 * **为什么需要**：扩展侧此前**没有任何自动化门禁**——单测（python）碰不到它，
 * `e2e_ext_bridge.py` 要真浏览器且不进 verify-all（SPEC §6.2 定为可选）。于是
 * extension/ 是唯一"改错了当场看不出来"的地方，而它恰恰是最脆的：一个 i18n 键拼错，
 * 页面上就是一行空白文案；`shared.js` 忘了在 HTML 里引，整个设置页 ReferenceError 全白；
 * `registerContentScripts` 写回蛇形 `run_at`，动态站点**静默失效**（见 background.js 注释）。
 * 这些都不是理论风险：前两个已经在本轮开发中差点踩到，后一个实测踩过。
 *
 * 检查项（全部零依赖、纯静态 + 纯函数用例）：
 *   1. 每个 .js 能被解析（语法错误当场拦住）；
 *   2. manifest.json 合法、必需字段齐全、引用的文件都存在；
 *   3. HTML 的 `<script src>` **顺序**正确（shared.js 必须在逻辑脚本之前）且无内联脚本
 *      （MV3 默认 CSP 会禁掉内联，写了就是运行时不执行）；
 *   4. i18n：zh/en 键集**必须完全一致**，且 HTML 里每个 data-i18n 键都能查到译文；
 *   5. shared.js 的纯函数行为（match pattern / 域名校验 / 站点覆盖）；
 *   6. 安全红线：不得出现 `chrome.storage.sync`、不得出现非 127.0.0.1/localhost 的字面 URL；
 *   7. `syncDynamicScripts` 必须用驼峰 `runAt`（蛇形 `run_at` 会让动态注册 100% 静默失效）；
 *   8. STATIC_SITES 与 manifest 的静态 content_scripts 必须对得上；
 *   9. SW 必须 `importScripts('shared.js')`（否则 MASKIT_SHARED 未定义，扩展加载即死）；
 *  10. JS 里 `$('id')` / `getElementById('id')` 引用的 id 必须在对应 HTML 里存在
 *      （缺失会让初始化在绑定按钮事件前抛错 —— 「刷新 / 设置」全成死键，见 §3b）。
 *
 * 用法：`node scripts/check-extension.mjs`（失败退出码 1）
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import url from 'node:url'

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..')
const EXT = path.join(ROOT, 'extension')

const errors = []
const notes = []
const fail = (msg) => errors.push(msg)

function read(name) {
  const p = path.join(EXT, name)
  if (!fs.existsSync(p)) {
    fail(`缺少文件：extension/${name}`)
    return ''
  }
  return fs.readFileSync(p, 'utf8')
}

// ── 1. 语法 ──────────────────────────────────────────────────────────────────
const JS_FILES = ['shared.js', 'background.js', 'bridge-main.js', 'bridge-isolated.js',
  'options.js', 'popup.js']
const sources = {}
for (const name of JS_FILES) {
  const code = read(name)
  sources[name] = code
  if (!code) continue
  try {
    new vm.Script(code, { filename: `extension/${name}` })
  } catch (e) {
    fail(`extension/${name} 语法错误：${e.message}`)
  }
}

// ── 2. manifest ─────────────────────────────────────────────────────────────
let manifest = null
try {
  manifest = JSON.parse(read('manifest.json') || '{}')
} catch (e) {
  fail(`manifest.json 不是合法 JSON：${e.message}`)
}
if (manifest) {
  if (manifest.manifest_version !== 3) fail('manifest_version 必须是 3（MV3）')
  for (const key of ['name', 'version', 'background', 'action']) {
    if (!(key in manifest)) fail(`manifest.json 缺少必需字段 ${key}`)
  }
  // `default_locale` 只有配了 _locales/ 目录才能写：只声明字段会让扩展直接加载失败
  if ('default_locale' in manifest && !fs.existsSync(path.join(EXT, '_locales'))) {
    fail('manifest.json 声明了 default_locale 但没有 _locales/ 目录 —— 扩展会加载失败')
  }
  const referenced = new Set()
  const bgCfg = manifest.background || {}
  const sw = String(bgCfg.service_worker || '').trim()
  if (sw) referenced.add(sw)
  // 跨浏览器双键：Chromium 走 service_worker，Firefox MV3 走 event page（scripts）。
  // Firefox 不支持 service_worker；只写单键在 Firefox 下 background 完全缺失 → 扩展死。
  if (!sw) fail('manifest.json background 缺少 service_worker（Chromium MV3 必需）')
  if (!Array.isArray(bgCfg.scripts) || !bgCfg.scripts.length) {
    fail('manifest.json background 缺少 scripts 数组（Firefox MV3 是 event page，只写 service_worker 时背景完全缺失）')
  }
  for (const s of bgCfg.scripts || []) referenced.add(s)
  for (const cs of manifest.content_scripts || []) {
    for (const f of cs.js || []) referenced.add(f)
  }
  for (const page of [manifest.options_page, (manifest.action || {}).default_popup]) {
    if (page) referenced.add(page)
  }
  for (const f of referenced) {
    if (!fs.existsSync(path.join(EXT, f))) fail(`manifest.json 引用了不存在的文件：extension/${f}`)
  }
  // content_scripts 在 manifest 里用蛇形 run_at（与 chrome.scripting 的 API 不同名，
  // 这正是 background.js 那个坑的来源），这里只做"字段确实存在"的存在性检查
  for (const cs of manifest.content_scripts || []) {
    if (!cs.run_at) fail('manifest content_scripts 缺少 run_at（manifest 侧是蛇形，别改）')
    if (!Array.isArray(cs.matches) || !cs.matches.length) fail('manifest content_scripts 缺少 matches')
  }
}

// ── 3. HTML：脚本顺序 + 内联脚本 ─────────────────────────────────────────────
const PAGES = [
  { html: 'options.html', logic: 'options.js' },
  { html: 'popup.html', logic: 'popup.js' },
]
for (const { html, logic } of PAGES) {
  const src = read(html)
  if (!src) continue
  const tags = [...src.matchAll(/<script\b([^>]*)>/gi)].map((m) => m[1])
  for (const attrs of tags) {
    if (!/\bsrc\s*=/i.test(attrs)) {
      fail(`extension/${html} 有内联 <script>：MV3 默认 CSP 会拒绝执行（页面上就是死的）`)
    }
  }
  const order = tags.map((a) => (a.match(/src\s*=\s*"([^"]+)"/i) || [])[1]).filter(Boolean)
  const iShared = order.indexOf('shared.js')
  const iLogic = order.indexOf(logic)
  if (iShared < 0) {
    fail(`extension/${html} 没有引入 shared.js —— 逻辑脚本会因 MASKIT_SHARED 未定义而整页报错`)
  } else if (iLogic < 0) {
    fail(`extension/${html} 没有引入 ${logic}`)
  } else if (iShared > iLogic) {
    fail(`extension/${html} 里 shared.js 必须排在 ${logic} **之前**（否则 const 解构拿到 undefined）`)
  }
  for (const f of order) {
    if (!fs.existsSync(path.join(EXT, f))) fail(`extension/${html} 引用了不存在的脚本：${f}`)
  }
}

// ── 3b. JS 引用的 DOM id 必须在对应 HTML 里存在 ──────────────────────────────
// 补一次真实事故（2026-09-16）：popup.html 的标题只写了 `data-i18n="recentTitle"`
// 而漏了 `id="recentTitle"`，于是 popup.js `$('recentTitle').textContent = …` 必抛
// TypeError。后果**不是**"少一行文案"，而是 init() 被掐断在「绑定按钮事件」之前 ——
// 「刷新 / 设置」一起变死键，界面却照常显示"尚未检测"，用户只能得出"点了没反应"。
// 这类错误静态可判，而 §4 的 i18n 检查看不见它（i18n 键存在、DOM 也在，只是 id 没了）。
// 只认字面量参数；`$('row-' + i)` 这类动态拼接天然跳过（不误报）。
const ID_USE_RE = /\$\('([A-Za-z0-9_-]+)'\)|getElementById\(['"]([A-Za-z0-9_-]+)['"]\)/g
for (const { html, logic } of PAGES) {
  const code = sources[logic]
  const page = read(html)
  if (!code || !page) continue
  const wantIds = new Set()
  for (const m of code.matchAll(ID_USE_RE)) wantIds.add(m[1] || m[2])
  const haveIds = new Set([...page.matchAll(/\bid="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]))
  const miss = [...wantIds].filter((id) => !haveIds.has(id))
  if (miss.length) {
    fail(`extension/${logic} 引用了 ${html} 里不存在的 id：${miss.join(', ')}` +
      '（运行时抛 TypeError，且会在绑定按钮事件前中断整个初始化，表现为"按钮点了没反应"）')
  }
}

// ── 4. i18n 字典 ────────────────────────────────────────────────────────────
/** 从 JS 源码里抠出 `const <name> = {…}` 的平衡字面量并求值（比正则可靠）。 */
function extractObjectLiteral(src, declName) {
  const at = src.indexOf(`const ${declName} = `)
  if (at < 0) throw new Error(`找不到 const ${declName} = `)
  let i = src.indexOf('{', at)
  if (i < 0) throw new Error(`${declName} 后面不是对象字面量`)
  const start = i
  let depth = 0
  let quote = ''
  for (; i < src.length; i++) {
    const ch = src[i]
    if (quote) {
      if (ch === '\\') { i++; continue }
      if (ch === quote) quote = ''
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue }
    if (ch === '{' || ch === '[') depth++
    else if (ch === '}' || ch === ']') {
      depth--
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  throw new Error(`${declName} 的对象字面量没有闭合`)
}

for (const { html, logic } of PAGES) {
  const src = sources[logic]
  if (!src) continue
  let dict
  try {
    dict = new Function(`return (${extractObjectLiteral(src, 'I18N')})`)()
  } catch (e) {
    fail(`extension/${logic} 的 I18N 无法解析：${e.message}`)
    continue
  }
  const zhKeys = Object.keys(dict.zh || {})
  const enKeys = Object.keys(dict.en || {})
  if (!zhKeys.length || !enKeys.length) {
    fail(`extension/${logic} 的 I18N 缺少 zh 或 en 分支`)
    continue
  }
  const onlyZh = zhKeys.filter((k) => !enKeys.includes(k))
  const onlyEn = enKeys.filter((k) => !zhKeys.includes(k))
  if (onlyZh.length) fail(`extension/${logic} 的 I18N：en 缺 ${onlyZh.join(', ')}`)
  if (onlyEn.length) fail(`extension/${logic} 的 I18N：zh 缺 ${onlyEn.join(', ')}`)

  const htmlSrc = read(html)
  const used = [...htmlSrc.matchAll(/data-i18n(?:-ph)?="([^"]+)"/g)].map((m) => m[1])
  const missing = [...new Set(used)].filter((k) => !zhKeys.includes(k) || !enKeys.includes(k))
  if (missing.length) {
    fail(`extension/${html} 用了字典里没有的 i18n 键：${missing.join(', ')}` +
      '（页面上会渲染成键名或空串）')
  }
  notes.push(`${logic}: i18n ${zhKeys.length} 键 × 2 语言，HTML 用到 ${new Set(used).size} 个`)
}

// ── 5. shared.js 纯函数行为 ─────────────────────────────────────────────────
let SHARED = null
try {
  const ctx = { self: {} }
  vm.createContext(ctx)
  vm.runInContext(sources['shared.js'] || '', ctx, { filename: 'extension/shared.js' })
  SHARED = ctx.self.MASKIT_SHARED
} catch (e) {
  fail(`shared.js 无法在沙箱里求值：${e.message}`)
}
if (SHARED) {
  const cases = [
    // [域名, 期望的 match pattern] —— localhost / IPv4 / IPv6 只能用 http://
    // （manifest 只预授权 http://，写成 *:// 会被 Chrome 拒绝，动态注册静默失效）
    ['chat.deepseek.com', '*://*.chat.deepseek.com/*'],
    ['127.0.0.1', 'http://127.0.0.1/*'],
    ['localhost', 'http://localhost/*'],
    ['[::1]', 'http://[::1]/*'],
    ['ChatGPT.com', '*://*.chatgpt.com/*'],
    ['', ''],
  ]
  for (const [input, want] of cases) {
    const got = SHARED.siteMatchPattern(input)
    if (got !== want) fail(`siteMatchPattern(${JSON.stringify(input)}) = ${JSON.stringify(got)}，期望 ${JSON.stringify(want)}`)
  }
  // 域名校验：只允许 [a-z0-9.*-]，首尾不允许点
  for (const bad of ['', '  ', 'a b.com', 'http://x.com', '.a.com', 'a.com.', 'a/b']) {
    if (SHARED.normalizeDomain(bad) !== '') fail(`normalizeDomain(${JSON.stringify(bad)}) 应为空串`)
  }
  for (const [good, want] of [['ChatGPT.com', 'chatgpt.com'], ['a.b-c.d', 'a.b-c.d'], ['127.0.0.1', '127.0.0.1']]) {
    if (SHARED.normalizeDomain(good) !== want) fail(`normalizeDomain(${JSON.stringify(good)}) 应为 ${want}`)
  }
  // 站点覆盖：必须支持子域，但不能跨域误match（"notchatgpt.com" 不属于 "chatgpt.com"）
  const sites = ['chatgpt.com', 'claude.ai']
  for (const [host, want] of [['chatgpt.com', 'chatgpt.com'], ['chat.openai.chatgpt.com', 'chatgpt.com'],
    ['notchatgpt.com', ''], ['claude.ai', 'claude.ai'], ['evil.com', '']]) {
    const got = SHARED.siteCovers(host, sites)
    if (got !== want) fail(`siteCovers(${host}) = ${JSON.stringify(got)}，期望 ${JSON.stringify(want)}`)
  }
  // STATIC_SITES 必须与 manifest 的静态注册对得上（否则 popup 说已启用、实际没注入）
  if (manifest) {
    const matched = (manifest.content_scripts || []).flatMap((cs) => cs.matches || [])
    for (const site of SHARED.STATIC_SITES) {
      if (!matched.some((m) => m.includes(site))) {
        fail(`STATIC_SITES 里的 ${site} 没出现在 manifest content_scripts.matches —— 静态注册缺失`)
      }
    }
    for (const m of matched) {
      const dom = m.replace(/^\*?:\/\/(\*\.)?/, '').replace(/\/.*$/, '')
      if (!SHARED.STATIC_SITES.includes(dom)) {
        fail(`manifest content_scripts.matches 里的 ${m} 不在 STATIC_SITES 里 —— 两处清单漂移`)
      }
    }
  }
}

// ── 5b. 推荐站点清单（PRESET_SITES） ────────────────────────────────────────
// 这份清单是**用户唯一会看到**的站点来源（设置页 chip + 一键添加），写坏的后果很直接：
//   - 域名不合法 → normalizeDomain 返回 '' → 点 chip 弹出「域名格式不合法」，永远加不上；
//   - 重复域名 → 一键添加时 `permissions.request` 收到重复 origin，用户看到同一个站两次；
//   - `verified` 与 `unsupportedReason` 不一致 → 未实测的站不打 ⚠，用户以为能脱敏，
//     实际静默裸奔（(B) 类直通，界面上完全看不出来）。
// 这些都是"改的人当场看不出来、用户隔几天才发现"的类型，所以必须静态兜住。
if (SHARED) {
  const presets = SHARED.PRESET_SITES
  if (!Array.isArray(presets) || !presets.length) {
    fail('shared.js 的 PRESET_SITES 缺失或为空 —— 设置页的「推荐站点」会是空的')
  } else {
    const seen = new Set()
    for (const p of presets) {
      const d = p && p.domain
      if (typeof d !== 'string' || !d) { fail(`PRESET_SITES 里有缺 domain 的条目`); continue }
      if (SHARED.normalizeDomain(d) !== d) {
        fail(`PRESET_SITES 域名不合法：${d}（normalizeDomain 归一化后应原样返回，只允许小写字母/数字/.-*）`)
      }
      if (seen.has(d)) fail(`PRESET_SITES 域名重复：${d}（一键添加会重复申请同一个 origin）`)
      seen.add(d)
      if (!p.zh || !p.en) fail(`PRESET_SITES 的 ${d} 缺少 zh/en 名称（设置页 chip 上要显示）`)
      if (p.verified !== true && p.verified !== false) {
        fail(`PRESET_SITES 的 ${d} 的 verified 必须是布尔值（true=路径实测命中，false=未实测）`)
        continue
      }
      const reason = SHARED.unsupportedReason(d, '')
      if (!p.verified && reason !== 'paths') {
        fail(`PRESET_SITES 的 ${d} 标了未实测，但 unsupportedReason 返回 ${JSON.stringify(reason)} —— 不会打 ⚠`)
      }
      if (p.verified && reason) {
        fail(`PRESET_SITES 的 ${d} 标了已实测，unsupportedReason 却返回 ${JSON.stringify(reason)} —— 会误打 ⚠`)
      }
    }
    // 静态注册站点必须在推荐清单里且标 verified：否则它既已在 enabledSites 默认项里，
    // 又会出现在"可添加"的 chip 上，用户点了得到一句「该站点已在列表中」。
    for (const s of SHARED.STATIC_SITES) {
      const hit = presets.find((x) => x.domain === s)
      if (!hit) fail(`STATIC_SITES 的 ${s} 不在 PRESET_SITES 里（设置页会把它显示成"可添加"）`)
      else if (hit.verified !== true) fail(`静态注册站点 ${s} 必须标 verified: true（它已在默认站点里）`)
    }
    notes.push(`shared.js: PRESET_SITES ${presets.length} 个推荐站点（${presets.filter((p) => p.verified).length} 个已实测）`)
  }
}

// ── 6/7/9. 源码红线（逐文件扫描） ───────────────────────────────────────────
// 先把注释剥掉再扫：这几个文件里**到处**是"不要用 storage.sync（那是外传）"、
// "http://127.0.0.1 而不是别的主机"这类说明性文字。拿原文扫必然全是误报，
// 而误报的门禁等于没有门禁——两次之后所有人都学会无视它。
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')      // /* 块注释 */
    .replace(/(^|[^:])\/\/.*$/gm, '$1')    // // 行注释（避开 "http://"）
}
for (const name of JS_FILES) {
  const src = sources[name]
  if (!src) continue
  const code = stripComments(src)
  if (/chrome\.storage\.sync/.test(code)) {
    fail(`extension/${name} 使用了 chrome.storage.sync —— 会把数据同步到账号（外传，红线）`)
  }
  // 只允许 127.0.0.1 / localhost 的字面 URL。模板插值（`http://${d}/*`）与变量拼接
  // 不是字面量，跳过——它们由 §5 的纯函数用例单独管（siteMatchPattern）。
  for (const m of code.matchAll(/https?:\/\/[^\s'"`)]+/g)) {
    const host = (m[0].match(/^https?:\/\/([^/:]+)/) || [])[1] || ''
    if (host.includes('$')) continue
    if (!['127.0.0.1', 'localhost'].includes(host)) {
      fail(`extension/${name} 出现非本机字面 URL：${m[0]}（扩展只允许访问 127.0.0.1 / localhost）`)
    }
  }
}
// 驼峰 runAt：蛇形会让 registerContentScripts 抛错 → 被 catch 收进 failures → 静默失效
const bg = sources['background.js'] || ''
if (/registerContentScripts/.test(bg)) {
  const body = bg.slice(bg.indexOf('async function syncDynamicScripts'))
  if (/\brun_at\s*:/.test(body)) {
    fail('background.js 的 registerContentScripts 用了蛇形 run_at —— 必须用驼峰 runAt，' +
      '否则动态注册 100% 静默失效')
  }
  if (!/\brunAt\s*:/.test(body)) {
    fail('background.js 的 registerContentScripts 里没有 runAt 字段')
  }
}
if (!/importScripts\(\s*['"]shared\.js['"]\s*\)/.test(bg)) {
  fail("background.js 缺少 importScripts('shared.js') —— MASKIT_SHARED 未定义，扩展加载即死")
}
// importScripts 只存在于 Worker 环境（Chromium SW）；Firefox MV3 的 event page 没有
// 这个全局，无条件调用会 ReferenceError 让背景直接死。必须由 manifest 的
// background.scripts 先加载 shared.js，并用 typeof 守卫住这条分支。
const importScriptsAt = bg.indexOf("importScripts('shared.js')")
if (importScriptsAt >= 0) {
  const guard = bg.slice(Math.max(0, importScriptsAt - 200), importScriptsAt)
  if (!/typeof\s+importScripts\s*===?\s*['"]function['"]/.test(guard)) {
    fail('background.js 的 importScripts 必须用 `typeof importScripts === \'function\'` 守卫 —— '
      + 'Firefox MV3 背景是 event page，没有 importScripts 全局，无条件调用直接 ReferenceError')
  }
}
// onMessage 必须按 `sender.url` 的 scheme 判定「扩展自己的页面」，不能用 `!sender.tab`。
// 选项页是**真标签页**，sender.tab 有值（2026-09-16 实测）；用 !sender.tab 判会让 admin
// 分支永远进不去、函数末尾返回 undefined → 端口立刻关闭 → 页面侧恒报
// "The message port closed before a response was received"（选项页测试连接/占用/重注册
// 三处同时失灵，而 SW 侧一切正常，极难定位）。
if (/onMessage/.test(bg) && !/sender\.url[\s\S]{0,120}(?:chrome-extension:|moz-extension:)/.test(bg)) {
  fail('background.js 的 onMessage 没有按 sender.url 判定扩展页面 —— ' +
    '以标签页打开的选项页其 sender.tab 有值，用 !sender.tab 判会让 admin 消息全部超时')
}

// ── restore 请求必须带 content_type ─────────────────────────────────────────
// 这是**静默失败**类字段：漏了不报错，引擎只是退回旧的「整段文本还原」，
// 而被 SSE 事件边界切开的占位符（模型逐 token 输出时 `content:"{{EMAIL"` +
// `content:"_dsszcd}}"`）就永远拼不回来，页面露出裸 `{{...}}`。
// 真机往返才暴露过一次（2026-09-16），所以钉死在门禁里。
// 两处都要检查：MAIN world 的调用点，以及 SW 构造 body 时的白名单。
const mainSrc = sources['bridge-main.js'] || ''
const restoreSites = [...mainSrc.matchAll(/bridge\.call\(\s*'restore'/g)]
if (!restoreSites.length) {
  fail("bridge-main.js 里找不到 bridge.call('restore') 调用点 —— 还原链路缺失")
} else {
  for (const site of restoreSites) {
    if (!/content_type\s*:/.test(mainSrc.slice(site.index, site.index + 400))) {
      fail('bridge-main.js 的 restore 调用没带 content_type —— 引擎会退回整段文本还原，' +
        '被 SSE 事件边界切开的占位符将无法还原（页面露出裸 {{...}}）')
    }
  }
}
if (/async function handleRestore/.test(bg)) {
  const at = bg.indexOf('async function handleRestore')
  if (!/content_type\s*:/.test(bg.slice(at, at + 800))) {
    fail('background.js 的 handleRestore 白名单漏了 content_type —— ' +
      '字段在建 body 时被丢掉，还原退化成整段文本（静默失败）')
  }
}

// ── 结论 ────────────────────────────────────────────────────────────────────
for (const n of notes) console.log(`check-extension:      ${n}`)
if (errors.length) {
  for (const e of errors) console.log(`check-extension: FAIL ${e}`)
  console.log(`check-extension: FAIL（${errors.length} 项）`)
  process.exit(1)
}
console.log('check-extension: OK')
