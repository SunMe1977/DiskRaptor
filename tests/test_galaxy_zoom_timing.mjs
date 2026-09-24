// Regression test: camera transitions (galaxy open zoom, planet focus) must
// complete after `duration` ms of WALL time, even when frames are slow.
// Previously progress accumulated clamped frame dt (16ms per frame), so on a
// heavy scan (~7fps) the 3.4s intro zoom stretched past 8s+ and the tail
// looked frozen — users saw a static galaxy with no zoom animation.
// Runs on plain node, no browser needed.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const src = await readFile(new URL('../frontend/galaxyview/animation.js', import.meta.url), 'utf8');

function loadEngine() {
  const window = {
    GalaxyViewConfig: {
      animation: { rotationScale: 1 },
      camera: { cinematicTransitionDuration: 1200 },
    },
    GalaxyView: {},
  };
  const sandbox = { window, console };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'animation.js' });
  return new sandbox.window.GalaxyView.AnimationEngine();
}

function makeCamera(z) {
  return { position: [0, z * 0.3, z], target: [0, 0, 0] };
}

// Drive the engine with a fixed frame step; return the wall timestamp at
// which the transition completed (or null if it never did).
function drive(engine, camera, { step, duration, maxFrames = 10000 }) {
  engine.flyTo([0, 100, 400], [0, 0, 0], duration);
  let t = 1000;
  for (let i = 0; i < maxFrames; i++) {
    engine.update(t, [], camera);
    if (engine.transitions.length === 0) return t;
    t += step;
  }
  return null;
}

// 1. Smooth 60fps: completes on schedule and snaps exactly onto the target.
{
  const engine = loadEngine();
  const camera = makeCamera(2600);
  const doneAt = drive(engine, camera, { step: 16.7, duration: 3400 });
  assert.ok(doneAt !== null, '60fps flight must complete');
  assert.ok(doneAt - 1000 <= 3400 + 100, `60fps flight must take ~3.4s wall (took ${doneAt - 1000}ms)`);
  assert.deepEqual(Array.from(camera.position), [0, 100, 400], 'camera must snap exactly onto target');
  assert.deepEqual(Array.from(camera.target), [0, 0, 0], 'target must snap exactly');
  console.log(`PASS 60fps: completed in ${Math.round(doneAt - 1000)}ms wall`);
}

// 2. Heavy scene (~7fps, 140ms frames): must STILL complete in ~duration.
{
  const engine = loadEngine();
  const camera = makeCamera(13000);
  const t0 = 1000;
  engine.flyTo([0, 630, 2100], [0, 0, 0], 3400);
  let t = t0;
  let lastZ = camera.position[2];
  let moved = false;
  let doneAt = null;
  for (let i = 0; i < 200; i++) {
    engine.update(t, [], camera);
    if (camera.position[2] < lastZ - 1e-9) moved = true;
    lastZ = camera.position[2];
    if (engine.transitions.length === 0) { doneAt = t; break; }
    t += 140;
  }
  assert.ok(moved, 'camera must visibly move during the flight');
  assert.ok(doneAt !== null, '7fps flight must complete');
  assert.ok(doneAt - t0 <= 3400 + 500, `7fps flight must take ~3.4s wall (took ${doneAt - t0}ms)`);
  assert.deepEqual(Array.from(camera.position), [0, 630, 2100], 'camera must arrive exactly');
  console.log(`PASS 7fps: completed in ${Math.round(doneAt - t0)}ms wall`);
}

// 3. Pausing object animation must not freeze an in-flight camera transition.
{
  const engine = loadEngine();
  const camera = makeCamera(2600);
  engine.pause();
  const doneAt = drive(engine, camera, { step: 16.7, duration: 1200 });
  assert.ok(doneAt !== null && doneAt - 1000 <= 1200 + 100, 'paused flight must still complete on schedule');
  console.log('PASS paused engine: camera transition still completes');
}

