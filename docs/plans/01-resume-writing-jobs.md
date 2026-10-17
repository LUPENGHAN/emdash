# 01 续写要能记多个任务

先读 [README.md](README.md) 里的共用规则。分支名：`feat/resume-writing-jobs`。

## 要做的事

「续写」（Continue writing）是一个设置：应用开着时，按时间、按用量窗口重置、或者在官方账号额度快用完时，自动给某个会话发一句「继续」，或者换个账号交接过去。

现在只能设置**一个**会话。要改成一个列表：每一条（下面叫「续写任务」）各自选项目、任务、会话，各自设触发条件，各自发送，互不影响。

用户已有的那一条设置，升级后要自动变成列表里的第一条，不能丢。

## 不做的事

- 不把续写搬到主进程（仍然在窗口里跑，应用开着才生效，和现在一样）。
- 不改触发条件的算法（`decideResume` 里的时间、窗口重置、额度判断逻辑不变）。
- 不改交接（handoff）的做法。

## 已知代码位置

- `src/core/features/conversations/contributions/resume-settings.ts`：设置的 schema `resumeWritingSettingsSchema`、默认值、注册（key 是 `resumeWriting`）。现在是一个扁平对象：`enabled`、`projectId`、`taskId`、`conversationId`、`text`、`clockTime`、`onWindowReset`、`quotaPercent`、`confirm`，加上三个记账字段 `clockDay`、`usagePercents`、`quotaKey`。
- `src/core/features/conversations/browser/resume-writing.ts`：纯函数 `decideResume({ now, settings, providerId, modelSource, accounts })`，决定这次该不该发。测试：`resume-writing.test.ts`。
- `src/core/features/conversations/browser/resume-writing-watcher.tsx`：
  - `ResumeWritingWatcher` 组件：每 20 秒跑一次 `runResumeTick`；
  - 模块级变量 `ticking`、`failures`、`retryAt`（全局只有一份）和 `usageCache`；
  - `deliver()` 发消息、`handoff()` 交接。
- `src/core/features/conversations/contributions/browser/resume-writing-settings.tsx`：设置页面。
- `src/renderer/App.tsx` 约 128 行挂载 `<ResumeWritingWatcher />`。小窗（`src/renderer/app/popout-app.tsx`）没有挂载。
- 设置读写：
  - `src/core/features/settings/api/browser/use-app-settings-key.ts` 的 `useAppSettingsKey(key)`，返回 `value` 和 `updateAsync(partial)`。`updateAsync` 把 `partial` **浅合并**到缓存里的当前值再整个写回；
  - `src/core/features/settings/api/browser/app-settings-client.ts`：`requestAppSettingsMeta(key)`（从主进程读最新值）、`updateAppSettingsRequest(key, value)`；
  - 主进程 `src/core/services/settings/node/settings-store.ts`：存的是「和默认值的差异」，读的时候和默认值深合并，再用 schema `safeParse`，**解析失败就返回默认值**（所以 schema 写错会让用户的设置看起来全没了）。
- `src/renderer/lib/runtime/browser-host.ts`：`isBrowserHost`，在远程浏览器里打开时为真。

## 数据结构

```ts
// resume-settings.ts
export const resumeJobSchema = z.object({
  id: z.string().min(1),
  enabled: z.boolean().default(true),
  projectId: z.string().default(''),
  taskId: z.string().default(''),
  conversationId: z.string().default(''),
  text: z.string().default('继续'),
  clockTime: z.string().default(''),
  onWindowReset: z.boolean().default(false),
  quotaPercent: z.number().min(1).max(100).nullable().default(null),
  confirm: z.boolean().default(false),
  clockDay: z.string().nullable().default(null),
  usagePercents: z.string().nullable().default(null),
  quotaKey: z.string().nullable().default(null),
});
export type ResumeJob = z.infer<typeof resumeJobSchema>;

export const resumeWritingSettingsSchema = z.preprocess(
  migrateLegacyResumeWriting,
  z.object({ jobs: z.array(resumeJobSchema).default([]) })
);
export type ResumeWritingSettings = { jobs: ResumeJob[] };
export const DEFAULT_RESUME_WRITING_SETTINGS: ResumeWritingSettings = { jobs: [] };
```

旧数据的迁移：

```ts
/** The id the single pre-list setting becomes, so its bookkeeping carries over. */
export const LEGACY_RESUME_JOB_ID = 'legacy';

/**
 * Before the list, the setting was one flat job. Stored values are a delta merged over
 * the defaults, so an old one arrives as `{ jobs: [], enabled, projectId, … }`.
 */
function migrateLegacyResumeWriting(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const value = raw as Record<string, unknown>;
  const jobs = Array.isArray(value.jobs) ? value.jobs : [];
  if (jobs.length > 0 || typeof value.conversationId !== 'string' || !value.conversationId) {
    return { jobs };
  }
  const { jobs: _jobs, ...legacy } = value;
  return { jobs: [{ ...legacy, id: LEGACY_RESUME_JOB_ID }] };
}
```

