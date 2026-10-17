# 08 编辑器未保存缓存过期：对比误导、「全部放弃」清不掉、删除工作区后残留

先读 [README.md](README.md) 里的共用规则。分支名：`fix/editor-buffer-staleness`。

## 要解决的问题

用户报告（Emdash Fork 1.2.7）：

1. 编辑器里一份几天前没保存的缓存，在磁盘文件被外部 git 提交更新之后，仍然被套到编辑器上；对比视图看起来像代码被改回去了。
2. **点保存会用旧缓存覆盖磁盘上更新过的文件，而且不提示冲突**。这是最严重的问题。
3. 改动面板的「全部放弃」不清这份缓存，还会把未跟踪的文件连同 `node_modules` 软链接一起删掉，事先不列出来。
4. 删除任务或 worktree 之后，`emdash4-editor-buffers.db` 里这个路径的缓存记录还在。

## 已经查清的原因（执行前不用再查）

- 缓存表在 `src/core/features/editor/node/editor-buffer-service.ts`：只有 `uri`、`content`、`updated_at` 三列，**不记录这份缓存是基于哪个版本的磁盘内容改的**。
- 编辑器打开工作区时，`src/core/features/editor/api/browser/task-editor/stores/editor-view-store.ts` 的 `restoreBuffers()` 把缓存逐条交给 `openFileStore.hydrateBuffer()`。
- `src/core/features/editor/api/browser/open-file-store/open-file-store.ts`：
  - `hydrateBuffer()`（约 310 行）把缓存内容直接写进编辑缓冲区。缓冲区还没建好时先存到 `pendingBufferSeed`，等 `createFacetHandle()`（约 868 行）建好缓冲区时再写入。
  - 写入缓存之前，`entry.baseEtag` 已经被设成**当前**磁盘文件的 etag（约 870 行 `entry.baseEtag = entry.lastDiskEtag`）。
  - 保存时 `save()` 用 `baseEtag` 做前置条件。因为 `baseEtag` 是最新的，保存会直接成功，旧内容就覆盖了新文件。冲突对话框（`editor-view-store.ts` 的 `saveFile()` 看 `entry.conflicted`）根本没机会出现。
- 「全部放弃」：`src/core/features/source-control/browser/diff-view/changes-panel/unstaged-section.tsx` 的 `handleDiscardAll`，调到 `packages/core/src/runtimes/git/node/checkout/git-checkout.ts` 的 `revertAll()`，执行 `git reset --hard HEAD` 加 `git clean -fd`。`git clean -fd` 会删所有未跟踪、未被忽略的文件和目录。`node_modules` 软链接会被删，是因为 `.gitignore` 里的 `node_modules/`（带斜杠）只匹配目录，不匹配软链接。
- 缓存数据库是「派生存储」：建表 SQL 的指纹一变，整个数据库会被删掉重建（见 `editor-buffer-service.ts` 顶部注释）。**所以改表结构会丢掉用户现有的所有未保存缓存**，这是已知代价，见步骤 1 末尾。

## 不做的事

- 不改冲突对话框本身（`conflictDialog`），沿用现有的「Accept Incoming / Keep Mine」。
- 不改远程（SSH）工作区的缓存逻辑，远程文件的处理保持原样，只要别报错。
- 不重写 `open-file-store.ts` 的其他逻辑。

## 步骤

### 步骤 1：缓存记录它基于的磁盘内容

文件：`src/core/features/editor/node/editor-buffer-service.ts`、`src/core/features/editor/api/contract.ts`、`src/core/features/editor/node/wire-controller.ts`。

1. 建表 SQL 加一列 `base_hash TEXT`（可以为空）：

   ```sql
   CREATE TABLE editor_buffers (
     uri TEXT PRIMARY KEY,
     content TEXT NOT NULL,
     base_hash TEXT,
     updated_at INTEGER NOT NULL
   ) STRICT;
   ```

