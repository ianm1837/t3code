import * as NodeHttp2 from "node:http2";

import { RelayApnsEnvironment } from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

const APNS_STAGE_TIMEOUT = "10 seconds";
const APNS_STAGE_TIMEOUT_MS = 10_000;

const ApnsTransportStage = Schema.Literals(["connect", "send", "read-response"]);
type ApnsTransportStage = typeof ApnsTransportStage.Type;

export class ApnsTransportError extends Schema.TaggedError<ApnsTransportError>()(
  "ApnsTransportError",
  {
    environment: RelayApnsEnvironment,
    stage: ApnsTransportStage,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `APNs ${this.environment} request failed during ${this.stage}.`;
  }
}

export interface ApnsTransportResponse {
  readonly status: number;
  readonly apnsId: string | null;
  readonly body: string;
}

export class ApnsTransport extends Context.Service<
  ApnsTransport,
  {
    readonly post: (input: {
      readonly environment: RelayApnsEnvironment;
      readonly path: string;
      readonly headers: Readonly<Record<string, string>>;
      readonly body: string;
    }) => Effect.Effect<ApnsTransportResponse, ApnsTransportError>;
  }
>()("t3/push/ApnsTransport") {}

export const makeApnsTransport = Effect.fn("ApnsTransport.make")(function* (input: {
  readonly originFor: (environment: RelayApnsEnvironment) => string;
}): Effect.fn.Return<ApnsTransport["Service"], never, Scope.Scope> {
  const sessions = new Map<string, NodeHttp2.ClientHttp2Session>();

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const session of sessions.values()) session.close();
      sessions.clear();
    }),
  );

  const openSession = (origin: string) => {
    const session = NodeHttp2.connect(origin);
    const evict = () => {
      if (sessions.get(origin) === session) sessions.delete(origin);
    };
    session.on("error", evict);
    session.on("goaway", evict);
    session.on("close", evict);
    sessions.set(origin, session);
    return session;
  };

  const connectedSession = Effect.fn("ApnsTransport.connect")(function* (
    environment: RelayApnsEnvironment,
  ) {
    const connectError = (cause: unknown) =>
      new ApnsTransportError({ environment, stage: "connect", cause });
    const session = yield* Effect.try({
      try: () => {
        const origin = input.originFor(environment);
        const cached = sessions.get(origin);
        return cached !== undefined && !cached.closed && !cached.destroyed
          ? cached
          : openSession(origin);
      },
      catch: connectError,
    });
    if (!session.connecting) return session;
    return yield* Effect.callback<NodeHttp2.ClientHttp2Session, ApnsTransportError>((resume) => {
      const onConnect = () => {
        cleanup();
        resume(Effect.succeed(session));
      };
      const onError = (cause: Error) => {
        cleanup();
        resume(Effect.fail(connectError(cause)));
      };
      const onClose = () => onError(new Error("APNs connection closed before it was ready."));
      const cleanup = () => {
        session.off("connect", onConnect);
        session.off("error", onError);
        session.off("close", onClose);
      };
      session.once("connect", onConnect);
      session.once("error", onError);
      session.once("close", onClose);
      return Effect.sync(cleanup);
    }).pipe(
      Effect.timeoutOrElse({
        duration: APNS_STAGE_TIMEOUT,
        orElse: () =>
          Effect.sync(() => session.destroy()).pipe(
            Effect.andThen(Effect.fail(connectError(new Error("APNs connection timed out.")))),
          ),
      }),
    );
  });

  const request = (requestInput: {
    readonly environment: RelayApnsEnvironment;
    readonly session: NodeHttp2.ClientHttp2Session;
    readonly path: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
  }) =>
    Effect.callback<ApnsTransportResponse, ApnsTransportError>((resume) => {
      let stage: ApnsTransportStage = "send";
      let settled = false;
      const fail = (cause: unknown) => {
        if (settled) return;
        settled = true;
        resume(
          Effect.fail(
            new ApnsTransportError({ environment: requestInput.environment, stage, cause }),
          ),
        );
      };
      let stream: NodeHttp2.ClientHttp2Stream;
      try {
        stream = requestInput.session.request({
          ...requestInput.headers,
          ":method": "POST",
          ":path": requestInput.path,
        });
      } catch (cause) {
        fail(cause);
        return;
      }
      let status = 0;
      let apnsId: string | null = null;
      let body = "";
      stream.setEncoding("utf8");
      stream.setTimeout(APNS_STAGE_TIMEOUT_MS, () => {
        fail(new Error("APNs stream timed out."));
        stream.close(NodeHttp2.constants.NGHTTP2_CANCEL);
      });
      stream.on("response", (headers) => {
        stage = "read-response";
        status = Number(headers[":status"]);
        const id = headers["apns-id"];
        apnsId = typeof id === "string" ? id : null;
      });
      stream.on("data", (chunk: string) => {
        body += chunk;
      });
      stream.on("end", () => {
        if (settled) return;
        settled = true;
        resume(Effect.succeed({ status, apnsId, body }));
      });
      stream.on("error", fail);
      stream.on("close", () => fail(new Error("APNs stream closed before the response ended.")));
      stream.end(requestInput.body);
      return Effect.sync(() => {
        settled = true;
        if (!stream.closed) stream.close(NodeHttp2.constants.NGHTTP2_CANCEL);
      });
    });

  const post: ApnsTransport["Service"]["post"] = Effect.fn("ApnsTransport.post")(
    function* (postInput) {
      yield* Effect.annotateCurrentSpan({ "apns.environment": postInput.environment });
      const session = yield* connectedSession(postInput.environment);
      return yield* request({ ...postInput, session });
    },
  );

  return ApnsTransport.of({ post });
});

export const layer = Layer.effect(
  ApnsTransport,
  makeApnsTransport({
    originFor: (environment) =>
      environment === "production"
        ? "https://api.push.apple.com"
        : "https://api.sandbox.push.apple.com",
  }),
);
