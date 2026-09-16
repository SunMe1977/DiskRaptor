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
  "galaxyview/visuals.js",
  "galaxyview/interaction.js",
  "galaxyview/lod.js",
  "galaxyview/timeline.js",
  "galaxyview/live-scan.js",
  "galaxyview/insights.js",
  "galaxyview/plugin-api.js",
  "galaxyview.js",
];

const files = walk(SRC);

// Core bundle: the classic <script defer> files are concatenated in index.html
// tag order and minified as ONE unit (cross-file name mangling), then loaded
// via a single tag. Semantics match sequential deferred scripts exactly
// (same order, same shared global scope); galaxyview stays separate because
// it is lazy-loaded on demand at runtime.
const indexHtml = fs.readFileSync(path.join(SRC, "index.html"), "utf8");
const bundledRels = [...indexHtml.matchAll(/<script\s+defer\s+src="([^"]+)"\s*><\/script>/g)]
  .map((m) => m[1])
  .filter((s) => !s.startsWith("galaxyview/"));
if (bundledRels.length === 0) {
  console.error("[build-frontend] no deferred scripts found in index.html");
  process.exit(1);
}
const bundledSet = new Set(bundledRels.map((r) => path.join(SRC, ...r.split("/"))));

const jsFiles = files.filter((src) => {
  const ext = path.extname(src).toLowerCase();
  if (ext !== ".js" && ext !== ".mjs") return false;
  // Bundled core files ship only inside core.bundle.js (keeps dist lean);
  // galaxyview individuals are kept as the lazy-loader fallback.
  return !bundledSet.has(src);
});
const otherFiles = files.filter((src) => {
  const ext = path.extname(src).toLowerCase();
  return ext !== ".js" && ext !== ".mjs" && path.basename(src) !== "index.html";
});

// Parallel minification of all JS files
await Promise.all(
  jsFiles.map(async (src) => {
    const rel = path.relative(SRC, src);
    const dest = path.join(DST, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    try {
      await esbuild.build({
        entryPoints: [src],
        outfile: dest,
        minify: true,
        allowOverwrite: true,
        logLevel: "silent",
      });
    } catch (e) {
      console.error("[build-frontend] minify FAILED for", rel);
      console.error(String((e && e.message) || e));
      process.exit(1);
    }
  }),
);

// Copy non-JS files (CSS, HTML, etc.)
// Source-only assets (e.g. the full-res logo) are excluded from dist — the
// About dialog uses the pre-scaled logo6_about.png (256px) instead.
const DIST_EXCLUDE = new Set([
  "images/logo6_original.png",
]);
for (const src of otherFiles) {
  const rel = path.relative(SRC, src);
  if (DIST_EXCLUDE.has(rel.split(path.sep).join("/"))) continue;
  const dest = path.join(DST, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const ext = path.extname(src).toLowerCase();
  if (ext === ".css") {
    try {
      const r = await esbuild.transform(fs.readFileSync(src, "utf8"), {
        loader: "css",
        minify: true,
      });
      fs.writeFileSync(dest, r.code);
    } catch (e) {
      console.error("[build-frontend] css minify FAILED for", rel);
      console.error(String((e && e.message) || e));
      process.exit(1);
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}

// Galaxy bundle (required — the runtime fallback is for dev only, so a broken
// bundle must fail the build instead of shipping frontend-dist/ without it).
try {
  const parts = galaxy
    .map((g) => fs.readFileSync(path.join(SRC, g), "utf8"))
    .join("\n;\n");
  const r = await esbuild.transform(parts, { minify: true });
  fs.writeFileSync(path.join(DST, "galaxyview", "bundle.js"), r.code);
  console.log("[build-frontend] galaxy bundle written");
} catch (e) {
  console.error("[build-frontend] galaxy bundle FAILED:", (e && e.message) || e);
  process.exit(1);
}

// Core bundle: concat in tag order, minify once, rewrite dist index.html to
// a single script tag.
try {
  const parts = bundledRels.map((r) => {
    const p = path.join(SRC, ...r.split("/"));
    if (!fs.existsSync(p)) throw new Error(`script tag references missing file: ${r}`);
    return fs.readFileSync(p, "utf8");
  });
  const r = await esbuild.transform(parts.join("\n;\n"), { minify: true });
  fs.writeFileSync(path.join(DST, "core.bundle.js"), r.code);
  const rewritten = indexHtml.replace(
    /([ \t]*<script\s+defer\s+src="[^"]+"\s*><\/script>\r?\n)+/,
    '        <script defer src="core.bundle.js"></script>\n',
  );
  if (rewritten === indexHtml) {
    throw new Error("could not locate deferred script block in index.html");
  }
  fs.writeFileSync(path.join(DST, "index.html"), rewritten);
  console.log(`[build-frontend] core bundle written (${bundledRels.length} files)`);
} catch (e) {
  console.error("[build-frontend] core bundle FAILED:", (e && e.message) || e);
  process.exit(1);
}

console.log(`[build-frontend] done -> ${DST}`);
