// "Open in app" Android package (WEB-12/WEB-13). No server, no browser, no network. Runs in `npm run test:static`.
// The intent:// links on /l/* must name the package Android App Links verify, or Chrome opens a Play-Store dead end:
//   1. APP_PACKAGE (src/lib/appLinks.ts) == package_name in public/.well-known/assetlinks.json
//   2. APP_PACKAGE == the mobile prod applicationId (android/app/build.gradle.kts, when the mobile repo is checked out)
//   3. the pinned literal `com.beautica.app` still holds (so a matching drift of all sources is caught too)
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./helpers/env.mjs";
import { siblingPath, mobileGate } from "./helpers/backend.mjs";

const PINNED = "com.beautica.app";
const read = (rel) => readFileSync(process.env.APP_LINKS_TS && rel.endsWith("appLinks.ts") ? process.env.APP_LINKS_TS : join(ROOT, rel), "utf8");
const appPackage = /export const APP_PACKAGE = "([^"]+)"/.exec(read("src/lib/appLinks.ts"))?.[1];
const gradle = siblingPath("../beautica-mobile/android/app/build.gradle.kts");

describe("open-in-app Android package", () => {
  test("APP_PACKAGE is declared", () => assert.ok(appPackage, "APP_PACKAGE constant not found in src/lib/appLinks.ts"));

  test("APP_PACKAGE == pinned production package", () => assert.equal(appPackage, PINNED));

  test("APP_PACKAGE == assetlinks.json package_name", () => {
    const links = JSON.parse(read("public/.well-known/assetlinks.json"));
    const names = links.filter((l) => l.target?.namespace === "android_app").map((l) => l.target.package_name);
    assert.deepEqual(names, [appPackage]);
  });

  test("APP_PACKAGE == mobile prod applicationId", { skip: !mobileGate(gradle) && "beautica-mobile not checked out: package pinned above" }, () => {
    const g = readFileSync(gradle, "utf8");
    const prod = /val prodApplicationId = "([^"]+)"/.exec(g)?.[1];
    assert.match(g, /applicationId = prodApplicationId/, "defaultConfig no longer uses prodApplicationId");
    assert.equal(prod, appPackage);
  });
});
