/* Data Maskit Browser Bridge — 扩展内共享常量与纯函数（**唯一来源**）
 *
 * 为什么单独成文件：这三样东西原先在 background.js / options.js / popup.js 里各抄了一份：
 *   - `STATIC_SITES`（3 份）、`UNSUPPORTED_REASON`（2 份）、
 *   - `normalizeDomain` / `siteMatchPattern`（options 一套、background 一套）。
 * 抄袭的代价不是"多打几个字"，而是**漂移后无声地自相矛盾**：popup 说「已生效」、
 * options 标「路径未适配」；或者 options 用 `*://127.0.0.1/*` 申请权限（Chrome 直接拒绝），
 * 而 background 注册时用 `http://` —— 用户看到"添加成功"但实际不生效。
 * matchPattern 的 IP/localhost 分支就因为这种漂移出过一次缺陷（SPEC v2.7 记录）。
 *
 * 加载方式：
 *   - SW：`background.js` 顶部 `importScripts('shared.js')`（classic service worker）；
 *   - 扩展页面：`<script src="shared.js"></script>` 必须在各自的 logic 脚本**之前**。
 * 两处都把结果挂到 `self.MASKIT_SHARED`，不污染 `window` 命名空间。
 *
 * 本文件必须是**纯常量 + 纯函数**：不碰 chrome.*、不发请求、不读 storage。
 */
'use strict';

