import { describe, expect, it } from "@effect/vitest";
import { beforeEach, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";

import type { PushAlertPreferences } from "@t3tools/contracts";
import type { Preferences } from "../../persistence/mobile-preferences";
import { appAtomRegistry } from "../../state/atom-registry";
import {
  __resetDirectPushRegistrationForTest,
  installDirectPushRegistration,
  setDirectPushAlert,
} from "./directPushRegistration";

const ENVIRONMENT_A = EnvironmentId.make("environment-a");
const ENVIRONMENT_B = EnvironmentId.make("environment-b");
const FIRST_TOKEN = "a".repeat(64);
const ROTATED_TOKEN = "b".repeat(64);
const ALL_ALERTS: PushAlertPreferences = {
  notifyOnCompletion: true,
  notifyOnFailure: true,
  notifyOnApproval: true,
  notifyOnInput: true,
};

type RpcCall = {
  readonly tag: string;
  readonly environmentId: EnvironmentId;
  readonly input: unknown;
};

const rpc = vi.hoisted(() => ({
  calls: [] as Array<RpcCall>,
  waiters: [] as Array<{ readonly count: number; readonly resolve: () => void }>,
}));
const tokenListeners = vi.hoisted(() => [] as Array<(token: unknown) => void>);
const preferences = vi.hoisted(() => ({
  atom: null as Atom.Writable<AsyncResult.AsyncResult<Preferences, never>> | null,
}));

function callsReach(count: number): Promise<void> {
  return new Promise((resolve) => {
    if (rpc.calls.length >= count) resolve();
    else rpc.waiters.push({ count, resolve });
  });
}

vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  createEnvironmentRpcCommand: (_runtime: unknown, options: { readonly tag: string }) => ({
    run: (
      _registry: unknown,
      target: { readonly environmentId: EnvironmentId; readonly input: unknown },
    ) =>
      Effect.sync(() => {
        rpc.calls.push({ tag: options.tag, ...target });
        for (const waiter of rpc.waiters.filter(({ count }) => rpc.calls.length >= count)) {
          waiter.resolve();
        }
        return { deliveryConfigured: true };
      }),
  }),
}));

vi.mock("../../connection/runtime", () => ({ connectionAtomRuntime: {} }));

vi.mock("../../state/atom-registry", async () => {
  const { AtomRegistry } = await import("effect/reactivity");
  return { appAtomRegistry: AtomRegistry.make() };
});

vi.mock("../../state/preferences", async () => {
  const reactivity = await import("effect/reactivity");
  preferences.atom = reactivity.Atom.make<AsyncResult.AsyncResult<Preferences, never>>(
    reactivity.AsyncResult.success({}),
  ).pipe(reactivity.Atom.keepAlive);
  const atom = preferences.atom;
  return {
    mobilePreferencesAtom: atom,
    saveMobilePreferences: {
      run: (
        registry: AtomRegistry.AtomRegistry,
        update: { readonly transform: (current: Preferences) => Partial<Preferences> },
      ) =>
        Effect.sync(() => {
          const current = reactivity.AsyncResult.getOrElse(registry.get(atom), () => ({}));
          registry.set(
            atom,
            reactivity.AsyncResult.success({ ...current, ...update.transform(current) }),
          );
        }),
    },
  };
});

vi.mock("../../persistence/imperative", () => ({
  loadOrCreateAgentAwarenessDeviceId: () => Promise.resolve("device-1"),
}));

vi.mock("./capabilities", () => ({ supportsDirectPush: () => true }));

vi.mock("expo-constants", () => ({
  default: {
    deviceName: "Test iPhone",
    expoConfig: {
      version: "2.3.0",
      ios: { bundleIdentifier: "com.example.t3code" },
      extra: { apsEnvironment: "sandbox", push: { mode: "direct" } },
    },
  },
}));

