# Go 网关 SDK 与管理 UI 接入验证

验证日期：2026-11-14。本文保留接入前的原型实验记录；产品代码的验收结果见 [实施记录](embedded-go-gateway-implementation.md)。

对应 [网关方案讨论稿](embedded-go-gateway.md)。本次只进行隔离实验，
没有修改 Emdash 启动路径、用户登录、供应商配置或应用数据库。

## 1. 结论

两轮隔离验证已完成：第一轮测试 v6 基础接口；第二轮使用固定的 v8 commit，
跑通实际 SDK HTTP 服务、配套 UI 登录、管理配置读写、会话路由、取消和用量提取。
实际 Codex CLI 通过 SDK 与两个 mock 上游完成了同一 thread 的续聊和历史传递。

发现两项需要调整方案的问题：默认 Responses HTTP handler 丢失 middleware 中的账号绑定
context；`data:` 宿主页 iframe 使 UI 的 localStorage 访问失败。
显式 SDK 执行适配和隔离 WebContentsView 分别通过验证，详见第 8 节。
真实模型、完整 OAuth 换取与刷新、正式 Emdash 设置页仍未验证。

## 2. 环境与版本

| 项目 | 本次使用 |
| --- | --- |
| 平台 | macOS arm64 |
| Go | 1.27.1 |
| SDK 外部模块测试 | CLIProxyAPI v6.10.9；模块自身要求 Go 1.26.0 |
| SDK 主分支源码核对 | `1aaf56bc6a0fc6fce19049ba7ae8554c882304a6`，模块路径 v8 |
| UI 源码 | `3d893ec88938c3ceef200a15be6af8cf972564b3` |
| UI 构建工具 | 隔离目录中的 pnpm 11.6.0，hoisted 依赖布局 |
| 浏览器检查 | Playwright Chromium，headless |

UI 上游声明 Bun。本次仅在临时副本移除 `packageManager` 声明以使用 pnpm，
并禁用依赖安装脚本；未修改业务源码。下载的源码副本中 550 个 `src` 文件与上述 UI commit 一致。
依赖按上游声明范围解析，没有验证上游 Bun 锁文件的精确重现。
Emdash 根目录的 package.json、pnpm-lock.yaml 均未变动。

## 3. 已执行的测试

| 测试 | 结果 | 证明范围 |
| --- | --- | --- |
| Go 原型 `go test -race -count=1 -v ./...` | 通过，2 项 | 本地 mock Responses 上游、实际 Codex CLI 续聊、会话隔离、用量文件保留、拒绝非 loopback 上游 |
| SDK `TestExternalBuilder` | 通过 | 外部模块通过公开 `sdk/config` 调用 Builder；没有启动 HTTP 服务 |
| SDK `TestUsageCallback` | 通过 | 发布模拟用量记录后收到正确的 token 数；没有验证真实上游用量解析 |
| SDK `TestPinnedAccount` | 通过 | 模拟执行器依次使用 A、B、A；指定不存在的账号时返回错误，没有使用其他账号 |
| SDK 上述测试的 race 检查 | 通过 | 该测试覆盖范围内未报告数据竞争 |
| UI 默认 pnpm 隔离布局构建 | 未通过 | 暴露上游依赖未直接声明的问题 |
| UI hoisted 布局构建 | 通过 | `tsc && vite build` 生成单 HTML |
| UI 浏览器启动 | 通过 | 本地 HTTP 打开登录页，标题和登录控件正常，未捕获 `pageerror` |

UI 构建产物最终大小为 4,161,568 字节，构建报告 gzip 约 1.36 MB。
SHA-256 为 `8804108231bfc60d6f4784649b9e9ac2736a69224d12c6906dc3ac3d89c74289`。
它是整套管理应用的大小，尚未裁剪供应商、账号和 OAuth 页面。

## 4. 源码核对结果

### 4.1 SDK 可使用公开配置包

v6.10.9 和查阅的 v8 源码都有 `sdk/config`，可避免外部项目直接导入 `internal/config`。
v6.10.9 在第一轮编译验证；v8 外部编译、运行与 UI 联通在第二轮完成。

### 4.2 用量回调可复用，长期保存需补充

v6.10.9 的 `usage.Record` 不包含请求 ID、会话 ID，v8 主分支有这些字段。
不能把主分支字段当作所有版本都提供的保证。

查阅的两个版本中，SDK 用量分发器和 `internal/redisqueue` 使用内存结构。
后者提供过期和弹出消费行为，名称不代表已经部署 Redis 或磁盘账本。
因此已检查的这条用量路径不满足重启保留要求，应补充持久接收器，
或继续评估所选版本的其他存储扩展；本次没有证明整个项目不存在其他持久化组件。

