// Cross-platform JS syntax check: runs `node --check` over every frontend
// script (replaces the old Unix-only `for f in frontend/*.js` loop).
import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const roots = ["frontend", "tests"];
const exts = new Set([".js", ".mjs", ".cjs"]);

function collect(dir, out) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry === "node_modules") continue;
    if (statSync(full).isDirectory()) collect(full, out);
    else if (exts.has(entry.slice(entry.lastIndexOf(".")))) out.push(full);
  }
}

const files = [];
for (const root of roots) collect(root, files);
files.sort();

let failed = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ["--check", f], { stdio: "ignore" });
  } catch {
    console.error(`SYNTAX ERROR: ${f}`);
    failed++;
  }
}
if (failed > 0) {
  console.error(`${failed} file(s) failed syntax check`);
  process.exit(1);
}
console.log(`Syntax OK (${files.length} files)`);
