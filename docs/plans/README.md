# 执行方案

`docs/todo.md` 里每一项对应这里的一个方案文件。方案写给执行的模型看：照着步骤做，不要自己扩大范围。每个文件最后有「审查方案」，是给审查的人看的。

| 文件 | 对应 todo | 类型 | 风险 |
|---|---|---|---|
| [01-resume-writing-jobs.md](01-resume-writing-jobs.md) | 续写要能记多个任务 | 实现 | 中 |
| [02-remote-access-tunnel.md](02-remote-access-tunnel.md) | 远程访问要能从应用里传出去 | 先调研，再实现 | 高 |
| [03-github-skill-import.md](03-github-skill-import.md) | 用 GitHub 链接直接导入 skill | 实现 | 中 |
| [04-cursor-skills-mcp.md](04-cursor-skills-mcp.md) | Cursor 读不到库里的 skill 和 MCP | 实现 | 中 |
| [05-mcp-task-tools.md](05-mcp-task-tools.md) | Emdash MCP 加上列出、归档、删除任务 | 实现 | 高（删除） |
| [06-codex-provider-models.md](06-codex-provider-models.md) | Codex 换供应商后模型列表不对 | 实现 | 中 |
| [07-codex-provider-requests.md](07-codex-provider-requests.md) | Codex 用自定义供应商时请求不兼容 | 实现 | 中 |
| [08-editor-buffer-staleness.md](08-editor-buffer-staleness.md) | 编辑器未保存缓存过期 | 实现 | 高（会覆盖文件） |
| [09-session-protocols.md](09-session-protocols.md) | 接入通用会话协议（ASP、AHP） | 只调研 | 低 |

建议顺序：08 → 07 → 06 → 04 → 03 → 05 → 01 → 09 → 02。06 和 07 都改 `source-launch.ts`，要么同一个人连着做，要么 07 先合进去再做 06。

## 所有方案共用的规则

执行前先读完这一节，每个方案都默认遵守。

### 仓库和分支

- 仓库：`/Users/hlp/Documents/code/emdash`，桌面应用在 `apps/emdash-desktop/`。下文的 `src/...` 都指 `apps/emdash-desktop/src/...`，`packages/...` 指仓库根下的 `packages/...`。
- 从 `feat/multi-agent` 开一个新分支，名字用方案文件名，例如 `fix/editor-buffer-staleness`。不要直接在 `feat/multi-agent` 上提交。
- 一个方案一个分支，不要把两个方案的改动混在一起。

### 不能做的事

- **不要启动真实的 agent**（Claude、Codex、OpenCode、Cursor、Pi、Oh My Pi 发消息都会花用户的额度）。需要验证 agent 行为时，用方案里写的假服务器或零额度办法；方案里写着「需要用户同意」的步骤，停下来问。
- 不要动 `drizzle/` 下的迁移文件，不要动 `dist/`、`out/`、`release/`、`build/`。
- 不要提交 `tooling/fixtures/*.db`。
- 不要 `git push`，不要合并分支，不要改 GitHub 上的任何东西。做完停在本地提交。
- 不要用 `any`；不要用 `require()`；不要用 `export * from` 之类的转导出做捷径。
- 不要删除或改写用户目录下的文件（`~/.codex`、`~/.cursor`、`~/.agentskills`、`~/Library/Application Support/emdash-fork` 等）。测试一律用临时目录。
- 方案没写的重构不要做。看到别的问题，记在交付说明里，不要顺手改。

### 代码风格

- 跟周围代码一样写：命名、注释密度、写法照抄邻近文件。注释用英文，说明「为什么」，不写「做了什么」。
- 界面文字用英文写在代码里，中文翻译放 `src/core/features/localization/browser/zh-CN.json`。加完新文字后运行：

  ```bash
  cd /Users/hlp/Documents/code/emdash/apps/emdash-desktop && node scripts/fork/extract-ui-strings.mjs --missing
  ```

  把列出来的新字符串都翻译进 `zh-CN.json`。
- 格式化：在 `apps/emdash-desktop` 目录里运行 `pnpm exec oxfmt`（不带参数）。改了 `packages/` 下的文件，就在那个包的目录里也运行一次。

### 检查命令

每个方案做完都要跑，全部通过才算完成：

```bash
cd /Users/hlp/Documents/code/emdash
pnpm exec nx run-many -t format:check,typecheck,lint -p @emdash/emdash-desktop
cd apps/emdash-desktop && pnpm exec vitest run --project node <改到的测试文件路径>
```

测试文件名以 `.db.test.ts` 结尾的（要真实 SQLite 的），用 `--project main-db` 而不是 `--project node`。`.browser.test.ts` 用 `--project browser`，需要装好 Playwright 的浏览器；装不了就在交付说明里写出来。

改了 `packages/core` 或 `packages/plugins` 的话，加上对应的包：`-p @emdash/emdash-desktop @emdash/core @emdash/plugins`。

已知和本次改动无关的失败：core 里有 3 个原本就失败的测试，`use-system-dependencies.test.ts` 偶尔会随机失败。遇到这些不用修，在交付说明里写出来就行。

### 测试实例（需要在应用里点一点看效果时）

不要用用户正在用的应用。先构建，再用隔离的数据目录启动：

```bash
cd /Users/hlp/Documents/code/emdash/apps/emdash-desktop
pnpm exec electron-vite build
env -i HOME="$HOME" USER="$USER" PATH=/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin \
  EMDASH_USER_DATA_DIR=/tmp/emd-ui/data CLAUDE_CONFIG_DIR=/tmp/emd-ui/claude \
  CODEX_HOME=/tmp/emd-ui/codex OPENCODE_CONFIG_DIR=/tmp/emd-ui/opencode TELEMETRY_ENABLED=false \
  ../../node_modules/.bin/electron . --remote-debugging-port=9333 --inspect=9339
```

- `HOME` 必须是真实的，不能换成假目录，否则 macOS 会弹钥匙串对话框。
- 测试中在 `~/emdash/worktrees` 下建的 worktree，测完要删掉。删之前先 `ls ~/emdash/worktrees`，只删自己建的。原来就有的是：`AstrLink-65cfaa3d`、`Docker-config-84c496e7`、`Time-Tracker-62ecf6a8`、`code-8a860a9e`、`emdash-f018d863`、`win-deal-app-024ad39c`。
- 测完关掉测试实例（结束这个 electron 进程）。

### 提交

- Conventional Commits，例如 `fix(editor): …`、`feat(agent-library): …`。
- 提交信息最后一行加：`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`（执行的是别的模型时换成它自己的名字）。
- 一个方案可以分几个提交，每个提交自己能通过检查。

### 交付说明

做完后写一段交付说明（贴在对话里，不要写进仓库），包含：

1. 分支名和提交列表（`git log --oneline feat/multi-agent..HEAD`）。
2. 每个步骤做了没有；没做的写原因。
3. 跑过的检查命令和结果，失败的贴输出。
4. 手动验证做了哪些、看到了什么；没做的写原因。
5. 方案里没写、自己临时决定的地方。
6. 发现但没处理的问题。

不要写「应该没问题」这种话：做过的写做过，没做的写没做。
