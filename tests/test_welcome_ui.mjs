import { runTest, jsExpr, assert, clickById, sleep, waitFor } from "./test_shared.mjs";

runTest("DiskRaptor Welcome Screen Test", 9201, async (cdp) => {
  // The welcome screen renders async after app init; wait for it instead of
  // racing the first paint (flaky "not-found" under load).
  await waitFor(async () => {
    const w = await jsExpr(cdp, `!!document.getElementById('welcome-placeholder')`);
    return w === true;
  }, { timeout: 10000, label: "welcome" });

  const welcomeVisible = await jsExpr(cdp, `
    (function() {
      const w = document.getElementById('welcome-placeholder');
      if (!w) return 'not-found';
      const hidden = w.classList.contains('hidden');
      return 'visible=' + !hidden;
    })()
  `);
  assert("Welcome screen visible on launch", String(welcomeVisible).includes("visible=true"), `${welcomeVisible}`);

  const heading = await jsExpr(cdp, `document.querySelector('#welcome-placeholder .welcome-title') ? 'found' : 'not-found'`);
  assert("Welcome heading exists", heading === "found");

  const scanBtn = await jsExpr(cdp, `document.getElementById('welcome-scan-btn') ? 'found' : 'not-found'`);
  assert("Welcome scan button", scanBtn === "found");

  const browseBtn = await jsExpr(cdp, `document.getElementById('welcome-browse-btn') ? 'found' : 'not-found'`);
  assert("Welcome browse button", browseBtn === "found");

  const aboutBtn = await jsExpr(cdp, `document.getElementById('welcome-about-btn') ? 'found' : 'not-found'`);
  assert("Welcome about button", aboutBtn === "found");

  const subtitleText = await jsExpr(cdp, `
    (function() {
      const w = document.getElementById('welcome-placeholder');
      if (!w) return 'not-found';
      const s = w.querySelector('.welcome-subtitle');
      return s ? s.textContent.trim().slice(0, 60) : 'no-subtitle';
    })()
  `);
  assert("Welcome subtitle text readable", subtitleText !== "not-found" && subtitleText !== "no-subtitle", `${subtitleText}`);

  await clickById(cdp, "welcome-close");
  await sleep(500);

  const welcomeHidden = await jsExpr(cdp, `
    (function() {
      // Real app: welcome-close hides #welcome-onboarding (app.js
      // hideOnboarding). Legacy injected DOM hid #welcome-placeholder.
      const ob = document.getElementById('welcome-onboarding');
      if (ob) return 'hidden=' + ob.classList.contains('hidden');
      const w = document.getElementById('welcome-placeholder');
      if (!w) return 'not-found';
      return 'hidden=' + w.classList.contains('hidden');
    })()
  `);
  assert("Welcome hidden after close click", welcomeHidden.includes("hidden=true"), `${welcomeHidden}`);

  await jsExpr(cdp, `
    (function() {
      const ob = document.getElementById('welcome-onboarding');
      if (ob) ob.classList.remove('hidden');
      const w = document.getElementById('welcome-placeholder');
      if (w) w.classList.remove('hidden');
      return 'reshown';
    })()
  `);
  await sleep(200);

  const scanPathVisible = await jsExpr(cdp, `document.getElementById('scan-path') ? 'found' : 'not-found'`);
  assert("Scan path visible", scanPathVisible === "found");
});