(function (root) {
  /** manifest 静态 content_scripts 已覆盖的站点。改动必须与 manifest.json 同步。 */
  const STATIC_SITES = ['chatgpt.com', 'claude.ai'];

  /**
   * 推荐站点：设置页一键添加用。
   *
   * **为什么不直接写进 manifest 做静态注册**：那等于安装时就声明「读取和更改你在以下
   * 十几个站点上的数据」，并且在用户从未访问过的站点上也常驻注入脚本 —— 对一个以
   * 「零外传」为卖点的隐私工具来说，这个默认姿势不成立。改成「预设 + 用户手势授权」：
   * 想用就点一次（一次授权弹窗全部加上），不想用的站点一个字节都不碰。
   *
   * `verified` 的含义（**只有这一个意思，别过度解读**）：
   *   - `true`  = 该站的对话接口路径**实测命中** `bridge-main.js` 的 LLM_PATH_HINTS；
   *   - `false` = **没实测过**，不代表不能用。未命中路径白名单的请求一律原样直通：
   *               不断网，但也不脱敏。所以这里标 false 是「我不知道」，不是「不行」。
   *
   * 域名一律写**顶域**：`*://*.example.com/*` 同时匹配顶域与所有子域（MDN match pattern
   * 规则已核对），所以写 `doubao.com` 就能覆盖 `www.doubao.com`，不必重复列。
   */
  const PRESET_SITES = [
    // ── 已实测（与 STATIC_SITES 一致，改这里必须同步 manifest.json） ──
    { domain: 'chatgpt.com', zh: 'ChatGPT', en: 'ChatGPT', verified: true },
    { domain: 'claude.ai', zh: 'Claude', en: 'Claude', verified: true },
    // ── 海外常见 ──
    { domain: 'gemini.google.com', zh: 'Google Gemini', en: 'Google Gemini', verified: false },
    { domain: 'grok.com', zh: 'Grok（xAI）', en: 'Grok (xAI)', verified: false },
    { domain: 'perplexity.ai', zh: 'Perplexity', en: 'Perplexity', verified: false },
    { domain: 'copilot.microsoft.com', zh: 'Microsoft Copilot', en: 'Microsoft Copilot', verified: false },
    { domain: 'mistral.ai', zh: 'Mistral Le Chat', en: 'Mistral Le Chat', verified: false },
    { domain: 'poe.com', zh: 'Poe', en: 'Poe', verified: false },
    // ── 国内常见 ──
    { domain: 'deepseek.com', zh: 'DeepSeek', en: 'DeepSeek', verified: false },
    { domain: 'doubao.com', zh: '豆包', en: 'Doubao', verified: false },
    { domain: 'tongyi.aliyun.com', zh: '通义千问', en: 'Tongyi Qianwen', verified: false },
    { domain: 'qwen.ai', zh: 'Qwen（国际版）', en: 'Qwen (global)', verified: false },
    { domain: 'kimi.com', zh: 'Kimi', en: 'Kimi', verified: false },
    { domain: 'yuanbao.tencent.com', zh: '腾讯元宝', en: 'Tencent Yuanbao', verified: false },
    { domain: 'chatglm.cn', zh: '智谱清言', en: 'ChatGLM', verified: false },
    // ⚠️ 域必须是「用户实际会停在哪个域」，不是「品牌官网是哪个域」。
    // 实测（2026-09-16 真 Chrome）：yiyan.baidu.com 会 302 到 wenxin.baidu.com，
    // 顶域都换了 —— 按 yiyan 注册 match pattern 完全覆盖不到真实对话页，
    // 用户「添加了文心一言」却一点不生效，且无任何提示。
    { domain: 'wenxin.baidu.com', zh: '文心一言', en: 'ERNIE Bot', verified: false },
    { domain: 'xinghuo.xfyun.cn', zh: '讯飞星火', en: 'iFlytek Spark', verified: false },
    // 小米 MiMo 真实域名实测是 mimo.xiaomi.com（xiaomimimo.com 连接直接被拒）。
    { domain: 'mimo.xiaomi.com', zh: '小米 MiMo', en: 'Xiaomi MiMo', verified: false },
  ];

  /**
   * 不在推荐列表里的**历史/备用域名**：用户手输时也要按「未实测」标注，
   * 否则会与推荐列表里同一服务的另一个域名给出两套判据（SPEC 反复强调的同源问题）。
   */
  const LEGACY_UNVERIFIED = ['chat.deepseek.com', 'kimi.moonshot.cn'];

  const UNVERIFIED_DOMAINS = PRESET_SITES
    .filter((p) => !p.verified)
    .map((p) => p.domain)
    .concat(LEGACY_UNVERIFIED);

  /**
   * 路径规则未实测的站点：允许添加，但必须标注 + 添加前提示。
   * popup 需要它来判断「本页是否生效」，options 需要它来打标签 —— 两处判据必须同源。
   * 由 PRESET_SITES 推导，不再手写，避免两份清单漂移。
   */
  const UNSUPPORTED_REASON = {};
  for (const d of UNVERIFIED_DOMAINS) UNSUPPORTED_REASON[d] = 'paths';

  /**
   * 域名 → Chrome match pattern。
   *
   * **必须是已授权 host 权限的子集**：manifest 对 `127.0.0.1` / `localhost` 只预授权
   * `http://`（SPEC §3.1），所以它们只能用 `http://…/*`；写成 `*://…/*` 会被 Chrome 拒绝
   * （`chrome.permissions.contains` 直接返回 false，动态注册静默失效）。
   * 真实站点走 options 页的手势授权 `*://*.<domain>/*`，申请与注册两边必须同款。
   */
  function siteMatchPattern(domain) {
    const d = String(domain || '').trim().toLowerCase();
    if (!d) return '';
    const local = /^\d{1,3}(\.\d{1,3}){3}$/.test(d) || d.includes(':') || d === 'localhost';
    return local ? `http://${d}/*` : `*://*.${d}/*`;
  }

  /** 域名校验：只允许 `[a-z0-9.*-]`（SPEC §3.5(5)），首尾不允许点。 */
  function normalizeDomain(raw) {
    const d = String(raw || '').trim().toLowerCase();
    if (!d) return '';
    if (!/^[a-z0-9.*-]+$/.test(d)) return '';
    if (d.startsWith('.') || d.endsWith('.')) return '';
    return d;
  }

  /** 本页域名是否被某个已启用站点覆盖（含子域）。 */
  function siteCovers(host, sites) {
    const h = String(host || '').toLowerCase();
    if (!h) return '';
    for (const s of sites || []) {
      const d = String(s || '').toLowerCase();
      if (d && (h === d || h.endsWith('.' + d))) return d;
    }
    return '';
  }

  /**
   * 该域名（或它所属的已启用站点）是否有「路径未实测」标注；无则返回 ''。
   *
   * 除精确命中外还认**子域**：`UNSUPPORTED_REASON` 只列顶域（推荐站点也只写顶域），
   * 而用户可能手输 `chat.deepseek.com`、`www.doubao.com` 这类具体主机 —— 不认子域就会
   * 给出「已适配」的错判，popup 显示「已生效」而实际未脱敏（最危险的一种失败）。
   */
  function unsupportedReason(domain, coveredSite) {
    for (const raw of [domain, coveredSite]) {
      const d = String(raw || '').toLowerCase();
      if (!d) continue;
      if (UNSUPPORTED_REASON[d]) return UNSUPPORTED_REASON[d];
      for (const u of UNVERIFIED_DOMAINS) {
        if (d.endsWith('.' + u)) return 'paths';
      }
    }
    return '';
  }

  root.MASKIT_SHARED = {
    STATIC_SITES, PRESET_SITES, UNSUPPORTED_REASON,
    siteMatchPattern, normalizeDomain, siteCovers, unsupportedReason,
  };
})(typeof self !== 'undefined' ? self : this);
