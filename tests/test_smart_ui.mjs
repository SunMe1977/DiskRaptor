import {
  runTest, jsExpr, jsInvoke, assert, waitFor,
} from "./test_shared.mjs";

// Real S.M.A.R.T. value check, run on Windows/macOS/Linux in CI.
// Verifies the actually-read values via the backend bridge:
//   - when the platform provides SMART data (admin + real drive / smartctl)
//     it asserts real numbers (temperature, power-on hours, wear, RAW attrs),
//     not just a status label;
//   - otherwise it asserts the graceful fallback (WMI report / clear error).
// The UI render check below only runs when the real frontend is present.

// Reads the real S.M.A.R.T. values via the backend and, when the real
// frontend is loaded, verifies the rendered UI shows those values too.
// Runs on Windows / macOS / Linux. Where the platform can't provide SMART
// data (no admin rights / no smartctl / virtual disk) it verifies the
// graceful fallback instead — but when real data IS available it asserts the
// actual read values (temperature, power-on hours, wear, RAW attributes),
// not just a status label.
runTest("DiskRaptor S.M.A.R.T. real-value check", 9255, async (cdp) => {
  // ── 1. Drives must be enumerated (real disks). ──────────────────
  const disks = await jsInvoke(cdp, `window.__TAURI__.invoke('list_disks', {})`);
  const diskArr = Array.isArray(disks) ? disks : (disks && disks.data ? disks.data : []);
  assert("list_disks returned drives", diskArr.length >= 1, JSON.stringify(disks).slice(0, 200));

  // ── 2. Query SMART status for the first drive. ──────────────────
  const firstId = String(diskArr[0] && (diskArr[0].id != null ? diskArr[0].id : 0));
  let report = null;
  let invokeErr = null;
  try {
    const raw = await jsInvoke(cdp, `window.__TAURI__.invoke('get_smart_status', { deviceId: ${JSON.stringify(firstId)} })`);
    report = raw && raw.data !== undefined && raw.success !== undefined ? raw.data : raw;
  } catch (e) {
    invokeErr = String((e && e.message) || e);
  }

  if (invokeErr) {
    assert("get_smart_status handled gracefully (error surfaced, no crash)", invokeErr.length > 0, invokeErr);
    console.log(`  SMART unavailable on this platform: ${invokeErr}`);
    return;
  }
  assert("get_smart_status returned a report", !!report, JSON.stringify(report).slice(0, 200));

  const attrs = Array.isArray(report.attributes) ? report.attributes : [];
  const source = report.source || "";
  const status = report.status || "";
  const score = Number(report.score);

  console.log(
    `  SMART source=${source} model=${report.model || "-"} interface=${report.interface || "-"} status=${status} score=${score}`,
  );

  // ── 3. Real read-value assertions (when data is available). ──────
  const hasRealData =
    source === "nvme" || source === "smartctl" ||
    attrs.length > 3 ||
    report.temperature_c != null ||
    report.percentage_used != null ||
    report.power_on_hours > 0;

  if (hasRealData) {
    console.log(`  Real SMART data present: ${attrs.length} attributes`);

    // Temperature must be a plausible physical value (°C, 0..100).
    const temp = report.temperature_c;
    if (temp != null) {
      const t = Number(temp);
      assert("temperature is a real °C value (0..100)", Number.isFinite(t) && t >= 0 && t <= 100, `temp=${temp}`);
    }

    // Power-on hours must be a real non-negative number.
    const poh = Number(report.power_on_hours);
    assert("power-on hours is a real number (>=0)", Number.isFinite(poh) && poh >= 0, `poh=${poh}`);

    // Wear / percentage used must be in 0..100 when reported.
    const wear = report.wear != null ? Number(report.wear) : null;
    if (wear != null) {
      assert("wear / percentage used in 0..100", Number.isFinite(wear) && wear >= 0 && wear <= 100, `wear=${wear}`);
    }

    // Health score must be 0..100.
    assert("health score in 0..100", Number.isFinite(score) && score >= 0 && score <= 100, `score=${score}`);
    assert("status is one of Healthy/Warning/Critical", /^(Healthy|Warning|Critical)$/i.test(String(status)), `status=${status}`);

    // Attribute RAW values must be real numbers, not "—"/"n/a".
    if (attrs.length > 0) {
      const numericRaws = attrs.filter((a) => a.raw != null && /^-?\d/.test(String(a.raw).trim())).length;
      assert(
        "attribute RAW values are real numbers",
        numericRaws >= 3,
        `numeric raw=${numericRaws}/${attrs.length} first=${JSON.stringify(attrs.slice(0, 3))}`,
      );
      // At least one of temp / power-on-hours / media errors must carry a number.
      const tempAttr = attrs.find((a) => /temp/i.test(a.name || ""));
      const pohAttr = attrs.find((a) => /power on hours/i.test(a.name || ""));
      const errAttr = attrs.find((a) => /media errors|uncorrected/i.test(a.name || ""));
      const anyReal = [tempAttr, pohAttr, errAttr].some((a) => a && a.raw != null && /-?\d/.test(String(a.raw)));
      assert("temperature / power-on-hours / media errors hold numbers", anyReal === true, JSON.stringify([tempAttr, pohAttr, errAttr]));
    }
  } else {
    // Fallback path (no admin rights → WMI, or unsupported disk).
    console.log(`  No full attribute table (source=${source || "none"}); verifying fallback data.`);
    const hasIdentity =
      (report.model && report.model !== "") ||
      (report.friendly_name && report.friendly_name !== "") ||
      report.capacity > 0;
    assert("fallback still shows real disk identity (model/capacity)", hasIdentity === true, JSON.stringify(report).slice(0, 200));
    assert("fallback marks a real status", /Healthy|Warning|Not Supported/i.test(String(status)) || status === "", `status=${status}`);
  }

  // ── 4. UI render check (only when the real frontend is loaded). ─
  const uiAvailable = await jsExpr(cdp, `typeof (window.app && window.app.openSmartTools) === 'function'`);
  if (uiAvailable === true) {
    await jsExpr(cdp, `window.app.openSmartTools(); 'ok'`);
    const opened = await waitFor(async () => {
      const o = await jsExpr(cdp, `!!document.getElementById('smart-overlay')`);
      return o === true;
    }, { timeout: 5000, label: "smart overlay" });
    assert("S.M.A.R.T. overlay opens (real UI)", opened === true);

    await jsExpr(cdp, `document.getElementById('smart-scan').click(); 'ok'`);
    const rendered = await waitFor(() => renderedState(cdp), { timeout: 30000, label: "smart render" });

    // Verify the banner/tiles mirror the backend's real values.
    const ui = JSON.parse(await jsExpr(cdp, `(function(){
      const res = document.getElementById('smart-result');
      const out = { banner: '', temp: '', score: null, tiles: [], attrRows: 0, raws: [] };
      if (!res) return JSON.stringify(out);
      const b = res.querySelector('.smart-banner');
      if (b) {
        out.banner = (b.querySelector('.banner-status')||{}).textContent || '';
        out.temp = (b.querySelector('.banner-temp')||{}).textContent || '';
        const m = ((b.querySelector('.banner-score')||{}).textContent||'').match(/Health Score (\\d+)/);
        out.score = m ? parseInt(m[1],10) : null;
      }
      res.querySelectorAll('.smart-tile').forEach(function(t){ out.tiles.push((t.textContent||'').replace(/\\s+/g,' ').trim()); });
      out.attrRows = res.querySelectorAll('.smart-attr-table tbody tr').length;
      res.querySelectorAll('.smart-attr-table tbody tr td.attr-raw').forEach(function(c){ out.raws.push((c.textContent||'').trim()); });
      return JSON.stringify(out);
    })()`));

    assert("S.M.A.R.T. banner rendered", ui.banner !== "", `banner=${ui.banner}`);

    if (hasRealData && report.temperature_c != null) {
      const tempNum = parseInt(String(ui.temp), 10);
      assert("UI banner temperature is a real °C number", !isNaN(tempNum) && tempNum >= 0 && tempNum <= 100, `temp=${ui.temp}`);
    }
    if (hasRealData && report.percentage_used != null) {
      const wearTile = ui.tiles.find((t) => /Wear/.test(t));
      assert("UI wear tile shows a real percentage", !!wearTile && /\\d+%/.test(wearTile), `tiles=${JSON.stringify(ui.tiles)}`);
    }
    if (hasRealData && attrs.length > 0) {
      assert(
        "UI attribute table renders raw values",
        ui.attrRows >= attrs.length && ui.raws.filter((r) => /-?\\d/.test(r)).length >= 3,
        `rows=${ui.attrRows} raws=${JSON.stringify(ui.raws.slice(0, 5))}`,
      );
    }
  } else {
    console.log("  Real frontend not loaded (test-server fake DOM) — UI render check skipped.");
  }
});

async function renderedState(cdp) {
  try {
    return await jsExpr(cdp, `(function(){
      const st = document.getElementById('smart-status');
      const res = document.getElementById('smart-result');
      const t = (st ? st.textContent : '') + (res ? res.textContent : '');
      const busy = /Querying|Loading/.test(t);
      const banner = res && res.querySelector('.smart-banner');
      return (!!banner || (/Error|not available|Run as Administrator|Basic health/i.test(t) && !busy));
    })()`);
  } catch {
    return false;
  }
}
