# 04 Cursor 读不到库里的 skill 和 MCP

先读 [README.md](README.md) 里的共用规则。分支名：`fix/cursor-library-skills-mcp`。

## 要解决的问题

Emdash 技能库（`~/.agentskills`）里的 skill 和库里配置的 MCP 服务器，Claude、Codex 等都能用，Cursor 用不了。

## 已经查清的原因（2026-10-17 实测，cursor-agent `2026.10.14-941492e`）

**skill**：

- Emdash 用 `src/core/features/agent-library/node/skill-library.ts` 的 `syncWorkspaceSkills()`，在每个工作区的 `.claude/skills/` 和 `.agents/skills/` 下建**软链接**，指向 `~/.agentskills/<name>`。
- Cursor 会扫这两个目录，但读项目级 skill 时会先取真实路径，**真实路径不在这个 skills 目录里面的直接跳过**（防止软链接指到项目外）。所以 Cursor 看不到这些链接。
- Cursor 也读 `.cursor/skills/`，同样的检查。只要放的是**真实的文件夹**（复制，不是链接），就能读到。

**MCP**：

- 终端模式：`src/core/features/agent-library/node/mcp-launch.ts` 的 `terminalLaunchForMcp()` 对 Cursor 返回 `null`，什么都不传。
- 实测：`cursor-agent --plugin-dir <目录>` 会加载这个目录里的 `mcp.json`（一个假 MCP 服务器被启动了）。目录结构：

  ```
  <目录>/
    .cursor-plugin/plugin.json   {"name":"emdash-library","version":"0.0.1","description":"…"}
    mcp.json                     {"mcpServers":{"名字":{"command":"…","args":[…],"env":{…}}}}
  ```

- 聊天（ACP）模式：Emdash 已经在 `session/new` 里传 MCP，实测 Cursor 会启动它们，**这部分不用改**。
- `cursor-agent --plugin-dir <目录> acp` 不报错，但聊天模式**不加载**插件目录（实测假 MCP 没被启动）。所以聊天模式的 skill 只能走工作区的 `.cursor/skills/`。

## 决定

- **skill（两种模式通用）**：在工作区的 `.cursor/skills/<name>/` 放库里 skill 的**复制品**，并写进 `.git/info/exclude`。
- **MCP（只改终端模式）**：每次启动 Cursor 终端会话前，生成一个插件目录，里面只放 `mcp.json`，启动参数加 `--plugin-dir <目录>`。
- 插件目录里**不放 skill**（skill 已经由 `.cursor/skills` 提供，放两份 Cursor 会显示重复）。

## 已知代码位置

- `src/core/features/agent-library/node/skill-library.ts`：
  - `WORKSPACE_SKILLS_DIRS`（约 27 行）：放软链接的目录；
  - `syncWorkspaceSkills()`（约 67 行）：建链接、删多余链接、把路径写进 exclude；
  - `managedLinkTarget()`（约 182 行）：判断一个链接是不是 Emdash 建的；
  - `writeExcludeBlock()`（约 202 行）：维护 `.git/info/exclude` 里 Emdash 的那一段。
- `src/core/features/agent-library/node/skill-sources.ts` 约 489 行有 `folderHash()`（目前不导出）。
- `src/core/features/agent-library/node/mcp-launch.ts`：`terminalLaunchForMcp()`、`LaunchMcpServer` 类型（在 `../api`）。
- `src/main/bootstrap/boot/phases/services.ts` 约 600–620 行：终端会话启动前的 `prepareAgentLaunch`，调用 `terminalLaunchForMcp(providerId, servers, env)`。
- `src/core/features/conversations/node/tui-conversation-provider.ts`：
  - 约 65 行：`prepareAgentLaunch` 的参数类型；
  - 约 192 行：调用 `prepareAgentLaunch`，返回的 `args` 作为数组追加到启动参数（不会按空格切开，最终由 `formatCommandLine` 加引号）；
  - `conversation.autoApprove`：这个会话是否自动批准。

## 步骤

### 步骤 1：工作区里放 Cursor 能读的 skill 复制品

文件：`skill-library.ts`。