### 4.3 账号绑定有公开扩展点

v6.10.9 的 `executor.PinnedAuthMetadataKey` 可以把直接执行限制到指定账号。
模拟执行测试已通过。尚未证明配套 HTTP handler 会传递我们的会话路由约束，
也未验证失效账号、限流、流式重试等边界。

### 4.4 OAuth 页面与存储适配点存在

UI 包含 `/oauth` 页面及授权开始、状态查询、取消和回调提交接口；
Codex 等 provider 出现在其授权接口定义中。这属于源码核对，真实授权没有执行。

SDK 提供 `sdk/auth.RegisterTokenStore` 扩展点，默认实现为文件存储。
管理 UI 在用户选择记住密码时会持久化管理 Key。
正式接入需要验证 TokenStore、配置写入和 UI 认证如何适配 Emdash 的加密存储，
不能把默认存储方式直接视为符合宿主要求。

### 4.5 UI 和 SDK 需要匹配版本

构建的 UI 声明 `/v8/management` 管理 API。
v6.10.9 的服务注册 `/v0/management`，OAuth 路由结构也有差别。
第一轮没有将这两个不同版本拼接。第二轮改用匹配 v8 管理接口的 SDK，完成了基本联通；
仍不把它视为所有兼容回退逻辑都已验证。

SDK 与 UI 的 LICENSE 均为 MIT，分发时需保留相应版权及许可证文本。
这项核对不覆盖所有传递依赖的许可证。

## 5. 可复现测试

SDK 测试源和独立 go.mod/go.sum 保存在
`apps/emdash-desktop/tooling/prototypes/go-gateway/sdk-validation/`。
它是嵌套实验模块，不加入 Emdash 应用依赖和启动路径。

```bash
cd apps/emdash-desktop/tooling/prototypes/go-gateway/sdk-validation
go test -race -count=1 -v ./...
```

Go mock 网关原型的命令为：

```bash
cd apps/emdash-desktop/tooling/prototypes/go-gateway
go test -race -count=1 -v ./...
```

临时上游源码、UI 依赖、构建产物和浏览器截图位于 `/tmp/emdash-sdk-validation/`，
没有加入仓库。没有把整个上游 UI 或生成的 HTML 复制进 Emdash。

## 6. 实施前仍需验证

- 选择正式 SDK／UI 发布版本，回归第二轮已验证的管理读写和执行适配。
- 完整 OAuth 回调换取、刷新、退出登录及加密存储。
- 真实会话的模型能力同步、完整 SSE 分帧、工具循环和不兼容字段处理。
- 真实供应商的工具调用、取消、压缩和跨供应商续聊兼容性。
- Emdash 实际设置页的认证交付、授权浏览器跳转、焦点和页面生命周期。
- 加密凭据保存、Token 刷新和退出登录；需要用户交互的真实授权单独验证。
- 持久用量的去重、崩溃恢复和清理策略。
- Go 服务退出、端口变化后的会话恢复，以及各平台打包。

## 7. 固定版本参考

