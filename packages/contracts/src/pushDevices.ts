import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { RelayApnsEnvironment } from "./relay.ts";

export const ApnsDeviceToken = TrimmedNonEmptyString.check(Schema.isPattern(/^[0-9a-f]{64,200}$/));
export type ApnsDeviceToken = typeof ApnsDeviceToken.Type;

export const PushAlertPreferences = Schema.Struct({
  notifyOnCompletion: Schema.Boolean,
  notifyOnFailure: Schema.Boolean,
  notifyOnApproval: Schema.Boolean,
  notifyOnInput: Schema.Boolean,
});
export type PushAlertPreferences = typeof PushAlertPreferences.Type;

export const PushDeviceRegistration = Schema.Struct({
  deviceId: TrimmedNonEmptyString,
  token: ApnsDeviceToken,
  topic: TrimmedNonEmptyString,
  apsEnvironment: RelayApnsEnvironment,
  label: TrimmedNonEmptyString,
  appVersion: Schema.optional(TrimmedNonEmptyString),
  preferences: Schema.optional(PushAlertPreferences),
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

export const PushThreadNotificationLevel = Schema.Literals(["all", "needs-me", "off"]);
export type PushThreadNotificationLevel = typeof PushThreadNotificationLevel.Type;

export const PushThreadNotificationLevelEntry = Schema.Struct({
  threadId: ThreadId,
  level: PushThreadNotificationLevel,
});
export type PushThreadNotificationLevelEntry = typeof PushThreadNotificationLevelEntry.Type;

export const PushThreadNotificationLevelList = Schema.Struct({
  threads: Schema.Array(PushThreadNotificationLevelEntry),
});
export type PushThreadNotificationLevelList = typeof PushThreadNotificationLevelList.Type;

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
