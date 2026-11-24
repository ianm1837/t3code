import { describe, expect, it } from "@effect/vitest";

import { sanitizeApnsNotificationPayload } from "./agentActivityNotifications.ts";

describe("sanitizeApnsNotificationPayload", () => {
  it("never cuts an emoji in half at the title limit", () => {
    const notification = sanitizeApnsNotificationPayload({
      title: "😀".repeat(120),
      body: "body",
      environmentId: "environment",
      threadId: "thread",
      deepLink: "t3code://thread",
    });
    expect(notification.title).toBe(`${"😀".repeat(58)}...`);
  });
});
