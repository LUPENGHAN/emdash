# 05 Emdash MCP 加上列出、归档、删除任务

先读 [README.md](README.md) 里的共用规则。分支名：`feat/mcp-task-tools`。

## 要做的事

Emdash 给每个 agent 提供一个内置 MCP 服务器（名字是 `emdash`）。现在它只能新建任务（`create_task`、`suggest_task`、`handoff`），不能列出、归档或删除任务。要加三个工具：

| 工具 | 作用 | 是否要用户确认 |
|---|---|---|
| `list_tasks` | 列出调用者所在项目的任务 | 不用（只读） |
| `archive_task` | 归档一个任务（之后可恢复） | 要 |
| `delete_task` | 删除一个任务，可以连同 worktree、分支一起删 | 要，用应用里现成的删除对话框 |

## 不做的事

- 不加「恢复已归档任务」「批量删除」。
- 不能跨项目操作。
- 不改应用里删除、归档任务本身的逻辑。

## 已知代码位置

这套 MCP 的结构是：**主进程注册工具 → 把动作发给最近使用的窗口 → 窗口里执行**。所以真正干活的代码在渲染进程里，和用户点按钮走同一套代码。

- `src/core/features/agent-control/node/mcp-tools.ts`：用 `server.registerTool(name, { description, inputSchema, annotations }, handler)` 注册工具。`list_conversations`（约 93 行）是只读工具的例子，`create_task`（约 158 行）是要确认的例子。
- `src/core/features/agent-control/api/index.ts`：`AgentControlAction` 联合类型（约 36 行），每种动作一个 `kind`。
- `src/core/features/agent-control/browser/execute-agent-action.ts`：
  - `executeAgentAction(caller, action)` 的 `switch (action.kind)`（约 52 行起）；
  - `confirm(title, detail, confirmLabel)`（约 280 行）：弹确认框，用户拒绝时抛错 `The user declined in Emdash.`；
  - `listConversations()`（约 304 行）：只读结果的格式写法。
- 任务数据：
  - `getTaskManagerStore(projectId)`，在 `src/core/features/tasks/api/browser/task-state/task-selectors.ts`；`.tasks` 是一个 Map，值的 `.data` 是 `Task`（类型在 `src/core/primitives/tasks/api/tasks.ts` 约 61 行：`id`、`name`、`status`、`createdAt`、`archivedAt?`、`type` 等）；
  - 任务的分支名：先在 `task-manager.ts` 或任务 store 上找（搜 `taskBranch` 或 `branch`），`execute-agent-action.ts` 里 `create_task` 那段（约 190 行）有取调用者分支的写法，可以参考；
  - `taskManager.archiveTask(taskId)`（`src/core/features/tasks/api/browser/stores/task-manager.ts` 约 742 行）；
  - `taskManager.deleteTasks(ids, { deleteWorktree, deleteBranch, deleteConversations })`（约 815 行）。
- 删除对话框：`src/core/features/tasks/api/browser/delete-selected-tasks.ts` 演示了怎么用：

  ```ts
  const outcome = await openModal('deleteTaskModal', { projectId, tasks: [{ taskId, taskName }] });
  if (!outcome.success) return;
  const { deleteWorktree, deleteBranch, deleteConversations } = outcome.data;
  await taskManager.deleteTasks([taskId], { deleteWorktree, deleteBranch, deleteConversations });
  ```

  这个对话框（`src/core/features/tasks/browser/delete-task-modal.tsx`）自己会检查 worktree、未推送的提交，让用户选是否删 worktree 和分支。**直接复用，不要自己写确认框。**
- 会话状态：`Conversation.agentStatus`（`src/core/primitives/conversations/api/conversations.ts` 约 40 行），取值见 `src/core/primitives/agents/api/agent-events.ts`：`'idle' | 'working' | 'awaiting-input' | 'error' | 'completed'`。项目里所有会话：`(await getConversationsClient()).getConversationsForProject({ projectId })`。

