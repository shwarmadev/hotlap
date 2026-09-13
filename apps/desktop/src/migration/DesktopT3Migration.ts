// @effect-diagnostics nodeBuiltinImport:off -- This service is the native boundary for inspecting and atomically moving desktop homes.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";

const { mkdir, readFile, rename, writeFile } = NodeFSP;
const { randomUUID } = NodeCrypto;

import { bootstrapRemoteBearerSession } from "@t3tools/client-runtime/authorization";
import {
  environmentEndpointUrl,
  fetchRemoteEnvironmentDescriptor,
} from "@t3tools/client-runtime/environment";
import {
  executeEnvironmentHttpRequest,
  makeEnvironmentHttpApiGroupClient,
} from "@t3tools/client-runtime/rpc";
import type {
  DesktopT3MigrationInspection,
  DesktopT3MigrationStartInput,
  DesktopT3MigrationStartResult,
} from "@t3tools/contracts";
import { t3MigrationManifest } from "@t3tools/shared/t3MigrationManifest";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/unstable/http/HttpClient";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import {
  inspectT3DesktopMigration,
  migrateT3DesktopData,
  recoverT3DesktopMigration,
  type T3DesktopMigrationPaths,
} from "./T3DesktopMigrationCore.ts";
import { macT3DesktopProcessProbe } from "./T3DesktopMigrationProcess.ts";

const MIGRATION_DIRECTORY = "t3-desktop";
const DISMISSED_FILE = "dismissed.json";
const BACKEND_STOP_TIMEOUT = Duration.seconds(8);
const BACKEND_READY_TIMEOUT = Duration.seconds(30);
const HTTP_VALIDATION_TIMEOUT_MS = 10_000;

type RecoveryResult = Awaited<ReturnType<typeof recoverT3DesktopMigration>>;

const DesktopT3MigrationOperation = Schema.Literals([
  "inspect",
  "dismiss",
  "read-identity",
  "stop-backend",
  "validate-backend",
  "migrate",
  "recover",
]);

