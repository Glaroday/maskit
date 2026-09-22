<p align="center">
  <img src="frontend/public/favicon.svg" width="96" height="96" alt="Maskit Logo" />
</p>

<h1 align="center">Data Maskit (数据面具)</h1>

<p align="center">
  <strong>专为大模型打造的本地隐私脱敏与还原网关 · 请求自动结构化打码 · 回复打字机无感还原 · 100% 本地运算零遥测</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-AGPL--3.0-blue.svg" alt="License: AGPL-3.0"></a>
  <a href="https://github.com/xiaYuTian11/maskit/releases"><img src="https://img.shields.io/github/v/release/xiaYuTian11/maskit?display_name=tag&color=emerald" alt="Release"></a>
  <a href="https://github.com/xiaYuTian11/maskit/actions/workflows/ci.yml"><img src="https://github.com/xiaYuTian11/maskit/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://linux.do/"><img src="https://img.shields.io/badge/Community-LINUX%20DO-2563eb?logo=linux&logoColor=white" alt="LINUX DO"></a>
  <a href="https://github.com/xiaYuTian11/maskit"><img src="https://img.shields.io/badge/QQ%E7%BE%A4-489926214-12B7F5.svg" alt="QQ Group"></a>
  <img src="https://img.shields.io/badge/Desktop-Windows%20%7C%20macOS-blueviolet.svg" alt="Desktop: Windows | macOS">
  <img src="https://img.shields.io/badge/Docker-amd64%20%7C%20arm64-2496ED.svg?logo=docker&logoColor=white" alt="Docker">
  <a href="README_EN.md"><img src="https://img.shields.io/badge/Language-English-lightgrey.svg" alt="English README"></a>
</p>

<p align="center">简体中文 | <a href="README_EN.md">English</a></p>

---

## 💡 为什么需要 Maskit？

当你在使用 **Cursor、Claude Code、Codex、Pi、OpenCode、ChatGPT 或任意 AI 编程助手** 时，代码中的高危敏感信息往往在不知不觉中被发送到外部模型服务商：

- 🔑 **凭据与密钥**：`sk-proj-...`、`ghp_...`、云厂商 AccessKey、JWT Token、PEM 私钥证书；
- 🌐 **内网资产拓扑**：数据库连接串（`mysql://root:Pass123@192.168.1.50:3306/db`）、私有 IP 地址（`10.x` / `172.16.x` / `192.168.x`）；
- 👤 **业务隐私（PII）**：手机号、身份证、姓名、银行卡、企业内部代号与保密业务词；
- 📄 **文档与业务附件**：上传给 Web 端 AI 分析的 Word（`.docx` / `.doc`）、Excel（`.xlsx` / `.xls`）、PPT（`.pptx`）等文件中的内部数据。

**Maskit 的使命**：在你的开发终端与外部 AI 服务之间架设一道透明的“本地隐私防护网关”——**请求出网前在本地自动打码成结构化占位符，模型回答时毫秒级流式无感还原成原文**！

---

## 🔄 核心原理与真实效果对比

<p align="center">
  <img src="docs/architecture-zh.svg" alt="Data Maskit 工作原理架构图" width="100%" />
</p>

| 阶段 | 内容样例 | 实际效果说明 |
|---|---|---|
| **你的实际输入** | `排查数据库：mysql://root:Pass123@192.168.1.50:3306/db，联系人李四 13800138000` | 包含高危数据库密码与真实联系电话 |
| **大模型收到的内容** | `排查数据库：{{CONNSTR_zkpmqx}}，联系人{{TERM_fnqtsw}} {{PHONE_bcdfgh}}` | 敏感信息全被替换，**外部大模型完全看不到真实数据** |
| **模型生成的回答** | `建议检查 {{CONNSTR_zkpmqx}} 的网络连通性，并让 {{TERM_fnqtsw}} 核对账号权限` | 模型围绕占位符正常理解、推理与作答 |
| **你最终看到的输出** | `建议检查 mysql://root:Pass123@192.168.1.50:3306/db 的网络连通性，并让 李四 核对账号权限` | **本地毫秒级无感还原，开发体验完全不受影响！** |

<details>
<summary><b>🔍 点击展开：查看真实脱敏与还原弹窗截图（含思维链分析与实时高亮对照）</b></summary>
<br />
<p align="center">
  <img src="docs/screenshots/event-detail.png" alt="真实脱敏与还原事件明细" width="85%" />