## 规则（在渲染进程里执行时检查，不靠 agent 自觉）

1. 只能操作 `caller.projectId` 里的任务：任务 id 在 `getTaskManagerStore(caller.projectId).tasks` 里找不到就报错 `No task <id> in this project.`。
2. 不能归档或删除调用者自己所在的任务（`taskId === caller.taskId`）：报错 `You cannot archive or delete the task you are running in.`。
3. 任务里有会话的 `agentStatus` 是 `'working'` 或 `'awaiting-input'` 时不能删除、不能归档：报错 `An agent is still running in “<任务名>”. Stop it first.`。
4. 自动化运行产生的任务（`task.data.type === 'automation-run'`）不能删、不能归档：报错 `Automation runs are managed by their automation.`。
5. 已经归档的任务再归档：直接返回 `“<任务名>” is already archived.`，不报错。

## 步骤

### 步骤 1：动作类型

文件：`api/index.ts`。在 `AgentControlAction` 里加：

```ts
| { kind: 'list_tasks'; includeArchived: boolean }
| { kind: 'archive_task'; taskId: string }
| { kind: 'delete_task'; taskId: string }
```

### 步骤 2：注册工具

文件：`mcp-tools.ts`。放在 `create_task` 后面，照它的写法：

```ts
server.registerTool(
  'list_tasks',
  {
    description:
      "Tasks in this project: id, name, branch, status, whether an agent is running in it, and when it was created. Yours is marked. Use the id with archive_task or delete_task.",
    inputSchema: { include_archived: z.boolean().default(false) },
    annotations: { readOnlyHint: true },
  },
  ({ include_archived }) => dispatch({ kind: 'list_tasks', includeArchived: include_archived })
);

server.registerTool(
  'archive_task',
  {
    description:
      'Archive a task in this project (it can be restored in Emdash later). Not your own task, and not one with an agent still running. The user confirms in Emdash.',
    inputSchema: { task_id: z.string().min(1) },
  },
  ({ task_id }) => dispatch({ kind: 'archive_task', taskId: task_id })
);

server.registerTool(
  'delete_task',
  {
    description:
      "Delete a task in this project. The user decides in Emdash whether its worktree and branch go too, and sees any unpushed commits first. Cannot be undone. Not your own task, and not one with an agent still running. Prefer archive_task unless the user asked for deletion.",
    inputSchema: { task_id: z.string().min(1) },
    annotations: { destructiveHint: true },
  },
  ({ task_id }) => dispatch({ kind: 'delete_task', taskId: task_id })
);
```

先确认 `annotations` 支持 `destructiveHint`（看 `@modelcontextprotocol/sdk` 的类型，或文件里有没有别处用过）；不支持就去掉这一行。

### 步骤 3：执行

文件：`execute-agent-action.ts`。

1. `switch` 里加三个分支，各调一个新函数：`listTasks(caller, action.includeArchived)`、`archiveTask(caller, who, action.taskId)`、`deleteTask(caller, who, action.taskId)`。
2. 写一个共用的检查函数：

   ```ts
   /** The task an agent may archive or delete, or an error saying why not. */
   async function taskForRemoval(caller: AgentCaller, taskId: string) {
     const taskManager = getTaskManagerStore(caller.projectId);
     if (!taskManager) throw new Error('Open this project in Emdash first');
     const task = taskManager.tasks.get(taskId);
     if (!task) throw new Error(`No task ${taskId} in this project.`);
     if (taskId === caller.taskId) {
       throw new Error('You cannot archive or delete the task you are running in.');
     }
     if (task.data.type === 'automation-run') {
       throw new Error('Automation runs are managed by their automation.');
     }
     const conversations = await (
       await getConversationsClient()
     ).getConversationsForProject({ projectId: caller.projectId });
     const running = conversations.some(
       (c) => c.taskId === taskId && (c.agentStatus === 'working' || c.agentStatus === 'awaiting-input')
     );
     if (running) throw new Error(`An agent is still running in “${task.data.name}”. Stop it first.`);
     return { taskManager, task };
   }
   ```

   任务名用 `task.data.name` 还是 `task.displayName`，看 `resume-writing-settings.tsx` 里 `taskChoices()` 用的是 `task.displayName`，这里也用 `displayName`（有就用）。