1. 把 `skill-sources.ts` 的 `folderHash()` 改成导出（`export async function folderHash`），在 `skill-library.ts` 里导入。不要复制一份。
2. 新增常量：

   ```ts
   /**
    * Cursor skips project skills whose real path leaves the skills folder, so it gets
    * copies instead of links. The marker tells Emdash's copies from the repository's own.
    */
   const CURSOR_SKILLS_DIR = path.join('.cursor', 'skills');
   const COPY_MARKER = '.emdash-library-copy';
   ```

3. 新增函数 `syncCursorSkillCopies(input: { workspacePath; libraryDir; names }): Promise<{ copied: string[]; shadowed: string[]; excluded: string[] }>`：
   - 对 `.cursor/skills/` 下已有的每个文件夹：如果里面有 `COPY_MARKER` 文件（是 Emdash 的复制品），并且名字不在 `names` 里，整个删掉（`rm(dir, { recursive: true, force: true })`）。**没有标记文件的文件夹一律不碰**。
   - 对 `names` 里的每个 skill：
     - 目标 `.cursor/skills/<name>` 存在、但没有标记文件 → 仓库自带的同名 skill，记入 `shadowed`，跳过；
     - 目标有标记文件，且标记文件里记的 hash 等于库里这个 skill 当前的 `folderHash` → 已是最新，跳过复制；
     - 否则：删掉旧复制品（如果有），用 `cp(source, target, { recursive: true, dereference: true })` 复制，再写标记文件，内容是库里这个 skill 的 `folderHash`；
     - 记入 `copied`，并把 `/.cursor/skills/<name>` 加到 `excluded`。
   - `names` 为空时不创建 `.cursor/skills/` 目录。
   - 计算 hash 时要排除标记文件本身（库里的源文件夹没有标记文件，所以对源文件夹算 hash 就行，不要对复制品算）。
4. `syncWorkspaceSkills()` 里调用它，把它返回的 `excluded` 合并进原来的 `excluded` 数组，再调用 `writeExcludeBlock()`。返回值里把 `copied` 并进 `linked`，`shadowed` 合并。

完成标志：`skill-library.test.ts` 新增测试（用 `os.tmpdir()` 建临时的库目录和工作区）：
- 库里有 `a`、`b`，`names = ['a','b']` → `.cursor/skills/a`、`b` 是真实文件夹（`lstat().isSymbolicLink()` 为 false），有标记文件；
- 再次同步、库没变 → 不重新复制（用文件的 `mtimeMs` 判断，或者在复制品里放一个额外文件，确认它还在）；
- 修改库里 `a/SKILL.md` 后同步 → 复制品更新；
- `names = ['a']` → `b` 的复制品被删；
- 工作区自带 `.cursor/skills/a`（没有标记）→ 不被覆盖，`shadowed` 里有 `a`；
- `.git/info/exclude` 里有 `/.cursor/skills/a`（测试里先 `git init` 工作区，看现有测试是怎么做的）。

### 步骤 2：生成 Cursor 用的插件目录（只放 MCP）

新建文件：`src/core/features/agent-library/node/cursor-plugin.ts`。

```ts
import { chmod, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { LaunchMcpServer } from '../api';

/** Plugin folders older than this are from conversations long gone. */
const STALE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Cursor's terminal CLI takes MCP servers only from config files or a plugin folder
 * (`--plugin-dir`), so each launch gets a folder of its own holding just `mcp.json`.
 * It can carry secrets (env, headers), so only this user can read it.
 */
export async function writeCursorPluginDir(
  root: string,
  conversationId: string,
  servers: readonly LaunchMcpServer[]
): Promise<string> { … }

/** Removes plugin folders not written for two weeks. Errors are ignored. */
export async function pruneCursorPluginDirs(root: string, now = Date.now()): Promise<void> { … }
```

要求：

