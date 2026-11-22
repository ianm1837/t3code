import type { RelayApnsEnvironment } from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as Signature from "effect/crypto/Signature";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Jwt from "effect/jose/Jwt";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import {
  apnsAlertPayload,
  apnsReasonFromBody,
  sanitizeApnsNotificationPayload,
  type AgentActivityNotification,
} from "./agentActivityNotifications.ts";
import type { ApnsProviderKey } from "./apnsProviderKey.ts";
import * as ApnsTransport from "./ApnsTransport.ts";

const PROVIDER_TOKEN_REUSE_SECONDS = 50 * 60;
const MAX_COLLAPSE_ID_BYTES = 64;

export class ApnsJwtError extends Schema.TaggedError<ApnsJwtError>()("ApnsJwtError", {
  keyId: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Failed to sign the APNs provider token for key ${this.keyId}.`;
  }
}

const ProviderTokenClaims = Schema.Struct({ iss: Schema.String, iat: Schema.Number });

const ApnsAlertRequestBody = Schema.Struct({
  aps: Schema.Struct({
    alert: Schema.Struct({ title: Schema.String, body: Schema.String }),
    sound: Schema.String,
    "thread-id": Schema.String,
  }),
  body: Schema.Struct({
    environmentId: Schema.String,
    threadId: Schema.String,
    deepLink: Schema.String,
  }),
});
const encodeApnsAlertRequestBody = Schema.encodeEffect(Schema.fromJsonString(ApnsAlertRequestBody));

export const signApnsProviderToken = Effect.fn("ApnsSender.signProviderToken")(function* (input: {
  readonly key: ApnsProviderKey;
  readonly issuedAtSeconds: number;
}) {
  const token = yield* Jwt.sign(
    ProviderTokenClaims,
    { iss: input.key.teamId, iat: input.issuedAtSeconds },
    input.key.signingKey,
    { kid: input.key.keyId },
  ).pipe(Effect.mapError((cause) => new ApnsJwtError({ keyId: input.key.keyId, cause })));
  return Redacted.value(token);
});

export interface ApnsSendResult {
  readonly ok: boolean;
  readonly status: number;
  readonly reason?: string;
  readonly apnsId: string | null;
}

export interface ApnsDeliveryTarget {
  readonly token: string;
  readonly topic: string;
  readonly apsEnvironment: RelayApnsEnvironment;
}

function collapseIdFor(notification: AgentActivityNotification): string | undefined {
  if (notification.updatedAt === undefined) return undefined;
  const updatedAt = Option.getOrNull(DateTime.make(notification.updatedAt));
  if (updatedAt === null) return undefined;
  const collapseId = `${notification.threadId}:${updatedAt.epochMilliseconds}`;
  return new TextEncoder().encode(collapseId).length <= MAX_COLLAPSE_ID_BYTES
    ? collapseId
    : undefined;
}

export class ApnsSender extends Context.Service<
  ApnsSender,
  {
    readonly send: (input: {
      readonly key: ApnsProviderKey;
      readonly device: ApnsDeliveryTarget;
      readonly notification: AgentActivityNotification;
    }) => Effect.Effect<ApnsSendResult, ApnsTransport.ApnsTransportError | ApnsJwtError>;
  }
>()("t3/push/ApnsSender") {}

const make = Effect.gen(function* () {
  const transport = yield* ApnsTransport.ApnsTransport;
  const signature = yield* Signature.Signature;
  const providerTokens = new WeakMap<
    ApnsProviderKey,
    { readonly jwt: string; readonly issuedAtSeconds: number }
  >();

  const signing = yield* Semaphore.make(1);

  const providerToken = Effect.fn("ApnsSender.providerToken")(function* (key: ApnsProviderKey) {
    const nowSeconds = Math.floor((yield* DateTime.now).epochMilliseconds / 1_000);
    const cached = providerTokens.get(key);
    if (
      cached !== undefined &&
      nowSeconds - cached.issuedAtSeconds < PROVIDER_TOKEN_REUSE_SECONDS
    ) {
      return cached.jwt;
    }
    const jwt = yield* signApnsProviderToken({ key, issuedAtSeconds: nowSeconds }).pipe(
      Effect.provideService(Signature.Signature, signature),
    );
    providerTokens.set(key, { jwt, issuedAtSeconds: nowSeconds });
    return jwt;
  }, signing.withPermits(1));

  const send: ApnsSender["Service"]["send"] = Effect.fn("ApnsSender.send")(function* (input) {
    yield* Effect.annotateCurrentSpan({
      "apns.environment": input.device.apsEnvironment,
      "apns.token_suffix": input.device.token.slice(-8),
    });
    const notification = sanitizeApnsNotificationPayload(input.notification);
    const jwt = yield* providerToken(input.key);
    const body = yield* encodeApnsAlertRequestBody(apnsAlertPayload(notification)).pipe(
      Effect.orDie,
    );
    const collapseId = collapseIdFor(notification);
    const response = yield* transport.post({
      environment: input.device.apsEnvironment,
      path: `/3/device/${input.device.token}`,
      headers: {
        authorization: `bearer ${jwt}`,
        "apns-topic": input.device.topic,
        "apns-push-type": "alert",
        "apns-priority": "10",
        ...(collapseId === undefined ? {} : { "apns-collapse-id": collapseId }),
        "content-type": "application/json",
      },
      body,
    });
    const reason = apnsReasonFromBody(response.body);
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      ...(reason === undefined ? {} : { reason }),
      apnsId: response.apnsId,
    };
  });

  return ApnsSender.of({ send });
});

export const layer = Layer.effect(ApnsSender, make);
