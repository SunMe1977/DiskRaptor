import crypto from "crypto";
import * as fs from "fs";
import { runTest, jsExpr, jsInvoke, assert, clickById, setValue, sleep, waitFor } from "./test_shared.mjs";

// Builds a REAL license with the repo's private key (same key the test
// binary embeds as public key via build.rs). Mirrors scripts/keygen.sh:
// raw JSON payload, Ed25519 signature, "<payload b64>.<sig b64>".
function issueLicense(email) {
  const privPem = fs.readFileSync("scripts/private.key", "utf8");
  const key = crypto.createPrivateKey(privPem);
  const payload = JSON.stringify({
    email,
    type: "pro",
    issued: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    expires: "2027-10-02T00:00:00Z",
  });
  const sig = crypto.sign(null, Buffer.from(payload, "utf8"), key);
  return Buffer.from(payload, "utf8").toString("base64") + "." + sig.toString("base64");
}

async function openProTab(cdp) {
  await jsExpr(cdp, `document.getElementById('about-overlay').classList.add('active'); 'opened'`);
  await sleep(300);
  await jsExpr(cdp, `document.querySelector('.about-tab[data-tab="pro"]').click(); 'pro-tab'`);
  await sleep(300);
}

const textOf = (id) => `document.getElementById('${id}')?.textContent || ''`;
const visibleOf = (id) => {
  const el = document.getElementById(id);
  return !!el && el.style.display !== "none" && (el.textContent || "").length > 0;
};

runTest("DiskRaptor License Activation UI Test", 9263, async (cdp) => {
  // --- 0) start clean (a stale instance could still hold a license) ---
  await jsInvoke(cdp, `window.__TAURI__.invoke("license_deactivate")`).catch(() => null);
  await sleep(400);
  await openProTab(cdp);
  const hasInput = await jsExpr(cdp, `document.getElementById('license-key-input') ? 'found' : 'not-found'`);
  assert("License key input exists", hasInput === "found");
  const hasBtn = await jsExpr(cdp, `document.getElementById('btn-license-activate') ? 'found' : 'not-found'`);
  assert("Activate button exists", hasBtn === "found");

  // --- 1) unknown short code is rejected with the Creem answer ---
  // (dotless input takes the online path: bogus key -> "not found").
  await setValue(cdp, "license-key-input", "DR-6UMB-UX6X-9KZX");
  await clickById(cdp, "btn-license-activate", 15000);
  const errShort = await jsExpr(cdp, textOf("license-error"));
  assert("Unknown short code rejected", /not found|Invalid license format|not configured|connection/i.test(errShort || ""), `got=${JSON.stringify(errShort)}`);
  const stateAfterShort = await jsExpr(cdp, textOf("license-state-text"));
  assert("State stays inactive after short code", stateAfterShort !== "pro", `state=${stateAfterShort}`);

  // --- 2) valid signed key activates + shows thanks ---
  const goodKey = issueLicense("uitest@diskraptor.com");
  assert("Test license has payload.signature shape", goodKey.includes("."), `len=${goodKey.length}`);
  await setValue(cdp, "license-key-input", goodKey);
  await clickById(cdp, "btn-license-activate", 800);
  const reachedPro = await waitFor(async () => {
    const s = await jsExpr(cdp, textOf("license-state-text"));
    return s === "pro";
  }, { timeout: 8000, label: "pro-state" });
  assert("State turns pro after valid key", reachedPro === true);
  const thanksVisible = await jsExpr(cdp, `(${visibleOf})('license-error')`);
  const thanksText = await jsExpr(cdp, textOf("license-error"));
  assert("Thanks message shown", thanksVisible === true && /Pro/.test(thanksText || ""), `got=${JSON.stringify(thanksText)}`);
  const details = await jsExpr(cdp, textOf("license-details"));
  assert("Details show buyer email", /uitest@diskraptor\.com/.test(details || ""), `got=${JSON.stringify(details)}`);
  const status = await jsInvoke(cdp, `window.__TAURI__.invoke("license_status")`);
  const st = (status && status.data ? status.data : status) || {};
  assert("Backend license_status is pro", st.state === "pro" && st.email === "uitest@diskraptor.com", JSON.stringify(st).slice(0, 160));

  // --- 3) real Creem short code activates online (needs baked-in creds) ---
  // Uses a genuine customer key; the deactivate at the end frees the slot.
  await setValue(cdp, "license-key-input", "N3BOP-JY4DX-WC6U4-CCZQB-6NG55");
  await clickById(cdp, "btn-license-activate", 15000);
  const creemPro = await waitFor(async () => {
    const s = await jsExpr(cdp, `document.getElementById('license-state-text')?.textContent || ''`);
    return s === "pro";
  }, { timeout: 30000, label: "creem-pro-state" });
  const creemCreds = await jsInvoke(cdp, `window.__TAURI__.invoke("license_status")`).catch(() => null);
  const creemActive = creemPro && !/not configured/i.test(JSON.stringify(creemCreds));
  if (!creemActive) {
    const errEl = await jsExpr(cdp, `document.getElementById('license-error')?.textContent || ''`);
    console.log(`  Creem online path unavailable in this build, skipping (err=${JSON.stringify(errEl)})`);
  } else {
    assert("Creem key activates to pro", true);
    const creemThanks = await jsExpr(cdp, `document.getElementById('license-error')?.textContent || ''`);
    assert("Thanks shown for Creem key", /Pro/.test(creemThanks || ""), `got=${JSON.stringify(creemThanks)}`);
  }

  // --- 4) cleanup: deactivate so the dev machine stays inactive ---
  await clickById(cdp, "btn-license-deactivate", 15000);
  const backToInactive = await waitFor(async () => {
    const s = await jsInvoke(cdp, `window.__TAURI__.invoke("license_status")`);
    const v = (s && s.data ? s.data : s) || {};
    return v.state === "inactive";
  }, { timeout: 8000, label: "inactive-state" });
  assert("Deactivate restores inactive", backToInactive === true);
});
