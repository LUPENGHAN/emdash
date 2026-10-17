# 07 Codex 用自定义供应商时请求不兼容

先读 [README.md](README.md) 里的共用规则。分支名：`fix/codex-provider-web-search`。

这个方案和 [06](06-codex-provider-models.md) 都改 `source-launch.ts`。先做完这个并合进去，再开始 06。

## 要解决的问题

### A. 联网搜索工具导致 400（必须做）

Codex 在供应商 Xhub 上用 `deepseek-v4.1-flash` 报：

```
model deepseek-v4.1-flash exists but has no deployment compatible with endpoint responses and this request
```

原因已经查清（2026-10-16 实测）：Codex 0.163 每个请求都自带 `{"type":"web_search","external_web_access":false}` 工具，这个供应商的 DeepSeek 不支持。去掉这个工具后，同一个请求返回 200。

Codex 的配置 `-c web_search="disabled"` 能让请求里不带这个工具，已经用假服务器确认过。

### B. 会话中途换模型后 400（只做提示）

同一个 Codex 会话先用 `openai/gpt-6-sol`，再换别的厂商的模型，报 `encrypted history requires an owned session or previous_response_id`。原因是 gpt-6-sol 返回的加密推理内容（`encrypted_content`）被 Codex 放进历史里，别的厂商的模型解不开。

试过的办法：在模型目录里关掉 `supports_reasoning_summary_parameter`，Codex 仍然发 `include: ["reasoning.encrypted_content"]`，没用。所以这部分**只做提示，不改请求**。

## 已知代码位置

- `src/core/features/model-providers/node/source-launch.ts` 的 `buildSourceLaunch()`，`case 'codex'`（约 71–138 行）：
  - 终端模式：返回的 `args` 是一串 `-c key=value`，由 `codexOverride(path, value)` 生成（约 253 行）。
  - 聊天模式：`env.CODEX_CONFIG` 是一份 JSON，由聊天适配器（codex-acp）读取。
- `src/core/features/model-providers/api/index.ts` 的 `modelProviderSchema`（约 19 行）：供应商的设置项。
- `src/core/features/model-providers/browser/providers-settings-page.tsx`：供应商设置页面。`nonReasoningModels`（约 186、213 行）是一个现成的「按模型勾选」的例子。
- 测试：`src/core/features/model-providers/node/model-providers.test.ts`，约 184 行开始是 Codex 的测试。
- 假服务器：`docs/plans/tools/capture-responses.py`（只记录请求，一律回 400，不会转发到任何真实供应商）。

## 决定

按模型设置，默认关闭联网搜索：

- 供应商的每个模型默认**不带**联网搜索工具（多数中转站不支持）。
- 用户可以在供应商设置里给某些模型打开「Web search」，只有这些模型保留。

这样既解决了 DeepSeek 的问题，又不会让支持搜索的模型永远搜不了网。

## 步骤

### 步骤 1：供应商设置加一个字段

文件：`api/index.ts`。

在 `nonReasoningModels` 后面加：

```ts
/**
 * Models that keep Codex's built-in web search tool. Codex sends it with every request
 * and many gateways reject the whole request over it, so it is off unless listed.
 */
webSearchModels: z.array(z.string()).optional(),
```

完成标志：类型检查通过。

### 步骤 2：Codex 启动时按模型关掉联网搜索

文件：`source-launch.ts`，`case 'codex'`。

1. 在 `providerConfig` 定义之后加：

   ```ts
   // Codex sends a web_search tool with every request; gateways that lack it reject the
   // whole request ("no deployment compatible"), so it stays off unless the model has it.
   const webSearch = model && provider.webSearchModels?.includes(model) ? null : 'disabled';
   ```

2. `CODEX_CONFIG` 的 JSON 里加：`...(webSearch && { web_search: webSearch }),`
3. `args` 里加：`...(webSearch ? codexOverride('web_search', webSearch) : []),`
4. 没有选模型（`model` 为空）时也关掉。这是有意的：不知道用的是哪个模型，就按默认关闭处理。

完成标志：`model-providers.test.ts` 新增三条测试：
- 默认：`args` 里有 `web_search="disabled"`，`JSON.parse(env.CODEX_CONFIG).web_search === 'disabled'`；
- `webSearchModels` 里有这个模型：两处都没有 `web_search`；
- 没传模型：两处都是 `disabled`。
- 并且保留现有断言「`args` 里没有任何参数含空白字符」。

### 步骤 3：设置页面加勾选

文件：`providers-settings-page.tsx`。

1. 找到 `nonReasoning` 这个 state（约 186 行）和它在界面上对应的勾选控件。完全照着它的写法，加一组 `webSearch` 的勾选：
   - state：`const [webSearch, setWebSearch] = useState<string[]>(initial?.webSearchModels ?? []);`
   - 保存：`const webSearchModels = webSearch.filter((model) => selected.includes(model)); if (webSearchModels.length > 0) draft.webSearchModels = webSearchModels;`
2. 勾选控件的文字：`Web search (Codex)`；说明文字：`Codex sends a web search tool with every request. Many gateways reject it; turn it on only for models whose provider supports it.`
3. 只在协议是 OpenAI Responses 的供应商上显示这组勾选（Codex 只用这种协议）。看页面里是怎么判断协议的（搜 `openai-responses` 或 `protocol`）。
4. 跑 `extract-ui-strings.mjs --missing`，把新文字翻译进 `zh-CN.json`：
   - `Web search (Codex)` → `联网搜索（Codex）`
   - 说明 → `Codex 每次请求都会带上联网搜索工具，很多中转站不支持、会直接拒绝请求。只给供应商确实支持的模型打开。`

