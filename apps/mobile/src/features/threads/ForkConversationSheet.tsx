import {
  normalizeProviderAccentColor,
  resolveProviderInstanceDisplayName,
  shouldShowInstanceBadge,
} from "@t3tools/client-runtime/state/provider-instance-display";
import type { ModelSelection, ServerConfig } from "@t3tools/contracts";
import { LegendList, type LegendListRenderItemProps } from "@legendapp/list/react-native";
import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { ContextSheetSize } from "../../components/ContextSheetSize";
import { ProviderInstanceIcon } from "../../components/ProviderIcon";
import { cn } from "../../lib/cn";
import { groupByProvider, type ModelOption } from "../../lib/modelOptions";
import type { ForkModelPickerState } from "./fork-model-picker-state";

type ForkCatalogItem =
  | {
      readonly kind: "provider";
      readonly key: string;
      readonly providerKey: string;
      readonly providerLabel: string;
      readonly isFirst: boolean;
    }
  | {
      readonly kind: "model";
      readonly key: string;
      readonly option: ModelOption;
      readonly isFirst: boolean;
    };

function modelKey(selection: ModelSelection): string {
  return `${selection.instanceId}:${selection.model}`;
}

export function ForkConversationSheet(props: {
  readonly supportsModelSelection?: boolean;
  readonly state: ForkModelPickerState;
  readonly serverConfig: ServerConfig;
  readonly options: ReadonlyArray<ModelOption>;
  readonly onCancel: () => void;
  readonly onSelectModel: (selection: ModelSelection) => void;
  readonly onConfirm: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [contentHeight, setContentHeight] = useState(0);
  const groups = useMemo(() => groupByProvider(props.options), [props.options]);
  const catalogItems = useMemo<ReadonlyArray<ForkCatalogItem>>(
    () =>
      groups.flatMap((group, groupIndex) => [
        {
          kind: "provider" as const,
          key: `provider:${group.providerKey}`,
          providerKey: group.providerKey,
          providerLabel: group.providerLabel,
          isFirst: groupIndex === 0,
        },
        ...group.models.map((option, optionIndex) => ({
          kind: "model" as const,
          key: `model:${option.key}`,
          option,
          isFirst: optionIndex === 0,
        })),
      ]),
    [groups],
  );
  const catalogHeight = Math.min(
    288,
    catalogItems.reduce((height, item) => height + (item.kind === "provider" ? 40 : 48), 0),
  );
  const selectedKey = modelKey(props.state.selectedModel);
  const selectedOption = props.options.find((option) => option.key === selectedKey) ?? null;
  const selectedProvider = props.serverConfig.providers.find(
    (provider) => provider.instanceId === props.state.selectedModel.instanceId,
  );
  const providerEntries = props.serverConfig.providers.map((provider) => ({
    driverKind: provider.driver,
  }));
  const providerIcon = (providerKey: string, surfaceColor: string, size = 20) => {
    const provider = props.serverConfig.providers.find(
      (candidate) => candidate.instanceId === providerKey,
    );
    if (!provider) {
      const fallback = props.options.find((option) => option.providerKey === providerKey);
      return fallback ? (
        <ProviderInstanceIcon
          provider={fallback.providerDriver}
          displayName={fallback.providerLabel}
          size={size}
          surfaceColor={surfaceColor}
        />
      ) : null;
    }
    const accentColor = normalizeProviderAccentColor(provider.accentColor);
    return (
      <ProviderInstanceIcon
        provider={provider.driver}
        displayName={resolveProviderInstanceDisplayName(provider)}
        accentColor={accentColor}
        showBadge={shouldShowInstanceBadge(
          { driverKind: provider.driver, accentColor },
          providerEntries,
        )}
        size={size}
        surfaceColor={surfaceColor}
      />
    );
  };
  const selectedProviderName = selectedProvider
    ? resolveProviderInstanceDisplayName(selectedProvider)
    : (selectedOption?.providerLabel ?? String(props.state.selectedModel.instanceId));
  const selectedModelName = selectedOption?.label ?? props.state.selectedModel.model;
  const selectionUnavailable =
    props.supportsModelSelection !== false &&
    (selectedOption === null || selectedOption.isUnavailable === true);
  const submitting = props.state.status === "submitting";

  return (
    <Modal
      animationType="slide"
      presentationStyle={Platform.OS === "android" ? "overFullScreen" : "pageSheet"}
      transparent={Platform.OS === "android"}
      allowSwipeDismissal={!submitting}
      onRequestClose={submitting ? undefined : props.onCancel}
    >
      <View
        className="flex-1 justify-end"
        style={{ backgroundColor: Platform.OS === "android" ? "#00000066" : undefined }}
      >
        {Platform.OS === "android" && !submitting ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Cancel fork conversation"
            className="absolute inset-0"
            onPress={props.onCancel}
          />
        ) : null}
        <View
          className="overflow-hidden rounded-t-3xl bg-sheet-solid"
          style={{ maxHeight: windowHeight - insets.top - 24 }}
          onLayout={(event) => setContentHeight(event.nativeEvent.layout.height)}
        >
          <ContextSheetSize height={contentHeight} />
          <View className="gap-1 border-b border-border px-5 pb-4 pt-5">
            <Text className="text-lg font-t3-bold text-foreground">Fork conversation</Text>
            <Text className="text-sm leading-5 text-foreground-muted">
              Choose how the new conversation should continue.
            </Text>
          </View>

          <ScrollView
            style={{ flexShrink: 1 }}
            contentContainerClassName="gap-4 px-5 py-4"
            keyboardShouldPersistTaps="handled"
          >
            <View className="gap-2">
              <Text className="text-xs font-t3-bold text-foreground-muted">Provider and model</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Provider and model: ${selectedProviderName}, ${selectedModelName}`}
                accessibilityState={{ expanded: catalogOpen }}
                disabled={submitting || props.supportsModelSelection === false}
                className="min-h-14 flex-row items-center gap-3 rounded-2xl border border-border bg-card px-4 py-3 active:bg-subtle"
                onPress={() => setCatalogOpen((open) => !open)}
              >
                {providerIcon(String(props.state.selectedModel.instanceId), "transparent", 22)}
                <View className="min-w-0 flex-1">
                  <Text className="text-sm font-t3-semibold text-foreground" numberOfLines={1}>
                    {selectedProviderName} · {selectedModelName}
                  </Text>
                  {selectionUnavailable ? (
                    <Text className="text-xs text-foreground-muted">Unavailable</Text>
                  ) : selectedOption?.subtitle ? (
                    <Text className="text-xs text-foreground-muted" numberOfLines={1}>
                      {selectedOption.subtitle}
                    </Text>
                  ) : null}
                </View>
                <SymbolView
                  name={catalogOpen ? "chevron.up" : "chevron.down"}
                  size={14}
                  tintColorClassName="accent-icon-subtle"
                />
              </Pressable>

              {catalogOpen ? (
                <View
                  className="overflow-hidden rounded-2xl border border-border bg-card"
                  style={{ height: catalogHeight }}
                >
                  <LegendList
                    data={catalogItems}
                    estimatedItemSize={48}
                    extraData={`${selectedKey}:${submitting}`}
                    getItemType={(item) => item.kind}
                    keyExtractor={(item) => item.key}
                    keyboardShouldPersistTaps="handled"
                    nestedScrollEnabled
                    recycleItems
                    renderItem={(itemProps: LegendListRenderItemProps<ForkCatalogItem>) => {
                      const item = itemProps.item;
                      if (item.kind === "provider") {
                        const provider = props.serverConfig.providers.find(
                          (candidate) => candidate.instanceId === item.providerKey,
                        );
                        const providerName = provider
                          ? resolveProviderInstanceDisplayName(provider)
                          : item.providerLabel;
                        return (
                          <View
                            className={cn(
                              "min-h-10 flex-row items-center gap-2 bg-subtle px-4 py-2",
                              !item.isFirst && "border-t border-border",
                            )}
                          >
                            {providerIcon(item.providerKey, "transparent", 16)}
                            <Text className="text-xs font-t3-bold text-foreground-muted">
                              {providerName}
                            </Text>
                          </View>
                        );
                      }

                      const option = item.option;
                      const selected = option.key === selectedKey;
                      return (
                        <Pressable
                          accessibilityRole="radio"
                          accessibilityLabel={[option.label, option.subtitle]
                            .filter(Boolean)
                            .join(", ")}
                          accessibilityState={{
                            checked: selected,
                            disabled: option.isUnavailable === true,
                          }}
                          disabled={option.isUnavailable === true || submitting}
                          className={cn(
                            "min-h-12 flex-row items-center gap-3 px-4 py-2 active:bg-subtle",
                            !item.isFirst && "border-t border-border-subtle",
                            option.isUnavailable && "opacity-60",
                          )}
                          onPress={() => {
                            props.onSelectModel(option.selection);
                            setCatalogOpen(false);
                          }}
                        >
                          <View className="min-w-0 flex-1">
                            <Text
                              className="text-sm font-t3-medium text-foreground"
                              numberOfLines={1}
                            >
                              {option.label}
                            </Text>
                            {option.isUnavailable ? (
                              <Text className="text-xs text-foreground-muted">Unavailable</Text>
                            ) : option.subtitle ? (
                              <Text className="text-xs text-foreground-muted" numberOfLines={1}>
                                {option.subtitle}
                              </Text>
                            ) : null}
                          </View>
                          {selected ? (
                            <SymbolView
                              name="checkmark"
                              size={16}
                              tintColorClassName="accent-icon"
                              weight="semibold"
                            />
                          ) : null}
                        </Pressable>
                      );
                    }}
                    showsVerticalScrollIndicator={false}
                  />
                </View>
              ) : null}
            </View>

            <View className="flex-row items-start gap-3">
              <SymbolView
                name="arrow.triangle.branch"
                size={15}
                tintColorClassName="accent-icon-subtle"
              />
              <Text className="min-w-0 flex-1 text-xs leading-5 text-foreground-muted">
                Recent history through the selected response is included. Older history stays in the
                source thread. Files stay in the current workspace.
              </Text>
            </View>

            {props.state.error ? (
              <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
                {props.state.error}
              </Text>
            ) : null}
          </ScrollView>

          <View
            className="flex-row justify-end gap-2 border-t border-border px-5 pt-3"
            style={{ paddingBottom: Math.max(insets.bottom, 12) }}
          >
            <Pressable
              accessibilityRole="button"
              disabled={submitting}
              className="min-h-11 items-center justify-center rounded-xl border border-border px-5 active:bg-subtle disabled:opacity-50"
              onPress={props.onCancel}
            >
              <Text className="font-t3-semibold text-foreground">Cancel</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: submitting || selectionUnavailable }}
              disabled={submitting || selectionUnavailable}
              className="min-h-11 min-w-36 flex-row items-center justify-center gap-2 rounded-xl bg-primary px-5 active:opacity-80 disabled:opacity-50"
              onPress={props.onConfirm}
            >
              {submitting ? (
                <ActivityIndicator
                  size="small"
                  colorClassName={String("accent-primary-foreground")}
                />
              ) : null}
              <Text className="font-t3-semibold text-primary-foreground">Fork conversation</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}
