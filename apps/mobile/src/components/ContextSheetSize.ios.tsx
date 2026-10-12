import { requireNativeView } from "expo";
import type { ComponentType } from "react";
import type { ViewProps } from "react-native";
import type { ContextSheetSizeProps } from "./ContextSheetSize";

const NativeContextSheetSize: ComponentType<ViewProps & { readonly contentHeight: number }> =
  requireNativeView("T3NativeControls", "ContextSheetSize");

export function ContextSheetSize(props: ContextSheetSizeProps) {
  return (
    <NativeContextSheetSize
      contentHeight={props.height}
      pointerEvents="none"
      style={{ position: "absolute", width: 0, height: 0 }}
    />
  );
}
