# Go gateway prototype

This isolated experiment uses a Go child process, two loopback-only mock Responses
providers, and a temporary Codex home. It is not connected to the desktop app.

Run `go test -v ./...` in this directory. The integration test builds and starts the
sidecar, then starts the locally installed `codex` CLI against fake providers. It skips
when Codex is unavailable. No real credentials, conversations, or external model
services are used. The test checks that a session can resume through a changed route,
that another session keeps its route, and that the usage file survives session deletion.

`launch.ts` is a development-only example of the Node host starting the binary and
reading its loopback address and ephemeral credential from its stdout pipe. The Go test
starts the actual process directly; the launcher can be exercised separately.

The proxy intentionally only permits loopback HTTP upstreams and is not suitable for
production. It does not support real authentication, official subscriptions, remote
hosts, full SSE usage formats, fault-tolerant accounting, provider compatibility,
privacy filtering, packaging, app lifecycle, or migration of existing conversations.
Its JSONL usage log is solely a test artifact, not the application's usage ledger.