1. `root` 由调用方传入：`path.join(home, SKILL_LIBRARY_DIRNAME, '.emdash', 'cursor-plugins')`。这个路径一般不含空格。
2. `conversationId` 只允许 `[A-Za-z0-9-]`，否则抛错（防止路径穿越）。
3. 目录是 `<root>/<conversationId>/`，权限 `0o700`；`mcp.json` 权限 `0o600`。每次调用都整个重写。
4. `.cursor-plugin/plugin.json` 内容：`{ "name": "emdash-library", "version": "1.0.0", "description": "MCP servers from the Emdash library" }`。
5. `mcp.json` 的格式：

   ```json
   {
     "mcpServers": {
       "<name>": { "command": "…", "args": ["…"], "env": { "K": "V" } },
       "<name2>": { "url": "https://…", "headers": { "K": "V" } }
     }
   }
   ```

   `transport === 'http'` 的写 `url`/`headers`，其余写 `command`/`args`/`env`。没有的字段不写。
6. 返回目录的绝对路径。

完成标志：新建 `cursor-plugin.test.ts`，覆盖：stdio 和 http 两种服务器的 JSON 格式；文件权限（`stat().mode & 0o777`，只在非 Windows 上断言）；非法 `conversationId` 抛错；`pruneCursorPluginDirs` 删掉旧的、保留新的（用 `utimes` 把一个目录改旧）。

### 步骤 3：Cursor 终端会话启动时带上插件目录

文件：`tui-conversation-provider.ts`、`services.ts`。

1. `prepareAgentLaunch` 的参数类型（约 65 行）加 `autoApprove: boolean`；调用处（约 192 行）传 `conversation.autoApprove === true`。
2. `services.ts` 的 `prepareAgentLaunch`（约 600 行）：

   ```ts
   const servers = await launchMcpServers(params.conversationId, params.projectId);
   if (params.providerId === 'cursor') {
     if (servers.length === 0) return null;
     const dir = await writeCursorPluginDir(cursorPluginRoot, params.conversationId, servers);
     // Cursor asks before it starts a plugin's MCP servers unless told to approve them.
     return { args: ['--plugin-dir', dir, ...(params.autoApprove ? ['--approve-mcps'] : [])], env: {} };
   }
   return terminalLaunchForMcp(params.providerId, servers, params.env);
   ```

   `cursorPluginRoot` 在 `services.ts` 里定义一次：`path.join(homedir(), SKILL_LIBRARY_DIRNAME, '.emdash', 'cursor-plugins')`（`SKILL_LIBRARY_DIRNAME` 从 `skill-library.ts` 导入）。
3. 启动时调用一次 `pruneCursorPluginDirs(cursorPluginRoot)`，用 `services.ts` 里现有的后台任务写法（搜 `runInBackground`，没有就 `void …catch(() => {})`）。
4. `mcp-launch.ts` 里 `terminalLaunchForMcp` 顶部注释「Cursor only reads config files, so they get nothing」改成「Cursor gets a plugin folder instead (see cursor-plugin.ts)」。

完成标志：类型检查通过；`tui-conversation-provider` 的现有测试（如果有）通过，传参改动要同步到测试里。

### 步骤 4：实测（不花额度）

准备一个会被启动就留下记录的假 MCP 服务器：

```bash
mkdir -p /tmp/cursor-probe
cat > /tmp/cursor-probe/probe-mcp.sh <<'EOF'
#!/bin/sh
echo "$0 $* started $(date +%T)" >> /tmp/cursor-probe/hits.log
cat > /dev/null
EOF
chmod +x /tmp/cursor-probe/probe-mcp.sh
```

1. **skill 复制品**：在测试实例的技能库设置里确认有至少一个 skill，打开任意一个任务（会触发工作区同步）。然后：

   ```bash
   ls -la <这个任务的工作区>/.cursor/skills/
   ```

   期望：每个 skill 是普通文件夹（不是 `->` 链接），里面有 `.emdash-library-copy`；`git -C <工作区> status --short` 里看不到 `.cursor/`。
2. **插件目录**：在测试实例的技能库里加一个 MCP 服务器：命令 `/tmp/cursor-probe/probe-mcp.sh`，参数 `terminal`。新建一个 Cursor **终端**会话，打开后**不要发消息**，等 20 秒，然后关掉这个会话。

   期望：`cat /tmp/cursor-probe/hits.log` 里有 `terminal started`；`ls ~/.agentskills/.emdash/cursor-plugins/` 里有这个会话 id 的目录，里面的 `mcp.json` 有 `probe-mcp.sh`。

   如果这个会话没有开自动批准，Cursor 会在界面里问要不要启用这个 MCP，点同意后再看记录。