完成标志：测试实例的供应商设置里能看到这组勾选，勾上保存后重新打开还在。

### 步骤 4：换模型的提示（问题 B）

文件：`providers-settings-page.tsx`。

在 Responses 协议的供应商设置里，模型列表下面加一行说明文字：

`In one Codex conversation, stay with models from the same vendor. Some models return encrypted reasoning that models from other vendors cannot read, and the conversation then fails with “encrypted history requires an owned session”. Start a new conversation to switch.`

中文：`同一个 Codex 会话里请只用同一家厂商的模型。有些模型会返回加密的推理内容，别家的模型读不了，会话会报「encrypted history requires an owned session」。要换厂商请新开会话。`

不要做别的拦截。

### 步骤 5：用假服务器确认真实请求

这一步不花额度，必须做。

1. 终端模式：

   ```bash
   cd /Users/hlp/Documents/code/emdash
   rm -f /tmp/captured.jsonl
   python3 -I docs/plans/tools/capture-responses.py /tmp/captured.jsonl &
   mkdir -p /tmp/codex-probe-home
   CODEX_HOME=/tmp/codex-probe-home EMDASH_MODEL_PROVIDER_KEY=dummy codex exec --skip-git-repo-check \
     -c model_provider=probe -c 'model_providers.probe.name="probe"' \
     -c 'model_providers.probe.base_url="http://127.0.0.1:4999/v1"' \
     -c 'model_providers.probe.env_key="EMDASH_MODEL_PROVIDER_KEY"' \
     -c 'model_providers.probe.wire_api="responses"' \
     -c 'model_providers.probe.request_max_retries=0' -c 'model_providers.probe.stream_max_retries=0' \
     -c web_search='"disabled"' -c model=test-model "say ok"
   kill %1
   python3 -c "import json; b=json.loads(json.loads(open('/tmp/captured.jsonl').readline())['body']); print([t.get('type') for t in b['tools']])"
   ```

   期望：输出的列表里没有 `web_search`。再去掉 `-c web_search=...` 跑一次，期望列表里有 `web_search`。最后 `rm -rf /tmp/codex-probe-home /tmp/captured.jsonl`。

2. 聊天模式（测试实例里）：
   - 启动假服务器（同上）。
   - 在测试实例的设置里加一个供应商：协议 OpenAI Responses，地址 `http://127.0.0.1:4999/v1`，密钥随便填，模型填 `test-model`。
   - 新建一个 Codex **聊天**会话，来源选这个供应商，发一条「hi」。会话会报错（假服务器回 400），这是预期的。
   - 看 `/tmp/captured.jsonl` 里 `/v1/responses` 那条请求的 `tools`：期望没有 `web_search`。
   - 如果聊天模式下仍然有 `web_search`，说明 codex-acp 没有把 `CODEX_CONFIG` 里的 `web_search` 传给 Codex。停下来，在交付说明里写清楚，不要自己去改 codex-acp。
   - 用完把这个测试供应商删掉，关掉假服务器。

完成标志：两种模式的抓包结果都写进交付说明。

## 测试

```bash
cd /Users/hlp/Documents/code/emdash/apps/emdash-desktop
pnpm exec vitest run --project node src/core/features/model-providers
```

然后跑 README 里的检查命令。

## 提交建议

1. `fix(model-providers): keep Codex's web search tool off unless the model has it`（步骤 1–3、5）
2. `docs(model-providers): warn against switching vendors inside one Codex conversation`（步骤 4）

---

## 审查方案

### A. 范围

- [ ] 改动只在 `src/core/features/model-providers/` 和 `zh-CN.json`。
- [ ] 没有改 `packages/plugins` 里的 codex-acp 适配器。

### B. 行为

- [ ] 读 `source-launch.ts` 的 diff：终端（`args`）和聊天（`CODEX_CONFIG`）两边都处理了，取值一致。
- [ ] 默认是关闭（没设 `webSearchModels`、没选模型都关闭），不是默认打开。
- [ ] `codexOverride('web_search', 'disabled')` 生成的是 `web_search="disabled"`，值带引号（TOML 字符串）。用 `node -e` 或测试断言确认。
- [ ] `args` 里没有含空白字符的参数（现有断言还在、仍然通过）。
- [ ] 别的 agent（claude、opencode、pi）的分支没被改动。

### C. 设置页

- [ ] 只有 Responses 协议的供应商显示「联网搜索」勾选。
- [ ] 取消选中某个模型后，它也从 `webSearchModels` 里去掉（`filter(selected.includes)`）。
- [ ] 老的供应商记录（没有这个字段）能正常打开、保存，不报错。

### D. 实测

- [ ] 交付说明里有两次抓包结果：终端模式、聊天模式各一次。
- [ ] 自己重跑步骤 5 第 1 小步，确认 `disabled` 时没有 `web_search`。
- [ ] 测试实例里加的测试供应商已删除，假服务器已关闭（`lsof -i :4999` 没有输出）。

### E. 翻译和检查

- [ ] `extract-ui-strings.mjs --missing` 输出为空。
- [ ] 检查命令全部通过。

### 不通过的典型情况

- 只改了 `args`，忘了 `CODEX_CONFIG`：聊天模式仍然报错。
- 把 `web_search` 写成布尔值 `false`：Codex 的这个配置是字符串（`disabled` / `cached` / `live`），布尔值可能被忽略或报错。
- 为了做问题 B，去改 Codex 的会话文件或拦截模型切换。方案里明确只做提示。
