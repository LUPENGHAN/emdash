# 03 用 GitHub 链接直接导入 skill

先读 [README.md](README.md) 里的共用规则。分支名：`feat/github-skill-import`。

## 要做的事

用户想贴一个 GitHub 链接（仓库、分支或目录，例如 `https://github.com/LUPENGHAN/sales`），由 Emdash 找出里面所有的 skill，让用户勾选，装进技能库（`~/.agentskills`），并记下来源，之后能「检查更新」。

现在做不到，原因有三个：

1. 没有这个入口。技能库只能从内置目录安装或新建；能贴 GitHub 链接的只有已装 skill 的「来源」（`setSkillSource`），只管更新。
2. 私有仓库读不到。所有 GitHub 请求都是匿名的，私有仓库一律 404；匿名请求每小时只有 60 次。
3. skill 不一定在仓库根目录。`sales` 的 skill 在 `.agents/skills/customer-analysis/`。

## 不做的事

- 不支持 GitHub 以外的网站（GitLab 等）。
- 不支持 GitHub Enterprise（只认 `github.com`）。
- 不改「检查更新」「更新」的界面，只让它们也带上 token。
- 不处理仓库里的软链接和子模块：遇到就跳过，并在结果里说明。

## 已知代码位置

- `src/core/features/agent-library/node/skill-sources.ts`（核心，先通读一遍）：
  - `parseGitHubSkillUrl(url)`（约 77 行）：解析出 `{ repo: 'owner/name', ref, path }`；
  - `resolveRefAndPath(parsed)`（约 350 行）：分支名里带 `/` 时把 ref 和 path 分开；
  - `remoteSnapshot(repo, ref)`（约 366 行）：取一次提交和整棵文件树，返回 `{ commit, rootTree, entries: [{ path, type, sha, mode }] }`；
  - `treeAt(snapshot, path)`、`filesUnder(snapshot, path)`（约 395–420 行）；
  - `updateSkill()`（约 181 行）：下载一个 skill 的文件到临时目录，再用 `replaceFolder()` 整体换进库里，最后写来源记录。**安装要复用这套做法**；
  - `mutateSources()`（约 258 行）：读改写 `~/.agentskills/.emdash/sources.json`，一次一个；
  - `fetchGitHub(url, options)`（约 523 行）：所有 GitHub API 请求都走这里，目前不带 token；
  - 下载文件用的是 `raw.githubusercontent.com`（约 206 行），私有仓库用不了。
- `src/core/features/agent-library/node/agent-library-service.ts`：服务，`deps` 里加依赖，方法转给 `skill-sources.ts`。
- `src/core/features/agent-library/api/index.ts`：Wire 合约 `agentLibraryContract`（约 133 行起）。
- `src/core/features/agent-library/node/wire-controller.ts`：合约到服务的转接。
- `src/main/bootstrap/boot/phases/services.ts`：
  - 约 536 行创建 `agentLibrary`；
  - 约 861 行 `readGitHubCredentials = createGitHubCredentialReader(...)`，用法：`await readGitHubCredentials(accountId, 'github.com')`，成功时 `result.data.accessToken`；
  - 默认 GitHub 账号：`providerAccountRegistry.getDefaultAccountId('github')`（先确认 `providerAccountRegistry` 上有这个方法；没有就搜 `getDefaultAccountId` 看别处怎么拿）。
- 界面：
  - `src/core/features/skills/browser/components/SkillsToolbar.tsx`：工具栏，现在有「New Skill」按钮；
  - `src/core/features/skills/contributions/browser/SkillsPanel.tsx`：用 `useOpenModal('createSkillModal')` 打开新建弹窗，照这个方式打开新弹窗；
  - `src/core/features/skills/browser/components/CreateSkillModal.tsx`：弹窗的写法（`defineModal`、`useModalController`、`Dialog`），新弹窗照抄结构；
  - `src/core/features/skills/contributions/browser.ts`：在 `modalDefs` 里注册新弹窗；
  - `src/core/features/agent-library/api/browser/client.ts`：`getAgentLibraryClient()`。
