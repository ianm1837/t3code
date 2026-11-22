import {
  ApnsDeviceToken,
  AuthSessionId,
  PushAlertPreferences,
  type PushDeviceRegisterResult,
  type PushDeviceRegistration,
  PushDeviceRegistryError,
  PushThreadNotificationLevel,
  type PushThreadNotificationLevelEntry,
  type PushThreadNotificationLevelList,
  ThreadId,
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
  preferences: Schema.optional(PushAlertPreferences),
  sessionId: AuthSessionId,
  updatedAt: Schema.String,
});
export type PushDeviceRecord = typeof PushDeviceRecord.Type;

const PushDeviceFile = Schema.Struct({
  devices: Schema.Array(PushDeviceRecord),
  threadLevels: Schema.optional(Schema.Record(Schema.String, PushThreadNotificationLevel)),
});
type PushDeviceFile = typeof PushDeviceFile.Type;
const EMPTY_FILE: PushDeviceFile = { devices: [] };

const PushDeviceFileJson = Schema.fromJsonString(PushDeviceFile);
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
    readonly threadLevel: (input: {
      readonly threadId: ThreadId;
    }) => Effect.Effect<PushThreadNotificationLevel, PushDeviceRegistryError>;
    readonly setThreadLevel: (
      input: PushThreadNotificationLevelEntry,
    ) => Effect.Effect<void, PushDeviceRegistryError>;
    readonly listThreadLevels: Effect.Effect<
      PushThreadNotificationLevelList,
      PushDeviceRegistryError
    >;
  }
>()("t3/push/PushDeviceRegistry") {}

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const sessions = yield* SessionStore.SessionStore;
  const lock = yield* Semaphore.make(1);

  const registryError = (cause: unknown) => new PushDeviceRegistryError({ cause });

  const readFile = Effect.gen(function* () {
    const bytes = yield* secrets.get(PUSH_DEVICES_SECRET);
    if (Option.isNone(bytes)) return EMPTY_FILE;
    return yield* decodePushDeviceFile(new TextDecoder().decode(bytes.value));
  }).pipe(Effect.mapError(registryError));

  const readDevices = Effect.map(readFile, (file) => file.devices);

  const writeFile = (file: PushDeviceFile) =>
    encodePushDeviceFile(file).pipe(
      Effect.flatMap((json) => secrets.set(PUSH_DEVICES_SECRET, new TextEncoder().encode(json))),
      Effect.mapError(registryError),
    );

  const updateFile = <A>(
    change: (file: PushDeviceFile) => { readonly file: PushDeviceFile; readonly result: A },
  ) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const file = yield* readFile;
        const next = change(file);
        if (next.file !== file) yield* writeFile(next.file);
        return next.result;
      }),
    );

  const update = <A>(
    change: (devices: ReadonlyArray<PushDeviceRecord>) => {
      readonly devices: ReadonlyArray<PushDeviceRecord>;
      readonly result: A;
    },
  ) =>
    updateFile((file) => {
      const next = change(file.devices);
      return {
        file: next.devices === file.devices ? file : { ...file, devices: next.devices },
        result: next.result,
      };
    });

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

  const threadLevel: PushDeviceRegistry["Service"]["threadLevel"] = Effect.fn(
    "PushDeviceRegistry.threadLevel",
  )(function* (input) {
    const file = yield* readFile;
    return file.threadLevels?.[input.threadId] ?? "all";
  });

  const setThreadLevel: PushDeviceRegistry["Service"]["setThreadLevel"] = Effect.fn(
    "PushDeviceRegistry.setThreadLevel",
  )(function* (input) {
    yield* updateFile((file) => {
      const current = file.threadLevels?.[input.threadId] ?? "all";
      if (current === input.level) return { file, result: undefined };
      const others = Object.fromEntries(
        Object.entries(file.threadLevels ?? {}).filter(([threadId]) => threadId !== input.threadId),
      );
      return {
        file: {
          ...file,
          threadLevels:
            input.level === "all" ? others : { ...others, [input.threadId]: input.level },
        },
        result: undefined,
      };
    });
  });

  const listThreadLevels: PushDeviceRegistry["Service"]["listThreadLevels"] = readFile.pipe(
    Effect.map((file) => ({
      threads: Object.entries(file.threadLevels ?? {}).map(([threadId, level]) => ({
        threadId: ThreadId.make(threadId),
        level,
      })),
    })),
    Effect.withSpan("PushDeviceRegistry.listThreadLevels"),
  );

  return PushDeviceRegistry.of({
    register,
    unregister,
    listDeliverable,
    removeTokens,
    list,
    threadLevel,
    setThreadLevel,
    listThreadLevels,
  });
});

export const layer = Layer.effect(PushDeviceRegistry, make);