2. `saveBuffer(uri, content, baseHash)`：多一个参数 `baseHash: string | null`，写进 `base_hash`。
3. `EditorBufferEntry` 改成 `{ uri; content; baseHash: string | null; updatedAt: number }`。`listBuffers()` 的两条 `SELECT` 都要选出 `base_hash AS baseHash, updated_at AS updatedAt`。
4. `contract.ts` 里 `saveBuffer` 的输入加 `baseHash: z.string().nullable()`，`listBuffers` 的输出跟着改。打开文件看现有写法，照着加字段。
5. `wire-controller.ts` 把 `baseHash` 传下去。

完成标志：`src/core/features/editor/node/editor-buffer-service.db.test.ts` 的现有测试改完后能通过，新增一条测试：存了 `baseHash` 能原样读回来。这个测试文件属于 `main-db` 测试项目（见 README）。

> 改了建表 SQL，用户升级后第一次启动时旧缓存会被整库清掉。在交付说明里写出来，提醒用户升级前把所有文件保存好。

### 步骤 2：自动保存缓存时带上基准

文件：`open-file-store.ts`。

1. 新建一个小工具函数，放在同目录的新文件 `buffer-base-hash.ts`：

   ```ts
   /** SHA-256 of the disk text a buffer was edited from, so a stale row can be spotted. */
   export async function bufferBaseHash(text: string): Promise<string> {
     const bytes = new TextEncoder().encode(text);
     const digest = await crypto.subtle.digest('SHA-256', bytes);
     return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
   }
   ```

2. `OpenFileEntryImpl` 加一个字段 `baseText: string | undefined`：**缓冲区开始被编辑时对应的磁盘文本**。所有给 `entry.baseEtag = entry.lastDiskEtag` 赋值的地方（约 375、421、827、870、932 行，用 `grep -n "baseEtag = entry.lastDiskEtag\|baseEtag = impl.lastDiskEtag"` 找全），旁边同时写 `baseText = lastDiskText`。
3. `onBufferChanged()` 的自动保存（约 919 行）改成：

   ```ts
   const base = entry.baseText;
   void (base === undefined ? Promise.resolve(null) : bufferBaseHash(base))
     .then(async (baseHash) => (await getEditorClient()).saveBuffer({ uri, content, baseHash }))
     .catch(() => undefined);
   ```

4. 第 386 行、455 行另外两处 `saveBuffer` 调用也补上 `baseHash`，算法一样。

完成标志：类型检查通过，没有漏传 `baseHash` 的调用。

### 步骤 3：恢复缓存时发现过期就标冲突，不悄悄套用

文件：`open-file-store.ts`、`editor-view-store.ts`。

1. `hydrateBuffer(ref, content)` 改成 `hydrateBuffer(ref, row: { content: string; baseHash: string | null; updatedAt: number })`。`editor-view-store.ts` 的 `restoreBuffers()` 把整行传进来。
2. `OpenFileEntryImpl` 加字段 `pendingBufferSeedBase: string | null | undefined`，和 `pendingBufferSeed` 一起存、一起清空。
3. 新写一个私有方法，处理「把缓存写进缓冲区」这件事，`hydrateBuffer()` 直接写入的分支和 `createFacetHandle()` 里用 `pendingBufferSeed` 的分支**都改成调用它**：

   ```ts
   /**
    * Applies a recovered buffer row. A row edited from other disk text than what is on
    * disk now (or a row from before rows recorded it) is a conflict, so saving asks
    * instead of writing the stale text over newer work.
    */
   private async applyRecoveredBuffer(
     entry: OpenFileEntryImpl,
     handle: FacetHandle,
     content: string,
     baseHash: string | null
   ): Promise<void> {
     const disk = entry.lastDiskText;
     const stale = disk === undefined || baseHash === null || baseHash !== (await bufferBaseHash(disk));
     // The entry may have changed while hashing (user typed, file closed).
     if (this.entries.get(entry.key) !== entry || entry.dirty) return;
     if (handle.getText() === content) return;
     this.silentSet(entry, handle, content);
     this.reconcileDirty(entry);
     if (stale && entry.dirty) {
       runInAction(() => {
         entry.conflicted = true;
         entry.recoveredStale = true;
       });
     }
   }
   ```

   - `FacetHandle` 用文件里实际的类型名，先看 `slot.handle` 的类型再写。
   - `recoveredStale` 是新加的 observable 布尔字段，在 `makeObservable` 那里注册（照着 `conflicted` 的写法），并加到公开的 `OpenFileEntry` 接口里（约 73 行，`readonly recoveredStale: boolean`）。
   - `reloadFromDisk()` 和保存成功的地方要把 `recoveredStale` 设回 `false`（和 `conflicted = false` 写在一起）。
