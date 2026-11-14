# SDK v8 runtime validation

Isolated experiment against CLIProxyAPI commit
`1aaf56bc6a0fc6fce19049ba7ae8554c882304a6`.
This module is not part of the desktop application's dependencies or startup.

```bash
go test -race -count=1 -v ./...
go build -o /tmp/emdash-sdk-validation/probe-v8 ./cmd/probe
PROBE_UI_HTML=/path/to/management/dist/index.html \
PROBE_BOOT_FILE=/tmp/emdash-sdk-validation/v8-boot.json \
  /tmp/emdash-sdk-validation/probe-v8
```

The probe binds an ephemeral loopback port, creates a temporary config/auth directory,
and launches two loopback mock Responses upstreams. It uses fixed, fake credentials
`probe-client` and `probe-management` for testing only. Do not connect real accounts
or expose this program outside a test machine. It records mock request bodies and
selected usage fields in its temporary directory.

With the probe running, these checks use the bootstrap file above:

```bash
python3 check-runtime.py
python3 check-codex-sdk.py
```

The runtime check covers routing A to B, another session remaining on A, concurrent
requests, SSE cancellation reaching the mock upstream, token extraction, management
authentication, configuration write/read, and rejection of invalid OAuth requests.
The Codex check requires the CLI on PATH. It creates a temporary CODEX_HOME and
checks that the thread ID and history survive routing from A to B through the SDK.
The Python checks write their results under `/tmp/emdash-sdk-validation/`.

The default SDK Responses HTTP handler drops request-context pinning in this tested
commit. The probe calls `ExecuteStreamWithAuthManager` with an explicit pinned context
instead. Header `X-Probe-Default: true` bypasses that adapter to reproduce the
selection failure. The mock stream adapter frames complete event/data lines only;
it is not a production SSE implementation and has not been verified against arbitrary
fragmentation, compaction, tool loops, or provider formats.

The SDK's upstream `go.mod` replaces MoeForge/moego with router-for-me/moego.
Go does not inherit dependency module replacements, so this external module repeats
that replacement explicitly. The pinned version is an experimental validation baseline,
not a production dependency decision.

See `docs/proposals/embedded-go-gateway-validation.md` at the repository root for
management UI, Electron WebContentsView, and OAuth-start observations. Real OAuth
code exchange and refresh have not been tested. Stop the probe with SIGTERM or Ctrl-C.
