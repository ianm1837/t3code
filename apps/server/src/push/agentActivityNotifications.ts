import type {
  RelayAgentActivityAggregateRow,
  RelayAgentActivityState,
  RelayAgentAwarenessPhase,
  RelayAgentAwarenessPreferences,
} from "@t3tools/contracts/relay";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const TERMINAL_NOTIFICATION_FRESHNESS_MS = 2 * 60 * 1_000;
const RUNNING_AGENT_ACTIVITY_ROW_TTL_MS = 2 * 60 * 60 * 1_000;
const WAITING_AGENT_ACTIVITY_ROW_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_SUMMARY_TEXT_LENGTH = 120;
const MAX_STATUS_TEXT_LENGTH = 40;
const MAX_DEEP_LINK_LENGTH = 512;
const PERMANENT_APNS_TOKEN_REASONS: ReadonlySet<string> = new Set([
  "BadDeviceToken",
  "DeviceTokenNotForTopic",
  "Unregistered",
]);

export interface AgentActivityNotification {
  readonly title: string;
  readonly body: string;
  readonly environmentId: string;
  readonly threadId: string;
  readonly deepLink: string;
  readonly phase?: RelayAgentAwarenessPhase;
  readonly updatedAt?: string;
}

function isFreshTerminalNotification(input: {
  readonly updatedAt: string;
  readonly nowMs: number;
}): boolean {
  const timestamp = Option.getOrNull(DateTime.make(input.updatedAt));
  return (
    timestamp !== null &&
    input.nowMs - timestamp.epochMilliseconds <= TERMINAL_NOTIFICATION_FRESHNESS_MS
  );
}

function alertAllowedForPhase(input: {
  readonly preferences: RelayAgentAwarenessPreferences | null;
  readonly phase: string;
}): boolean {
  if (input.preferences === null) return true;
  switch (input.phase) {
    case "waiting_for_approval":
      return input.preferences.notifyOnApproval;
    case "waiting_for_input":
      return input.preferences.notifyOnInput;
    case "completed":
      return input.preferences.notifyOnCompletion;
    case "failed":
      return input.preferences.notifyOnFailure;
    default:
      return false;
  }
}

export function shouldAlertForActivity(input: {
  readonly phase: RelayAgentAwarenessPhase;
  readonly updatedAt: string;
  readonly preferences: RelayAgentAwarenessPreferences | null;
  readonly nowMs: number;
}): boolean {
  return (
    input.preferences?.notificationsEnabled === true &&
    alertAllowedForPhase({ preferences: input.preferences, phase: input.phase }) &&
    ((input.phase !== "completed" && input.phase !== "failed") ||
      isFreshTerminalNotification({ updatedAt: input.updatedAt, nowMs: input.nowMs }))
  );
}

function agentActivityExpiresAt(
  state: Pick<RelayAgentActivityState, "phase" | "updatedAt">,
): number {
  const updatedAtMs = Option.match(DateTime.make(state.updatedAt), {
    onNone: () => Number.NaN,
    onSome: (dt) => dt.epochMilliseconds,
  });
  if (Number.isNaN(updatedAtMs)) {
    return Number.NaN;
  }
  const ttlMs =
    state.phase === "running" || state.phase === "starting"
      ? RUNNING_AGENT_ACTIVITY_ROW_TTL_MS
      : WAITING_AGENT_ACTIVITY_ROW_TTL_MS;
  return updatedAtMs + ttlMs;
}

export function isExpiredAgentActivityState(input: {
  readonly state: RelayAgentActivityState;
  readonly nowMs: number;
}): boolean {
  const expiresAt = agentActivityExpiresAt(input.state);
  return !Number.isFinite(expiresAt) || input.nowMs > expiresAt;
}

export function statusForPhase(phase: RelayAgentAwarenessPhase): string {
  switch (phase) {
    case "waiting_for_approval":
      return "Approval";
    case "waiting_for_input":
      return "Input";
    case "completed":
      return "Done";
    case "failed":
      return "Failed";
    case "starting":
      return "Connecting";
    case "running":
      return "Working";
    case "stale":
      return "Waiting";
  }
}

function truncateText(input: { readonly value: string; readonly maxLength: number }): string {
  const trimmed = input.value.trim();
  if (trimmed.length <= input.maxLength) {
    return trimmed;
  }
  return trimmed.slice(0, input.maxLength - 3).trimEnd() + "...";
}

function sanitizeDeepLink(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) {
    return "/";
  }
  return truncateText({ value: trimmed, maxLength: MAX_DEEP_LINK_LENGTH });
}

function sanitizeAgentActivityAggregateRow(
  row: RelayAgentActivityAggregateRow,
): RelayAgentActivityAggregateRow {
  return {
    ...row,
    projectTitle: truncateText({ value: row.projectTitle, maxLength: MAX_SUMMARY_TEXT_LENGTH }),
    threadTitle: truncateText({ value: row.threadTitle, maxLength: MAX_SUMMARY_TEXT_LENGTH }),
    modelTitle: truncateText({ value: row.modelTitle, maxLength: MAX_SUMMARY_TEXT_LENGTH }),
    status: truncateText({ value: row.status, maxLength: MAX_STATUS_TEXT_LENGTH }),
    deepLink: sanitizeDeepLink(row.deepLink),
  };
}

export function sanitizeApnsNotificationPayload(
  notification: AgentActivityNotification,
): AgentActivityNotification {
  return {
    ...notification,
    title: truncateText({ value: notification.title, maxLength: MAX_SUMMARY_TEXT_LENGTH }),
    body: truncateText({ value: notification.body, maxLength: MAX_SUMMARY_TEXT_LENGTH }),
    deepLink: sanitizeDeepLink(notification.deepLink),
  };
}

export function notificationForActivity(
  row: RelayAgentActivityAggregateRow,
): AgentActivityNotification {
  const activity = sanitizeAgentActivityAggregateRow(row);
  return sanitizeApnsNotificationPayload({
    title: activity.threadTitle,
    body: `${activity.status}: ${activity.projectTitle}`,
    environmentId: activity.environmentId,
    threadId: activity.threadId,
    deepLink: activity.deepLink,
    phase: activity.phase,
    updatedAt: activity.updatedAt,
  });
}

function notificationThreadId(notification: AgentActivityNotification): string {
  return notification.threadId.length > 0
    ? `${notification.environmentId}/${notification.threadId}`
    : "t3-agent-alerts";
}

export function apnsAlertPayload(notification: AgentActivityNotification) {
  return {
    aps: {
      alert: {
        title: notification.title,
        body: notification.body,
      },
      sound: "default",
      "thread-id": notificationThreadId(notification),
    },
    body: {
      environmentId: notification.environmentId,
      threadId: notification.threadId,
      deepLink: notification.deepLink,
    },
  };
}

export function isPermanentApnsTokenFailure(result: {
  readonly ok: boolean;
  readonly status: number;
  readonly reason?: string | undefined;
}): boolean {
  return (
    !result.ok &&
    (result.status === 410 ||
      (result.status === 400 &&
        result.reason !== undefined &&
        PERMANENT_APNS_TOKEN_REASONS.has(result.reason)))
  );
}

const decodeApnsErrorResponseJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      reason: Schema.optional(Schema.String),
    }),
  ),
);

export function apnsReasonFromBody(body: string): string | undefined {
  if (body.trim().length === 0) {
    return undefined;
  }
  return Option.match(decodeApnsErrorResponseJson(body), {
    onNone: () => body,
    onSome: (parsed) => parsed.reason ?? body,
  });
}