4. 结果：过期的缓存仍然显示在编辑器里（用户的修改不丢），但 `conflicted = true`。用户按保存时，`saveFile()` 会弹现有的冲突对话框，不会直接覆盖。

完成标志：`open-file-store.test.ts` 新增三条测试，全部通过：
- 缓存的 `baseHash` 和当前磁盘一致 → 套用，`dirty = true`，`conflicted = false`；
- 不一致 → 套用，`conflicted = true`，`recoveredStale = true`；调用 `save()`（不带 overwrite）返回冲突，磁盘内容不变；
- `baseHash` 为 `null`（旧数据）→ 和不一致一样处理。

先看 `open-file-store.test.ts` 里现有的 `hydrateBuffer` 测试是怎么造假磁盘和假客户端的，照着写。

### 步骤 4：告诉用户这是恢复出来的旧修改

文件：编辑器标签页的状态显示。先用下面的命令找到显示 `conflicted` 状态的界面：

```bash
cd apps/emdash-desktop && grep -rn "conflicted" src/core/features/editor --include=*.tsx
```

（如果 `--include` 报错，就去掉它，再用 `grep -v test` 过滤。）

1. 在文件标签或编辑器顶部，`recoveredStale` 为真时显示一行提示：`Unsaved changes from an earlier session. The file has changed on disk since.`，旁边两个按钮：
   - `Reload from disk`：调 `openFileStore.reloadFromDisk(entry)`，同时清掉这条缓存记录（`reloadFromDisk` 里已经调了 `clearBuffer`，确认一下）；
   - `Compare`：打开对比视图，比较磁盘和这份修改（见步骤 5）。
2. 找不到合适的现成位置时，用 `toast`（`@emdash/ui/react/primitives` 里的 `toast.warning` 或项目里实际有的方法）在恢复时提示一次，并把这个决定写进交付说明。

完成标志：测试实例里能看到这行提示（手动验证第 2 步）。

### 步骤 5：对比视图写清两边是什么

用户看到的那种「磁盘 ↔ 未保存修改」对比，标题里要能看出来不是 git 改动。

1. 找到对比的界面：

   ```bash
   cd apps/emdash-desktop && grep -rln "DISK_SLOT\|kind: 'disk'" src/core/features/editor src/core/features/source-control | grep -v test
   ```

   重点看 `src/core/features/editor/contributions/browser/monaco/sticky-diff-editor.tsx` 和 `src/core/features/editor/api/browser/task-editor/stores/file-tab-resource.ts`，确认哪个对比的两边分别是「磁盘」和「缓冲区」。
2. 在这个对比的标题（或左右两边的标签）上写明：左边 `On disk`，右边 `Unsaved changes`。git 对比保持原来的写法（`HEAD` / `Working tree` 或现有文字）。
3. 如果找不到「磁盘 ↔ 缓冲区」的对比，而用户看到的其实是 git 对比（`HEAD ↔ 工作区`）里混进了缓冲区内容，停下来，在交付说明里写清楚你看到的代码路径，不要猜着改。

完成标志：测试实例里打开过期缓存的对比，能看到两边的标签。

### 步骤 6：「全部放弃」清缓存、先列出要删的文件、不删软链接

文件：`unstaged-section.tsx`、`src/core/features/source-control/browser/stores/git-checkout-store.ts`、`packages/core/src/runtimes/git/api/checkout/contract.ts`、`packages/core/src/runtimes/git/node/checkout/checkout-runtime.ts`、`packages/core/src/runtimes/git/node/checkout/checkout-resource.ts`、`packages/core/src/runtimes/git/node/checkout/git-checkout.ts`。

