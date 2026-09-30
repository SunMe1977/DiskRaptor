#!/usr/bin/env node
/**
 * bump-version.mjs — bump the version in all files that carry it.
 *
 * Usage: node scripts/bump-version.mjs <new-version>
 * Example: node scripts/bump-version.mjs 1.0.43
 *
 * Updates:
 *   package.json, package-lock.json, src-tauri/tauri.conf.json,
 *   src-tauri/Cargo.toml, src-tauri/Cargo.lock,
 *   installer/nsis/DiskRaptor.nsi, installer/nsis/DiskRaptor-silent.nsi
 *
 * After updating, runs `cargo update -p diskraptor` to refresh Cargo.lock
 * and then validates consistency with scripts/check-version.mjs.
 */
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const args = process.argv.slice(2);
if (args.length !== 1 || !/^\d+\.\d+\.\d+$/.test(args[0])) {
  console.error("Usage: node scripts/bump-version.mjs <new-version>");
  console.error("Example: node scripts/bump-version.mjs 1.0.43");
  process.exit(1);
}

const NEW_VERSION = args[0];

function updateJSON(filePath, updateFn) {
  const full = path.join(ROOT, filePath);
  const data = JSON.parse(fs.readFileSync(full, "utf8"));
  updateFn(data);
  fs.writeFileSync(full, JSON.stringify(data, null, 2) + "\n");
  console.log(`Updated ${filePath} -> ${NEW_VERSION}`);
}

function updateText(filePath, regex, replacement) {
  const full = path.join(ROOT, filePath);
  let content = fs.readFileSync(full, "utf8");
  const newContent = content.replace(regex, replacement);
  if (newContent === content) {
    console.error(`ERROR: pattern not found in ${filePath}`);
    process.exit(1);
  }
  fs.writeFileSync(full, newContent);
  console.log(`Updated ${filePath} -> ${NEW_VERSION}`);
}

// 1. package.json
updateJSON("package.json", (d) => { d.version = NEW_VERSION; });

// 2. package-lock.json — top-level version + root package entry
updateJSON("package-lock.json", (d) => {
  d.version = NEW_VERSION;
  if (d.packages && d.packages[""]) {
    d.packages[""].version = NEW_VERSION;
  }
});

// 3. tauri.conf.json
updateJSON("src-tauri/tauri.conf.json", (d) => { d.version = NEW_VERSION; });

// 4. Cargo.toml
updateText("src-tauri/Cargo.toml", /^version\s*=\s*"[^"]+"/m, `version = "${NEW_VERSION}"`);

// 5. Cargo.lock — diskraptor crate entry
updateText("src-tauri/Cargo.lock", /(name = "diskraptor"\nversion = ")[^"]+/, `$1${NEW_VERSION}`);

// 6. NSIS installers
updateText("installer/nsis/DiskRaptor.nsi", /(!define PRODUCT_VERSION ")[^"]+/, `$1${NEW_VERSION}`);
updateText("installer/nsis/DiskRaptor-silent.nsi", /(!define PRODUCT_VERSION ")[^"]+/, `$1${NEW_VERSION}`);

// 7. Refresh Cargo.lock dependencies
console.log("Running cargo update -p diskraptor...");
try {
  execSync("cargo update -p diskraptor", { cwd: ROOT, stdio: "inherit" });
} catch {
  console.warn("WARNING: cargo update failed (is Rust installed?). Cargo.lock may need manual update.");
}

// 8. Validate consistency
console.log("Validating version consistency...");
try {
  execSync("node scripts/check-version.mjs", { cwd: ROOT, stdio: "inherit" });
} catch {
  console.error("VERSION CONSISTENCY CHECK FAILED — please review the changes above.");
  process.exit(1);
}

console.log(`\nVersion bumped to ${NEW_VERSION} successfully.`);