export class DesktopT3MigrationOperationError extends Schema.TaggedError<DesktopT3MigrationOperationError>()(
  "DesktopT3MigrationOperationError",
  {
    operation: DesktopT3MigrationOperation,
    detail: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

const isDesktopT3MigrationOperationError = Schema.is(DesktopT3MigrationOperationError);

function operationError(
  operation: typeof DesktopT3MigrationOperation.Type,
  detail: string,
  cause: unknown,
): DesktopT3MigrationOperationError {
  return new DesktopT3MigrationOperationError({ operation, detail, cause });
}

export class DesktopT3Migration extends Context.Service<
  DesktopT3Migration,
  {
    readonly inspect: Effect.Effect<DesktopT3MigrationInspection, DesktopT3MigrationOperationError>;
    readonly dismiss: Effect.Effect<void, DesktopT3MigrationOperationError>;
    readonly start: (
      input: DesktopT3MigrationStartInput,
    ) => Effect.Effect<DesktopT3MigrationStartResult>;
    readonly recover: Effect.Effect<RecoveryResult, DesktopT3MigrationOperationError>;
  }
>()("@t3tools/desktop/migration/DesktopT3Migration") {}

function resolvePaths(
  environment: DesktopEnvironment.DesktopEnvironment["Service"],
): T3DesktopMigrationPaths {
  const sourceBaseDir = environment.path.join(environment.homeDirectory, ".t3");
  return {
    sourceBaseDir,
    sourceStateDir: environment.path.join(sourceBaseDir, "userdata"),
    destinationBaseDir: environment.baseDir,
    destinationStateDir: environment.stateDir,
    migrationDir: environment.path.join(environment.baseDir, "migrations", MIGRATION_DIRECTORY),
  };
}

async function writeDismissed(paths: T3DesktopMigrationPaths): Promise<void> {
  await mkdir(paths.migrationDir, { recursive: true, mode: 0o700 });
  const destination = NodePath.join(paths.migrationDir, DISMISSED_FILE);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  await writeFile(temporary, '{"version":1}\n', { flag: "wx", mode: 0o600 });
  await rename(temporary, destination);
}

async function isDismissed(paths: T3DesktopMigrationPaths): Promise<boolean> {
  try {
    const value = JSON.parse(
      await readFile(NodePath.join(paths.migrationDir, DISMISSED_FILE), "utf8"),
    ) as Record<string, unknown>;
    return value.version === 1;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    return false;
  }
}

function toContractInspection(
  inspection: Awaited<ReturnType<typeof inspectT3DesktopMigration>>,
  dismissed: boolean,
): DesktopT3MigrationInspection {
  if (inspection.status === "ready") {
    return {
      status: "ready",
      dismissed,
      summary: {
        projectCount: inspection.projectCount,
        threadCount: inspection.threadCount,
        destinationHasData: inspection.destinationHasData,
        pairingTransfer: inspection.pairingTransfer,
      },
    };
  }
  if (inspection.status === "blocked") {
    return { status: "blocked", reason: inspection.reason, dismissed };
  }
  return inspection;
}

const assertBackendStopped = Effect.fn("desktop.t3Migration.assertBackendStopped")(function* (
  instances: ReadonlyArray<DesktopBackendPool.DesktopBackendInstance>,
) {
  yield* Effect.forEach(instances, (instance) => instance.stop({ timeout: BACKEND_STOP_TIMEOUT }), {
    concurrency: "unbounded",
  });
  const snapshots = yield* Effect.forEach(instances, (instance) => instance.snapshot);
  if (
    snapshots.some(
      (snapshot) =>
        snapshot.desiredRunning || Option.isSome(snapshot.activePid) || snapshot.restartScheduled,
    )
  ) {
    return yield* operationError(
      "stop-backend",
      "Hotlap backend did not stop cleanly for migration.",
      snapshots,
    );
  }
});

function validateImportedBackend(input: {
  readonly backend: DesktopBackendPool.DesktopBackendInstance;
  readonly expectedEnvironmentId: string;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void, DesktopT3MigrationOperationError> {
  return Effect.gen(function* () {
    yield* input.backend.start;
    const ready = yield* input.backend.waitForReady(BACKEND_READY_TIMEOUT);
    if (!ready) {
      return yield* operationError(
        "validate-backend",
        "Imported Hotlap backend did not become ready.",
        "readiness-timeout",
      );
    }

    const config = yield* input.backend.currentConfig;
    if (Option.isNone(config) || config.value.bootstrap.desktopBootstrapToken === undefined) {
      return yield* operationError(
        "validate-backend",
        "Imported Hotlap backend did not provide local authentication.",
        "missing-bootstrap-token",
      );
    }
    const httpBaseUrl = config.value.httpBaseUrl.href;
    const descriptor = yield* fetchRemoteEnvironmentDescriptor({
      httpBaseUrl,
      timeoutMs: HTTP_VALIDATION_TIMEOUT_MS,
    });
    if (descriptor.environmentId !== input.expectedEnvironmentId) {
      return yield* operationError(
        "validate-backend",
        "Imported Hotlap backend has the wrong environment identity.",
        descriptor.environmentId,
      );
    }

    const session = yield* bootstrapRemoteBearerSession({
      httpBaseUrl,
      credential: config.value.bootstrap.desktopBootstrapToken,
      timeoutMs: HTTP_VALIDATION_TIMEOUT_MS,
      clientMetadata: { label: "Hotlap migration check", deviceType: "desktop" },
    });
    const orchestration = yield* makeEnvironmentHttpApiGroupClient(httpBaseUrl, "orchestration");
    yield* executeEnvironmentHttpRequest(
      environmentEndpointUrl(httpBaseUrl, "/api/orchestration/shell"),
      HTTP_VALIDATION_TIMEOUT_MS,
      orchestration.shellSnapshot({
        headers: { authorization: `Bearer ${session.access_token}` },
      }),
    );
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.mapError((cause) =>
      isDesktopT3MigrationOperationError(cause)
        ? cause
        : operationError(
            "validate-backend",
            "Imported Hotlap backend failed authenticated validation.",
            cause,
          ),
    ),
  );
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const pool = yield* DesktopBackendPool.DesktopBackendPool;
  const desktopSettings = yield* DesktopAppSettings.DesktopAppSettings;
  const httpClient = yield* HttpClient.HttpClient;
  const hookContext = yield* Effect.context<
    | DesktopEnvironment.DesktopEnvironment
    | DesktopBackendPool.DesktopBackendPool
    | DesktopAppSettings.DesktopAppSettings
    | HttpClient.HttpClient
  >();
  const mutex = yield* Semaphore.make(1);
  const paths = resolvePaths(environment);
  const usesDefaultDestinationHome =
    environment.baseDir === environment.path.join(environment.homeDirectory, ".hotlap") &&
    environment.stateDir ===
      environment.path.join(environment.homeDirectory, ".hotlap", "userdata");

  const inspect = Effect.tryPromise({
    try: async () => {
      const [inspection, dismissed] = await Promise.all([
        inspectT3DesktopMigration({
          paths,
          platform: environment.platform,
          isPackaged: environment.isPackaged,
          usesDefaultDestinationHome,
          processProbe: macT3DesktopProcessProbe,
          migrationManifest: t3MigrationManifest,
        }),
        isDismissed(paths),
      ]);
      return toContractInspection(inspection, dismissed);
    },
    catch: (cause) =>
      operationError("inspect", "Hotlap could not inspect the T3 Code workspace.", cause),
  });

  const dismiss = Effect.tryPromise({
    try: () => writeDismissed(paths),
    catch: (cause) =>
      operationError("dismiss", "Hotlap could not save the migration choice.", cause),
  });

  const start = (request: DesktopT3MigrationStartInput) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const expectedEnvironmentId = yield* Effect.tryPromise({
          try: () => readFile(NodePath.join(paths.sourceStateDir, "environment-id"), "utf8"),
          catch: (cause) =>
            operationError(
              "read-identity",
              "T3 Code environment identity could not be read.",
              cause,
            ),
        }).pipe(Effect.map((value) => value.trim()));
        const instances = yield* pool.list;
        const previousSnapshots = yield* Effect.forEach(instances, (instance) => instance.snapshot);
        const primary = yield* pool.primary;
        const runPromise = Effect.runPromiseWith(hookContext);

        const result = yield* Effect.tryPromise({
          try: () =>
            migrateT3DesktopData({
              paths,
              platform: environment.platform,
              isPackaged: environment.isPackaged,
              usesDefaultDestinationHome,
              processProbe: macT3DesktopProcessProbe,
              migrationManifest: t3MigrationManifest,
              replaceExisting: request.replaceExisting,
              hooks: {
                stopDestinationBackend: () => runPromise(assertBackendStopped(instances)),
                reloadDestinationSettings: () =>
                  runPromise(desktopSettings.load.pipe(Effect.asVoid)),
                startAndValidateDestinationBackend: () =>
                  runPromise(
                    validateImportedBackend({
                      backend: primary,
                      expectedEnvironmentId,
                      httpClient,
                    }),
                  ),
                restartPreviousDestinationBackend: () =>
                  runPromise(
                    Effect.forEach(
                      instances,
                      (instance, index) =>
                        previousSnapshots[index]?.desiredRunning ? instance.start : Effect.void,
                      { concurrency: "unbounded", discard: true },
                    ),
                  ),
              },
            }),
          catch: (cause) => operationError("migrate", "T3 Code migration failed.", cause),
        }).pipe(
          Effect.catch((error) =>
            Effect.succeed({ status: "error", message: error.message } as const),
          ),
        );

        if (result.status === "failed") {
          return { status: "error", message: result.message } as const;
        }
        return result;
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed({
            status: "error",
            message: error.message,
          } as const),
        ),
      ),
    );

  return DesktopT3Migration.of({
    inspect,
    dismiss,
    start,
    recover: Effect.tryPromise({
      try: () => recoverT3DesktopMigration(paths),
      catch: (cause) =>
        operationError("recover", "Hotlap could not recover the previous migration.", cause),
    }),
  });
});

export const layer = Layer.effect(DesktopT3Migration, make);
