#!/usr/bin/env node
import * as fs from "fs";
import * as path from "path";

const I18N_DIR = path.join(process.cwd(), "frontend", "i18n");
const EN_FILE = path.join(I18N_DIR, "en.js");
const FRONTEND_DIR = path.join(process.cwd(), "frontend");
const APP_MODULES_DIR = path.join(FRONTEND_DIR, "app-modules");

const SKIP_KEYS = new Set(["toolbar.title"]);
const COMMON_NON_TRANSLATABLE = new Set([
  "en", "de", "fr", "es", "it", "pt", "nl", "pl", "sv", "da", "nb", "fi", "cs", "ro", "tr", "id", "vi", "ru", "uk", "ar", "zh", "zh-tw", "ja", "ko", "hi",
]);

function loadKeys(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const match = content.match(/window\.I18N_DATA\[.*?\]\s*=\s*(\{[\s\S]*?\});/);
  if (!match) return { keys: new Set(), raw: {} };
  try {
    const obj = JSON.parse(match[1]);
    const keys = new Set();
    function walk(o, prefix) {
      for (const k of Object.keys(o)) {
        const full = prefix ? `${prefix}.${k}` : k;
        if (typeof o[k] === "string") keys.add(full);
        else if (o[k] && typeof o[k] === "object") walk(o[k], full);
      }
    }
    walk(obj, "");
    return { keys, raw: obj };
  } catch (e) {
    console.error(`Parse error ${filePath}: ${e.message}`);
    return { keys: new Set(), raw: {} };
  }
}

function dotGet(obj, dotted) {
  if (dotted in obj) return obj[dotted];
  const parts = dotted.split(".");
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[p];
  }
  return cur;
}