// 4. Cancelling (user grabs control) stops the flight immediately.
{
  const engine = loadEngine();
  const camera = makeCamera(2600);
  engine.flyTo([0, 100, 400], [0, 0, 0], 3400);
  engine.update(1000, [], camera);
  engine.update(1100, [], camera);
  engine.cancelTransitions();
  const z = camera.position[2];
  engine.update(5000, [], camera);
  assert.equal(engine.transitions.length, 0, 'no transitions after cancel');
  assert.equal(camera.position[2], z, 'camera must not move after cancel');
  console.log('PASS cancel: flight stops on user input');
}

console.log('\nPASS: galaxy zoom timing (wall-clock transitions)');

// 5. Orbit/rotation angular velocity must be CONSTANT over time (it used to
// integrate the absolute clock, so planets/moons spun faster every second
// until the galaxy blurred — and a followed planet could never be tracked).
{
  const engine = loadEngine();
  const planet = {
    type: 'planet', active: true, orbitSpeed: 0.0004, orbitRadius: 100,
    orbitAngle: 0, position: [100, 0, 0], rotationSpeed: 0.001,
    pulsePhase: 0, data: { files: 10 },
  };
  const moon = {
    type: 'moon', active: true, orbitSpeed: 0.003, orbitRadius: 10,
    orbitAngle: 0, position: [110, 0, 0], parentPosition: [100, 0, 0],
    id: 'm1',
  };
  const step = 16.7;
  let t = 1000;
  let earlyPlanet = null;
  let latePlanet = null;
  let earlyMoon = null;
  let lateMoon = null;
  let prevPlanet = 0;
  let prevMoon = 0;
  const perSecond = 60;
  let accPlanet = 0;
  let accMoon = 0;
  let second = 0;
  for (let i = 0; i < perSecond * 40; i++) {
    engine.update(t, [planet, moon], null);
    accPlanet += planet.orbitAngle - prevPlanet;
    accMoon += moon.orbitAngle - prevMoon;
    prevPlanet = planet.orbitAngle;
    prevMoon = moon.orbitAngle;
    t += step;
    if ((i + 1) % perSecond === 0) {
      second++;
      if (second === 1) { earlyPlanet = accPlanet; earlyMoon = accMoon; }
      if (second === 39) { latePlanet = accPlanet; lateMoon = accMoon; }
      accPlanet = 0;
      accMoon = 0;
    }
  }
  const planetRatio = latePlanet / earlyPlanet;
  const moonRatio = lateMoon / earlyMoon;
  assert.ok(planetRatio > 0.5 && planetRatio < 2, `planet orbit rate must stay constant (ratio ${planetRatio})`);
  assert.ok(moonRatio > 0.5 && moonRatio < 2, `moon orbit rate must stay constant (ratio ${moonRatio})`);
  assert.ok(earlyPlanet > 0, 'planets must keep moving');
  console.log(`PASS orbits: planet ${planetRatio.toFixed(2)}x, moon ${moonRatio.toFixed(2)}x (late vs early rate)`);
}

console.log('\nPASS: galaxy orbit constancy');

// 6. A follow-locked planet stands still (no orbit/spin) while others move.
{
  const engine = loadEngine();
  const base = {
    type: 'planet', active: true, orbitSpeed: 0.0004, orbitRadius: 100,
    orbitAngle: 0.5, position: [100, 0, 0], rotationSpeed: 0.001,
    pulsePhase: 0, data: { files: 10 },
  };
  const locked = { ...base, position: [...base.position], _followLocked: true };
  const free = { ...base, position: [...base.position] };
  let t = 1000;
  for (let i = 0; i < 300; i++) {
    engine.update(t, [locked, free], null);
    t += 16.7;
  }
  assert.equal(locked.orbitAngle, 0.5, 'locked planet must not orbit');
  assert.equal(locked._rotation, undefined, 'locked planet must not spin');
  assert.deepEqual(locked.position, [100, 0, 0], 'locked planet must not move');
  assert.ok(free.orbitAngle > 0.5, 'unlocked planet must keep orbiting');
  console.log('PASS follow-lock: selected planet stands still, others move');
}

console.log('\nPASS: galaxy follow lock');
