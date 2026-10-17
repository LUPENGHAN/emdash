# 09 接入通用会话协议（ASP、AHP）：调研

先读 [README.md](README.md) 里的共用规则。分支名：`docs/session-protocols-research`。

**这个方案只做调研、写文档，不改代码。**

## 背景

Emdash 现在在 agent 之间交接（handoff）的做法：把最近几条对话整理成一段文字，作为新 agent 的第一条消息。例如一个交接出来的会话，开头是「你在接手另一个 AI 编码助手（Codex）没做完的工作……」。新 agent 只拿到摘要，看不到完整的历史和工具调用记录。

社区里有两个相关的方向：

- **ASP（Agent Session Protocol）**：一种通用的会话格式（JSONL）。各 agent 自己的会话文件可以和统一的事件格式互相转换（`normalize` / `denormalize`），所以一个会话可以从 Codex 导出、再导入到 Claude Code 里接着跑。
  - https://github.com/kevin-dp/agent-session-protocol （格式规范，加一个命令行工具 `capi`）
  - https://github.com/agent-session-protocol/universal-session-log （存储引擎；目前只支持 Claude、Codex。它把分工写成：ACP 管实时交互，ASP 管历史和跨 agent 迁移）
- **AHP（VS Code 的 Agent Host Protocol）**：把 agent 会话当成由宿主托管的基础设施。介绍文章：https://rohitai.com/blog/vscode-agent-host-protocol-session-infrastructure 。规范本身还没人读过。

已知的限制：各家加密的推理内容（Codex 的 `encrypted_content`、Claude 的 thinking 签名）只有原厂能解。所以跨厂商迁移只能带过去对话、工具调用和结果，带不过去推理过程。这和 [07](07-codex-provider-requests.md) 里「会话中途换模型后 400」是同一个原因。

## 要回答的问题

### 1. 两个协议本身

对 ASP 和 AHP 分别回答，每条附链接（官方仓库、规范文件、提交记录）：

1. 规范在哪里？最新版本号、最近一次提交的日期。
2. 谁在维护？有几个贡献者？有没有正式发布的版本？
3. 有没有被别的项目用？（搜 GitHub 上引用它的仓库，列出来，写上 star 数。）
4. 许可证是什么？
5. 格式稳定吗？最近三个月有没有不兼容的改动？（看提交记录和 issue。）
6. 它定义了哪些事件类型？（用户消息、助手消息、工具调用、工具结果、推理、文件改动……逐条列出。）
7. 加密的推理内容、图片、附件是怎么处理的？
8. 支持哪些 agent？每个 agent 的转换器是否完整？哪些字段会丢？

AHP 额外回答：

9. 它是协议还是 VS Code 内部的接口？有没有独立的规范文档？
10. 宿主和 agent 之间怎么通信（进程、socket、HTTP）？
11. Emdash 能不能作为宿主？能不能作为客户端接入 VS Code？

### 2. 和 Emdash 现有的东西对照

阅读下面的代码，写清楚 Emdash 现在怎么做、协议能替换掉哪部分：

- 交接：`src/core/features/conversations/browser/handoff.ts`（找 `prepareHandoff`，服务端实现搜 `prepareHandoff` 在 `src/core/features/conversations/node/` 里的位置）。写出交接时具体带了哪些内容、丢了哪些。
- ACP 聊天：`packages/core/src/runtimes/acp/`，只需要说明会话状态存在哪里（搜 `conversation_records` 表、`conversations.db`）。
- 终端会话：各 agent 的会话文件由 agent 自己存，Emdash 只记会话 id（`conversations` 表的 `provider_session_id`）。
- 各 agent 的会话文件在哪里、是什么格式（**只读，不要改**，可以用 `ls` 和 `head` 看用户机器上的真实文件结构，但**文档里不能贴会话内容**，只写字段名和结构）：
  - Claude Code：`~/.claude/projects/<项目>/<会话id>.jsonl`
  - Codex：`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`
  - OpenCode：查 OpenCode 文档和 `~/.local/share/opencode/` 之类的目录
  - Pi：`~/.pi/agent/sessions/`（Pi 的格式文档：https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/session-format.md ）
  - Oh My Pi：`~/.omp/agent/sessions/`
  - Cursor：`~/.cursor/chats/`

做成一张表：agent × （会话文件位置、格式、ASP 有没有转换器、自己写转换器的难度：低 / 中 / 高、理由）。

### 3. 三种接法的评估

对下面每种，写：能解决什么问题、要做哪些事（列要点，不用写代码）、大概的改动范围（哪些目录）、风险、依赖协议的哪部分：

1. **只用于交接**：交接时把旧会话转换成新 agent 的原生会话文件，让新 agent 用 `--resume` 接着跑，代替现在的摘要。要特别说明：转换出来的会话文件新 agent 能不能真的读进去（例如 Claude Code 的会话文件有没有校验）。
2. **统一的会话历史**：所有 agent 的会话都存一份统一格式，用来搜索、回看、导出、分享。
3. **接 AHP**：Emdash 作为宿主托管会话，或者和 VS Code 互通。

### 4. 小实验（可选，不花额度）

如果 ASP 的仓库里有现成的转换工具，可以拿一个**测试用的**会话文件试转换：

- 不要用用户的真实会话。自己造一个：在临时目录里写一个最小的 Codex 或 Claude 会话 JSONL（照真实文件的结构，内容写「hello」「ok」这种）。
- 跑转换，看输出。不要把结果导入到任何 agent 里去跑（会花额度）。
- 安装第三方工具前，先看它的 `package.json` 有没有 `postinstall` 之类的安装脚本；有的话先问用户。

## 交付

写一份文档 `docs/session-protocols-research.md`，结构：

1. 结论（三五行）：推荐先做哪一种接法，还是暂时都不做，理由。
2. ASP：问题 1–8 的答案。
3. AHP：问题 1–11 的答案。
4. Emdash 现状和 agent 会话格式对照表。
5. 三种接法的评估。
6. 小实验结果（做了的话）。
7. 需要用户决定的问题。
8. 参考链接。

文档写完提交（`docs(conversations): research shared agent session protocols`），然后停下，把结论给用户看。

---

## 审查方案

- [ ] 没有改任何代码，只新增了 `docs/session-protocols-research.md`。
- [ ] 文档里**没有贴用户真实会话的内容**（只有字段名和结构）。审查的人全文搜一下用户的项目名、中文对话片段，确认没有。
- [ ] 每条事实性结论都有链接；抽查三条，链接打开确实是对应的内容。
- [ ] 「有没有被别的项目用」「格式是否稳定」这类问题有具体证据（仓库列表、提交日期），不是「看起来」。
- [ ] 加密推理内容的限制在评估里被考虑到了。
- [ ] 「只用于交接」那一项说清楚了新 agent 能不能读进转换出来的会话文件；查不到时写明查不到，没有假设可以。
- [ ] 小实验（如果做了）用的是自己造的测试文件，没有把结果交给任何 agent 跑。
- [ ] 推荐有理由，也写了不推荐其他方案的原因。