3. `listTasks`：
   - 从 `getTaskManagerStore(caller.projectId).tasks` 取全部任务；`includeArchived` 为假时去掉 `archivedAt` 有值的；
   - 每行格式：`<id> · <名字> · <分支或 no branch> · <archived 或 status> · <agent running 或 idle> · created <createdAt 的日期部分>`，调用者自己的任务末尾加 ` (you)`；
   - 按 `createdAt` 从新到旧；
   - 没有任务时返回 `No tasks.`；
   - 「agent running」用和 `taskForRemoval` 一样的判断，项目会话只取一次，不要每个任务取一次。
4. `archiveTask`：
   - `taskForRemoval`；已归档就返回提示（规则 5）；
   - `await confirm(\`${who} wants to archive “${名字}”\`, 'It can be restored from the archived tasks in Emdash.', 'Archive')`；
   - `await taskManager.archiveTask(taskId)`；
   - 返回 `Archived “<名字>”.`
5. `deleteTask`：
   - `taskForRemoval`；
   - 打开删除对话框（见上面「已知代码位置」）。**对话框标题里要能看出是 agent 发起的**：先看 `deleteTaskModal` 接不接受标题或说明参数；不接受的话，先用 `confirm(\`${who} wants to delete “${名字}”\`, 'Next you choose whether its worktree and branch are deleted too.', 'Continue')` 弹一次，再打开删除对话框；
   - 用户在删除对话框里取消：`throw new Error('The user declined in Emdash.')`；
   - 确认后 `await taskManager.deleteTasks([taskId], { deleteWorktree, deleteBranch, deleteConversations })`；
   - 返回 `Deleted “<名字>”` 加上删了什么，例如 `(worktree and branch removed)` / `(worktree kept)`。

完成标志：类型检查通过。

### 步骤 4：测试

1. `agent-control` 的 node 测试：`mcp-tools.ts` 如果有测试（搜 `registerAgentControlTools` 的测试），加三条：三个工具都注册了；参数映射正确（`include_archived` → `includeArchived`，`task_id` → `taskId`）。没有现成测试就新建 `mcp-tools.test.ts`，用一个假的 `server`（记录 `registerTool` 的调用）和假的 `dispatch`。
2. `execute-agent-action.ts` 的检查逻辑：把 `taskForRemoval` 里**不依赖 store 的判断**抽成纯函数（例如 `removalBlocker({ task, callerTaskId, conversations }): string | null`），放在同目录新文件 `task-removal.ts`，给它写单元测试，覆盖规则 2、3、4 和「可以删」四种情况。规则 1 在 store 里查，不用单测。

```bash
cd /Users/hlp/Documents/code/emdash/apps/emdash-desktop
pnpm exec vitest run --project node src/core/features/agent-control
```

然后跑 README 里的检查命令。

### 步骤 5：手动验证（测试实例，不启动真实 agent）

不能让真的 agent 调工具（会花额度）。用 MCP 的 HTTP 接口直接调：