- 测试：`src/core/features/agent-library/node/skill-sources.test.ts`，先看它怎么模拟 `fetch`。

## 步骤

### 步骤 1：GitHub 请求带上 token

文件：`skill-sources.ts`。

1. 新增类型和一个模块内的取 token 函数：

   ```ts
   /** The signed-in github.com account's token, or null to go anonymous. */
   export type GitHubTokenSource = () => Promise<string | null>;
   ```

2. `fetchGitHub(url, options)` 的 `options` 加 `token?: string | null`。有 token 时请求头加 `authorization: \`Bearer ${token}\``。
3. **只给 `https://api.github.com/` 开头的地址加 token**。在 `fetchGitHub` 开头检查：`new URL(url).origin === 'https://api.github.com'`，不是就不加（防止 token 发到别的网站）。
4. 404 的错误信息改成：`GitHub returned 404 for <路径>. If the repository is private, sign in to GitHub in Settings → Accounts.`（只在没带 token 时加后半句；带了 token 还 404，就是仓库不存在或账号没权限，写 `…, or this account cannot see it.`）。
5. 所有调用 `fetchGitHub` 的函数（`remoteSnapshot`、`defaultBranch`、`resolveRefAndPath` 等）都加一个 `token` 参数并往下传。`checkSkillUpdates(libraryDir, token)`、`updateSkill(libraryDir, name, force, token)`、`setSkillSource(libraryDir, name, url, token)` 同样加参数。
6. `defaultBranch` 有缓存（`branches` Map），缓存的 key 不用带 token。

完成标志：`skill-sources.test.ts` 新增测试：
- 传了 token：发给 `api.github.com` 的请求头有 `authorization: Bearer <token>`；
- 没传 token：没有这个头；
- 没带 token 时 404 的错误信息里有「sign in to GitHub」。

### 步骤 2：文件下载改走 API

文件：`skill-sources.ts`。

1. 新增函数，按文件的 blob sha 下载内容：

   ```ts
   async function downloadBlob(repo: string, sha: string, token: string | null): Promise<Buffer> {
     const body = await fetchGitHub(`https://api.github.com/repos/${repo}/git/blobs/${sha}`, { token });
     if (body?.encoding !== 'base64' || typeof body.content !== 'string') {
       throw new Error(`GitHub sent an unreadable file (${sha})`);
     }
     return Buffer.from(body.content, 'base64');
   }
   ```

2. `filesUnder()` 的返回值多带 `sha`（`entries` 里已经有）。同时**跳过软链接**（`mode === '120000'`），把它们单独返回或者记下来，见步骤 3。
3. 把 `updateSkill()` 里下载文件的循环抽成一个函数：

   ```ts
   /** Writes a skill's files from a snapshot into `dest`; returns the paths written. */
   async function downloadSkillFiles(
     repo: string,
     files: { path: string; sha: string | null; mode: string | null }[],
     dest: string,
     token: string | null
   ): Promise<string[]>
   ```

   - 每个文件用 `remoteFileTarget(dest, file.path)` 算目标路径（它会防止 `../` 跳出目录，保留这个调用）；
   - 用 `downloadBlob` 下载，`sha` 为空的文件抛错；
   - `mode === '100755'` 的文件 `chmod 0o755`（原来就有，保留）。
4. `updateSkill()` 改成调用 `downloadSkillFiles`。**行为不能变**：下载到临时目录 → `replaceFolder` → 更新记录。

完成标志：`skill-sources.test.ts` 里原有的 `updateSkill` 测试改成模拟 blobs API 之后全部通过；新增一条：仓库里有软链接时不会把它当普通文件写出来。

### 步骤 3：扫描仓库里的 skill

文件：`skill-sources.ts`。

新增导出函数：

```ts
export type GitHubSkillCandidate = {
  /** Folder inside the repository holding SKILL.md; empty for the root. */
  path: string;
  /** The name it installs under: SKILL.md's `name`, else the folder's name. */
  name: string;
  description: string;
  /** isSafeSkillName(name); unsafe ones are listed but cannot be picked. */
  valid: boolean;
  existsInLibrary: boolean;
  /** Symlinks and submodules inside it that will not be copied. */
  skipped: string[];
};

