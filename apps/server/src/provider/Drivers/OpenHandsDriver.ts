/**
 * OpenHandsDriver — `ProviderDriver` for the OpenHands CLI (`openhands acp`).
 *
 * OpenHands exposes an ACP-based CLI, like Grok and Cursor. Unlike either, it has no
 * model catalog to refresh (its ACP session advertises no model state) and no proven
 * update-installer path (it ships via `uv tool install`, which `providerMaintenance.ts`
 * cannot attribute to a specific owner), so this driver skips catalog refresh and uses
 * manual-only maintenance capabilities. See `../acp/OpenHandsAcpSupport.ts` for the
 * `openhands-acp` binary breakage this driver works around.
 *
 * @module provider/Drivers/OpenHandsDriver
 */
import { OpenHandsSettings, ProviderDriverKind } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeOpenHandsTextGeneration } from "../../textGeneration/OpenHandsTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeOpenHandsAdapter } from "../Layers/OpenHandsAdapter.ts";
import {
  buildInitialOpenHandsProviderSnapshot,
  checkOpenHandsProviderStatus,
  enrichOpenHandsSnapshot,
} from "../Layers/OpenHandsProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";

const decodeOpenHandsSettings = Schema.decodeSync(OpenHandsSettings);

const DRIVER_KIND = ProviderDriverKind.make("openhands");
const MAINTENANCE_CAPABILITIES = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: null,
});

export type OpenHandsDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

export const OpenHandsDriver: ProviderDriver<OpenHandsSettings, OpenHandsDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "OpenHands",
    supportsMultipleInstances: true,
  },
  configSchema: OpenHandsSettings,
  defaultConfig: (): OpenHandsSettings => decodeOpenHandsSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const httpClient = yield* HttpClient.HttpClient;
      const serverSettings = yield* ServerSettingsService;
      const eventLoggers = yield* ProviderEventLoggers;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER_KIND,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const effectiveConfig = { ...config, enabled } satisfies OpenHandsSettings;
      const adapter = yield* makeOpenHandsAdapter(effectiveConfig, {
        environment: processEnv,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        instanceId,
      });
      const textGeneration = yield* makeOpenHandsTextGeneration(effectiveConfig, processEnv);

      const checkProvider = checkOpenHandsProviderStatus(effectiveConfig, processEnv).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<
        ProviderSnapshotSettings<OpenHandsSettings>
      >({
        resolveMaintenance: () => Effect.succeed(MAINTENANCE_CAPABILITIES),
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          buildInitialOpenHandsProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
        checkProvider,
        enrichSnapshot: ({ settings, snapshot: currentSnapshot, publishSnapshot }) =>
          enrichOpenHandsSnapshot({
            snapshot: currentSnapshot,
            maintenanceCapabilities: MAINTENANCE_CAPABILITIES,
            enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
            publishSnapshot,
            httpClient,
          }),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build OpenHands snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        snapshotForCwd: () => snapshot.getSnapshot,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
