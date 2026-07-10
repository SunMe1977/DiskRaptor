#!/usr/bin/env node
/**
 * Check DiskRaptor release health:
 * - Check latest CI workflow run for v0.2.2 release
 * - Check latest release has all 3 OS assets
 * Exits 0 if all good, 1 otherwise.
 */
import { execSync } from "node:child_process";

let failures = 0;

// 1. Check the CI run for v0.2.2 release
try {
  const out = execSync(
    'gh run list --branch v0.2.2 --json name,status,conclusion,databaseId --limit 1',
    { encoding: "utf8", timeout: 15000 }
  );
  const runs = JSON.parse(out);
  if (runs.length > 0) {
    const run = runs[0];
    console.log(`CI Run #${run.databaseId}: ${run.status} / ${run.conclusion || "running"}`);
    if (run.conclusion === "success") {
      console.log("  ✅ CI passed");
    } else if (run.status === "completed") {
      console.log("  ❌ CI failed (check details)");
      failures++;
    } else {
      console.log(`  ⏳ Still ${run.status}...`);
    }

    // Check individual job status
    const jobsOut = execSync(
      `gh run view ${run.databaseId} --json jobs`,
      { encoding: "utf8", timeout: 15000 }
    );
    const jr = JSON.parse(jobsOut);
    for (const job of jr.jobs) {
      const icon = job.conclusion === "success" ? "✅" :
                   job.conclusion === "failure" ? "❌" :
                   job.status === "in_progress" ? "⚙️" : "⏳";
      console.log(`  ${icon} ${job.name}: ${job.status} / ${job.conclusion || "..."}`);
      if (job.conclusion === "failure") failures++;
    }
  } else {
    console.log("No CI run found for v0.2.2 yet");
    failures++;
  }
} catch (e) {
  console.log("ERROR checking CI run:", e.message);
  failures++;
}

// 2. Check if the release has all assets
try {
  let releaseName = "v0.2.2";
  const out = execSync(`gh release view ${releaseName} --json assets 2>/dev/null`, {
    encoding: "utf8",
    timeout: 15000,
  });
  const r = JSON.parse(out);
  const names = r.assets.map((a) => a.name);
  console.log(`\n${releaseName} assets:`, names.join(", "));

  const hasWin = names.some((n) => n.includes("Windows") || n.endsWith(".msi"));
  const hasMac = names.some((n) => n.includes("macOS") || n.endsWith(".dmg"));
  const hasLinux = names.some((n) => n.includes("Linux") || n.includes("AppImage"));

  console.log(`  Windows: ${hasWin ? "✅" : "❌"}`);
  console.log(`  macOS:   ${hasMac ? "✅" : "❌"}`);
  console.log(`  Linux:   ${hasLinux ? "✅" : "❌"}`);

  if (hasWin && hasMac && hasLinux) {
    console.log("\n🎉 ALL OS RELEASES SUCCEEDED!");
  } else {
    failures++;
  }
} catch (e) {
  console.log(`\nv0.2.2 release not created yet (waiting for CI...)`);
}

process.exit(failures > 0 ? 1 : 0);
