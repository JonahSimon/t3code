// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { createModelSelection } from "@t3tools/shared/model";
import { expect } from "vite-plus/test";
import { OpenHandsSettings, ProviderInstanceId } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as TextGeneration from "./TextGeneration.ts";
import { makeOpenHandsTextGeneration } from "./OpenHandsTextGeneration.ts";
import { execScriptSource, writeFakeCli } from "../testUtils/fakeCli.ts";
const decodeOpenHandsSettings = Schema.decodeSync(OpenHandsSettings);

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../scripts/acp-mock-agent.ts");

const OpenHandsTextGenerationTestLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-openhands-text-generation-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

function makeAcpOpenHandsWrapper(dir: string, env: Record<string, string>): string {
  return writeFakeCli({
    directory: NodePath.join(dir, "bin"),
    name: "openhands",
    env,
    source: execScriptSource({
      scriptPath: mockAgentPath,
      expectedArgs: ["acp"],
    }),
  });
}

function withFakeAcpOpenHands<A, E, R>(
  env: Record<string, string>,
  effectFn: (textGeneration: TextGeneration.TextGeneration["Service"]) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const tempDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-openhands-text-acp-"),
    );
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }),
    );
    const binaryPath = makeAcpOpenHandsWrapper(tempDir, env);
    const config = decodeOpenHandsSettings({ binaryPath });
    const textGeneration = yield* makeOpenHandsTextGeneration(config);
    return yield* effectFn(textGeneration);
  }).pipe(Effect.scoped);
}

function readJsonRpcRequests(
  filePath: string,
): ReadonlyArray<{ readonly method?: string; readonly params?: Record<string, unknown> }> {
  return NodeFS.readFileSync(filePath, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> });
}

// OpenHands has no model catalog, so `session/set_model` is never sent; the
// requested model id only routes commands to this driver.
const modelSelection = createModelSelection(
  ProviderInstanceId.make("openhands"),
  "openhands-default",
);

it.layer(OpenHandsTextGenerationTestLayer)("OpenHandsTextGeneration", (it) => {
  it.effect("uses ACP with disabled tool capabilities and always-ask mode", () => {
    const requestLogDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-openhands-text-log-"),
    );
    const requestLogPath = NodePath.join(requestLogDir, "requests.ndjson");

    return withFakeAcpOpenHands(
      {
        T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({
          subject: "Add OpenHands provider",
          body: "Wire up the ACP runtime and headless text generation path.",
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/openhands",
            stagedSummary: "M apps/server/src/provider/Drivers/OpenHandsDriver.ts",
            stagedPatch: "diff --git a/.../OpenHandsDriver.ts b/.../OpenHandsDriver.ts",
            modelSelection,
          });

          expect(generated.subject).toBe("Add OpenHands provider");
          expect(generated.body).toBe("Wire up the ACP runtime and headless text generation path.");

          const requests = readJsonRpcRequests(requestLogPath);
          expect(
            requests.find((request) => request.method === "initialize")?.params?.clientCapabilities,
          ).toMatchObject({
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          });
          expect(requests.some((request) => request.method === "session/set_model")).toBe(false);
        }),
    );
  });

  it.effect("extracts the JSON object when OpenHands wraps it in conversational text", () =>
    withFakeAcpOpenHands(
      {
        T3_ACP_PROMPT_RESPONSE_TEXT:
          "Sure! Here's a thread title:\n\n" +
          JSON.stringify({ title: "Investigate failing CI" }) +
          "\n\nLet me know if you need anything else.",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "the lint job is red",
            modelSelection,
          });
          expect(generated.title).toBe("Investigate failing CI");
        }),
    ),
  );

  it.effect("fails with TextGenerationError when output is empty", () =>
    withFakeAcpOpenHands(
      {
        T3_ACP_PROMPT_RESPONSE_TEXT: "   \n  ",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(
            textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "anything",
              modelSelection,
            }),
          );
          expect(error._tag).toBe("TextGenerationError");
          expect(error.detail).toMatch(/empty/i);
        }),
    ),
  );

  it.effect("decodes a structured PR title + body", () =>
    withFakeAcpOpenHands(
      {
        T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({
          title: "feat(openhands): wire up ACP text generation",
          body: "## Summary\n- Spawn `openhands acp` for headless text generation.\n- Extract JSON output from conversational wrapping.",
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generatePrContent({
            cwd: process.cwd(),
            baseBranch: "main",
            headBranch: "feat/openhands-provider",
            commitSummary: "feat: add openhands provider",
            diffSummary: "M apps/server/src/provider/Drivers/OpenHandsDriver.ts",
            diffPatch: "diff --git a/.../OpenHandsDriver.ts b/.../OpenHandsDriver.ts",
            modelSelection,
          });

          expect(generated.title).toBe("feat(openhands): wire up ACP text generation");
          expect(generated.body).toContain("Spawn `openhands acp`");
        }),
    ),
  );

  it.effect("fails with TextGenerationError when output is unparseable JSON", () =>
    withFakeAcpOpenHands(
      {
        T3_ACP_PROMPT_RESPONSE_TEXT: "totally not json output from a confused model",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(
            textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "anything",
              modelSelection,
            }),
          );
          expect(error._tag).toBe("TextGenerationError");
          expect(error.detail).toMatch(/invalid structured output/i);
        }),
    ),
  );

  it.effect("decodes a branch name suggestion", () =>
    withFakeAcpOpenHands(
      {
        T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({ branch: "feature/wire-up-openhands" }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateBranchName({
            cwd: process.cwd(),
            message: "wire up openhands",
            modelSelection,
          });
          expect(generated.branch).toBe("feature/wire-up-openhands");
        }),
    ),
  );
});
