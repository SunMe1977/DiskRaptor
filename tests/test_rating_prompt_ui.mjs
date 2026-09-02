import {
  runTest, jsExpr, assert, sleep, waitFor, launchAndConnect, IS_WIN, IS_MAC,
} from "./test_shared.mjs";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";

// The Rust backend stores settings at {config_dir}/diskraptor/settings.json
// (dirs::config_dir()), so the test drives the rating prompt by pre-seeding
// that file and backs up the user's real settings around the run.
function settingsFile() {
  const home = os.homedir();
  if (IS_WIN) {
    return path.join(
      process.env.APPDATA || path.join(home, "AppData", "Roaming"),
      "diskraptor", "settings.json",
    );
  }
  if (IS_MAC) {
    return path.join(home, "Library", "Application Support", "diskraptor", "settings.json");
  }
  return path.join(
    process.env.XDG_CONFIG_HOME || path.join(home, ".config"),
    "diskraptor", "settings.json",
  );
}

const SETTINGS_FILE = settingsFile();
const BACKUP_FILE = SETTINGS_FILE + ".rating-test.bak";

function readSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")); }
  catch { return {}; }
}

function writeSettings(s) {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2), "utf8");
}

function setRatingState(count) {
  const s = readSettings();
  s.rating_launch_count = count;
  writeSettings(s);
}

function backupSettings() {
  if (fs.existsSync(SETTINGS_FILE)) {
    fs.copyFileSync(SETTINGS_FILE, BACKUP_FILE);
    console.log(`  Settings backed up: ${BACKUP_FILE}`);
  }
}

function restoreSettings() {
  try {
    if (fs.existsSync(BACKUP_FILE)) {
      fs.copyFileSync(BACKUP_FILE, SETTINGS_FILE);
      fs.unlinkSync(BACKUP_FILE);
      console.log("  Settings restored");
    }
  } catch (e) {
    console.error("  Settings restore failed:", e);
  }
}

backupSettings();
process.on("exit", restoreSettings);

// Pre-seed count=4 so the very first app launch in this test is the 5th.
setRatingState(4);

function ratingDialogText(cdp) {
  return jsExpr(cdp, `
    (function() {
      const cards = document.querySelectorAll('.dlg-card');
      if (!cards.length) return 'none';
      const out = [];
      cards.forEach(function(c) {
        const text = (c.textContent || '').trim();
        const btns = Array.from(c.querySelectorAll('button')).map(function(b) { return b.textContent.trim(); });
        out.push(text + ' :: btns=' + btns.join('|'));
      });
      return out.join(' ;; ');
    })()
  `);
}

async function clickRatingButton(cdp, labelPart) {
  return jsExpr(cdp, `
    (function() {
      let clicked = false;
      document.querySelectorAll('.dlg-card button').forEach(function(b) {
        if (b.textContent.trim().indexOf(${JSON.stringify(labelPart)}) === 0) { b.click(); clicked = true; }
      });
      return clicked ? 'clicked' : 'not-found';
    })()
  `);
}