vi.mock("expo-notifications", () => ({
  getPermissionsAsync: () => Promise.resolve({ granted: true }),
  getDevicePushTokenAsync: () => Promise.resolve({ type: "ios", data: FIRST_TOKEN }),
  addPushTokenListener: (listener: (token: unknown) => void) => {
    tokenListeners.push(listener);
    return { remove: () => {} };
  },
}));

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  AppState: { addEventListener: () => ({ remove: () => {} }) },
}));

const byEnvironment = (calls: ReadonlyArray<RpcCall>) =>
  [...calls].sort((left, right) => left.environmentId.localeCompare(right.environmentId));

function setPreferences(value: Preferences): void {
  appAtomRegistry.set(preferences.atom!, AsyncResult.success(value));
}

function install(connected: ReadonlyArray<EnvironmentId>) {
  const connectedEnvironmentIdsAtom = Atom.make<ReadonlyArray<EnvironmentId>>(connected).pipe(
    Atom.keepAlive,
  );
  const dispose = installDirectPushRegistration({ connectedEnvironmentIdsAtom });
  return {
    connect: (environmentIds: ReadonlyArray<EnvironmentId>) =>
      appAtomRegistry.set(connectedEnvironmentIdsAtom, environmentIds),
    [Symbol.dispose]: dispose,
  };
}

const registration = ({
  environmentId,
  token,
  preferences = ALL_ALERTS,
}: {
  readonly environmentId: EnvironmentId;
  readonly token: string;
  readonly preferences?: PushAlertPreferences;
}): RpcCall => ({
  tag: "push.registerDevice",
  environmentId,
  input: {
    deviceId: "device-1",
    token,
    topic: "com.example.t3code",
    apsEnvironment: "sandbox",
    label: "Test iPhone",
    appVersion: "2.3.0",
    preferences,
  },
});

describe("installDirectPushRegistration", () => {
  beforeEach(() => {
    rpc.calls.length = 0;
    rpc.waiters.length = 0;
    tokenListeners.length = 0;
    __resetDirectPushRegistrationForTest();
  });

  it.effect(
    "re-registers every connected environment when the token rotates or an alert kind changes",
    () =>
      Effect.gen(function* () {
        setPreferences({ directPushEnabled: true });
        using _registration = install([ENVIRONMENT_A, ENVIRONMENT_B]);
        yield* Effect.promise(() => callsReach(2));
        expect(byEnvironment(rpc.calls)).toEqual([
          registration({ environmentId: ENVIRONMENT_A, token: FIRST_TOKEN }),
          registration({ environmentId: ENVIRONMENT_B, token: FIRST_TOKEN }),
        ]);

        for (const listener of tokenListeners) listener({ type: "ios", data: ROTATED_TOKEN });
        yield* Effect.promise(() => callsReach(4));
        expect(byEnvironment(rpc.calls.slice(2))).toEqual([
          registration({ environmentId: ENVIRONMENT_A, token: ROTATED_TOKEN }),
          registration({ environmentId: ENVIRONMENT_B, token: ROTATED_TOKEN }),
        ]);

        yield* setDirectPushAlert({ kind: "notifyOnCompletion", enabled: false });
        yield* Effect.promise(() => callsReach(6));
        const withoutCompletion = { ...ALL_ALERTS, notifyOnCompletion: false };
        expect(byEnvironment(rpc.calls.slice(4))).toEqual([
          registration({
            environmentId: ENVIRONMENT_A,
            token: ROTATED_TOKEN,
            preferences: withoutCompletion,
          }),
          registration({
            environmentId: ENVIRONMENT_B,
            token: ROTATED_TOKEN,
            preferences: withoutCompletion,
          }),
        ]);
      }),
  );

  it("unregisters a newly connected environment while the preference is off", async () => {
    setPreferences({});
    using registration = install([]);
    registration.connect([ENVIRONMENT_A]);
    await callsReach(1);
    expect(rpc.calls).toEqual([
      {
        tag: "push.unregisterDevice",
        environmentId: ENVIRONMENT_A,
        input: { deviceId: "device-1" },
      },
    ]);
  });
});
