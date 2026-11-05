import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse, UrlParams } from "effect/http";
import { describe, expect, it } from "vite-plus/test";

import * as ClaudeResetCredits from "./claudeResetCredits.ts";
import { claudeRateLimitEventToUpdate, makeClaudeScopedLimitNames } from "./claudeUsageLimits.ts";

const NOW = Date.parse("2026-09-22T12:00:00.000Z");
const grant = (overrides: Record<string, unknown>) => ({
  id: "grant_a",
  resets_left: 1,
  usable_now: true,
  ...overrides,
});

const writeLogin = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped();
  yield* fs.writeFileString(
    path.join(directory, ".credentials.json"),
    '{"claudeAiOauth":{"accessToken":"oauth-token"}}',
  );
  const accountConfigPath = path.join(directory, ".claude.json");
  yield* fs.writeFileString(accountConfigPath, '{"oauthAccount":{"organizationUuid":"org-1"}}');
  return { configDir: directory, accountConfigPath };
});

const respond = (status: number, body: unknown) =>
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(body, { status }))),
  );
const refuseRequests = HttpClient.make(() => Effect.die("must not send a request"));

describe("claudeResetCreditsToContract", () => {
  it("counts live grants and pins the next usable one", () => {
    expect(
      ClaudeResetCredits.claudeResetCreditsToContract(
        {
          eligible: true,
          next_grant_id: "grant_a",
          grants: [
            grant({ resets_left: 2, ends_at: "2026-10-01T00:00:00Z" }),
            grant({ id: "paused", paused: true }),
            grant({ id: "expired", ends_at: "2026-09-01T00:00:00Z" }),
            grant({ id: "garbled", ends_at: "not a date" }),
            grant({ id: "date_only", ends_at: "2026-10-01" }),
            grant({ id: "impossible", ends_at: "2027-02-30T00:00:00Z" }),
            grant({ id: "empty", ends_at: "" }),
            grant({ id: "Not Valid" }),
            grant({ id: "grant_b", resets_left: 3, usable_now: false }),
          ],
        },
        NOW,
      ),
    ).toEqual({
      availableCount: 2,
      nextCreditId: "grant_a",
      nextExpiresAt: "2026-10-01T00:00:00.000Z",
    });
  });

  it("offers nothing to redeem without a usable next grant or an eligible account", () => {
    expect(
      ClaudeResetCredits.claudeResetCreditsToContract(
        { eligible: true, next_grant_id: "grant_a", grants: [grant({ usable_now: false })] },
        NOW,
      ),
    ).toEqual({ availableCount: 0 });
    expect(
      ClaudeResetCredits.claudeResetCreditsToContract({ eligible: true, grants: [grant({})] }, NOW),
    ).toEqual({
      availableCount: 0,
    });
    expect(
      ClaudeResetCredits.claudeResetCreditsToContract(
        { eligible: false, grants: [grant({})] },
        NOW,
      ),
    ).toBeUndefined();
    expect(ClaudeResetCredits.claudeResetCreditsToContract(undefined, NOW)).toBeUndefined();
  });
});