</p>
</details>

---

## ✨ 核心亮点与功能全景

### 🛡️ 1. 深度脱敏与多轮会话一致性
- **开箱即用规则库**：内置 **21 类**扫描规则，开箱默认开启 **7 类**核心隐私与凭据（API Key、银行卡、数据库连接串、邮箱、身份证、座机、手机号）；其余 14 类（PEM 私钥、JWT、Token、Secret、云厂商 AccessKey、内网/公网 IP、IPv6、MAC、车牌、USCC 统一信用代码、港澳通行证、IBAN 等）默认关闭，可在设置中按需开启，避免冷门高误报规则干扰模型对代码与配置的正常推理；
- **自定义敏感词与正则**：支持一键按分类管理内部人名、项目代号、敏感术语；支持整词匹配边界与自定义正则扩展，采用确定性常驻占位符防失效；
- **多轮会话滑动窗口复用**：独创占位符复用机制。同一长对话中，“张三”在第 1 轮和第 10 轮始终映射为同一个占位符，**大模型逻辑推理完全一致不串号**。

### 🤖 2. 本地 AI 实体识别（NER 语义模型联动）
- **非结构化自由文本识别**：内置轻量级本地 ONNX 语义模型，自动识别正则难以覆盖的人名（NAME）、企业机构（ORG）、详细物理地址（ADDR）；
- **洁净原文抽取 + 单调 OffsetMap 坐标映射**：在未被破坏的洁净原文上做语义抽取，再通过单调坐标映射将实体区间翻译回打码文本，**彻底杜绝规则替换后上下文截断导致的明文残片泄漏**；
- **100% 离线推理**：全部在本地进程内运行，无需任何外部网络调用；该功能**默认关闭**（正则规则已覆盖主要场景），需要时可在设置页一键开启。

### 🌐 3. 浏览器扩展生态（网页版 AI 隐私保护）
- **无缝接入 Web 端大模型**：Chrome/Edge MV3 扩展，**ChatGPT / Claude / DeepSeek 三站已逐站实测并内置授权，装完无需手动添加站点**（仍需在面板开启扩展链路并填入访问令牌）；另有 14 个常见 AI 站点（Kimi、通义千问、腾讯元宝、智谱清言、文心一言、Gemini、Grok、Perplexity、Copilot 等）可在设置中一键授权添加，未实测的站点会明确标注，也支持自定义站点；
- **全链路双通道拦截（Fetch + XHR 双引擎）**：除常规 Fetch 外，深度拦截底层 `XMLHttpRequest` 的请求与流式响应（XHR 响应还原目前覆盖 DeepSeek 网页版），其余站点保持原生行为零干预；
- **文档与附件直传脱敏（ChatGPT / Claude 已适配）**：Web 端上传 Word（`.docx` / `.doc`）、Excel（`.xlsx` / `.xls`）、PowerPoint（`.pptx`）等文件时在本地自动解析并打码出网；**DeepSeek 等尚未适配的站点，上传文件本体不脱敏**（原样透传），扩展会在弹窗中明确提示「附件内容不脱敏」——请勿把含敏感数据的文件传给这些站点；
- **本地拦截打码 + 网页打字机流式还原**：页面发出的 Prompt 在本地引擎打码后出网，回复在网页界面流式还原，支持多轮会话一致性保持。

### ⚡ 4. 毫秒级 SSE 流式接管（真·打字机体验）
- 针对 OpenAI / Anthropic 的 `text/event-stream` 流式响应，逐事件增量还原下发；
- 智能处理跨 chunk 占位符切片与缓冲区拼接，**完全保留官方原生丝滑打字机体验，不卡顿、不迟滞**。

### 🔌 5. 免装根证书 + 原生直连兜底（绝不断网）
- **多端口反代模式**：为不同模型/渠道分配独立本地端口（如 `18701` 对应 OpenAI、`18703` 对应 Anthropic），只需在工具中将 `base_url` 改为本地端口，**无需向操作系统安装自签名 CA 根证书**；
- **Fallback Passthrough 兜底保障**：哪怕你关闭了脱敏代理或退出软件，本地端口依然由轻量底层维持监听并**透明直连转发明文**，**你的 AI 工具绝不会意外断网或报网络错误**！