**先确认 `defineSettingsContribution` 接受 `z.preprocess` 的 schema**（看 `src/core/primitives/settings/api/contribution.ts` 里 `schema` 的类型）。如果类型不接受，改用下面的备选，并在交付说明里写出来：

- schema 保持 `z.object({ jobs: …, ...旧字段全部 .optional() })`；
- 新写一个函数 `resumeJobsOf(settings): ResumeJob[]`，`jobs` 非空就返回 `jobs`，否则用旧字段拼出 id 为 `legacy` 的一条；
- 所有读 jobs 的地方都通过 `resumeJobsOf`；每次写都写 `{ jobs, …旧字段全部 undefined }`。

## 步骤

### 步骤 1：schema 和迁移

文件：`resume-settings.ts`。按上面的「数据结构」改。

完成标志：新建 `resume-settings.test.ts`：
- 旧格式 `{ jobs: [], enabled: true, projectId: 'p', taskId: 't', conversationId: 'c', text: 'go', clockTime: '09:00', quotaPercent: 80, clockDay: '2026-10-01', … }` 解析后是一条 id 为 `legacy` 的 job，所有字段原样保留；
- `{ jobs: [] }` 和 `{}` 解析为空列表；
- 新格式（`jobs` 有两条）原样保留，旧字段被忽略；
- 旧格式但 `conversationId` 为空 → 空列表。

### 步骤 2：判断逻辑改用单条 job

文件：`resume-writing.ts`、`resume-writing.test.ts`。

1. `decideResume` 的入参 `settings: ResumeWritingSettings` 改成 `job: ResumeJob`；返回值里的 `patch` 类型改成 `Partial<ResumeJob>`。函数体里把 `settings.` 换成 `job.`。**逻辑一行都不要改。**
2. 测试里构造参数的地方同步改名，断言不变。

完成标志：`resume-writing.test.ts` 原有测试全部通过，断言没有改动（`git diff` 里测试只有改名）。

### 步骤 3：写设置要排队，避免互相覆盖

新建文件：`src/core/features/conversations/browser/resume-jobs-store.ts`。

背景：现在设置页面和后台监听都会写这个设置。改成列表后，两边同时写不同的 job，如果各自拿自己手里的旧列表整个写回，就会把对方刚写的改动冲掉。

```ts
import { requestAppSettingsMeta, updateAppSettingsRequest, invalidateAppSettingsKey } from '@core/features/settings/api/browser/app-settings-client';
import type { ResumeJob } from '@core/features/conversations/contributions/resume-settings';

let queue: Promise<unknown> = Promise.resolve();

/**
 * Every change to the job list goes through here, one at a time, starting from the value
 * the main process holds: the settings page and the watcher both write, and a whole-list
 * write from a stale copy would undo the other's change.
 */
export function changeResumeJobs(change: (jobs: ResumeJob[]) => ResumeJob[]): Promise<void> {
  const run = async () => {
    const meta = await requestAppSettingsMeta('resumeWriting');
    const next = change(meta.value.jobs);
    await updateAppSettingsRequest('resumeWriting', { jobs: next });
    invalidateAppSettingsKey('resumeWriting');
  };
  const next = queue.then(run, run);
  queue = next.catch(() => {});
  return next;
}

export const patchResumeJob = (id: string, patch: Partial<ResumeJob>) =>
  changeResumeJobs((jobs) => jobs.map((job) => (job.id === id ? { ...job, ...patch } : job)));
export const addResumeJob = (job: ResumeJob) => changeResumeJobs((jobs) => [...jobs, job]);
export const removeResumeJob = (id: string) =>
  changeResumeJobs((jobs) => jobs.filter((job) => job.id !== id));
```

- 先确认 `requestAppSettingsMeta`、`updateAppSettingsRequest`、`invalidateAppSettingsKey` 的真实签名（打开 `app-settings-client.ts` 看），按实际参数调用。
- `patchResumeJob` 对一条已经被删掉的 job 不做任何事（`map` 找不到就不变），这是对的：监听器可能在用户删掉这条之后才写回记账字段。

完成标志：类型检查通过。

### 步骤 4：后台监听按条运行

文件：`resume-writing-watcher.tsx`。

