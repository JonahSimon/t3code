// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  OpenHandsSettings,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";

import type { AcpSessionModeState } from "../acp/AcpRuntimeModel.ts";
import { ServerConfig } from "../../config.ts";
import {
  makeOpenHandsAdapter,
  parseOpenHandsResume,
  resolveRequestedModeId,
  selectPermissionOptionId,
} from "./OpenHandsAdapter.ts";
import { execScriptSource, writeFakeCli } from "../../testUtils/fakeCli.ts";

const decodeOpenHandsSettings = Schema.decodeSync(OpenHandsSettings);

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");

async function makeMockOpenHandsWrapper(extraEnv?: Record<string, string>) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "openhands-acp-mock-"));
  return writeFakeCli({
    directory: dir,
    name: "fake-openhands",
    env: extraEnv ?? {},
    // Real spawns pass `acp` plus a mode flag (`--llm-approve`, `--always-approve`);
    // only the subcommand is asserted since the flag varies with runtimeMode.
    source: execScriptSource({ scriptPath: mockAgentPath, expectedArgs: ["acp"] }),
  });
}

const openHandsAdapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-openhands-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const makeTestAdapter = (
  binaryPath: string,
  options?: Parameters<typeof makeOpenHandsAdapter>[1],
) => makeOpenHandsAdapter(decodeOpenHandsSettings({ binaryPath }), options).pipe(Effect.orDie);

it("accepts a resume cursor only when its schema version and sessionId match", () => {
  assert.deepEqual(parseOpenHandsResume({ schemaVersion: 1, sessionId: "abc" }), {
    sessionId: "abc",
  });
  assert.isUndefined(parseOpenHandsResume(undefined));
  assert.isUndefined(parseOpenHandsResume(null));
  assert.isUndefined(parseOpenHandsResume("abc"));
  assert.isUndefined(parseOpenHandsResume({ schemaVersion: 2, sessionId: "abc" }));
  assert.isUndefined(parseOpenHandsResume({ schemaVersion: 1, sessionId: "" }));
  assert.isUndefined(parseOpenHandsResume({ schemaVersion: 1, sessionId: "   " }));
  assert.isUndefined(parseOpenHandsResume({ schemaVersion: 1 }));
});

function openHandsModeState(availableModeIds: ReadonlyArray<string>): AcpSessionModeState {
  return {
    currentModeId: "always-ask",
    availableModes: availableModeIds.map((id) => ({ id, name: id })),
  };
}

it("resolves undefined without mode state, since OpenHands has nothing to switch", () => {
  assert.isUndefined(
    resolveRequestedModeId({
      interactionMode: "default",
      runtimeMode: "full-access",
      modeState: undefined,
    }),
  );
});

it("maps runtime mode to the matching OpenHands confirmation mode", () => {
  const modeState = openHandsModeState(["always-ask", "llm-approve", "always-approve"]);
  assert.equal(
    resolveRequestedModeId({
      interactionMode: "default",
      runtimeMode: "approval-required",
      modeState,
    }),
    "always-ask",
  );
  assert.equal(
    resolveRequestedModeId({ interactionMode: "default", runtimeMode: "auto", modeState }),
    "llm-approve",
  );
  assert.equal(
    resolveRequestedModeId({
      interactionMode: "default",
      runtimeMode: "auto-accept-edits",
      modeState,
    }),
    "llm-approve",
  );
  assert.equal(
    resolveRequestedModeId({ interactionMode: "default", runtimeMode: "full-access", modeState }),
    "always-approve",
  );
});

it("forces always-ask for plan mode regardless of runtime mode", () => {
  const modeState = openHandsModeState(["always-ask", "llm-approve", "always-approve"]);
  assert.equal(
    resolveRequestedModeId({ interactionMode: "plan", runtimeMode: "full-access", modeState }),
    "always-ask",
  );
});

it("falls back to the agent's current mode when the requested mode isn't offered", () => {
  const modeState = openHandsModeState(["always-ask"]);
  assert.equal(
    resolveRequestedModeId({ interactionMode: "default", runtimeMode: "full-access", modeState }),
    "always-ask",
  );
});

function openHandsPermissionRequest(
  options: ReadonlyArray<{
    readonly optionId: string;
    readonly kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
  }>,
) {
  return {
    sessionId: "mock-session-1",
    toolCall: {
      toolCallId: "tool-call-1",
      title: "cat package.json",
      kind: "execute" as const,
      status: "pending" as const,
    },
    options: options.map((option) => ({
      optionId: option.optionId,
      name: option.kind,
      kind: option.kind,
    })),
  };
}

it("maps accept decisions to allow_once, preferring it over allow_always", () => {
  const request = openHandsPermissionRequest([
    { optionId: "allow-once", kind: "allow_once" },
    { optionId: "allow-always", kind: "allow_always" },
    { optionId: "reject-once", kind: "reject_once" },
  ]);
  assert.equal(selectPermissionOptionId(request, "accept"), "allow-once");
});

it("maps acceptForSession and acceptAlways decisions to allow_always when offered", () => {
  const request = openHandsPermissionRequest([
    { optionId: "allow-once", kind: "allow_once" },
    { optionId: "allow-always", kind: "allow_always" },
    { optionId: "reject-once", kind: "reject_once" },
  ]);
  assert.equal(selectPermissionOptionId(request, "acceptForSession"), "allow-always");
  assert.equal(selectPermissionOptionId(request, "acceptAlways"), "allow-always");
});

it("falls back to allow_once when OpenHands omits allow_always", () => {
  const request = openHandsPermissionRequest([
    { optionId: "allow-once", kind: "allow_once" },
    { optionId: "reject-once", kind: "reject_once" },
  ]);
  assert.equal(selectPermissionOptionId(request, "acceptForSession"), "allow-once");
});

it("maps decline to reject_once", () => {
  const request = openHandsPermissionRequest([
    { optionId: "allow-once", kind: "allow_once" },
    { optionId: "reject-once", kind: "reject_once" },
  ]);
  assert.equal(selectPermissionOptionId(request, "decline"), "reject-once");
});

it("returns undefined when no option matches the decision's kinds", () => {
  const request = openHandsPermissionRequest([{ optionId: "allow-once", kind: "allow_once" }]);
  assert.isUndefined(selectPermissionOptionId(request, "decline"));
});

it.layer(openHandsAdapterTestLayer)("OpenHandsAdapterLive", (it) => {
  it.effect("starts a session and maps mock ACP prompt flow to runtime events", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("openhands-mock-thread");
      const wrapperPath = yield* Effect.promise(() => makeMockOpenHandsWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed"
              ? Deferred.succeed(turnCompleted, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("openhands"), model: "openhands" },
      });

      assert.equal(session.provider, "openhands");
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "hello openhands",
        attachments: [],
      });

      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(runtimeEventsFiber);
      const types = runtimeEvents.map((e) => e.type);

      assert.includeMembers(types, [
        "session.started",
        "session.state.changed",
        "thread.started",
        "turn.started",
        "item.started",
        "content.delta",
        "turn.completed",
      ] as const);

      const delta = runtimeEvents.find((e) => e.type === "content.delta");
      assert.isDefined(delta);
      if (delta?.type === "content.delta") {
        assert.equal(delta.payload.delta, "hello from mock");
      }

      yield* adapter.stopSession(threadId);
    }),
  );
});
