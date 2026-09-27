#!/usr/bin/env node
// Unit tests for frontend/galaxyview/camera.js (CameraMixin).
// No app, no CDP, no DOM: the mixin only touches `this.*` + GalaxyViewConfig,
// so it can be exercised with a stubbed `window` and a fake receiver.
// Run: node tests/check_camera_math.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

globalThis.window = {
  GalaxyViewConfig: {
    camera: { fov: 60, near: 0.1, far: 100000, minZoom: 5, maxZoom: 5000 },
    accessibility: {},
    animation: { enabled: true, cinematicTransitions: true },
  },
};

const src = readFileSync(join(ROOT, "frontend", "galaxyview", "camera.js"), "utf8");
(0, eval)(src);

const Cam = globalThis.window.GalaxyView.CameraMixin;
let passed = 0;
let failed = 0;
function check(label, cond, detail = "") {
  if (cond) { passed++; console.log(`  ok ${label}`); }
  else { failed++; console.log(`  FAIL ${label}${detail ? " -- " + detail : ""}`); }
}
const approx = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// All 14 extracted methods are present.
for (const m of ["_autoFitCamera", "_computeFitView", "_applyFitView", "_introEnabled",
  "_playOpenZoom", "_armIntroCancel", "_perspScale", "_calculateViewMatrix",
  "_calculateProjectionMatrix", "_project", "_setFollow", "_clearFollow",
  "_updatePauseState", "_updateFollow"]) {
  check(`mixin has ${m}`, typeof Cam[m] === "function");
}

// _computeFitView: empty -> null.
check("fitView empty -> null", Cam._computeFitView.call({ objects: [] }) === null);

// _computeFitView: single planet at distance 100, scale 10.
// maxDist=110, dist = 110/sin(30deg)*1.8 = 110/0.5*1.8 = 396.
{
  const view = Cam._computeFitView.call({ objects: [{ position: [100, 0, 0], scale: 10 }] });
  check("fitView dist math", view && approx(view.dist, 396), `dist=${view && view.dist}`);
  check("fitView tilt 0.42", view && approx(view.position[1], view.position[2] * 0.42));
  check("fitView target origin", view && view.target[0] === 0 && view.target[1] === 0 && view.target[2] === 0);
}

// _computeFitView: clamps to minZoom / maxZoom.
{
  // Tiny scene: maxDist floors at 10 -> dist = 10/sin(30deg)*1.8 = 36.
  const tiny = Cam._computeFitView.call({ objects: [{ position: [1, 0, 0], scale: 1 }] });
  check("fitView small-scene floor", tiny && approx(tiny.dist, 36), `dist=${tiny && tiny.dist}`);
  const huge = Cam._computeFitView.call({ objects: [{ position: [1e6, 0, 0], scale: 1 }] });
  check("fitView maxZoom clamp", huge && huge.dist === 5000, `dist=${huge && huge.dist}`);
}

// _calculateViewMatrix: camera on +Z looking at origin.
{
  const fake = { camera: { position: [0, 0, 10], target: [0, 0, 0], up: [0, 1, 0] } };
  const m = Cam._calculateViewMatrix.call(fake);
  check("viewMatrix translation", approx(m[12], 0) && approx(m[13], 0) && approx(m[14], -10), `t=[${m[12]},${m[13]},${m[14]}]`);
  check("viewMatrix identity rotation", approx(m[0], 1) && approx(m[5], 1) && approx(m[10], 1) && approx(m[15], 1));
}

// _calculateProjectionMatrix: shape checks.
{
  const m = Cam._calculateProjectionMatrix.call({}, 800, 600);
  const f = 1 / Math.tan((60 * Math.PI / 180) / 2);
  check("projMatrix f/aspect", approx(m[0], f / (800 / 600)), `m0=${m[0]}`);
  check("projMatrix perspective row", m[11] === -1 && m[15] === 0);
}

// _project: origin projects to screen center; behind-camera -> null.
{
  const fake = { camera: { position: [0, 0, 10], target: [0, 0, 0], up: [0, 1, 0] } };
  const vm = Cam._calculateViewMatrix.call(fake);
  const pm = Cam._calculateProjectionMatrix.call({}, 800, 600);
  const s = Cam._project.call(fake, [0, 0, 0], vm, pm, 800, 600);
  check("project center", s && approx(s.x, 400) && approx(s.y, 300), JSON.stringify(s));
  check("project null input", Cam._project.call(fake, null, vm, pm, 800, 600) === null);
  check("project behind camera", Cam._project.call(fake, [0, 0, 20], vm, pm, 800, 600) === null);
}

// _perspScale: fallback 1, proportional, clamped at 10.
check("perspScale no focal", Cam._perspScale.call({}) === 1);
check("perspScale no obj", Cam._perspScale.call({ _focal: 500 }) === 1);
{
  const fake = { _focal: 200 };
  check("perspScale value", approx(Cam._perspScale.call(fake, { _distance: 100 }), 2));
  check("perspScale clamp", Cam._perspScale.call(fake, { _distance: 1 }) === 10);
}

// _introEnabled honors reduced-motion / disabled animation.
check("intro enabled by default", Cam._introEnabled.call({}) === true);

// _applyFitView copies position + target.
{
  const fake = { camera: { position: [0, 0, 0], target: [9, 9, 9] } };
  Cam._applyFitView.call(fake, { position: [1, 2, 3], target: [4, 5, 6] });
  check("applyFitView", fake.camera.position[0] === 1 && fake.camera.target[2] === 6);
}

// Follow lock: set -> lock flags + freeze; clear -> release.
// Receiver inherits the whole mixin (like GalaxyView.prototype does), so
// internal cross-calls (_updatePauseState/_clearFollow) resolve.
{
  const anim = { paused: false };
  const planet = { position: [10, 0, 0] };
  const fake = Object.assign(Object.create(Cam), { followTarget: null, animation: anim, hoveredObject: null });
  Cam._setFollow.call(fake, planet);
  check("setFollow locks", planet._followLocked === true && fake._selectionFrozen === true && anim.paused === true);
  // Planet drifts +X by 2 with no flight active: camera translates, aim locks.
  fake.camera = { position: [10, 5, 20], target: [10, 0, 0] };
  fake.interaction = { keys: {} };
  fake._followPrev = [10, 0, 0];
  planet.position = [12, 0, 0];
  Cam._updateFollow.call(fake);
  check("updateFollow translates camera", fake.camera.position[0] === 12 && fake.camera.target[0] === 12,
    `pos=${fake.camera.position} tgt=${fake.camera.target}`);
  // WASD releases the lock.
  fake.interaction.keys = { w: true };
  Cam._updateFollow.call(fake);
  check("updateFollow WASD releases", fake.followTarget === null && planet._followLocked === false);
}

console.log(`\nCamera math: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
