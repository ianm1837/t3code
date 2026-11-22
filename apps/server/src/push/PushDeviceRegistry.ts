import {
  ApnsDeviceToken,
  AuthSessionId,
  type PushDeviceRegisterResult,
  type PushDeviceRegistration,
  PushDeviceRegistryError,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import { RelayApnsEnvironment } from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import { APNS_PROVIDER_KEY_SECRET } from "./apnsProviderKey.ts";

const PUSH_DEVICES_SECRET = "apns-devices";

const PushDeviceRecord = Schema.Struct({
  deviceId: TrimmedNonEmptyString,
  token: ApnsDeviceToken,
  topic: TrimmedNonEmptyString,
  apsEnvironment: RelayApnsEnvironment,
  label: TrimmedNonEmptyString,
  appVersion: Schema.optional(TrimmedNonEmptyString),
  sessionId: AuthSessionId,
  updatedAt: Schema.String,
});
export type PushDeviceRecord = typeof PushDeviceRecord.Type;

const PushDeviceFileJson = Schema.fromJsonString(
  Schema.Struct({ devices: Schema.Array(PushDeviceRecord) }),
);
const decodePushDeviceFile = Schema.decodeUnknownEffect(PushDeviceFileJson);
const encodePushDeviceFile = Schema.encodeEffect(PushDeviceFileJson);

export class PushDeviceRegistry extends Context.Service<
  PushDeviceRegistry,
  {
    readonly register: (input: {
      readonly registration: PushDeviceRegistration;
      readonly sessionId: AuthSessionId;
    }) => Effect.Effect<PushDeviceRegisterResult, PushDeviceRegistryError>;
    readonly unregister: (input: {
      readonly deviceId: string;
    }) => Effect.Effect<boolean, PushDeviceRegistryError>;
    readonly listDeliverable: Effect.Effect<
      ReadonlyArray<PushDeviceRecord>,
      PushDeviceRegistryError
    >;
    readonly removeTokens: (input: {
      readonly tokens: ReadonlyArray<string>;
    }) => Effect.Effect<void, PushDeviceRegistryError>;
    readonly list: Effect.Effect<
      ReadonlyArray<PushDeviceRecord & { readonly sessionActive: boolean }>,
      PushDeviceRegistryError
    >;
  }
>()("t3/push/PushDeviceRegistry") {}

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const sessions = yield* SessionStore.SessionStore;
  const lock = yield* Semaphore.make(1);

  const registryError = (cause: unknown) => new PushDeviceRegistryError({ cause });

  const readDevices = Effect.gen(function* () {
    const bytes = yield* secrets.get(PUSH_DEVICES_SECRET);
    if (Option.isNone(bytes)) return [];
    const file = yield* decodePushDeviceFile(new TextDecoder().decode(bytes.value));
    return file.devices;
  }).pipe(Effect.mapError(registryError));

  const writeDevices = (devices: ReadonlyArray<PushDeviceRecord>) =>
    encodePushDeviceFile({ devices }).pipe(
      Effect.flatMap((json) => secrets.set(PUSH_DEVICES_SECRET, new TextEncoder().encode(json))),
      Effect.mapError(registryError),
    );

  const update = <A>(
    change: (devices: ReadonlyArray<PushDeviceRecord>) => {
      readonly devices: ReadonlyArray<PushDeviceRecord>;
      readonly result: A;
    },
  ) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const devices = yield* readDevices;
        const next = change(devices);
        if (next.devices !== devices) yield* writeDevices(next.devices);
        return next.result;
      }),
    );

  const activeSessionIds = sessions.listActive().pipe(
    Effect.map((active) => new Set<string>(active.map((session) => session.sessionId))),
    Effect.mapError(registryError),
  );

  const register: PushDeviceRegistry["Service"]["register"] = Effect.fn(
    "PushDeviceRegistry.register",
  )(function* (input) {
    const updatedAt = DateTime.formatIso(yield* DateTime.now);
    const record: PushDeviceRecord = {
      ...input.registration,
      sessionId: input.sessionId,
      updatedAt,
    };
    yield* update((devices) => ({
      devices: [
        ...devices.filter(
          (device) => device.deviceId !== record.deviceId && device.token !== record.token,
        ),
        record,
      ],
      result: undefined,
    }));
    const key = yield* secrets.get(APNS_PROVIDER_KEY_SECRET).pipe(Effect.mapError(registryError));
    return { deliveryConfigured: Option.isSome(key) };
  });

  const unregister: PushDeviceRegistry["Service"]["unregister"] = Effect.fn(
    "PushDeviceRegistry.unregister",
  )(function* (input) {
    return yield* update((devices) => {
      const remaining = devices.filter((device) => device.deviceId !== input.deviceId);
      return remaining.length === devices.length
        ? { devices, result: false }
        : { devices: remaining, result: true };
    });
  });

  const listDeliverable: PushDeviceRegistry["Service"]["listDeliverable"] = Effect.gen(
    function* () {
      const active = yield* activeSessionIds;
      return yield* update((devices) => {
        const deliverable = devices.filter((device) => active.has(device.sessionId));
        return {
          devices: deliverable.length === devices.length ? devices : deliverable,
          result: deliverable,
        };
      });
    },
  ).pipe(Effect.withSpan("PushDeviceRegistry.listDeliverable"));

  const removeTokens: PushDeviceRegistry["Service"]["removeTokens"] = Effect.fn(
    "PushDeviceRegistry.removeTokens",
  )(function* (input) {
    if (input.tokens.length === 0) return;
    const tokens = new Set(input.tokens);
    yield* update((devices) => {
      const remaining = devices.filter((device) => !tokens.has(device.token));
      return {
        devices: remaining.length === devices.length ? devices : remaining,
        result: undefined,
      };
    });
  });

  const list: PushDeviceRegistry["Service"]["list"] = Effect.gen(function* () {
    const active = yield* activeSessionIds;
    const devices = yield* readDevices;
    return devices.map((device) => ({ ...device, sessionActive: active.has(device.sessionId) }));
  }).pipe(Effect.withSpan("PushDeviceRegistry.list"));

  return PushDeviceRegistry.of({ register, unregister, listDeliverable, removeTokens, list });
});

export const layer = Layer.effect(PushDeviceRegistry, make);
