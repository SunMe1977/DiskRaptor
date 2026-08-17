#!/usr/bin/env node
/**
 * Frontend production build: copies frontend/ to frontend-dist/ and minifies
 * all JS/CSS with esbuild (classic scripts keep their top-level globals).
 * Also bundles the galaxy view modules into one file (galaxyview/bundle.js);
 * the app falls back to the individual modules if the bundle is missing.
 */
import * as esbuild from "esbuild";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "frontend");
const DST = path.join(ROOT, "frontend-dist");

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

fs.rmSync(DST, { recursive: true, force: true });
fs.mkdirSync(DST, { recursive: true });

const galaxy = [
  "galaxyview/config.js",
  "galaxyview/spatial-index.js",
  "galaxyview/data-mapper.js",
  "galaxyview/animation.js",
  "galaxyview/effects.js",
  "galaxyview/interaction.js",
  "galaxyview/lod.js",
  "galaxyview/timeline.js",
  "galaxyview/live-scan.js",
  "galaxyview/insights.js",
  "galaxyview/plugin-api.js",
  "galaxyview.js",
];

const files = walk(SRC);
for (const src of files) {
  const rel = path.relative(SRC, src);
  const dest = path.join(DST, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const ext = path.extname(src).toLowerCase();
  if (ext === ".js" || ext === ".mjs") {
    try {
      await esbuild.build({
        entryPoints: [src],
        outfile: dest,
        minify: true,
        allowOverwrite: true,
        logLevel: "silent",
      });
    } catch (e) {
      console.error("[build-frontend] minify failed for", rel, e);
      fs.copyFileSync(src, dest);
    }
  } else if (ext === ".css") {
    try {
      const r = await esbuild.transform(fs.readFileSync(src, "utf8"), {
        loader: "css",
        minify: true,
      });
      fs.writeFileSync(dest, r.code);
    } catch (e) {
      console.error("[build-frontend] css minify failed for", rel, e);
      fs.copyFileSync(src, dest);
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}

// Galaxy bundle (best effort — the app falls back to individual modules).
try {
  const parts = galaxy
    .map((g) => fs.readFileSync(path.join(SRC, g), "utf8"))
    .join("\n;\n");
  const r = await esbuild.transform(parts, { minify: true });
  fs.writeFileSync(path.join(DST, "galaxyview", "bundle.js"), r.code);
  console.log("[build-frontend] galaxy bundle written");
} catch (e) {
  console.warn("[build-frontend] galaxy bundle failed:", e.message);
}

console.log(`[build-frontend] done -> ${DST}`);
