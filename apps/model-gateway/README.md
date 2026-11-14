# Embedded model gateway

Go child process for Emdash's local model router, embedding CLIProxyAPI's SDK.
The original native Providers settings page owns API configuration. Electron supplies
that inventory to Go and owns the stable loopback endpoint, conversation routes,
encrypted credentials, and independent usage ledger. No management website is embedded.

API accounts support OpenAI Responses, OpenAI Chat Completions and Anthropic Messages,
including streaming, model aliases and usage. Native Codex/Claude OAuth uses the SDK;
settings open authorization in the system browser. Actual account login and refresh
still require account-owner verification. Agent protocol support determines which
sources can be selected; arbitrary protocol conversion is not promised.

Each provider can enable all three protocols under one shared base URL and key, with
separate URL/key overrides per protocol. Empty enabled URLs inherit the shared base;
empty override keys inherit the shared key. Keys can be displayed/copied in native
settings and remain encrypted at rest. Flexible agents can choose a default launch
protocol; Codex stays on Responses and Claude Code on Messages. Changing an existing
agent's protocol requires a restart; URL/key updates apply to subsequent routed calls.

## Build and verification

Developers need Go 1.27.1 and the repository's pinned pnpm toolchain. End users receive
the compiled binary and do not need Go. Desktop build/dev prepares it automatically.

```sh
pnpm --dir apps/model-gateway build
pnpm --dir apps/model-gateway test
pnpm --dir apps/model-gateway typecheck
node apps/model-gateway/scripts/build.mjs --target win32-x64
node apps/model-gateway/scripts/build.mjs --target linux-x64
pnpm --dir apps/emdash-desktop build
node apps/emdash-desktop/tooling/model-gateway-smoke.mjs
EMDASH_CODEX_TEST_BINARY=/absolute/path/to/codex \
  pnpm --dir apps/emdash-desktop exec vitest run --project node \
  src/core/features/model-gateway/node
```

The smoke test uses an isolated Electron profile, adds all three native provider types,
checks automatic startup and OAuth entry points, and writes screenshots. Node tests use
local simulated upstreams and fake keys; the optional actual Codex test uses temporary
homes for CLI resume and the bundled ACP adapter. No personal login or paid upstream
is consumed. Windows/Linux cross-compilation does not verify installed applications.

## Runtime and storage

Bootstrap JSON arrives on stdin; stdout carries newline-delimited control messages and
SDK logs go to stderr. Control requests use a process token. Each agent receives a
conversation capability, scoped to its own route. Deleted conversations are rejected.
The host starts the router automatically and keeps the HTTP address stable across Go
restarts. Same-protocol/model/context/account-type switches wait until the agent is idle.

API keys and OAuth credentials use the encrypted app secret service; no plaintext
credential files are written. API definitions remain in original Providers settings.
Old encrypted gateway configurations migrate into that inventory once with ID aliases.
Remote agents and existing direct sessions retain their original configuration.

Go writes usage to a Bolt outbox before publishing; Electron acknowledges only after
its independent SQLite KV ledger commits. Replay retries unacknowledged events and
IDs prevent duplicates. Records contain identifiers, token counts, timestamps and
status, without prompts or responses. Deleting chat files does not remove usage.

Codex CLI and ACP share the stable `custom-gateway` identity. ACP configures this when
app-server starts as well as per-thread; per-thread configuration alone is insufficient
with Codex 0.167.1. Cross-provider history compatibility still depends on the model and
upstream implementation. Fees, content redaction and memory are outside this module.

The SDK retains its MIT license. The build collects bundled dependency notices into
`dist/THIRD-PARTY-NOTICES.txt`; packaging includes the binary and applicable licenses.
