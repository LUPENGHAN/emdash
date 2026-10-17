# 06 Codex 换供应商后模型列表不对

先读 [README.md](README.md) 里的共用规则。分支名：`fix/codex-provider-model-catalog`。

**先等 [07](07-codex-provider-requests.md) 合进 `feat/multi-agent` 再开始**，两个方案都改 `source-launch.ts`。

## 要解决的问题

用户反映：Codex 切到自己加的供应商后，模型列表里只有「自己加的那一个模型」，其余是 Codex 原来的 OpenAI 模型（gpt-6-sol 之类），不是供应商的全部模型。

## 已经查清的原因（2026-10-17 实测，执行前不用再查）

Codex 的模型列表来自它的模型目录。Emdash 给供应商写一份目录文件 `~/.codex/emdash-model-catalog-<供应商key>.json`，通过 `model_catalog_json` 交给 Codex。实测：

- 终端模式带上目录：`codex debug models -c model_catalog_json=...` 列出的正是供应商的全部模型。
- 聊天模式（Mac）通过包装脚本 `~/.codex/emdash-codex-app-server.sh` 带上目录：app-server 的 `model/list` 也是供应商的全部模型。
- **不带目录时**，两种模式列出的都是 Codex 自己的 OpenAI 模型，再加上当前选中的那个模型。这就是用户看到的现象。

不带目录的情况有两种：

1. **选中的模型没设上下文长度**。`src/core/features/model-providers/node/source-launch.ts` 的 `case 'codex'` 里，`catalogFile` 只在 `contextWindow` 有值时才生成（约 78 行），而且目录里只放设了上下文长度的模型（约 83 行 `Object.entries(provider.contextWindows ?? {})`）。
2. **Windows 上的聊天模式**。`source-launch.ts` 约 122 行有 `process.platform !== 'win32'` 的判断，Windows 上不用包装脚本，所以聊天模式永远不带目录。

另外两点已经确认：

- 没选模型时，`effective-agent-config.ts` 约 67 行已经默认用供应商的第一个模型，**这部分不用改**。
- 目录里的条目不写 `context_window` 时，Codex 照样接受（实测 `codex debug models` 能读出来，上下文长度为空）。
- 聊天适配器 codex-acp 在 Windows 上用 `spawn("\"<CODEX_PATH>\" app-server", { shell: true })` 启动 Codex（见 `packages/plugins/dist/adapters/codex-acp.cjs` 的 `startCodexConnection`），所以 Windows 上可以用 `.cmd` 包装脚本。

## 已知代码位置

- `src/core/features/model-providers/node/source-launch.ts`，`case 'codex'`（约 71–138 行）。
- `src/core/features/model-providers/node/codex-model-catalog.ts`：
  - `CodexModelCatalog` 类型（约 9 行）；
  - `buildCodexModelCatalog()`（约 50 行）：把 Emdash 的模型列表转成 Codex 的格式；
  - `ensureCodexModelCatalog()`（约 107 行）：写目录文件和包装脚本；
  - `APP_SERVER_WRAPPER`（约 36 行）：Mac / Linux 的包装脚本内容；
  - `codexAppServerWrapperPath()`（约 32 行）。
- 测试：`src/core/features/model-providers/node/codex-model-catalog.test.ts`、`model-providers.test.ts`（约 184 行起是 Codex）。
- 工具：`docs/plans/tools/codex-model-list.py`（不花额度，列出 app-server 看到的模型）。

## 步骤

### 步骤 1：目录里的上下文长度改成可选

文件：`codex-model-catalog.ts`。

1. `CodexModelCatalog.models` 的元素类型改成 `{ id: string; contextWindow?: number }`。
2. `buildCodexModelCatalog()` 里，只有 `contextWindow` 有值时才覆盖 `context_window` 和 `max_context_window`：

   ```ts
   return {
     ...(base ?? fallbackModelInfo(id)),
     slug: id,
     ...(contextWindow !== undefined && {
       context_window: contextWindow,
       max_context_window: contextWindow,
     }),
   };
   ```

3. 更新函数上方的注释：目录现在列出供应商的全部模型，上下文长度只在设置过时才覆盖。

