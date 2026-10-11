import {
  ANTIGRAVITY_DEFAULT_MODEL,
  type EnvironmentId,
  type MessageId,
  type ModelSelection,
  type ServerConfig,
  type ThreadId,
} from "@t3tools/contracts";

import { buildModelOptions, type ModelOption } from "../../lib/modelOptions";

export type ForkModelPickerState = {
  readonly source: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
  };
  readonly selectedModel: ModelSelection;
  readonly status: "idle" | "submitting";
  readonly error: string | null;
};

function snapshotModelSelection(selection: ModelSelection): ModelSelection {
  return {
    instanceId: selection.instanceId,
    model: selection.model,
    ...(selection.options ? { options: selection.options.map((option) => ({ ...option })) } : {}),
  };
}

export function openForkModelPicker(input: {
  readonly environmentId: EnvironmentId;
  readonly sourceThreadId: ThreadId;
  readonly sourceMessageId: MessageId;
  readonly modelSelection: ModelSelection;
}): ForkModelPickerState {
  return {
    source: {
      environmentId: input.environmentId,
      threadId: input.sourceThreadId,
      messageId: input.sourceMessageId,
    },
    selectedModel: snapshotModelSelection(input.modelSelection),
    status: "idle",
    error: null,
  };
}

export function buildForkModelOptions(
  config: ServerConfig,
  inheritedSelection: ModelSelection,
): ReadonlyArray<ModelOption> {
  const inheritedProvider = config.providers.find(
    (provider) => provider.instanceId === inheritedSelection.instanceId,
  );
  const inheritedCatalogModel =
    inheritedProvider?.driver === "antigravity" &&
    inheritedSelection.model === ANTIGRAVITY_DEFAULT_MODEL
      ? (inheritedProvider.models.find((model) =>
          model.aliases?.includes(ANTIGRAVITY_DEFAULT_MODEL),
        ) ?? inheritedProvider.models.find((model) => model.isDefault === true))
      : undefined;
  const catalogSelection = inheritedCatalogModel
    ? { ...inheritedSelection, model: inheritedCatalogModel.slug }
    : inheritedSelection;
  const inheritedUsesAlias = catalogSelection.model !== inheritedSelection.model;
  const runnableModelKeys = new Set(
    config.providers.flatMap((provider) =>
      provider.enabled &&
      provider.installed &&
      provider.status === "ready" &&
      provider.auth.status !== "unauthenticated" &&
      provider.availability !== "unavailable"
        ? provider.models.map((model) => `${provider.instanceId}:${model.slug}`)
        : [],
    ),
  );
  return buildModelOptions(config, catalogSelection, undefined, null).flatMap((option) => {
    const isInherited =
      option.selection.instanceId === catalogSelection.instanceId &&
      option.selection.model === catalogSelection.model;
    const runnable = runnableModelKeys.has(option.key);
    if (!runnable && !isInherited) return [];
    const resolvedOption =
      inheritedUsesAlias && isInherited
        ? {
            ...option,
            key: `${inheritedSelection.instanceId}:${inheritedSelection.model}`,
            selection: inheritedSelection,
          }
        : option;
    return [{ ...resolvedOption, ...(runnable ? {} : { isUnavailable: true }) }];
  });
}

export function canConfirmForkModelSelection(
  selection: ModelSelection,
  options: ReadonlyArray<ModelOption>,
): boolean {
  return options.some(
    (option) =>
      option.selection.instanceId === selection.instanceId &&
      option.selection.model === selection.model &&
      option.isUnavailable !== true,
  );
}

export function forkModelPickerShouldClose(
  state: ForkModelPickerState,
  current: {
    readonly connected: boolean;
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly sourceMessageAvailable: boolean;
  },
): boolean {
  return (
    !current.connected ||
    current.environmentId !== state.source.environmentId ||
    current.threadId !== state.source.threadId ||
    !current.sourceMessageAvailable
  );
}

export function buildForkCommandInput(
  state: ForkModelPickerState,
  destinationThreadId: ThreadId,
  createdAt: string,
) {
  return {
    threadId: destinationThreadId,
    sourceThreadId: state.source.threadId,
    sourceMessageId: state.source.messageId,
    modelSelection: state.selectedModel,
    createdAt,
  };
}