export async function scanGitHubSkills(
  libraryDir: string,
  url: string,
  token: string | null
): Promise<{ repo: string; ref: string; commit: string; skills: GitHubSkillCandidate[] }>
```

做法：

1. `parseGitHubSkillUrl(url)`，失败抛错：`Paste a GitHub link, like https://github.com/owner/repo`。再 `resolveRefAndPath`。
2. `remoteSnapshot(repo, ref, token)`。
3. 在链接指向的目录（`path`）之下，找出所有路径以 `SKILL.md` 结尾的 blob（`entry.path === 'SKILL.md'` 或以 `/SKILL.md` 结尾，且在 `path` 之下）。它所在的文件夹就是一个 skill。
4. 嵌套的 skill（一个 skill 文件夹里面还有别的 `SKILL.md`）：只保留最外层那个，里面的忽略。
5. 每个 skill 下载它的 `SKILL.md`（`downloadBlob`），读 frontmatter 的 `name`、`description`。`skill-library.ts` 里有 `frontmatterField(markdown, field)`，把它改成导出后复用，不要再写一份。
6. `name`：frontmatter 的 `name` 去空格后非空就用它，否则用文件夹名（根目录用仓库名）。`valid = isSafeSkillName(name)`。
7. `existsInLibrary`：`~/.agentskills/<name>` 是否存在。
8. `skipped`：这个 skill 文件夹下 `mode === '120000'`（软链接）或 `type === 'commit'`（子模块）的路径。
9. 一个仓库最多处理 50 个 skill。超过时只取前 50 个（按路径排序），并在结果里多返回 `truncated: true`，界面上提示「只列出了前 50 个」。
10. 一个都没找到时抛错：`No SKILL.md found under <repo>/<path>`。

完成标志：测试覆盖：根目录就是 skill；skill 在 `.agents/skills/x/`；多个 skill；嵌套只保留外层；frontmatter 没有 `name` 用文件夹名；名字不合法 `valid = false`；库里已有同名 `existsInLibrary = true`；有软链接时 `skipped` 里有它。

### 步骤 4：安装选中的 skill

文件：`skill-sources.ts`。

```ts
export async function installGitHubSkills(
  libraryDir: string,
  input: {
    repo: string;
    ref: string;
    /** The commit the scan saw, so the install matches what the user picked from. */
    commit: string;
    picks: { path: string; name: string; overwrite: boolean }[];
  },
  token: string | null
): Promise<{ installed: string[]; skipped: { name: string; reason: string }[] }>
```

做法：

1. **用 `input.commit` 取文件树**，不是用分支。写一个 `snapshotAtCommit(repo, commit, token)`：请求 `https://api.github.com/repos/${repo}/commits/${commit}`，后面和 `remoteSnapshot` 一样。最好让 `remoteSnapshot` 内部调用它，不要复制代码。
2. 每个 pick：
   - `isSafeSkillName(name)` 不通过 → `skipped`，原因 `invalid name`；
   - 库里已有同名文件夹、`overwrite` 为假 → `skipped`，原因 `already in the library`；
   - 已有同名、`overwrite` 为真，但这个 skill 有来源记录且本地改过（`installedHash` 和当前 `folderHash` 不同）→ `skipped`，原因 `has local edits`。界面要让用户先看到这个提示，见步骤 6；
   - 否则：在 `libraryDir/.emdash/skill-update/` 下建临时目录，`downloadSkillFiles` 下载，`replaceFolder` 换进 `libraryDir/<name>`，删临时目录（`try/finally`）。
