import type { TurnFailureReason } from "@t3tools/contracts";
import { turnFailureHeadline } from "@t3tools/client-runtime/turn-failure";
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";

/**
 * Why the latest turn failed, above the composer. It goes away on its own when
 * the next turn starts, because a running turn carries no failure.
 */
export function TurnFailedNotice(props: { readonly reason: TurnFailureReason }) {
  return (
    <View className="gap-1.5 rounded-[20px] border border-border-subtle bg-card-alt p-4">
      <Text className="font-t3-bold text-2xs uppercase tracking-[1.1px] text-danger-foreground">
        {turnFailureHeadline(props.reason)}
      </Text>
      <Text className="font-sans text-sm leading-normal text-foreground-secondary">
        {props.reason.message}
      </Text>
    </View>
  );
}
