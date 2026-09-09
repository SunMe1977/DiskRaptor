// Browser-only regression for planet shading and the real lazy-loader.
// Run after npm run build:frontend to check both source modules and the bundle.
/* global window, document, loadGalaxyScripts */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const app = await readFile(new URL('../frontend/app.js', import.meta.url), 'utf8');
const loader = app.slice(app.indexOf('    function loadGalaxyScripts('), app.indexOf('    function _feedGalaxyView('));
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chromium', headless: true });
try {
  for (const built of [false, true]) {
    const root = new URL(built ? '../frontend-dist/' : '../frontend/', import.meta.url);
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://galaxy.test/**', async route => {
      const path = new URL(route.request().url()).pathname.slice(1);
      if (!path) return route.fulfill({ contentType: 'text/html', body: '<canvas id="preview" width="1000" height="700"></canvas>' });
      if (!built && path === 'galaxyview/bundle.js') return route.fulfill({ status: 404, body: '' });
      // Config arrives last to catch unordered dynamic script execution.
      if (path === 'galaxyview/config.js') await new Promise(resolve => setTimeout(resolve, 150));
      return route.fulfill({ contentType: 'application/javascript', body: await readFile(new URL(path, root), 'utf8') });
    });
    await page.goto('https://galaxy.test/');
    await page.addScriptTag({ content: loader });
    await page.evaluate(() => new Promise(resolve => loadGalaxyScripts(resolve)));
    const result = await page.evaluate(() => {
      const visuals = new window.GalaxyView.Visuals(window.GalaxyViewConfig);
      // Regression: seededRand must never go negative, which crashed arc() with
      // a negative radius during resize (buildLayers) and left the empty state.
      visuals.resize(800, 600);
      visuals.resize(320, 480);
      const canvas = document.getElementById('preview');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const color = [0.3, 0.6, 0.85];
      const luminance = (x, y) => {
        const p = ctx.getImageData(x, y, 1, 1).data;
        return p[0] * 0.2126 + p[1] * 0.7152 + p[2] * 0.0722;
      };
      const checks = [];
      for (const quality of ['high', 'medium', 'low']) {
        visuals.quality = quality;
        for (const radius of [4, 14, 45]) {
          for (const angle of [-Math.PI / 2, 0, Math.PI / 2, Math.PI]) {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            visuals.drawPlanet(ctx, 100, 100, radius, color, angle, 0, { id: 'test-planet', hasRing: false });
            const dx = Math.cos(angle) * radius * 0.6;
            const dy = Math.sin(angle) * radius * 0.6;
            checks.push({ quality, radius, angle,
              day: luminance(Math.round(100 + dx), Math.round(100 + dy)),
              night: luminance(Math.round(100 - dx), Math.round(100 - dy)),
              alpha: ctx.getImageData(100, 100, 1, 1).data[3],
            });
          }
        }
      }
      const sprites = [0, 1, 2, 3].map(variant => visuals._sphereSprite(color, 'p', variant));
      const hashes = sprites.map(sprite => {
        let hash = 2166136261;
        for (const byte of sprite.getContext('2d').getImageData(0, 0, sprite.width, sprite.height).data) {
          hash = Math.imul(hash ^ byte, 16777619);
        }
        return hash;
      });
      const reused = sprites[0] === visuals._sphereSprite(color, 'p', 0);
      const moon = visuals._sphereSprite([0.65, 0.65, 0.65], 'm');
      const moonPixels = moon.getContext('2d').getImageData(64, 30, 1, 65).data;
      const files = [{ path: 'C:/Photos/a.jpg', size: 1000000 }, { path: 'C:/Code/a.js', size: 100000 }];
      const stats = { top_files: files, total_files: 2, total_size: 1100000 };
      const mapper = new window.GalaxyView.DataMapper();
      mapper.mapData({ stats }, stats, files);
      const folders = mapper.planets.filter(planet => planet.id.startsWith('planet-'));
      const view = new window.GalaxyView.GalaxyView(document.createElement('div'));
      const integrated = view.visuals instanceof window.GalaxyView.Visuals;
      view._lightScreen = { x: 100, y: 0 };
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      view._renderPlanet(ctx, { x: 100, y: 100 }, { scale: 40, color, id: 'test-planet', hasRing: false }, { pulse: 1 }, 0);
      const integrationContrast = luminance(100, 76) - luminance(100, 124);

      // Contact sheet for optional manual inspection, including actual UI sizes.
      ctx.fillStyle = '#050914'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.font = '20px system-ui'; ctx.fillStyle = '#d7dfec';
      ctx.fillText('GalaxyView: lit surfaces, opaque night sides', 35, 40);
      const colors = [[0.74, 0.47, 0.24], [0.18, 0.45, 0.8], [0.65, 0.24, 0.12], [0.28, 0.57, 0.67]];
      for (let i = 0; i < 4; i++) {
        const x = 130 + i * 245;
        ctx.drawImage(visuals._sphereSprite(colors[i], 'p', i), x - 85, 90, 170, 170);
        ctx.fillStyle = '#aebbd0'; ctx.fillText(i % 2 === 0 ? 'Gas giant' : 'Rocky / ocean', x - 65, 300);
        for (const [j, r] of [4, 14, 45].entries()) {
          visuals.drawPlanet(ctx, x, 355 + j * 100, r, colors[i], -Math.PI * 0.7, 0, { id: String(i), hasRing: j === 2 && i === 0 });
        }
      }
      visuals.drawMoon(ctx, 80, 645, 24, [0.65, 0.65, 0.65], -Math.PI * 0.65, 0);
      ctx.fillStyle = '#aebbd0'; ctx.fillText('Cratered moon', 120, 652);
      return { checks, hashes, reused, integrated, integrationContrast,
        moonDay: moonPixels[0], moonNight: moonPixels[64 * 4],
        folders: folders.map(p => ({ path: p.path, scale: p.scale })) };
    });
    assert.deepEqual(errors, [], 'lazy loading must not cause dependency errors');
    assert.ok(result.integrated, 'GalaxyView must use the visual engine');
    assert.ok(result.integrationContrast > 25, 'the actual planet renderer must preserve directional shading');
    for (const check of result.checks) {
      assert.equal(check.alpha, 255, 'planet interiors must stay opaque');
      assert.ok(check.day > check.night * 2 + 12, `day/night shading lost: ${JSON.stringify(check)}`);
    }
    assert.equal(new Set(result.hashes).size, 4, 'surface variants must be distinct');
    assert.ok(result.reused, 'sprites must be reused instead of regenerated each frame');
    assert.ok(result.moonDay > result.moonNight * 3, 'moons need directional shading too');
    assert.deepEqual(result.folders.map(p => p.path), ['C:/Photos', 'C:/Code']);
    assert.ok(result.folders[0].scale > result.folders[1].scale && result.folders[0].scale > 30);
    if (built && process.env.GALAXY_SCREENSHOT) await page.screenshot({ path: process.env.GALAXY_SCREENSHOT });
    console.log(`PASS ${built ? 'production bundle' : 'source modules (delayed config)'}: lighting, opacity, textures, cache, scan mapping and renderer integration`);
    await page.close();
  }
} finally {
  await browser.close();
}
