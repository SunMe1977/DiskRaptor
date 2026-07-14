/**
 * DiskRaptor — GalaxyView Interaction Controller
 * WASD flight, mouse orbit, zoom, click-to-open, hover metadata.
 * Smooth camera movement with inertia.
 */
(function () {
  "use strict";

  const CFG = window.GalaxyViewConfig;

  class InteractionController {
    constructor(canvas, camera) {
      this.canvas = canvas;
      this.camera = camera;
      this.keys = {};
      this.mouse = { x: 0, y: 0, dx: 0, dy: 0, down: false, button: -1 };
      this.velocity = { x: 0, y: 0, z: 0 };
      this.orbitVelocity = { x: 0, y: 0 };
      this.isFlying = false;
      this.hoveredObject = null;
      this.selectedObject = null;
      this.clickHandler = null;
      this.hoverHandler = null;
      this.cameraDamping = 0.08;

      this._bindEvents();
      this._setupKeyboard();
    }

    _bindEvents() {
      const c = this.canvas;

      c.addEventListener("contextmenu", (e) => e.preventDefault());

      c.addEventListener("mousedown", (e) => {
        this.mouse.down = true;
        this.mouse.button = e.button;
        this.mouse.x = e.clientX;
        this.mouse.y = e.clientY;
        this.mouse.dx = 0;
        this.mouse.dy = 0;
      });

      window.addEventListener("mouseup", (e) => {
        if (this.mouse.down) {
          // Click detection (short drag = click)
          const totalDrag = Math.abs(this.mouse.dx) + Math.abs(this.mouse.dy);
          if (totalDrag < 5 && e.button === 0 && this.clickHandler) {
            this._handleClick(e);
          }
        }
        this.mouse.down = false;
        this.mouse.button = -1;
      });

      c.addEventListener("mousemove", (e) => {
        if (this.mouse.down) {
          this.mouse.dx = e.clientX - this.mouse.x;
          this.mouse.dy = e.clientY - this.mouse.y;
          this.mouse.x = e.clientX;
          this.mouse.y = e.clientY;
        }

        // Hover detection
        if (this.hoverHandler) {
          this._handleHover(e);
        }
      });

      c.addEventListener("wheel", (e) => {
        e.preventDefault();
        if (this.camera && CFG.interaction.scrollZoom) {
          const delta = e.deltaY > 0 ? 1 : -1;
          const zoomFactor = CFG.camera.zoomSpeed;
          const currentDist = Math.sqrt(
            Math.pow(this.camera.position[0] - this.camera.target[0], 2) +
            Math.pow(this.camera.position[1] - this.camera.target[1], 2) +
            Math.pow(this.camera.position[2] - this.camera.target[2], 2)
          );
          const newDist = Math.max(
            CFG.camera.minZoom,
            Math.min(CFG.camera.maxZoom, currentDist * (1 + delta * zoomFactor * 0.1))
          );
          const scale = newDist / currentDist;
          this.camera.position[0] = this.camera.target[0] + (this.camera.position[0] - this.camera.target[0]) * scale;
          this.camera.position[1] = this.camera.target[1] + (this.camera.position[1] - this.camera.target[1]) * scale;
          this.camera.position[2] = this.camera.target[2] + (this.camera.position[2] - this.camera.target[2]) * scale;
        }
      }, { passive: false });

      // Touch support
      let lastTouchDist = 0;
      c.addEventListener("touchstart", (e) => {
        if (e.touches.length === 2) {
          lastTouchDist = Math.hypot(
            e.touches[0].clientX - e.touches[1].clientX,
            e.touches[0].clientY - e.touches[1].clientY
          );
        }
      }, { passive: true });

      c.addEventListener("touchmove", (e) => {
        if (e.touches.length === 2) {
          e.preventDefault();
          const dist = Math.hypot(
            e.touches[0].clientX - e.touches[1].clientX,
            e.touches[0].clientY - e.touches[1].clientY
          );
          const delta = lastTouchDist - dist;
          if (this.camera) {
            const currentDist = Math.sqrt(
              Math.pow(this.camera.position[0] - this.camera.target[0], 2) +
              Math.pow(this.camera.position[1] - this.camera.target[1], 2) +
              Math.pow(this.camera.position[2] - this.camera.target[2], 2)
            );
            const newDist = Math.max(CFG.camera.minZoom, Math.min(CFG.camera.maxZoom, currentDist + delta));
            const scale = newDist / currentDist;
            this.camera.position[0] = this.camera.target[0] + (this.camera.position[0] - this.camera.target[0]) * scale;
            this.camera.position[1] = this.camera.target[1] + (this.camera.position[1] - this.camera.target[1]) * scale;
            this.camera.position[2] = this.camera.target[2] + (this.camera.position[2] - this.camera.target[2]) * scale;
          }
          lastTouchDist = dist;
        }
      }, { passive: false });
    }

    _setupKeyboard() {
      window.addEventListener("keydown", (e) => {
        this.keys[e.key.toLowerCase()] = true;
        if (e.key === " ") e.preventDefault(); // prevent page scroll
      });
      window.addEventListener("keyup", (e) => {
        this.keys[e.key.toLowerCase()] = false;
      });

      // Prevent default for WASD
      window.addEventListener("keydown", (e) => {
        if (["w", "a", "s", "d", "q", "e", "shift", " "].includes(e.key.toLowerCase())) {
          if (CFG.interaction.wasdFlight) e.preventDefault();
        }
      });
    }

    /** Update flight and orbit. Called every frame. */
    update(dt) {
      if (!this.camera) return;

      // Mouse orbit
      if (this.mouse.down && this.mouse.button === 0 && CFG.interaction.mouseOrbit) {
        this.orbitVelocity.x += this.mouse.dx * CFG.camera.orbitSpeed;
        this.orbitVelocity.y += this.mouse.dy * CFG.camera.orbitSpeed;
        this.mouse.dx = 0;
        this.mouse.dy = 0;
      }

      if (CFG.interaction.inertialScroll) {
        this.orbitVelocity.x *= 0.9;
        this.orbitVelocity.y *= 0.9;
      } else {
        this.orbitVelocity.x = 0;
        this.orbitVelocity.y = 0;
      }

      // Apply orbit to camera (orbit around target)
      if (Math.abs(this.orbitVelocity.x) > 0.0001 || Math.abs(this.orbitVelocity.y) > 0.0001) {
        const pos = this.camera.position;
        const target = this.camera.target;

        // Yaw (horizontal orbit)
        const dx = pos[0] - target[0];
        const dz = pos[2] - target[2];
        const radius = Math.sqrt(dx * dx + dz * dz);
        if (radius > 0.01) {
          const angle = Math.atan2(dz, dx) + this.orbitVelocity.x;
          pos[0] = target[0] + Math.cos(angle) * radius;
          pos[2] = target[2] + Math.sin(angle) * radius;
        }

        // Pitch (vertical orbit)
        const dy = pos[1] - target[1];
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist > 0.01) {
          const pitch = Math.asin(dy / dist) - this.orbitVelocity.y;
          const clampedPitch = Math.max(-Math.PI / 3, Math.min(Math.PI / 3, pitch));
          const newY = target[1] + Math.sin(clampedPitch) * dist;
          pos[1] = newY;
        }
      }

      // WASD flight
      if (CFG.interaction.wasdFlight) {
        const speed = CFG.camera.flightSpeed * (this.keys["shift"] ? 3 : 1) * (dt / 16);
        const forward = [
          this.camera.target[0] - this.camera.position[0],
          this.camera.target[1] - this.camera.position[1],
          this.camera.target[2] - this.camera.position[2],
        ];
        const fLen = Math.sqrt(forward[0]*forward[0] + forward[1]*forward[1] + forward[2]*forward[2]);
        if (fLen > 0.01) {
          forward[0] /= fLen; forward[1] /= fLen; forward[2] /= fLen;
          // Right vector (cross with up)
          const right = [
            forward[2] * 1 - forward[1] * 0,
            forward[0] * 0 - forward[2] * 1,
            forward[1] * 1 - forward[0] * 0,
          ];
          const rLen = Math.sqrt(right[0]*right[0] + right[1]*right[1] + right[2]*right[2]);
          if (rLen > 0.01) {
            right[0] /= rLen; right[1] /= rLen; right[2] /= rLen;
          }

          let moved = false;
          if (this.keys["w"]) {
            this.camera.position[0] += forward[0] * speed;
            this.camera.position[1] += forward[1] * speed;
            this.camera.position[2] += forward[2] * speed;
            this.camera.target[0] += forward[0] * speed;
            this.camera.target[1] += forward[1] * speed;
            this.camera.target[2] += forward[2] * speed;
            moved = true;
          }
          if (this.keys["s"]) {
            this.camera.position[0] -= forward[0] * speed;
            this.camera.position[1] -= forward[1] * speed;
            this.camera.position[2] -= forward[2] * speed;
            this.camera.target[0] -= forward[0] * speed;
            this.camera.target[1] -= forward[1] * speed;
            this.camera.target[2] -= forward[2] * speed;
            moved = true;
          }
          if (this.keys["a"]) {
            this.camera.position[0] -= right[0] * speed;
            this.camera.position[1] -= right[1] * speed;
            this.camera.position[2] -= right[2] * speed;
            this.camera.target[0] -= right[0] * speed;
            this.camera.target[1] -= right[1] * speed;
            this.camera.target[2] -= right[2] * speed;
            moved = true;
          }
          if (this.keys["d"]) {
            this.camera.position[0] += right[0] * speed;
            this.camera.position[1] += right[1] * speed;
            this.camera.position[2] += right[2] * speed;
            this.camera.target[0] += right[0] * speed;
            this.camera.target[1] += right[1] * speed;
            this.camera.target[2] += right[2] * speed;
            moved = true;
          }

          // Vertical movement
          if (this.keys["q"]) {
            this.camera.position[1] -= speed * 0.5;
            this.camera.target[1] -= speed * 0.5;
            moved = true;
          }
          if (this.keys["e"]) {
            this.camera.position[1] += speed * 0.5;
            this.camera.target[1] += speed * 0.5;
            moved = true;
          }

          this.isFlying = moved;
        }
      }

      // Update camera look-at
      if (this.camera.lookAt) {
        this.camera.lookAt(this.camera.target);
      }
    }

    _handleClick(e) {
      if (!this.clickHandler) return;
      // Raycast from mouse position to find object
      const rect = this.canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      // Call click handler with mouse position
      this.clickHandler(mouseX, mouseY, this.camera);
    }

    _handleHover(e) {
      if (!this.hoverHandler) return;
      const rect = this.canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      this.hoverHandler(mouseX, mouseY, this.camera);
    }

    /** Set callback for click events: function(screenX, screenY, camera) */
    onClick(handler) {
      this.clickHandler = handler;
    }

    /** Set callback for hover events: function(screenX, screenY, camera) */
    onHover(handler) {
      this.hoverHandler = handler;
    }

    /** Reset camera to default position */
    resetCamera() {
      if (!this.camera) return;
      const def = CFG.camera.defaultPosition;
      this.camera.position[0] = def[0];
      this.camera.position[1] = def[1];
      this.camera.position[2] = def[2];
      this.camera.target[0] = 0;
      this.camera.target[1] = 0;
      this.camera.target[2] = 0;
      this.orbitVelocity.x = 0;
      this.orbitVelocity.y = 0;
    }

    dispose() {
      this.clickHandler = null;
      this.hoverHandler = null;
      this.keys = {};
    }
  }

  window.GalaxyView = window.GalaxyView || {};
  window.GalaxyView.InteractionController = InteractionController;
})();
