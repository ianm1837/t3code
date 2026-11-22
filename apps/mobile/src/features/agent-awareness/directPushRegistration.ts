import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { AtomRegistry, type Atom } from "effect/reactivity";
import { AppState } from "react-native";
import { msg } from "gt-react-native";
import {
  EnvironmentAuthorizationError,
  WS_METHODS,
  type EnvironmentId,
  type PushAlertPreferences,
} from "@t3tools/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../../connection/runtime";
import { m } from "../../i18n/messages";
import { loadOrCreateAgentAwarenessDeviceId } from "../../persistence/imperative";
import type { Preferences } from "../../persistence/mobile-preferences";
import { appAtomRegistry } from "../../state/atom-registry";
import { mobilePreferencesAtom, saveMobilePreferences } from "../../state/preferences";
import { supportsDirectPush } from "./capabilities";
import {
  requestAgentNotificationPermission,
  type NotificationPermissionResult,
} from "./notificationPermissions";
import { resolveApsEnvironment } from "./registrationPayload";

export type DirectPushEnvironmentStatus =
  | "registering"
  | "ready"
  | "no-server-key"
  | "failed"
  | "unavailable";

export type DirectPushEnableResult = NotificationPermissionResult;

const UNREGISTER_ON_REMOVE_TIMEOUT = "3 seconds";

const ALL_ALERTS: PushAlertPreferences = {
  notifyOnCompletion: true,
  notifyOnFailure: true,
  notifyOnApproval: true,
  notifyOnInput: true,
};

export type DirectPushAlertKind = keyof PushAlertPreferences;

export function directPushAlerts(preferences: Preferences): PushAlertPreferences {
  return preferences.directPushAlerts ?? ALL_ALERTS;
}

const registerCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mobile:push:register",
  tag: WS_METHODS.pushRegisterDevice,
});

const unregisterCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mobile:push:unregister",
  tag: WS_METHODS.pushUnregisterDevice,
});

const isEnvironmentAuthorizationError = Schema.is(EnvironmentAuthorizationError);

