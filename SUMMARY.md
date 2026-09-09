# OpenHands provider driver

Adds OpenHands (github.com/All-Hands-AI/OpenHands) as a built-in ACP-based provider driver,
following the Grok/Cursor pattern documented in `docs/internals/providers.md` and the 3-step
recipe in `apps/server/src/provider/builtInDrivers.ts`.

## What was implemented

- `packages/contracts/src/settings.ts` — `OpenHandsSettings` schema (`enabled`, `binaryPath`,
  `customModels`), same shape as `GrokSettings`/`CursorSettings`. No invented fields.
- `packages/contracts/src/model.ts` — `OPENHANDS_DRIVER_KIND`, `OPENHANDS_DEFAULT_MODEL` sentinel
  model, mirroring the Antigravity pattern (OpenHands has no `models` listing command).
- `apps/server/src/provider/acp/OpenHandsAcpSupport.ts` — spawn/runtime wiring, modeled on
  `GrokAcpSupport.ts`. Builds the spawn command/args/env and constructs the shared
  `AcpSessionRuntime`. Maps T3 `RuntimeMode` to OpenHands' `--llm-approve`/`--always-approve` CLI
  flags and ACP confirmation-mode ids (`always-ask`/`llm-approve`/`always-approve`).
- `apps/server/src/provider/Services/OpenHandsAdapter.ts` +
  `apps/server/src/provider/Layers/OpenHandsAdapter.ts` — the `ProviderAdapter` implementation
  translating OpenHands' ACP session events (tool calls, permission requests, mode changes) into
  T3 orchestration events, modeled on `CursorAdapter`/`GrokAdapter`.
- `apps/server/src/provider/Layers/OpenHandsProvider.ts` — status probing (`openhands --version`)
  and `ServerProvider` snapshot building, modeled on `GrokProvider.ts`. No model catalog probe
  (none exists) and no auth-state guess (OpenHands resolves LLM credentials from `~/.openhands`
  out of band, not via CLI login, so auth always reports `"unknown"`).
- `apps/server/src/textGeneration/OpenHandsTextGeneration.ts` — headless text-generation helper
  (tools disabled, always-ask mode), modeled on the Grok/Cursor text-generation helpers.
- `apps/server/src/provider/Drivers/OpenHandsDriver.ts` — the `ProviderDriver` bundling the above
  (driverKind, metadata, configSchema, defaultConfig, create), modeled on `GrokDriver.ts`.
- `apps/server/src/provider/builtInDrivers.ts` — registered `OpenHandsDriver`: import,
  `BuiltInDriversEnv` union entry, `BUILT_IN_DRIVERS` array entry. This is the only change to a
  shared registry file.
- `apps/server/src/provider/acp/AcpSessionRuntime.ts` — one small, backward-compatible change:
  `authMethodId` is now optional (`readonly authMethodId?: string`), and the `authenticate` RPC
  call is skipped when it's omitted. This was necessary, not incidental: ACP's `authenticate` is
  not optional per the protocol, but OpenHands only advertises an interactive cloud OAuth
  device-flow auth method. A local install is already authenticated out of band via `~/.openhands`
  credentials, so sending `authenticate` on every session would either be rejected or would open a
  browser login each time. All existing callers (Grok, Cursor, Antigravity) still pass
  `authMethodId` explicitly, so this is additive and doesn't change their behavior — confirmed via
  `grep` across `apps/server/src/provider/` and the full test suite.
- Unit tests alongside every new file (`*.test.ts`), following the existing pattern next to
  `GrokDriver.ts`/`GrokAcpSupport.ts`: `OpenHandsDriver.test.ts`, `OpenHandsAdapter.test.ts`,
  `OpenHandsProvider.test.ts`, `OpenHandsAcpSupport.test.ts`, `OpenHandsTextGeneration.test.ts`.
  Existing `ProviderRegistry.test.ts` updated to include the new driver in the registry-wide
  assertions.

## The `openhands-acp` binary investigation

The locally installed CLI (`openhands` 1.16.0 via `uv tool install openhands`) ships an
`openhands-acp` console script that is broken:

