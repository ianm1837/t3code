import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Argument from "effect/cli/Argument";
import * as CliError from "effect/cli/CliError";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as GlobalFlag from "effect/cli/GlobalFlag";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import {
  isPermanentApnsTokenFailure,
  type AgentActivityNotification,
} from "../push/agentActivityNotifications.ts";
import {
  APNS_PROVIDER_KEY_SECRET,
  decodeApnsProviderKey,
  encodeApnsProviderKey,
} from "../push/apnsProviderKey.ts";
import * as ApnsSender from "../push/ApnsSender.ts";
import * as ApnsTransport from "../push/ApnsTransport.ts";
import * as PushDeviceRegistry from "../push/PushDeviceRegistry.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";

const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Emit JSON instead of human-readable output."),
  Flag.withDefault(false),
);

const encodeStatusJson = Schema.encodeEffect(
  Schema.fromJsonString(Schema.toEncoded(Schema.Unknown)),
);

const userError = (error: { readonly message: string }) =>
  new CliError.UserError({ cause: error, userMessage: error.message });

const runtimeLayer = Effect.fn("push.cli.runtimeLayer")(function* (input: {
  readonly flags: { readonly baseDir: Option.Option<string> };
  readonly quietLogs: boolean;
}) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(input.flags, logLevel, {
    quietLogs: input.quietLogs,
  });
  const layerSecrets = ServerSecretStore.layer.pipe(
    Layer.provideMerge(ServerConfig.layer(config)),
    Layer.provide(
      Layer.succeed(References.MinimumLogLevel, input.quietLogs ? "Error" : config.logLevel),
    ),
  );
  const layerDevices = Layer.mergeAll(
    PushDeviceRegistry.layer.pipe(Layer.provide(SessionStore.layer)),
    ApnsSender.layer.pipe(Layer.provide(ApnsTransport.layer)),
  ).pipe(
    Layer.provideMerge(ServerEnvironment.layerIdentity),
    Layer.provideMerge(SqlitePersistence.layerCliConfig),
    Layer.provideMerge(layerSecrets),
  );
  return { layerSecrets, layerDevices };
});

const readProviderKey = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const bytes = yield* secrets.get(APNS_PROVIDER_KEY_SECRET);
  if (Option.isNone(bytes)) return Option.none();
  return Option.some(yield* decodeApnsProviderKey(bytes.value));
});

const pushKeySetCommand = Command.make("set", {
  ...projectLocationFlags,
  keyFile: Flag.FileText("key-file").pipe(
    Flag.withDescription("The AuthKey_<KEYID>.p8 file Apple issued for APNs."),
  ),
  keyId: Flag.String("key-id").pipe(
    Flag.withDescription("The 10-character key ID shown next to the key in Apple Developer."),
  ),
  teamId: Flag.String("team-id").pipe(
    Flag.withDescription("The 10-character Apple Developer team ID that owns the key."),
  ),
}).pipe(
  Command.withDescription(
    "Install the APNs key this server uses to send alerts to self-built iOS apps.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const { layerSecrets } = yield* runtimeLayer({ flags, quietLogs: false });
      const encoded = yield* encodeApnsProviderKey({
        teamId: flags.teamId.trim(),
        keyId: flags.keyId.trim(),
        privateKey: flags.keyFile,
      }).pipe(Effect.catchTags({ ApnsProviderKeyError: (error) => Effect.fail(userError(error)) }));
      const issuedAt = yield* DateTime.now;
      yield* ApnsSender.signApnsProviderToken({
        key: encoded.key,
        issuedAtSeconds: Math.floor(issuedAt.epochMilliseconds / 1_000),
      }).pipe(Effect.catchTags({ ApnsJwtError: (error) => Effect.fail(userError(error)) }));
      yield* Effect.gen(function* () {
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        yield* secrets.set(APNS_PROVIDER_KEY_SECRET, encoded.bytes);
      }).pipe(Effect.provide(layerSecrets));
      yield* Console.log(
        `Installed APNs key ${encoded.key.keyId} for team ${encoded.key.teamId}. A running server picks it up within a minute.\n`,
      );
    }),
  ),
);

const pushKeyRemoveCommand = Command.make("remove", projectLocationFlags).pipe(
  Command.withDescription("Remove the APNs key; this server stops sending alerts to iOS devices."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const { layerSecrets } = yield* runtimeLayer({ flags, quietLogs: false });
      const removed = yield* Effect.gen(function* () {
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        const existing = yield* secrets.get(APNS_PROVIDER_KEY_SECRET);
        if (Option.isNone(existing)) return false;
        yield* secrets.remove(APNS_PROVIDER_KEY_SECRET);
        return true;
      }).pipe(Effect.provide(layerSecrets));
      yield* Console.log(removed ? "Removed the APNs key.\n" : "No APNs key is installed.\n");
    }),
  ),
);

const pushKeyCommand = Command.make("key").pipe(
  Command.withDescription("Install or remove the APNs key."),
  Command.withSubcommands([pushKeySetCommand, pushKeyRemoveCommand]),
);

const tokenSuffix = (token: string) => `…${token.slice(-8)}`;

