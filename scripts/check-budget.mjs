#!/usr/bin/env node
/**
 * Frontend performance budget: fails CI when `frontend-dist/` grows past the
 * budget. Keeps bundle optimizations (bundling, lazy galaxy) from regressing
 * unnoticed. Run AFTER `node scripts/build-frontend.mjs`.
 *
 * Usage: node scripts/check-budget.mjs [--update-baseline]
 */
import * as fs from "fs";
import * as path from "path";
import { gzipSync } from "zlib";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DIST = path.join(ROOT, "frontend-dist");

// Budgets (bytes), split by category so a 1.7 MB PNG can't hide behind JS
// savings (and vice versa).
// - code: all text meant to be parsed (js/css/html/json), measured gzipped.
// - assets: binary payloads (images, fonts, .ico), measured raw (gzip does
//   not compress them, so raw size is the honest metric).
const BUDGETS = {
  codeGzip: 420 * 1024,
  assetsRaw: 700 * 1024,
  totalRaw: 1.6 * 1024 * 1024,
  // No single JS payload may exceed this (catches an accidental unminified
  // file or a debug bundle slipping into dist).
  maxSingleJsRaw: 900 * 1024,
};

const CODE_EXT = new Set([".js", ".mjs", ".css", ".html", ".json", ".svg"]);

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

if (!fs.existsSync(DIST)) {
  console.error(`frontend-dist/ missing — run 'node scripts/build-frontend.mjs' first`);
  process.exit(1);
}

const files = walk(DIST);
let totalRaw = 0;
let codeGzip = 0;
let assetsRaw = 0;
let worstJs = { file: "", size: 0 };
for (const f of files) {
  const buf = fs.readFileSync(f);
  totalRaw += buf.length;
  const ext = path.extname(f).toLowerCase();
  if (CODE_EXT.has(ext)) {
    codeGzip += gzipSync(buf, { level: 9 }).length;
  } else {
    assetsRaw += buf.length;
  }
  if ((ext === ".js" || ext === ".mjs") && buf.length > worstJs.size) {
    worstJs = { file: path.relative(DIST, f), size: buf.length };
  }
}

const fmt = (n) => `${(n / 1024).toFixed(1)} KB`;
let failed = false;
const check = (label, actual, budget) => {
  const ok = actual <= budget;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}: ${fmt(actual)} (budget ${fmt(budget)})`);
  if (!ok) failed = true;
};

console.log("Frontend perf budget (frontend-dist/):");
console.log(`  files: ${files.length}`);
check("code gzip  ", codeGzip, BUDGETS.codeGzip);
check("assets raw ", assetsRaw, BUDGETS.assetsRaw);
check("total raw  ", totalRaw, BUDGETS.totalRaw);
console.log(`  largest js: ${worstJs.file} (${fmt(worstJs.size)})`);
check("max single js raw", worstJs.size, BUDGETS.maxSingleJsRaw);

if (failed) {
  console.error("\nBudget exceeded: shrink frontend-dist (bundle, lazy-load, drop dead code).");
  process.exit(1);
}
console.log("\nAll budgets OK.");
