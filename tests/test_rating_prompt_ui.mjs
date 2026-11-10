import { runTest, jsExpr, assert, sleep, waitFor } from "./test_shared.mjs";

// Rating entry point: the 5-star widget on the welcome page opens the
// platform store page (Microsoft Store / Mac App Store) via `open_url`.
// The old milestone-based "rate it" launch prompt no longer exists.
runTest("DiskRaptor Rating Prompt Test", 9270, async (cdp) => {
  const star = await waitFor(async () => {
    return await jsExpr(cdp, `!!document.getElementById('welcome-star-rating')`);
  }, { timeout: 15000, label: "star rating widget" });
  assert("Star rating widget exists", star === true);

  const attrs = await jsExpr(cdp, `JSON.stringify({
    role: document.getElementById('welcome-star-rating')?.getAttribute('role') || '',
    tabindex: document.getElementById('welcome-star-rating')?.getAttribute('tabindex') || '',
    aria: document.getElementById('welcome-star-rating')?.getAttribute('aria-label') || '',
    title: document.getElementById('welcome-star-rating')?.getAttribute('title') || ''
  })`);
  const a = JSON.parse(attrs);
  assert("Star widget is keyboard accessible", a.role === "button" && a.tabindex === "0", attrs);
  assert("Star widget has a rating label", a.aria.length > 0 && a.title.length > 0, attrs);

  const expected = await jsExpr(cdp, `
    (function() {
      const p = (navigator.platform || '').toLowerCase();
      return p.indexOf('mac') === 0
        ? 'https://apps.apple.com/us/app/diskraptor/id6793462969'
        : 'https://apps.microsoft.com/detail/xpdf89vj02kvmm?cid=PCCongratsBnr';
    })()
  `);

  const wrapped = await jsExpr(cdp, `
    (function() {
      window.__ratingCalls = [];
      try {
        const orig = window.__TAURI__.invoke;
        Object.defineProperty(window.__TAURI__, 'invoke', {
          configurable: true, writable: true,
          value: function(cmd, args) {
            if (cmd === 'open_url') {
              window.__ratingCalls.push(String(args && args.url));
              return Promise.resolve({});
            }
            return orig.call(window.__TAURI__, cmd, args);
          }
        });
        return 'wrapped';
      } catch (e) { return 'wrap-failed:' + String(e && e.message); }
    })()
  `);
  assert("open_url stubbed for test", wrapped === "wrapped", String(wrapped));

  await jsExpr(cdp, `document.getElementById('welcome-star-rating').click(); 'clicked'`);
  await sleep(300);
  let calls = await jsExpr(cdp, `window.__ratingCalls || []`);
  assert("Clicking stars opens the store page",
    Array.isArray(calls) && calls.length === 1 && calls[0] === expected,
    `calls=${JSON.stringify(calls)} expected=${expected}`);

  await jsExpr(cdp, `window.__ratingCalls = []; 'reset'`);
  await jsExpr(cdp, `
    document.getElementById('welcome-star-rating')
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    'enter'
  `);
  await sleep(300);
  calls = await jsExpr(cdp, `window.__ratingCalls || []`);
  assert("Enter key activates the rating widget",
    Array.isArray(calls) && calls.length === 1 && calls[0] === expected,
    `calls=${JSON.stringify(calls)}`);
});
