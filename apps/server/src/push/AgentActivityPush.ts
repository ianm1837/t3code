import type {
  PushAlertPreferences,
  PushThreadNotificationLevel,
  ThreadId,
} from "@t3tools/contracts";
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
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as AgentAwarenessRelay from "../relay/AgentAwarenessRelay.ts";
import { forkParked } from "../serverActivation.ts";
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

const ALL_ALERTS: PushAlertPreferences = {
  notifyOnCompletion: true,
  notifyOnFailure: true,
  notifyOnApproval: true,
  notifyOnInput: true,
};

function directPushPreferences({
  device,
  level,
}: {
  readonly device: { readonly preferences?: PushAlertPreferences | undefined };
  readonly level: PushThreadNotificationLevel;
}): RelayAgentAwarenessPreferences {
  const alerts = device.preferences ?? ALL_ALERTS;
  return {
    liveActivitiesEnabled: false,
    notificationsEnabled: level !== "off",
    notifyOnApproval: alerts.notifyOnApproval,
    notifyOnInput: alerts.notifyOnInput,
    notifyOnCompletion: level === "all" && alerts.notifyOnCompletion,
    notifyOnFailure: level === "all" && alerts.notifyOnFailure,
  };
}

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
  const settledByThread = new Map<
    ThreadId,
    { readonly state: RelayAgentActivityState; readonly tokens: Set<string> }
  >();

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
    readonly threadId: ThreadId;
    readonly state: RelayAgentActivityState | null;
  }) {
    const state = input.state;
    const nowMs = (yield* DateTime.now).epochMilliseconds;
    for (const [threadId, settled] of settledByThread) {
      if (isExpiredAgentActivityState({ state: settled.state, nowMs })) {
        settledByThread.delete(threadId);
      }
    }
    const previous = settledByThread.get(input.threadId);
    settledByThread.delete(input.threadId);
    if (state === null || isExpiredAgentActivityState({ state, nowMs })) return;
    const alerts = (preferences: RelayAgentAwarenessPreferences) =>
      shouldAlertForActivity({
        phase: state.phase,
        updatedAt: state.updatedAt,
        preferences,
        nowMs,
      });
    if (!alerts(directPushPreferences({ device: {}, level: "all" }))) return;
    const level = yield* registry.threadLevel({ threadId: input.threadId });
    const settledTokens =
      previous?.state.updatedAt === state.updatedAt ? previous.tokens : new Set<string>();
    const notification = notificationForActivity({ ...state, status: statusForPhase(state.phase) });
    const devices = (yield* registry.listDeliverable).filter(
      (device) =>
        !settledTokens.has(device.token) && alerts(directPushPreferences({ device, level })),
    );
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
    const retryableTokens = new Set<string>();
    let delivered = 0;
    for (const { device, result } of results) {
      if (Result.isFailure(result)) {
        failures.push(result.failure._tag);
        if (result.failure._tag === "ApnsTransportError") retryableTokens.add(device.token);
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
        retryableTokens.add(device.token);
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
    if (retryableTokens.size > 0) {
      for (const device of devices) {
        if (!retryableTokens.has(device.token)) settledTokens.add(device.token);
      }
      settledByThread.set(input.threadId, { state, tokens: settledTokens });
      return yield* new ApnsDeliveryRetryableError({
        failedDevices: retryableTokens.size,
        failures,
      });
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

export const makeThreadLevelPruning = Effect.gen(function* () {
  const registry = yield* PushDeviceRegistry.PushDeviceRegistry;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const removeLevel = (threadId: ThreadId) =>
    registry
      .setThreadLevel({ threadId, level: "all" })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not remove a deleted thread's push alert level.", cause),
        ),
      );
  const isDeleted = (threadId: ThreadId) =>
    threads.getThreadShell(threadId).pipe(
      Effect.map((shell) => shell === null),
      Effect.orElseSucceed(() => false),
    );
  return Effect.gen(function* () {
    const { threads: levels } = yield* registry.listThreadLevels.pipe(
      Effect.orElseSucceed(() => ({ threads: [] })),
    );
    yield* Effect.forEach(
      levels,
      ({ threadId }) =>
        isDeleted(threadId).pipe(
          Effect.flatMap((deleted) => (deleted ? removeLevel(threadId) : Effect.void)),
        ),
      { discard: true },
    );
    yield* Stream.runForEach(
      threads.streamDomainEvents.pipe(Stream.filter((event) => event.type === "thread.deleted")),
      (event) => removeLevel(event.threadId),
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Stopped removing deleted threads' push alert levels.", cause),
      ),
    );
  }).pipe(Effect.withSpan("AgentActivityPush.pruneThreadLevels"));
});

export const layer = Layer.effect(
  AgentActivityPush,
  Effect.gen(function* () {
    const publisher = yield* Effect.flatMap(
      makeApnsSink,
      AgentAwarenessRelay.makeAgentActivityPublisher,
    );
    const pruneThreadLevels = yield* makeThreadLevelPruning;
    return AgentActivityPush.of({
      ...publisher,
      start: Effect.fn("AgentActivityPush.startWithThreadLevelPruning")(function* () {
        yield* publisher.start();
        yield* forkParked(pruneThreadLevels);
      }),
    });
  }),
);