### 📊 6. 全链路日志、安全审计与成本排行
- **全链路日志明细**：查看每一笔请求的出网打码、上游响应、耗时分布，并提供一键高亮原文对照；
- **被动安全审计与防注入检测**：实时监控模型回复是否存在错误泄露、命令执行等风险，新增**提示词注入检测（Prompt Injection Detection）**，捕捉伪造系统轮次、凭据嗅探与外发指令；
- **Token 用量与费用估算**：支持主流大模型价格智能匹配，直观统计每日调用量与费用支出。

---

## 📸 功能界面概览

| 控制台概览 (Dashboard) | 客户端多端口管理 (Clients) |
|:---:|:---:|
| ![控制台概览](docs/screenshots/dashboard.png) | ![客户端管理](docs/screenshots/clients.png) |
| **实时拦截日志 (Logs)** | **敏感词库与正则 (Words)** |
| ![拦截日志](docs/screenshots/logs.png) | ![敏感词库](docs/screenshots/words.png) |
| **数据统计与成本看板 (Stats)** | **安全审计中心 (Audit)** |
| ![数据统计](docs/screenshots/stats.png) | ![安全审计中心](docs/screenshots/audit.png) |

---

## 🛠️ 万能接入指南（支持任意可配 Base URL 的工具）

接入极简：**在你的任意工具中，只需把 API Base URL 改为 Maskit 对应的本地端口即可**！
> 默认端口映射：OpenAI 协议 `http://127.0.0.1:18701/v1` ｜ DeepSeek 协议 `http://127.0.0.1:18702/v1` ｜ Anthropic 协议 `http://127.0.0.1:18703`（可自由添加修改）

### 1. Cursor
打开 Cursor → `Settings` → `Models`：
- **OpenAI Base URL**：`http://127.0.0.1:18701/v1`
- 填入你的真实 API Key（Maskit 在本地收到后安全转发给上游）。

