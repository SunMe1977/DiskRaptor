/**
 * DiskRaptor UI test runner.
 * Launches a static file server, opens the test page in Playwright,
 * and reports pass/fail results.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const PORT = 9876;
const BASE = path.resolve(".");

// ── Minimal static file server ──────────────────────────────────────────
const MIME = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const server = http.createServer((req, res) => {
  let file = req.url.split("?")[0];
  if (file === "/") file = "/frontend/tests.html";
  const filePath = path.join(BASE, file);
  const ext = path.extname(filePath);
  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
    });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
});

// ── Run tests ───────────────────────────────────────────────────────────
async function run() {
  await new Promise((r) => server.listen(PORT, r));
  console.log(
    `\n  Test server at http://localhost:${PORT}/frontend/tests.html\n`,
  );

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on("console", (msg) => {
    if (msg.type() === "log") console.log(`  [log] ${msg.text()}`);
    if (msg.type() === "error") console.error(`  [err] ${msg.text()}`);
  });

  try {
    await page.goto(`http://localhost:${PORT}/frontend/tests.html`, {
      waitUntil: "networkidle",
      timeout: 15000,
    });

    // Wait for tests to finish (longer timeout for debug)
    await page
      .waitForFunction(
        () =>
          document.querySelector("#test-output")?.innerText.includes("Failed:"),
        { timeout: 30000, polling: 200 },
      )
      .catch(async () => {
        // If it times out, dump the current state
        const current = await page.evaluate(() => {
          const el = document.querySelector("#test-output");
          return el ? el.innerText : "NO test-output element";
        });
        console.log("  [TIMEOUT] Current test output:", current);
        const errors = await page
          .evaluate(() => {
            return fail.map((f) => f);
          })
          .catch(() => []);
        console.log("  [TIMEOUT] Failures:", errors.join(", "));
        throw new Error("Tests timed out. Output: " + current.slice(0, 500));
      });

    // Small extra delay for last assertions
    await page.waitForTimeout(500);

    // Extract results from the DOM
    const results = await page.evaluate(() => {
      const txt = document.querySelector("#test-output")?.innerText || "";
      const passMatch = txt.match(/Passed:\s*(\d+)/);
      const failMatch = txt.match(/Failed:\s*(\d+)/);
      const testRows = Array.from(
        document.querySelectorAll("#test-output > div"),
      );
      return {
        text: txt,
        passed: passMatch ? parseInt(passMatch[1]) : 0,
        failed: failMatch ? parseInt(failMatch[1]) : 0,
        details: testRows.map((r) => r.textContent || ""),
      };
    });

    console.log(`\n  ── Results ──────────────────────────────`);
    console.log(`  Passed: ${results.passed}   Failed: ${results.failed}`);
    console.log(`  ──────────────────────────────────────────\n`);

    for (const d of results.details) {
      if (d.includes("✘") || d.includes("fail")) {
        console.log(`  ✘ ${d}`);
      }
    }
    for (const d of results.details) {
      if (d.includes("✔") || d.includes("pass")) {
        console.log(`  ✔ ${d}`);
      }
    }

    const exitCode = results.failed > 0 ? 1 : 0;
    process.exit(exitCode);
  } catch (err) {
    console.error(`\n  ✘ Test error: ${err.message}\n`);
    process.exit(1);
  } finally {
    await browser.close();
    server.close();
  }
}

run();