1. `revertAll` 的输入从 `z.object({})` 改成 `z.object({ includeUntracked: z.boolean().default(true) })`。一路改到 `git-checkout.ts`：

   ```ts
   async revertAll(options: { includeUntracked: boolean }): Promise<Result<void, GitCommandError>> {
     return this.commandMutation(async () => {
       try {
         await this.exec.exec(['reset', '--hard', 'HEAD']);
       } catch (error) {
         if (!checkoutFailures.isUnbornHead(error)) throw error;
       }
       if (!options.includeUntracked) return;
       const untracked = await this.untrackedPathsWithoutSymlinks();
       if (untracked.length > 0) await this.exec.exec(['clean', '-fd', '--', ...untracked]);
     });
   }
   ```

   - `untrackedPathsWithoutSymlinks()`：运行 `git ls-files --others --exclude-standard --directory -z`，按 `\0` 切开，对每一项 `lstat`，去掉软链接。先看同文件里 `revert()`（约 125 行）是怎么拿未跟踪路径的，能复用就复用。
   - 软链接被保留，是为了不再误删 `node_modules` 这类链接。
2. `git-checkout-store.ts` 的 `discardAllFiles()` 改成 `discardAllFiles(options: { includeUntracked: boolean })`。
3. `unstaged-section.tsx` 的 `handleDiscardAll`：
   - 从改动面板现有的数据里取出未跟踪的文件（状态是新增、未跟踪的那些；先看 `changesView` 里是怎么区分的）；
   - 确认框的说明里列出：会还原多少个已跟踪文件；会删除哪些未跟踪文件（最多列 20 个，多了写「and N more」）；
   - 加一个勾选框 `Also delete untracked files`，**默认不勾**。看 `openConfirmActionModal` 支不支持勾选框；不支持就用两个按钮代替：`Discard tracked changes` 和 `Discard and delete untracked`；
   - 放弃成功后，清掉这个工作区里所有文件的编辑器缓存（见第 4 点）。
4. 清缓存：
   - `editor-buffer-service.ts` 加方法 `clearBuffers(root: ResourceUri)`，删掉 `root` 下所有记录（`WHERE substr(uri, 1, ?) = ?`，和 `listBuffers(root)` 用同样的前缀写法），加到 contract 和 wire-controller。
   - 已打开的文件：`open-file-store.ts` 加 `discardDirtyUnder(root: ResourceUri)`，只对这个工作区下的脏文件调用 `reloadFromDisk`。不要用现有的 `discardAllDirty()`，它会影响所有工作区。
   - `handleDiscardAll` 成功后依次调用这两个。工作区的 root 怎么拿：参考 `editor-view-store.ts` 里的 `this.files?.rootUri`，在改动面板这边找同一个工作区的 root；找不到现成的，就在交付说明里写出来，先只做 `discardDirtyUnder` 能做到的部分。

完成标志：
- `packages/core/src/runtimes/git/node/checkout/git-checkout.test.ts` 覆盖：`includeUntracked: false` 不删未跟踪文件；`true` 删普通未跟踪文件但保留未跟踪的软链接。测试用 `os.tmpdir()` 下的临时仓库。
- 测试实例里手动验证第 3 步通过。

### 步骤 7：删除任务或 worktree 时清掉缓存

文件：`src/core/features/tasks/api/node/task-service.ts`（约 416–460 行的 `deleteWorktree` 流程）、`editor-buffer-service.ts`、启动装配 `src/main/bootstrap/boot/phases/services.ts` 或 `database.ts`。

1. `editor-buffer-service.ts` 加方法：

   ```ts
   /** Drops rows for local files under `dir` (a removed worktree). Remote rows are kept. */
   async clearBuffersUnderLocalPath(dir: string): Promise<void>
   ```

   做法：`SELECT uri FROM editor_buffers`，逐条 `decodeResourceUri`；只处理本地主机的记录（看 `HostFileRef.host.type`，本地的值先在代码里确认）；把它的路径还原成字符串（找 `packages/core/src/primitives/path/api` 里把 `HostAbsolutePath` 转成字符串的函数），如果等于 `dir` 或以 `dir + path.sep` 开头，就删掉。