- [SDK v6.10.9 公开配置 API](https://github.com/router-for-me/CLIProxyAPI/blob/v6.10.9/sdk/config/config.go)
- [SDK v6.10.9 用量接口](https://github.com/router-for-me/CLIProxyAPI/blob/v6.10.9/sdk/cliproxy/usage/manager.go)
- [SDK v6.10.9 账号绑定字段](https://github.com/router-for-me/CLIProxyAPI/blob/v6.10.9/sdk/cliproxy/executor/types.go)
- [管理 UI 固定版本](https://github.com/router-for-me/Cli-Proxy-API-Management-Center/tree/3d893ec88938c3ceef200a15be6af8cf972564b3)

## 8. 第二轮：v8 HTTP 服务、UI 与 Electron 验证

### 8.1 固定版本

SDK 使用 `1aaf56bc6a0fc6fce19049ba7ae8554c882304a6`，对应 Go 模块版本
`v8.0.70-0.20261112185239-1aaf56bc6a0f`；UI 仍使用第 2 节所列 commit。
先通过本地源码替换编译，再移除该替换，从 Go 模块代理下载固定版本并重新执行测试通过。
两种方式都未修改 SDK 业务源码。

上游依赖 `MoeForge/moego` 使用了 module replace。
外部模块必须显式重复该替换为 `router-for-me/moego v0.1.2`，
因为 Go 不继承依赖模块的 replace。这项要求已记录到独立实验模块中。

### 8.2 已执行的检查

| 测试 | 结果与限制 |
| --- | --- |
| v8 外部 Builder、用量回调、指定账号执行 | 3 项通过，并通过 race 检查 |
| 实际 SDK 服务管理认证 | 正确管理 Key 返回 200，错误 Key 返回 401；测试使用固定假 Key |
| 数据请求认证 | 执行适配层拒绝错误客户端 Key |
| 模型目录 | `/v1/models` 返回配置的 mock 模型 |
| 显式执行适配后的路由 | one 从 A 切到 B，two 保持 A，9 次成功请求包含并发检查 |
| 上游认证 | mock 上游确认收到对应的假供应商 Key |
| 流式取消 | 客户端关闭连接后，取消到达 mock HTTP 上游 |
| SDK 内置 Codex 执行器的 usage 解析 | 9 条成功用量均提取到输入 7、输出 3 和非空执行 ID |
| 管理配置读写与保存 | request-retry 从 0 改为 1，API 和磁盘均读到 1，再恢复 0 |
| 实际 Codex CLI 续聊 | 临时 CODEX_HOME 中启动，再切到 B 后 resume；thread 不变，旧消息与新问题到达 B |
| Chromium 中管理 UI 登录 | 登录成功，看到两个 mock 供应商 Key 和管理数据，无 pageerror |
| Electron WebContentsView | 在独立测试容器中登录，供应商页和 OAuth 页加载成功 |
| 页面权限检查 | 管理页面中的 require、process、electronAPI 均为 undefined |
| OAuth 授权发起 | Codex 返回 auth.openai.com 授权 URL、S256 PKCE、localhost 回调地址，状态为 wait |
| OAuth 取消与无效状态 | 取消返回 cancelled=true；无效 provider 和非待定 callback 被拒绝 |

实际 Codex CLI 的上游仍是本地 mock。测试证明了 CLI 与 SDK 链路下的 thread 和历史传递，
没有证明真实供应商接受彼此的推理、工具调用或服务端响应标识。

用量接收器把过滤后的字段写入临时测试文件，便于断言。
它不包含生产级去重、崩溃恢复、数据库投影或保留策略。
测试会另存 mock 请求内容检查历史传递，这不代表产品将保存完整请求日志。

### 8.3 默认 HTTP handler 丢失账号绑定

测试先通过 `WithMiddleware` 把 `handlers.WithPinnedAuthID` 写入请求 context。
固定会话选择 A，连续 4 次调用默认 Responses handler，观察到 A、B、A、B，绑定未生效。

源码核对显示默认 handler 构造执行 context 时仅继承部分请求信息，
没有继承该绑定字段。这与 SDK 直接执行接口能正确绑定账号的测试不矛盾。

实验适配层直接以显式绑定 context 调用 `ExecuteStreamWithAuthManager`，
随后会话切换、并发和取消均通过。该适配层只处理测试上游输出的完整 SSE 行，
没有覆盖任意分片、完整错误协议或工具调用循环，不能直接作为生产实现。

此外，内置 Codex 执行器会变换 payload；观察到 input 归一化、推理字段和工具注入。
因此第三方 Responses 供应商不能默认视为可以无差别使用该执行器。
正式设计需要按供应商能力选择透传或适配，并验证功能开关。

### 8.4 Electron 嵌入方式

`data:` 宿主页中的 sandbox iframe 虽可加载 UI 地址，
但页面因 localStorage SecurityError 崩溃。这是该来源组合的实测结果，
不代表所有 iframe 场景都无法工作。

改用 WebContentsView：启用 sandbox 和 contextIsolation、禁用 Node 集成、
不配置 preload，使用独立内存 partition 和临时 Electron userData，
管理 UI 登录、供应商页和 OAuth 页均通过。
测试没有向 Emdash 实际窗口注册页面，也没有验证宿主 Wire 接口或免输入登录。

该容器是方案建议的承载方式。仍需处理设置页边界、焦点、布局变化、
销毁和 OAuth 弹窗跳转，不以关闭 webSecurity 作为接入手段。

### 8.5 复现与后续

实验位于 `apps/emdash-desktop/tooling/prototypes/go-gateway/sdk-v8-validation/`，
包含固定依赖、SDK 基础测试、服务 probe、HTTP 检查和 Codex 续聊检查。
使用方法和测试局限写在该目录 README 中。

Electron 与 UI 检查脚本、截图和测试结果保留在 `/tmp/emdash-sdk-validation/`。
真实 OAuth 的用户授权、Token 换取、刷新与持久保存需要单独验证；
本轮发起的待定授权已取消，没有获取真实账号 Token。