完成标志：`codex-model-catalog.test.ts` 新增一条测试：没有 `contextWindow` 的模型，输出里 `slug` 正确，没有 `context_window` 字段（或者等于已知模型自己的值）。

### 步骤 2：只要供应商有模型，就写目录，并放进全部模型

文件：`source-launch.ts`，`case 'codex'`。

1. 原来的：

   ```ts
   const catalogFile = contextWindow ? codexModelCatalogPath(key) : undefined;
   const catalog = catalogFile && !/\s/.test(catalogFile) ? { providerKey: key, models: Object.entries(provider.contextWindows ?? {})... } : undefined;
   ```

   改成：

   ```ts
   // Codex lists the models its catalog describes, so every provider model goes in, sized
   // where the provider sets a window; without a catalog it lists OpenAI's own models.
   const catalogFile = provider.models.length > 0 ? codexModelCatalogPath(key) : undefined;
   const catalog: CodexModelCatalog | undefined =
     catalogFile && !/\s/.test(catalogFile)
       ? {
           providerKey: key,
           models: provider.models.map((id) => ({
             id,
             ...(provider.contextWindows?.[id] && { contextWindow: provider.contextWindows[id] }),
           })),
         }
       : undefined;
   ```

2. `model_context_window` 的处理（`contextWindow` 变量和 `codexOverride('model_context_window', ...)`）**保持不变**。
3. 目录路径含空格时没有目录（`extraArgs` 按空白切分，带空格的路径会被切坏）。这种情况在 `effective-agent-config.ts` 或调用处记一条警告日志：`Codex model catalog path has whitespace; Codex will list its own models`。先看文件里现有的日志写法（`log.warn`）。

完成标志：`model-providers.test.ts` 新增测试：
- 供应商有 3 个模型、只有 1 个设了上下文长度 → `launch.codexCatalog.models` 有 3 项，只有那一项带 `contextWindow`；
- 选中的模型没设上下文长度 → `args` 里仍然有 `model_catalog_json=...`；
- 原有测试（例如约 219、227、240 行）按新行为更新：如果旧测试断言「没设上下文长度就没有目录」，改成新的期望，并在交付说明里列出改了哪些旧断言。

### 步骤 3：Windows 聊天模式也带上目录

文件：`codex-model-catalog.ts`、`source-launch.ts`。

1. `codex-model-catalog.ts` 加 Windows 的包装脚本：

   ```ts
   // TOML literal string ('…'): a Windows path's backslashes are not escapes there.
   const APP_SERVER_WRAPPER_CMD = [
     '@echo off',
     'rem Written by Emdash for its Codex chat conversations on a model provider.',
     `"%EMDASH_CODEX_BIN%" -c "model_catalog_json='%EMDASH_CODEX_MODEL_CATALOG%'" %*`,
     '',
   ].join('\r\n');
   ```

2. `codexAppServerWrapperPath()` 在 Windows 上返回 `.cmd` 结尾的路径：

   ```ts
   export function codexAppServerWrapperPath(home = codexHome(), platform = process.platform): string {
     return path.join(home, platform === 'win32' ? 'emdash-codex-app-server.cmd' : 'emdash-codex-app-server.sh');
   }
   ```

3. `ensureCodexModelCatalog()` 按平台写对应的脚本；Windows 上不调用 `chmod`。
4. `source-launch.ts` 去掉 `process.platform !== 'win32'` 这个条件，两个平台都设置 `CODEX_PATH` 和 `EMDASH_CODEX_MODEL_CATALOG`。
5. 已知限制：目录路径里含 `'` 时 TOML 字面字符串会坏。`codexHome()` 一般是 `C:\Users\<用户名>\.codex`，用户名含 `'` 的极少。在 `catalog` 的判断里，Windows 上路径含 `'` 也当成没有目录处理（和空格一样）。

完成标志：
- `codex-model-catalog.test.ts` 加测试：`platform` 传 `'win32'` 时路径以 `.cmd` 结尾；生成的脚本内容包含 `model_catalog_json='%EMDASH_CODEX_MODEL_CATALOG%'` 和 `%*`。
- 为了能测，`ensureCodexModelCatalog` 也可以加一个 `platform` 参数（默认 `process.platform`）。