3. 装好后写来源记录（`mutateSources`）：`{ name, repo, path, ref, installedTree: <这个文件夹的 tree sha，用 treeAt(snapshot, path)>, remoteTree: 同上, installedHash: await folderHash(folder) }`。
4. 一个 skill 失败不影响其他的：每个 pick 单独 try/catch，失败的放进 `skipped`，原因是错误信息。

完成标志：测试覆盖：新装成功、文件内容正确、来源记录正确；同名不覆盖被跳过；同名覆盖成功；本地改过被跳过；名字不合法被跳过；下载中途失败时库里没有半个文件夹、原来的同名文件夹还在。

### 步骤 5：服务、合约、启动装配

1. `agent-library-service.ts`：`deps` 加 `getGitHubToken: GitHubTokenSource`。新增方法 `scanGitHubSkills(url)`、`installGitHubSkills(input)`，内部先 `const token = await deps.getGitHubToken().catch(() => null)` 再调用。装完调用 `deps.refreshSkillCatalog()`（照 `updateSkill` 的写法）。已有的 `checkSkillUpdates`、`updateSkill`、`setSkillSource` 也改成带 token。
2. `api/index.ts` 合约加：

   ```ts
   scanGitHubSkills: procedure({
     input: z.object({ url: z.string().min(1) }),
     output: z.object({
       repo: z.string(), ref: z.string(), commit: z.string(), truncated: z.boolean(),
       skills: z.array(z.object({
         path: z.string(), name: z.string(), description: z.string(),
         valid: z.boolean(), existsInLibrary: z.boolean(), skipped: z.array(z.string()),
       })),
     }),
   }),
   installGitHubSkills: procedure({
     input: z.object({
       repo: z.string().min(1), ref: z.string().min(1), commit: z.string().regex(/^[0-9a-f]{40}$/),
       picks: z.array(z.object({ path: z.string(), name: z.string().min(1), overwrite: z.boolean() })).min(1).max(50),
     }),
     output: z.object({
       installed: z.array(z.string()),
       skipped: z.array(z.object({ name: z.string(), reason: z.string() })),
     }),
   }),
   ```

   `repo` 也要校验格式：`z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)`。
3. `wire-controller.ts` 加两行转接。
4. `services.ts` 创建 `agentLibrary` 时加：

   ```ts
   // Late-bound: the GitHub credential reader is built further down in this phase.
   getGitHubToken: async () => {
     const accountId = await providerAccountRegistry.getDefaultAccountId('github');
     if (!accountId) return null;
     const credentials = await readGitHubCredentials(accountId, 'github.com');
     return credentials.success ? credentials.data.accessToken : null;
   },
   ```

   `readGitHubCredentials` 定义在后面，但这个函数只在启动完成后被调用，所以没问题（文件里已有同样的写法，搜 `Late-bound`）。如果类型检查报「used before declaration」，把这段挪到 `readGitHubCredentials` 定义之后、用一个 `let` 变量接上，并在交付说明里写出来。
5. **token 只在主进程里用**，不能出现在合约的任何输出里，也不能写进日志。

完成标志：类型检查通过；`agent-library-service.test.ts` 里构造服务的地方补上 `getGitHubToken: async () => null`。

### 步骤 6：导入弹窗

新建文件：`src/core/features/skills/browser/components/ImportGitHubSkillModal.tsx`。