1. `ResumeWritingWatcher`：
   - 用 `useAppSettingsKey('resumeWriting')` 读 `value.jobs`，放进 ref（和现在一样的写法）；
   - 只要有任意一条 `enabled` 就启动定时器，否则不启动；
   - **`isBrowserHost` 为真时直接 `return null`**，不启动定时器。远程浏览器打开时也会渲染 `App.tsx`，不加这个判断，电脑上的窗口和浏览器会各发一次。
   - 再确认一种情况：这台电脑的窗口切换到「另一台电脑」时（`switchComputer`，见 `src/core/features/remote-access/browser/computer-switch.ts`），窗口是重新加载并连到对方的。这时这个窗口里的监听会替对方的设置发消息，而对方自己的窗口也在发。找一下窗口怎么知道自己连的是别的电脑（看 `remote-access` 下的 `remote-client` 接口，搜 `serverId`），是的话也 `return null`。找不到判断方法就在交付说明里写出来，不要自己造一个。
2. 每 20 秒一次的 tick 改成：对每条 `enabled` 的 job 依次调用 `runResumeJob(job)`。
3. 模块级的 `ticking`、`failures`、`retryAt` 改成按 job id 存：

   ```ts
   const running = new Set<string>();
   const failures = new Map<string, number>();
   const retryAt = new Map<string, number>();
   ```

   一条失败只让这一条退避，其他照常。`usageCache` 和 `usageAt` 保持全局共用（同一个 tick 里多条 job 只查一次用量）。
4. `runResumeTick(settings, update)` 改成 `runResumeJob(job)`，里面所有 `update(patch)` 改成 `patchResumeJob(job.id, patch)`；交接后 `update({ conversationId: createdId })` 改成 `patchResumeJob(job.id, { conversationId: createdId })`。
5. 确认框（`confirm`）的标题里加上 job 的会话标题，让用户知道是哪一条：例如 `Continue “<会话标题>”?`。会话标题从 `loadConversation` 拿到的 `conversation.title` 取。
6. 定时器回调里 `for … of` 依次 `await`，不要 `Promise.all` 并发（避免同时弹多个确认框）。

完成标志：类型检查通过；`resume-writing.test.ts` 通过。监听器本身不好单测，靠手动验证。

### 步骤 5：设置页面改成列表

文件：`resume-writing-settings.tsx`。

1. 把现在页面里「On」开关以下、针对一个会话的整块表单，抽成组件 `ResumeJobCard({ job })`。卡片内部：
   - 顶部一行：开关（`enabled`）、这条的标题（选了会话就显示 `agent · 会话标题`，没选显示 `New job`）、右侧删除按钮（图标按钮，`aria-label="Remove"`）；
   - 下面是原来的「Conversation」「Send in the same conversation」「Hand off to another official account」「Ask before sending」几块，字段和交互完全照旧；
   - 原来的 `save(patch)` 改成调用 `patchResumeJob(job.id, next)`，`clockDayIfPassed`、「改了目标就清空 `usagePercents`、`quotaKey`」这些规则原样保留；
   - 每张卡片自己用 `useQuery` 取这个项目的会话（`queryKey` 带上 `job.projectId`，照原来的写法）。
2. 页面顶部：标题和说明不变；去掉原来全局的「On」开关；加按钮 `Add`：

   ```ts
   void addResumeJob({ ...resumeJobSchema.parse({ id: crypto.randomUUID() }) });
   ```

3. 列表为空时显示一行说明：`No conversations yet. Add one to have Emdash continue it.`
4. 删除前用 `openConfirmActionModal`（或文件里已有的确认方式）问一句：`Remove this job?`。
5. 输入框（`Message`、`Clock time`、`%`）每敲一个字就写一次设置会很频繁，而且每次都走排队。保持和现在一样的即时保存即可（现在也是每次输入都保存），不要加防抖，避免引入新问题。
6. 翻译：`Add` → `添加`；`New job` → `新的续写`；`Remove` → `删除`；`Remove this job?` → `删除这条续写？`；`No conversations yet. Add one to have Emdash continue it.` → `还没有续写。添加一条，让 Emdash 自动继续对话。`；`Continue “{0}”?` → `继续「{0}」？`（占位符写法照 `zh-CN.json` 里已有的）。跑 `extract-ui-strings.mjs --missing` 为准。

完成标志：测试实例里能加两条、分别设置、删掉一条，重开设置页内容不变。

### 步骤 6：清理

- `resume-writing-settings.tsx` 和监听器里不再引用 `DEFAULT_RESUME_WRITING_SETTINGS` 的旧字段。
- `grep -rn "settings\.conversationId\|settings\.enabled\|settings\.clockTime" src/core/features/conversations` 没有残留（`job.` 开头的才对）。

## 测试

```bash
cd /Users/hlp/Documents/code/emdash/apps/emdash-desktop
pnpm exec vitest run --project node src/core/features/conversations/browser/resume-writing.test.ts src/core/features/conversations/contributions
```

然后跑 README 里的检查命令。

## 手动验证（测试实例，不花额度）

**不要让续写真的给 agent 发消息**（会花额度）。所有验证都用「Ask before sending」（发送前询问）打开的 job，确认框弹出来后点**取消**。

