/**
 * DiskRaptor — GalaxyView Visual Engine
 * Cached-sprite rendering for gradient planets with day/night shading, star
 * coronas with diffraction flares, parallax starfields with a milky-way band,
 * drifting 3D dust, and a layered black-hole accretion disk.
 *
 * Performance strategy: expensive gradient spheres are pre-rendered once per
 * color into offscreen sprites and blitted (rotated toward the light) instead
 * of building radial gradients per object per frame. The static starfield is
 * baked into layer canvases; only a small set of bright stars twinkles live.
 */
(function () {
  "use strict";

  const CFG = window.GalaxyViewConfig;
  const TAU = Math.PI * 2;
  const SPRITE_SIZE = 128;
  const MAX_SPRITES = 320;

  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function rgba(c, a) {
    return `rgba(${clamp01(c[0]) * 255 | 0},${clamp01(c[1]) * 255 | 0},${clamp01(c[2]) * 255 | 0},${a})`;
  }
  function mul(c, f) { return [clamp01(c[0] * f), clamp01(c[1] * f), clamp01(c[2] * f)]; }
  function mixc(a, b, t) {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  }
  // Stable 32-bit string hash → deterministic per-object variation.
  function hashStr(s) {
    let h = 2166136261;
    s = String(s || "");
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0) / 4294967295;
  }
  function seededRand(seed) {
    // Keep the LCG state strictly positive: `| 0` on a large seed can wrap to a
    // negative int, and a negative `%` result made rnd() return negative values,
    // which crashed arc() with a negative radius and produced NaN positions.
    let s = (seed * 2147483647) >>> 0;
    if (s === 0) s = 1;
    return function () {
      s = (s * 16807) % 2147483647;
      if (s <= 0) s = 1;
      return (s - 1) / 2147483646;
    };
  }
  function makeCanvas(w, h) {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    return c;
  }

  class Visuals {
    constructor(cfg) {
      this.cfg = cfg || CFG;
      this.vcfg = (this.cfg && this.cfg.visual) || {};
      this.acc = (this.cfg && this.cfg.accessibility) || {};
      this.quality = "high"; // high | medium | low
      this.sprites = new Map();
      this.dust = [];
      this.dustCount = 0;
      this.twinklers = [];
      this.layers = [];
      this.backdrop = null;
      this.width = 0;
      this.height = 0;
      this._buildDust();
      this._buildTwinklers();
    }

    get motion() {
      return this.acc.reducedMotion ? 0 : (this.acc.animationIntensity !== undefined ? this.acc.animationIntensity : 1);
    }

    // ── Sprite cache ────────────────────────────────────────────

    _sprite(key, size, painter) {
      let s = this.sprites.get(key);
      if (s) return s;
      if (this.sprites.size >= MAX_SPRITES) {
        const first = this.sprites.keys().next().value;
        this.sprites.delete(first);
      }
      s = makeCanvas(size, size);
      painter(s.getContext("2d"), size);
      this.sprites.set(key, s);
      return s;
    }

    _colorKey(c) {
      return `${(clamp01(c[0]) * 255 | 0) >> 3},${(clamp01(c[1]) * 255 | 0) >> 3},${(clamp01(c[2]) * 255 | 0) >> 3}`;
    }

    // Surface normals provide a curved terminator and limb shading. Textures
    // are evaluated on the sphere, then lit, never painted over the night side.
    _sphereSprite(color, kind, variant = 0) {
      const key = `sph|${kind}|${variant}|${this._colorKey(color)}`;
      return this._sprite(key, SPRITE_SIZE, (ctx, size) => {
        const radius = size / 2 - 1;
        if (kind === "star") {
          const glow = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, radius);
          glow.addColorStop(0, rgba([1, 1, 0.94], 1));
          glow.addColorStop(0.7, rgba(mixc(color, [1, 1, 1], 0.4), 1));
          glow.addColorStop(1, rgba(color, 1));
          ctx.fillStyle = glow;
          ctx.beginPath(); ctx.arc(size / 2, size / 2, radius, 0, TAU); ctx.fill();
          return;
        }
        const moon = kind === "m";
        const gas = !moon && variant % 2 === 0 && this.vcfg.planetBands !== false;
        const phase = variant * 2.37 + hashStr(this._colorKey(color)) * TAU;
        const rnd = seededRand(hashStr(key));
        const craters = Array.from({ length: moon ? 18 : 0 }, () => {
          const cy = rnd() * 1.7 - 0.85;
          const angle = rnd() * Math.PI;
          const ring = Math.sqrt(1 - cy * cy);
          return { x: Math.cos(angle) * ring, y: cy, z: Math.sin(angle) * ring, r: 0.06 + rnd() * 0.16 };
        });
        const image = ctx.createImageData(size, size);
        for (let y = 0; y < size; y++) {
          for (let x = 0; x < size; x++) {
            const nx = (x + 0.5 - size / 2) / radius;
            const ny = (y + 0.5 - size / 2) / radius;
            const rr = nx * nx + ny * ny;
            if (rr >= 1) continue;
            const nz = Math.sqrt(1 - rr);
            const lat = Math.asin(ny);
            const lon = Math.atan2(nx, nz);
            const terrain = Math.sin(nx * 8 + phase + Math.sin(nz * 11 + ny * 5)) *
              Math.cos(ny * 9 - nz * 6 + phase) +
              0.35 * Math.sin(nx * 23 + ny * 17 + Math.sin(nz * 19));
            let surface;
            let relief = 1;
            if (gas) {
              const wave = lat * 24 + Math.sin(lon * 5 + phase + lat * 8) * 0.8 + terrain * 0.6;
              const bands = Math.sin(wave) * 0.5 + Math.sin(wave * 2.3) * 0.18;
              surface = mixc(mul(color, 0.5), mixc(color, [0.94, 0.87, 0.72], 0.6), clamp01(0.5 + bands));
            } else if (moon) {
              surface = mul(mixc(color, [0.55, 0.53, 0.5], 0.45), 0.8 + terrain * 0.18);
              for (const crater of craters) {
                const d = Math.hypot(nx - crater.x, ny - crater.y, nz - crater.z) / crater.r;
                if (d < 1.2) {
                  relief *= d < 0.8 ? 0.65 + 0.3 * (ny - crater.y) / crater.r : 1.2;
                }
              }
            } else {
              const land = clamp01((terrain - 0.05) * 7);
              const ocean = mul(color, 0.65);
              const rock = mixc(color, [0.55, 0.53, 0.32], 0.65);
              surface = mixc(ocean, rock, land);
              const clouds = clamp01((Math.sin(lon * 13 + lat * 8 + terrain * 3 + phase) +
                Math.sin(lat * 22 - lon * 7) - 1.05) * 0.8);
              surface = mixc(surface, [0.92, 0.94, 0.95], clouds * 0.8);
              const ice = clamp01((Math.abs(ny) - 0.88 + terrain * 0.025) * 14);
              surface = mixc(surface, [0.85, 0.9, 0.94], ice);
            }
            // Light points upward and slightly toward the viewer. A specular
            // lobe and a deep terminator read as a curved, glossy sphere rather
            // than a flat disc. The surface stays opaque even in full shadow.
            const diffuse = Math.max(0, -ny * 0.88 + nz * 0.475);
            const specular = Math.pow(diffuse, 24) * 0.55;
            const light = Math.min(1.12, 0.035 + 0.965 * Math.pow(diffuse, 0.7) + specular);
            const atmosphere = moon ? 0 : Math.pow(1 - nz, 3) * diffuse * 0.32;
            const i = (y * size + x) * 4;
            for (let channel = 0; channel < 3; channel++) {
              image.data[i + channel] = clamp01(surface[channel] * relief * light +
                atmosphere * [0.35, 0.6, 1][channel]) * 255;
            }
            image.data[i + 3] = clamp01((1 - Math.sqrt(rr)) * radius) * 255;
          }
        }
        ctx.putImageData(image, 0, 0);
      });
    }

    /** Additive radial glow sprite (stars, nebula cores, comet heads). */
    _glowSprite(color, power) {
      const key = `glow|${power}|${this._colorKey(color)}`;
      return this._sprite(key, SPRITE_SIZE, (x, S) => {
        const cx = S / 2, r = S / 2;
        const g = x.createRadialGradient(cx, cx, 0, cx, cx, r);
        g.addColorStop(0, rgba(mixc(color, [1, 1, 1], 0.7), 0.95));
        g.addColorStop(0.12, rgba(color, 0.55 * power));
        g.addColorStop(0.35, rgba(color, 0.18 * power));
        g.addColorStop(0.7, rgba(color, 0.04 * power));
        g.addColorStop(1, rgba(color, 0));
        x.fillStyle = g;
        x.fillRect(0, 0, S, S);
      });
    }

    // ── Sizing ──────────────────────────────────────────────────

    resize(w, h) {
      if (w <= 0 || h <= 0 || (w === this.width && h === this.height)) return;
      this.width = w; this.height = h;
      this._buildBackdrop();
      this._buildLayers();
    }

    _buildBackdrop() {
      const w = this.width, h = this.height;
      const c = makeCanvas(w, h);
      const x = c.getContext("2d");
      const g = x.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, "#03050c");
      g.addColorStop(0.45, "#070d1c");
      g.addColorStop(1, "#0b1428");
      x.fillStyle = g;
      x.fillRect(0, 0, w, h);
      // Faint galactic core glow behind the system.
      const core = x.createRadialGradient(w / 2, h * 0.52, 0, w / 2, h * 0.52, Math.max(w, h) * 0.55);
      core.addColorStop(0, "rgba(70,90,160,0.14)");
      core.addColorStop(0.4, "rgba(40,55,110,0.06)");
      core.addColorStop(1, "rgba(0,0,0,0)");
      x.fillStyle = core;
      x.fillRect(0, 0, w, h);
      // Cinematic vignette.
      const v = x.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.42, w / 2, h / 2, Math.max(w, h) * 0.78);
      v.addColorStop(0, "rgba(0,0,0,0)");
      v.addColorStop(1, "rgba(0,0,4,0.5)");
      x.fillStyle = v;
      x.fillRect(0, 0, w, h);
      this.backdrop = c;
    }

    // ── Parallax starfield (baked layers + live twinkle) ───────

    _buildLayers() {
      const w = this.width, h = this.height;
      // Overscan so parallax shifting never exposes empty edges.
      const ow = w + 240, oh = h + 240;
      const specs = [
        { count: 900, max: 0.9, alpha: [0.12, 0.4], depth: 0.15, milky: true },
        { count: 550, max: 1.3, alpha: [0.25, 0.6], depth: 0.4 },
        { count: 260, max: 1.9, alpha: [0.45, 0.9], depth: 0.85 },
      ];
      const tints = [[0.75, 0.82, 1], [1, 1, 1], [1, 0.93, 0.8], [0.85, 0.9, 1], [1, 0.85, 0.72]];
      this.layers = specs.map((spec, li) => {
        const c = makeCanvas(ow, oh);
        const x = c.getContext("2d");
        const rnd = seededRand(1337 + li * 71);
        if (spec.milky) this._paintMilkyWay(x, ow, oh, rnd);
        for (let i = 0; i < spec.count; i++) {
          const sx = rnd() * ow, sy = rnd() * oh;
          const sz = 0.25 + rnd() * spec.max;
          const a = spec.alpha[0] + rnd() * (spec.alpha[1] - spec.alpha[0]);
          const tint = tints[(rnd() * tints.length) | 0];
          x.fillStyle = rgba(tint, a);
          x.beginPath(); x.arc(sx, sy, sz, 0, TAU); x.fill();
          if (sz > spec.max * 0.82) {
            // Bright stars get a soft cross flare in the bake.
            x.save();
            x.globalCompositeOperation = "lighter";
            x.strokeStyle = rgba(tint, a * 0.28);
            x.lineWidth = 0.6;
            const L = sz * 4.5;
            x.beginPath();
            x.moveTo(sx - L, sy); x.lineTo(sx + L, sy);
            x.moveTo(sx, sy - L); x.lineTo(sx, sy + L);
            x.stroke();
            x.restore();
          }
        }
        return { canvas: c, depth: spec.depth, w: ow, h: oh };
      });
    }

    _paintMilkyWay(x, w, h, rnd) {
      x.save();
      x.globalCompositeOperation = "lighter";
      // Diagonal band of soft clouds + dense tiny stars.
      const ang = -0.42;
      const cos = Math.cos(ang), sin = Math.sin(ang);
      const puffs = 54;
      for (let i = 0; i < puffs; i++) {
        const t = i / puffs;
        const bx = w * (0.08 + t * 0.88) + (rnd() - 0.5) * w * 0.06;
        const by = h * 0.5 + (bx - w / 2) * Math.tan(ang) + (rnd() - 0.5) * h * 0.16;
        const pr = (0.06 + rnd() * 0.14) * Math.max(w, h) * 0.5;
        const warm = rnd();
        const col = warm > 0.6 ? [110, 90, 160] : warm > 0.3 ? [80, 110, 180] : [120, 130, 190];
        const g = x.createRadialGradient(bx, by, 0, bx, by, pr);
        g.addColorStop(0, `rgba(${col[0]},${col[1]},${col[2]},${0.05 + rnd() * 0.05})`);
        g.addColorStop(0.5, `rgba(${col[0]},${col[1]},${col[2]},0.02)`);
        g.addColorStop(1, "rgba(0,0,0,0)");
        x.fillStyle = g;
        x.beginPath(); x.arc(bx, by, pr, 0, TAU); x.fill();
      }
      for (let i = 0; i < 1600; i++) {
        const bx = rnd() * w;
        const bandY = h * 0.5 + (bx - w / 2) * Math.tan(ang);
        const spread = h * 0.1 * (0.3 + rnd() * 0.7);
        const by = bandY + (rnd() + rnd() + rnd() - 1.5) * spread * 2;
        const a = 0.05 + rnd() * 0.3;
        x.fillStyle = `rgba(210,220,255,${a})`;
        x.fillRect(bx, by, rnd() < 0.15 ? 1.4 : 0.9, rnd() < 0.15 ? 1.4 : 0.9);
      }
      x.restore();
      void cos; void sin;
    }

    _buildTwinklers() {
      const n = (this.vcfg.twinkleCount !== undefined ? this.vcfg.twinkleCount : 140);
      this.twinklers = [];
      const rnd = seededRand(90210);
      for (let i = 0; i < n; i++) {
        this.twinklers.push({
          x: rnd(), y: rnd(),
          size: 0.7 + rnd() * 1.5,
          phase: rnd() * TAU,
          speed: 0.6 + rnd() * 2.2,
          warm: rnd() > 0.7,
        });
      }
    }

    _buildDust() {
      const n = (this.vcfg.dustCount !== undefined ? this.vcfg.dustCount : 600);
      this.dust = [];
      const rnd = seededRand(4242);
      for (let i = 0; i < n; i++) {
        // Thin galactic disk distribution (denser toward the core).
        const t = rnd();
        const rad = 0.15 + Math.pow(t, 0.65) * 0.85;
        const ang = rnd() * TAU;
        this.dust.push({
          x: Math.cos(ang) * rad,
          y: (rnd() - 0.5) * 0.09 * (1.2 - rad),
          z: Math.sin(ang) * rad,
          size: 0.6 + rnd() * 1.6,
          alpha: 0.1 + rnd() * 0.4,
          spin: 0.014 + rnd() * 0.03,
          warm: rnd() > 0.72,
        });
      }
      this.dustCount = n;
    }

    // ── Frame renderers ─────────────────────────────────────────

    paintBackdrop(ctx) {
      if (this.backdrop) ctx.drawImage(this.backdrop, 0, 0);
    }

    renderStarfield(ctx, w, h, time, camera) {
      if (!this.layers.length) return;
      // Parallax from camera azimuth/elevation.
      let az = 0, el = 0;
      if (camera && camera.position) {
        const p = camera.position;
        az = Math.atan2(p[0], p[2]);
        const len = Math.max(1, Math.hypot(p[0], p[1], p[2]));
        el = p[1] / len;
      }
      const tm = time * this.motion;
      for (const layer of this.layers) {
        let ox = (-az * 260 * layer.depth) % layer.w;
        let oy = (-el * 180 * layer.depth) % layer.h;
        if (ox > 0) ox -= layer.w;
        if (oy > 0) oy -= layer.h;
        const baseX = ox - 120, baseY = oy - 120;
        ctx.drawImage(layer.canvas, baseX, baseY);
        if (baseX + layer.w < w) ctx.drawImage(layer.canvas, baseX + layer.w, baseY);
        if (baseY + layer.h < h) ctx.drawImage(layer.canvas, baseX, baseY + layer.h);
        if (baseX + layer.w < w && baseY + layer.h < h) {
          ctx.drawImage(layer.canvas, baseX + layer.w, baseY + layer.h);
        }
      }
      // Live twinkling bright stars on top.
      const tw = this.quality === "low" ? 0 : this.quality === "medium" ? 50 : this.twinklers.length;
      if (tw > 0) {
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        for (let i = 0; i < tw; i++) {
          const s = this.twinklers[i];
          const a = 0.35 + Math.sin(tm * s.speed + s.phase) * 0.3;
          if (a <= 0.05) continue;
          const sx = s.x * w, sy = s.y * h;
          ctx.fillStyle = s.warm ? `rgba(255,226,190,${a})` : `rgba(214,228,255,${a})`;
          ctx.beginPath(); ctx.arc(sx, sy, s.size, 0, TAU); ctx.fill();
          if (s.size > 1.6) {
            ctx.fillStyle = s.warm ? `rgba(255,214,160,${a * 0.18})` : `rgba(190,210,255,${a * 0.18})`;
            ctx.beginPath(); ctx.arc(sx, sy, s.size * 3.4, 0, TAU); ctx.fill();
          }
        }
        ctx.restore();
      }
    }

    renderDust(ctx, project, time, extent) {
      let n = this.dustCount;
      if (this.quality === "low") return;
      if (this.quality === "medium") n = Math.min(n, 240);
      const tm = time * this.motion;
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      for (let i = 0; i < n; i++) {
        const d = this.dust[i];
        const a = d.spin * tm;
        const ca = Math.cos(a), sa = Math.sin(a);
        const wx = (d.x * ca - d.z * sa) * extent;
        const wz = (d.x * sa + d.z * ca) * extent;
        const wy = d.y * extent;
        const s = project([wx, wy, wz]);
        if (!s || s.x < -8 || s.y < -8 || s.x > this.width + 8 || s.y > this.height + 8) continue;
        const depthFade = clamp01(1.15 - Math.abs(s.z) * 0.9);
        const alpha = d.alpha * depthFade * 0.8;
        if (alpha <= 0.02) continue;
        ctx.fillStyle = d.warm ? `rgba(255,208,160,${alpha})` : `rgba(168,190,255,${alpha})`;
        const sz = d.size * depthFade;
        ctx.fillRect(s.x - sz * 0.5, s.y - sz * 0.5, sz, sz);
      }
      ctx.restore();
    }

    // ── Celestial bodies ────────────────────────────────────────

    drawStar(ctx, x0, y0, r, color, glow, time) {
      if (r < 0.5) return;
      const tm = time * this.motion;
      const c = color || [1, 0.85, 0.4];
      // Layered corona (additive).
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      const gSprite = this._glowSprite(c, 1);
      const gr = r * (7 + glow * 5 + Math.sin(tm * 1.4) * 0.4);
      ctx.globalAlpha = 0.5 + glow * 0.35;
      ctx.drawImage(gSprite, x0 - gr, y0 - gr, gr * 2, gr * 2);
      // Chromatic echo.
      ctx.globalAlpha = 0.16 + glow * 0.1;
      const gr2 = gr * 1.35;
      ctx.drawImage(this._glowSprite([c[0] * 0.7, c[1] * 0.8, 1], 0.7), x0 - gr2, y0 - gr2, gr2 * 2, gr2 * 2);
      // Diffraction spikes.
      if (this.quality !== "low") {
        const spikes = this.quality === "high" ? 2 : 1;
        for (let pass = 0; pass < spikes; pass++) {
          const long = pass === 0;
          const len = r * (long ? 5.5 + glow * 7 : 2.6 + glow * 3) * (1 + Math.sin(tm * 2.1 + pass) * 0.07);
          const alpha = (long ? 0.3 : 0.16) + glow * 0.25;
          const rot = tm * 0.05 + (pass ? Math.PI / 4 : 0);
          for (let k = 0; k < 4; k++) {
            const ang = rot + k * Math.PI / 2;
            const ex = x0 + Math.cos(ang) * len, ey = y0 + Math.sin(ang) * len;
            const sg = ctx.createLinearGradient(x0, y0, ex, ey);
            sg.addColorStop(0, rgba(mixc(c, [1, 1, 1], 0.6), alpha));
            sg.addColorStop(0.25, rgba(c, alpha * 0.4));
            sg.addColorStop(1, rgba(c, 0));
            ctx.strokeStyle = sg;
            ctx.lineWidth = long ? Math.max(1.2, r * 0.16) : Math.max(0.8, r * 0.09);
            ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(ex, ey); ctx.stroke();
          }
        }
      }
      ctx.restore();
      // Photosphere.
      const body = this._sphereSprite(mixc(c, [1, 1, 1], 0.45), "star");
      ctx.drawImage(body, x0 - r, y0 - r, r * 2, r * 2);
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.fillStyle = `rgba(255,252,240,${0.75 + glow * 0.2})`;
      ctx.beginPath(); ctx.arc(x0, y0, r * 0.52, 0, TAU); ctx.fill();
      ctx.restore();
    }

     drawPlanet(ctx, x0, y0, r, color, lightAngle, rotation, opts) {
       if (r < 0.6) return;
      opts = opts || {};
      const c = color || [0.5, 0.6, 0.8];
      const seed = hashStr(opts.id);
      const hasRing = opts.hasRing !== undefined ? opts.hasRing : (r > 13 && seed > 0.62);
      const tilt = (seed - 0.5) * 0.7;
      const rot = (lightAngle !== null && lightAngle !== undefined) ? lightAngle + Math.PI / 2 : 0;

      if (hasRing) this._ringHalf(ctx, x0, y0, r, c, tilt, true, seed);

      // A small set of stable surface variants keeps the sprite cache bounded.
      const sph = this._sphereSprite(c, "p", Math.round(seed * 4294967295) % 4);
      ctx.save();
      ctx.translate(x0, y0);
      ctx.rotate(rot);
      ctx.drawImage(sph, -r, -r, r * 2, r * 2);
      ctx.restore();

      if (hasRing) this._ringHalf(ctx, x0, y0, r, c, tilt, false, seed);
    }

    _ringHalf(ctx, x0, y0, r, c, tilt, back, seed) {
      const rx = r * (1.55 + seed * 0.5);
      const ry = rx * (0.24 + seed * 0.1);
      ctx.save();
      ctx.translate(x0, y0);
      ctx.rotate(tilt);
      const start = back ? Math.PI : 0;
      const end = back ? TAU : Math.PI;
      const bandCol = mixc(c, [1, 0.95, 0.85], 0.45);
      const bands = [
        { rr: 0.78, w: r * 0.16, a: 0.34 },
        { rr: 1.0, w: r * 0.3, a: 0.5 },
        { rr: 1.18, w: r * 0.1, a: 0.24 },
      ];
      for (const b of bands) {
        ctx.strokeStyle = rgba(bandCol, b.a);
        ctx.lineWidth = Math.max(0.8, b.w);
        ctx.beginPath();
        ctx.ellipse(0, 0, rx * b.rr, ry * b.rr, 0, start, end);
        ctx.stroke();
      }
      // Faint sheen line through the rings.
      ctx.strokeStyle = rgba(mixc(bandCol, [1, 1, 1], 0.6), 0.2);
      ctx.lineWidth = Math.max(0.5, r * 0.05);
      ctx.beginPath();
      ctx.ellipse(0, 0, rx * 0.94, ry * 0.94, 0, start, end);
      ctx.stroke();
      ctx.restore();
    }

    drawMoon(ctx, x0, y0, r, color, lightAngle, sparkle) {
      if (r < 0.35) return;
      const c = color || [0.7, 0.7, 0.75];
      if (r < 2.2) {
        // Tiny moons: flat dot + faint glow reads better than a scaled sprite.
        ctx.save();
        ctx.fillStyle = rgba(mixc(c, [1, 1, 1], 0.15), 0.95);
        ctx.beginPath(); ctx.arc(x0, y0, r, 0, TAU); ctx.fill();
        if (sparkle > 0.55) {
          ctx.globalCompositeOperation = "lighter";
          ctx.fillStyle = rgba(c, (sparkle - 0.55) * 0.7);
          ctx.beginPath(); ctx.arc(x0, y0, r * 2.6, 0, TAU); ctx.fill();
        }
        ctx.restore();
        return;
      }
      const sph = this._sphereSprite(c, "m");
      const rot = (lightAngle !== null && lightAngle !== undefined) ? lightAngle + Math.PI / 2 : 0;
      ctx.save();
      ctx.translate(x0, y0);
      ctx.rotate(rot);
      ctx.drawImage(sph, -r, -r, r * 2, r * 2);
      ctx.restore();
      if (sparkle > 0.4) {
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = (sparkle - 0.4) * 0.5;
        const g = this._glowSprite(c, 0.8);
        ctx.drawImage(g, x0 - r * 3, y0 - r * 3, r * 6, r * 6);
        ctx.restore();
      }
    }

    drawBlackHole(ctx, x0, y0, r, time, lensing) {
      if (r < 1.5) return;
      const tm = time * this.motion;
      const tilt = -0.28;
      const rx = r * 2.6, ry = rx * 0.3;
      const sweep = tm * 0.9;

      // Outer gravitational halo.
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = 0.2 + lensing * 0.15;
      const halo = this._glowSprite([0.45, 0.4, 1], 0.8);
      ctx.drawImage(halo, x0 - r * 4, y0 - r * 4, r * 8, r * 8);
      ctx.restore();

      this._accretion(ctx, x0, y0, rx, ry, tilt, r, sweep, true, lensing);

      // Event horizon + photon ring.
      ctx.save();
      ctx.fillStyle = "#000";
      ctx.shadowColor = "rgba(0,0,0,0.95)";
      ctx.shadowBlur = r * 1.6;
      ctx.beginPath(); ctx.arc(x0, y0, r * 0.62, 0, TAU); ctx.fill();
      ctx.shadowBlur = 0;
      ctx.globalCompositeOperation = "lighter";
      const pr = ctx.createRadialGradient(x0, y0, r * 0.56, x0, y0, r * 0.78);
      pr.addColorStop(0, "rgba(255,240,220,0)");
      pr.addColorStop(0.55, `rgba(255,236,200,${0.5 + lensing * 0.3})`);
      pr.addColorStop(0.75, "rgba(255,170,90,0.25)");
      pr.addColorStop(1, "rgba(255,120,60,0)");
      ctx.fillStyle = pr;
      ctx.beginPath(); ctx.arc(x0, y0, r * 0.8, 0, TAU); ctx.fill();
      ctx.restore();

      this._accretion(ctx, x0, y0, rx, ry, tilt, r, sweep, false, lensing);
    }

    _accretion(ctx, x0, y0, rx, ry, tilt, r, sweep, back, lensing) {
      ctx.save();
      ctx.translate(x0, y0);
      ctx.rotate(tilt);
      ctx.globalCompositeOperation = "lighter";
      const start = back ? Math.PI : 0;
      const end = back ? TAU : Math.PI;
      const bands = [
        { rr: 0.55, w: Math.max(1.2, r * 0.2), col: [1, 0.92, 0.75], a: 0.85 },
        { rr: 0.75, w: Math.max(1.4, r * 0.3), col: [1, 0.62, 0.28], a: 0.6 },
        { rr: 0.95, w: Math.max(1, r * 0.16), col: [0.85, 0.3, 0.2], a: 0.34 },
      ];
      for (const b of bands) {
        // Doppler beaming: the approaching (left) side burns brighter.
        ctx.strokeStyle = rgba(b.col, b.a * (0.72 + lensing * 0.28));
        ctx.lineWidth = b.w;
        ctx.beginPath();
        ctx.ellipse(0, 0, rx * b.rr, ry * b.rr, 0, start, end);
        ctx.stroke();
      }
      // Rotating hot sweep in the disk.
      const seg = 0.9;
      const a0 = (sweep % TAU);
      for (let k = 0; k < 2; k++) {
        const s0 = a0 + k * Math.PI;
        const inRange = back
          ? (s0 % TAU) > Math.PI * 0.9 && (s0 % TAU) < Math.PI * 2
          : true;
        if (!inRange && back) continue;
        const gcol = [1, 0.95, 0.85];
        ctx.strokeStyle = rgba(gcol, 0.5);
        ctx.lineWidth = Math.max(1, r * 0.14);
        ctx.beginPath();
        ctx.ellipse(0, 0, rx * 0.66, ry * 0.66, 0, s0, s0 + seg);
        ctx.stroke();
        ctx.strokeStyle = rgba(gcol, 0.16);
        ctx.lineWidth = Math.max(2, r * 0.4);
        ctx.beginPath();
        ctx.ellipse(0, 0, rx * 0.66, ry * 0.66, 0, s0, s0 + seg);
        ctx.stroke();
      }
      ctx.restore();
    }

    drawNebula(ctx, x0, y0, r, color, alpha, time, seed) {
      if (r < 2) return;
      const tm = time * this.motion;
      const c = color || [0.5, 0.4, 0.9];
      const sd = hashStr(seed);
      const rnd = seededRand(((sd * 1e6) | 0) + 3);
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      const blobs = this.quality === "low" ? 3 : 5;
      for (let i = 0; i < blobs; i++) {
        const bAng = rnd() * TAU + tm * 0.03 * (i % 2 ? 1 : -1);
        const bDist = r * (0.1 + rnd() * 0.42);
        const bx = x0 + Math.cos(bAng) * bDist;
        const by = y0 + Math.sin(bAng) * bDist * 0.8;
        const br = r * (0.4 + rnd() * 0.4);
        const tint = i % 3 === 0 ? mixc(c, [1, 1, 1], 0.25) : i % 3 === 1 ? c : mixc(c, [0.4, 0.6, 1], 0.4);
        const g = ctx.createRadialGradient(bx, by, 0, bx, by, br);
        g.addColorStop(0, rgba(tint, alpha * 0.3));
        g.addColorStop(0.45, rgba(tint, alpha * 0.12));
        g.addColorStop(1, rgba(tint, 0));
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(bx, by, br, 0, TAU); ctx.fill();
      }
      // Embedded newborn stars.
      if (this.quality !== "low") {
        const stars = 5 + ((sd * 5) | 0);
        for (let i = 0; i < stars; i++) {
          const sAng = rnd() * TAU;
          const sDist = r * Math.sqrt(rnd()) * 0.72;
          const sx = x0 + Math.cos(sAng) * sDist;
          const sy = y0 + Math.sin(sAng) * sDist * 0.85;
          const tw = 0.5 + Math.sin(tm * (1 + rnd() * 2) + i * 2.3) * 0.35;
          const sr = 0.7 + rnd() * 1.1;
          ctx.fillStyle = `rgba(255,250,240,${0.5 * tw + 0.2})`;
          ctx.beginPath(); ctx.arc(sx, sy, sr, 0, TAU); ctx.fill();
          ctx.fillStyle = `rgba(200,220,255,${0.12 * tw})`;
          ctx.beginPath(); ctx.arc(sx, sy, sr * 4, 0, TAU); ctx.fill();
        }
      }
      ctx.restore();
    }

    drawComet(ctx, x0, y0, r, alpha, tailDx, tailDy) {
      if (alpha <= 0.02) return;
      const len = Math.hypot(tailDx || 0, tailDy || 0);
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      if (len > 0.001) {
        const ex = x0 + tailDx, ey = y0 + tailDy;
        const g = ctx.createLinearGradient(x0, y0, ex, ey);
        g.addColorStop(0, `rgba(210,240,255,${alpha * 0.55})`);
        g.addColorStop(0.3, `rgba(150,200,255,${alpha * 0.22})`);
        g.addColorStop(1, "rgba(120,170,255,0)");
        ctx.strokeStyle = g;
        ctx.lineCap = "round";
        // Tapered tail: two strokes of shrinking width.
        ctx.lineWidth = Math.max(1.5, r * 1.5);
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x0 + tailDx * 0.55, y0 + tailDy * 0.55); ctx.stroke();
        ctx.lineWidth = Math.max(0.7, r * 0.7);
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(ex, ey); ctx.stroke();
      }
      const g = this._glowSprite([0.7, 0.85, 1], 1);
      const gr = r * 6;
      ctx.globalAlpha = alpha;
      ctx.drawImage(g, x0 - gr, y0 - gr, gr * 2, gr * 2);
      ctx.restore();
      ctx.save();
      ctx.fillStyle = `rgba(255,255,255,${alpha})`;
      ctx.beginPath(); ctx.arc(x0, y0, Math.max(0.8, r * 0.7), 0, TAU); ctx.fill();
      ctx.restore();
    }

    // ── Adaptive quality ────────────────────────────────────────

    adaptToFPS(fps) {
      if (!this.vcfg.adaptiveQuality || fps <= 0) return;
      const low = this.vcfg.qualityFpsLow || 40;
      const high = this.vcfg.qualityFpsHigh || 55;
      if (fps < low * 0.6 && this.quality !== "low") this.quality = "low";
      else if (fps < low && this.quality === "high") this.quality = "medium";
      else if (fps > high && this.quality === "medium") this.quality = "high";
      else if (fps > high * 1.15 && this.quality === "low") this.quality = "medium";
    }

    dispose() {
      this.sprites.clear();
      this.layers = [];
      this.backdrop = null;
      this.dust = [];
    }
  }

  // ── Demo scene ────────────────────────────────────────────────
  // A self-contained showcase galaxy so the view can be explored without a
  // scan (empty-state "Demo Galaxy" button and dev harnesses).

  function buildDemoScene() {
    const rnd = seededRand(20260908);
    const objects = [];
    const star = {
      type: "star", id: "demo-star", name: "DiskRaptor Prime",
      position: [0, 0, 0], scale: 20, color: [1, 0.86, 0.45],
      glow: 0.85, alpha: 1, active: true,
      data: { totalFiles: 184320, totalSize: 4.2e12 },
    };
    objects.push(star);

    const planetColors = [
      [0.27, 0.86, 1], [1, 0.4, 0.67], [0.4, 1, 0.53], [1, 0.67, 0.27],
      [0.47, 0.62, 1], [0.86, 0.5, 1], [0.3, 0.9, 0.8], [1, 0.85, 0.35],
      [0.65, 0.72, 0.85],
    ];
    const names = ["Downloads", "Documents", "Media", "Projects", "Photos", "Music", "Archive", "Games", "Backups"];
    let moonN = 0;
    for (let i = 0; i < 9; i++) {
      const orbit = 70 + i * 46 + rnd() * 18;
      const p = {
        type: "planet", id: `demo-p${i}`, name: names[i],
        position: [orbit, 0, 0],
        scale: 7 + rnd() * 15, color: planetColors[i],
        alpha: 1, active: true, glow: 0.3 + rnd() * 0.3,
        orbitRadius: orbit,
        orbitAngle: rnd() * Math.PI * 2,
        orbitSpeed: 0.00042 - i * 0.00003,
        pulsePhase: rnd() * Math.PI * 2,
        rotationSpeed: 0.0008 + rnd() * 0.0014,
        showOrbit: i % 3 === 0,
        data: { files: 400 + ((rnd() * 24000) | 0), size: orbit * 4e9 },
      };
      objects.push(p);
      const moons = 1 + ((rnd() * 3) | 0);
      for (let m = 0; m < moons; m++) {
        moonN++;
        objects.push({
          type: "moon", id: `demo-m${i}-${m}`, name: `file-${moonN}.dat`,
          position: [orbit + 14, 0, 0],
          scale: 1.6 + rnd() * 3.4,
          color: mixc(p.color, [1, 1, 1], 0.25 + rnd() * 0.3),
          alpha: 1, active: true,
          parentPosition: p.position,
          orbitRadius: p.scale * (1.9 + m * 0.9) + 6,
          orbitAngle: rnd() * Math.PI * 2,
          orbitSpeed: 0.0022 + rnd() * 0.003,
          sparkle: rnd() > 0.45,
          data: { size: (rnd() * 8e8) | 0 },
        });
      }
    }

    objects.push({
      type: "blackHole", id: "demo-bh", name: "node_modules",
      position: [560, 4, -120], scale: 13, color: [0, 0, 0],
      alpha: 1, active: true, rotationSpeed: 0.0004,
      data: { size: 9.6e10 },
    });

    const nebSpecs = [
      { pos: [-420, 30, -260], color: [1, 0.35, 0.6], s: 150, a: 0.4 },
      { pos: [300, -40, 420], color: [0.3, 0.75, 1], s: 175, a: 0.34 },
      { pos: [-180, 55, 480], color: [0.62, 0.4, 1], s: 120, a: 0.3 },
    ];
    nebSpecs.forEach((n, i) => objects.push({
      type: "nebula", id: `demo-neb${i}`, name: "dust cloud",
      position: [...n.pos], scale: n.s, color: n.color, alpha: n.a, active: true,
      data: {},
    }));

    objects.push({
      type: "diamond", id: "demo-dup", name: "duplicate.zip",
      position: [150, 35, 90], scale: 9, color: [0.4, 1, 1],
      alpha: 1, active: true, shimmer: true, data: { size: 3.4e9 },
    });

    const now = Date.now();
    for (let i = 0; i < 2; i++) {
      objects.push({
        type: "comet", id: `demo-comet${i}`, name: "temp file",
        position: [-500 + i * 900, 60 - i * 110, -200 + i * 460],
        velocity: [0.7 - i * 1.5, -0.12 + i * 0.2, 0.5 - i * 0.9],
        scale: 3.4, color: [0.85, 0.92, 1], alpha: 1, active: true,
        tailLength: 26, birthTime: now, lifetime: 600000,
        data: {},
      });
    }

    objects.push({
      type: "satellite", id: "demo-sat", name: "backup job",
      position: [96, 0, 0], scale: 2.6, color: [0.7, 0.75, 1],
      alpha: 0.9, active: true, orbitRadius: 96, orbitAngle: 0.4, orbitSpeed: 0.004,
      data: {},
    });

    return {
      objects,
      stats: { total_files: 184320, total_dirs: 9214, total_size: 4.2e12 },
    };
  }

  window.GalaxyView = window.GalaxyView || {};
  window.GalaxyView.Visuals = Visuals;
  window.GalaxyView.buildDemoScene = buildDemoScene;
})();
