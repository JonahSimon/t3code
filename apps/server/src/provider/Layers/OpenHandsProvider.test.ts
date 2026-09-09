// @effect-diagnostics nodeBuiltinImport:off - resolves mock ACP agent script path relative to this test file.
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { OpenHandsSettings } from "@t3tools/contracts";

import {
  buildInitialOpenHandsProviderSnapshot,
  checkOpenHandsProviderStatus,
} from "./OpenHandsProvider.ts";
import { execScriptSource, writeFakeCli } from "../../testUtils/fakeCli.ts";

const decodeOpenHandsSettings = Schema.decodeSync(OpenHandsSettings);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.resolve(__dirname, "../../../scripts/acp-mock-agent.ts");

describe("buildInitialOpenHandsProviderSnapshot", () => {
  it.effect("returns a disabled snapshot when settings.enabled is false", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialOpenHandsProviderSnapshot(
        decodeOpenHandsSettings({ enabled: false }),
      );
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.installed).toBe(false);
      expect(snapshot.message).toContain("disabled");
    }),
  );

  it.effect("returns disabled by default — OpenHands is opt-in", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialOpenHandsProviderSnapshot(decodeOpenHandsSettings({}));
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
    }),
  );

  it.effect("returns a pending snapshot when enabled", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialOpenHandsProviderSnapshot(
        decodeOpenHandsSettings({ enabled: true }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.version).toBeNull();
      expect(snapshot.message).toContain("Checking OpenHands");
    }),
  );
});

it.layer(NodeServices.layer)("checkOpenHandsProviderStatus", (it) => {
  it.effect("reports binary as missing when binary path does not resolve", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkOpenHandsProviderStatus(
        decodeOpenHandsSettings({
          enabled: true,
          binaryPath: "/definitely/not/installed/openhands-binary",
        }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toMatch(/not installed|not on PATH|Failed to execute/);
    }),
  );

  it.effect("reports an installed CLI as unhealthy when --version exits non-zero", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-openhands-version-" });
          const openHandsPath = writeFakeCli({
            directory: dir,
            name: "openhands",
            source: ["process.exit(2);"].join("\n"),
          });
          return yield* checkOpenHandsProviderStatus(
            decodeOpenHandsSettings({ enabled: true, binaryPath: openHandsPath }),
          );
        }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toBe("OpenHands CLI is installed but failed to run.");
    }),
  );

  const writeFakeOpenHandsCli = (input: { readonly acp: boolean }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-openhands-probe-" });
      return writeFakeCli({
        directory: dir,
        name: "openhands",
        source: [
          'if (process.argv[2] === "--version") {',
          '  process.stdout.write("openhands 1.16.0\\n");',
          "  process.exit(0);",
          "}",
          'if (process.argv[2] !== "acp") process.exit(1);',
          ...(input.acp ? [execScriptSource({ scriptPath: mockAgentPath })] : ["process.exit(3);"]),
          "",
        ].join("\n"),
      });
    });

  it.effect("reports ready when the ACP initialize probe succeeds", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const openHandsPath = yield* writeFakeOpenHandsCli({ acp: true });
          return yield* checkOpenHandsProviderStatus(
            decodeOpenHandsSettings({ enabled: true, binaryPath: openHandsPath }),
          );
        }),
      );

      expect(snapshot.status).toBe("ready");
      expect(snapshot.installed).toBe(true);
      expect(snapshot.version).toBe("1.16.0");
      expect(snapshot.auth).toEqual({ status: "unknown" });
    }),
  );

  it.effect("falls back to a warning when the ACP initialize probe fails", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const openHandsPath = yield* writeFakeOpenHandsCli({ acp: false });
          return yield* checkOpenHandsProviderStatus(
            decodeOpenHandsSettings({ enabled: true, binaryPath: openHandsPath }),
          );
        }),
      );

      expect(snapshot.status).toBe("warning");
      expect(snapshot.installed).toBe(true);
      expect(snapshot.version).toBe("1.16.0");
      expect(snapshot.message).toContain("ACP initialize failed");
    }),
  );
});