### 步骤 4：实测（不花额度）

1. 终端模式，用步骤 2 生成的目录：

   ```bash
   cd /tmp
   codex debug models -c model_catalog_json='"/path/to/generated/catalog.json"' | python3 -c "import json,sys; print([m['slug'] for m in json.load(sys.stdin)['models']])"
   ```

   生成目录的办法：写一个临时的 vitest 测试，或者在测试实例里用一个「只给部分模型设了上下文长度」的供应商启动一次 Codex 终端会话（不发消息，只打开），然后看 `/tmp/emd-ui/codex/emdash-model-catalog-*.json`。期望：列出供应商的全部模型。
2. 聊天模式（Mac）：

   ```bash
   EMDASH_CODEX_BIN=codex EMDASH_CODEX_MODEL_CATALOG=/tmp/emd-ui/codex/emdash-model-catalog-<key>.json \
     python3 -I docs/plans/tools/codex-model-list.py /tmp/emd-ui/codex/emdash-codex-app-server.sh
   ```

   期望：输出供应商的全部模型。
3. Windows：这台 Mac 上测不了。在交付说明里写明「Windows 未实测」，并写出给用户在 Windows 上验证的命令：

   ```powershell
   $env:EMDASH_CODEX_BIN = (Get-Command codex).Source
   $env:EMDASH_CODEX_MODEL_CATALOG = "$env:USERPROFILE\.codex\emdash-model-catalog-<key>.json"
   & "$env:USERPROFILE\.codex\emdash-codex-app-server.cmd" debug models
   ```

   期望：输出的 JSON 里是供应商的模型。

## 测试

```bash
cd /Users/hlp/Documents/code/emdash/apps/emdash-desktop
pnpm exec vitest run --project node src/core/features/model-providers
```

然后跑 README 里的检查命令。

## 提交建议

1. `fix(model-providers): list every provider model in Codex's catalog`（步骤 1–2）
2. `fix(model-providers): give Codex chat on Windows the provider's catalog`（步骤 3）

---

## 审查方案

### A. 范围

- [ ] 改动只在 `src/core/features/model-providers/node/`。
- [ ] 没有改 `packages/plugins`（codex-acp 不用改）。
- [ ] `effective-agent-config.ts` 里「没选模型时用第一个模型」的逻辑没有被改动。

### B. 目录内容

- [ ] 目录里的模型来自 `provider.models`（全部），不是 `contextWindows` 的键。
- [ ] 只有设置了上下文长度的模型才覆盖 `context_window`；没设的不写这个字段，也不写 0 或别的默认值。
- [ ] `model_context_window` 参数的行为和改之前一样（只在选中的模型设了上下文长度时才加）。
- [ ] 供应商没有模型（`models` 为空）时不写目录。

### C. 参数安全

- [ ] `args` 里没有含空白字符的参数，现有断言还在。
- [ ] 路径含空格时没有目录，而且有日志。
- [ ] Windows 脚本里 `model_catalog_json` 用的是单引号（TOML 字面字符串），不是双引号；路径含 `'` 时不生成目录。
- [ ] Windows 脚本用 `\r\n` 换行，最后一条命令用 `%*` 传参数。

### D. 实测

- [ ] 自己重跑步骤 4 的第 1、2 小步，结果和交付说明一致。
- [ ] 交付说明里写了 Windows 未实测，并给了验证命令。

### E. 检查命令

- [ ] 检查命令全部通过；被改掉的旧断言逐条看过，确认是行为本来就该变，不是为了让测试通过而改。

### 不通过的典型情况

- 只把模型全放进目录，没去掉「必须设上下文长度才写目录」的条件：选中的模型没设上下文长度时仍然没有目录。
- 没设上下文长度的模型写了 `context_window: 0`：Codex 会以为上下文是 0。
- Windows 脚本用了 `"model_catalog_json=\"%…%\""`（TOML 基本字符串）：反斜杠会被当成转义，路径读错。
