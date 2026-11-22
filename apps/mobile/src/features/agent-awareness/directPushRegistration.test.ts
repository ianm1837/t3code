import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom } from "effect/reactivity";

import type { Preferences } from "../../persistence/mobile-preferences";
import { appAtomRegistry } from "../../state/atom-registry";
import {
  __resetDirectPushRegistrationForTest,
  installDirectPushRegistration,
} from "./directPushRegistration";

const ENVIRONMENT_A = EnvironmentId.make("environment-a");
const ENVIRONMENT_B = EnvironmentId.make("environment-b");
const FIRST_TOKEN = "a".repeat(64);
const ROTATED_TOKEN = "b".repeat(64);

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
  return { mobilePreferencesAtom: preferences.atom, saveMobilePreferences: { run: vi.fn() } };
});

vi.mock("../../persistence/imperative", () => ({
  loadOrCreateAgentAwarenessDeviceId: () => Promise.resolve("device-1"),
}));

vi.mock("./capabilities", () => ({ agentAwarenessPushMode: () => "direct" }));

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

const registration = (environmentId: EnvironmentId, token: string): RpcCall => ({
  tag: "push.registerDevice",
  environmentId,
  input: {
    deviceId: "device-1",
    token,
    topic: "com.example.t3code",
    apsEnvironment: "sandbox",
    label: "Test iPhone",
    appVersion: "2.3.0",
  },
});

describe("installDirectPushRegistration", () => {
  beforeEach(() => {
    rpc.calls.length = 0;
    rpc.waiters.length = 0;
    tokenListeners.length = 0;
    __resetDirectPushRegistrationForTest();
  });

  it("re-registers every connected environment when the push token rotates", async () => {
    setPreferences({ directPushEnabled: true });
    using _registration = install([ENVIRONMENT_A, ENVIRONMENT_B]);
    await callsReach(2);
    expect(byEnvironment(rpc.calls)).toEqual([
      registration(ENVIRONMENT_A, FIRST_TOKEN),
      registration(ENVIRONMENT_B, FIRST_TOKEN),
    ]);

    for (const listener of tokenListeners) listener({ type: "ios", data: ROTATED_TOKEN });
    await callsReach(4);
    expect(byEnvironment(rpc.calls.slice(2))).toEqual([
      registration(ENVIRONMENT_A, ROTATED_TOKEN),
      registration(ENVIRONMENT_B, ROTATED_TOKEN),
    ]);
  });

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
