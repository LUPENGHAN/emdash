# Terminal agent 文件短链

状态：已接受并实现。Codex 0.171、Emdash live 终端和浏览器测试已验证。

## 问题

Agent 在终端回复中引用本地文件时，需要满足两个条件：

* 正文只显示简短名称，例如“Codex 启动策略”。
* 名称使用链接样式，点击后在当前 Emdash 任务的编辑器中打开文件。

直接使用本地路径、`file://` 或普通 HTTPS Markdown 链接都不能同时满足这两个条件。
Codex 0.171 对这些目标有不同处理：

* 本地 Markdown 目标会进入 Codex 的 Document 链路。开启 TUI Workspace 时，点击会打开
  Codex 自己的文档侧栏，不会向宿主终端发出可供 Emdash 接管的 OSC 8 文件目标。
* 关闭 TUI Workspace 后，本地目标会显示为“名称（完整路径）”。路径可以点击，但正文暴露了
  完整目录。
* Web Markdown 目标能够产生 OSC 8 链接。Codex 只在确认终端支持语义链接时隐藏目标地址；
  `TERM_PROGRAM=emdash` 在 Codex 0.171 中属于未知终端，因此它会显示“名称（完整 URL）”。

单纯修改 xterm 的颜色和下划线只能改变样式，不能删除 Codex 已经写入终端缓冲区的路径或
URL。对终端输出做字符串截断也不可取，因为 TUI 输出包含 ANSI 光标移动、分块写入和屏幕重绘。

## 决策

Emdash 使用一个内部 HTTPS 形态的文件目标，并在终端边界把它转换回本地文件打开操作：

```text
https://open-file.emdash.invalid/open?path=<percent-encoded-absolute-path>
```

Agent 输出的 Markdown 示例：

```markdown
[Codex 启动策略](https://open-file.emdash.invalid/open?path=%2Fworkspace%2Fsrc%2Fcodex%2Findex.ts)
```

用户在终端中只看到蓝色、带下划线的“Codex 启动策略”。链接目标不会作为正文显示，点击后由
Emdash 在当前任务编辑器中打开文件。

`.invalid` 是保留的无效顶级域。该地址只用于终端内的能力编码，不应发出网络请求。Emdash
必须在外部链接处理之前识别它；无法通过严格校验的目标不得按本地文件执行。

## 执行链路

一次文件短链经历以下步骤：

1. Emdash 启动 Codex 时关闭 `features.tui_workspace`，阻止 Codex 接管文件点击并打开自己的
   文档侧栏。
2. Emdash 向 Codex 加入文件引用规则，要求使用简短 Markdown 标签和内部 HTTPS 目标。普通
   Web 链接不变。
3. Codex 会话使用 `TERM_PROGRAM=vscode`。Emdash 的终端基于 xterm.js，并支持 Codex 针对
   VS Code 终端所依赖的 OSC 8 行为。该兼容标识只用于 Codex，其他 Agent 仍看到
   `TERM_PROGRAM=emdash`。
4. Codex 将名称渲染为只有标签可见的 OSC 8 链接。
5. `FrontendPty` 在点击时调用 `classifyOscLink`。内部目标通过校验后返回本地文件路径，不进入
   外部浏览器确认流程。
6. 终端处于鼠标上报模式时，点击屏蔽层消费按下和释放事件，防止同一次点击同时发送给 TUI。
7. 编辑器文件回调在当前任务上下文打开目标。

已有路径格式继续兼容。`file://`、绝对路径、任务相对路径和带 `:line[:column]` 或
`#Lline[Ccolumn]` 后缀的 OSC 目标仍可被识别。普通文本路径也保留文件链接 Provider 和鼠标
上报模式下的点击屏蔽。短链协议是推荐输出格式，兼容路径用于历史输出和其他 Agent。

## 安全边界

终端输出不可信。内部短链按以下规则处理：

* 使用 `new URL()` 解析，并精确比较 `origin` 和 `pathname`。不使用 `startsWith()`、
  `includes()` 或相似的域名字符串判断。
