import crypto from "crypto";
import * as fs from "fs";
import { runTest, jsExpr, jsInvoke, assert, clickById, setValue, sleep, waitFor } from "./test_shared.mjs";

function issueLicense(email) {
  const privPem = fs.readFileSync("scripts/private.key", "utf8");
  const key = crypto.createPrivateKey(privPem);
  const payload = JSON.stringify({ email, type: "pro", issued: "2026-10-01T00:00:00Z", expires: "2027-10-02T00:00:00Z" });
  const sig = crypto.sign(null, Buffer.from(payload, "utf8"), key);
  return Buffer.from(payload, "utf8").toString("base64") + "." + sig.toString("base64");
}

async function branding(cdp) {
  return jsExpr(cdp, `({
    title: document.title,
    toolbar: document.querySelector('[data-i18n="toolbar.title"]')?.textContent || '',
    aboutH2: document.getElementById('about-brand-name')?.textContent || '',
    copy: document.querySelector('.about-copy')?.textContent || '',
    flag: !!window.__isPro
  })`);
}

runTest("DiskRaptor Pro Branding UI Test", 9268, async (cdp) => {
  // --- inactive baseline ---
  const before = await branding(cdp);
  assert("Baseline title is plain", before.title === "DiskRaptor", `title=${before.title}`);
  assert("Baseline toolbar is plain", before.toolbar === "DiskRaptor", `toolbar=${before.toolbar}`);

  // --- activate via the real button (dialog refresh applies branding) ---
  const goodKey = issueLicense("brand@diskraptor.com");
  await jsExpr(cdp, `document.getElementById('about-overlay').classList.add('active'); 'opened'`);
  await sleep(300);
  await jsExpr(cdp, `document.querySelector('.about-tab[data-tab="pro"]').click(); 'pro-tab'`);
  await sleep(300);
  await setValue(cdp, "license-key-input", goodKey);
  await clickById(cdp, "btn-license-activate", 800);
  const isPro = await waitFor(async () => (await branding(cdp)).flag === true, { timeout: 8000, label: "pro-flag" });
  assert("Pro flag set after activate", isPro === true);
  // license refresh() applies branding; give the async chain a beat
  await sleep(500);
  const during = await branding(cdp);
  assert("Title shows Pro", during.title === "DiskRaptor Pro", `title=${during.title}`);
  assert("Toolbar shows Pro", during.toolbar === "DiskRaptor Pro", `toolbar=${during.toolbar}`);
  assert("About heading shows Pro", during.aboutH2 === "DiskRaptor Pro", `h2=${during.aboutH2}`);
  assert("Copyright shows Pro", /DiskRaptor Pro/.test(during.copy || ""), `copy=${during.copy}`);

  // --- language switch keeps branding (re-translation hook) ---
  await jsExpr(cdp, `window.I18N && window.I18N.setLocale ? window.I18N.setLocale('de') : 'no-i18n'`);
  await sleep(500);
  const afterLang = await branding(cdp);
  assert("Toolbar still Pro after language switch", afterLang.toolbar === "DiskRaptor Pro", `toolbar=${afterLang.toolbar}`);
  await jsExpr(cdp, `window.I18N && window.I18N.setLocale ? window.I18N.setLocale('en') : 'no-i18n'`);
  await sleep(500);

  // --- deactivate via the real button restores plain branding ---
  await clickById(cdp, "btn-license-deactivate", 800);
  const backToPlain = await waitFor(async () => {
    const b = await branding(cdp);
    return b.flag === false && b.title === "DiskRaptor";
  }, { timeout: 8000, label: "plain-brand" });
  assert("Branding back to plain after deactivate", backToPlain === true);
  const after = await branding(cdp);
  assert("Toolbar plain again", after.toolbar === "DiskRaptor", `toolbar=${after.toolbar}`);
});
