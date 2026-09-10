#!/usr/bin/env node
"use strict";
// i18n coverage audit — diffs every language file against en.js.
// Reports: missing keys, extra keys, duplicate keys, empty values.
// Exit 0 = clean, exit 1 = issues found.

const fs = require("fs");
const path = require("path");

const I18N_DIR = path.join(process.cwd(), "frontend", "i18n");
const EN_FILE = path.join(I18N_DIR, "en.js");

function loadKeys(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const match = content.match(/window\.I18N_DATA\[.*?\]\s*=\s*(\{[\s\S]*?\});/);
  if (!match) return { keys: new Set(), raw: {} };
  try {
    const obj = JSON.parse(match[1].replace(/"/g, '"'));
    const keys = new Set();
    function walk(o, prefix) {
      for (const k of Object.keys(o)) {
        const full = prefix ? `${prefix}.${k}` : k;
        if (typeof o[k] === "string") {
          keys.add(full);
        } else if (o[k] && typeof o[k] === "object") {
          walk(o[k], full);
        }
      }
    }
    walk(obj, "");
    return { keys, raw: obj };
  } catch {
    return { keys: new Set(), raw: {} };
  }
}

function dotGet(obj, dotted) {
  const parts = dotted.split(".");
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[p];
  }
  return cur;
}

const { keys: enKeys, raw: enRaw } = loadKeys(EN_FILE);
const langFiles = fs.readdirSync(I18N_DIR).filter((f) => f.endsWith(".js") && f !== "en.js" && f !== "ui-extra.js");

let totalIssues = 0;

for (const file of langFiles.sort()) {
  const filePath = path.join(I18N_DIR, file);
  const { keys: locKeys, raw: locRaw } = loadKeys(filePath);
  const code = file.replace(".js", "");

  const missing = [...enKeys].filter((k) => !locKeys.has(k));
  const extra = [...locKeys].filter((k) => !enKeys.has(k));
  const empty = [...locKeys].filter((k) => {
    const v = dotGet(locRaw, k);
    return v === "" || v == null;
  });

  const issues = [];
  if (missing.length) issues.push(`  MISSING (${missing.length}): ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? ` ... +${missing.length - 10}` : ""}`);
  if (extra.length) issues.push(`  EXTRA (${extra.length}): ${extra.slice(0, 10).join(", ")}${extra.length > 10 ? ` ... +${extra.length - 10}` : ""}`);
  if (empty.length) issues.push(`  EMPTY (${empty.length}): ${empty.slice(0, 10).join(", ")}${empty.length > 10 ? ` ... +${empty.length - 10}` : ""}`);

  if (issues.length) {
    totalIssues += issues.length;
    console.log(`\x1b[33m${code}:\x1b[0m`);
    issues.forEach((l) => console.log(l));
  } else {
    console.log(`\x1b[32m${code}: OK\x1b[0m (${enKeys.size} keys)`);
  }
}

console.log(`\nTotal languages checked: ${langFiles.length}`);
console.log(`Total issues: ${totalIssues}`);
process.exit(totalIssues > 0 ? 1 : 0);
