import { defineConfig } from "@playwright/test";
import assert from "node:assert/strict";

assert.equal(process.env.AROOM_BROWSER_VERIFIED, "1", "Use the isolated browser runner");
const url = new URL(process.env.AROOM_BROWSER_URL!);
assert.equal(url.hostname, "127.0.0.1");
assert.equal(url.protocol, "http:");

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "acceptance.spec.ts",
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  outputDir: `${process.env.AROOM_BROWSER_EVIDENCE}/artifacts`,
  reporter: [["list"], ["json", { outputFile: `${process.env.AROOM_BROWSER_EVIDENCE}/results.json` }]],
  use: { baseURL: url.toString(), channel: "chrome", headless: true,
    viewport: { width: 1280, height: 800 }, hasTouch: true,
    screenshot: "only-on-failure", trace: "retain-on-failure" },
});