runTest("DiskRaptor Rating Prompt Test", 9270, async (cdp) => {
  // ── Scenario A: the 5th launch shows the rating prompt ──
  const shown5 = await waitFor(async () => {
    const t = await ratingDialogText(cdp);
    return typeof t === "string" && /rate it/i.test(t);
  }, { timeout: 20000, label: "5th-launch prompt" });
  assert("Rating prompt shown on 5th launch", shown5 === true, shown5 ? "" : "dialog never appeared");

  const btns = await jsExpr(cdp, `Array.from(document.querySelectorAll('.dlg-card button')).map(function(b){return b.textContent.trim();})`);
  assert(
    "Yes/No buttons present",
    Array.isArray(btns) && btns.some((b) => b.indexOf("Yes") === 0) && btns.some((b) => b.indexOf("No") === 0),
    JSON.stringify(btns),
  );

  // ── Scenario B: "No, thanks" closes the dialog but only until the next
  //    milestone — rating_dismissed is no longer persisted ──
  const noClicked = await clickRatingButton(cdp, "No");
  assert("No button clickable", noClicked === "clicked", String(noClicked));
  await sleep(700);

  const closedAfterNo = await jsExpr(cdp, `document.querySelectorAll('.dlg-card').length`);
  assert("Dialog closes after No", closedAfterNo === 0, "count=" + closedAfterNo);

  const s1 = readSettings();
  assert("rating_dismissed not persisted after No", s1.rating_dismissed !== true, JSON.stringify(s1));
  assert("launch count advanced to 5", s1.rating_launch_count === 5, "count=" + s1.rating_launch_count);

  // ── Scenario C: an immediate relaunch (count 6, not a milestone) asks again
  //    neither on launch 5's dialog nor on the next start ──
  try { await cdp.send("Close"); } catch {}
  await sleep(500);
  const second = await launchAndConnect(9271);
  await sleep(4000); // startup prompt logic would have fired by now if not suppressed
  const dismissedProbe = await ratingDialogText(second.cdp);
  assert(
    "No prompt on non-milestone relaunch",
    dismissedProbe === "none" || !/rate it/i.test(String(dismissedProbe)),
    String(dismissedProbe),
  );

  // ── Scenario D: the 10th launch prompts again; "Yes" opens the store page ──
  try { await second.cdp.send("Close"); } catch {}
  await sleep(500);
  setRatingState(9);
  const third = await launchAndConnect(9272);

  const shown10 = await waitFor(async () => {
    const t = await ratingDialogText(third.cdp);
    return typeof t === "string" && /rate it/i.test(t);
  }, { timeout: 20000, label: "10th-launch prompt" });
  assert("Rating prompt shown on 10th launch", shown10 === true, shown10 ? "" : "dialog never appeared");

  // Stub open_url so the test records the call instead of launching a real
  // browser window.
  const wrapStatus = await jsExpr(third.cdp, `
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
  assert("open_url stubbed for test", wrapStatus === "wrapped", String(wrapStatus));

  const yesClicked = await clickRatingButton(third.cdp, "Yes");
  assert("Yes button clickable", yesClicked === "clicked", String(yesClicked));
  await sleep(700);

  const closedAfterYes = await jsExpr(third.cdp, `document.querySelectorAll('.dlg-card').length`);
  assert("Dialog closes after Yes", closedAfterYes === 0, "count=" + closedAfterYes);

  const calls = await jsExpr(third.cdp, `window.__ratingCalls || []`);
  const expected = await jsExpr(third.cdp, `
    (function() {
      const p = (navigator.platform || '').toLowerCase();
      return p.indexOf('mac') === 0
        ? 'https://apps.apple.com/us/app/diskraptor/id6793462969'
        : 'https://apps.microsoft.com/detail/xpdf89vj02kvmm?cid=PCCongratsBnr';
    })()
  `);
  assert(
    "open_url called with store page",
    Array.isArray(calls) && calls.length >= 1 && calls[0] === expected,
    "calls=" + JSON.stringify(calls) + " expected=" + expected,
  );

  const s2 = readSettings();
  assert("rating_dismissed not set after Yes", s2.rating_dismissed !== true, JSON.stringify(s2));
  assert("launch count advanced to 10", s2.rating_launch_count === 10, "count=" + s2.rating_launch_count);

  try { await third.cdp.send("Close"); } catch {}
  await sleep(500);

  // ── Scenario E: the 50th launch asks again after repeated "No" ──
  setRatingState(49);
  const fourth = await launchAndConnect(9273);

  const shown50 = await waitFor(async () => {
    const t = await ratingDialogText(fourth.cdp);
    return typeof t === "string" && /rate it/i.test(t);
  }, { timeout: 20000, label: "50th-launch prompt" });
  assert("Rating prompt shown on 50th launch", shown50 === true, shown50 ? "" : "dialog never appeared");

  const no50 = await clickRatingButton(fourth.cdp, "No");
  assert("No button clickable at 50", no50 === "clicked", String(no50));
  await sleep(700);

  const s50 = readSettings();
  assert("rating_dismissed not persisted at 50", s50.rating_dismissed !== true, JSON.stringify(s50));
  assert("launch count advanced to 50", s50.rating_launch_count === 50, "count=" + s50.rating_launch_count);

  try { await fourth.cdp.send("Close"); } catch {}
  await sleep(500);

  // ── Scenario F: the 100th launch asks one last time ──
  setRatingState(99);
  const fifth = await launchAndConnect(9274);

  const shown100 = await waitFor(async () => {
    const t = await ratingDialogText(fifth.cdp);
    return typeof t === "string" && /rate it/i.test(t);
  }, { timeout: 20000, label: "100th-launch prompt" });
  assert("Rating prompt shown on 100th launch", shown100 === true, shown100 ? "" : "dialog never appeared");

  const no100 = await clickRatingButton(fifth.cdp, "No");
  assert("No button clickable at 100", no100 === "clicked", String(no100));
  await sleep(700);

  const s100 = readSettings();
  assert("rating_dismissed not persisted at 100", s100.rating_dismissed !== true, JSON.stringify(s100));
  assert("launch count advanced to 100", s100.rating_launch_count === 100, "count=" + s100.rating_launch_count);

  try { await fifth.cdp.send("Close"); } catch {}
  await sleep(500);

  // ── Scenario G: past launch #100 the milestone series is exhausted and the
  //    prompt no longer appears on relaunch ──
  setRatingState(100);
  const sixth = await launchAndConnect(9275);
  await sleep(4000);
  const exhaustedProbe = await ratingDialogText(sixth.cdp);
  assert(
    "No prompt after 100th launch",
    exhaustedProbe === "none" || !/rate it/i.test(String(exhaustedProbe)),
    String(exhaustedProbe),
  );

  try { await sixth.cdp.send("Close"); } catch {}
});
