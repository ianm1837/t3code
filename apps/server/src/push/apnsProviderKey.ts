import * as Effect from "effect/Effect";
import * as Jwk from "effect/jose/Jwk";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

export const APNS_PROVIDER_KEY_SECRET = "apns-provider-key";

const AppleIdentifier = Schema.String.check(Schema.isPattern(/^[A-Z0-9]{10}$/));

const ApnsProviderKeyFile = Schema.Struct({
  teamId: AppleIdentifier,
  keyId: AppleIdentifier,
  privateKey: Schema.String,
});
type ApnsProviderKeyFile = typeof ApnsProviderKeyFile.Type;

const ApnsProviderKeyJson = Schema.fromJsonString(ApnsProviderKeyFile);
const decodeApnsProviderKeyJson = Schema.decodeUnknownEffect(ApnsProviderKeyJson);
const encodeApnsProviderKeyJson = Schema.encodeEffect(ApnsProviderKeyJson);
const decodeApnsProviderKeyFields = Schema.decodeUnknownEffect(ApnsProviderKeyFile);

export class ApnsProviderKeyError extends Schema.TaggedError<ApnsProviderKeyError>()(
  "ApnsProviderKeyError",
  {
    stage: Schema.Literals(["decode", "import", "encode"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    switch (this.stage) {
      case "decode":
        return "The APNs provider key needs a 10-character team ID, a 10-character key ID and a private key.";
      case "import":
        return "The APNs private key is not a PKCS#8 P-256 key, like the AuthKey_<KEYID>.p8 file Apple issues.";
      case "encode":
        return "The APNs provider key could not be encoded.";
    }
  }
}

export interface ApnsProviderKey {
  readonly teamId: string;
  readonly keyId: string;
  readonly signingKey: Jwk.PrivateKey;
}

const importProviderKey = Effect.fn("ApnsProviderKey.import")(function* (
  file: ApnsProviderKeyFile,
) {
  const signingKey = yield* Jwk.importPkcs8(Redacted.make(file.privateKey.trim()), "ES256", {
    kid: file.keyId,
  }).pipe(Effect.mapError((cause) => new ApnsProviderKeyError({ stage: "import", cause })));
  return { teamId: file.teamId, keyId: file.keyId, signingKey } satisfies ApnsProviderKey;
});

export const decodeApnsProviderKey = Effect.fn("ApnsProviderKey.decode")(function* (
  bytes: Uint8Array,
) {
  const file = yield* decodeApnsProviderKeyJson(new TextDecoder().decode(bytes)).pipe(
    Effect.mapError((cause) => new ApnsProviderKeyError({ stage: "decode", cause })),
  );
  return yield* importProviderKey(file);
});

export const encodeApnsProviderKey = Effect.fn("ApnsProviderKey.encode")(function* (input: {
  readonly teamId: string;
  readonly keyId: string;
  readonly privateKey: string;
}) {
  const file = yield* decodeApnsProviderKeyFields(input).pipe(
    Effect.mapError((cause) => new ApnsProviderKeyError({ stage: "decode", cause })),
  );
  const key = yield* importProviderKey(file);
  const json = yield* encodeApnsProviderKeyJson(file).pipe(
    Effect.mapError((cause) => new ApnsProviderKeyError({ stage: "encode", cause })),
  );
  return { key, bytes: new TextEncoder().encode(json) };
});