effectIt.layer(NodeServices.layer)("readClaudeResetCredits", (it) => {
  it.effect("reads the grants and usage windows with the CLI's request", () =>
    Effect.gen(function* () {
      const { configDir } = yield* writeLogin;
      const client = HttpClient.make((request) => {
        expect(request.method).toBe("GET");
        expect(request.url).toBe("https://api.anthropic.com/api/oauth/usage");
        expect(UrlParams.toString(request.urlParams)).toBe("cedar_ember=1&skip_spend=1");
        expect(request.headers.authorization).toBe("Bearer oauth-token");
        expect(request.headers["anthropic-beta"]).toBe("oauth-2025-04-20");
        expect(request.headers["user-agent"]).toBe("claude-cli/2.1.0 (external, cli)");
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({
              cedar_ember: { eligible: true, next_grant_id: "grant_a", grants: [grant({})] },
              five_hour: { utilization: 40, resets_at: "2026-09-22T17:00:00Z" },
              seven_day: { utilization: "unknown" },
              limits: [
                {
                  kind: "weekly_scoped",
                  percent: 73,
                  resets_at: "2026-09-24T09:00:00Z",
                  scope: { model: { display_name: "Fable" } },
                },
                { kind: "weekly_scoped", percent: "high", scope: { model: {} } },
              ],
            }),
          ),
        );
      });
      const credits = yield* ClaudeResetCredits.readClaudeResetCredits(configDir, "2.1.0").pipe(
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HttpClient.HttpClient, client),
      );
      const scopedLimitNames = yield* makeClaudeScopedLimitNames;
      const login = yield* ClaudeResetCredits.makeClaudeLoginUsage({
        configDir,
        scopedLimitNames,
      });
      yield* login.requestRefresh;
      const limits = yield* login
        .read("2.1.0")
        .pipe(
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.provideService(HttpClient.HttpClient, client),
        );
      expect(credits).toEqual({ availableCount: 1, nextCreditId: "grant_a" });
      expect(limits?.windows).toEqual([
        {
          id: "five_hour",
          kind: "session",
          label: "Session",
          windowDurationMins: 300,
          usedPercent: 40,
          resetsAt: "2026-09-22T17:00:00.000Z",
        },
        {
          id: "seven_day_fable",
          kind: "weekly",
          label: "Weekly · Fable",
          windowDurationMins: 10080,
          usedPercent: 73,
          resetsAt: "2026-09-24T09:00:00.000Z",
        },
      ]);
      expect(
        claudeRateLimitEventToUpdate(
          {
            status: "allowed",
            rateLimitType: "seven_day_overage_included" as never,
            utilization: 0.8,
          },
          yield* Ref.get(scopedLimitNames),
        )?.windows.map((window) => [window.id, window.usedPercent]),
      ).toEqual([["seven_day_fable", 80]]);
    }),
  );

  it.effect("reads nothing from keychain logins or failed requests", () =>
    Effect.gen(function* () {
      const { configDir } = yield* writeLogin;
      const darwin = yield* ClaudeResetCredits.readClaudeResetCredits(configDir, "2.1.0").pipe(
        Effect.provideService(HostProcess.Platform, "darwin"),
        Effect.provideService(HttpClient.HttpClient, refuseRequests),
      );
      const limited = yield* ClaudeResetCredits.readClaudeResetCredits(configDir, "2.1.0").pipe(
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HttpClient.HttpClient, respond(429, {})),
      );
      const login = yield* ClaudeResetCredits.makeClaudeLoginUsage({
        configDir,
        scopedLimitNames: yield* makeClaudeScopedLimitNames,
      });
      yield* login.requestRefresh;
      const darwinLimits = yield* login
        .read("2.1.0")
        .pipe(
          Effect.provideService(HostProcess.Platform, "darwin"),
          Effect.provideService(HttpClient.HttpClient, refuseRequests),
        );
      expect([darwin, limited, darwinLimits]).toEqual([undefined, undefined, undefined]);
    }),
  );
});

const usageBody = (utilization: number) => ({ five_hour: { utilization, resets_at: null } });
const sessionPercent = (
  limits: { readonly windows: ReadonlyArray<{ readonly usedPercent: number }> } | undefined,
) => limits?.windows[0]?.usedPercent;

effectIt.layer(NodeServices.layer)("makeClaudeLoginUsage", (it) => {
  it.effect("asks the endpoint only on an explicit refresh, at most every five minutes", () =>
    Effect.gen(function* () {
      const { configDir } = yield* writeLogin;
      let requests = 0;
      const client = HttpClient.make((request) => {
        requests += 1;
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, Response.json(usageBody(10 * requests))),
        );
      });
      const login = yield* ClaudeResetCredits.makeClaudeLoginUsage({
        configDir,
        scopedLimitNames: yield* makeClaudeScopedLimitNames,
      });
      const read = login
        .read("2.1.0")
        .pipe(
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.provideService(HttpClient.HttpClient, client),
        );
      const refresh = login.requestRefresh.pipe(Effect.andThen(read));

      expect(yield* read).toBeUndefined();
      expect(sessionPercent(yield* refresh)).toBe(10);
      expect(sessionPercent(yield* refresh)).toBe(10);
      expect(sessionPercent(yield* read)).toBe(10);
      expect(requests).toBe(1);

      yield* TestClock.adjust("5 minutes");
      yield* login.record({
        checkedAt: "1970-01-01T00:05:00.000Z",
        windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent: 55 }],
      });
      expect(yield* refresh).toMatchObject({ checkedAt: "1970-01-01T00:05:00.000Z" });
      expect(sessionPercent(yield* refresh)).toBe(55);
      expect(requests).toBe(1);

      yield* TestClock.adjust("5 minutes");
      expect(sessionPercent(yield* read)).toBe(55);
      expect(sessionPercent(yield* refresh)).toBe(20);
      expect(requests).toBe(2);
    }),
  );

  it.effect("waits out a rate limit and keeps the last reading meanwhile", () =>
    Effect.gen(function* () {
      const { configDir } = yield* writeLogin;
      const answers = [
        () => Response.json(usageBody(30)),
        () => new Response(null, { status: 429, headers: { "retry-after": "3600" } }),
        () => Response.json(usageBody(40)),
      ];
      let requests = 0;
      const client = HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, answers[requests++]!())),
      );
      const login = yield* ClaudeResetCredits.makeClaudeLoginUsage({
        configDir,
        scopedLimitNames: yield* makeClaudeScopedLimitNames,
      });
      const refresh = login.requestRefresh.pipe(
        Effect.andThen(login.read("2.1.0")),
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HttpClient.HttpClient, client),
      );

      const first = yield* refresh;
      expect(sessionPercent(first)).toBe(30);
      yield* TestClock.adjust("5 minutes");
      expect(yield* refresh).toBe(first);
      expect(requests).toBe(2);
      yield* TestClock.adjust("59 minutes");
      expect(yield* refresh).toBe(first);
      expect(requests).toBe(2);
      yield* TestClock.adjust("1 minute");
      expect(sessionPercent(yield* refresh)).toBe(40);
      expect(requests).toBe(3);
    }),
  );
});

