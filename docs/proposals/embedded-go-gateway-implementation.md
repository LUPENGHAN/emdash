# 统一供应商与本地路由实施记录

更新：2026-11-15。原设计见 [方案](embedded-go-gateway.md)。

供应商统一放在原来的 **设置 → Providers** 页面。路由随应用启动，不再嵌入供应商管理网页，也不再维护两套 API Key 配置。三种协议都在原生表单中选择：OpenAI Responses、OpenAI Chat Completions、Anthropic Messages。

## 使用流程

1. 在 Providers 添加地址、协议、API Key 和模型；也可在路由授权账号中连接 Codex 或 Claude OAuth。
2. 创建本地会话时选择供应商和模型。选择器根据 Agent 支持的协议过滤可用来源，新供应商选择通过本地路由。
3. 会话来源显示 `本地路由 → 供应商`。Providers 的“会话路由”列出当前供应商、模型和待生效切换。
4. 切换同类型账号、同协议、同模型、同上下文窗口时，等 Agent 空闲后生效，其他会话不变。不同模型、协议或账号类型沿用受控重启路径。
5. “路由用量”查看独立请求账本，删除聊天不删除这些记录。

原生官方登录继续放在 Official accounts；路由 OAuth 在同一 Providers 页的“路由授权账号”。后者通过系统浏览器授权，支持 SDK 回调和手动粘贴回调 URL。OAuth 入口已接入，真实登录、刷新及官方请求尚未验收。

已有直连会话和历史默认值保留 provider 身份；不会自动改写历史会话。原生 Codex 历史会话切为网关仍需新建会话。远程 Agent 保持直连，本机回环入口不会注入远程进程。

## 一个供应商的多协议配置

Providers 默认提供多协议配置：公共 Base URL、默认 API Key、三种协议的启用开关。已启用协议可分别覆盖 URL 与 Key；地址留空继承公共 Base URL，Key 留空继承默认 Key。可以只配置独立 Key，不提供默认 Key。未启用的协议不会尝试请求，缺少可用 Key 时拒绝请求，不使用其他协议的 Key。

OpenAI Chat Completions 与 OpenAI Responses 独立配置和转发；Responses 的 compact 路径也保留。Anthropic Messages 是第三种协议。各协议共享供应商名称、模型列表与模型元数据，供应商只需添加一次。

“默认启动协议”用于新建 OpenCode、Pi、Oh My Pi 会话，可选自动、Chat Completions、Responses 或 Messages。Claude Code 固定使用 Messages，Codex 固定使用 Responses；本次没有增加协议转换。已有 Agent 改变请求协议仍需重启，修改地址或 Key 会由路由用于后续请求。

默认和独立 Key 在编辑页面直接显示，可复制；原来的加密存储继续保留。Key 不写入供应商设置记录。原文件导入导出也支持这些地址和独立 Key，只有勾选包含 Key 时才写入导出文件，导入预览不展示 Key。

## 组件与数据归属

| 组件 | 职责 |
| --- | --- |
| 原生 Providers 页面 | 唯一 API 供应商编辑入口，路由状态、账号授权、会话路由和用量 |
| model-providers | 原有供应商定义、协议能力、模型目录和 Agent 启动配置 |
| ModelGatewayService | 默认启动 Go、稳定回环入口、按会话绑定账号、切换、恢复和账本接收 |
| Go 子进程 | CLIProxyAPI SDK 原生 OAuth 账号；三种 API 协议的指定账号转发和用量采集 |
| encrypted secret 服务 | API Key、OAuth 凭据、路由签名密钥，以及旧配置兼容信息 |
| 独立 SQLite KV 账本 | 持久请求用量，不依赖聊天文件 |

原供应商定义和 Key 服务是 API 配置的唯一来源；Go 接收运行时投影。旧版网关的加密供应商配置首次恢复时并入原列表，保存旧 ID 映射、模型别名和必要请求头，避免重复配置或丢失旧路由。

