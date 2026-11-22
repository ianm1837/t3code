import { useAtomValue } from "@effect/atom-react";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import {
  WS_METHODS,
  type EnvironmentId,
  type PushThreadNotificationLevel,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../../connection/runtime";
import { supportsDirectPush } from "./capabilities";

const threadNotificationLevelsQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "mobile:push:thread-notification-levels",
  tag: WS_METHODS.pushListThreadNotificationLevels,
});

const unsupportedLevelsAtom = Atom.make(AsyncResult.initial()).pipe(
  Atom.withLabel("mobile:push:thread-notification-levels:unsupported"),
);

export const setThreadNotificationLevel = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mobile:push:set-thread-notification-level",
  tag: WS_METHODS.pushSetThreadNotificationLevel,
  onSuccess: ({ environmentId }, registry) =>
    Effect.sync(() =>
      registry.refresh(threadNotificationLevelsQuery({ environmentId, input: {} })),
    ),
});

export function useThreadNotificationLevel({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}): PushThreadNotificationLevel | null {
  const result = useAtomValue(
    supportsDirectPush()
      ? threadNotificationLevelsQuery({ environmentId, input: {} })
      : unsupportedLevelsAtom,
  );
  if (!AsyncResult.isSuccess(result)) return null;
  return result.value.threads.find((entry) => entry.threadId === threadId)?.level ?? "all";
}
