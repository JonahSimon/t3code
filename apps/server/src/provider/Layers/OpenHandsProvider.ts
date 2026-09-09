/**
 * OpenHandsProvider — status probing and snapshot building for the OpenHands CLI.
 *
 * OpenHands has no `models` listing command and its ACP session advertises no model
 * state (see {@link ../acp/OpenHandsAcpSupport}), so unlike Grok this probe never
 * discovers additional models. It also has no reliable local signal for auth state:
 * a local install resolves its LLM credentials from `~/.openhands`, not from a CLI
 * login step, so auth always reports `"unknown"` rather than guessing.
 *
 * @module OpenHandsProvider
 */
import {
  type CustomModelSetting,
  type ModelCapabilities,
  type OpenHandsSettings,
  type ServerProvider,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import {
  OPENHANDS_DEFAULT_MODEL_SLUG,
  makeOpenHandsAcpRuntime,
} from "../acp/OpenHandsAcpSupport.ts";

const OPENHANDS_PRESENTATION = {
  displayName: "OpenHands",
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

// OpenHands is a Python CLI: cold `--version` takes ~4s on this machine (uv
// tool install, heavy imports), so 4s was intermittently timing out. 15s is
// generous for cold caches while still failing fast on a broken install.
const VERSION_PROBE_TIMEOUT_MS = 15_000;
// `initialize` spawns a fresh `openhands acp` (another ~4s Python startup)
// before the handshake, so this must cover process boot plus the round trip.
const OPENHANDS_ACP_INITIALIZE_TIMEOUT_MS = 15_000;

const OPENHANDS_BUILT_IN_MODELS = [
  {
    slug: OPENHANDS_DEFAULT_MODEL_SLUG,
    name: "OpenHands Default",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];

export function buildInitialOpenHandsProviderSnapshot(
  openHandsSettings: OpenHandsSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = openHandsModelsFromSettings(openHandsSettings.customModels);

    if (!openHandsSettings.enabled) {
      return buildServerProvider({
        presentation: OPENHANDS_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "OpenHands is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: OPENHANDS_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking OpenHands CLI availability...",
      },
    });
  });
}

function openHandsModelsFromSettings(customModels: ReadonlyArray<CustomModelSetting> | undefined) {
  return providerModelsFromSettings(
    OPENHANDS_BUILT_IN_MODELS,
    customModels ?? [],
    EMPTY_CAPABILITIES,
  );
}

const runOpenHandsCliCommand = (
  openHandsSettings: OpenHandsSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const command = openHandsSettings.binaryPath || "openhands";
    const spawnCommand = yield* resolveSpawnCommand(command, args, { env: environment });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

/**
 * Confirms `openhands acp` can complete the ACP handshake. Only `initialize` is
 * called — never `authenticate` or `session/new` — so this cannot open a browser
 * login or boot the workspace's MCP servers. It exists to catch spawn-level
 * breakage (wrong binary, broken entry point) that a bare `--version` probe would
 * miss, since `openhands acp` and `openhands` share an entry point but not a code
 * path once the subcommand dispatches.
 */
const probeOpenHandsAcpInitialize = (
  openHandsSettings: OpenHandsSettings,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const acp = yield* makeOpenHandsAcpRuntime({
      openHandsSettings,
      environment,
      childProcessSpawner,
      cwd: process.cwd(),
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    });
    yield* acp.initialize();
  }).pipe(Effect.scoped);

export const checkOpenHandsProviderStatus = Effect.fn("checkOpenHandsProviderStatus")(function* (
  openHandsSettings: OpenHandsSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = openHandsModelsFromSettings(openHandsSettings.customModels);

  if (!openHandsSettings.enabled) {
    return buildServerProvider({
      presentation: OPENHANDS_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "OpenHands is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runOpenHandsCliCommand(
    openHandsSettings,
    ["--version"],
    environment,
  ).pipe(Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS), Effect.result);

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("OpenHands CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: OPENHANDS_PRESENTATION,
      enabled: openHandsSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "OpenHands CLI (`openhands`) is not installed or not on PATH."
          : "Failed to execute OpenHands CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: OPENHANDS_PRESENTATION,
      enabled: openHandsSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "OpenHands CLI is installed but timed out while running `openhands --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("OpenHands CLI version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    });
    return buildServerProvider({
      presentation: OPENHANDS_PRESENTATION,
      enabled: openHandsSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "OpenHands CLI is installed but failed to run.",
      },
    });
  }

  const acpExit = yield* probeOpenHandsAcpInitialize(openHandsSettings, environment).pipe(
    Effect.timeoutOption(OPENHANDS_ACP_INITIALIZE_TIMEOUT_MS),
    Effect.exit,
  );
  const acpFailed = Exit.isFailure(acpExit) || Option.isNone(acpExit.value);
  if (acpFailed) {
    yield* Effect.logWarning("OpenHands ACP initialize probe failed or timed out.", {
      errorTag: Exit.isFailure(acpExit) ? causeErrorTag(acpExit.cause) : "Timeout",
    });
  }

  return buildServerProvider({
    presentation: OPENHANDS_PRESENTATION,
    enabled: openHandsSettings.enabled,
    checkedAt,
    models: fallbackModels,
    probe: {
      installed: true,
      version,
      // A failed ACP probe degrades the chat experience, it does not make the
      // CLI itself unusable, so this is a warning rather than an error.
      status: acpFailed ? "warning" : "ready",
      auth: { status: "unknown" },
      ...(acpFailed
        ? {
            message:
              "OpenHands CLI is installed but ACP initialize failed. Chat sessions may not start.",
          }
        : {}),
    },
  });
});

export const enrichOpenHandsSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> => {
  const { snapshot, publishSnapshot } = input;

  return enrichProviderSnapshotWithVersionAdvisory(snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("OpenHands version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