没有增加数据库表或迁移。MCP、Skills、指令、hooks 沿用 Emdash 已有能力。未引入记忆、费用估算或本地内容脱敏。

### 路由与持久化

- 主进程持有稳定 HTTP 入口，Go 重启不改变已运行 Agent 的地址。失败请求不会自动重放。
- 每个会话持有独立能力令牌，只能访问自己的路由；已删除或非本地会话拒绝请求。
- Codex CLI/ACP 使用稳定的 `custom-gateway` 身份。ACP 在 app-server 启动时和每个线程上配置一致的 provider；其他支持供应商配置的 Agent 使用稳定网关标识。
- Go 严格使用指定账号，模型或账号不可用时拒绝，不回退到其他供应商。
- 三种协议按客户端要求转发，支持流式与非流式。模型别名在上游边界替换；不保证任意协议转换或任意模型历史兼容。
- Go 先写 Bolt outbox，主进程账本提交后才确认。未确认事件重启后补记，重复事件按 ID 去重。
- 用量只保存账号、模型、时间、Token 和状态，不保存提示词或回答。明确的零用量与缺失用量分开表示。
- API Key 与 OAuth 凭据不写明文配置文件。原管理网页、WebContentsView、网页构建和相关 UI 资源已移除。

## 验证

本地 HTTP 模拟上游验证了三种协议的流式和非流式请求、模型别名、授权头、Anthropic 客户端 `x-api-key`、count_tokens、独立用量、路由列表、移除供应商后拒绝请求，以及旧配置一次性迁移和恢复。

实际 Go 子进程与两个模拟 Responses 上游验证了并行会话隔离、忙碌切换、停止恢复、outbox 重放去重、删除会话后保留用量，以及加密恢复。实际 Codex 0.167.1 CLI 新建和 resume、应用内 codex-acp adapter 同会话两轮分别走 A/B，B 收到第一轮上下文。

本轮针对性节点回归 8 个文件、103 项通过，包含真实 Codex CLI 与 ACP 模拟上游测试。多协议与独立 Key 回归包括指定协议的独立地址、默认 Key 回退、独立 Key 优先、无默认 Key、缺少 Key 时拒绝、禁用协议后拒绝、默认启动协议、加密存储独立性和导入导出。Go `go test -race ./...` 和 `go vet ./...` 通过。桌面节点与浏览器类型检查、生产构建和原生 Electron 页面 smoke 通过；变更文件 lint 无错误（保留一处原有的类型导入警告）。

Electron smoke 使用隔离用户目录和数据库，验证了自动运行、三种协议各自新增保存、一个供应商保存三种地址、公共 Base URL、启动协议选择、重开后明文显示默认与独立 Key、复制到剪贴板、原生授权按钮，以及没有嵌套管理网页，并输出截图。复测命令见 [模块说明](../../apps/model-gateway/README.md)。没有用个人账号或付费上游。

### 全仓检查记录

上一轮已运行 `pnpm run check`，格式、lint、类型检查阶段通过；桌面全仓测试首次为 6087 通过、26 失败、8 跳过。本功能引入的 QueryClient mock 等失败已修复并通过针对性回归，ACP 启动布局另测 18 项通过。

全仓不能标记通过。剩余问题包括迁移身份校验、legacy-port 导入和部分浏览器断言或超时。HEAD journal 48 项、HEAD golden 47 项的不一致与本功能无关，没有为消除失败改写迁移数据。

## 未覆盖

- 真实账号 OAuth 授权、刷新、撤销、官方请求和用量核对。
- 不同真实供应商对推理内容、工具结果、压缩数据和服务端 response ID 的兼容性。
- 所有 Agent CLI 的逐个端到端验证；目前真实客户端验证集中在 Codex CLI 与 ACP。
- Windows/Linux 安装包运行、签名和发布。
- 远程路由、原生历史会话迁移、费用估算、内容脱敏、记忆。