* 只接受 `https://open-file.emdash.invalid/open`。
* 只允许一个 `path` 查询参数。重复参数、额外参数、用户名、密码和 fragment 全部拒绝。
* 解码后的目标必须是可识别的本地路径，不允许控制字符或网络路径形式。
* 内部 origin 匹配但负载无效时返回 `invalid-file`，终端显示错误且不把点击交还给 TUI。
* 相似域名不获得本地文件能力。例如 `open-file.emdash.invalid.example` 仍按普通 Web 链接处理。
* 其他未知协议不由 Emdash 接管。

这个协议只授予“请求当前任务打开一个路径”的能力。实际文件读取和编辑仍经过任务编辑器已有的
路径与 Host 边界。

## 实现位置

Codex 启动和输出约定：

* `packages/plugins/src/agents/impl/codex/index.ts` 添加启动参数和文件短链开发者指令。
* `apps/emdash-desktop/src/core/features/model-providers/node/codex-base-instructions.md` 记录未知
  网关模型使用的相同输出约定。
* `apps/emdash-desktop/src/core/features/conversations/node/tui-conversation-provider.ts` 只为 Codex
  会话声明 xterm.js 兼容的终端能力。

终端识别和打开：

* `apps/emdash-desktop/src/core/features/terminals/browser/pty/terminal-image-link.ts` 解析内部短链、
  `file://` 和路径型 OSC 目标。
* `apps/emdash-desktop/src/core/features/terminals/api/browser/pty/pty.ts` 拦截点击并选择任务内打开、
  外部打开或拒绝。
* `apps/emdash-desktop/src/core/features/terminals/api/browser/pty/file-link-provider.ts` 处理终端正文
  中没有 OSC 元数据的文件路径。

## 验证

自动验证覆盖以下情况：

* 内部短链解码为本地路径，行号后缀不会进入文件名。
* 缺少路径、相对单文件名、重复参数、额外参数和 fragment 被拒绝。
* 相似域名不能获得本地文件能力。
* 真实 Chromium/xterm 中只显示短标签，点击调用任务文件打开回调，不调用外部链接或外部文件
  回调，也不向 TUI 注入鼠标事件。
* OSC 8 在鼠标模式 9、1000、1002 和 1003 下只触发一次。
* 普通 Web 链接、图片、本地源文件、Unicode 路径、软换行和拖动选择保留原有行为。
* Codex 启动命令包含 `features.tui_workspace=false`、文件短链指令和 `--no-daemon` 能力协商。
* Codex 会话得到 `TERM_PROGRAM=vscode`，其他 Agent 保留 `TERM_PROGRAM=emdash`。

实施时运行并通过：

```text
terminal-image-link.test.ts                         32 tests
tui-conversation-provider.test.ts + link unit tests 51 tests
terminal-links.test.tsx                             66 browser tests
packages/plugins Codex tests                         2 tests
desktop and plugins typecheck
targeted desktop and plugins lint
```

live 验收还检查了恢复后的 Codex 进程环境：

```text
TERM=xterm-256color
TERM_PROGRAM=vscode
FORCE_HYPERLINK=1
```

随后在实际 Emdash 对话中确认正文只显示短名称，名称为蓝色并带下划线，点击在 Emdash 编辑器中
打开文件。

## 维护规则

升级 Codex 时需要重新检查三处行为：

* `features.tui_workspace` 是否仍控制 Codex 内部 Document 链路。
* Codex 的 Web 链接可见性策略是否仍通过终端识别决定。
* Codex 是否原生识别 `TERM_PROGRAM=emdash`。如果已经识别并按标签模式输出，应删除
  `TERM_PROGRAM=vscode` 兼容覆盖。

测试不能只断言链接可点击。验收必须同时断言可见文本不包含本地路径或内部 URL，并确认点击不会
传入 TUI 或打开系统浏览器。

历史终端输出不会重新渲染。升级或重启只影响随后生成的回复。

带行号的目标会先去除行号后缀再打开文件。编辑器回调目前只接收路径，因此短链不会定位到具体
行；增加行号跳转时，应扩展结构化文件打开契约，不把行号重新拼进文件名。