```
ModuleNotFoundError: No module named 'openhands_cli.acp'
```

Inspecting `~/.local/share/uv/tools/openhands/`:

- The generated entry point (`~/.local/share/uv/tools/openhands/bin/openhands-acp`) targets
  `openhands_cli.acp:main`.
- The installed wheel only contains `openhands_cli.acp_impl`, not a top-level `openhands_cli.acp`
  module — an upstream packaging bug where the console-script entry point and the actual module
  layout diverged (visible comparing the wheel's `dist-info` entry_points to the on-disk package
  tree).
- `openhands acp` (the CLI's own `acp` subcommand, not the separate `openhands-acp` binary) runs
  the same ACP server code (imports the working `openhands_cli.acp_impl` internally) and does not
  hit the broken import path.

**Workaround used**: spawn `openhands acp` instead of the separate `openhands-acp` binary. This is
implemented in `OpenHandsAcpSupport.ts` with a doc comment explaining why, and a note to switch
back to the dedicated binary once the upstream entry point is fixed.

## Verified vs. unverified

**Verified:**

- `pnpm run typecheck` in `apps/server` — passes, 0 errors, nothing OpenHands-related flagged.
- Full test suite (`vp test run`, which ran the whole `apps/server` suite rather than just the
  filtered files) — 298 test files passed (2 skipped), 4285 tests passed (10 skipped), 0
  failures. All new OpenHands unit tests are part of this run and pass.
- `openhands acp --help` runs successfully (confirms the subcommand exists and the workaround is
  viable at all).
- Manually piped JSON-RPC `initialize` and `session/new` requests into `openhands acp` over
  stdio. The process starts, prints its startup banner and an SDK warning to stderr (as expected —
  `OPENHANDS_SUPPRESS_BANNER=1` is set by the driver to suppress this), but no JSON-RPC response
  was observed on stdout in the manual probe. This is inconclusive: it may need a longer timeout,
  a real workspace directory, or valid LLM credentials configured in `~/.openhands` to progress
  past session setup, none of which were readily available in this sandbox.

**Unverified (real end-to-end run):**

- Whether `openhands acp`'s actual ACP `initialize`/`session/new`/`prompt` responses match the
  message shapes assumed in `OpenHandsAcpSupport.ts` and `OpenHandsAdapter.ts` (tool-call
  structure, permission-request structure, mode-change notifications, session update ids). These
  were built against the protocol spec and by close analogy with `GrokAcpSupport.ts`/
  `CursorAcpSupport.ts`/`AcpJsonRpcConnection.ts`, but a full live conversation turn (prompt →
  tool call → permission grant → response) was not observed end-to-end against a real, credentialed
  OpenHands agent in this environment.
- The `--llm-approve` / `--always-approve` CLI flag names and the `always-ask`/`llm-approve`/
  `always-approve` ACP mode ids are inferred from `openhands acp --help` output and are
  reasonable-effort matches to T3's `RuntimeMode`, but weren't exercised through a live mode
  switch.
- Whether a local install genuinely never needs `authenticate` in all configurations (e.g. if a
  user has no `~/.openhands` credentials configured yet) — the driver assumes "already
  authenticated or fails visibly," consistent with `OpenHandsProvider.ts` always reporting
  `"unknown"` auth state rather than guessing.

## Open questions

- Confirm the real shape of OpenHands' `session/update` notifications (tool call granularity,
  permission option ids) against a live, credentialed session once available, and adjust
  `OpenHandsAdapter.ts` if it diverges from the Grok/Cursor-derived assumptions.
- Track the upstream `openhands-acp` entry-point bug and switch `OpenHandsAcpSupport.ts` back to
  spawning the dedicated binary once fixed upstream (both should be equivalent once fixed, but the
  dedicated binary keeps the process name and lifecycle distinct from other `openhands` CLI usage).
- Decide whether `binaryPath` should default-resolve through the same `uv tool` install location
  T3 config expects for other CLI-shelling providers, or whether `PATH` resolution (current
  behavior, matching Grok/Cursor) is sufficient.