1. 在测试实例里打开一个项目，建两个任务 A、B（不用启动 agent；建任务时如果会自动启动 agent，选「不启动」或建完立刻停止，**不要发消息**）。
2. 找到 Emdash MCP 的地址：Emdash 启动 agent 时会把 `mcp_servers.emdash.url` 传给它（例如 `http://127.0.0.1:<端口>/mcp/<id>/<token>`）。在任务 A 里开一个**终端**（不是 agent），看环境变量或日志里有没有这个地址；找不到的话看 `src/core/features/agent-control/node/agent-control-server.ts` 里地址是怎么生成的，以及 `caller-tokens.ts` 怎么给一个会话发地址，然后在交付说明里写出你用的办法。
3. 用 MCP 的 JSON-RPC 调工具（地址换成第 2 步拿到的，以任务 A 的身份）：

   ```bash
   URL='http://127.0.0.1:<端口>/mcp/<...>'
   H='content-type: application/json'; A='accept: application/json, text/event-stream'
   curl -s "$URL" -H "$H" -H "$A" -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}' -D /tmp/mcp-headers.txt
   # 如果响应头里有 mcp-session-id，后面每个请求都加上 -H "mcp-session-id: <值>"
   curl -s "$URL" -H "$H" -H "$A" -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_tasks","arguments":{}}}'
   ```

4. 依次验证，每一条都记下结果：
   - `list_tasks`：A 带 `(you)`，B 在列表里；
   - `archive_task` A（自己）：报错「cannot archive or delete the task you are running in」；
   - `archive_task` B：应用里弹确认框，点取消 → 返回「declined」；再来一次点确认 → B 被归档，`list_tasks` 默认不再显示 B，`include_archived: true` 时显示为 archived；
   - 在应用里恢复 B，再 `delete_task` B：先弹确认（或删除对话框），点取消 → 返回「declined」，B 还在；再来一次，删除对话框里勾选删除 worktree → B 被删，`ls ~/emdash/worktrees/...` 里它的 worktree 没了；
   - `delete_task` 一个不存在的 id：报错「No task … in this project」。
5. 清理：删掉任务 A 和测试项目建出来的 worktree（只删自己建的），关闭测试实例。

## 提交建议

1. `feat(agent-control): let agents list, archive and delete tasks`

---

## 审查方案

### A. 范围

- [ ] 改动在 `src/core/features/agent-control/`（加上测试）。
- [ ] 没有改 `task-manager.ts`、`delete-task-modal.tsx` 的行为（如果为了显示「agent 发起」给对话框加了可选参数，确认不传时外观和原来一样）。

### B. 安全规则（最重要，逐条对着代码看）

- [ ] 规则 1：任务从 `caller.projectId` 的 store 里找，没有用 agent 传来的项目 id。
- [ ] 规则 2：`taskId === caller.taskId` 时拒绝，归档和删除都检查了。
- [ ] 规则 3：运行中的判断包括 `working` 和 `awaiting-input`；归档和删除都检查了。
- [ ] 规则 4：自动化运行的任务被拒绝。
- [ ] 删除一定经过 `deleteTaskModal`，是否删 worktree / 分支由用户在对话框里选，agent 的参数里**没有**这两个选项。
- [ ] 用户取消时抛的是 `The user declined in Emdash.`，agent 能看懂。
- [ ] 归档也弹了确认框。
- [ ] `delete_task` 的说明里有「不能撤销」「优先归档」。

### C. 正确性

- [ ] `list_tasks` 默认不含已归档；项目会话只取了一次。
- [ ] 结果文字里任务名用的是显示名，和应用界面一致。
- [ ] 删除后的返回文字如实反映了用户的选择（删没删 worktree）。

### D. 测试和实测

- [ ] `removalBlocker` 的四种情况都有测试。
- [ ] 交付说明里有手动验证第 4 步每一条的结果。自己至少重做「删除自己被拒绝」和「删除对话框取消」两条。
- [ ] 测试 worktree 已清理：`ls ~/emdash/worktrees` 和 README 里的原有列表比，没有多出来的。

### 不通过的典型情况

- `delete_task` 带了 `delete_worktree` / `delete_branch` 参数，让 agent 自己决定删不删。
- 删除不经过对话框，只用 `confirm` 问一句就删了 worktree：用户看不到未推送的提交。
- 运行中的判断只看了调用者自己的任务，或者只看 `working` 漏了 `awaiting-input`。