3. **聊天模式**：同一个 MCP 下新建 Cursor **聊天**会话，不发消息，等 20 秒。期望 `hits.log` 里多一行（这一步只是确认没改坏，原来就能用）。
4. 结束后：在测试实例里删掉这个 MCP 服务器和测试会话；`rm -rf /tmp/cursor-probe`。

> skill 能不能被 Cursor 真正用上，要让 Cursor 回答一次问题才能确认，会花用户的 Cursor 额度。**这一步不要做**，在交付说明里写「skill 是否生效需要用户同意后实测」。代码层面的依据是：Cursor 读 `.cursor/skills` 时要求真实路径在目录内，复制品满足这一点。

## 测试

```bash
cd /Users/hlp/Documents/code/emdash/apps/emdash-desktop
pnpm exec vitest run --project node src/core/features/agent-library src/core/features/conversations/node
```

然后跑 README 里的检查命令。

## 提交建议

1. `fix(agent-library): give Cursor real copies of library skills`（步骤 1）
2. `fix(agent-library): hand Cursor terminals library MCP servers through a plugin folder`（步骤 2–3）

---

## 审查方案

### A. 范围

- [ ] 改动在 `src/core/features/agent-library/`、`tui-conversation-provider.ts`、`services.ts`。
- [ ] 没有改 `packages/core` 的 ACP 代码，没有给聊天模式加 `--plugin-dir`（实测无效）。

### B. 不能误删用户的文件（最重要）

- [ ] `.cursor/skills/` 下删除只发生在**有标记文件**的文件夹上。逐行读删除的代码确认。
- [ ] 判断标记时用的是「文件夹里有 `.emdash-library-copy` 文件」，不是「名字在库里」。
- [ ] 复制前删旧复制品，同样先确认有标记。
- [ ] 测试里有「仓库自带同名 skill 不被覆盖」这一条。
- [ ] 自己在临时目录手动试一遍：`.cursor/skills/` 下放一个自己的文件夹，同步后它还在、内容没变。

### C. 复制品是否保持最新

- [ ] 标记文件里存的是**库里源文件夹**的 hash，比较时也是拿源文件夹的 hash 比，不是对复制品算 hash。
- [ ] 复制用了 `dereference: true`（库里的 skill 内部有软链接时，复制品里是真实文件，Cursor 才读得到）。

### D. 插件目录的安全

- [ ] `conversationId` 有字符白名单，测试覆盖了 `../x` 这类输入。
- [ ] 目录 `0o700`、`mcp.json` `0o600`。
- [ ] `--plugin-dir` 和目录是两个独立的数组元素，不是拼成一个字符串。
- [ ] `--approve-mcps` 只在 `autoApprove` 为真时加。
- [ ] 清理只删 `cursor-plugins/` 下的子目录，删除范围不会超出这个目录。

### E. 其他 agent 不受影响

- [ ] `terminalLaunchForMcp` 对 claude、codex、opencode 的输出没变（现有测试通过）。
- [ ] `syncWorkspaceSkills` 对 `.claude/skills`、`.agents/skills` 的软链接行为没变（现有测试通过）。

### F. 实测

- [ ] 自己重做步骤 4 的第 1、2 小步。
- [ ] 交付说明里写了「skill 是否被 Cursor 用上未实测（需要额度）」。

### 不通过的典型情况

- 用软链接或硬链接代替复制：软链接 Cursor 不认；硬链接没法跨磁盘，也会让在复制品里的修改改到库里。
- 每次同步都无条件重新复制：工作区多、skill 多时很慢，还会不停改文件时间、触发文件监听。
- 把插件目录放在 `~/Library/Application Support/...`：路径有空格，虽然参数是数组不会切坏，但没必要冒这个险；方案指定放在 `~/.agentskills/.emdash/cursor-plugins/`。