function isTranslated(context) {
  if (/\b__\s*\(/.test(context)) return true;
  if (/\bt\s*\(/.test(context)) return true;
  if (/\bI18N\.t\s*\(/.test(context)) return true;
  if (/\.replace\s*\(/.test(context)) return true;
  if (/\$\{.*__\s*\(/.test(context)) return true;
  if (/\$\{.*t\s*\(/.test(context)) return true;
  if (/data-i18n-title=/.test(context)) return true;
  if (/data-i18n=/.test(context)) return true;
  return false;
}

function checkHardcodedStrings() {
  const issues = [];
  const jsFiles = [
    ...fs.readdirSync(FRONTEND_DIR).filter((f) => f.endsWith(".js")),
    ...fs.readdirSync(APP_MODULES_DIR).filter((f) => f.endsWith(".js")),
  ];

  for (const file of jsFiles) {
    const filePath = file.includes("/") || file.includes("\\")
      ? path.join(APP_MODULES_DIR, file)
      : path.join(FRONTEND_DIR, file);
    if (!fs.existsSync(filePath)) continue;
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.split("\n");

    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;

      let inStr = false;
      let quoteChar = "";
      let str = "";
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (!inStr) {
          if (ch === '"' || ch === "'" || ch === "`") { inStr = true; quoteChar = ch; str = ""; }
        } else {
          if (ch === "\\") { i++; continue; }
          if (ch === quoteChar) {
            inStr = false;
            if (str.length >= 2
              && !/^(http|https|data|chrome-extension|about|javascript|#|\.)/.test(str)
              && !/^[\d\s.,:;%$€£¥()[\]{}<>!@#$%^&*|\\\/`~=?+-]+$/.test(str)
              && !/^(const|let|var|function|return|if|else|for|while|switch|case|break|continue|try|catch|throw|new|this|class|extends|import|export|default|from|async|await|yield|delete|typeof|instanceof|in|of|true|false|null|undefined|NaN|Infinity)$/.test(str)
              && !COMMON_NON_TRANSLATABLE.has(str)
              && !str.includes(".")
              && !/^[a-z][a-z0-9_-]+$/i.test(str)
            ) {
              const beforeCtx = line.slice(Math.max(0, i - str.length - 40), i);
              const afterCtx = line.slice(i + 1, i + str.length + 40);
              const fullCtx = beforeCtx + str + afterCtx;
              if (isTranslated(fullCtx)) continue;
              if (/\bconst\s+\w+\s*=/.test(beforeCtx) && !/textContent|innerHTML|placeholder|title|aria-label|value\s*=/.test(fullCtx)) continue;
              if (/\breturn\b/.test(beforeCtx) && (/\bfunction\s*\(/.test(line) || /=>\s*\{/.test(beforeCtx))) continue;
              if (/console\.(log|warn|error|debug|info)/.test(fullCtx)) continue;
              if (/throw\s+/.test(fullCtx) || /new\s+Error\s*\(/.test(fullCtx)) continue;
              if (/^\s*\/\//.test(line) || /^\s*\*/.test(line)) continue;
              if (/schema|license|copyright|registered/.test(str.toLowerCase())) continue;
              if (str.includes("://")) continue;
              if (/<div|<span|<button|<input|<a\s/i.test(str)) continue;
              if (/padding|font-size|border|border-radius|background|color|var\(--/i.test(str)) continue;
              if (/^span:|^div:|^button:|^input:/i.test(str)) continue;
              if (/^\\u[0-9a-fA-F]{4}/.test(str)) continue;
              if (/^&[a-z]+;$/i.test(str)) continue;
              if (/^\s*[\u25B6\u25BC\u25C0\u25FB\u25A0\u25CF\u25C6\u25B2\u25BE\u25CE★●✓✅⬇⬆💡⏱✖⟲]/.test(str)) continue;

              const isDomContext =
                /textContent\s*=/.test(fullCtx) || /innerHTML\s*=/.test(fullCtx) ||
                /placeholder\s*=/.test(fullCtx) || /title\s*=/.test(fullCtx) ||
                /aria-label\s*=/.test(fullCtx) || /value\s*=/.test(fullCtx) ||
                /\.appendChild\(/.test(fullCtx) || /\.insertBefore\(/.test(fullCtx) ||
                /\.replaceWith\(/.test(fullCtx) || /\.insertAdjacentHTML\(/.test(fullCtx) ||
                /\.innerText\s*=/.test(fullCtx);
              if (!isDomContext) continue;

              issues.push({ file: path.basename(filePath), line: line.replace(/^\s+/, "").slice(0, 120), str });
            }
            str = "";
          } else {
            str += ch;
          }
        }
      }
    }
  }
  return issues;
}

function checkTranslationCompleteness() {
  const issues = [];
  const { keys: enKeys, raw: enRaw } = loadKeys(EN_FILE);
  const langFiles = fs.readdirSync(I18N_DIR).filter((f) => f.endsWith(".js") && f !== "en.js" && f !== "ui-extra.js");

  for (const file of langFiles.sort()) {
    const filePath = path.join(I18N_DIR, file);
    const { keys: locKeys, raw: locRaw } = loadKeys(filePath);
    const code = file.replace(".js", "");

    const missing = [...enKeys].filter((k) => !locKeys.has(k) && !SKIP_KEYS.has(k));
    const extra = [...locKeys].filter((k) => !enKeys.has(k));
    const empty = [...locKeys].filter((k) => {
      const v = dotGet(locRaw, k);
      return v === "" || v == null;
    });
    const mismatchedParams = [...locKeys].filter((k) => {
      if (!enKeys.has(k)) return false;
      const enParams = (enRaw[k] || "").match(/\{(\w+)\}/g) || [];
      const locParams = (locRaw[k] || "").match(/\{(\w+)\}/g) || [];
      const enSet = new Set(enParams.map((p) => p.slice(1, -1)));
      const locSet = new Set(locParams.map((p) => p.slice(1, -1)));
      if (enSet.size !== locSet.size) return true;
      for (const p of enSet) { if (!locSet.has(p)) return true; }
      return false;
    });

    if (missing.length) issues.push({ code, type: "MISSING", keys: missing });
    if (extra.length) issues.push({ code, type: "EXTRA", keys: extra });
    if (empty.length) issues.push({ code, type: "EMPTY", keys: empty });
    if (mismatchedParams.length) issues.push({ code, type: "PARAM_MISMATCH", keys: mismatchedParams });
  }
  return issues;
}

function main() {
  let totalIssues = 0;

  console.log("=== Hardcoded String Audit ===");
  const hardcoded = checkHardcodedStrings();
  if (hardcoded.length) {
    console.log(`\x1b[31mFound ${hardcoded.length} hardcoded string(s):\x1b[0m`);
    for (const h of hardcoded) {
      console.log(`  \x1b[31m${h.file}\x1b[0m: "${h.str}" — ${h.line}`);
    }
    totalIssues += hardcoded.length;
  } else {
    console.log("\x1b[32mNo hardcoded strings found.\x1b[0m");
  }

  console.log("\n=== Translation Completeness Audit ===");
  const completeness = checkTranslationCompleteness();
  if (completeness.length) {
    console.log(`\x1b[31mFound ${completeness.length} translation issue(s):\x1b[0m`);
    for (const c of completeness) {
      console.log(`  \x1b[31m${c.code} ${c.type}:\x1b[0m ${c.keys.slice(0, 10).join(", ")}${c.keys.length > 10 ? ` ... +${c.keys.length - 10}` : ""}`);
    }
    totalIssues += completeness.length;
  } else {
    console.log("\x1b[32mAll translations complete.\x1b[0m");
  }

  console.log(`\nTotal issues: ${totalIssues}`);
  process.exit(totalIssues > 0 ? 1 : 0);
}

main();