const pushStatusCommand = Command.make("status", { ...projectLocationFlags, json: jsonFlag }).pipe(
  Command.withDescription("Show the installed APNs key and the iOS devices registered for alerts."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const { layerDevices } = yield* runtimeLayer({ flags, quietLogs: flags.json });
      yield* Effect.gen(function* () {
        const key = yield* readProviderKey.pipe(Effect.result);
        const devices = yield* (yield* PushDeviceRegistry.PushDeviceRegistry).list;
        if (flags.json) {
          const json = yield* encodeStatusJson({
            key:
              key._tag === "Failure"
                ? { valid: false }
                : Option.match(key.success, {
                    onNone: () => null,
                    onSome: (installed) => ({
                      valid: true,
                      teamId: installed.teamId,
                      keyId: installed.keyId,
                    }),
                  }),
            devices: devices.map((device) => ({
              deviceId: device.deviceId,
              label: device.label,
              tokenSuffix: device.token.slice(-8),
              apsEnvironment: device.apsEnvironment,
              topic: device.topic,
              appVersion: device.appVersion ?? null,
              sessionActive: device.sessionActive,
              updatedAt: device.updatedAt,
            })),
          });
          yield* Console.log(`${json}\n`);
          return;
        }
        const keyLine =
          key._tag === "Failure"
            ? `APNs key: invalid. ${key.failure.message}`
            : Option.match(key.success, {
                onNone: () => "APNs key: not installed. Run `t3 push key set`.",
                onSome: (installed) => `APNs key: ${installed.keyId} for team ${installed.teamId}.`,
              });
        const deviceLines =
          devices.length === 0
            ? ["Devices: none registered."]
            : [
                "Devices:",
                ...devices.map(
                  (device) =>
                    `  ${device.label} (${device.deviceId}) token ${tokenSuffix(device.token)}, ${device.apsEnvironment}, ${device.topic}, session ${device.sessionActive ? "active" : "ended"}, updated ${device.updatedAt}`,
                ),
              ];
        yield* Console.log(`${[keyLine, ...deviceLines].join("\n")}\n`);
      }).pipe(Effect.provide(layerDevices));
    }),
  ),
);

const pushTestCommand = Command.make("test", {
  ...projectLocationFlags,
  device: Flag.String("device").pipe(
    Flag.withDescription("Send only to this device id, from `t3 push status`."),
    Flag.optional,
  ),
  thread: Flag.String("thread").pipe(
    Flag.withDescription("Open this thread id when the alert is tapped."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("Send one test alert to the registered iOS devices now."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const { layerDevices } = yield* runtimeLayer({ flags, quietLogs: false });
      yield* Effect.gen(function* () {
        const registry = yield* PushDeviceRegistry.PushDeviceRegistry;
        const sender = yield* ApnsSender.ApnsSender;
        const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
        const key = yield* readProviderKey.pipe(
          Effect.catchTags({ ApnsProviderKeyError: (error) => Effect.fail(userError(error)) }),
        );
        if (Option.isNone(key)) {
          return yield* userError({ message: "No APNs key is installed. Run `t3 push key set`." });
        }
        const deviceId = Option.getOrNull(flags.device);
        const devices =
          deviceId === null
            ? yield* registry.listDeliverable
            : (yield* registry.list).filter((device) => device.deviceId === deviceId);
        if (devices.length === 0) {
          return yield* userError({
            message:
              deviceId === null
                ? "No registered devices with an active session."
                : `No registered device ${deviceId}.`,
          });
        }
        const environmentId = yield* identity.getEnvironmentId;
        const threadId = Option.getOrElse(flags.thread, () => "");
        const notification: AgentActivityNotification = {
          title: "T3 Code",
          body: "Test alert from this server.",
          environmentId,
          threadId,
          deepLink:
            threadId.length > 0
              ? `/threads/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`
              : "/",
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        };
        let failed = 0;
        const permanentTokens: string[] = [];
        for (const device of devices) {
          const result = yield* sender
            .send({ key: key.value, device, notification })
            .pipe(Effect.result);
          const prefix = `${device.label} (${device.deviceId}) token ${tokenSuffix(device.token)}`;
          if (result._tag === "Failure") {
            failed += 1;
            yield* Console.log(`${prefix}: ${result.failure.message}`);
            continue;
          }
          const response = result.success;
          if (!response.ok) failed += 1;
          if (isPermanentApnsTokenFailure(response)) permanentTokens.push(device.token);
          yield* Console.log(
            `${prefix}: ${response.status}${response.reason === undefined ? "" : ` ${response.reason}`}${response.apnsId === null ? "" : ` apns-id ${response.apnsId}`}`,
          );
        }
        yield* registry.removeTokens({ tokens: permanentTokens });
        if (permanentTokens.length > 0) {
          yield* Console.log(`Removed ${permanentTokens.length} device(s) APNs no longer accepts.`);
        }
        if (failed > 0) {
          return yield* userError({
            message: `APNs refused the alert for ${failed} of ${devices.length} device(s).`,
          });
        }
      }).pipe(Effect.provide(layerDevices));
    }),
  ),
);

const pushDeviceRemoveCommand = Command.make("remove", {
  ...projectLocationFlags,
  deviceId: Argument.String("device-id").pipe(
    Argument.withDescription("The device id, from `t3 push status`."),
  ),
}).pipe(
  Command.withDescription("Stop sending alerts to one iOS device."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const { layerDevices } = yield* runtimeLayer({ flags, quietLogs: false });
      const removed = yield* PushDeviceRegistry.PushDeviceRegistry.pipe(
        Effect.flatMap((registry) => registry.unregister({ deviceId: flags.deviceId })),
        Effect.provide(layerDevices),
      );
      yield* Console.log(
        removed
          ? `Removed device ${flags.deviceId}.\n`
          : `No registered device ${flags.deviceId}.\n`,
      );
    }),
  ),
);

const pushDeviceCommand = Command.make("device").pipe(
  Command.withDescription("Manage the iOS devices registered for alerts."),
  Command.withSubcommands([pushDeviceRemoveCommand]),
);

export const pushCommand = Command.make("push").pipe(
  Command.withDescription("Send agent alerts from this server straight to self-built iOS apps."),
  Command.withSubcommands([pushKeyCommand, pushStatusCommand, pushTestCommand, pushDeviceCommand]),
);