2. worktree 删除成功之后调用它。`task-service.ts` 拿不到 `editorBuffer` 的话，通过构造参数（deps）传进去，在启动装配里接上。`editorBuffer` 在 `src/main/bootstrap/boot/phases/database.ts` 创建，看它是怎么传给 editor 的 wire-controller 的，照着传。
3. 清理失败只记警告日志，不能让删除任务失败。

完成标志：`editor-buffer-service.db.test.ts` 覆盖：目录下的记录被删，目录外的、名字只是前缀相同的（`/a/b` 和 `/a/bc`）、远程的都保留。

### 步骤 8：启动时清掉文件已经不存在的记录

文件：`editor-buffer-service.ts` 的 `pruneStale()`。

在按时间清理之后，再对本地记录逐条检查文件是否存在（`fs.promises.stat`，捕获 `ENOENT`），不存在就删。远程记录跳过。整段包在 try/catch 里，出错只记日志。

完成标志：测试覆盖「文件不存在的记录被删，文件存在的保留」。

### 步骤 9：确认删除工作区后不会再写缓存

用户观察到删除工作区前后缓存还在被写入。先按下面的手动验证第 4 步复现：

- 删除任务后，编辑器标签如果还开着、还在自动保存缓存，就在 `onBufferChanged` 的自动保存里加判断：`entry.status.kind` 是 `orphaned` 或 `error` 时不再保存缓存（状态名以代码里实际的为准）。
- 如果复现不出来，就不改代码，在交付说明里写明「没复现」。

## 测试

```bash
cd /Users/hlp/Documents/code/emdash/apps/emdash-desktop
pnpm exec vitest run --project node src/core/features/editor src/core/features/source-control
pnpm exec vitest run --project main-db src/core/features/editor/node/editor-buffer-service.db.test.ts
cd ../../packages/core && pnpm exec vitest run src/runtimes/git
```

最后跑 README 里的检查命令。

## 手动验证（测试实例）

准备：在测试实例里加一个本地项目，用 `/tmp/emd-ui/repo` 或新建一个临时仓库，里面提交一个 `a.ts`。

1. **过期缓存不覆盖**：在编辑器里打开 `a.ts`，改一行不保存，等 2 秒（自动保存缓存），关掉测试实例。在终端里改 `a.ts` 的另一行并 `git commit`。重新打开测试实例和这个文件：
   - 期望：编辑器里是旧的修改，顶部有「Unsaved changes from an earlier session…」提示；
   - 按 Cmd+S：弹冲突对话框，不会直接保存；选「Accept Incoming」后，文件内容是终端里提交的版本。
2. **对比标签**：重复第 1 步，点提示里的 `Compare`，两边标签是 `On disk` 和 `Unsaved changes`。
3. **全部放弃**：在仓库里新建未跟踪文件 `tmp.txt`，建一个未跟踪的软链接 `ln -s /tmp linked`，改 `a.ts` 不保存（产生缓存）。在改动面板点「全部放弃」：
   - 确认框列出 `tmp.txt`；
   - 不勾选删除未跟踪：`tmp.txt` 和 `linked` 都还在，`a.ts` 已还原；
   - 再来一次并勾选：`tmp.txt` 被删，`linked` 还在；
   - 编辑器里 `a.ts` 不再显示未保存。
4. **删除 worktree**：建一个 worktree 任务，打开里面的文件改一行不保存，删除这个任务（勾选删除 worktree）。然后用只读方式查数据库：

   ```bash
   sqlite3 "file:/tmp/emd-ui/data/emdash4-editor-buffers.db?mode=ro" "select uri from editor_buffers"
   ```

   期望：没有这个 worktree 路径下的记录。等 10 秒再查一次，确认没有被重新写入。数据库文件名以实际为准，用 `ls /tmp/emd-ui/data` 确认。
5. 删掉测试用的 worktree，关闭测试实例。

## 提交建议

