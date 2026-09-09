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

**Verified live end-to-end (2026-09-08, against the installed `openhands` 1.16.0):**

A full ACP conversation turn was driven over stdio against a real, credentialed OpenHands agent
(LLM = local Ollama, `gemma-4-12B-it-qat`, via `OPENHANDS_PERSISTENCE_DIR` pointing at an isolated
config). Every message shape the driver assumes was confirmed against live output:

- `initialize` → `agentCapabilities` (`loadSession: true`, `mcpCapabilities` http+sse,
  `promptCapabilities` audio/embeddedContext/image), `agentInfo` "OpenHands CLI ACP Agent"
  1.16.0, `authMethods` = only `[oauth]`. Confirms the driver's skip-`authenticate` decision.
- `session/new` → `sessionId` + `modes.availableModes` with ids exactly
  `always-ask`/`llm-approve`/`always-approve` and `currentModeId: "always-ask"` — matches
  `OPENHANDS_ALWAYS_ASK_MODE_ID`/`openHandsAcpModeId` and the `--llm-approve`/`--always-approve`
  spawn flags.
- `session/prompt` → `prompt` must be a **list of content blocks** (`[{type:"text",text:...}]`),
  not a string. The driver already sends a list; a string prompt returns
  `-32602 Invalid params (list_type)`.
- `session/request_permission` notification → `{options:[{kind,optionId,name}...], sessionId,
toolCall:{...}}` with kinds `allow_once`/`reject_once`/`allow_always`. The driver's
  `selectPermissionOptionId` lookup by kind resolves correctly (`accept`→`allow_once`,
  `acceptAlways`→`allow_always`, `reject`→`reject_once`), and `parsePermissionRequest` reads
  exactly the `toolCall` fields OpenHands sends. Responding with
  `{outcome:{outcome:"selected",optionId:"accept"}}` completes the approval.
- `session/update` notifications → `available_commands_update`, `agent_thought_chunk`,
  `agent_message_chunk`, `tool_call`, `tool_call_update` (with `rawOutput`), plus an extra
  `_meta.field_meta.openhands.dev/metrics` block that the runtime ignores gracefully.
- Real tool execution: with the permission granted, the agent ran `cat test.txt` (a
  `TerminalAction`), streamed `tool_call`/`tool_call_update`, and the prompt resolved with
  `{"result":{"stopReason":"end_turn"}}`.

**Two upstream bugs found while verifying:**

1. `openhands acp --override-with-envs` is a **no-op in ACP mode**: `entrypoint.py` parses the
   flag but never passes it to `run_acp_server`, so the LLM config always comes from
   `~/.openhands/agent_settings.json` (or `OPENHANDS_PERSISTENCE_DIR`). The driver does not rely
   on this flag, so no driver change is needed — but anyone expecting env-var LLM overrides in ACP
   mode will silently get the on-disk config.
2. For an OpenAI-compatible endpoint (Ollama), the `model` in `agent_settings.json` needs a
   litellm provider prefix (`openai/qwen3.5:latest`, not `qwen3.5:latest`); un-prefixed model
   names fail with `litellm.BadRequestError: LLM Provider NOT provided`.

**Earlier "hang" root-caused (not an OpenHands bug):** the manual probes that appeared to hang at
startup were deadlocking on a full stderr pipe — the probe never drained stderr while OpenHands
wrote its startup banner + SDK warning, so the child blocked on `write(2)` before answering
`initialize`. The driver is not affected: `AcpSessionRuntime.ts` drains stderr in a forked fiber
(`child.stderr.pipe(Stream.decodeText(), ...)`).

**Remaining unverified (low risk):**

- Whether a local install genuinely never needs `authenticate` in all configurations (e.g. if a
  user has no `~/.openhands` credentials configured yet) — the driver assumes "already
  authenticated or fails visibly," consistent with `OpenHandsProvider.ts` always reporting
  `"unknown"` auth state rather than guessing.
- A live `session/resume` (loadSession) round-trip — the `loadSession: true` capability is
  advertised and the shared runtime implements it, but it was not exercised in this session.

## Open questions

- Track the upstream `openhands-acp` entry-point bug and switch `OpenHandsAcpSupport.ts` back to
  spawning the dedicated binary once fixed upstream (both should be equivalent once fixed, but the
  dedicated binary keeps the process name and lifecycle distinct from other `openhands` CLI usage).
- Decide whether `binaryPath` should default-resolve through the same `uv tool` install location
  T3 config expects for other CLI-shelling providers, or whether `PATH` resolution (current
  behavior, matching Grok/Cursor) is sufficient.
- The LLM backend for real T3 use is unresolved: `~/.openhands/agent_settings.json` currently
  points at the headroom proxy with a stale, revoked Claude Code token. Refreshing that token (or
  pointing OpenHands at Ollama) is tracked in the shared-memory backlog, not this repo.
