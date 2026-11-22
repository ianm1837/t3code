import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  settleAsyncResult,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as Effect from "effect/Effect";
import { AsyncResult } from "effect/reactivity";
import * as Notifications from "expo-notifications";
import { useGT } from "gt-react-native";
import { useState, useSyncExternalStore } from "react";
import { Linking } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import * as Dialog from "../../components/ui/Dialog";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { m as resolveMessage } from "../../i18n/messages";
import { makePermissionStatusAtom } from "../../lib/permissionStatusAtom";
import { mobilePreferencesAtom } from "../../state/preferences";
import {
  connectedEnvironmentIdsAtom,
  useSavedRemoteConnections,
} from "../../state/use-remote-environment-registry";
import {
  directPushAlerts,
  getDirectPushStatus,
  setDirectPushAlert,
  setDirectPushEnabled,
  subscribeDirectPushStatus,
  type DirectPushAlertKind,
  type DirectPushEnvironmentStatus,
} from "../agent-awareness/directPushRegistration";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";

type PermissionStatus = "checking" | "granted" | "denied";

const permissionStatusAtom = makePermissionStatusAtom<PermissionStatus>({
  label: "mobile:direct-push-permission",
  initial: "checking",
  read: async () => {
    const result = await settlePromise(() => Notifications.getPermissionsAsync());
    return result._tag === "Success" && result.value.granted ? "granted" : "denied";
  },
});

export function DirectPushNotificationsScreen() {
  const gt = useGT();
  const insets = useSafeAreaInsets();
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const permission = useAtomValue(permissionStatusAtom);
  const setPermission = useAtomSet(permissionStatusAtom);
  const connectedEnvironmentIds = useAtomValue(connectedEnvironmentIdsAtom);
  const { savedConnectionsById } = useSavedRemoteConnections();
  const statuses = useSyncExternalStore(
    subscribeDirectPushStatus,
    getDirectPushStatus,
    getDirectPushStatus,
  );
  const [saving, setSaving] = useState(false);
  const enabled =
    AsyncResult.isSuccess(preferencesResult) && preferencesResult.value.directPushEnabled === true;
  const alerts = AsyncResult.isSuccess(preferencesResult)
    ? directPushAlerts(preferencesResult.value)
    : null;
  const connections = Object.values(savedConnectionsById);
  const alertRows = [
    { kind: "notifyOnCompletion", icon: "checkmark.circle", label: gt("Finished") },
    { kind: "notifyOnFailure", icon: "exclamationmark.circle", label: gt("Failed") },
    { kind: "notifyOnApproval", icon: "exclamationmark.shield", label: gt("Needs approval") },
    { kind: "notifyOnInput", icon: "questionmark.bubble", label: gt("Needs input") },
  ] as const;

  const handleAlertChange = async ({
    kind,
    enabled: next,
  }: {
    readonly kind: DirectPushAlertKind;
    readonly enabled: boolean;
  }) => {
    const result = await settleAsyncResult(() =>
      Effect.runPromiseExit(setDirectPushAlert({ kind, enabled: next })),
    );
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      Dialog.alert(gt("Notifications unavailable"), gt("Could not update notifications."));
    }
  };

  const statusLabel = (environmentId: EnvironmentId) => {
    if (!connectedEnvironmentIds.includes(environmentId)) return gt("Not connected");
    const status: DirectPushEnvironmentStatus = statuses.get(environmentId) ?? "registering";
    switch (status) {
      case "ready":
        return gt("Ready");
      case "no-server-key":
        return gt("Server has no APNs key");
      case "failed":
        return gt("Couldn't register");
      case "unavailable":
        return gt("Not allowed on this connection");
      case "registering":
        return gt("Registering");
    }
  };

  const handleChange = async (next: boolean) => {
    setSaving(true);
    const result = await settleAsyncResult(() =>
      Effect.runPromiseExit(setDirectPushEnabled({ enabled: next })),
    );
    setSaving(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        Dialog.alert(
          gt("Notifications unavailable"),
          error instanceof Error
            ? (errorDisplayMessage(error, resolveMessage) ?? error.message)
            : gt("Could not update notifications."),
        );
      }
      return;
    }
    if (!next) return;
    const outcome = result.value;
    if (outcome.type === "granted") {
      setPermission("granted");
      return;
    }
    if (outcome.type === "unsupported") {
      Dialog.alert(
        gt("Notifications unavailable"),
        gt("Agent notifications are unavailable on this platform."),
      );
      return;
    }
    setPermission("denied");
    if (outcome.canAskAgain) {
      Dialog.alert(gt("Notifications disabled"), gt("Notifications were not enabled."));
      return;
    }
    Dialog.alert(
      gt("Notifications disabled"),
      gt("Notifications were denied for this app. Open Settings to enable them."),
      [
        { text: gt("Cancel"), style: "cancel" },
        { text: gt("Open Settings"), onPress: () => void Linking.openSettings() },
      ],
    );
  };

  return (
    <SettingsScreen title={gt("Notifications")}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 18) + 18,
        }}
      >
        <SettingsSection
          title={gt("Agent activity")}
          footer={gt(
            "Your environments send alerts straight to this device. Each one needs an APNs key installed with {command}.",
            { command: "t3 push key set" },
          )}
        >
          <SettingsSwitchRow
            icon="bell.badge"
            label={gt("Device Notifications")}
            disabled={
              saving || permission === "checking" || !AsyncResult.isSuccess(preferencesResult)
            }
            value={enabled && permission === "granted"}
            onValueChange={(next) => void handleChange(next)}
          />
        </SettingsSection>
        {enabled && permission === "granted" && alerts !== null ? (
          <SettingsSection
            title={gt("Alerts")}
            footer={gt("Your environments send this device only the alerts turned on here.")}
          >
            {alertRows.map((row) => (
              <SettingsSwitchRow
                key={row.kind}
                icon={row.icon}
                label={row.label}
                value={alerts[row.kind]}
                onValueChange={(next) => void handleAlertChange({ kind: row.kind, enabled: next })}
              />
            ))}
          </SettingsSection>
        ) : null}
        {enabled && permission === "granted" && connections.length > 0 ? (
          <SettingsSection title={gt("Environments")}>
            {connections.map((connection) => (
              <SettingsRow
                key={connection.environmentId}
                icon="server.rack"
                label={connection.environmentLabel}
                value={statusLabel(connection.environmentId)}
              />
            ))}
          </SettingsSection>
        ) : null}
      </ScrollView>
    </SettingsScreen>
  );
}
