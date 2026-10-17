# Todo

每一项的详细执行方案和审查方案在 [plans/](plans/README.md)。

## 续写要能记多个任务

执行方案：[plans/01-resume-writing-jobs.md](plans/01-resume-writing-jobs.md)

现在的续写设置只能记一个任务：`resumeWriting` 里只有一组项目、任务、会话。可能有多个任务都需要续写，每个任务各自有定时、用量窗口重置和官方账号额度的触发。

要改成一份任务列表，每条独立配置、独立发送，互不影响。

## 远程访问要能从应用里传出去

执行方案：[plans/02-remote-access-tunnel.md](plans/02-remote-access-tunnel.md)

现在公网访问靠应用外面的 `cloudflared`：远程访问只监听本机 `127.0.0.1:7788`，隧道、DNS 和开机自启都要自己配（见 `docs/remote-access-cloudflare.md`）。

希望在应用里原生就能把这台电脑传出去，比如内置 frp，或者其他同类方案。方案还没定，先比较再做：frp 需要一台有公网地址的服务器；Cloudflare Tunnel、Tailscale 之类不需要自己的服务器。要看安装、登录、子域名和开机自启能不能都放进设置，而不是再维护一份应用外面的配置。

## 用 GitHub 链接直接导入 skill

执行方案：[plans/03-github-skill-import.md](plans/03-github-skill-import.md)

现在没法贴一个仓库链接（比如 `https://github.com/LUPENGHAN/sales`）就把里面的 skill 装上：

- 没有这个入口。技能库只能从内置目录安装或新建；唯一能贴 GitHub 链接的是已装 skill 的「来源」（`setSkillSource`），只管检查和拉取更新。
- 私有仓库读不到。`skill-sources.ts` 的 `fetchGitHub` 和 `updateSkill` 里下载 `raw.githubusercontent.com` 的请求都不带 token，私有仓库一律 404，匿名请求每小时还只有 60 次。
- skill 不一定在仓库根目录。`sales` 的 skill 在 `.agents/skills/customer-analysis/`，其余都是文档。

`customer-analysis` 已手动复制进 `~/.agentskills`（`sales` 的 `f454ff2`），没有设来源：私有仓库现在检查更新会失败。功能做好后用新入口重新导入一次，把来源补上。

### 做法

1. **GitHub 请求带 token**（`agent-library/node/skill-sources.ts`）
   - `fetchGitHub` 和文件下载改成可以传入 token：有 token 时加 `authorization: Bearer <token>`。
   - token 取应用里已登录的 github.com 账号（`features/github/node/accounts` 那套，`getOctokit` 用的同一个），由 `agent-library-service` 注入，`skill-sources.ts` 不直接依赖 GitHub 账号模块。
   - 文件下载从 `raw.githubusercontent.com` 改成 `GET /repos/{repo}/git/blobs/{sha}`（base64），和其他请求走同一套认证，公开、私有仓库都一样；`remoteSnapshot` 里已经有每个文件的 sha。
   - 没登录账号时照旧匿名；遇到 404 时提示「仓库不存在或是私有仓库，请先在设置里登录 GitHub」。
   - 顺带解决检查更新撞匿名次数限制的问题。

2. **扫描仓库里的 skill**（新函数 `scanGitHubSkills(url)`）
   - 用 `parseGitHubSkillUrl` + `resolveRefAndPath` 解析链接，支持仓库、分支、目录三种链接。
   - 用 `remoteSnapshot` 拿整棵树，在链接指向的目录下找所有 `SKILL.md`，它所在的文件夹就是一个 skill。
   - 读每个 `SKILL.md` 的 frontmatter，取 `name` 和 `description`；`name` 不合法（`isSafeSkillName`）的列出来但不能选。
   - 返回 `{ repo, ref, commit, skills: [{ name, description, path, existsInLibrary }] }`。

3. **安装选中的 skill**（新函数 `installGitHubSkills(url, picks)`）
   - 每个选中的 skill 按 `updateSkill` 的方式下载到 `.emdash` 下的临时目录，下载完再整体换到 `~/.agentskills/<name>`，失败时不留半个文件夹。
   - 装好直接写来源记录：`repo`、`ref`、`path`、`installedTree`（远端树 id）、`installedHash`，之后「检查更新」能直接用。
   - 库里已有同名 skill 时，按用户选择覆盖或跳过；覆盖前若本地有改动（hash 和来源记录不一致）要再确认。
   - 装完调用技能库刷新，让 agent 立即能用。

