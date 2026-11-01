#!/usr/bin/env node
/**
 * Marks the built frontend as a "store build" so the app disables its in-app
 * self-update (Microsoft/Mac App Store apps must update through the store).
 *
 * The frontend checks for the marker the same way the macOS store build does
 * (`data-store="true"` on #about-update-check). For the Windows Store (silent
 * MSI / MSIX) build this runs via `beforeBuildCommand` after the frontend is
 * built and before Tauri embeds it.
 */
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const htmlPath = path.join(ROOT, "frontend-dist", "index.html");

const src = fs.readFileSync(htmlPath, "utf8");
const marker = 'id="about-update-check"';
if (!src.includes(marker)) {
  console.error("[stamp-store] #about-update-check not found in frontend-dist/index.html");
  process.exit(1);
}
if (src.includes(marker + ' data-store="true"')) {
  console.log("[stamp-store] already a store build");
} else {
  fs.writeFileSync(htmlPath, src.replace(marker, marker + ' data-store="true"'));
  console.log("[stamp-store] marked frontend-dist/index.html as store build");
}
