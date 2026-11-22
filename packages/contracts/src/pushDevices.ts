import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { RelayApnsEnvironment } from "./relay.ts";

export const ApnsDeviceToken = TrimmedNonEmptyString.check(Schema.isPattern(/^[0-9a-f]{64,200}$/));
export type ApnsDeviceToken = typeof ApnsDeviceToken.Type;

export const PushDeviceRegistration = Schema.Struct({
  deviceId: TrimmedNonEmptyString,
  token: ApnsDeviceToken,
  topic: TrimmedNonEmptyString,
  apsEnvironment: RelayApnsEnvironment,
  label: TrimmedNonEmptyString,
  appVersion: Schema.optional(TrimmedNonEmptyString),
});
export type PushDeviceRegistration = typeof PushDeviceRegistration.Type;

export const PushDeviceRegisterResult = Schema.Struct({
  deliveryConfigured: Schema.Boolean,
});
export type PushDeviceRegisterResult = typeof PushDeviceRegisterResult.Type;

export const PushDeviceUnregisterInput = Schema.Struct({
  deviceId: TrimmedNonEmptyString,
});
export type PushDeviceUnregisterInput = typeof PushDeviceUnregisterInput.Type;

export class PushDeviceRegistryError extends Schema.TaggedError<PushDeviceRegistryError>()(
  "PushDeviceRegistryError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Unable to update the push device registry";
  }
}
