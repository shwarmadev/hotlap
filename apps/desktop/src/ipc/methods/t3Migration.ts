// @effect-diagnostics globalTimersInEffect:off -- Relaunch is deliberately scheduled after IPC returns the completed result to the renderer.
import {
  DesktopT3MigrationInspectionSchema,
  DesktopT3MigrationStartInputSchema,
  DesktopT3MigrationStartResultSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopLifecycle from "../../app/DesktopLifecycle.ts";
import * as DesktopT3Migration from "../../migration/DesktopT3Migration.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

const scheduleRelaunch = Effect.fn("desktop.ipc.t3Migration.scheduleRelaunch")(function* () {
  const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
  const context = yield* Effect.context<DesktopLifecycle.DesktopLifecycleRuntimeServices>();
  const runPromise = Effect.runPromiseWith(context);
  yield* Effect.sync(() => {
    setTimeout(() => {
      void runPromise(lifecycle.relaunch("T3 Code migration completed"));
    }, 250);
  });
});

export const inspectT3DesktopMigration = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.INSPECT_T3_DESKTOP_MIGRATION_CHANNEL,
  payload: Schema.Void,
  result: DesktopT3MigrationInspectionSchema,
  handler: Effect.fn("desktop.ipc.t3Migration.inspect")(function* () {
    const migration = yield* DesktopT3Migration.DesktopT3Migration;
    return yield* migration.inspect;
  }),
});

export const dismissT3DesktopMigration = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DISMISS_T3_DESKTOP_MIGRATION_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.t3Migration.dismiss")(function* () {
    const migration = yield* DesktopT3Migration.DesktopT3Migration;
    return yield* migration.dismiss;
  }),
});

export const startT3DesktopMigration = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.START_T3_DESKTOP_MIGRATION_CHANNEL,
  payload: DesktopT3MigrationStartInputSchema,
  result: DesktopT3MigrationStartResultSchema,
  handler: Effect.fn("desktop.ipc.t3Migration.start")(function* (input) {
    const migration = yield* DesktopT3Migration.DesktopT3Migration;
    const result = yield* migration.start(input);
    if (result.status === "completed") yield* scheduleRelaunch();
    return result;
  }),
});
