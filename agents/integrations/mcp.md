# MCP

## Main Files

- `src/main/core/mcp/services/McpService.ts`
- `src/main/core/mcp/utils/` — adapters, catalog, config IO, config paths, conversion
- `src/main/core/mcp/controller.ts`
- `src/core/primitives/mcp/api/`
- `src/core/features/agent-control/node/` — app-owned `emdash` tools, authenticated callers, background discovery, delegation and messages
- `src/core/features/coordination/` — main agent identity, task ownership, project access, worker grants and durable results
- `src/core/features/mcp/browser/` (`mcp-view.tsx`, `components/`)

## Current Behavior

- MCP server configs are read, adapted, merged, and written across supported agent ecosystems
- provider-specific config formats are handled through adapters in `src/main/core/mcp/utils/`
- the renderer MCP UI manages installed servers and catalog entries
- Chat's MCP list reports configured servers, not inferred connection health. Codex's recognized
  synthetic startup failures are translated by its ACP enrichment hook and displayed on the
  composer MCP trigger/popover instead of opening a transcript turn. Startup errors are scoped to
  the current Session activation and are not retained as configuration. Other provider diagnostics
  and ordinary failed MCP tool invocations remain unchanged; there is no health polling.

## Rules

- do not assume all providers support the same MCP transport types
- keep canonical MCP data in shared types and adapt at the edges
- if you add provider-specific MCP behavior, update both service and UI compatibility handling

## App-owned coordination tools

- MCP caller identity is separate from target project and task IDs. A project main agent can operate across authorized projects; linked projects organize context and do not grant access.
- Main agents default to accessible projects and can be narrowed to selected projects. Delegated workers control their own task and receive extra project permissions only through explicit, bounded grants. Native agent shell tools are not an OS sandbox.
- Project/task/conversation discovery, task dispatch and ACP message acceptance run in the background. Mutations that retain a human confirmation, such as archive/delete, first pass background task authorization.
- Stable request IDs deduplicate dispatch and messages. Unknown message acceptance is retained without automatic replay; terminal messages remain pending when safe delivery cannot be confirmed.
- Result submission requests review. Only the designated main conversation can acknowledge result events or review a result through MCP; main conversation changes preserve coordinator identity and task history.

- Delegated tasks may carry `depends_on`: plans remain visible without worktrees or processes until prerequisite results are accepted. Admission freezes approved result versions and commit references. Waiting plans can be cancelled through the main-agent UI or `cancel_pending_task`; cancellation never stops a running session.

- ACP background prompts carry `origin: background`; queued user input takes priority at turn boundaries without interrupting the active turn. Main-agent result notices show a readable summary and keep event IDs, instructions and structured payloads in hidden context.

- The task UI lists persistent pending messages and undelivered main-agent results through `agentControl` Wire procedures. Explicit handling/dismissal prevents message replay; resolving a result notification only acknowledges its event and never completes the task. In-flight deliveries are hidden until their acceptance is known or recovery establishes uncertainty.

- New main-agent runtimes use independent management worktrees through the dedicated Host verb. Ordinary task creation rejects management workspace configs and the reserved management branch namespace, including qualified refs. Existing main-agent checkouts remain intact until their document migration runs.
