import fs from "fs";
import path from "path";

const I18N_JS = "frontend/i18n.js";
const LOCALES_DIR = "frontend/locales";

const content = fs.readFileSync(I18N_JS, "utf-8");

// ── Extract LANGUAGES array by bracket matching ────────
const langStart = content.indexOf("const LANGUAGES = [");
const arrayStart = content.indexOf("[", langStart);
let depth = 0;
let langEnd = arrayStart;
for (let i = arrayStart; i < content.length; i++) {
  if (content[i] === "[") depth++;
  if (content[i] === "]") {
    depth--;
    if (depth === 0) { langEnd = i + 1; break; }
  }
}
let langSrc = content.substring(arrayStart, langEnd);
// Debug
console.log("lang array length:", langSrc.length);

const langFn = new Function("return " + langSrc);
const languages = langFn();
console.log("Extracted " + languages.length + " languages");

// ── Extract STRINGS object by bracket matching ────────
const strStart = content.indexOf("const STRINGS = {");
const objStart = content.indexOf("{", strStart);
depth = 0;
let strEnd = objStart;
for (let i = objStart; i < content.length; i++) {
  if (content[i] === "{") depth++;
  if (content[i] === "}") {
    depth--;
    if (depth === 0) { strEnd = i + 1; break; }
  }
}
let strSrc = content.substring(objStart, strEnd);

const strFn = new Function("return " + strSrc);
const strings = strFn();
console.log("Extracted " + Object.keys(strings).length + " translation keys");

// ── Create locales directory ───────────────────────────
fs.mkdirSync(LOCALES_DIR, { recursive: true });

// ── Write languages.json ───────────────────────────────
fs.writeFileSync(
  path.join(LOCALES_DIR, "languages.json"),
  JSON.stringify(languages, null, 2),
  "utf-8"
);
console.log("Created frontend/locales/languages.json");

// ── Write one JSON per language ────────────────────────
const langCodes = languages.map(l => l.code);
const allKeys = Object.keys(strings);

for (const code of langCodes) {
  const langStrings = {};
  for (const key of allKeys) {
    langStrings[key] = strings[key][code] !== undefined
      ? strings[key][code]
      : strings[key]["en"] || key;
  }
  const sorted = {};
  Object.keys(langStrings).sort().forEach(k => { sorted[k] = langStrings[k]; });
  fs.writeFileSync(
    path.join(LOCALES_DIR, code + ".json"),
    JSON.stringify(sorted, null, 2),
    "utf-8"
  );
}
console.log("Created " + langCodes.length + " locale files");
console.log("Done!");
