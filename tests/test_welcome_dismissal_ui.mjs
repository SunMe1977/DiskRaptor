import { runTest, jsExpr, jsInvoke, assert, clickById, sleep } from "./test_shared.mjs";

// Closing the onboarding banner must hide it immediately and persist
// `welcome_dismissed` in the backend settings.
runTest("DiskRaptor Welcome Dismissal Persistence Test", 9266, async (cdp) => {
  const placeholder = await jsExpr(cdp, `document.getElementById('welcome-placeholder') ? 'found' : 'not-found'`);
  assert("Welcome placeholder exists", placeholder === "found");

  const onboarding = await jsExpr(cdp, `document.getElementById('welcome-onboarding') ? 'found' : 'not-found'`);
  assert("Welcome onboarding exists", onboarding === "found");
  if (onboarding !== "found") return;

  const original = await jsInvoke(cdp, "window.__TAURI__.invoke('load_settings', {})").catch(() => null);
  const originalDismissed = !!(original && original.welcome_dismissed);

  // Force the banner visible so the dismissal path is always exercised.
  await jsExpr(cdp, `document.getElementById('welcome-onboarding').classList.remove('hidden'); 'shown'`);
  const visible = await jsExpr(cdp, `!document.getElementById('welcome-onboarding').classList.contains('hidden')`);
  assert("Welcome visible before close", visible === true);

  await clickById(cdp, "welcome-close", 300);
  await sleep(400);

  const hiddenAfterClose = await jsExpr(cdp, `document.getElementById('welcome-onboarding').classList.contains('hidden')`);
  assert("Welcome hidden after close click", hiddenAfterClose === true);

  const dismissed = await jsExpr(cdp, `
    (async () => {
      try {
        const r = await window.__TAURI__.invoke('load_settings', {});
        return r && r.welcome_dismissed === true;
      } catch (e) { return 'err:' + e.message; }
    })()
  `);
  assert("Welcome dismissal saved to settings", dismissed === true, `dismissed=${dismissed}`);

  // Restore the original preference so the test does not change the user's app.
  if (!originalDismissed) {
    await jsInvoke(cdp, "window.__TAURI__.invoke('save_settings', { settings: { welcome_dismissed: false } })")
      .catch(() => {});
  }
});
