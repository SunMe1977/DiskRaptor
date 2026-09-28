#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"));
const csp = config.app?.security?.csp;

// The test server evaluates CDP expressions in the webview. Keep the normal
// CSP in tauri.conf.json and allow eval only in this test-server build.
if (typeof csp !== "string" || !/script-src 'self';/.test(csp)) {
  throw new Error("Expected the production script-src 'self' CSP directive");
}
const testCsp = csp.replace("script-src 'self';", "script-src 'self' 'unsafe-eval';");
const result = spawnSync(
  "cargo",
  ["build", "--manifest-path", "src-tauri/Cargo.toml", "--features", "test-server"],
  {
    cwd: root,
    env: {
      ...process.env,
      TAURI_CONFIG: JSON.stringify({ app: { security: { csp: testCsp } } }),
    },
    stdio: "inherit",
  },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