class DirectPushOperationError extends Schema.TaggedError<DirectPushOperationError>()(
  "DirectPushOperationError",
  {
    operation: Schema.Literals([
      "read-notification-permissions",
      "read-device-push-token",
      "load-device-identifier",
    ]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Direct push operation ${this.operation} failed.`;
  }
}

const loadDeviceId = Effect.tryPromise({
  try: () => loadOrCreateAgentAwarenessDeviceId(),
  catch: (cause) => new DirectPushOperationError({ operation: "load-device-identifier", cause }),
});

let connectedEnvironmentIds: ReadonlySet<EnvironmentId> = new Set();
let statuses: ReadonlyMap<EnvironmentId, DirectPushEnvironmentStatus> = new Map();
const statusListeners = new Set<() => void>();
const environmentLocks = new Map<EnvironmentId, Semaphore.Semaphore>();
let observedToken: string | null = null;

export function getDirectPushStatus(): ReadonlyMap<EnvironmentId, DirectPushEnvironmentStatus> {
  return statuses;
}

export function subscribeDirectPushStatus(listener: () => void): () => void {
  statusListeners.add(listener);
  return () => {
    statusListeners.delete(listener);
  };
}

function setStatus({
  environmentId,
  status,
}: {
  readonly environmentId: EnvironmentId;
  readonly status: DirectPushEnvironmentStatus | null;
}): void {
  if ((statuses.get(environmentId) ?? null) === status) return;
  const next = new Map(statuses);
  if (status === null) next.delete(environmentId);
  else next.set(environmentId, status);
  statuses = next;
  for (const listener of statusListeners) listener();
}

function lockFor(environmentId: EnvironmentId): Semaphore.Semaphore {
  const existing = environmentLocks.get(environmentId);
  if (existing !== undefined) return existing;
  const lock = Semaphore.makeUnsafe(1);
  environmentLocks.set(environmentId, lock);
  return lock;
}

function normalizedToken(token: Notifications.DevicePushToken | null): string | null {
  if (token === null || token.type !== "ios" || typeof token.data !== "string") return null;
  const value = token.data.trim().toLowerCase();
  return value.length > 0 ? value : null;
}

function deviceLabel(): string {
  return Constants.deviceName?.trim() || m(msg("iOS device"));
}

const readDeviceToken = Effect.fn("directPushRegistration.readDeviceToken")(function* () {
  const permissions = yield* Effect.tryPromise({
    try: () => Notifications.getPermissionsAsync(),
    catch: (cause) =>
      new DirectPushOperationError({ operation: "read-notification-permissions", cause }),
  });
  if (!permissions.granted) return null;
  if (observedToken !== null) return observedToken;
  const token = normalizedToken(
    yield* Effect.tryPromise({
      try: () => Notifications.getDevicePushTokenAsync(),
      catch: (cause) =>
        new DirectPushOperationError({ operation: "read-device-push-token", cause }),
    }),
  );
  if (token !== null && observedToken === null) observedToken = token;
  return observedToken;
});

const failureStatus = (cause: Cause.Cause<unknown>): DirectPushEnvironmentStatus =>
  cause.reasons.some(
    (reason) => reason._tag === "Fail" && isEnvironmentAuthorizationError(reason.error),
  )
    ? "unavailable"
    : "failed";

const reconcileUnlocked = Effect.fn("directPushRegistration.reconcileUnlocked")(function* (
  environmentId: EnvironmentId,
) {
  const preferences = yield* AtomRegistry.getResult(appAtomRegistry, mobilePreferencesAtom);
  const deviceId = yield* loadDeviceId;
  const unregister = Effect.suspend(() => {
    setStatus({ environmentId, status: null });
    return unregisterCommand.run(appAtomRegistry, { environmentId, input: { deviceId } });
  });
  if (preferences.directPushEnabled !== true) return yield* unregister;
  setStatus({ environmentId, status: "registering" });
  const token = yield* readDeviceToken();
  const bundleId = Constants.expoConfig?.ios?.bundleIdentifier?.trim();
  if (token === null || !bundleId) return yield* unregister;
  const appVersion = Constants.expoConfig?.version?.trim();
  const exit = yield* Effect.exit(
    registerCommand.run(appAtomRegistry, {
      environmentId,
      input: {
        deviceId,
        token,
        topic: bundleId,
        apsEnvironment: resolveApsEnvironment(Constants.expoConfig?.extra),
        label: deviceLabel(),
        ...(appVersion ? { appVersion } : {}),
        preferences: directPushAlerts(preferences),
      },
    }),
  );
  setStatus({
    environmentId,
    status: Exit.isSuccess(exit)
      ? exit.value.deliveryConfigured
        ? "ready"
        : "no-server-key"
      : failureStatus(exit.cause),
  });
});

const reconcile = Effect.fn("directPushRegistration.reconcile")(function* (
  environmentId: EnvironmentId,
) {
  yield* lockFor(environmentId)
    .withPermit(reconcileUnlocked(environmentId))
    .pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          if (Cause.hasInterruptsOnly(cause)) return;
          if (statuses.get(environmentId) !== undefined) {
            setStatus({ environmentId, status: failureStatus(cause) });
          }
        }),
      ),
    );
});

const reconcileConnected = Effect.fn("directPushRegistration.reconcileConnected")(function* () {
  yield* Effect.forEach(connectedEnvironmentIds, reconcile, {
    concurrency: "unbounded",
    discard: true,
  });
});

export const setDirectPushEnabled = Effect.fn("directPushRegistration.setDirectPushEnabled")(
  function* ({ enabled }: { readonly enabled: boolean }) {
    if (enabled) {
      const permission = yield* requestAgentNotificationPermission;
      if (permission.type !== "granted") return permission;
    }
    yield* saveMobilePreferences.run(appAtomRegistry, { directPushEnabled: enabled });
    yield* reconcileConnected();
    const result: DirectPushEnableResult = { type: "granted" };
    return result;
  },
);

export const setDirectPushAlert = Effect.fn("directPushRegistration.setDirectPushAlert")(
  function* ({ kind, enabled }: { readonly kind: DirectPushAlertKind; readonly enabled: boolean }) {
    yield* saveMobilePreferences.run(appAtomRegistry, {
      transform: (current) => ({
        directPushAlerts: { ...directPushAlerts(current), [kind]: enabled },
      }),
    });
    yield* reconcileConnected();
  },
);

export function unregisterDirectPushForEnvironment({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}): Promise<void> {
  if (!supportsDirectPush() || !connectedEnvironmentIds.has(environmentId)) {
    setStatus({ environmentId, status: null });
    return Promise.resolve();
  }
  return Effect.runPromise(
    lockFor(environmentId)
      .withPermit(
        loadDeviceId.pipe(
          Effect.flatMap((deviceId) =>
            unregisterCommand.run(appAtomRegistry, { environmentId, input: { deviceId } }),
          ),
        ),
      )
      .pipe(
        Effect.timeout(UNREGISTER_ON_REMOVE_TIMEOUT),
        Effect.ignore,
        Effect.ensuring(Effect.sync(() => setStatus({ environmentId, status: null }))),
      ),
  );
}

export function installDirectPushRegistration({
  connectedEnvironmentIdsAtom,
}: {
  readonly connectedEnvironmentIdsAtom: Atom.Atom<ReadonlyArray<EnvironmentId>>;
}): () => void {
  if (!supportsDirectPush()) return () => {};
  const runReconcile = (environmentId: EnvironmentId) => {
    void Effect.runPromise(reconcile(environmentId));
  };
  const runReconcileConnected = () => {
    void Effect.runPromise(reconcileConnected());
  };
  const unsubscribeConnected = appAtomRegistry.subscribe(
    connectedEnvironmentIdsAtom,
    (environmentIds) => {
      const previous = connectedEnvironmentIds;
      connectedEnvironmentIds = new Set(environmentIds);
      for (const environmentId of environmentIds) {
        if (!previous.has(environmentId)) runReconcile(environmentId);
      }
    },
    { immediate: true },
  );
  const tokenSubscription = Notifications.addPushTokenListener((token) => {
    const next = normalizedToken(token);
    if (next === null) return;
    observedToken = next;
    runReconcileConnected();
  });
  const appStateSubscription = AppState.addEventListener("change", (state) => {
    if (state === "active") runReconcileConnected();
  });
  return () => {
    unsubscribeConnected();
    connectedEnvironmentIds = new Set();
    tokenSubscription.remove();
    appStateSubscription.remove();
  };
}

export function __resetDirectPushRegistrationForTest(): void {
  connectedEnvironmentIds = new Set();
  statuses = new Map();
  statusListeners.clear();
  environmentLocks.clear();
  observedToken = null;
}