1. **旧设置迁移**：
   - 测试实例跑的就是新代码，没法先用旧版本存一条设置，所以直接往数据库里写一条旧格式的。先启动一次测试实例再关掉，让它建好数据库；确认 `/tmp/emd-ui/data/emdash4.db` 存在；然后**用 sqlite3 写入一条旧格式的设置**（这是测试实例的数据库，不是用户的，不要写错路径）：

     ```bash
     sqlite3 /tmp/emd-ui/data/emdash4.db "insert or replace into app_settings(key, value) values ('resumeWriting', '{\"enabled\":true,\"projectId\":\"p1\",\"taskId\":\"t1\",\"conversationId\":\"c1\",\"text\":\"继续\",\"clockTime\":\"09:00\",\"confirm\":true}')"
     ```

     先用 `sqlite3 /tmp/emd-ui/data/emdash4.db ".schema app_settings"` 确认表结构和列名，按实际的写。
   - 再启动测试实例，打开「设置 → 续写」：期望列表里有一条，时间是 09:00，「发送前询问」打开。
2. **两条互不影响**：在测试实例里建一个项目和两个任务，每个任务建一个会话（**终端会话建好后不要发消息**）。加两条续写，分别指向两个会话，都打开「发送前询问」，时间都设成当前时间之后 1 分钟。等时间到：期望弹出两个确认框（一个接一个，标题里分别是两个会话的名字），都点取消。
3. **一条失败不影响另一条**：把第一条的会话删掉（在应用里删会话），第二条时间再设到 1 分钟后。期望：第一条报「That conversation is gone」的提示，第二条照常弹确认框。
4. **同时写不丢**：在第 2 步的确认框弹出时（监听器正在处理），快速改另一条的消息文字。取消确认框后，重新打开设置页，期望改的文字还在。
5. 清理：删掉测试项目的 worktree（只删自己建的），关闭测试实例。

## 提交建议

1. `feat(conversations): keep a list of continue-writing jobs`（步骤 1–3）
2. `feat(conversations): run each continue-writing job on its own`（步骤 4）
3. `feat(conversations): edit continue-writing jobs as a list`（步骤 5–6）

---

## 审查方案

### A. 范围

- [ ] 改动在 `src/core/features/conversations/` 的续写相关文件、`zh-CN.json`。
- [ ] `decideResume` 的逻辑没变：`git diff` 里 `resume-writing.ts` 只有改名（`settings` → `job`、类型名），测试断言没变。

### B. 旧数据不丢（最重要）

- [ ] 迁移测试覆盖了旧格式的每一个字段，包括 `clockDay`、`usagePercents`、`quotaKey`（不然升级当天可能重复发送）。
- [ ] 迁移出来的 id 是固定的 `legacy`，不是随机的。
- [ ] schema 写错时主进程会退回默认值（空列表），看起来像设置丢了。自己用手动验证第 1 步确认旧数据能读出来。
- [ ] 用户第一次在新界面上改动后，存进数据库的是 `{ jobs: [...] }`，旧字段不再出现（用 sqlite3 只读查测试实例的数据库确认）。

### C. 不会重复发送

- [ ] 远程浏览器（`isBrowserHost`）里不启动监听。
- [ ] 连到别的电脑的窗口里不启动监听；如果执行的人没找到判断方法，交付说明里写了，审查的人决定是否接受。
- [ ] 每条 job 有自己的「正在处理」标记，同一条不会在上一次还没结束时又开始。
- [ ] 多条 job 依次处理，不是并发。

### D. 写设置不互相覆盖

- [ ] 所有写 `resumeWriting` 的地方都走 `changeResumeJobs` / `patchResumeJob`，没有直接用 `updateAsync`。`grep -rn "updateAsync\|useAppSettingsKey('resumeWriting')" src/core/features/conversations` 确认。
- [ ] `changeResumeJobs` 每次都先从主进程读最新值，不是用组件里的值。
- [ ] 对已删除的 job 写记账字段，不会把它加回来。

### E. 界面

- [ ] 每张卡片的交互和原来的单个表单一致（选项目会清空任务和会话，选任务会清空会话，等等）。
- [ ] 删除有确认。
- [ ] 翻译齐全。

### F. 检查和实测

- [ ] 检查命令通过。
- [ ] 自己重做手动验证第 1、2 步。确认过程中没有真的给 agent 发出消息（确认框都点了取消）。

### 不通过的典型情况

- 迁移只搬了 `projectId`、`taskId`、`conversationId`，漏了记账字段，升级当天时间触发重复发送。
- 设置页面和监听器各自用 `updateAsync({ jobs })` 写整个列表，两边同时写时互相覆盖。
- 监听器用 `Promise.all` 并发处理所有 job，同时弹出多个确认框，或者共用一个 `ticking` 让一条卡住所有条。
