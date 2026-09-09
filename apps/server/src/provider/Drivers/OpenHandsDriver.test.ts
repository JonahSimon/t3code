// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient } from "effect/unstable/http";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { OpenHandsDriver } from "./OpenHandsDriver.ts";

const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-openhands-driver-",
}).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
  ),
  Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Disabled OpenHands must not make an HTTP request")),
    ),
  ),
);

it.layer(testLayer)("OpenHandsDriver", (it) => {
  it.effect('disabled instance reports status "disabled" and never spawns a process', () =>
    Effect.gen(function* () {
      const instance = yield* OpenHandsDriver.create({
        instanceId: ProviderInstanceId.make("openhands-disabled"),
        displayName: "OpenHands test",
        enabled: false,
        environment: [],
        config: OpenHandsDriver.defaultConfig(),
      });
      expect((yield* instance.snapshot.refresh).status).toBe("disabled");
    }).pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => Effect.die("Disabled OpenHands must not spawn a process")),
      ),
      Effect.scoped,
    ),
  );

  // Unlike Cursor and Codex, OpenHands has no proven update-installer path (it
  // ships via `uv tool install`), so maintenance is manual-only regardless of
  // whether the configured executable exists.
  it.effect("stays manual-only regardless of the configured executable", () =>
    Effect.gen(function* () {
      const instance = yield* OpenHandsDriver.create({
        instanceId: ProviderInstanceId.make("openhands-manual-only"),
        displayName: "OpenHands test",
        enabled: false,
        environment: [],
        config: {
          ...OpenHandsDriver.defaultConfig(),
          binaryPath: NodePath.join("does", "not", "exist", "openhands"),
        },
      });
      expect((yield* instance.snapshot.resolveMaintenance()).update).toBeNull();
    }).pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.die("OpenHands must not spawn a process to resolve maintenance"),
        ),
      ),
      Effect.scoped,
    ),
  );

  it("default config is disabled with the bare `openhands` binary", () => {
    const config = OpenHandsDriver.defaultConfig();
    expect(config.enabled).toBe(false);
    expect(config.binaryPath).toBe("openhands");
    expect(config.customModels).toEqual([]);
  });
});
