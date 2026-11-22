import Constants from "expo-constants";
import { Platform } from "react-native";
import { supportsAndroidAgentNotifications } from "./androidNotifications";

export type AgentAwarenessPushMode = "relay" | "direct" | "none";

export function agentAwarenessPushMode(): AgentAwarenessPushMode {
  const extra = Constants.expoConfig?.extra;
  const mode = extra?.push?.mode;
  if (mode === "relay" || mode === "direct" || mode === "none") {
    return mode;
  }
  return extra?.iosPersonalTeamBuild === true ? "none" : "relay";
}

export function supportsDirectPush(): boolean {
  return Platform.OS === "ios" && agentAwarenessPushMode() === "direct";
}

export function supportsAgentAwarenessPush() {
  return Platform.OS === "android"
    ? supportsAndroidAgentNotifications()
    : Platform.OS === "ios" && agentAwarenessPushMode() === "relay";
}
