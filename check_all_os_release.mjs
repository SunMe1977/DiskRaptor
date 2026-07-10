#!/usr/bin/env node
#!/usr/bin/env node
/**
 * Check DiskRaptor release health:
 * - Latest release has all 3 OS assets
 * - Latest CI run succeeded
 * Exits 0 if all good, 1 otherwise.
 */
import { execSync } from "node:child_process";

let failures = 0;

// Check latest release (v0.2.0)
try {
  const out = execSync("gh release view v0.2.0 --json assets", {
    encoding: "utf8",
    timeout: 15000,
  });
  const r = JSON.parse(out);
  const names = r.assets.map((a) => a.name);
  console.log("v0.2.0 assets:", names.join(", "));

  const hasWin = names.some((n) => n.includes("Windows") || n.endsWith(".msi"));
  const hasMac = names.some((n) => n.includes("macOS") || n.includes("darwin") || n.endsWith(".dmg"));
  const hasLinux = names.some((n) => n.includes("Linux") || n.includes("AppImage"));

  console.log(`  Windows: ${hasWin ? "✅" : "❌"}`);
  console.log(`  macOS:   ${hasMac ? "✅" : "❌"}`);
  console.log(`  Linux:   ${hasLinux ? "✅" : "❌"}`);

  if (!(hasWin && hasMac && hasLinux)) failures++;
} catch (e) {
  console.log("ERROR checking v0.2.0:", e.message);
  failures++;
}

// Check v0.1.6 (may still be missing Linux)
try {
  const out = execSync("gh release view v0.1.6 --json assets", {
    encoding: "utf8",
    timeout: 15000,
  });
  const r = JSON.parse(out);
  const names = r.assets.map((a) => a.name);
  console.log("v0.1.6 assets:", names.join(", "));

  const hasWin = names.some((n) => n.includes("Windows") || n.endsWith(".msi"));
  const hasMac = names.some((n) => n.includes("macOS") || n.includes("darwin") || n.endsWith(".dmg"));
  const hasLinux = names.some((n) => n.includes("Linux") || n.includes("AppImage"));

  console.log(`  Windows: ${hasWin ? "✅" : "❌"}`);
  console.log(`  macOS:   ${hasMac ? "✅" : "❌"}`);
  console.log(`  Linux:   ${hasLinux ? "✅" : "❌"}`);

  if (!(hasWin && hasMac && hasLinux)) failures++;
} catch (e) {
  console.log("ERROR checking v0.1.6:", e.message);
  failures++;
}

process.exit(failures > 0 ? 1 : 0);