4. **Wire 接口**（`agent-library/api/index.ts` + `node/wire-controller.ts`）
   - 加 `scanGitHubSkills({ url })` 和 `installGitHubSkills({ url, ref, commit, picks: [{ path, overwrite }] })`。
   - 安装时传扫描时的 commit，扫描和安装之间仓库有新提交也装同一版。

5. **界面**（技能库工具栏，`SkillsToolbar.tsx` 旁加「从 GitHub 导入」）
   - 弹窗：粘贴链接 → 扫描 → 列出 skill（名字、描述、仓库内路径、「已存在」标记）→ 勾选 → 安装。
   - 只扫到一个 skill 时默认勾上；已存在的默认不勾，勾上时显示覆盖提示。
   - 新弹窗按规范从 `contributions/browser.ts` 暴露；新字符串跑 `extract-ui-strings.mjs --missing` 后补中文。

6. **测试**
   - `skill-sources.test.ts`：模拟 GitHub 响应，测扫描（根目录、子目录、多个 skill、`name` 不合法）、带 token 的请求头、404 的提示、安装后来源记录正确、覆盖和跳过。
   - 测试实例里用 `LUPENGHAN/sales` 实测：未登录时报私有仓库提示，登录后扫出 `customer-analysis`，安装后来源和检查更新都正常。

## Cursor 读不到库里的 skill 和 MCP

执行方案：[plans/04-cursor-skills-mcp.md](plans/04-cursor-skills-mcp.md)

> 2026-10-17 实测后做法有变：聊天模式不认 `--plugin-dir`，skill 改成在 `.cursor/skills` 放复制品；聊天模式的 MCP 原本就能用。下面的「做法」以方案为准。

### 原因（看的是 cursor-agent `2026.10.14-941492e` 的代码）

- **skill**：Emdash 把库里的 skill 以软链接的形式放进工作区的 `.claude/skills`、`.agents/skills`，链接指向 `~/.agentskills/<name>`。Cursor 确实会扫这两个目录，但它读项目级 skill 时会先取真实路径，真实路径不在这个 skills 目录里面的文件夹直接跳过（`findSkillMarkdownFiles` 里的 `isPathWithin` 检查，防止软链接指到项目外）。所以 Claude、Codex 能用的链接，Cursor 全部忽略。只有用户级目录 `~/.cursor/skills` 允许软链接指向外面。
- **MCP，终端模式**：`mcp-launch.ts` 的 `terminalLaunchForMcp` 对 Cursor 直接返回 `null`，什么都不传。当时认为 Cursor 只能读 `.cursor/mcp.json`、`~/.cursor/mcp.json` 这两个配置文件。
- **MCP，ACP 聊天模式**：`acpMcpServers` 对所有 agent 都会在 `session/new` 里传 MCP；Cursor 的 ACP 也声明了支持（`mcpCapabilities: { http, sse }`，并且会读 `mcpServers`）。理论上应该能用，但还没实测。

### 做法

现在的 cursor-agent 有 `--plugin-dir <path>`，可以在一次启动里加载一个本地插件目录。插件可以带 `skills/<name>/SKILL.md` 和 `mcp.json`（或 `.mcp.json`），也支持 `${CURSOR_PLUGIN_ROOT}` 变量。用它做每次启动注入，不用改 Cursor 的全局配置，也不用往工作区写 `.cursor/` 文件。

1. **生成插件目录**：每次启动 Cursor 前，在 Emdash 数据目录下按会话（或工作区）生成一个插件目录：
   - `.cursor-plugin/plugin.json`：名字可以叫 `emdash-library`。
   - `skills/<name>/`：这个工作区该有的 skill（和 `syncWorkspaceSkills` 用同一份列表），**复制**而不是软链接，避免同样的真实路径检查。库里的 skill 更新后要重新生成。
   - `mcp.json`：库里这个项目启用的 MCP（`launchMcpServers` 的结果），格式是 `{ "mcpServers": { name: { command, args, env } | { url, headers } } }`。
2. **终端模式**：`terminalLaunchForMcp` 的 Cursor 分支返回 `--plugin-dir <目录>`。如果用户开了自动批准，再加 `--approve-mcps`，否则 Cursor 会先弹 MCP 审批。skill 不依赖 MCP，所以没有 MCP 时也要传 `--plugin-dir`。启动参数要按 shell 转义规则处理。
3. **ACP 模式**：先实测 `session/new` 传的 MCP 在 Cursor 里能不能用。能用就只解决 skill：`cursor-agent acp` 的启动参数加 `--plugin-dir`，要先确认 `acp` 子命令接不接受这个参数；不接受的话，ACP 下的 skill 退而求其次，同步到工作区 `.cursor/skills` 并写进 `.git/info/exclude`，用复制而不是软链接。
4. **确认插件格式**：动手前用一个手写的插件目录跑 `cursor-agent --plugin-dir <dir> mcp list`（不消耗额度），确认插件里的 MCP 会被列出来。skill 能不能读到要在测试实例里起一次 Cursor，只问「列出你能用的 skill」，跑完就停。
5. **测试**：`mcp-launch.test.ts` 加 Cursor 分支；插件目录生成写单元测试（skill 复制、MCP 格式、项目范围过滤、库更新后重新生成）。

