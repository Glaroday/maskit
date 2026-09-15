# Changelog

本文件记录对用户可见的变更；格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循语义化版本。

## [0.2.12] - 2026-09-15

### 新增 / Added
- 公网 IPv4 内置规则（`IP_PUBLIC`，默认关）：边界断言防版本号/文件名误伤，语义校验排除私网/环回/组播/CGNAT/RFC 段，白名单豁免知名公共 DNS，版本号形态（全个位数、Java 构建号 `1.8.0.202`）放行；已知漏检面见规则说明。
  *Public IPv4 rule (`IP_PUBLIC`, default off): boundary assertions against version-number/file-name false positives, semantic validation excluding private/loopback/multicast/CGNAT/RFC ranges, well-known DNS whitelisted, version shapes (all-single-digit, Java build numbers) exempted.*
- 透传模式占位符尽力还原：停止代理或关闭过滤后，从事件库（48h、非凭据）还原模型回复中的占位符，计数并入 PASS 事件。
  *Best-effort placeholder restoration in passthrough mode from the event store (48h, non-credential); counts attached to PASS events.*
- 客户端配置重构：默认「通用聚合」模板（`/v1` 通配）、端点推荐池；移除预设注入请求头（占位值会顶掉客户端真 key）。
  *Client config revamp: default general-aggregate template (`/v1` wildcard), endpoint suggestions; preset header chips removed.*
- 界面：侧边栏折叠记忆、数据密集页放宽版心、仪表盘百分比封顶展示。
  *UI: sidebar collapse memory, wider data-dense pages, capped percentage display.*

### 修复 / Bug Fixes
- TOKEN 漏检全大写 `BEARER` 头；explicit 模式改域名不生效（现自动重启代理）；占位符预热超容量淘汰方向反转与孤儿泄漏；清空日志后跨进程事件复活与日志页游标停更；升级迁移不再覆盖显式 `stop_mode`。
  *Fixed: uppercase `BEARER` misses; explicit-mode domain changes not taking effect (now auto-restarts); warmup eviction order and orphan leaks; cross-process event resurrection and stale log cursor after clearing; migration no longer overrides explicit `stop_mode`.*
- 透传兜底层硬化：socket 读超时、HEAD/OPTIONS 支持、畸形 chunked 请求 400、413/503 前排空请求体、自启异常挂兜底。
  *Passthrough hardening: socket read timeout, HEAD/OPTIONS support, 400 on malformed chunked bodies, request-body draining before error responses, autostart exception fallback.*
- 前端：侧边栏 tooltip 文案互换、`/v1` 通配 Base URL 缺 `/v1`、日志清空后页码不归位。
  *Frontend: swapped sidebar tooltips, missing `/v1` in wildcard Base URL, stale page number after log clear.*

### 优化 / Changed
- App 退出不再挂明文直连兜底（退出即断连）；手动停止仍按 stop_mode 语义。
  *App exit no longer starts the plaintext fallback; manual stops keep stop_mode semantics.*
- 关闭过滤开关后保留流式效果；FAIL_CLOSED 非白名单非 JSON 阻断尊重过滤开关。
  *Streaming preserved when filtering is off; the FAIL_CLOSED block honors the filter switch.*
- 价格缓存原子写，并真正实现定期刷新（原「7 天自动刷新」未实现）。
  *Atomic price-cache writes plus a real periodic refresh loop.*
- 引擎自愈收紧：重启 CAS 互斥防双引擎；孤儿清理加进程身份校验，绝不误杀无关进程。
  *Tighter self-healing: CAS restart mutex; identity-checked orphan cleanup that never kills foreign processes.*

## [0.2.11] - 2026-09-14

### 修复 / Bug Fixes
- 修复**仪表盘统计卡片大数字溢出边框**：百万级以上数字按中英体系自适应进位（中文万/亿、英文 M/B），完整千分位通过悬浮提示展示；分享卡主数字按位数动态缩小字号；模型排行 Token 用量改紧凑进位；前缀保真度卡展示改为「上下文缓存友好度」文案并新增逐项悬浮说明，平均首个差异字节改用 KB/MB 自适应单位。同步把面板自动打开的地址带上 `#token=`，免去每次手动输入访问令牌。
  *Fixed dashboard stat cards overflowing their borders with large numbers: values beyond the compact threshold now scale adaptively per unit system (CJK 万/亿, Latin M/B) with the full thousands-separated figure available as a hover tooltip; the share card scales its headline font down by digit count; model rankings use compact token formatting; the prefix-fidelity card is retitled "Context Cache Health" with per-metric hover explanations, and the average first-diff byte now renders in adaptive KB/MB units. The auto-opened panel URL also carries `#token=` so the access token no longer has to be typed by hand.*

## [0.2.10] - 2026-09-13

### 新增 / Added
- 新增**控制台词条一键穿透日志与全链路详情看板**：首页「今日脱敏词明细」与「今日还原明细」支持直接点击任一词条，自动携带参数跳转至「拦截审计日志」并开启全局搜索；日志列表直观展示每条记录命中的敏感词标签（如 `PHONE`、`CONNSTR` 等）；日志详情弹窗新增出站脱敏（用户请求）与入站还原（模型响应）链路节点全景看板，对照卡片强化原文与占位符直观对比，彻底解决“不知道脱敏了什么、还原了什么”的困惑。
  *Added one-click word-to-log navigation and full-link audit detail dialog: Top masked and restored items on the Dashboard can now be clicked directly to navigate to the Interception Logs page with pre-filled search filters; log table rows prominently display matched sensitive tags (`PHONE`, `CONNSTR`, etc.); the log detail modal now features a visual pipeline stage banner (Outbound Masking vs. Inbound Restoring) with side-by-side comparison cards, making it immediately clear what was intercepted and what was restored.*
