import type {
  RelayAgentActivityState,
  RelayAgentAwarenessPreferences,
} from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as AgentAwarenessRelay from "../relay/AgentAwarenessRelay.ts";
import {
  isExpiredAgentActivityState,
  isPermanentApnsTokenFailure,
  notificationForActivity,
  shouldAlertForActivity,
  statusForPhase,
} from "./agentActivityNotifications.ts";
import {
  APNS_PROVIDER_KEY_SECRET,
  decodeApnsProviderKey,
  type ApnsProviderKey,
} from "./apnsProviderKey.ts";
import * as ApnsSender from "./ApnsSender.ts";
import * as PushDeviceRegistry from "./PushDeviceRegistry.ts";

const DIRECT_PUSH_PREFERENCES: RelayAgentAwarenessPreferences = {
  liveActivitiesEnabled: false,
  notificationsEnabled: true,
  notifyOnApproval: true,
  notifyOnInput: true,
  notifyOnCompletion: true,
  notifyOnFailure: true,
};

export class ApnsDeliveryRetryableError extends Schema.TaggedError<ApnsDeliveryRetryableError>()(
  "ApnsDeliveryRetryableError",
  {
    failedDevices: Schema.Number,
    failures: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return `APNs delivery failed for ${this.failedDevices} device(s) and will be retried.`;
  }
}

export class AgentActivityPush extends Context.Service<
  AgentActivityPush,
  AgentAwarenessRelay.AgentAwarenessRelay["Service"]
>()("t3/push/AgentActivityPush") {}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export const makeApnsSink = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const registry = yield* PushDeviceRegistry.PushDeviceRegistry;
  const sender = yield* ApnsSender.ApnsSender;
  let cachedKey: { readonly raw: string; readonly key: ApnsProviderKey } | undefined;

  const readTarget = Effect.gen(function* () {
    const bytes = yield* secrets.get(APNS_PROVIDER_KEY_SECRET);
    if (Option.isNone(bytes)) return { _tag: "Unlinked" } as const;
    const raw = new TextDecoder().decode(bytes.value);
    if (cachedKey?.raw !== raw) {
      cachedKey = { raw, key: yield* decodeApnsProviderKey(bytes.value) };
    }
    return { _tag: "Ready", target: cachedKey.key } as const;
  });

  const deliver = Effect.fn("AgentActivityPush.deliver")(function* (input: {
    readonly target: ApnsProviderKey;
    readonly state: RelayAgentActivityState | null;
  }) {
    const state = input.state;
    if (state === null) return;
    const nowMs = (yield* DateTime.now).epochMilliseconds;
    if (
      isExpiredAgentActivityState({ state, nowMs }) ||
      !shouldAlertForActivity({
        phase: state.phase,
        updatedAt: state.updatedAt,
        preferences: DIRECT_PUSH_PREFERENCES,
        nowMs,
      })
    ) {
      return;
    }
    const notification = notificationForActivity({ ...state, status: statusForPhase(state.phase) });
    const devices = yield* registry.listDeliverable;
    if (devices.length === 0) return;
    const results = yield* Effect.forEach(
      devices,
      (device) =>
        sender.send({ key: input.target, device, notification }).pipe(
          Effect.result,
          Effect.map((result) => ({ device, result })),
        ),
      { concurrency: 4 },
    );
    const permanentTokens: string[] = [];
    const failures: string[] = [];
    let retryable = 0;
    let delivered = 0;
    for (const { device, result } of results) {
      if (Result.isFailure(result)) {
        failures.push(result.failure._tag);
        if (result.failure._tag === "ApnsTransportError") retryable += 1;
        continue;
      }
      const response = result.success;
      if (response.ok) {
        delivered += 1;
        continue;
      }
      failures.push(`${response.status}:${response.reason ?? "unknown"}`);
      if (isPermanentApnsTokenFailure(response)) {
        permanentTokens.push(device.token);
      } else if (isRetryableStatus(response.status)) {
        retryable += 1;
      }
    }
    yield* registry.removeTokens({ tokens: permanentTokens });
    yield* Effect.logInfo("agent activity push delivered", {
      threadId: state.threadId,
      phase: state.phase,
      total: devices.length,
      delivered,
      removedTokens: permanentTokens.length,
      failures,
    });
    if (retryable > 0) {
      return yield* new ApnsDeliveryRetryableError({ failedDevices: retryable, failures });
    }
  });

  const sink: AgentAwarenessRelay.AgentActivitySink<
    ApnsProviderKey,
    Effect.Error<typeof readTarget> | Effect.Error<ReturnType<typeof deliver>>
  > = {
    serviceName: "AgentActivityPush",
    unlinkedReason: "APNs provider key not installed",
    readTarget,
    sameTarget: ({ previous, next }) => previous === next,
    publish: deliver,
    logStartup: (target) =>
      target._tag === "Ready"
        ? Effect.logInfo("agent activity push enabled", {
            teamId: target.target.teamId,
            keyId: target.target.keyId,
          })
        : Effect.logInfo("agent activity push standby; no APNs provider key installed"),
    logReady: (target) =>
      Effect.logInfo("agent activity push enabled after the APNs provider key was installed", {
        teamId: target.teamId,
        keyId: target.keyId,
      }),
  };
  return sink;
});

export const layer = Layer.effect(
  AgentActivityPush,
  Effect.flatMap(makeApnsSink, AgentAwarenessRelay.makeAgentActivityPublisher),
);