1. 结构照抄 `CreateSkillModal.tsx`：`defineModal<void>()({ id: 'importGitHubSkillModal', component })`、`useModalController`、`useCloseGuard(busy)`。
2. 界面分两步：
   - **第一步**：一个输入框 `GitHub link`，占位文字 `https://github.com/owner/repo`；按钮 `Find skills`。点了调 `scanGitHubSkills`，期间按钮显示 `Searching…` 并禁用。出错把错误信息显示在输入框下面（红字，照 `CreateSkillModal` 的 `createError` 写法）。
   - **第二步**：列出找到的 skill，每行一个勾选框，显示 `name`、`description`（最多两行）、仓库内路径（灰色小字）：
     - `valid` 为假：勾选框禁用，旁边写 `Invalid name`；
     - `existsInLibrary`：默认不勾，旁边写 `Already in the library — installing replaces it`；
     - 其他：只找到一个 skill 时默认勾上，多个时默认都不勾；
     - `skipped` 非空：写 `N links or submodules will not be copied`；
     - `truncated`：列表上方写 `Showing the first 50 skills.`
   - 底部按钮 `Install (N)`，N 是勾选数量，0 时禁用。点了调 `installGitHubSkills`，`overwrite` 等于这个 skill 的 `existsInLibrary`。
3. 安装完：
   - `installed` 非空 → `toast.success('Installed N skills')`，刷新技能列表（`queryClient.invalidateQueries`，看 `CreateSkillModal` 装完是怎么刷新的，照着做；来源列表的 query key 是 `['agentLibrary', 'skillSources']`，也刷新），关闭弹窗；
   - `skipped` 非空 → 不关弹窗，在列表上方逐条显示跳过的名字和原因。
4. 注册：`skills/contributions/browser.ts` 的 `modalDefs` 加上它。
5. 打开：`SkillsToolbar.tsx` 加一个按钮 `Import from GitHub`（`variant="secondary"`，图标用 `lucide-react` 的 `Github` 或 `Download`，看项目里别处用哪个），放在「New Skill」左边；`SkillsPanel.tsx` 照 `openCreateSkillModal` 的写法打开它。
6. 翻译（`zh-CN.json`）：
   - `Import from GitHub` → `从 GitHub 导入`
   - `GitHub link` → `GitHub 链接`
   - `Find skills` → `查找技能`；`Searching…` → `查找中…`
   - `Invalid name` → `名称不合法`
   - `Already in the library — installing replaces it` → `库里已有同名技能，安装会替换它`
   - `{0} links or submodules will not be copied` → `{0} 个软链接或子模块不会被复制`（先看 `zh-CN.json` 里带数字的字符串是怎么写占位符的，照着写）
   - `Showing the first 50 skills.` → `只列出了前 50 个技能。`
   - `Install ({0})` → `安装（{0}）`；`Installed {0} skills` → `已安装 {0} 个技能`
   - 跳过原因 `invalid name` / `already in the library` / `has local edits` → `名称不合法` / `库里已有同名技能` / `本地有修改`
   - 跑 `extract-ui-strings.mjs --missing`，以它列出的为准。

完成标志：测试实例里能打开弹窗，走完公开仓库的导入（手动验证第 1 步）。

## 测试

```bash
cd /Users/hlp/Documents/code/emdash/apps/emdash-desktop
pnpm exec vitest run --project node src/core/features/agent-library src/core/features/skills
```

单元测试里**不要访问真实的 GitHub**，一律模拟 `fetch`。然后跑 README 里的检查命令。

## 手动验证（测试实例）

测试实例的技能库目录是真实的 `~/.agentskills`（`HOME` 是真实的）。**为了不弄乱用户的库**，安装测试只装一个用户库里没有的、公开的 skill，测完删掉它和它的来源记录。