1. `fix(editor): record the disk text an unsaved buffer was edited from`（步骤 1–3）
2. `fix(editor): flag recovered buffers that predate the file on disk`（步骤 4–5）
3. `fix(source-control): list untracked files before discarding all, keep symlinks`（步骤 6）
4. `fix(editor): drop buffers of removed worktrees and missing files`（步骤 7–9）

---

## 审查方案

审查的人按顺序做，每一项都要有结论（通过 / 不通过 / 不适用）。

### A. 范围

- [ ] `git diff --stat feat/multi-agent...HEAD` 只涉及这些地方：`src/core/features/editor/`、`src/core/features/source-control/`、`src/core/features/tasks/api/node/task-service.ts`、`packages/core/src/runtimes/git/`、启动装配、`zh-CN.json`。多出来的文件逐个问为什么。
- [ ] 没有改 `drizzle/`、没有提交 `.db` 文件。

### B. 最关键的行为：不能再悄悄覆盖

- [ ] 读 `open-file-store.ts` 的 diff：所有「把缓存内容写进缓冲区」的路径（`hydrateBuffer` 直接写入、`pendingBufferSeed` 在 `createFacetHandle` 里写入）都走 `applyRecoveredBuffer`，没有漏掉的分支。用 `grep -n "pendingBufferSeed\|silentSet" open-file-store.ts` 逐个核对。
- [ ] `baseHash === null` 的旧记录按过期处理，不是按正常处理。
- [ ] 异步算 hash 之后重新检查了 entry 还在、用户没有在这期间开始编辑。
- [ ] 测试里有「过期 → save() 返回冲突 → 磁盘不变」这一条，并且断言了磁盘内容。
- [ ] 每个给 `baseEtag` 赋值的地方，旁边都更新了 `baseText`（`grep -n "baseEtag =" open-file-store.ts`，数量要对得上）。

### C. 全部放弃

- [ ] `includeUntracked` 的默认值：wire 层 `default(true)` 是为了兼容别的调用方；界面上默认不删未跟踪文件。确认界面确实默认不删。
- [ ] 软链接过滤用的是 `lstat`，不是 `stat`（`stat` 会跟着链接走，判断不出来）。
- [ ] `git clean` 的参数里有 `--`，路径来自 git 输出而不是用户输入；路径用 `-z` 和 `\0` 切分，文件名有空格不会出错。
- [ ] 清缓存只清这个工作区，没有调用会影响所有工作区的 `discardAllDirty()`。
- [ ] 自己在临时仓库里跑一遍：未跟踪文件、未跟踪目录、未跟踪软链接、文件名带空格，各自结果正确。

### D. 删除 worktree 清缓存

- [ ] 前缀判断用了路径分隔符，`/a/b` 不会误删 `/a/bc`，有测试。
- [ ] 清理失败只记日志，删除任务本身不受影响（看 try/catch 包的范围）。
- [ ] 远程记录不受影响。

### E. 数据库

- [ ] 建表 SQL 改了，交付说明里写了「升级后旧缓存会被清空」。
- [ ] 所有 SQL 用参数绑定（`?`），没有把路径或 uri 拼进 SQL 字符串。

### F. 界面和翻译

- [ ] 新增的英文文字都在 `zh-CN.json` 里有翻译，`extract-ui-strings.mjs --missing` 输出为空。
- [ ] 截图或亲自在测试实例里看：提示条、对比标签、确认框的文件列表都正常显示。

### G. 检查命令

- [ ] 自己重新跑一遍 README 里的检查命令和上面的测试命令，结果和交付说明一致。
- [ ] 手动验证 1、3、4 至少亲自重做一遍，第 1 步必须重做。

### 不通过的典型情况

- 只在 `hydrateBuffer` 里加了判断，`pendingBufferSeed` 那条路径没改：打开文件时缓冲区还没建好，走的就是这条路，问题依然存在。
- 用 etag 而不是内容 hash 判断过期：`git checkout` 会改 mtime，内容没变也会报冲突，误报太多。
- 「全部放弃」把默认改成了「不删未跟踪文件」，但 wire 层默认也改成了 `false`，影响了别的调用方又没检查。
