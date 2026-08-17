#!/usr/bin/env node
// One-time split of the inline STRINGS table in frontend/i18n.js into
// per-locale files (frontend/i18n/<code>.js) that set window.I18N_DATA.
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const i18nPath = path.resolve(__dirname, "..", "frontend", "i18n.js");
const outDir = path.resolve(__dirname, "..", "frontend", "i18n");

const src = fs.readFileSync(i18nPath, "utf8");

// Extract `const STRINGS = { ... };` using brace matching.
const marker = "const STRINGS = {";
const start = src.indexOf(marker);
if (start < 0) throw new Error("STRINGS not found");
const objStart = src.indexOf("{", start);
let depth = 0;
let objEnd = -1;
for (let i = objStart; i < src.length; i++) {
  const ch = src[i];
  if (ch === "{") depth++;
  else if (ch === "}") {
    depth--;
    if (depth === 0) {
      objEnd = i;
      break;
    }
  }
}
if (objEnd < 0) throw new Error("STRINGS object not closed");
const objText = src.slice(objStart, objEnd + 1);
const STRINGS = new Function("return (" + objText + ");")();

// Collect locale codes (first-level values are objects keyed by locale).
const locales = new Set();
for (const key in STRINGS) {
  const table = STRINGS[key];
  for (const loc in table) locales.add(loc);
}

fs.mkdirSync(outDir, { recursive: true });
for (const loc of locales) {
  const data = {};
  for (const key in STRINGS) {
    if (STRINGS[key][loc] !== undefined) data[key] = STRINGS[key][loc];
  }
  const js =
    "window.I18N_DATA = window.I18N_DATA || {};\n" +
    "window.I18N_DATA[" + JSON.stringify(loc) + "] = " +
    JSON.stringify(data) + ";\n";
  fs.writeFileSync(path.join(outDir, loc + ".js"), js);
}
console.log("wrote", locales.size, "locale files to", outDir);
console.log(Array.from(locales).join(", "));