1. **公开仓库**：用 `https://github.com/anthropics/skills`（或者其他公开的 skill 仓库）。期望：列出多个 skill；勾一个用户库里**没有**的（先 `ls ~/.agentskills` 确认），安装；`ls ~/.agentskills/<名字>` 有文件；`~/.agentskills/.emdash/sources.json` 里有它的记录；技能库界面里能看到它，「检查更新」不报错。
2. **私有仓库，没登录 GitHub**：测试实例的数据目录是隔离的，默认没有 GitHub 账号。用 `https://github.com/LUPENGHAN/sales`，期望：报错，错误信息里有「sign in to GitHub」。
3. **私有仓库，登录后**：这一步要在测试实例里登录用户的 GitHub 账号，**先问用户**，用户同意才做；不同意就在交付说明里写「未实测」。登录后再试第 2 步的链接，期望列出 `customer-analysis`，并显示「库里已有同名技能」（用户之前手动复制过一份）。**不要点安装**。
4. 清理：删掉第 1 步装的 skill 文件夹，并从 `~/.agentskills/.emdash/sources.json` 里删掉它的记录（先备份这个文件：`cp sources.json /tmp/sources.json.bak`，改完用 `python3 -m json.tool` 确认格式正确）。

## 提交建议

1. `feat(agent-library): send the GitHub account's token with skill requests`（步骤 1–2）
2. `feat(agent-library): find and install skills from a GitHub link`（步骤 3–5）
3. `feat(skills): import skills from GitHub`（步骤 6）

---

## 审查方案

### A. 范围

- [ ] 改动在 `src/core/features/agent-library/`、`src/core/features/skills/`、`services.ts`、`zh-CN.json`。
- [ ] 没有新增依赖（没用 Octokit，继续用 `fetch`）。

### B. token 安全（最重要）

- [ ] token 只会发给 `https://api.github.com`：读 `fetchGitHub` 的判断，并确认没有别的地方带着 token 发请求（`grep -n "authorization" skill-sources.ts`）。
- [ ] token 没有出现在合约的输出、错误信息、日志里。`grep -rn "token" ` 新增代码，逐个看。
- [ ] 取 token 失败时按匿名处理，不会让整个请求失败。
- [ ] 测试里有「没 token 不带头」「有 token 带头」两条。

### C. 写文件的安全

- [ ] 所有写进库里的路径都经过 `remoteFileTarget()`（防 `../`），新代码没有绕过它。
- [ ] skill 名字经过 `isSafeSkillName()` 才用来拼库里的路径。
- [ ] 软链接（`120000`）和子模块没有被写成文件。
- [ ] 安装是「临时目录 → 整体替换」，失败时原来的同名文件夹还在（有测试）。
- [ ] 覆盖之前检查了本地修改。

### D. 一致性

- [ ] 安装用的是扫描时的 `commit`，不是分支最新。
- [ ] 来源记录的 `installedTree` 是这个 skill 文件夹的 tree sha，装完后「检查更新」显示没有更新。自己在测试实例里装一个，立刻点检查更新确认。
- [ ] `updateSkill` 改成走 blobs API 后，原有测试全部通过，行为没变。

### E. 界面

- [ ] 名字不合法的不能勾选；已存在的默认不勾。
- [ ] 安装中关不掉弹窗（`useCloseGuard`）。
- [ ] 部分跳过时，用户能看到跳过了哪些、为什么。
- [ ] 翻译齐全，`extract-ui-strings.mjs --missing` 输出为空。

### F. 请求次数

- [ ] 扫描一个仓库的请求数大约是：1（提交）+ 1（文件树）+ 每个 skill 1（SKILL.md），有上限 50。没有对每个文件都发请求。
- [ ] 安装时每个文件 1 个请求，这是必要的；确认没有重复下载。

### G. 实测

- [ ] 自己重做手动验证第 1、2 步。
- [ ] 确认第 4 步的清理做了：用户的库里没有多出测试用的 skill，`sources.json` 和备份比只少了测试那条（`diff`）。

### 不通过的典型情况

- token 加在了所有请求上，包括 `raw.githubusercontent.com` 或任意 URL。
- 扫描时把 frontmatter 的 `name` 直接拼进路径，没校验。
- 安装直接往 `~/.agentskills/<name>` 里写文件，没走临时目录，失败时留下半个文件夹。
- 用分支名而不是扫描时的 commit 安装：扫描和安装之间仓库有新提交时，装的和用户看到的不一样。
