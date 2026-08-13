import { Stack } from "expo-router";
import { HeroUINativeProvider } from "heroui-native";
import type { JSX } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";

import "../global.css";

export default function RootLayout(): JSX.Element {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <HeroUINativeProvider>
        <Stack
          screenOptions={{
            headerLargeTitle: true,
            headerShadowVisible: false,
            headerTitle: "EAS Local Cache",
          }}
        />
      </HeroUINativeProvider>
    </GestureHandlerRootView>
  );
}
