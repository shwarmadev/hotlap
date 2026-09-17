import {
  defaultInstanceIdForDriver,
  MessageId,
  ProviderDriverKind,
  TurnId,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProviderSessionRuntime from "../../persistence/ProviderSessionRuntime.ts";
import { ProviderSessionDirectoryPersistenceError, ProviderValidationError } from "../Errors.ts";
import {
  ProviderSessionDirectory,
  type ProviderRuntimeBinding,
  type ProviderRuntimeBindingWithMetadata,
  type ProviderSessionDirectoryShape,
  type ProviderSessionDirectoryUpsertOptions,
} from "../Services/ProviderSessionDirectory.ts";
const decodeProviderDriverKindValue = Schema.decodeUnknownEffect(ProviderDriverKind);

function toPersistenceError(operation: string) {
  return (cause: unknown) =>
    new ProviderSessionDirectoryPersistenceError({
      operation,
      detail: `Failed to execute ${operation}.`,
      cause,
    });
}

function decodeProviderDriverKind(
  providerName: string,
  operation: string,
): Effect.Effect<ProviderDriverKind, ProviderSessionDirectoryPersistenceError> {
  return decodeProviderDriverKindValue(providerName).pipe(
    Effect.mapError(
      (cause) =>
        new ProviderSessionDirectoryPersistenceError({
          operation,
          detail: `Unknown persisted provider '${providerName}'.`,
          cause,
        }),
    ),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mergeRuntimePayload(
  existing: unknown | null,
  next: unknown | null | undefined,
): unknown | null {
  if (next === undefined) {
    return existing ?? null;
  }
  if (isRecord(existing) && isRecord(next)) {
    return { ...existing, ...next };
  }
  return next;
}

/**
 * Add or remove one message from the sends dispatched to a provider but not yet
 * admitted. Each send owns only its own entry, so overlapping sends keep theirs.
 */
export function withDispatchingMessage(
  runtimePayload: Record<string, unknown>,
  messageId: MessageId,
  dispatching: boolean,
): Record<string, unknown> {
  const current = runtimePayload.dispatchingMessageIds;
  const others = (Array.isArray(current) ? current : []).filter((id) => id !== messageId);
  return {
    ...runtimePayload,
    dispatchingMessageIds: dispatching ? [...others, messageId] : others,
  };
}

/**
 * Read what the runtime payload proves about one message. A confirmed admission
 * wins over a dispatch marker; `turnId: null` means it may have been sent.
 */
export function readPersistedTurnAdmission(
  runtimePayload: unknown,
  messageId: MessageId,
): { readonly turnId: TurnId | null; readonly active: boolean } | null {
  if (!isRecord(runtimePayload)) return null;
  const turnId = runtimePayload.lastAdmittedTurnId;
  if (runtimePayload.lastAdmittedMessageId === messageId && typeof turnId === "string") {
    return { turnId: TurnId.make(turnId), active: runtimePayload.activeTurnId === turnId };
  }
  const dispatching = runtimePayload.dispatchingMessageIds;
  return Array.isArray(dispatching) && dispatching.includes(messageId)
    ? { turnId: null, active: false }
    : null;
}

function toRuntimeBinding(
  runtime: ProviderSessionRuntime.ProviderSessionRuntime,
  operation: string,
): Effect.Effect<ProviderRuntimeBindingWithMetadata, ProviderSessionDirectoryPersistenceError> {
  return decodeProviderDriverKind(runtime.providerName, operation).pipe(
    Effect.map(
      (provider) =>
        ({
          threadId: runtime.threadId,
          provider,
          // Migration boundary only: rows written before the instance split
          // have a null provider_instance_id. Promote them as they leave
          // persistence so hot routing code never has to infer an instance
          // from a driver kind.
          providerInstanceId: runtime.providerInstanceId ?? defaultInstanceIdForDriver(provider),
          adapterKey: runtime.adapterKey,
          runtimeMode: runtime.runtimeMode,
          status: runtime.status,
          resumeCursor: runtime.resumeCursor,
          runtimePayload: runtime.runtimePayload,
          lastSeenAt: runtime.lastSeenAt,
        }) satisfies ProviderRuntimeBindingWithMetadata,
    ),
  );
}

const makeProviderSessionDirectory = Effect.gen(function* () {
  const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;

  const getBinding = (threadId: ThreadId) =>
    repository.getByThreadId({ threadId }).pipe(
      Effect.mapError(toPersistenceError("ProviderSessionDirectory.getBinding:getByThreadId")),
      Effect.flatMap((runtime) =>
        Option.match(runtime, {
          onNone: () => Effect.succeed(Option.none<ProviderRuntimeBinding>()),
          onSome: (value) =>
            toRuntimeBinding(value, "ProviderSessionDirectory.getBinding").pipe(
              Effect.map((binding) => Option.some(binding)),
            ),
        }),
      ),
    );

  const writeBinding = Effect.fn(function* (
    binding: ProviderRuntimeBinding,
    options: ProviderSessionDirectoryUpsertOptions | undefined,
  ) {
    const existing = yield* repository
      .getByThreadId({ threadId: binding.threadId })
      .pipe(Effect.mapError(toPersistenceError("ProviderSessionDirectory.upsert:getByThreadId")));

    const existingRuntime = Option.getOrUndefined(existing);
    const resolvedThreadId = binding.threadId ?? existingRuntime?.threadId;
    if (!resolvedThreadId) {
      return yield* new ProviderValidationError({
        operation: "ProviderSessionDirectory.upsert",
        issue: "threadId must be a non-empty string.",
      });
    }

    const now = DateTime.formatIso(yield* DateTime.now);
    const providerChanged =
      existingRuntime !== undefined && existingRuntime.providerName !== binding.provider;
    const providerInstanceId =
      binding.providerInstanceId ?? (!providerChanged ? existingRuntime?.providerInstanceId : null);
    if (providerInstanceId === null || providerInstanceId === undefined) {
      return yield* new ProviderValidationError({
        operation: "ProviderSessionDirectory.upsert",
        issue: "providerInstanceId is required for provider session runtime bindings.",
      });
    }
    const runtimePayload = mergeRuntimePayload(
      existingRuntime?.runtimePayload ?? null,
      binding.runtimePayload,
    );
    yield* repository
      .upsert(
        {
          threadId: resolvedThreadId,
          providerName: binding.provider,
          providerInstanceId,
          adapterKey:
            binding.adapterKey ??
            (providerChanged
              ? binding.provider
              : (existingRuntime?.adapterKey ?? binding.provider)),
          runtimeMode: binding.runtimeMode ?? existingRuntime?.runtimeMode ?? "full-access",
          status: binding.status ?? existingRuntime?.status ?? "running",
          lastSeenAt: now,
          resumeCursor:
            binding.resumeCursor !== undefined
              ? binding.resumeCursor
              : (existingRuntime?.resumeCursor ?? null),
          runtimePayload:
            options?.updateRuntimePayload === undefined
              ? runtimePayload
              : options.updateRuntimePayload(isRecord(runtimePayload) ? runtimePayload : {}),
        },
        options,
      )
      .pipe(Effect.mapError(toPersistenceError("ProviderSessionDirectory.upsert:upsert")));
  });

  // Writers merge into the row they read, so a write landing in between would be
  // lost. Ignoring inserts never merge into an existing row and need no lock.
  const upsert: ProviderSessionDirectoryShape["upsert"] = (binding, options) =>
    options?.onConflict === "ignore"
      ? writeBinding(binding, options)
      : repository
          .withWriteTransaction(writeBinding(binding, options))
          .pipe(
            Effect.catchTag("PersistenceSqlError", (cause) =>
              Effect.fail(toPersistenceError("ProviderSessionDirectory.upsert:transaction")(cause)),
            ),
          );

  const getProvider: ProviderSessionDirectoryShape["getProvider"] = (threadId) =>
    getBinding(threadId).pipe(
      Effect.flatMap((binding) =>
        Option.match(binding, {
          onSome: (value) => Effect.succeed(value.provider),
          onNone: () =>
            Effect.fail(
              new ProviderSessionDirectoryPersistenceError({
                operation: "ProviderSessionDirectory.getProvider",
                detail: `No persisted provider binding found for thread '${threadId}'.`,
              }),
            ),
        }),
      ),
    );

  const clearActiveTurnIfMatches: ProviderSessionDirectoryShape["clearActiveTurnIfMatches"] = (
    input,
  ) =>
    Effect.gen(function* () {
      return yield* repository.clearActiveTurnIfMatches({
        ...input,
        clearedAt: DateTime.formatIso(yield* DateTime.now),
      });
    }).pipe(
      Effect.mapError(toPersistenceError("ProviderSessionDirectory.clearActiveTurnIfMatches")),
    );

  const clearTurnAdmissionIfMatches: ProviderSessionDirectoryShape["clearTurnAdmissionIfMatches"] =
    (input) =>
      Effect.gen(function* () {
        return yield* repository.clearTurnAdmissionIfMatches({
          ...input,
          clearedAt: DateTime.formatIso(yield* DateTime.now),
        });
      }).pipe(
        Effect.mapError(toPersistenceError("ProviderSessionDirectory.clearTurnAdmissionIfMatches")),
      );

  const recordImportedTranscript: ProviderSessionDirectoryShape["recordImportedTranscript"] = (
    input,
  ) =>
    repository
      .recordImportedTranscript(input)
      .pipe(
        Effect.mapError(toPersistenceError("ProviderSessionDirectory.recordImportedTranscript")),
      );

  const listThreadIds: ProviderSessionDirectoryShape["listThreadIds"] = () =>
    repository.list().pipe(
      Effect.mapError(toPersistenceError("ProviderSessionDirectory.listThreadIds:list")),
      Effect.map((rows) => rows.map((row) => row.threadId)),
    );

  const listBindings: ProviderSessionDirectoryShape["listBindings"] = () =>
    repository.list().pipe(
      Effect.mapError(toPersistenceError("ProviderSessionDirectory.listBindings:list")),
      Effect.flatMap((rows) =>
        Effect.forEach(
          rows,
          (row) => toRuntimeBinding(row, "ProviderSessionDirectory.listBindings"),
          { concurrency: "unbounded" },
        ),
      ),
    );

  return {
    upsert,
    recordImportedTranscript,
    getProvider,
    getBinding,
    clearActiveTurnIfMatches,
    clearTurnAdmissionIfMatches,
    listThreadIds,
    listBindings,
  } satisfies ProviderSessionDirectoryShape;
});

export const ProviderSessionDirectoryLive = Layer.effect(
  ProviderSessionDirectory,
  makeProviderSessionDirectory,
);
