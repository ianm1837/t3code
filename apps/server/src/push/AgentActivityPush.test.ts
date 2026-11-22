import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import {
  AuthSessionId,
  EnvironmentId,
  EventId,
  ThreadId,
  type AuthClientSession,
  type PushAlertPreferences,
} from "@t3tools/contracts";
import type { RelayAgentActivityState } from "@t3tools/contracts/relay";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Jwt from "effect/jose/Jwt";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as AgentActivityPush from "./AgentActivityPush.ts";
import { APNS_PROVIDER_KEY_SECRET, encodeApnsProviderKey } from "./apnsProviderKey.ts";
import * as ApnsSender from "./ApnsSender.ts";
import * as ApnsTransport from "./ApnsTransport.ts";
import * as PushDeviceRegistry from "./PushDeviceRegistry.ts";

const TEST_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg3EwCztQysKTvzdcR
g0LWq+axzUd4tHi9PyMdqh7PlGShRANCAARfQpoLgv/tOsHWCLriDza7Ruaey2b7
mR/nS6mLu6W7+agkEqDm0mE3F/ngpPjL4Jj0IGadeMcKNKFRSBgiLdfn
-----END PRIVATE KEY-----
`;
const NOW = "2026-09-04T12:00:00.000Z";
const NOW_MS = DateTime.toEpochMillis(DateTime.makeUnsafe(NOW));
const SESSION_A = AuthSessionId.make("session-a");
const SESSION_B = AuthSessionId.make("session-b");
const TOKEN_A = "a".repeat(64);
const TOKEN_B = "b".repeat(64);
const TOKEN_C = "c".repeat(64);
const NO_COMPLETION: PushAlertPreferences = {
  notifyOnCompletion: false,
  notifyOnFailure: true,
  notifyOnApproval: true,
  notifyOnInput: true,
};

function activityState(overrides: Partial<RelayAgentActivityState> = {}): RelayAgentActivityState {
  return {
    environmentId: EnvironmentId.make("env-1"),
    threadId: ThreadId.make("thread-1"),
    projectTitle: "Project",
    threadTitle: "Fix the build",
    phase: "completed",
    headline: "Done",
    modelTitle: "Model",
    updatedAt: NOW,
    deepLink: "/threads/env-1/thread-1",
    ...overrides,
  };
}

function clientSession(sessionId: AuthSessionId): AuthClientSession {
  return {
    sessionId,
    subject: "phone",
    scopes: [],
    method: "dpop-access-token",
    client: { deviceType: "mobile" },
    issuedAt: DateTime.makeUnsafe(NOW),
    expiresAt: DateTime.makeUnsafe("2026-10-04T12:00:00.000Z"),
    lastConnectedAt: null,
    connected: true,
    current: false,
  };
}

const makeHarness = Effect.fnUntraced(function* (input: {
  readonly respond: (token: string) => ApnsTransport.ApnsTransportResponse;
}) {
  const values = new Map<string, Uint8Array>();
  const secrets = ServerSecretStore.ServerSecretStore.of({
    get: (name) => Effect.sync(() => Option.fromUndefinedOr(values.get(name))),
    create: (name, value) => Effect.sync(() => void values.set(name, value)),
    set: (name, value) => Effect.sync(() => void values.set(name, value)),
    remove: (name) => Effect.sync(() => void values.delete(name)),
    getOrCreateRandom: () => Effect.die("unused"),
  });
  const activeSessions = new Set<AuthSessionId>([SESSION_A, SESSION_B]);
  const requests: Array<Parameters<ApnsTransport.ApnsTransport["Service"]["post"]>[0]> = [];
  const transport = ApnsTransport.ApnsTransport.of({
    post: (request) =>
      Effect.sync(() => {
        requests.push(request);
        return input.respond(request.path.slice("/3/device/".length));
      }),
  });
  const layer = Layer.mergeAll(PushDeviceRegistry.layer, ApnsSender.layer).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(ServerSecretStore.ServerSecretStore, secrets),
        Layer.mock(SessionStore.SessionStore)({
          cookieName: "push-test",
          legacyCookieName: undefined,
          listActive: () => Effect.sync(() => [...activeSessions].map(clientSession)),
        }),
        Layer.succeed(ApnsTransport.ApnsTransport, transport),
        NodeCrypto.layer,
      ),
    ),
  );
  const { sink, registry } = yield* Effect.all({
    sink: AgentActivityPush.makeApnsSink,
    registry: PushDeviceRegistry.PushDeviceRegistry,
  }).pipe(Effect.provide(layer));

  const { bytes } = yield* encodeApnsProviderKey({
    teamId: "TEAM123456",
    keyId: "KEY1234567",
    privateKey: TEST_PRIVATE_KEY,
  });
  values.set(APNS_PROVIDER_KEY_SECRET, bytes);
  const target = yield* sink.readTarget;
  assert.strictEqual(target._tag, "Ready");
  if (target._tag !== "Ready") return yield* Effect.die("APNs key was not installed");

  const register = (registration: {
    readonly deviceId: string;
    readonly token: string;
    readonly sessionId: AuthSessionId;
    readonly preferences?: PushAlertPreferences;
  }) =>
    registry.register({
      registration: {
        deviceId: registration.deviceId,
        token: registration.token,
        topic: "com.example.app",
        apsEnvironment: "sandbox",
        label: `Phone ${registration.deviceId}`,
        ...(registration.preferences === undefined
          ? {}
          : { preferences: registration.preferences }),
      },
      sessionId: registration.sessionId,
    });
  const publish = (state: RelayAgentActivityState | null) =>
    sink.publish({
      target: target.target,
      environmentId: EnvironmentId.make("env-1"),
      threadId: ThreadId.make("thread-1"),
      projectId: null,
      state,
      reason: "snapshot",
    });

  yield* TestClock.setTime(NOW_MS);
  return { registry, register, publish, requests, activeSessions };
});

const okResponse = (): ApnsTransport.ApnsTransportResponse => ({
  status: 200,
  apnsId: "apns-id",
  body: "",
});

describe("AgentActivityPush APNs sink", () => {
  it.effect("sends a fresh completion to every deliverable device and skips running work", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ respond: okResponse });
      assert.deepStrictEqual(
        yield* harness.register({ deviceId: "device-a", token: TOKEN_A, sessionId: SESSION_A }),
        { deliveryConfigured: true },
      );
      yield* harness.register({ deviceId: "device-b", token: TOKEN_B, sessionId: SESSION_B });

      yield* harness.publish(activityState());

      assert.deepStrictEqual(harness.requests.map((request) => request.path).toSorted(), [
        `/3/device/${TOKEN_A}`,
        `/3/device/${TOKEN_B}`,
      ]);
      const request = harness.requests[0];
      assert.isDefined(request);
      const { authorization, ...headers } = request.headers;
      assert.deepStrictEqual(headers, {
        "apns-topic": "com.example.app",
        "apns-push-type": "alert",
        "apns-priority": "10",
        "apns-collapse-id": `thread-1:${NOW_MS}`,
        "content-type": "application/json",
      });
      assert.strictEqual(request.environment, "sandbox");
      assert.strictEqual(
        request.body,
        '{"aps":{"alert":{"title":"Fix the build","body":"Done: Project"},"sound":"default","thread-id":"env-1/thread-1"},"body":{"environmentId":"env-1","threadId":"thread-1","deepLink":"/threads/env-1/thread-1"}}',
      );
      assert.isTrue(authorization?.startsWith("bearer "));
      const jwt = yield* Jwt.decodeUnverified(authorization?.slice("bearer ".length) ?? "");
      assert.deepStrictEqual(jwt.protectedHeader, { alg: "ES256", kid: "KEY1234567" });
      assert.deepStrictEqual(jwt.claims, { iss: "TEAM123456", iat: Math.floor(NOW_MS / 1_000) });
      assert.strictEqual(harness.requests[1]?.headers.authorization, authorization);

      yield* harness.publish(activityState({ phase: "running" }));
      yield* harness.publish(null);
      assert.strictEqual(harness.requests.length, 2);
    }),
  );

  it.effect.each([
    { level: "all", phase: "completed", sent: ["a"] },
    { level: "all", phase: "waiting_for_approval", sent: ["a", "b"] },
    { level: "needs-me", phase: "completed", sent: [] },
    { level: "needs-me", phase: "waiting_for_input", sent: ["a", "b"] },
    { level: "off", phase: "waiting_for_approval", sent: [] },
  ] as const)(
    "sends $phase in a thread at $level only to devices that allow it",
    ({ level, phase, sent }) =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({ respond: okResponse });
        yield* harness.register({ deviceId: "device-a", token: TOKEN_A, sessionId: SESSION_A });
        yield* harness.register({
          deviceId: "device-b",
          token: TOKEN_B,
          sessionId: SESSION_B,
          preferences: NO_COMPLETION,
        });
        yield* harness.registry.setThreadLevel({ threadId: ThreadId.make("thread-1"), level });
        assert.deepStrictEqual(
          yield* harness.registry.listThreadLevels,
          level === "all"
            ? { threads: [] }
            : { threads: [{ threadId: ThreadId.make("thread-1"), level }] },
        );

        yield* harness.publish(activityState({ phase }));

        assert.deepStrictEqual(
          harness.requests.map((request) => request.path.slice(-1)).toSorted(),
          [...sent],
        );
      }),
  );

  it.effect("removes levels of deleted threads and keeps archived ones", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ respond: okResponse });
      const removed = ThreadId.make("thread-removed");
      const archived = ThreadId.make("thread-archived");
      const live = ThreadId.make("thread-live");
      for (const threadId of [removed, archived, live]) {
        yield* harness.registry.setThreadLevel({ threadId, level: "off" });
      }
      const prune = yield* AgentActivityPush.makeThreadLevelPruning.pipe(
        Effect.provideService(PushDeviceRegistry.PushDeviceRegistry, harness.registry),
        Effect.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: (threadId) =>
              Effect.succeed(
                threadId === removed
                  ? null
                  : {
                      ...liveThreadShell(threadId),
                      archivedAt: threadId === archived ? DateTime.makeUnsafe(NOW) : null,
                    },
              ),
            streamDomainEvents: Stream.make({
              id: EventId.make("event:thread-live:deleted"),
              type: "thread.deleted",
              threadId: live,
              occurredAt: DateTime.makeUnsafe(NOW),
              payload: {
                ...liveThreadShell(live),
                lastVisitedAt: null,
                deletedAt: DateTime.makeUnsafe(NOW),
              },
            }),
          }),
        ),
      );

      yield* prune;

      assert.deepStrictEqual(yield* harness.registry.listThreadLevels, {
        threads: [{ threadId: archived, level: "off" }],
      });
    }),
  );

  it.effect.each([
    { status: 410, reason: "Unregistered", removed: true, retried: false },
    { status: 400, reason: "BadDeviceToken", removed: true, retried: false },
    { status: 400, reason: "DeviceTokenNotForTopic", removed: true, retried: false },
    { status: 503, reason: "ServiceUnavailable", removed: false, retried: true },
  ])("handles APNs $status $reason", ({ status, reason, removed, retried }) =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        respond: (token) =>
          token === TOKEN_A
            ? { status, apnsId: null, body: JSON.stringify({ reason }) }
            : okResponse(),
      });
      yield* harness.register({ deviceId: "device-a", token: TOKEN_A, sessionId: SESSION_A });
      yield* harness.register({ deviceId: "device-b", token: TOKEN_B, sessionId: SESSION_B });
      const sent = () =>
        harness.requests
          .map((request) => `${request.path.slice(-1)}@${request.headers["apns-collapse-id"]}`)
          .toSorted();

      const outcome = yield* harness.publish(activityState()).pipe(Effect.flip, Effect.option);
      assert.strictEqual(Option.isSome(outcome), retried);
      if (retried) {
        yield* harness.publish(activityState()).pipe(Effect.flip);
        assert.deepStrictEqual(sent(), [
          `a@thread-1:${NOW_MS}`,
          `a@thread-1:${NOW_MS}`,
          `b@thread-1:${NOW_MS}`,
        ]);
        const laterUpdatedAt = "2026-09-04T12:00:01.000Z";
        const laterMs = DateTime.toEpochMillis(DateTime.makeUnsafe(laterUpdatedAt));
        yield* harness.publish(activityState({ updatedAt: laterUpdatedAt })).pipe(Effect.flip);
        assert.deepStrictEqual(sent(), [
          `a@thread-1:${NOW_MS}`,
          `a@thread-1:${NOW_MS}`,
          `a@thread-1:${laterMs}`,
          `b@thread-1:${NOW_MS}`,
          `b@thread-1:${laterMs}`,
        ]);
      }
      const tokens = (yield* harness.registry.list).map((device) => device.token);
      assert.deepStrictEqual(tokens, removed ? [TOKEN_B] : [TOKEN_A, TOKEN_B]);
    }),
  );

  it.effect("skips and drops devices whose session ended and replaces a re-registered token", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ respond: okResponse });
      yield* harness.register({ deviceId: "device-a", token: TOKEN_A, sessionId: SESSION_A });
      yield* harness.register({ deviceId: "device-b", token: TOKEN_B, sessionId: SESSION_B });
      harness.activeSessions.delete(SESSION_B);

      yield* harness.publish(activityState({ phase: "waiting_for_approval" }));

      assert.deepStrictEqual(
        harness.requests.map((request) => request.path),
        [`/3/device/${TOKEN_A}`],
      );
      assert.deepStrictEqual(
        (yield* harness.registry.list).map((device) => device.deviceId),
        ["device-a"],
      );

      yield* harness.register({
        deviceId: "device-a",
        token: TOKEN_C,
        sessionId: SESSION_A,
        preferences: NO_COMPLETION,
      });
      assert.deepStrictEqual(
        (yield* harness.registry.list).map((device) => [device.deviceId, device.preferences]),
        [["device-a", NO_COMPLETION]],
      );
      yield* harness.register({ deviceId: "device-d", token: TOKEN_C, sessionId: SESSION_A });
      assert.deepStrictEqual(
        (yield* harness.registry.list).map((device) => [
          device.deviceId,
          device.token,
          device.preferences,
        ]),
        [["device-d", TOKEN_C, undefined]],
      );
    }),
  );
});