const ClaimBody = Schema.fromJsonString(
  Schema.Struct({ program: Schema.String, grant_id: Schema.String, request_id: Schema.String }),
);
const decodeClaimBody = Schema.decodeEffect(ClaimBody);

const consume = (client: HttpClient.HttpClient, ids = { grantId: "grant_a", requestId: "r-1" }) =>
  Effect.gen(function* () {
    const login = yield* writeLogin;
    return yield* ClaudeResetCredits.consumeClaudeResetCredit({
      ...login,
      version: "2.1.0",
      ...ids,
    }).pipe(
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HttpClient.HttpClient, client),
      Effect.result,
    );
  });

effectIt.layer(NodeServices.layer)("consumeClaudeResetCredit", (it) => {
  it.effect("claims the grant for the organization", () =>
    Effect.gen(function* () {
      const client = HttpClient.make((request) =>
        Effect.gen(function* () {
          expect(request.method).toBe("POST");
          expect(request.url).toBe(
            "https://api.anthropic.com/api/organizations/org-1/reset_rate_limits",
          );
          expect(request.headers.authorization).toBe("Bearer oauth-token");
          const body =
            request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
          expect(yield* decodeClaimBody(body)).toEqual({
            program: "cedar_ember",
            grant_id: "grant_a",
            request_id: "r-1",
          });
          return HttpClientResponse.fromWeb(request, Response.json({ result: "reset" }));
        }).pipe(Effect.orDie),
      );
      expect(yield* consume(client)).toMatchObject({ _tag: "Success", success: "reset" });
    }),
  );

  it.effect("maps each answer to an outcome or a failure", () =>
    Effect.gen(function* () {
      for (const [result, outcome] of [
        ["not_limited", "nothingToReset"],
        ["already_used", "alreadyRedeemed"],
        ["ineligible", "noCredit"],
      ] as const) {
        expect(yield* consume(respond(200, { result }))).toMatchObject({ success: outcome });
      }
      for (const client of [
        respond(200, { result: "cooldown" }),
        respond(429, {}),
        respond(401, {}),
      ]) {
        const result = yield* consume(client);
        expect(result).toMatchObject({ _tag: "Failure" });
        if (result._tag === "Failure") {
          expect(ClaudeResetCredits.isSettledClaudeResetCreditFailure(result.failure)).toBe(true);
        }
      }
      for (const client of [respond(500, {}), respond(200, { result: "unavailable" })]) {
        const unanswered = yield* consume(client);
        expect(unanswered).toMatchObject({ _tag: "Failure" });
        if (unanswered._tag === "Failure") {
          expect(ClaudeResetCredits.isSettledClaudeResetCreditFailure(unanswered.failure)).toBe(
            false,
          );
        }
      }
    }),
  );

  it.effect("refuses malformed ids without sending anything", () =>
    Effect.gen(function* () {
      for (const ids of [
        { grantId: "Bad Grant", requestId: "r-1" },
        { grantId: "grant_a", requestId: "has space" },
      ]) {
        expect(yield* consume(refuseRequests, ids)).toMatchObject({ _tag: "Failure" });
      }
    }),
  );
});
