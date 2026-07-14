/**
 * DiskRaptor — GalaxyView Data Mapper
 * Converts filesystem scan data into celestial bodies.
 * Drives→Stars, Folders→Planets, Files→Moons, etc.
 */
(function () {
  "use strict";

  const CFG = window.GalaxyViewConfig;

  /** File extension → type category */
  const FILE_TYPES = {
    // Code
    js: "code", ts: "code", jsx: "code", tsx: "code", py: "code",
    java: "code", cpp: "code", c: "code", h: "code", hpp: "code",
    rs: "code", go: "code", rb: "code", php: "code", swift: "code",
    kt: "code", scala: "code", vue: "code", svelte: "code",
    // Documents
    md: "docs", txt: "docs", pdf: "docs", doc: "docs", docx: "docs",
    xls: "docs", xlsx: "docs", ppt: "docs", pptx: "docs",
    rtf: "docs", odt: "docs", csv: "docs", json: "docs", xml: "docs",
    yaml: "docs", yml: "docs", toml: "docs", ini: "docs", cfg: "docs",
    // Media - Images
    jpg: "media", jpeg: "media", png: "media", gif: "media",
    svg: "media", webp: "media", ico: "media", bmp: "media",
    tiff: "media", psd: "media", ai: "media",
    // Media - Video
    mp4: "media", avi: "media", mkv: "media", mov: "media",
    wmv: "media", flv: "media", webm: "media",
    // Media - Audio
    mp3: "media", wav: "media", flac: "media", ogg: "media",
    wma: "media", aac: "media", m4a: "media",
    // Archives
    zip: "archive", rar: "archive", "7z": "archive", tar: "archive",
    gz: "archive", bz2: "archive", xz: "archive", iso: "archive",
    // Executables
    exe: "executable", dll: "executable", msi: "executable",
    bin: "executable", app: "executable", deb: "executable",
    AppImage: "executable",
    // Other
    "": "other",
  };

  function getFileType(name) {
    if (!name || typeof name !== "string") return "other";
    const dot = name.lastIndexOf(".");
    if (dot < 0) return "other";
    const ext = name.substring(dot + 1).toLowerCase();
    return FILE_TYPES[ext] || "other";
  }

  function getFileTypeColor(type) {
    const pal = CFG.palettes[CFG.accessibility.colorBlindPalette === "normal" ? "normal" : CFG.accessibility.colorBlindPalette] || CFG.palettes.normal;
    switch (type) {
      case "code": return pal.planetCode;
      case "docs": return pal.planetDocs;
      case "media": return pal.planetMedia;
      case "archive": return pal.planetArchive;
      default: return pal.planetOther;
    }
  }

  function getMoonColor(type) {
    const pal = CFG.palettes.normal;
    switch (type) {
      case "executable": return pal.moonExecutable;
      case "media":
      case "image": return pal.moonImage;
      case "video": return pal.moonVideo;
      case "audio": return pal.moonAudio;
      case "docs": return pal.moonDocument;
      case "archive": return pal.moonArchive;
      default: return pal.moonOther;
    }
  }

  function parseDriveName(drivePath) {
    if (!drivePath) return "?";
    return drivePath.replace(":", "").replace("\\", "").toUpperCase();
  }

  function sizeToRadius(size, minR, maxR) {
    minR = minR || 1;
    maxR = maxR || 25;
    if (!size || size <= 0) return minR;
    // Logarithmic scale: ln(size) normalized
    const logSize = Math.log(size + 1);
    const logMax = Math.log(1e12); // ~1TB
    const t = Math.min(logSize / logMax, 1);
    return minR + t * (maxR - minR);
  }

  // ── Color parsing helper (hex/rgba to float3) ──────────────
  function parseColor(cssColor) {
    if (!cssColor) return [0.5, 0.5, 0.5];
    // rgba format
    const rgbaMatch = cssColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (rgbaMatch) {
      return [
        parseInt(rgbaMatch[1]) / 255,
        parseInt(rgbaMatch[2]) / 255,
        parseInt(rgbaMatch[3]) / 255,
      ];
    }
    // hex format
    const hexMatch = cssColor.match(/#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})/);
    if (hexMatch) {
      return [
        parseInt(hexMatch[1], 16) / 255,
        parseInt(hexMatch[2], 16) / 255,
        parseInt(hexMatch[3], 16) / 255,
      ];
    }
    return [0.5, 0.5, 0.5];
  }

  // ── DataMapper ──────────────────────────────────────────────
  class DataMapper {
    constructor() {
      this.galaxyObjects = [];
      this.stars = [];
      this.planets = [];
      this.moons = [];
      this.blackHoles = [];
      this.nebulae = [];
      this.comets = [];
      this.diamonds = [];
      this.particleClouds = [];
      this.satellites = [];
      this.currentScanPath = "";
      this.largestFile = null;
    }

    /**
     * Map scan result data to galaxy objects.
     * @param {Object} scanResult - from get_scan_result
     * @param {Array} stats - stats with total_files, total_dirs, total_size
     * @param {Array} topFiles - top N files [{path, size}]
     */
    mapData(scanResult, stats, topFiles) {
      this.clear();
      if (!scanResult && !stats) return this.galaxyObjects;

      const scanPath = (scanResult && scanResult.scanPath) || stats.scanPath || "";
      this.currentScanPath = scanPath;
      const totalFiles = (scanResult && scanResult.totalFiles) || stats.total_files || 0;
      const totalDirs = (scanResult && scanResult.totalDirs) || stats.total_dirs || 0;
      const totalSize = (scanResult && scanResult.totalSize) || stats.total_size || 0;

      // 1. Create Stars from drives / scan root
      this._createStars(scanPath, totalSize, totalFiles);

      // 2. Create Planets from directory info (folders)
      this._createPlanets(scanResult, stats);

      // 3. Create Moons from files
      this._createMoons(topFiles, totalFiles, totalSize);

      // 4. Detect and create Black Holes (folders > 50GB)
      this._createBlackHoles(scanResult);

      // 5. Create Nebulae (file type density)
      this._createNebulae(topFiles, totalFiles);

      // 6. Create Particle Clouds (tiny files)
      this._createParticleClouds(totalFiles, totalSize);

      // 7. Create Comets (recently modified - top files)
      this._createComets(topFiles);

      // 8. Identify Diamond (largest file)
      this._identifyDiamond(topFiles);

      // 9. Create Satellites (follow shortcuts / symlinks)
      this._createSatellites(scanResult);

      // Build combined list
      this.galaxyObjects = [
        ...this.stars,
        ...this.planets,
        ...this.moons,
        ...this.blackHoles,
        ...this.nebulae,
        ...this.particleClouds,
        ...this.comets,
        ...this.diamonds,
        ...this.satellites,
      ];

      return this.galaxyObjects;
    }

    _createStars(path, totalSize, totalFiles) {
      const driveName = parseDriveName(path);
      const isSSD = true; // Default: assume SSD. Could query drive type.
      const pal = CFG.palettes.normal;

      const star = {
        type: "star",
        id: "star-root",
        name: driveName || "Root",
        path: path,
        isSSD: isSSD,
        position: [0, 0, 0],
        scale: sizeToRadius(totalSize, CFG.galaxy.starMinRadius, CFG.galaxy.starMaxRadius),
        color: parseColor(isSSD ? pal.starSSD : pal.starHDD),
        glow: Math.min(totalSize / 1e11, 1),
        alpha: 1,
        data: { totalFiles, totalSize, driveName },
        lodLevel: 0,
      };
      this.stars.push(star);

      // Create orbital star clusters for multi-path
      if (totalFiles > 100000) {
        const clusterStar = {
          type: "star",
          id: "star-cluster",
          name: "Cluster",
          position: [80, 10, 40],
          scale: star.scale * 0.4,
          color: parseColor(pal.starNAS),
          glow: 0.5,
          alpha: 0.7,
          data: { totalFiles: Math.floor(totalFiles * 0.3), isCluster: true },
          lodLevel: 0,
        };
        this.stars.push(clusterStar);
      }
    }

    _createPlanets(scanResult, stats) {
      if (!scanResult && !stats) return;
      // Use top-level directory information from scan
      const dirs = (stats && stats.total_dirs) || 0;
      const files = (stats && stats.total_files) || 0;
      const size = (stats && stats.total_size) || 0;

      // Create representative planets for common system directories
      const commonDirs = [
        { name: "System", path: "C:\\Windows", size: size * 0.15, files: files * 0.1, isCode: false },
        { name: "Programs", path: "C:\\Program Files", size: size * 0.2, files: files * 0.05, isCode: false },
        { name: "Users", path: "C:\\Users", size: size * 0.4, files: files * 0.5, isCode: false },
        { name: "Data", path: "C:\\Data", size: size * 0.15, files: files * 0.2, isCode: false },
        { name: "Temp", path: "C:\\Temp", size: size * 0.02, files: files * 0.05, isCode: false },
      ];

      // If we have topFiles, derive more planets from directory structure
      if (scanResult && scanResult.topFiles) {
        const dirMap = new Map();
        for (const file of scanResult.topFiles) {
          const parts = (file.path || file).replace(/\\/g, "/").split("/");
          if (parts.length > 1) {
            const dir = parts.slice(0, -1).join("/");
            dirMap.set(dir, (dirMap.get(dir) || 0) + (file.size || 0));
          }
        }
        let idx = 0;
        for (const [dirPath, dirSize] of dirMap) {
          if (idx >= 15) break;
          const dirName = dirPath.split("/").pop() || dirPath;
          const angle = (idx / 15) * Math.PI * 2;
          const orbitRadius = CFG.galaxy.orbitBaseRadius + dirSize * CFG.galaxy.orbitScale;
          const isCode = [".js", ".ts", ".py", ".cpp", ".rs", ".go"].some(e => dirName.includes(e));
          this.planets.push({
            type: "planet",
            id: "planet-" + idx,
            name: dirName,
            path: dirPath,
            position: [
              Math.cos(angle) * orbitRadius,
              (Math.random() - 0.5) * 10,
              Math.sin(angle) * orbitRadius,
            ],
            scale: sizeToRadius(dirSize, CFG.galaxy.planetMinRadius, CFG.galaxy.planetMaxRadius),
            color: parseColor(getFileTypeColor(isCode ? "code" : getFileType(dirName))),
            glow: 0.3 + Math.random() * 0.4,
            alpha: 1,
            orbitRadius: orbitRadius,
            orbitAngle: angle,
            orbitSpeed: CFG.galaxy.orbitBaseRadius / (orbitRadius + 1) * 0.001,
            rotationSpeed: 0.0005 + Math.random() * 0.002,
            pulsePhase: Math.random() * Math.PI * 2,
            data: { size: dirSize, files: Math.floor(dirSize / 50000) },
            lodLevel: 0,
          });
          idx++;
        }
      }

      // Always add at least one generic planet
      if (this.planets.length === 0) {
        for (let i = 0; i < 5; i++) {
          const angle = (i / 5) * Math.PI * 2;
          const r = CFG.galaxy.orbitBaseRadius + i * 15;
          this.planets.push({
            type: "planet",
            id: "planet-" + i,
            name: "Folder " + (i + 1),
            position: [
              Math.cos(angle) * r,
              (Math.random() - 0.5) * 5,
              Math.sin(angle) * r,
            ],
            scale: 2 + Math.random() * 5,
            color: [0.3 + Math.random() * 0.4, 0.3 + Math.random() * 0.4, 0.5 + Math.random() * 0.4],
            glow: 0.3,
            alpha: 1,
            orbitRadius: r,
            orbitAngle: angle,
            orbitSpeed: 0.0005 + Math.random() * 0.001,
            rotationSpeed: 0.001,
            pulsePhase: Math.random() * 6.28,
            data: { size: 50000000 + Math.random() * 1e9, files: 100 + Math.floor(Math.random() * 5000) },
            lodLevel: 0,
          });
        }
      }
    }

    _createMoons(topFiles, totalFiles, totalSize) {
      if (!topFiles || !topFiles.length) return;
      const maxMoons = Math.min(topFiles.length, 200);

      for (let i = 0; i < maxMoons; i++) {
        const file = topFiles[i];
        const filePath = (file.path || file || "");
        const fileName = filePath.split(/[/\\]/).pop() || filePath;
        const fileSize = file.size || 0;
        const fileType = getFileType(fileName);

        // Assign to a parent planet
        const parentPlanet = this.planets[i % Math.max(this.planets.length, 1)];
        const parentPos = parentPlanet ? parentPlanet.position : [0, 0, 0];
        const moonAngle = (i / maxMoons) * Math.PI * 2;
        const moonRadius = 3 + fileSize * CFG.galaxy.moonOrbitScale;

        this.moons.push({
          type: "moon",
          id: "moon-" + i,
          name: fileName,
          path: filePath,
          position: [
            parentPos[0] + Math.cos(moonAngle) * moonRadius,
            parentPos[1] + (Math.random() - 0.5) * 2,
            parentPos[2] + Math.sin(moonAngle) * moonRadius,
          ],
          scale: sizeToRadius(fileSize, CFG.galaxy.moonMinRadius, CFG.galaxy.moonMaxRadius),
          color: parseColor(getMoonColor(fileType)),
          glow: 0.2,
          alpha: 0.9,
          sparkle: Math.random() > 0.7,
          parentId: parentPlanet ? parentPlanet.id : null,
          parentPosition: parentPos,
          orbitRadius: moonRadius,
          orbitAngle: moonAngle,
          orbitSpeed: 0.002 + Math.random() * 0.003,
          data: { size: fileSize, type: fileType, path: filePath },
          lodLevel: 0,
        });
      }
    }

    _createBlackHoles(scanResult) {
      // Black holes for massive folders (>50GB)
      if (!scanResult) return;
      const threshold = CFG.liveScan.blackHoleFormThreshold;
      const topFiles = scanResult.topFiles || [];
      const dirSizeMap = new Map();

      for (const file of topFiles) {
        const fp = (file.path || file || "");
        const parts = fp.replace(/\\/g, "/").split("/");
        if (parts.length > 1) {
          const dir = parts.slice(0, -1).join("/");
          dirSizeMap.set(dir, (dirSizeMap.get(dir) || 0) + (file.size || 0));
        }
      }

      let bhCount = 0;
      for (const [dir, size] of dirSizeMap) {
        if (size > threshold && bhCount < 3) {
          const angle = Math.random() * Math.PI * 2;
          const r = 100 + Math.random() * 200;
          this.blackHoles.push({
            type: "blackHole",
            id: "blackhole-" + bhCount,
            name: dir.split("/").pop() || dir,
            path: dir,
            position: [
              Math.cos(angle) * r,
              (Math.random() - 0.5) * 20,
              Math.sin(angle) * r,
            ],
            scale: CFG.galaxy.blackHoleEventHorizon + sizeToRadius(size, 5, 20),
            color: [0, 0, 0],
            glow: 0.8,
            alpha: 0.9,
            eventHorizon: true,
            gravitationalLensing: true,
            rotationSpeed: 0.0003,
            data: { size, path: dir },
            lodLevel: 0,
          });
          bhCount++;
        }
      }
    }

    _createNebulae(topFiles, totalFiles) {
      if (!topFiles || topFiles.length === 0) return;
      const fileTypeCount = { code: 0, docs: 0, media: 0, archive: 0, other: 0 };

      for (const file of topFiles.slice(0, 500)) {
        const fp = (file.path || file || "");
        const name = fp.split(/[/\\]/).pop() || fp;
        const ft = getFileType(name);
        fileTypeCount[ft] = (fileTypeCount[ft] || 0) + 1;
      }

      const total = Object.values(fileTypeCount).reduce((a, b) => a + b, 0) || 1;
      let nebIdx = 0;

      for (const [type, count] of Object.entries(fileTypeCount)) {
        if (count > total * 0.1) {
          const angle = Math.random() * Math.PI * 2;
          const r = 150 + Math.random() * 100;
          const colorStr = getFileTypeColor(type);
          const baseColor = parseColor(colorStr);

          this.nebulae.push({
            type: "nebula",
            id: "nebula-" + nebIdx,
            name: type.charAt(0).toUpperCase() + type.slice(1) + " Nebula",
            position: [
              Math.cos(angle) * r,
              (Math.random() - 0.5) * 15,
              Math.sin(angle) * r,
            ],
            scale: 20 + (count / total) * 60,
            color: baseColor,
            glow: 0.4,
            alpha: 0.15,
            density: count / total,
            dominantType: type,
            data: { fileCount: count, type },
            lodLevel: 1,
          });
          nebIdx++;
        }
      }
    }

    _createParticleClouds(totalFiles, totalSize) {
      if (totalFiles < 100) return;
      const cloudCount = Math.min(Math.floor(totalFiles / 5000), 10);

      for (let i = 0; i < cloudCount; i++) {
        const angle = Math.random() * Math.PI * 2;
        const r = 50 + Math.random() * 300;
        this.particleClouds.push({
          type: "particleCloud",
          id: "pcloud-" + i,
          position: [
            Math.cos(angle) * r,
            (Math.random() - 0.5) * 30,
            Math.sin(angle) * r,
          ],
          scale: 5 + Math.random() * 15,
          color: [0.4, 0.4, 0.6],
          glow: 0.15,
          alpha: 0.2,
          density: 0.5 + Math.random() * 0.5,
          data: { particleCount: 1000 + Math.floor(Math.random() * 5000) },
          lodLevel: 2,
        });
      }
    }

    _createComets(topFiles) {
      if (!topFiles || topFiles.length === 0) return;
      // Treat recently modified files as comets
      const cometCount = Math.min(topFiles.length, 10);
      for (let i = 0; i < cometCount; i++) {
        const file = topFiles[i];
        const fp = (file.path || file || "");
        const angle = Math.random() * Math.PI * 2;
        const r = 30 + Math.random() * 200;

        this.comets.push({
          type: "comet",
          id: "comet-" + i,
          name: fp.split(/[/\\]/).pop() || fp,
          path: fp,
          position: [
            Math.cos(angle) * r,
            (Math.random() - 0.5) * 20,
            Math.sin(angle) * r,
          ],
          scale: 0.5 + Math.random() * 1.5,
          color: [1, 1, 1],
          glow: 0.6,
          alpha: 1,
          tailLength: 10 + Math.random() * 30,
          lifetime: CFG.animation.cometLifetime,
          birthTime: Date.now(),
          velocity: [
            (Math.random() - 0.5) * 0.5,
            (Math.random() - 0.5) * 0.3,
            (Math.random() - 0.5) * 0.5,
          ],
          data: { path: fp },
          lodLevel: 0,
        });
      }
    }

    _identifyDiamond(topFiles) {
      if (!topFiles || topFiles.length === 0) return;
      const largest = topFiles[0];
      if (!largest) return;
      const fp = (largest.path || largest || "");
      this.largestFile = { name: fp.split(/[/\\]/).pop() || fp, path: fp, size: largest.size || 0 };

      this.diamonds.push({
        type: "diamond",
        id: "diamond-largest",
        name: this.largestFile.name,
        path: this.largestFile.path,
        position: [0, 35, 0], // Above the star
        scale: 2,
        color: parseColor(CFG.palettes.normal.diamond),
        glow: 0.9,
        alpha: 1,
        shimmer: true,
        data: { size: this.largestFile.size, path: this.largestFile.path },
        lodLevel: 0,
      });
    }

    _createSatellites(scanResult) {
      // Placeholder for shortcuts/symlinks
      if (!scanResult) return;
      for (let i = 0; i < 3; i++) {
        const angle = (i / 3) * Math.PI * 2;
        this.satellites.push({
          type: "satellite",
          id: "sat-" + i,
          name: "Link " + (i + 1),
          position: [
            Math.cos(angle) * 15,
            5 + i * 3,
            Math.sin(angle) * 15,
          ],
          scale: 0.8,
          color: [0.6, 0.6, 0.8],
          glow: 0.3,
          alpha: 0.8,
          orbitRadius: 15,
          orbitAngle: angle,
          orbitSpeed: 0.005,
          data: { target: "shortcut" },
          lodLevel: 0,
        });
      }
    }

    /** Generate a new object during live scan (for LiveScanEngine) */
    createLiveObject(filePath, fileSize, index) {
      const fileName = filePath.split(/[/\\]/).pop() || filePath;
      const fileType = getFileType(fileName);
      const dirParts = filePath.replace(/\\/g, "/").split("/");
      const parentDir = dirParts.slice(0, -1).join("/");
      const planetIdx = Math.abs(this._hashCode(parentDir)) % Math.max(this.planets.length, 1);
      const parentPlanet = this.planets[planetIdx];

      if (!parentPlanet) {
        return {
          type: "meteor",
          position: [
            (Math.random() - 0.5) * 400,
            (Math.random() - 0.5) * 200,
            (Math.random() - 0.5) * 400 - 200,
          ],
          scale: 0.3 + Math.random() * 0.5,
          color: [1, 0.8, 0.3],
          alpha: 0.8,
          velocity: [0, 0, 2 + Math.random() * 3],
          lifetime: 3000 + Math.random() * 2000,
          birthTime: Date.now(),
          data: { path: filePath, size: fileSize },
        };
      }

      const angle = Math.random() * Math.PI * 2;
      const r = 3 + fileSize * CFG.galaxy.moonOrbitScale;

      return {
        type: "moon",
        name: fileName,
        path: filePath,
        position: [
          parentPlanet.position[0] + Math.cos(angle) * r,
          parentPlanet.position[1] + (Math.random() - 0.5) * 2,
          parentPlanet.position[2] + Math.sin(angle) * r,
        ],
        scale: sizeToRadius(fileSize, 0.1, 2),
        color: parseColor(getMoonColor(fileType)),
        glow: 0.3,
        alpha: 0.9,
        sparkle: true,
        parentId: parentPlanet.id,
        parentPosition: [parentPlanet.position[0], parentPlanet.position[1], parentPlanet.position[2]],
        orbitRadius: r,
        orbitAngle: angle,
        orbitSpeed: 0.003 + Math.random() * 0.004,
        data: { size: fileSize, type: fileType, path: filePath },
        liveSpawned: true,
        birthTime: Date.now(),
      };
    }

    _hashCode(str) {
      let hash = 0;
      if (!str) return hash;
      for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
      }
      return hash;
    }

    clear() {
      this.galaxyObjects = [];
      this.stars = [];
      this.planets = [];
      this.moons = [];
      this.blackHoles = [];
      this.nebulae = [];
      this.comets = [];
      this.diamonds = [];
      this.particleClouds = [];
      this.satellites = [];
      this.largestFile = null;
    }

    getObjectById(id) {
      return this.galaxyObjects.find(o => o.id === id);
    }
  }

  // ── Exports ─────────────────────────────────────────────
  window.GalaxyView = window.GalaxyView || {};
  window.GalaxyView.DataMapper = DataMapper;
  window.GalaxyView.getFileType = getFileType;
  window.GalaxyView.parseColor = parseColor;
  window.GalaxyView.sizeToRadius = sizeToRadius;
})();