### 2. Claude Code（配合 cc-switch 一键使用）
- 在 **[cc-switch](https://github.com/farion1231/cc-switch)** 中，将正在使用的 Claude 渠道 **Base URL** 修改为：
  `http://127.0.0.1:18703`
- 或通过终端环境变量启动：
  ```bash
  export ANTHROPIC_BASE_URL="http://127.0.0.1:18703"
  claude
  ```

### 3. Codex / Pi / OpenCode / Aider / 命令行工具
通过环境变量指定本地代理端口即可无感打码：
```bash
# Linux / macOS
export OPENAI_BASE_URL="http://127.0.0.1:18701/v1"
export OPENAI_API_KEY="your-api-key"

# Windows PowerShell
$env:OPENAI_BASE_URL = "http://127.0.0.1:18701/v1"
$env:OPENAI_API_KEY = "your-api-key"
```

### 4. 代码接入（Python / Node.js / LangChain）
```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:18701/v1",
    api_key="your-api-key"
)

# 正常调用，全链路自动本地打码与流式还原
response = client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "排查数据库连接：mysql://root:Pass123@192.168.1.100:3306"}]
)
print(response.choices[0].message.content)
```

### 5. 添加第三方中转站 / 聚合网关（如 One API / New API）
1. 在「客户端管理」点击「添加客户端」；
2. **目标网关**：填入中转商地址（如 `https://api.your-relay.com`）；
3. **本地端口**：填一个未被占用的端口（如 `18709`）；
4. **脱敏路径**：默认已预置主流路径（如 `/v1/chat/completions` 等），直接按需勾选即可；
5. 保存后，外部工具的 Base URL 填 `http://127.0.0.1:18709/v1` 即可正常使用！

### 6. 浏览器扩展（ChatGPT / Claude 等网页版 AI）

网页版 AI 无法配置 API Base URL，可通过 Maskit 专属浏览器扩展实现全自动打码与还原：

1. **安装扩展**：从 [Releases](https://github.com/xiaYuTian11/maskit/releases/latest) 下载 `Maskit_<版本>_extension.zip` 并解压，在 Chrome/Edge 打开 `chrome://extensions` → 开启「开发者模式」→ 点击「加载已解压的扩展程序」选择解压目录（源码用户可直接加载 `extension/` 目录）；
2. **连接面板**：在 Maskit 桌面面板「设置 → 浏览器扩展」开启扩展链路并复制**访问令牌**，填入扩展的设置弹窗中；
3. **启用站点**：`chatgpt.com`、`claude.ai`、`deepseek.com` 三站已内置授权、无需手动添加；其余 14 个预设站点在扩展设置中一键授权添加（未实测的会标注），也支持自定义站点。

> 💡 **状态与排查要点**：
> - **文件与附件脱敏**：ChatGPT / Claude 站点的网页端附件直传与 Office 文档脱敏（`.docx` / `.xlsx` / `.pptx` 及转码 `.doc` / `.xls`）已适配，无需人工预先编辑；DeepSeek 等未适配站点上传的文件本体不脱敏，扩展会弹窗提示；
> - 扩展图标弹窗清晰显示当前状态：绿色（正常脱敏）、黄色（**引擎未启动，明文直通＝不脱敏但不断网**）、红色（令牌无效或开关关闭，**同样直通不脱敏**）；
> - **引擎不可用或令牌失效时扩展默认明文直通**（这是「绝不断网」的设计取舍）；若要求「宁可请求失败也不放行明文」，可在设置中开启「引擎不可用时阻断」；
> - 扩展流量事件在控制台「事件日志」中同步记录，可按入口维度（代理链路 / 浏览器扩展）一键筛选。

---

## 🚀 下载与部署

### 方式 A：桌面客户端（Windows / macOS，推荐个人日常使用）

前往 **[GitHub Releases 发布页面](https://github.com/xiaYuTian11/maskit/releases)** 下载对应平台的最新安装包：

- **Windows 用户**：下载 `Maskit_<版本>_x64-setup.exe`，双击安装运行，系统托盘右键即可启停，支持全自动数字签名（Minisign）无缝在线更新；
- **macOS 用户（Apple Silicon M系列）**：下载 `Maskit_<版本>_aarch64.dmg`，双击打开后将 `Maskit.app` 拖入“应用程序（Applications）”文件夹。
  > 💡 **macOS 首次打开提示**：若打开时提示“无法打开，因为 Apple 无法检查其是否包含恶意软件”，只需在访达中**右键点击 Maskit 选择「打开」**，或在终端执行命令移除隔离属性即可正常运行：
  > ```bash
  > xattr -cr /Applications/Maskit.app
  > ```

---

### 方式 B：Docker 私有网关（推荐团队 / 服务器 / NAS 部署）
**无需下载源码**，直接拉取 GitHub 官方预构建的多架构镜像（原生支持 `linux/amd64` 与 `linux/arm64`），内嵌完整 Web 控制台：

#### 一行命令秒级启动：
```bash
docker run -d \
  --name maskit \
  --restart unless-stopped \
  -p 127.0.0.1:5801:5801 \
  -p 127.0.0.1:18701:18701 \
  -v maskit_data:/data \
  -e MASKIT_PANEL_TOKEN="YourSecretToken123456" \
  ghcr.io/xiayutian11/maskit:latest
```

> 💡 **端口映射与网络访问说明**：
> - `5801`：**Web 控制台端口（必开）**，用于查看仪表盘、管理规则与客户端配置；
> - `18701` 起：**大模型反代端口（按需开启）**。例如默认 18701 对应 OpenAI、18702 对应 DeepSeek。**用几个客户端就开几个端口**（如仅用一个就只映射 18701，用三个就 `-p 127.0.0.1:18701-18703:18701-18703`），不要盲目映射一大排无用端口；
> - **访问地址绑定**：若服务器前置有 Nginx 或仅供本机访问，推荐绑定 `-p 127.0.0.1:5801:5801`；若内网/局域网直接通过 IP 访问容器，去掉 `127.0.0.1:` 前缀改为 `-p 5801:5801 -p 18701:18701`；
> - **控制台令牌（密码）**：`-e MASKIT_PANEL_TOKEN="YourSecretToken123456"` 必须为 **≥16 位纯 ASCII 字符**（请勿包含中文字符，否则引擎将安全回退为启动日志随机 token）。

浏览器打开 `http://<服务器IP>:5801` 即可直接访问，并在弹出的登录窗口中输入你设置的密码即可管理（亦可使用 `http://<服务器IP>:5801/#token=<你的密码>` 快捷免密进入，fragment 不随请求发送、不会进代理访问日志，进入后 Token 会自动从地址栏抹除）。

> **安全建议与反向代理（Nginx 配置参考）**：
> 默认绑定 `127.0.0.1` 本机回环，保护代理端口不直接暴露到公网。若在外部通过 Nginx 挂域名并配置 TLS 反代，**Docker 启动时请务必添加环境变量 `-e MASKIT_TRUST_PROXY=1`**（使面板信任前置 Nginx 传递的 `X-Forwarded-Proto: https` 头部，防止 API 请求被 Origin 校验拦截），参考配置如下：
> ```nginx
> server {
>     listen 443 ssl;
>     server_name maskit.example.com;
>     # ssl 证书配置省略...
>
>     # 1. 控制面板（直接访问域名，在弹出的窗口输入 Token 登录）
>     location / {
>         proxy_pass http://127.0.0.1:5801;
>         proxy_set_header Host $host;
>         proxy_set_header X-Real-IP $remote_addr;
>         proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
>         proxy_set_header X-Forwarded-Proto $scheme;  # 关键：告知后端外部协议为 https
>         proxy_set_header X-Forwarded-Host $host;
>     }
>
>     # 2. 模型反代端口（如 OpenAI，关闭缓存保证打字机流式顺畅；建议配合内网白名单）
>     location /openai/ {
>         proxy_pass http://127.0.0.1:18701/;
>         proxy_set_header Host $host;
>         proxy_buffering off;
>         proxy_read_timeout 600s;
>     }
> }
> ```

#### 进阶：单端口模式（Docker 只开一个反代端口）

如果不想为每个客户端映射一个端口，可以用**单端口前缀模式**：所有客户端共用 5802 反代端口，靠路径前缀区分。在控制台「客户端管理」中，每个客户端的 **路径前缀（base_path）** 就是客户端 `base_url` 的路径部分：

```bash
docker run -d \
  --name maskit \
  --restart unless-stopped \
  -p 127.0.0.1:5801:5801 \
  -p 127.0.0.1:5802:5802 \
  -v maskit_data:/data \
  -e MASKIT_PANEL_TOKEN="YourSecretToken123456" \
  ghcr.io/xiayutian11/maskit:latest
```

假设你配置了两个客户端（路径前缀分别为 `/openai` 与 `/anthropic`），外部工具的 Base URL 填：

| 客户端 | Base URL |
|---|---|
| OpenAI 协议（前缀 `/openai`） | `http://<服务器IP>:5802/openai/v1` |
| Anthropic 协议（前缀 `/anthropic`） | `http://<服务器IP>:5802/anthropic` |

> 💡 **多端口 vs 单端口怎么选**：多端口（18701 起）每个客户端独立端口、`base_url` 最短，适合个人本机使用；单端口只映射一个 5802，适合容器端口受限或统一走 Nginx 前缀转发的场景。两种模式可以并存——5802 上的前缀路由与各客户端独立端口同时生效。

---

### 方式 C：从源码运行与开发

```bash
git clone https://github.com/xiaYuTian11/maskit.git
cd maskit

# 1. 安装核心依赖
pip install -r requirements.txt

# 2. 构建前端并启动引擎（若仅需控制台 API，可跳过前端构建）
cd frontend && npm install && npm run build && cd ..
python engine/panel.py

# 3. 前端界面二次开发（Vite 热重载，推荐）
cd frontend && npm run dev
```

> 💡 **测试提示**：日常修改可运行 `python scripts/verify-all.py` 执行本地全量门禁（含单测、构建、Lint、版本一致性等 15 项检查）。若修改了扩展核心代码，可运行 `python tests/e2e_ext_bridge.py` 执行真实浏览器端到端冒烟测试。

---

## 💬 社区与交流

- **官方 QQ 交流群**：**`489926214`**（欢迎加入交流讨论，获取最新规则与版本动态）；
- 论坛交流：**[LINUX DO 社区讨论专区](https://linux.do/t/topic/2884715)**；
- 建议反馈：[GitHub Issues](https://github.com/xiaYuTian11/maskit/issues) 与 [GitHub Discussions](https://github.com/xiaYuTian11/maskit/discussions)；
- 安全漏洞：私密反馈渠道见 [SECURITY.md](SECURITY.md)。

---

## 📜 开源协议

Data Maskit 基于 **[GNU AGPL-3.0](LICENSE)** 许可证发布。个人开发者、研究人员及开源项目均可完全免费使用。如需在闭源商业产品中分发或集成，请遵循 AGPL-3.0 相关条款。

<p align="center">
  Made with ❤️ by TMW & Contributors.
</p>
