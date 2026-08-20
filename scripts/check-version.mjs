#!/usr/bin/env node
/**
 * check-version.mjs — verifies the package version is consistent across all
 * files that carry it (package.json, package-lock.json, Cargo.toml/lock,
 * tauri.conf.json, NSIS installers). Exits non-zero on any mismatch so CI
 * catches a partial bump before a release is cut.
 */
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const VERSION = pkg.version;
if (!/^\d+\.\d+\.\d+$/.test(VERSION)) {
  console.error(`Bad package.json version: "${VERSION}"`);
  process.exit(1);
}

const failures = [];
function expect(name, actual) {
  if (actual !== VERSION) {
    failures.push(`${name}: expected "${VERSION}", got "${actual}"`);
  }
}

// package-lock.json: top-level and the root package entry.
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf8"));
expect("package-lock.json (root)", lock.version);
if (lock.packages && lock.packages[""]) {
  expect("package-lock.json packages['']", lock.packages[""].version);
}

// Cargo.toml
const cargoToml = fs.readFileSync(path.join(ROOT, "src-tauri", "Cargo.toml"), "utf8");
const cargoVer = /^version\s*=\s*"([^"]+)"/m.exec(cargoToml)?.[1];
expect("src-tauri/Cargo.toml", cargoVer);

// Cargo.lock — only the diskraptor crate entry.
const cargoLock = fs.readFileSync(path.join(ROOT, "src-tauri", "Cargo.lock"), "utf8");
const m = /name = "diskraptor"\nversion = "([^"]+)"/.exec(cargoLock);
expect("src-tauri/Cargo.lock (diskraptor)", m?.[1]);

// tauri.conf.json
const tauriConf = JSON.parse(fs.readFileSync(path.join(ROOT, "src-tauri", "tauri.conf.json"), "utf8"));
expect("src-tauri/tauri.conf.json", tauriConf.version);

// NSIS installers
for (const rel of ["installer/nsis/DiskRaptor.nsi", "installer/nsis/DiskRaptor-silent.nsi"]) {
  const nsi = fs.readFileSync(path.join(ROOT, rel), "utf8");
  const v = /PRODUCT_VERSION\s+"([^"]+)"/.exec(nsi)?.[1];
  expect(rel, v);
}

if (failures.length > 0) {
  console.error(`VERSION MISMATCH (expected ${VERSION}):`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`Version consistent: ${VERSION}`);