## Emdash MCP 加上列出、归档、删除任务

执行方案：[plans/05-mcp-task-tools.md](plans/05-mcp-task-tools.md)

现在 Emdash 的 MCP（`agent-control/node/mcp-tools.ts`）只能建任务（`create_task`、`suggest_task`、`handoff`），没有列出、归档、删除任务的工具。agent 没法清理自己或别人建的任务。

### 做法

1. **`list_tasks`**：列出 agent 所在项目的任务，返回 id、名字、分支、状态（运行中、空闲、已归档）、创建时间，可以按状态过滤。没有它，agent 不知道该删哪个任务。
2. **`archive_task`**：归档指定任务，以后还能恢复。复用应用里现有的归档逻辑，不重写。
3. **`delete_task`**：会删掉 worktree 和分支，不能撤销。像 `suggest_task` 一样在应用里弹确认框，写清任务名、分支、有没有未提交或未推送的改动，用户点了才执行；用户拒绝时 agent 收到「已拒绝」。
4. **限制**（在 `agent-control-dispatcher.ts` 里检查，不靠 agent 自觉）：
   - 只能操作调用者所在项目的任务；
   - 不能归档、删除调用者自己所在的任务；
   - 有 agent 正在运行的任务不能删，要先停。
5. **测试**：dispatcher 加单元测试，覆盖跨项目拒绝、删自己拒绝、运行中拒绝、用户拒绝确认。在测试实例里用临时任务实测，不启动真实 agent，测完把 `~/emdash/worktrees` 下的测试 worktree 清掉。

## Codex 换供应商后模型列表不对

执行方案：[plans/06-codex-provider-models.md](plans/06-codex-provider-models.md)

> 2026-10-17 已查清：只在两种情况下不带模型目录，一是选中的模型没设上下文长度，二是 Windows 的聊天模式。下面的「猜测的原因」以方案为准。

现象：Codex 切到自己加的供应商后，能选的只有一个模型，不是这个供应商里的全部模型；没选模型时还在用 Codex 原来配置里的模型。

### 猜测的原因（看了 `model-providers/node/source-launch.ts`，还没实测）

- Codex 的模型列表来自它自己的模型目录。Emdash 只在**选中的模型设了上下文长度**时才写一份目录（`model_catalog_json`），而且目录里只放**设了上下文长度的模型**（`Object.entries(provider.contextWindows)`）。所以只给一个模型设过上下文长度时，目录里只有它一个，`/model` 和聊天里的模型选择器也就只剩它。
- 没写目录时，Codex 列出的是它自己缓存里的 OpenAI 模型（`~/.codex/models_cache.json`），不是供应商的模型。
- 没选模型时 Emdash 不传 `model`，Codex 就用 `~/.codex/config.toml` 里的 `model`，这个模型供应商那边多半没有。

### 做法

1. 用了供应商就一定写模型目录，放进供应商的**全部**模型：设了上下文长度的用设的值，没设的用 Codex 对未知模型的默认值（`codex-model-catalog.ts` 已经有这套回退）。
2. 没选模型时，默认用供应商模型列表里的第一个（或供应商设的默认模型），一定传 `-c model=…`，不再落到 Codex 原来的配置。
3. 终端模式（`-c` 参数）和聊天模式（codex-acp 的 `CODEX_CONFIG` 和启动包装脚本）都要改；目录文件的路径不能有空格这个限制要保留或者解决。
4. 测试：`source-launch` 的测试覆盖「只给部分模型设了上下文长度」「一个都没设」「没选模型」三种情况。在测试实例里用假的供应商地址实测：终端里 `/model` 和聊天的模型选择器都能看到全部模型，不用真的发请求。

## Codex 用自定义供应商时请求不兼容

执行方案：[plans/07-codex-provider-requests.md](plans/07-codex-provider-requests.md)

### 联网搜索工具导致 400（已查清）

