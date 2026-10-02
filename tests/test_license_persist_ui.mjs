import crypto from "crypto";
import * as fs from "fs";
import { launchAndConnect, jsInvoke, assert, sleep, killChild, getAssertCounts, resetAssert } from "./test_shared.mjs";

function issueLicense(email) {
  const privPem = fs.readFileSync("scripts/private.key", "utf8");
  const key = crypto.createPrivateKey(privPem);
  const payload = JSON.stringify({ email, type: "pro", issued: "2026-10-01T00:00:00Z", expires: "2027-10-02T00:00:00Z" });
  const sig = crypto.sign(null, Buffer.from(payload, "utf8"), key);
  return Buffer.from(payload, "utf8").toString("base64") + "." + sig.toString("base64");
}

const stateOf = async (cdp) => {
  const s = await jsInvoke(cdp, `window.__TAURI__.invoke("license_status")`);
  return (s && s.data ? s.data : s) || {};
};

const PORT = 9266;
resetAssert();
let child1 = null;
let child2 = null;
try {
  // --- session 1: activate ---
  console.log("  session 1: launch + activate");
  const c1 = await launchAndConnect(PORT);
  child1 = c1.child;
  const act = await jsInvoke(c1.cdp, `window.__TAURI__.invoke("license_activate", { licenseKey: ${JSON.stringify(issueLicense("persist@diskraptor.com"))} })`);
  const st1 = await stateOf(c1.cdp);
  assert("Active right after activate", st1.state === "pro", JSON.stringify(st1).slice(0, 120));
  try { await c1.cdp.send("Close"); } catch {}
  killChild(child1);
  await sleep(2500);

  // --- session 2: fresh launch, license must survive restart ---
  console.log("  session 2: relaunch, check persistence");
  const c2 = await launchAndConnect(PORT);
  child2 = c2.child;
  const st2 = await stateOf(c2.cdp);
  assert("Still pro after restart", st2.state === "pro" && st2.email === "persist@diskraptor.com", JSON.stringify(st2).slice(0, 160));

  // --- cleanup ---
  await jsInvoke(c2.cdp, `window.__TAURI__.invoke("license_deactivate")`);
  await sleep(300);
  const st3 = await stateOf(c2.cdp);
  assert("Deactivate works after restart", st3.state === "inactive");
  try { await c2.cdp.send("Close"); } catch {}
  killChild(child2);
} catch (e) {
  console.error("  HARNESS ERROR: " + (e && e.message ? e.message : e));
  killChild(child1);
  killChild(child2);
  process.exit(2);
}
const { passed, failed } = getAssertCounts();
console.log(`\n  Passed: ${passed}  Failed: ${failed}`);
killChild(child2);
process.exit(failed ? 1 : 0);
