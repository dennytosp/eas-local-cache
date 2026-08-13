import { Card, Chip } from "heroui-native";
import type { JSX, ReactNode } from "react";
import { ScrollView, Text, View } from "react-native";

type BuildCardProps = {
  command: string;
  description: string;
  label: string;
  platform: string;
};

function CommandBlock({ children }: { children: ReactNode }): JSX.Element {
  return (
    <View className="rounded-2xl bg-foreground px-4 py-3">
      <Text selectable className="font-mono text-sm text-background">
        {children}
      </Text>
    </View>
  );
}

function BuildCard({ command, description, label, platform }: BuildCardProps): JSX.Element {
  return (
    <Card className="gap-4">
      <Card.Header className="flex-row items-center justify-between">
        <View className="gap-1">
          <Text selectable className="text-xs font-semibold uppercase tracking-widest text-accent">
            {label}
          </Text>
          <Card.Title>{platform}</Card.Title>
        </View>
        <View className="size-10 items-center justify-center rounded-full bg-accent-soft">
          <Text selectable className="text-base font-semibold text-accent-soft-foreground">
            2×
          </Text>
        </View>
      </Card.Header>
      <Card.Body className="gap-4">
        <Card.Description selectable>{description}</Card.Description>
        <CommandBlock>{command}</CommandBlock>
      </Card.Body>
    </Card>
  );
}

export default function HomeScreen(): JSX.Element {
  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerClassName="gap-6 px-5 pb-12 pt-5"
      contentInsetAdjustmentBehavior="automatic"
    >
      <View className="gap-4">
        <Chip color="success" size="sm" variant="soft" className="self-start">
          <View className="size-1.5 rounded-full bg-success" />
          <Chip.Label>LOCAL PROVIDER LINKED</Chip.Label>
        </Chip>

        <View className="gap-3">
          <Text
            selectable
            className="max-w-xl text-4xl font-semibold leading-tight tracking-tight text-foreground"
          >
            Build once. Reuse locally.
          </Text>
          <Text selectable className="max-w-xl text-base leading-6 text-foreground/60">
            This Expo app is the end-to-end fixture for eas-local-cache. Build the same native
            target twice and let the terminal show the miss-to-hit transition.
          </Text>
        </View>
      </View>

      <Card variant="secondary" className="gap-4">
        <Card.Header>
          <Card.Title>What is wired up</Card.Title>
        </Card.Header>
        <Card.Body className="gap-3">
          <View className="flex-row items-center justify-between gap-4">
            <Card.Description selectable>Provider</Card.Description>
            <Text selectable className="font-mono text-sm font-medium text-foreground">
              eas-local-cache
            </Text>
          </View>
          <View className="h-px bg-divider" />
          <View className="flex-row items-center justify-between gap-4">
            <Card.Description selectable>Storage</Card.Description>
            <Text selectable className="font-mono text-sm font-medium text-foreground">
              .expo/cache
            </Text>
          </View>
          <View className="h-px bg-divider" />
          <View className="flex-row items-center justify-between gap-4">
            <Card.Description selectable>Runtime</Card.Description>
            <Text selectable className="text-sm font-medium text-foreground">
              Expo CLI only
            </Text>
          </View>
        </Card.Body>
      </Card>

      <View className="gap-3">
        <Text selectable className="text-xl font-semibold text-foreground">
          Repeat one command
        </Text>
        <Text selectable className="text-sm leading-5 text-foreground/60">
          The first run builds and stores the artifact. The unchanged second run should restore it.
        </Text>
      </View>

      <BuildCard
        command="bun run ios"
        description="Use an iOS Simulator. Expo intentionally skips cache providers for physical iOS devices."
        label="Simulator"
        platform="iOS"
      />

      <BuildCard
        command="bun run android"
        description="Start an Android emulator, then run this command twice without changing native inputs."
        label="Emulator"
        platform="Android"
      />

      <Card variant="tertiary" className="gap-3">
        <Card.Header>
          <Chip color="accent" size="sm" variant="secondary">
            TERMINAL IS THE SOURCE OF TRUTH
          </Chip>
        </Card.Header>
        <Card.Body className="gap-2">
          <Card.Title>Look for the transition</Card.Title>
          <Card.Description selectable>
            Run one prints “Cache miss” and stores the build. Run two prints “Cache hit” and uses
            the custom binary path instead of compiling another native artifact.
          </Card.Description>
        </Card.Body>
      </Card>
    </ScrollView>
  );
}