现象：Codex 在 Xhub（`http://111.62.156.153:4000`）上用 `deepseek-v4.1-flash` 报 `model deepseek-v4.1-flash exists but has no deployment compatible with endpoint responses and this request`。同一供应商、同一模型在 omp 里走 Responses 是通的。

原因：Codex（0.163）的每个请求都自带 `{"type":"web_search","external_web_access":false}` 工具，Xhub 的 DeepSeek 不支持。2026-10-16 用本地假服务器抓到 Codex 的真实请求后逐项测试：`store:false`、`include: reasoning.encrypted_content`、`reasoning.summary`、`developer` 消息、`namespace` 工具、`client_metadata` 都能通，只有加了 `web_search` 的报这个错；把 Codex 的完整请求去掉 `web_search` 重放，返回 200。

做法：

1. Codex 有 `-c web_search="disabled"`，加上后请求里就不带这个工具（已用假服务器确认）。
2. 二选一：
   - 简单：用自定义供应商时一律加，终端模式加 `-c`，聊天模式写进 `CODEX_CONFIG`。代价是供应商上的 GPT 模型也不能联网搜索。
   - 细一点：供应商设置里每个模型加「支持联网搜索」，只给勾了的模型保留。可以和上面「Codex 换供应商后模型列表不对」一起做，都在 `source-launch.ts` 和模型目录里。
3. 测试：`source-launch` 测试覆盖终端和聊天两种模式都带上这个参数；再用假服务器确认请求里没有 `web_search`，不用真的请求供应商。

临时绕过：`~/.codex/config.toml` 加 `web_search = "disabled"`，但 Emdash 外面用官方账号的 Codex 也会被关掉。

### 会话中途换模型后 400（encrypted history）

现象：同一个 Codex 会话先用 `openai/gpt-6-sol`，再换 `grok-4.6` 或 `deepseek-v4.1-flash`，报 `encrypted history requires an owned session or previous_response_id`（会话记录 `~/.codex/sessions/2026/10/16/rollout-2026-10-16T15-05-51-01a14388-….jsonl`）。

原因：gpt-6-sol 返回了加密的推理内容（`encrypted_content`），Codex 每轮都把它放回历史里发出去；供应商只能把它交给生成它的上游，转到别的模型就拒绝。之后整个会话只能继续用 gpt-6-sol。

做法：

1. 自定义供应商的 Codex 会话里，换到另一个厂商的模型（按模型 id 前缀或名字判断）时先提示：可能因为加密的推理历史失败，建议新开会话。
2. 或者提供「换模型并新开会话」，用交接把上下文带过去。
3. 不在我们这边删历史里的加密推理，那是 Codex 自己的会话文件。

## 编辑器未保存缓存过期：对比误导、「全部放弃」清不掉、删除工作区后残留

执行方案：[plans/08-editor-buffer-staleness.md](plans/08-editor-buffer-staleness.md)

现象（1.2.7，任务 `todo-opportunity-picker`，worktree `emdash-todo-opportunity-picker-qwiqv`）：

1. `src/components/OpportunityPicker/index.tsx` 的对比视图显示「导入顺序被改回旧写法，多了两个空行」，像是代码回退了；但磁盘文件和 git HEAD 都是新写法，`git diff` 里也没有这处改动。
2. 改动面板点「全部放弃」：已跟踪文件的 4 处修改还原了，未跟踪的 `docs/` 文件和 `node_modules` 软链接也被删了，但编辑器里那份过期缓存还在。
3. 删除这个任务的 worktree 之后，`emdash4-editor-buffers.db` 里这个路径下的两条缓存（`index.tsx`、`src/global.css`）还在，成了孤立记录。

原因：

- `~/Library/Application Support/emdash-fork/emdash4-editor-buffers.db` 的 `editor_buffers` 表存着这个文件的未保存内容（`updated_at` 2026-10-15 15:14），是更早一个提交的版本；`src/global.css` 也有一份（2026-10-14 17:58）。
- 之后磁盘文件被外部（git 提交）更新了几次，缓存没有失效，也没有提示冲突。
- 对比视图拿「磁盘文件」和「过期缓存」做对比，界面上看不出这是未保存缓存的对比，容易当成 git 改动。

风险：在编辑器里点保存，过期缓存会直接覆盖磁盘上更新的文件，把外部提交的修改悄悄冲掉，没有任何冲突提示。

还没弄清的：

- 这份缓存最早是怎么来的：用户改过没保存，还是 Emdash 自己留下的。
- 排查时 `index.tsx` 那条缓存的时间变成了当天 18:48，内容也换成了另一种导入顺序。说明删除工作区前后，这份缓存还在被写入（可能是打开着的标签还在自动存缓存）。

