/**
 * Source (inside Pi's and Oh My Pi's Emdash extension) that registers the model provider
 * Emdash launched the session on, for that process only: the user's models.json /
 * models.yml are never written. Emdash's launch sets EMDASH_AGENT_PROVIDER to the
 * provider config (its apiKey names an env var, never holds the key) and
 * EMDASH_AGENT_MODEL to `<provider>/<model>`; without them it does nothing.
 *
 * `registerEmdashProvider(pi)` runs in the extension factory, which both agents await
 * before startup continues, so `--model`/`--provider` resolve against it.
 * `selectEmdashModel(pi, ctx)` runs on session_start, for launches that pass no
 * `--model` (the chat adapter).
 */
export const EMDASH_PROVIDER_EXTENSION_SOURCE = `\
function registerEmdashProvider(pi: ExtensionAPI) {
  const raw = process.env.EMDASH_AGENT_PROVIDER;
  if (!raw) return;
  try {
    const { key, models, ...config } = JSON.parse(raw);
    pi.registerProvider(key, {
      ...config,
      models: models.map((model: { id: string }) => ({
        name: model.id,
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 16384,
        ...model,
      })),
    });
  } catch {
    // A malformed config leaves the agent on its own providers.
  }
}

async function selectEmdashModel(pi: ExtensionAPI, ctx: any) {
  const wanted = process.env.EMDASH_AGENT_MODEL;
  const slash = wanted ? wanted.indexOf('/') : -1;
  if (!wanted || slash < 0) return;
  const provider = wanted.slice(0, slash);
  const id = wanted.slice(slash + 1);
  if (ctx?.model?.provider === provider && ctx.model.id === id) return;
  const model = ctx?.modelRegistry?.find?.(provider, id);
  if (model) await pi.setModel(model);
}
`;