- 新增**请求前缀诊断字段**（均不含原文）：MASK 事件新增 `body_rewritten`（本次是否回写了请求体）、`first_diff_byte`（回写后与客户端原始字节的首个差异位置；二分查找实现，超过 1 MB 记 -1，不参与任何脱敏决策）、`suffix_reused`（命中的占位符是否沿用了复用表里的旧 token）。此前用户报「接入后上游缓存命中率归零」时，无法区分是网关改了字节还是上游自己 miss，只能靠猜。有了这三项，一次日志就能定位；它们同时也是判断「要不要做字节级精确替换」的唯一实测依据 —— 实测一条带空格 + `\u` 转义的请求，首个差异位落在 byte 9（`{"model": ` 的空格），而真正的敏感值在 byte 74，中间 65 字节的前缀被凭空改动。
  *Added request-prefix diagnostics (no plaintext involved) to MASK events: `body_rewritten` (whether the body was written back at all), `first_diff_byte` (the first position that differs from the client's original bytes, found by binary search, reported as -1 above 1 MB, and never used in any masking decision) and `suffix_reused` (whether the matched placeholder reused an existing token from the reuse table). Previously, when someone reported "upstream cache hit rate dropped to zero after installing", there was no way to tell whether the gateway had changed the bytes or upstream had simply missed — only guesswork. These three fields answer it from a single log line, and they are also the only measured basis for deciding whether byte-level exact replacement is worth building: on a measured request with spaces and `\u` escapes, the first differing byte was byte 9 (the space in `{"model": `) while the actual sensitive value sat at byte 74, meaning 65 bytes of prefix had been altered for no reason.*
- 新增 `scripts/purge-daily-words.py`：按标签定向清理事件库 `daily_words` 词级明细的运维工具，用于一次性清掉历史规则误报累积的 `<CONNSTR>` 垃圾词条（面板的「清空日志」会删掉**全部日期**的词明细，且会把 `events` 一起清掉，太钝）。**默认只演练（只读）**，`--yes` 才写库；写库前检查 `shield.pid` 确认引擎未在运行（`--force` 可跳过，不推荐），并把库整份备份为 `<库名>.bak-purge-<时间戳>`。刻意**不碰** `daily_stats` / `daily_status` / `daily_tokens`（遵循「清日志不清统计」口径）与 `events`（清明细请用面板），脚本会把由此产生的「词明细合计 ≠ 脱敏总数」差额明确打出来。支持 `--day all` 清理全部保留期、`--db` 指定库文件。
  *Added `scripts/purge-daily-words.py`, an operations tool that removes `daily_words` entries for a given label — used to clear the `<CONNSTR>` junk accumulated by earlier false positives in one go (the panel's "clear logs" wipes the word detail for **every** date and takes `events` with it, which is far too blunt). It **defaults to a read-only dry run**; only `--yes` writes. Before writing it checks `shield.pid` to confirm the engine is not running (`--force` overrides, not recommended) and backs the whole store up to `<db>.bak-purge-<timestamp>`. It deliberately leaves `daily_stats` / `daily_status` / `daily_tokens` alone (honouring "clearing logs does not clear statistics") as well as `events` (use the panel to clear details), and prints the resulting gap between the word-detail total and the masked-event total so the difference is not mistaken for a no-op. `--day all` covers the whole retention window and `--db` points at a specific store.*
- 新增**仪表盘「前缀保真度」卡**：把上一条新增的三个前缀诊断字段接成可视化统计 —— 零改写透传率（请求体一个字节都没被改动的比例，主指标）、占位符复用率、平均首个差异字节。第一列按「样本数 / 总数」标注，第二、三列分母是**改写次数**（`suffix_reused` 与 `first_diff_byte` 都只在回写分支才有意义——零改写透传的请求没签发占位符、也没有差异位），既避免把「只有一个样本的均值」读成全量结论，也避免把「100 次请求 10 次命中、8 次复用」稀释成 8%；数据随「今日 / 近7天 / 近30天」切换，没有任何样本时显示「暂无数据」而不是一排 0，并进一步区分「本区间压根没请求」与「有请求但都早于该项统计上线」——后者正是升级当天的形态，不能显示成「脱敏没生效」。数据由事件库新增的日摘要表 `daily_prefix` 增量维护，只收带诊断字段的 MASK 事件，随「统计永久保存」策略保留、不随保留期裁剪。
  *Added a "Prefix Fidelity" dashboard card that visualises the three request-prefix diagnostics from the entry above: the byte-identical pass-through rate (the share of request bodies forwarded without a single byte changed, shown as the headline figure), the placeholder reuse rate and the average first-diff byte. The first column is annotated "samples / total"; the second and third use **rewrites** as their denominator, because both placeholder reuse and the first-diff byte are only meaningful when the body was actually rewritten (a byte-identical request issues no placeholder and has no diff position) — this keeps an average over a single sample from being read as a whole-range conclusion, and stops "10 hits and 8 reuses across 100 requests" from being diluted to 8%. The figures follow the Today / 7-day / 30-day selector, and with no samples the card reads "no data" rather than a row of zeros, further distinguishing "no requests in range" from "requests exist but predate this metric" — the latter is exactly what an upgrade day looks like and must not read as "masking is not working". The numbers come from a new `daily_prefix` daily summary table maintained incrementally by the event writer (masked events carrying the diagnostics only) and kept under the "statistics are retained forever" policy, never trimmed by the retention window.*

### 修复 / Bug Fixes
- 修复 **CONNSTR 规则把工具文档当成真实凭据脱敏**：AI 编码助手每轮都会把内置网络工具的参数说明（`proxy: http://user:pass@host:port or socks5://host:port`）注入提示词，旧规则只要看到 `://…:密码@` 就签发占位符，单日累计 800+ 次、长期霸占面板「今日脱敏词明细」第一名，把真实泄漏挤到后面。新增 `_connstr_ok` 形态校验，只豁免「一眼是文档/代码模板」的连接串——非数字端口且用户名或密码是占位形态、密码整体是锚定模板（`{password}` / `$PORT` / `%PWD%`）、占位主机且密码是占位词、经典 `user:pass` 对——真实内网/生产连接串照常脱敏与流式还原。
  *Fixed the `CONNSTR` rule masking tool documentation as if it were a real credential. Coding agents inject their built-in network tool docs (`proxy: http://user:pass@host:port or socks5://host:port`) into every prompt, and the old rule issued a placeholder for any `://…:password@` it saw — 800+ hits a day, permanently topping the panel's daily masked-word list and pushing real leaks down. A new `_connstr_ok` shape check exempts only strings that are unmistakably documentation templates: a non-numeric port combined with a placeholder-shaped user or password; an anchored template password (`{password}` / `$PORT` / `%PWD%`); a dummy host combined with a placeholder password; or the classic `user:pass` pair. Real intranet and production connection strings are still masked and restored as before.*
- 修复**豁免规则放走真实口令的五种形态**（同批复审）：① 模板判据从「密码含 `$ % { [ <` 字符类」改为锚定整体形态，否则 `mysql://root:p%40ssw0rd@…` 全明文上行；② 占位主机必须与占位密码同时成立，否则 `admin:S3cret99@host:5432` 被放行；③ IPv6 字面量整体解析 `[::1]:5432`，否则端口被读成 `::1` 而误豁免；④ 豁免必须让下游规则避让——CONNSTR 让路后 EMAIL 会把「口令尾@host」当邮箱吃掉，输出 `postgres://app:Xk9${{EMAIL_x}}:5432/prod`，看着有占位符、实际口令前半截明文；⑤ EMAIL 规则本地部分以下划线开头（`_svc@corp.com`）此前整段不匹配。
  *Fixed five ways the exemption could let a real password through (same review pass): (1) the template test is now anchored to the whole value instead of a `$ % { [ <` character class, which used to exempt `mysql://root:p%40ssw0rd@…` in full plaintext; (2) a dummy host now requires a placeholder password too, so `admin:S3cret99@host:5432` is no longer passed through; (3) IPv6 literals are parsed as a whole (`[::1]:5432`), since splitting on the first colon read the port as `::1` and wrongly exempted it; (4) an exemption must now shield its span from later rules — with `CONNSTR` stepping aside, `EMAIL` swallowed the password tail plus host and emitted `postgres://app:Xk9${{EMAIL_x}}:5432/prod`, which looks masked while the first half of the password travels in plaintext; (5) `EMAIL` no longer skips local parts starting with an underscore (`_svc@corp.com`).*
- 修复**豁免判据把占位主机当成「密码是假的」的佐证，导致真实口令明文上行**（提交前复审）：规则 1 的条件是「非数字端口 **且** 用户名/密码/主机至少一项是占位形态」，而主机像模板与端口像模板是**同一类信号** —— 拿它去证「密码是假的」属于循环论证。于是任何「非数字端口 + 占位主机名」的连接串被整体豁免，密码原样出网：实测 `postgres://admin:S3cret99@{host|hostname|myhost|server|myserver|example.com|test.com|sample.com|your-host|yourdomain.com|db.example|db.invalid}:port/db` **12/12 全部漏检**（改动前 `://user:pass@` 一律脱敏，属本批新引入的漏检面，非存量）。现收紧为佐证只能是**用户名或密码**是占位词；主机只在第 3 档与占位密码**同时**成立时才作数。回归验证：12 个占位主机名漏检 0、7 个文档模板误伤 0、8 条真实口令（含 `Xk9$mQ2p`、`p%40ssw0rd`、`[::1]:5432`）漏检 0；代价是「非占位用户名 + 非占位密码 + 模板端口」这类混合串由豁免转为脱敏（fail-closed 方向）。
  *Fixed the exemption test treating a placeholder host as evidence that the password is fake, which let real passwords travel in plaintext (pre-commit review). Rule 1 read "non-numeric port **and** at least one of user/password/host is placeholder-shaped" — but a template-shaped host is the *same class of signal* as a template-shaped port, so using it to prove "the password is fake" is circular. Any connection string with a non-numeric port plus a placeholder hostname was therefore exempted wholesale with the password in the clear: measured on `postgres://admin:S3cret99@{host|hostname|myhost|server|myserver|example.com|test.com|sample.com|your-host|yourdomain.com|db.example|db.invalid}:port/db`, all 12 leaked (before this batch `://user:pass@` was always masked, so this gap was newly introduced, not pre-existing). The evidence is now restricted to a placeholder-shaped **user or password**; a host only counts in rule 3 where it must hold together with a placeholder password. Regression results: 0 of 12 placeholder hosts leak, 0 of 7 documentation templates are harmed, 0 of 8 real passwords (including `Xk9$mQ2p`, `p%40ssw0rd`, `[::1]:5432`) are missed; the cost is that mixed strings with a real-looking user, a real-looking password and a template port move from exempt to masked — the fail-closed direction.*
- 修复**统计页凭据预览被二次打码成畸形串**：凭据类落库的已经是安全预览（`<CONNSTR 4 位>`、`<PEM 私钥 1024 字节>`、`sk-…3456`），前端再打一遍会显示成 `<CO******* 位>`。现按调用方传入的凭据标志直接展示；判据不再看字符串形状，避免非凭据敏感词（如自定义的 `<内部系统>`）在「显示明文」关闭时被原样展示。
  *Fixed credential previews being masked a second time in the stats UI into malformed strings: credentials are already stored as safe previews (`<CONNSTR 4 位>`, `<PEM 私钥 1024 字节>`, `sk-…3456`), and re-masking them produced `<CO******* 位>`. The preview is now shown as-is based on the credential flag passed by the caller; the check no longer keys off string shape, so a non-credential sensitive word such as a custom `<内部系统>` is not displayed verbatim while "show plaintext" is off.*
- 修复**请求体被无差别重序列化，导致上游 Prompt Cache 整段失效**：`request()` 原先无条件用 `json.dumps(body, ensure_ascii=False)` 回写请求体。`json.dumps` 的默认分隔符是 `(", ", ": ")`，会在每个逗号与冒号后补一个空格；`ensure_ascii=False` 又会把客户端的 `\u5f20\u4e09` 展开成「张三」。于是**哪怕一个敏感词都没命中**，上游收到的字节也与客户端发出的不同（实测紧凑体 113 字节被改写成 123 字节）——而按前缀命中的 Prompt Cache 只要前缀一变就整段 miss，多轮长会话每轮都重新计费。现由 `_mask_hit` 记录「本次是否真的替换过」：一个敏感词都没命中就**一个字都不动** `flow.request.content`；确实需要回写时改用紧凑分隔符 `(",", ":")`，并按客户端已表现出的转义策略选择 `ensure_ascii`，尽量让前缀字节保持一致。
  *Fixed request bodies being re-serialised unconditionally, which invalidated the upstream prompt cache entirely. `request()` used to write the body back with an unconditional `json.dumps(body, ensure_ascii=False)`. `json.dumps` defaults to the `(", ", ": ")` separators, inserting a space after every comma and colon, while `ensure_ascii=False` expanded the client's `\u5f20\u4e09` into literal characters. So even when not a single sensitive word matched, the upstream received different bytes from the client (a 113-byte compact body measured at 123 bytes after rewriting) — and a prefix-based prompt cache misses completely once the prefix changes, re-billing every turn of a long conversation. `_mask_hit` now records whether anything was actually replaced: with no match, `flow.request.content` is left completely untouched; when a rewrite is genuinely required it uses the compact `(",", ":")` separators and follows the escaping mode the client has already demonstrated, keeping as much of the prefix byte-identical as possible.*
- 修复 **Anthropic `cache_control` 被自定义词表误伤、缓存指令静默失效**：`cache_control` 一直被列在 `_MASK_ALWAYS_SKIP` 里，但该集合只在递归的**字符串分支**生效，而 `cache_control` 恒为对象 `{"type": "ephemeral"}` —— 判定被整个绕过，`"ephemeral"` 照常送进脱敏管线。默认词表不命中这个英文词，所以线上一直无感；一旦自定义词表里出现同形词，指令会被写成 `{"type": "{{TERM_xxxxxx}}"}`，上游判其非法。现按语义拆成 `_MASK_SKIP_SCALAR_KEYS`（仅字符串叶子）与 `_MASK_SKIP_SUBTREE_KEYS`（整棵子树跳过），只把结构固定、无业务载荷的 `cache_control` 放进后者。`response_format` / `format` 虽是同类 dict 值键但**故意不收** —— OpenAI 的 `json_schema` 与 Ollama 的 `format` 都可以是一整份 JSON Schema，其 `enum` 可能承载真实业务取值，整棵跳过等于新增一条漏检路径而收益为零；该决定由一条反向锁用例守住。
  *Fixed Anthropic `cache_control` being mangled by custom word lists, which silently invalidated cache directives. `cache_control` had always been listed in `_MASK_ALWAYS_SKIP`, but that set is only consulted in the recursion's string branch while `cache_control` is always an object (`{"type": "ephemeral"}`) — so the check was bypassed entirely and `"ephemeral"` went straight through the masking pipeline. The default word list never matches that English word, which is why it went unnoticed; as soon as a custom list contains a similarly shaped word the directive is rewritten to `{"type": "{{TERM_xxxxxx}}"}` and rejected upstream. The set is now split by semantics into `_MASK_SKIP_SCALAR_KEYS` (string leaves only) and `_MASK_SKIP_SUBTREE_KEYS` (whole subtrees skipped), with only the structurally fixed, payload-free `cache_control` in the latter. `response_format` and `format` are dict-valued keys of the same kind but are deliberately excluded: OpenAI's `json_schema` and Ollama's `format` can each be an entire JSON Schema whose `enum` may carry real business values, so skipping them wholesale would open a new detection gap for zero benefit. A reverse-lock test guards that decision.*
- 修复**命中敏感词时前缀被整段改写、上游缓存照样 miss**：新增字节级精确替换 —— 只把被脱敏的那个字符串字面量就地换掉，客户端 body 的排版（冒号后空格、缩进、数字写法、`\u` 转义风格）原样保留。此前命中后要整棵 `json.dumps` 重序列化，排版被一并抹掉，与客户端原始字节的首个差异位从「真正的敏感值」前移到 body 开头附近，上游按前缀做的 Prompt Cache 从差异位起整段 miss。实测五种客户端排版（紧凑 / 带空格 / 缩进 / 原字符 / `\u` 转义），首个差异位现在**全部正好落在被脱敏的值上**，此前分别是 byte 1~9。正确性由 `json.loads(结果) == 脱敏后的树` 等价校验兜底：一旦多替换了一处（命中键名、命中有意跳过的字段、把历史占位符切碎）就整条退回重序列化 —— 而退回的是**同一棵已脱敏的树**，因此这条路径在任何情况下都不会放行原文。超过 8 MB 的请求体不做替换、直接走原路径（首版定 1 MB 时判断「省下的前缀对齐收益抵不过 CPU 开销」，实测不成立，见下方优化条目）。另有一条**独立的退回线**：单次请求里被脱敏的唯一原文超过上限时同样退回重序列化（每个原文按两种合法 JSON 写法各建一条匹配分支，因此 64 个原文 ≈ 128 个分支）。发版复审时在 8 MB body 上复测了档位 —— splice 生效与退路 `json.dumps` 耗时**同价**（32 分支 21ms / 128 分支 23ms / 256 分支 27ms vs 22ms），退回并不省时间、只是白白丢掉前缀保真，于是把上限从 64 提到 **128**（覆盖单请求 64 个不同敏感值，日常长会话不再踩线），并补用例锁住「80 分支必须仍走 splice」；同时验证了 splice 生效/退回两条路径的还原结果完全一致 —— 上限只影响写回方式，不影响脱敏与还原（还原只看占位符→rev 映射）。`MASKIT_BYTE_SPLICE=0` 可一键关闭整条替换路径。
  *Fixed the request prefix being rewritten wholesale whenever a sensitive word was hit — which still made upstream miss. A new byte-level replacement swaps only the affected string literal in place, leaving the client's body layout (spaces after colons, indentation, number formatting, `\u` escaping style) untouched. Previously a hit triggered a whole-tree `json.dumps` re-serialisation that erased the layout and moved the first differing byte from the actual sensitive value up to near the start of the body; a prefix-based upstream prompt cache misses completely from that point on. Measured across five client layouts (compact, spaced, indented, literal characters, `\u` escapes), the first differing byte now lands exactly on the masked value in every case; it used to be byte 1-9. Correctness is guaranteed by an equivalence check (`json.loads(result) == masked tree`): if the replacement touched one position too many — a key name, a deliberately skipped field, an existing placeholder — the whole request falls back to re-serialisation, and since that fallback re-serialises the very same masked tree, this path can never let plaintext through. Bodies over 8 MB skip the replacement entirely (the first release capped this at 1 MB on the assumption that the prefix alignment saved was not worth the CPU; measurement disproved that — see the improvements entry below). There is a **second, independent fallback line**: a request whose masked text contains more distinct originals than the cap also falls back to re-serialisation, because each original contributes two alternation branches (literal and `\uXXXX` forms), so 64 originals mean roughly 128 branches. During the pre-release review the limits were re-benchmarked on an 8 MB body — splice costs the same as the `json.dumps` fallback (21ms at 32 branches, 23ms at 128, 27ms at 256, versus 22ms for dumps), so falling back saved no time and simply threw away prefix fidelity; the cap therefore went from 64 up to **128** (covering 64 distinct sensitive values per request, so everyday long conversations no longer trip it), with a new test locking "80 branches must still splice". Restore was verified identical on both the spliced and the fallback paths — the cap only affects how the body is written back, never masking or restoring (restore reads only the placeholder→rev map). `MASKIT_BYTE_SPLICE=0` turns the whole replacement path off.*

- 修复**「EMAIL 避让」误放过紧跟豁免连接串的真实邮箱**（提交前复审，2026-09-13）：连接串被判为文档模板而豁免后，本应只让 EMAIL 避开**与豁免区间重叠**的「口令尾@host」命中，实现却判成了「紧接在被豁免连接串之后」——而真正要防的口令尾起点在 `@` **之前**（前一个字符是 `:`，前置短路直接放行，等于这道判断从没挡住过它）。副作用是：连接串的主机名本身是邮箱时（`redis://default:{password}@zhang.san@example.com:6379`），那个**真实邮箱被整段跳过、明文上行**。现改为按区间判「重叠」而非「紧接其后」，并补上双向用例——此前把该函数整体改成 `return False`，660 个用例依然全过，说明它**一条用例都没有**。
  *Fixed the "EMAIL avoidance" check letting a real email through when it followed an exempted connection string (pre-commit review, 2026-09-13). Once a connection string is judged a documentation template and exempted, only EMAIL matches that **overlap** the exempted span (the "password-tail@host" shape) should be skipped; the implementation instead tested "immediately follows the exempted connection string" — yet the password tail it was meant to protect starts *before* the `@` (the preceding character is `:`), so the early-out returned false and the check never actually guarded anything. The side effect: when the connection string's hostname is itself an email (`redis://default:{password}@zhang.san@example.com:6379`), that **real email was skipped entirely and sent in plaintext**. The check now tests interval overlap instead of adjacency, with tests locking both directions — replacing the function body with a plain `return False` used to leave all 660 tests green, meaning it had **no test coverage at all**.*

### 优化 / Improved
- 优化**字节级替换的体积上限从 1 MB 放宽到 8 MB**（长会话是前缀缓存收益最大的场景，却恰好被 1 MB 挡在门外）：首版定 1 MB 的理由是「省下的前缀对齐收益抵不过 CPU 开销」，实测不成立 —— 完整路径（替换 + 调用方的 `json.loads` 等价校验）对退路 `json.dumps` 的耗时比，1 MB 为 1.34x、8 MB 为 1.17x，最坏只多 4 ms。诊断字段 `first_diff_byte` 的 1 MB 上限**刻意不跟着放宽**：它是每次回写都要算的纯诊断值，耗时随差异位置后移暴涨（1 MB 最末 14.5 ms、8 MB 达 173 ms），跟着放宽会把热路径拖慢一个数量级。两个上限互不联动由一条用例锁住。
  *Raised the byte-level replacement size cap from 1 MB to 8 MB — long conversations are where the prefix cache pays off most, and 1 MB excluded exactly those. The original 1 MB was justified as "the prefix alignment saved is not worth the CPU", which measurement disproved: over the full path (the replacement plus the caller's `json.loads` equivalence check) the cost relative to the `json.dumps` fallback is 1.34x at 1 MB and 1.17x at 8 MB, at most 4 ms worse. The 1 MB cap on the `first_diff_byte` diagnostic is deliberately **not** relaxed with it: that value is pure diagnostics recomputed on every write-back, and its cost grows sharply as the diff position moves later (14.5 ms at 1 MB versus 173 ms at 8 MB), so relaxing it would slow the hot path by an order of magnitude. A test locks the two caps so they cannot be silently coupled later.*

## [0.2.9] - 2026-09-12

### 新增 / Added
- 新增**控制面增量配置端点** `POST /api/config/patch`：以 `set` / `merge` / `map_del` / `list_add` / `list_remove` / `list_upsert` / `list_del` 七种操作做「只改指定路径」的写入。此前设置页每次保存都要提交整份 `config.json` 快照，两个标签页或「设置页 + 审计页」并发保存时，后到的陈旧快照会把先到的改动整片覆盖（容器型字段只能整份提交）。前端全部容器型调用点已改为增量下发。
  *Added an incremental control-plane config endpoint (`POST /api/config/patch`) with seven operations (`set` / `merge` / `map_del` / `list_add` / `list_remove` / `list_upsert` / `list_del`) that touch only the named path. Previously every save from the settings UI posted a whole `config.json` snapshot, so two concurrent saves (two tabs, or the settings and audit pages) let a stale snapshot silently wipe the other's edits — container-typed fields could only be written as a whole. All container-typed call sites in the frontend now send incremental patches.*
- 新增 **NDJSON 流式还原**（Ollama `/api/chat`、`/api/generate` 等换行分隔 JSON）：整包与逐行增量都能还原，半截占位符按行扣留、跨 TCP 块拼接，收尾补发。此前这类响应完全不被识别，占位符原样留在模型回复里。
  *Added NDJSON streaming restoration (Ollama `/api/chat`, `/api/generate` and other newline-delimited JSON). Both whole-body and line-by-line deltas are restored, half-placeholders are held back per line and stitched across TCP chunks, with a final flush. Previously these responses were not recognised at all and placeholders stayed in the model output verbatim.*
- 新增 `scripts/verify-all.py`：本地与 CI **共用的唯一门禁清单**（13 项，按 `python` / `frontend` / `rust` / `version` 分组）。`build.ps1` 改为直接调用它，`scripts/check-workflows.py` 增加与 `ci.yml` 的**双向漂移比对**，任一侧漏加/多加都会在 PR 阶段报错。此前门禁散在两处，本地「过了 `build.ps1` 却被 CI 拦下」时 tag 已经推走了。
  *Added `scripts/verify-all.py`, the single gate manifest shared by local runs and CI (13 checks grouped as `python` / `frontend` / `rust` / `version`). `build.ps1` now calls it directly, and `scripts/check-workflows.py` cross-checks it against `ci.yml` in both directions so a missing or extra gate fails during the PR. The gate list used to live in two places, which meant a local run could pass `build.ps1` and still be blocked by CI — after the tag had already been pushed.*
- 新增 `rust-macos` CI job（`macos-latest` 编译 + 单测）。`lib.rs` 里有二十多处 `#[cfg(target_os = "macos")]` 分支，此前只有 Windows 会编译，macOS 分支的编译错误要等打 tag 走发版工作流才暴露。
  *Added a `rust-macos` CI job (compile + unit tests on `macos-latest`). `lib.rs` carries 20+ `#[cfg(target_os = "macos")]` branches that only Windows used to compile, so macOS-only compile errors surfaced only when a tag triggered the release workflow.*
- 新增 **.env 导入跳过原因全面中英双语国际化**：解析器在输出中文原因文本的同时输出 `reasonKey` 与 `reasonArgs`，前端 `EnvImportDialog` 根据当前语言自动呈现地道翻译，彻底消除英文界面下跳过原因硬编码中文的问题，并通过 `scripts/check-env-import.mjs` 全量边界回归保障。
  *Added full bilingual internationalisation for .env import skip reasons: the parser now outputs `reasonKey` and `reasonArgs` alongside the fallback reason text, and `EnvImportDialog` automatically renders native translations based on current language, eliminating hardcoded Chinese skip reasons in the English UI with full test coverage in `scripts/check-env-import.mjs`.*

### 修复 / Bug Fixes
- 修复**引擎崩溃后自愈能力永久静默失效**：watchdog 的限频分支只 `continue`，而那一刻 child 引用已被清空，下一轮既看不到「进程退出」也看不到「假死」，于是「1 分钟后重试」变成永不重试，唯一恢复途径是用户手动点「重启引擎」。现改为把待重试时刻排进队列，倒计时结束即重拉，错误文案里的秒数是真实倒计时。
  *Fixed silent, permanent loss of crash self-healing. The watchdog's rate-limit branch only did `continue`, but by then the child handle had already been cleared, so the next iteration saw neither "process exited" nor "hung" — turning "retry in one minute" into "never retry", with the only recovery being a manual "restart engine". The retry time is now queued and honoured, and the countdown in the error message is real.*
- 修复**凭据原文经模型复述后落库**：会话里已识别的凭据若被模型原样复述回来，还原阶段会把它重新写进事件库明细。现对还原后的文本再做一次凭据清洗（长度阈值 + 已知凭据集合），凭据类明细恒只存打码 preview 与 sha256 摘要。
  *Fixed credential plaintext landing in the event store when the model echoes it back. A credential already masked in the session, if repeated verbatim by the model, was written back into the log detail during restoration. Restored text is now scrubbed again (length threshold plus known-credential set), so credential details only ever store a redacted preview and a sha256 digest.*
- 修复**凭据标签集在 5 处各写一份**、新增或改名时漏改某处会导致凭据分类失效：收敛为单一定义源 `engine/credential_labels.py` 与 `frontend/src/lib/credential-labels.ts`，并加跨端一致性用例。同步修正 `event_store` 的凭据判定口径。
  *Fixed the credential label set being duplicated in five places, where adding or renaming one would silently break credential classification. It now has a single source of truth (`engine/credential_labels.py` and `frontend/src/lib/credential-labels.ts`) guarded by cross-language consistency tests, and the `event_store` credential predicate was aligned.*
- 修复**统计历史的小时分桶恒等于事件时间戳**：SQLite 的 `/` 对整数做浮点除法，`(ts/3600)*3600` 并不取整，于是 `GROUP BY` 退化成每个事件一个桶。现改为 `CAST(ts / 3600 AS INTEGER) * 3600`（两处），并补小时路径用例（此前该分支零引用，所以漏网）。
  *Fixed hourly bucketing in the stats history being a no-op. SQLite's `/` performs floating-point division on integers, so `(ts/3600)*3600` did not truncate and `GROUP BY` degenerated to one bucket per event. Now uses `CAST(ts / 3600 AS INTEGER) * 3600` in both places, with tests for the hourly path (previously unreferenced, which is how it slipped through).*
- 修复 **SSE 负载不是 JSON 对象时的异常路径**，并修复 `CONNSTR` 正则 `[a-z][a-z0-9+.-]*://` 在长标识符文本上的超线性回溯：量词封顶 `{0,63}`（32KB 语料 1345ms → 7.4ms）。同时修好了对抗语料本身的假阴性——原语料只有 2 个词起始位置，形不成「N 起点 × O(N) 回溯」的乘积，倍率恒为 2.00，从不告警。
  *Fixed the exception path for non-object SSE payloads, and the super-linear backtracking of the `CONNSTR` pattern `[a-z][a-z0-9+.-]*://` on long identifier text by capping the quantifier to `{0,63}` (32KB input: 1345ms → 7.4ms). The adversarial corpus itself had a false negative — it contained only two word-start positions, so it could not produce the "N starts × O(N) backtracking" product and always reported a 2.00× ratio, never warning.*
- 修复**事件库损坏后面板永久 500**：`DatabaseError`（真损坏）现在把坏文件挪成 `event-store.sqlite3.corrupt-<时间戳>` 并重建空库（**绝不删除**原文件）；`OperationalError`（锁竞争、路径不可写）保持原样抛出，不碰用户文件。同时读路径不再每次查询都跑十几条 `CREATE TABLE/INDEX IF NOT EXISTS`（按路径记忆，换路径才重建），并修掉 `_connect()` 在 PRAGMA 失败时泄漏连接的问题。
  *Fixed the panel returning 500 forever after event-store corruption. A `DatabaseError` (genuine corruption) now moves the file aside as `event-store.sqlite3.corrupt-<timestamp>` and recreates an empty store — the original is never deleted — while an `OperationalError` (lock contention, unwritable path) still propagates without touching user files. Read paths no longer re-run a dozen `CREATE TABLE/INDEX IF NOT EXISTS` per query (the schema is now remembered per path and rebuilt only when the path changes), and `_connect()` no longer leaks a connection when a PRAGMA fails.*
- 修复**日志列表按类型过滤时的全量排序**：补 `(type, id)` 复合索引。查询形态是 `WHERE id > ? AND type = ? ORDER BY id LIMIT n`（按 id 游标增量取某一类型），只有 `(type, ts)` 时会退化成「扫完整个类型段 → 临时排序树」；100 万行实测首屏 292ms → 6ms、增量 40ms → 5ms。`(type, ts)` 保留给按时间范围的聚合查询。
  *Fixed full sorting when filtering the log list by type by adding a `(type, id)` composite index. The query shape is `WHERE id > ? AND type = ? ORDER BY id LIMIT n` (cursor-by-id, single type), which degraded to "scan the whole type range then build a temp sort tree" with only `(type, ts)` present; measured on 1M rows, first load went 292ms → 6ms and incremental polling 40ms → 5ms. `(type, ts)` is kept for time-range aggregations.*
- 修复**桌面壳「假就绪」**：就绪判定从「5801 TCP 可连」改为请求免令牌的 `/healthz`。端口被无关进程占用、或 Flask 已 listen 但工作线程死锁时，TCP 握手照样成功，于是壳把状态置为就绪、托盘显示「引擎已就绪」，而前端所有请求超时。watchdog 的假死判定同样改用 `/healthz`（Flask 死锁时端口照常握手，只探 TCP 永远看不到假死）。
  *Fixed false-ready states in the desktop shell: readiness now probes the token-free `/healthz` instead of just opening a TCP connection to 5801. When the port is held by an unrelated process, or Flask is listening but its worker threads are deadlocked, the TCP handshake still succeeds — so the shell marked itself ready and the tray said "engine ready" while every request timed out. The watchdog's hang detection uses `/healthz` too, since a deadlocked Flask still completes TCP handshakes.*
- 修复**手动重启引擎阻塞界面**：`restart_engine` 改为后台线程执行并立即返回（此前同步执行，含最长 3s 等待收尾 + 20s 就绪轮询，IPC 线程被占满，前端 await 期间表现为「点了没反应」）。同时用 Drop 兜底复位 `restart_in_flight`——该标志位若因 panic 留在 `true`，watchdog 会永久 `continue`，与上面那条自愈失效是同一失效模式。
  *Fixed the manual engine restart blocking the UI: `restart_engine` now runs on a background thread and returns immediately (it used to run synchronously, including up to 3s of graceful-shutdown waiting plus a 20s readiness poll, occupying the IPC thread so the UI looked frozen). A Drop guard now resets `restart_in_flight`, because leaving it `true` after a panic would make the watchdog `continue` forever — the same failure mode as the self-healing bug above.*
- 修复**壳层与引擎的面板端口环境变量不一致**：壳只认 `SHIELD_ENGINE_PORT`，引擎只认 `LLM_SHIELD_PANEL_PORT`，用户按任一侧改端口后壳仍探 5801，永远判不出「已就绪」。壳现在两个名字都认（优先引擎侧那个）。
  *Fixed the panel-port environment variable mismatch between shell and engine: the shell only honoured `SHIELD_ENGINE_PORT` while the engine only honoured `LLM_SHIELD_PANEL_PORT`, so changing the port on either side left the shell probing 5801 and never reporting ready. The shell now accepts both, preferring the engine's.*
- 修复**引擎日志无限增长**：壳在追加前做 5 MiB 轮转（保留一份 `.1`）。引擎的 stdout/stderr 是 append 打开的，桌面端常驻数周可涨到几百 MB。同时关闭 werkzeug 逐请求访问日志（面板每 2.5s 轮询一次，默认关；`MASKIT_ACCESS_LOG=1` 可开），被拒绝的控制面请求改为一条结构化日志，只记方法/路径/原因/来源，不记令牌（连长度都不记）。
  *Fixed unbounded engine log growth: the shell now rotates at 5 MiB before appending (keeping one `.1`). The engine's stdout/stderr is opened for append and could reach hundreds of MB over weeks of desktop uptime. Werkzeug's per-request access log is now off by default (the panel polls every 2.5s; set `MASKIT_ACCESS_LOG=1` to re-enable), and rejected control-plane requests produce one structured line recording method/path/reason/origin only — never the token, not even its length.*
- 修复**发版脚本的静默失败**：`release.ps1` 的原生命令（`git pull` / `add` / `commit` / `push` / `tag`）此前不检查退出码，PowerShell 的 `$ErrorActionPreference` 也管不到外部进程，失败会继续往下走并打印「发布完成」。现每步校验退出码、tag 已存在必须中止、无改动时明确提示 tag 未推送并给出手动命令、detached HEAD 直接拦截。
  *Fixed silent failures in the release script: its native commands (`git pull` / `add` / `commit` / `push` / `tag`) did not check exit codes, and PowerShell's `$ErrorActionPreference` does not cover external processes, so a failure would continue and still print "release complete". Every step now verifies its exit code, an existing tag aborts, a no-change run states plainly that the tag was not pushed and prints the manual command, and a detached HEAD is rejected up front.*
- 修复**未签名时发版工作流静默降级**：缺少更新签名密钥时保留 Release 草稿并输出 `::warning::`，不再生成一个「装不上更新」的正式版。
  *Fixed the release workflow silently degrading when unsigned: with no update-signing key it now keeps the Release as a draft and emits a `::warning::` instead of publishing a release whose builds cannot auto-update.*
- 修复 `tests/soak_health.py` **读错数据目录**：产品更名为 Data Maskit 后数据目录已变成 `%APPDATA%\Maskit`，脚本仍按 `%APPDATA%\LLMShield` 读取，事件库计数恒为 `-1`、令牌永远读不到，整份巡检结果失真却不报错。现按引擎同一口径解析（优先 `LLM_SHIELD_DATA_DIR`），端口也认引擎侧变量。
  *Fixed `tests/soak_health.py` reading the wrong data directory: after the rename to Data Maskit the data root became `%APPDATA%\Maskit`, but the script still read `%APPDATA%\LLMShield`, so the event count was always `-1`, the token was never found, and the whole soak report was quietly meaningless. It now resolves the directory the same way the engine does (preferring `LLM_SHIELD_DATA_DIR`) and honours the engine's port variable.*
- 修复**重启引擎后日志插件在正式版不生效**：`tauri-plugin-log` 此前只在 debug 构建注册，正式版里壳层所有 `log::warn!` / `log::error!`（自启自愈失败、更新后重启失败、系统代理地址解析失败）全部丢失，用户遇到问题没有任何可查线索。现正式版也注册，并把文件上限从插件默认的 40KB 提到 2MiB、保留两份。
  *Fixed the log plugin being inactive in release builds: `tauri-plugin-log` was only registered under debug, so every shell-side `log::warn!` / `log::error!` (autostart self-heal failure, post-update restart failure, system-proxy resolution failure) was lost in production, leaving users with nothing to inspect. It is now registered in release as well, with the file limit raised from the plugin's 40KB default to 2MiB and two files kept.*
- 修复**流式响应极端长行/无分隔符数据流导致内存无上限增长**：为 SSE / NDJSON 流式接管增加 `_SSE_BUF_MAX`（4MB）半事件缓冲上限，流式处理优先在最后换行符保留完整事件行以保护合法 JSON 不被截碎，超限时强制刷新重置；同时修复响应扫描超长时 CPU 阻塞事件循环风险（`_SCAN_BODY_MAX` 512KB 封顶截断 + 特征预检），以及反向代理返回 HTML 403 时前端误清 token 强制踢出用户的边界问题。
  *Fixed unbounded memory growth when handling extreme streaming lines or delimiter-free streams: added a 4MB buffer cap (`_SSE_BUF_MAX`) for SSE / NDJSON, preserving line boundaries where possible to avoid corrupting valid JSON and flushing on overflow; also capped whole-response scanning (`_SCAN_BODY_MAX` at 512KB + pattern precheck) to prevent event loop blocking, and fixed a frontend edge case where a reverse proxy HTML 403 erroneously cleared the auth token.*
- 修复**被拒绝的控制面请求缺少现场**：关闭 werkzeug 访问日志后，403 不再无迹可循（见上）。
  *Fixed rejected control-plane requests leaving no trace: with werkzeug's access log disabled, a 403 no longer passes without a record (see above).*

### 优化 / Changed
- 发版链路加固：`ci.yml` / `release.yml` / `test-macos-build.yml` 各 job 增加 `timeout-minutes`；`release.yml` 的 `docker` job 改为 `needs: [docker-smoke, desktop]`，避免桌面端失败却已把 `latest` 推到 `ghcr.io`；`.github/dependabot.yml` 注明 `open-pull-requests-limit: 0` 是自 0.2.1 起有意关闭常规版本更新 PR（经 git 历史确认），而非漏填。
  *Release pipeline hardening: every job in `ci.yml` / `release.yml` / `test-macos-build.yml` now sets `timeout-minutes`; `release.yml`'s `docker` job now `needs: [docker-smoke, desktop]` so a failed desktop build cannot leave `latest` already pushed to `ghcr.io`; and `.github/dependabot.yml` documents that `open-pull-requests-limit: 0` intentionally disables routine version-update PRs (confirmed via git history), rather than being an omission.*
- 文档与代码对齐：`AGENTS.md` §4、`CONTRIBUTING.md`、`docs/RELEASE_CHECKLIST.md` 统一指向 `scripts/verify-all.py` 作为门禁唯一清单（不再各自抄一份命令）；`docs/BRANCH_PROTECTION.md` 补上 `rust-macos` 必需项与用 `gh api` 核对的方法；`docs/PLATFORM_SUPPORT.md` 修正「官方桌面端仅支持 Windows」与 macOS DMG 已发布的矛盾表述及 Node 版本下限；`SECURITY.md` 新增环境变量清单（含 `MASKIT_ACCESS_LOG`）并说明 `LLM_SHIELD_*` 遗留前缀的处理口径。
  *Documentation aligned with the code: `AGENTS.md` §4, `CONTRIBUTING.md` and `docs/RELEASE_CHECKLIST.md` now all point at `scripts/verify-all.py` as the single gate manifest instead of each copying the command list; `docs/BRANCH_PROTECTION.md` adds the `rust-macos` required check and how to verify it via `gh api`; `docs/PLATFORM_SUPPORT.md` fixes the contradiction between "desktop builds are Windows-only" and the already-shipped macOS DMG, plus the Node version floor; and `SECURITY.md` gains an environment-variable table (including `MASKIT_ACCESS_LOG`) and states how the legacy `LLM_SHIELD_*` prefix is handled.*
- 清理死代码与过时注释：删除从未被调用的 `_placeholder()`（其 docstring 描述的「每会话随机占位符」与现行的滑动窗口复用设计相矛盾）；修正指向已不存在的 `app.py` / `panel.bat` 的注释，以及一条会指引用户运行不存在文件的权限报错文案；`{{LABEL_hex6}}` 等过时格式说明改为与当前后缀字符集一致。
  *Dead code and stale comments removed: deleted the never-called `_placeholder()` (whose docstring described per-session random placeholders, contradicting the sliding-window reuse design now in place); fixed comments referencing the long-gone `app.py` / `panel.bat` and an admin-permission error message that told users to run a file that no longer exists; and updated format notes such as `{{LABEL_hex6}}` to match the current suffix alphabet.*

## [0.2.8] - 2026-09-12

修复占位符「按后缀反查」兜底在预热后失效、反向代理非白名单路径明文上行安全漏洞，以及 Responses API 流式响应多 part 通道缓冲隔离。  
Release v0.2.8: Fix false-positive suffix index collision disabling placeholder fallback after warm-up, resolve cleartext forwarding on non-whitelisted reverse-proxy paths under fail-closed, and isolate multi-part Responses SSE buffers.

### 修复 / Bug Fixes
- 修复**占位符「按后缀反查」兜底在启动预热后大面积失效**的问题：后缀索引登记时用对象身份比较（`is not`）判断是否撞车，而预热从事件库 `json.loads` 出来的 token 与索引里已存的那个**值相等但对象不同**——同一个 token 被登记两次就会被误判成撞车，后缀被永久标记为不可用。复用表的设计目的就是跨请求复用同一占位符，因此事件库里同一 token 出现多条事件是常态，预热覆盖的事件越多、失效面越大；且该状态**无法自愈**，运行时的补登记也救不回来。表现为模型改写花括号、标签大小写或尾部残缺的占位符还原不出来，且没有任何日志，用户只能看到裸占位符。现改为值比较（`!=`）；真撞车（两个不同 token 抢同一后缀）的处理语义完全不变（感谢 @duncan0k 报告 #27）。
  *Fix: the suffix-index fallback for placeholder restoration was silently disabled after startup warm-up. The index used identity comparison (`is not`) to detect suffix collisions, but tokens rehydrated from the event store via `json.loads` are equal by value yet distinct objects — registering the same token twice was treated as a collision and the suffix was permanently marked unusable. Reusing one placeholder across requests is exactly what the reuse table is for, so multiple events per token are the norm and the blast radius grew with every warm-up; the state was also unrecoverable at runtime. Symptom: placeholders whose braces, label casing or trailing braces the model rewrote were never restored, with no log line at all. Now compares by value (`!=`); genuine collisions (two different tokens sharing a suffix) behave exactly as before (thanks to @duncan0k in #27).*
- 修复 **fail-closed 开启时非白名单路径的 JSON 请求仍明文上行**的问题：反向代理模式下，请求已经落在用户配置的上游路由上，但若路径不在该上游的白名单内、且请求体不含任何已知 LLM 特征键，此前会直接原样转发，**完全不检查 fail_closed**（默认开启）。未配置 `paths` 时白名单只有 7 条默认路径，`/v1/vector_stores`、`/v1/fine_tuning/jobs`、`/v2/...` 以及厂商新增端点上的 `{"text":"张三 13800138000"}` 都会明文直达上游。这与主管线「已配置路由 + fail-closed 一律脱敏」的口径冲突——放行判据 `_LLM_BODY_KEYS` 是白名单，永远追不上新协议；此前还存在「请求体解析失败反而比解析成功更安全」的倒挂。现改为 fail_closed 开启时统一交给主管线按未知形态脱敏，仅用户显式关闭 fail_closed 时才透传。⚠️ 行为变化：此后反向代理模式下 `/v1/files`、`/v1/fine_tuning/jobs` 等管理类 JSON 调用也会进入脱敏并建立会话（感谢 @duncan0k 报告 #28）。
  *Fix: JSON requests on non-whitelisted paths were forwarded in cleartext even with fail-closed enabled. In reverse-proxy mode, once a request matched a configured upstream, a path outside that upstream's whitelist with a body carrying none of the known LLM keys was passed through verbatim **without ever consulting fail-closed** (on by default). With no `paths` configured the whitelist is only the 7 default entries, so `/v1/vector_stores`, `/v1/fine_tuning/jobs`, `/v2/...` and any new vendor endpoint receiving `{"text":"张三 13800138000"}` went upstream in the clear. That contradicts the main pipeline's rule — "configured route + fail-closed ⇒ always mask" — and the allow-list `_LLM_BODY_KEYS` can never keep up with new protocols; it also produced the perverse result that a body failing to parse was safer than one that parsed fine. Now such requests are handed to the main pipeline and masked as unknown shape when fail-closed is on; passthrough only happens when the user explicitly turns fail-closed off. ⚠️ Behaviour change: management-style JSON calls such as `/v1/files` and `/v1/fine_tuning/jobs` are now masked and create a session in reverse-proxy mode (thanks to @duncan0k in #28).*
- 修复 **Responses 流式响应中同一 output item 的多个 content part 共用还原缓冲**的问题：通道键此前只用 `output_index`，而规范允许一个 message item 携带多个 `output_text` part，于是 part 0 的 `.done` 会清掉 part 1 的半截占位符缓冲，交错的增量也会把半截占位符串进另一个 part 的正文。现按 `content_index` 隔离通道；`content_index` 缺失或为 0 时通道键与改动前完全一致，官方端点（每条消息仅一个 part）的行为零变化。此问题主要影响自建/中转的多 part 实现（感谢 @duncan0k 报告 #29）。
  *Fix: multiple content parts of one Responses output item shared a single restoration buffer. The channel key used only `output_index`, but a message item may carry several `output_text` parts, so part 0's `.done` discarded part 1's buffered half-placeholder and interleaved deltas spliced a half-placeholder into the other part's text. Channels are now separated by `content_index`; when it is missing or 0 the key is byte-for-byte what it was before, so official endpoints (one part per message) behave exactly as before. This mainly affects self-hosted or relayed implementations that emit multiple parts (thanks to @duncan0k in #29).*
- 修复**发版脚本可能把 `[Unreleased]` 章节渲染成线上 Release body**的问题：`render-release-notes.py` 一直声明该章节不参与渲染，但实现里并没有这条规则，此前只是**碰巧**因为章节为空才报错。一旦按正常流程在发版前往 Unreleased 写入条目，这个防护就失效——若误传 `Unreleased` 作为版本号，未发布内容会被发到线上 Release 页。现显式拒绝该版本号。
  *Fix: the release-notes script could render the `[Unreleased]` section into a published GitHub Release body. `render-release-notes.py` always claimed that section is excluded, but nothing in the implementation enforced it — it only errored out **by accident** because the section happened to be empty. As soon as entries are written to Unreleased (the normal pre-release workflow) that guard disappears, and passing `Unreleased` as the version would publish unreleased notes. The version is now rejected explicitly.*

## [0.2.7] - 2026-09-11

命令行工具调用中的占位符还原加固、敏感词管理页「从 .env 导入」，以及 macOS (Apple Silicon) 原生 DMG 发布与在线更新。  
Release v0.2.7: Harden placeholder restoration in command-line tool calls, add ".env import" to the sensitive-word manager, and support native macOS (Apple Silicon) DMG release with OTA updates.

### 新增 / Features
- 敏感词管理页新增「📂 从 .env 导入」：粘贴或选择 `.env` 文件后自动解析（支持 `export` 前缀、单双引号、双引号转义、行内注释、BOM、CRLF、重复 key），按变量名与值形态**智能识别凭据**并推荐对应分类，可逐行勾选与调整目标分类后一键合入词库；解析时自动跳过空值、过短（< 3 字符，避免无边界子串匹配误伤代码）、超长（> 200 字符，后端会静默丢弃）与重复定义的行，并在预览区列明跳过原因。
  *Feature: Added "Import from .env" to the sensitive-word manager. Paste or pick a `.env` file and it is parsed automatically (`export` prefix, single/double quotes, double-quote escapes, inline comments, BOM, CRLF, duplicate keys). Rows are heuristically classified as credentials by variable name and value shape, with a recommended category you can review and change per row before merging into the word list in one click. Blank, too-short (< 3 chars, which would substring-match and corrupt surrounding code), too-long (> 200 chars, silently dropped by the backend) and duplicate rows are skipped with the reason shown in the preview.*
- **凭据类行的目标分类被收窄为 7 个凭据标签**（`API_KEY` / `TOKEN` / `SECRET` / `ACCESS_KEY` / `JWT` / `CONNSTR` / `PRIVATE_KEY`）：词库分类名会原样成为占位符标签，只有这 7 个标签才会让引擎对事件库**只写摘要与掩码、不写原文**；把密钥导入其它分类等于把明文写进本地 SQLite。
  *Credential rows can only target the 7 credential labels (`API_KEY` / `TOKEN` / `SECRET` / `ACCESS_KEY` / `JWT` / `CONNSTR` / `PRIVATE_KEY`). A category name becomes the placeholder label verbatim, and only these 7 labels make the engine store a digest and mask — never the plaintext — in the local event database. Importing a secret under any other category would write it to SQLite in cleartext.*
- 新增 `scripts/check-env-import.mjs`（27 项边界用例，含真实 `.env` 样例端到端），已接入 CI 门禁（`frontend` job，Node 22）。
  *Added `scripts/check-env-import.mjs` (27 edge cases including an end-to-end real-world `.env` sample), now wired into the CI gate (`frontend` job, Node 22).*
- 支持 macOS 原生 DMG 桌面安装包自动构建：GitHub Actions Release 工作流增加 `macos-latest` arm64 编译节点，正式 Release 自动附带 `Maskit_<版本>_aarch64.dmg`。
  *Support native macOS DMG bundle compilation: Added `macos-latest` arm64 runner to GitHub Release workflow, producing `Maskit_<version>_aarch64.dmg` automatically on release.*
- 统一跨平台自动更新元数据 `latest.json`，同时支持 Windows (`windows-x86_64`) 与 macOS (`darwin-aarch64`) 在线签名静默/增量升级。
  *Unified multi-platform `latest.json` updater manifest supporting both Windows (`windows-x86_64`) and macOS (`darwin-aarch64`) OTA signature-verified updates.*
- 新增 `scripts/check-workflows.py` 并接入 CI 门禁（`version` job）：校验 `.github/workflows` 下每个 workflow 的 YAML 可解析、job 与 step 结构完整，并把显式 `shell: bash` 的步骤抽出来跑 `bash -n`。此前 CI 不 lint workflow，YAML 或 `run` 块写坏只会在推送后（最坏是发版那一刻）才暴露。
  *Added `scripts/check-workflows.py` to the CI gate (`version` job): it checks that every workflow under `.github/workflows` parses as YAML with a well-formed job/step structure, and runs `bash -n` on steps that declare `shell: bash`. Previously CI did not lint workflows, so a broken YAML file or `run` block only surfaced after the push — at worst at release time.*

### 修复 / Bug Fixes
- 修复**日志保留天数设为 0（永久保留）失效**的问题：底层已支持 0 天不清理，但控制面多处使用 `value or 7` 短路判断，导致设为 0 时被强制回退为默认 7 天。现统一通过 `_normalize_retention` 归一化处理，前端设置输入框增加负数防呆限制并在中英文提示中明确「0 表示永久保留」（感谢 @Shy7777 提交 #22）。
  *Fix: Preserve unlimited log retention when retention days is set to 0. The backend storage already supported 0 as unlimited, but panel endpoints fell back to 7 days via truthiness checks (`value or 7`). Normalized retention parsing across endpoints, added input sanitation, and updated bilingual tooltips to reflect unlimited retention (thanks to @Shy7777 in #22).*
- 修复**流式响应中输入 Token 少记或丢失**的问题：Anthropic 协议将输入用量放在开头的 `message_start`，而 Responses 协议使用 `response.usage`；长流式响应（>64KB）会把开头挤出尾部缓冲区导致输入用量永久漏计，后续 chunk 还会把已有字段冲掉。现支持完整事件用量合并，透传模式引入 `SSEUsageAccumulator` 逐行累积 SSE 用量，低内存且不受截断影响（感谢 @Shy7777 提交 #23）。
  *Fix: Collect token usage reliably across streaming protocols. Anthropic puts input tokens in the initial `message_start` and Responses uses `response.usage`; long streams (>64KB) previously pushed early chunks past the tail buffer, losing prompt counts, while later chunks could overwrite existing fields. Now merges usage across snapshots and uses `SSEUsageAccumulator` in passthrough mode to track streaming lines with bounded memory (thanks to @Shy7777 in #23).*
- 修复**日志页切后台积压后恢复轮询跳漏记录**的问题：当积压超过 200 条时，旧逻辑使用 `ORDER BY id DESC LIMIT 200` 截断了最早的数据，客户端游标跳跃导致中间记录被永久跳过。现增量查询改用 `ORDER BY id ASC LIMIT ?`，配合 `has_more` 与 `next_since` 游标，前端支持最多 5 页连续追赶拉取（感谢 @Shy7777 提交 #24）。
  *Fix: Avoid skipping events during incremental log polling. When more than 200 events accumulated in the background, `ORDER BY id DESC LIMIT 200` truncated the oldest unread records, advancing the cursor past unseen rows. Incremental queries now paginate in ascending order (`ORDER BY id ASC`), returning `has_more` and `next_since` for up to 5 catch-up batches in the UI (thanks to @Shy7777 in #24).*
- 修复**多候选回答（`n > 1`）或稀疏 Choice 时流式还原错乱与断流**的问题：原逻辑按 chunk 内的数组位置区分通道，导致不同 `choice.index` 混用缓冲拼错半截占位符，且一个 choice 结束会暴力清空所有通道。现按真实 `choice.index` 隔离还原缓冲区，结束事件仅定向刷新对应通道，并补齐 Responses 终态快照清理（感谢 @Shy7777 提交 #25）。
  *Fix: Isolate SSE restoration by completion choice index. Chunks with sparse choices previously shared restoration channels based on array positions, concatenating partial placeholders across choices and prematurely flushing unrelated channels on completion. Restorations are now isolated by `choice.index`, only finishing channels are flushed, and completed Responses snapshots clear stale tails (thanks to @Shy7777 in #25).*
- 修复**设置页快速切换规则时的竞态覆盖回滚**：连续点击规则开关时，整表旧快照被依次入队发送，导致后一次保存把前一次修改覆盖（例如连续关 EMAIL 和 PHONE，EMAIL 又会被恢复开启）。现新增受控的 `/api/config/builtin_rules` 原子更新接口，仅在锁内合并提交的变更字段，并防呆禁用空规则操作（感谢 @Shy7777 提交 #26）。
  *Fix: Preserve independent rule changes during queued saves. Rapidly toggling built-in rules previously queued full snapshots based on stale state, causing the second save to overwrite the first (e.g. toggling off EMAIL and then PHONE would turn EMAIL back on). Added a dedicated `/api/config/builtin_rules` atomic endpoint to patch changed rules under the configuration lock (thanks to @Shy7777 in #26).*
- 修复模型把占位符写成**转义形态**（`\{\{IPPRIVATE_x\}\}`）时还原不彻底、留下 `\{\` 与 `\}\}` 残渣的问题：真值确实出来了，但命令仍然是坏的，用户会误判成「还原成功」，比彻底不还原更危险。现在整个转义块连同反斜杠一并替换，且流式响应的 chunk 边界落在反斜杠与花括号之间时也不再漏残渣。
  *Fix: Fully restore escaped placeholders (`\{\{X\}\}`) including their backslashes, instead of leaving `\{\` / `\}\}` residue that silently breaks the resulting command — previously the real value appeared while the command stayed broken, which is more dangerous than no restore at all.*
- 修复模型改写占位符**标签**（`IPPRIVATE` → `IP_PRIVATE`、或整段小写）导致完全还原不了的问题：按 6 位随机后缀反查即可救回（仅纯辅音后缀入索引，标签被整段换名时仍拒绝猜测，宁可失败可见）。同时修正这类还原在事件明细里被误标成「未还原」的问题。
  *Fix: Restore placeholders whose label the model rewrote (`IPPRIVATE` → `IP_PRIVATE`, or lowercased) via reverse-lookup on the 6-char random suffix. Only consonant suffixes are indexed, and renamed labels are still refused rather than guessed. Also corrects such restores being wrongly flagged as "not restored" in event details.*
- 修复**流式响应中途出错时丢弃已扣留文本**的问题：还原函数默认只清空一个缓冲槽，正文、思考、工具参数各自通道里被扣住的半截占位符会被静默丢弃，客户端看到的文本凭空少一截（实测：`结尾{{NAME_ab` 之后直接跳到下一块）。现在异常分支会把各通道滞留一并补发，且补发事件独立成行——与残片粘成 `data: {…}data: {…}` 时，严格按行解析的 SDK 会整条丢弃，等于白补。
  *Fix: Stop dropping withheld text when a streaming response fails mid-stream. The restore call only flushed a single buffer slot, so half-placeholders held per channel (content / reasoning / tool arguments) were silently discarded and the client saw a gap in the text. The error path now flushes every channel, and each flush event is emitted on its own line — glued onto a fragment as `data: {…}data: {…}` a strict line-based SDK would discard the whole event.*
- 修复「从 .env 导入」里**选了目标分类却忘了勾选该行**时的死角：确认按钮置灰、文案是「导入 0 项」，而页脚提示只覆盖「勾了但没选分类」这一种情况，用户完全无从判断为什么点不动（真机复现）。现在**选中目标分类即视为确认导入该行**，会自动把它勾上；用户仍可手动取消勾选。
  *Fix: Selecting a target category now auto-checks that row. Previously, choosing a category without ticking the checkbox left the confirm button disabled and reading "Import 0" with no explanation — the footer hint only covered the opposite case (ticked but no category), so users had no way to tell why they could not proceed. The checkbox can still be unticked manually.*

### 优化 / Improvements
- 增强 `generate-latest-json.py` 多平台签名解析，提前绑定版本标签防止未绑定变量异常。
  *Improve multi-platform signature parser in `generate-latest-json.py` to ensure robust manifest generation across platforms.*
- 独立 Windows 与 Unix 平台的 Python 依赖安装步骤，规避跨 Shell 语法差异。
  *Separate platform-specific Python installation steps in Release workflow to prevent shell syntax conflicts.*
- 修正 Release 说明文案与实际行为不符的问题：原文案称「本工作流不组装也不发布 `latest.json`」，而紧接着的步骤就会组装并上传该文件，属公开发布页上的用户可见错误信息；未签名包的 `UNSIGNED.txt` 标记与未签名场景的说明也一并改为只陈述该安装包自身缺少签名，不再对全局更新元数据下结论。
  *Fix: Corrected the release notes to match what the workflow actually does. The text claimed the workflow "does not assemble or publish latest.json updater metadata" while the very next steps do exactly that — a user-visible error on the public release page. The `UNSIGNED.txt` marker and the unsigned-build note now state only that the bundle itself carries no signature instead of making a claim about the global manifest.*
- 消除还原路径上两处**正则回溯**引起的超线性耗时：`_PARTIAL_RX` 与 `_ESCAPED_PLACEHOLDER_RX` 中的无上限反斜杠量词（`\\*` / `\\+`）在「连续反斜杠」文本上会退化成 O(N²)，32KB 输入实测 293ms（流式场景下会拖慢每个 chunk，表现为编辑器里逐字输出卡顿）。量词封顶为 `\\{0,3}` / `\\{1,3}` 后恢复线性（同输入 0.4ms），且对全部真实转义形态逐条等价。已对引擎热路径上的所有正则做回溯扫描，确认无其它超线性项。
  *Improve: Remove two super-linear regex backtracking hotspots in the restore path. Unbounded backslash quantifiers (`\\*` / `\\+`) in `_PARTIAL_RX` and `_ESCAPED_PLACEHOLDER_RX` degraded to O(N²) on runs of backslashes — 293 ms for a 32 KB input, which slowed every chunk in streaming mode and showed up as stuttering output. Capping them at `\\{0,3}` / `\\{1,3}` restores linear behaviour (0.4 ms for the same input) with identical results on every real escape form. All regexes on the engine hot path were scanned for backtracking; no other super-linear case remains.*

## [0.2.6] - 2026-09-11

注入请求头占位符覆盖客户端真实凭据（中转站 401）与 CI 单测死锁修复版本。  
Release v0.2.6: Fix CI unit test deadlock, credential header clobbering (401 errors), and enable macOS Apple Silicon DMG packaging.

### 修复 / Bug Fixes
- 修复「注入请求头」仍留占位符时**把客户端自带的真实凭据覆盖掉**、导致上游返回 401「无效的令牌」：现在整值为 `<...>` 的占位符一律跳过注入，客户端自带凭据照常透传。
  *Fix: Skip injecting header placeholders like `<YOUR_API_KEY>` to prevent overwriting client-sent credentials and causing upstream 401 Unauthorized errors.*
- 修复注入请求头值为空时同样会覆盖客户端凭据的问题：空值一并跳过注入并告警。
  *Fix: Skip empty or whitespace header values to avoid clearing client credentials.*
- **「注入请求头」中的凭据类请求头一律不再注入**：Maskit 只做透明转发，凭据归客户端所有，严禁在此字段注入 `Authorization`、`x-api-key` 等凭据头。
  *Security & Reliability: Disallow injecting credential headers (`Authorization`, `x-api-key`, etc.) via `extra_headers`; only protocol headers (such as `anthropic-beta`) are permitted.*
- 修复客户端类型预设**预填凭据头占位符**这一配置陷阱：`Authorization` / `x-api-key` 不再进预设。
  *UX Fix: Remove credential placeholders from client presets so users are never misled.*
- 修复 GitHub Actions Linux 虚拟机运行单测时的 `socketserver` 挂起死锁：`_stop_passthrough` 增加后台线程有界超时关闭保护。
  *CI Fix: Resolve unbounded hang in `socketserver.shutdown()` on headless runners with bounded timeout.*
- 开启 GitHub Actions 原生 macOS（Apple Silicon M系列）DMG 桌面安装包自动化构建。
  *Platform: Enable automated macOS arm64 DMG bundle compilation in GitHub Release workflow.*

### 优化 / Improvements
- 「注入请求头」收进设置弹窗的「高级选项」折叠区，默认收起；保存客户端时拦截占位符与凭据头并给出明确提示。
  *Move injected headers under an "Advanced Options" collapsible section; intercept placeholders and credential headers before saving.*

### 测试 / Tests
- 补充「注入请求头为占位符/空值时不得覆盖客户端自带凭据」与「凭据头一律不得注入」等 7 组单测；全量 535 项单测全部通过。
  *Add comprehensive unit test coverage for header injection guard rails; 535 tests passing.*

## [0.2.5] - 2026-09-11

代理启动超时、Secret 前缀短凭据与日志筛选修复版本。

### 修复
- 修复弱 CPU / 多 upstream 机器启动代理被误判失败（Issue #19）：就绪等待上限由固定 15s 放宽到 60s，并支持 `MASKIT_START_READY_TIMEOUT` 环境变量覆盖；启动失败分支不再对存活子进程调用会永久挂起的 `p.stdout.read()`，改用有界超时读取，保证 `proxy_starting` 一定复位；错误信息不再渲染成 `b'...'` 形式。
- 修复 Secret 前缀凭据的后缀长度阈值过严（19 位）导致自建平台、内网鉴权、测试环境的 8~16 位短 Key 全部漏判：阈值下调至 8 位，同时仍避开 `sk-demo`、`sk-test` 一类极短日常词。
- 修复 `total_tokens` 兜底把「总 token」误记为「输入 token」的偏差：仅在 prompt/completion 均为 0 时才使用 `total_tokens` 兜底。
- 移除 `transparent.py` 中与 `shield_defaults.py` 重复的 `_extract_usage` 实现，统一走 `shield_defaults.extract_usage`（补齐 `meta.tokens` 与 `total_tokens` 兼容）。
- 修复日志页「类型筛选」在海量日志下被 `LIMIT` 截断、筛不到较早事件的问题：类型过滤下推到数据库（新增 `event_type` 参数，命中 `idx_events_type_ts`），`/api/logs` 与 `/api/logs/export` 均支持 `type` 参数。
- 修复日志合并把同一 sid 的第三个及以后事件静默覆盖到已合并行的问题；非 MASK/RESTORE 类型（ERR/BLOCK/SCAN_WARN 等）即便带 sid 也独立成行展示。
- 修复敏感词排序词表「等长换词不生效」：缓存失效原本只比较词条数量，把 `{张三, 李四}` 换成 `{密, 王五}`（条数不变）时会继续沿用旧词表 —— 新词不脱敏、已删除的旧词继续脱敏，**漏脱敏与过脱敏同时发生**，且症状随调用顺序漂移极难排查。现改为按内容比较，任何写入词表的路径都自动正确。

### 优化
- 日志页「无数据」与「加载中」状态改按首次加载判定，后台轮询不再让空列表持续转圈。
- 敏感词新增按钮支持回车提交；输入框有内容时按钮变为「保存」，避免误触收起输入框。
- Secret 前缀卡片说明补全匹配规则：明确 `@` 可出现在前缀任意位置（不再表述为「以 @ 开头」）、前缀之后需跟随至少 8 位密文字符，并指引更短的固定 Key 改用「敏感词」列表（按字面精确匹配、无长度门槛）。
- 敏感词新增 1~2 字符的词时给出误伤告警：自定义词是无边界字面子串匹配，例如加入 `a1` 会把 `data1` 打码成 `dat{{TERM_x}}`，进而改坏发往上游的 prompt。
- 合并正则的缓存命中判断提前到构建匹配片段之前：`mask()` 热路径不再做词表排序与正则拼接（实测 2000 次调用仅首次构建），并修掉「跳过非法正则词」日志每次请求都重打一遍的刷屏（20 次调用由 20 条降为 1 条）。

### 测试
- 补充 8 位短 Key 与 `@` 前缀的脱敏/还原用例、Rerank 用量提取用例、`/api/logs?type=` 下推过滤用例、启动超时不阻塞用例。
- 补充「短于前缀阈值的固定 Key 经敏感词列表仍可完整脱敏/还原」用例，锁住设置页指引的这条兜底路径。
- 补充「等长换词必须立即生效」回归护栏：把缓存失效改回只比长度，该用例必挂（已实测验证）。
- 修复 `test_single_char_custom_word_requires_boundary` 的用例顺序依赖：改为直接覆盖惰性重建路径，不再依赖上一个用例残留的词表缓存。
- 修复 `tests/smoke_stream.py` 监听端口与探测端口不一致（硬编码 5899 vs `PROXY_PORT` 18992）导致流式冒烟测试无法通过的问题。

### 文档
- 社区论坛链接更新为 LINUX DO 项目专帖。

## [0.2.4] - 2026-09-11

代理启动稳定性、Secret 前缀配置与 Rerank 支持修复版本。

### 修复
- 修复 Windows GUI 打包态（无控制台）点击启动代理即崩溃挂起：引擎入口在导入任何三方库之前补齐 `sys.stdin/stdout/stderr`，避免 mitmproxy 日志处理器对 `None` 调用 `isatty()` 抛 `AttributeError` 并弹出阻塞式错误框。
- 修复 Secret 前缀配置被误丢弃与误限制：允许不带尾部连字符的自定义前缀（如 `hf_`、`x_`），显式清空 `secret_prefixes` 时不再被默认值回填；前缀中的 `-` 与 `_` 逐字符安全转义后视为等价，杜绝二次替换嵌套。
- 修复发布流水线长期停留在 Draft 状态：Release 资产上传完成后自动转为正式发布，发布标题统一为 `Data Maskit <tag>`。
- 修复 Rerank 接口未被纳入默认脱敏路径与业务字段扫描：新增 `/v1/rerank`、`/rerank` 默认路径，`documents` 纳入 LLM 业务键与扫描容器。

### 优化
- Rerank 响应用量提取兼容 Cohere 风格 `meta.tokens`。
- 设置页 Secret 前缀卡片补充说明文案与格式校验提示（重复前缀、非法格式）。

## [0.2.3] - 2026-09-11

反向代理兼容与配置健壮性修复版本。

### 修复
- 修复反向代理 / CDN（Nginx、EdgeOne 等）HTTPS 终止环境下页面白屏：静态资源（HTML / JS / CSS）不再经过 Origin 与 Host 校验，仅 `/api/*` 控制面接口进入安全防线。
- 修复 Origin 校验在反代回源 Origin 与源站不一致时把用户挡在面板之外的问题：新增配置项 `origin_check`（设置页「控制面访问安全」开关），以及环境变量 `MASKIT_DISABLE_ORIGIN_CHECK=1` 逃生舱。
- 增加控制台 Origin 拦截自救能力：登录门与配置接口在收到合法 Token 时精准识别拦截原因并提供一键解除通道，杜绝反代 Origin 错误导致设置页陷入死锁。
- 修复反向代理路由丢失 Query 参数的缺陷：完整保留客户端与 Target 自带的 query 参数（如 Azure OpenAI `?api-version=...`、Gemini `?key=...` 及流式参数等）。
- 修复配置归一化与 sidecar 同步脱节问题：配置清洗修正结果原子持久化写回磁盘，sidecar 与面板 100% 保持相同规范化路由表，锁内原子同步消除内存竞态。
- 修复多个纯中文名称客户端因内部路径前缀塌缩成同一 `/up` 而被整条丢弃的问题：自动生成 `up_N` 前缀、冲突时自动追加序号消解，客户端不再丢失；同名客户端改为去重并给出提示。
- 优化客户端预设路径与 Base URL 复制：前端一键复制符合 OpenAI SDK 规范的标准接入地址（自动带 `/v1`），预设剔除宽泛的裸 `/v1` 防范非 JSON 接口误伤，`Content-Type` 改为大小写不敏感。

### 文档
- 补充 Docker 端口按需映射说明（单模型仅需映射 18701）与 Nginx 反向代理参考配置（含 `MASKIT_TRUST_PROXY` 与 SSE 流式 `proxy_buffering off`）。
- 统一快捷登录链接口径为 `/#token=...`（fragment 不随请求发送、不进代理访问日志），规范 Docker 环境变量 Token 示例为标准 ASCII 格式。

## [0.2.2] - 2026-09-10

界面直达与价格同步优化版本。

### 优化与修复
- 顶栏导航区新增 GitHub 官方图标，支持点击一键打开系统默认浏览器直达开源项目主页。
- 修复手动点击「立即同步价格」时因开关校验导致的 HTTP 502 报错；手动触发自动视同授权并同步。
- 完善自托管价格源与 OpenRouter 格式的无缝兼容。
- 优化 DeepSeek 等主流系列模型的默认费率兜底，减少未收录后缀时的未定价展示。

## [0.2.1] - 2026-09-09

修复与体验优化版本。

### 优化与修复
- 修复 Windows 任务栏图标由于缺少多尺寸位图导致的白纸空白问题（补齐 16~256 全尺寸标准 ICO）。
- 移除关于页遗留的反馈卡片，避免重复入口。
- 修复高级设置中点击「去客户端管理配置」跳转导致下方内容空白的问题。
- 关闭 Dependabot 自动化拉取 PR 限制，保持仓库 PR 列表清爽。

## [0.2.0] - 2026-09-09

发布增强与上线版本。

### 优化与修复
- 增强桌面壳跨平台进程清理与守护机制（Unix 自底向上树状进程终止）。
- 增强面板安全边界校验（外部 URL 边界白名单、重定向凭据安全抹除）。
- 完善前端 TypeScript strict 模式类型检查与代码健壮性。
- 清理内部注释与代码规范，支持系统托盘本地化与平滑更新。
- 完整支持客户端远程无缝升级链路。

## [0.1.0] - 2026-09-09

首个公开开源版本。

### 功能
- 反向代理多端口脱敏：客户端 `base_url` 指向本机端口，请求体内敏感信息替换为 `{{LABEL_xxxxxx}}` 占位符后转发，响应流式逐事件还原。
- 内置规则：手机号 / 邮箱 / 身份证 / 银行卡 / IBAN / 车牌 / 内网 IP / API Key / JWT / 私钥 / 连接串等，另支持自定义词表与正则。
- 跨请求占位符滑动窗口复用，多轮对话上下文一致。
- Fail-closed：脱敏管线异常或请求体超 32MB 一律阻断，绝不放行明文。
- 透明直连兜底：代理未启动时端口仍由轻量层监听并原样转发，不断网。
- 被动安全审计：错误泄漏 / 身份换芯 / 工具调用改写 / SSE 异常 / 响应投毒 / 跨请求污染 / 危险动作信号。
- 本地事件库（SQLite）、统计仪表盘、战绩分享卡；凭据类事件只存摘要。
- Windows 桌面版（Tauri 2）：系统托盘、单实例、引擎崩溃自愈、开机自启。
- Docker 镜像（amd64 / arm64）内嵌 Web 控制台，远程访问需 `MASKIT_PANEL_TOKEN`。
- 中英文界面一键切换、深浅主题。

[Unreleased]: https://github.com/xiaYuTian11/maskit/compare/v0.2.3...HEAD
[0.2.3]: https://github.com/xiaYuTian11/maskit/releases/tag/v0.2.3
[0.2.2]: https://github.com/xiaYuTian11/maskit/releases/tag/v0.2.2
[0.2.1]: https://github.com/xiaYuTian11/maskit/releases/tag/v0.2.1
[0.2.0]: https://github.com/xiaYuTian11/maskit/releases/tag/v0.2.0
[0.1.0]: https://github.com/xiaYuTian11/maskit/releases/tag/v0.1.0
