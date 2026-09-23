"""凭据类标签的**唯一定义源**（引擎侧）。

为什么单独一个模块：这份集合原先在 4 个地方各写一遍（transparent / panel /
event_store / 前端两份 TS），口径分成 5 个与 7 个两派。少两个标签的那几处会让
「凭据原文永不落库」这条红线在**读路径**上漏掉 CONNSTR 与 PRIVATE_KEY——
CONNSTR 的捕获组就是连接串里的密码本身，PRIVATE_KEY 更是整块 PEM 私钥。

模块刻意只依赖 stdlib：`event_store` 不能 import `transparent`（那会把 mitmproxy
拖进面板 Flask 进程），所以共享常量必须放在两边都能安全 import 的独立模块里。
前端有一份等价的 TS 定义（`frontend/src/lib/credential-labels.ts`），由
`tests/test_regressions.py::test_credential_label_sets_stay_in_sync` 守死不漂移。
"""

# 判定语义：label 在此集合内 → 原文**永不落库**，只记打码 preview + 长度 + sha256 摘要。
CREDENTIAL_LABELS = frozenset({
    "API_KEY",
    "TOKEN",
    "SECRET",
    "ACCESS_KEY",
    "JWT",
    # 下面两个曾长期漏在集合外，明文原样写进 events.items[].original：
    # 生产库实测曾有 CONNSTR 5091 条 / PRIVATE_KEY 468 条明文。
    "CONNSTR",
    "PRIVATE_KEY",
})

# ========== 凭据**回流**检测的种类（audit_signals 的 `_CREDENTIAL_PATTERNS`） ==========
# 与上面的 CREDENTIAL_LABELS 不是一回事：那份是**脱敏侧**的标签（打码时用的业务标签），
# 这份是**审计侧**凭据回流规则匹配到的 kind 名，两者口径不同、不可合并。
# 放这里的理由与 CREDENTIAL_LABELS 相同：`audit_signals` 按这份名单产出
# `kind = "credential_echo:<kind>"`、证据 = `<kind> len=… sha256=…`；
# `event_store` 读侧要对**证据前缀**做降噪谓词
# （见 `_DEPRECATED_AUDIT_EVIDENCE_PREFIXES`），各写一遍必然漂移
# （历史事故正是这样发生）。由
# `tests/test_audit.py::test_credential_echo_kinds_stay_in_sync` 守死与规则表一致。
CREDENTIAL_ECHO_KINDS = (
    "github_token",
    "google_api_key",
    "aliyun_ak",
    "tencent_ak",
    "slack_token",
    "stripe_key",
    "aws_ak",
    "jwt",
)

# ========== W1-1 凭据回流的分档标记 ==========
# 规则无法区分「真实凭据」与「教学示例」（编程助手在代码块里写 .env 模板/CI 密钥
# 是家常便饭），故按**客观结构**（是否代码块内 + 值的熵）分档，并在证据尾部打标记：
#   · 代码块内 或 低熵 → LOW  + CREDENTIAL_ECHO_SAMPLE_MARKER（默认门槛下不入库）
#   · 其余（非代码块 + 高熵） → MEDIUM + CREDENTIAL_ECHO_REAL_MARKER
# CREDENTIAL_ECHO_REAL_MARKER 同时是读侧降噪的**保护标记**：带它的事件绝不允许被历史噪音谓词隐藏。
CREDENTIAL_ECHO_SAMPLE_MARKER = "[示例形态]"
CREDENTIAL_ECHO_REAL_MARKER = "[疑似真实凭据]"
