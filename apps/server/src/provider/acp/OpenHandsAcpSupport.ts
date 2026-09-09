/**
 * OpenHandsAcpSupport — spawn and runtime wiring for the OpenHands CLI over ACP.
 *
 * The CLI ships an `openhands-acp` console script, but in 1.16.0 its generated
 * entry point targets `openhands_cli.acp:main` while the wheel only contains
 * `openhands_cli.acp_impl`, so the script raises `ModuleNotFoundError` on every
 * invocation. The `openhands acp` subcommand runs the same server and is what we
 * spawn; switch back to the dedicated binary only once it resolves upstream.
 *
 * @module OpenHandsAcpSupport
 */
import {
  type OpenHandsSettings,
  OPENHANDS_DEFAULT_MODEL,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

/** Keeps the startup banner off the wire. It goes to stderr, but stderr is logged. */
const OPENHANDS_SUPPRESS_BANNER_ENV = "OPENHANDS_SUPPRESS_BANNER";

/**
 * Confirmation modes the agent advertises in `session/new`. They double as the
 * mode ids accepted by `session/set_mode`, so switching a live session uses the
 * same vocabulary as the launch flags.
 */
export const OPENHANDS_ALWAYS_ASK_MODE_ID = "always-ask";
export const OPENHANDS_LLM_APPROVE_MODE_ID = "llm-approve";
export const OPENHANDS_ALWAYS_APPROVE_MODE_ID = "always-approve";

type OpenHandsAcpRuntimeSettings = Pick<OpenHandsSettings, "binaryPath">;

export interface OpenHandsAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly openHandsSettings: OpenHandsAcpRuntimeSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
  readonly runtimeMode?: RuntimeMode;
}

/**
 * OpenHands has three confirmation modes and no edit-only tier, so
 * `auto-accept-edits` and `auto` both land on the LLM security analyzer: it is
 * the only setting that drops routine prompts while still stopping on the
 * actions OpenHands rates high risk.
 */
export function openHandsAcpModeId(runtimeMode: RuntimeMode | undefined): string {
  switch (runtimeMode) {
    case "auto-accept-edits":
    case "auto":
      return OPENHANDS_LLM_APPROVE_MODE_ID;
    case "full-access":
      return OPENHANDS_ALWAYS_APPROVE_MODE_ID;
    case "approval-required":
    default:
      return OPENHANDS_ALWAYS_ASK_MODE_ID;
  }
}

/**
 * `acp` is an argparse subcommand, so its flags must follow it. Always-ask is the
 * CLI default and has no flag of its own.
 */
export function openHandsAcpSpawnArgs(runtimeMode?: RuntimeMode): ReadonlyArray<string> {
  switch (openHandsAcpModeId(runtimeMode)) {
    case OPENHANDS_LLM_APPROVE_MODE_ID:
      return ["acp", "--llm-approve"];
    case OPENHANDS_ALWAYS_APPROVE_MODE_ID:
      return ["acp", "--always-approve"];
    default:
      return ["acp"];
  }
}

export function buildOpenHandsAcpSpawnInput(
  openHandsSettings: OpenHandsAcpRuntimeSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
  runtimeMode?: RuntimeMode,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: openHandsSettings?.binaryPath || "openhands",
    args: [...openHandsAcpSpawnArgs(runtimeMode)],
    cwd,
    env: {
      ...environment,
      [OPENHANDS_SUPPRESS_BANNER_ENV]: "1",
    },
  };
}

/**
 * Builds the session runtime. No `authMethodId` is sent: OpenHands advertises only
 * its cloud OAuth device flow, and a local install is already authenticated through
 * `~/.openhands`, so calling `authenticate` would start a browser login per session.
 */
export const makeOpenHandsAcpRuntime = (
  input: OpenHandsAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildOpenHandsAcpSpawnInput(
          input.openHandsSettings,
          input.cwd,
          input.environment,
          input.runtimeMode,
        ),
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

/**
 * T3's built-in OpenHands slug. OpenHands resolves its LLM from `~/.openhands` and
 * its ACP session carries no model state, so the slug only ever means "whatever the
 * CLI is configured with" and is never sent over the wire.
 */
export const OPENHANDS_DEFAULT_MODEL_SLUG = OPENHANDS_DEFAULT_MODEL;

export function resolveOpenHandsAcpBaseModelId(model: string | null | undefined): string {
  return model?.trim() || OPENHANDS_DEFAULT_MODEL_SLUG;
}
