import { DEFAULT_HOSTED_APP_URL } from "@t3tools/shared/connectAuth";
import { afterEach, expect, it, vi } from "vite-plus/test";

import appleAppSiteAssociation from "../web/public/.well-known/apple-app-site-association.json";
import assetLinks from "../web/public/.well-known/assetlinks.json";

// Keep config parsing independent of local env files and build credentials.
vi.mock("../../scripts/lib/public-config.ts", () => ({
  loadRepoEnv: () =>
    Object.fromEntries(
      ["APP_VARIANT", "T3CODE_IOS_BUNDLE_ID", "T3CODE_IOS_TEAM_ID", "T3CODE_IOS_APS_ENVIRONMENT"]
        .map((name) => [name, process.env[name]])
        .filter(([, value]) => value !== undefined),
    ),
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

async function loadConfig(variant: string | undefined) {
  vi.resetModules();
  vi.stubEnv("APP_VARIANT", variant);
  return (await import("./app.config.ts")).default;
}

it.each(["prod", ""])("rejects APP_VARIANT=%j before selecting production IDs", async (value) => {
  await expect(loadConfig(value)).rejects.toThrow(
    "APP_VARIANT must be development, preview, or production.",
  );
});

it.each([
  [undefined, "com.t3tools.t3code"],
  ["development", "com.t3tools.t3code.dev"],
  ["preview", "com.t3tools.t3code.preview"],
  ["production", "com.t3tools.t3code"],
])("keeps the iOS and Android identifiers for APP_VARIANT=%j", async (value, identifier) => {
  const config = await loadConfig(value);
  expect(config.ios?.bundleIdentifier).toBe(identifier);
  expect(config.android?.package).toBe(identifier);
  // Copied thread links open this app only while app.t3.codes lists it.
  const host = new URL(DEFAULT_HOSTED_APP_URL).host;
  expect(config.ios?.associatedDomains).toContain(`applinks:${host}`);
  expect(appleAppSiteAssociation.applinks.details[0]?.appIDs).toContain(
    `${config.ios?.appleTeamId}.${identifier}`,
  );
  expect(config.android?.intentFilters?.[0]?.data).toEqual([
    { scheme: "https", host, pathPrefix: "/threads/" },
  ]);
  expect(assetLinks.map((link) => link.target.package_name)).toContain(identifier);
});

it("signs an own-identity build with its team and direct push", async () => {
  vi.stubEnv("T3CODE_IOS_BUNDLE_ID", "com.example.t3code");
  vi.stubEnv("T3CODE_IOS_TEAM_ID", "ABCDE12345");
  const config = await loadConfig("production");
  const plugins = new Map(
    (config.plugins ?? []).map((plugin) =>
      typeof plugin === "string" ? [plugin, undefined] : [plugin[0], plugin[1]],
    ),
  );
  expect(config.ios?.bundleIdentifier).toBe("com.example.t3code");
  expect(config.ios?.appleTeamId).toBe("ABCDE12345");
  expect(config.ios?.associatedDomains).toBeUndefined();
  expect(plugins.get("expo-notifications")).toMatchObject({ mode: "development" });
  expect(plugins.get("@clerk/expo")).toMatchObject({ appleSignIn: false });
  expect(plugins.get("expo-widgets")).toMatchObject({
    bundleIdentifier: "com.example.t3code.widgets",
    groupIdentifier: "group.com.example.t3code",
  });
  expect(plugins.get("expo-sharing")).toMatchObject({
    ios: { enabled: true, extensionBundleIdentifier: "com.example.t3code.sharing" },
  });
  expect(config.extra?.apsEnvironment).toBe("sandbox");
  expect(config.extra?.push).toEqual({ mode: "direct" });
});