相关代码：

- 缓存读写：`core/features/editor/node/editor-buffer-service.ts`（`saveBuffer`、`clearBuffer`、`listBuffers`、`pruneStale` 只按时间清）。
- 打开文件时恢复缓存：`core/features/editor/api/browser/open-file-store/open-file-store.ts`。
- 「全部放弃」：`source-control/browser/stores/git-checkout-store.ts` 的 `discardAllFiles` → `revertAll`。

### 做法

1. **缓存记下基准版本**：存缓存时同时存它基于的磁盘内容 hash（或 mtime + size）。恢复缓存时如果磁盘已经变了，不直接套用，提示冲突：「重新载入磁盘版本 / 保留我的修改 / 对比」。文件打开期间磁盘变化也要走同样的检测。
2. **保存前再检查一次**：保存时磁盘内容和缓存的基准不一致，就弹冲突，不能直接覆盖。
3. **对比视图标明两边**：标题里写清是「git HEAD ↔ 工作区」还是「磁盘 ↔ 未保存修改」，未保存修改的对比用不同的样式。
4. **「全部放弃」**：
   - 一并清掉这些文件的未保存缓存，已打开的标签同时重新载入；
   - 先查 `revertAll` 会不会删未跟踪文件（相当于 `git clean`）。会删的话，执行前列出将删除的文件让用户确认，并且不碰软链接和被忽略的文件（`node_modules` 软链接被删就是这个问题）。
5. **删除任务或 worktree 时**：按 worktree 路径前缀清掉 `editor_buffers` 里的记录（`listBuffers(root)` 已经支持按前缀查），同时关掉这个工作区里打开的编辑器标签，避免删完还在写缓存。
6. **启动时清理孤立记录**：`pruneStale` 除了按时间，还删掉对应文件或工作区已经不存在的记录。
7. **测试**：缓存服务加单元测试（基准不一致时报冲突、按前缀清理、孤立记录清理）；在测试实例里按上面的复现步骤走一遍，外部提交用命令行模拟，不启动真实 agent。

## 接入通用会话协议（ASP、AHP），先做分析

执行方案：[plans/09-session-protocols.md](plans/09-session-protocols.md)

背景：现在跨 agent 交接是把最近几条对话整理成一段文字，作为新 agent 的第一条提示（见「项目当前进度」会话开头的「你在接手另一个 AI 编码助手（Codex）没做完的工作……」）。新 agent 拿到的只是摘要，没有完整历史和工具调用。社区里有两个方向可以参考：

- **ASP（Agent Session Protocol）**：通用的会话格式（JSONL），各 agent 的原生会话可以和统一事件格式互相转换（`normalize` / `denormalize`），可以把会话从 Codex 导出、导入到 Claude Code 里接着跑。参考实现：
  - https://github.com/kevin-dp/agent-session-protocol（格式加 `capi` 命令行）
  - https://github.com/agent-session-protocol/universal-session-log（存储引擎，目前只支持 Claude、Codex；分工是「ACP 管实时交互，ASP 管历史和跨 agent 迁移」）
- **AHP（VS Code 的 Agent Host Protocol）**：把 agent 会话当成基础设施，由宿主统一托管。介绍：https://rohitai.com/blog/vscode-agent-host-protocol-session-infrastructure 。还没读规范，Emdash 能不能作为宿主或客户端接入要先看。

已知限制：各家加密的推理内容（Codex 的 `encrypted_content`、Claude 的 thinking 签名）只有原厂能解，跨厂商迁移只能带对话、工具调用和结果，带不过去推理（和「Codex 会话中途换模型后 400」是同一个原因）。

### 先做的分析

1. 读 ASP、AHP 的规范，确认成熟度：版本、谁在用、格式是否稳定、许可证。
2. 对照 Emdash 已有的东西：ACP 聊天、PTY 会话、`handoff` / `send_message` 这些 MCP 工具、各 agent 的会话文件（`~/.codex/sessions`、Claude 的 projects、OpenCode、Pi、Oh My Pi）。看哪些能直接用协议替换，哪些要自己写转换。
3. 列出 Emdash 支持的 agent，各自的会话格式能否被转换（ASP 目前只覆盖 Claude、Codex）。
4. 评估三种接法的成本和收益：
   - 只用于交接：交接时转换完整会话，代替现在的摘要；
   - 统一会话历史：所有 agent 的会话存一份统一格式，用来搜索、回看、分享；
   - 接 AHP：让 Emdash 作为宿主托管会话，或者接入 VS Code 那一侧。
5. 结论写成方案，确定先做哪一种再动手。
