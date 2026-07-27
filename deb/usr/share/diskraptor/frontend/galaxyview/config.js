/**
 * DiskRaptor — GalaxyView Configuration
 * Central defaults for the visual engine. Extensible via plugin API.
 */
window.GalaxyViewConfig = {
  // ── Rendering ──────────────────────────────────────────
  renderer: {
    maxFPS: 60,
    antialias: true,
    alpha: false,
    pixelRatio: window.devicePixelRatio || 1,
    bloomStrength: 0.3,
    bloomRadius: 0.2,
    bloomThreshold: 0.6,
    motionBlurIntensity: 0.15,
    shadowMapSize: 1024,
    hdr: false,
  },

  // ── Camera ─────────────────────────────────────────────
  camera: {
    fov: 60,
    near: 0.1,
    far: 100000,
    defaultPosition: [0, 50, 150],
    minZoom: 5,
    maxZoom: 5000,
    orbitSpeed: 0.003,
    zoomSpeed: 1.5,
    panSpeed: 0.8,
    flightSpeed: 80,
    flightAcceleration: 0.92,
    interpolationDamping: 0.08,
    cinematicTransitionDuration: 1200,
  },

  // ── Galaxy Layout ──────────────────────────────────────
  galaxy: {
    starSpacing: 40,           // Min distance between stars (drives)
    orbitBaseRadius: 30,       // Base orbit radius for planets
    orbitScale: 0.15,          // Scale factor for orbit radius = folder_size * this
    moonOrbitScale: 0.02,
    planetMinRadius: 1.0,
    planetMaxRadius: 25,
    moonMinRadius: 0.15,
    moonMaxRadius: 3.0,
    starMinRadius: 5,
    starMaxRadius: 20,
    particleCount: 20000,      // Background star particles
    nebulaResolution: 32,      // Volumetric cloud voxels
    blackHoleEventHorizon: 8,
    maxVisibleObjects: 100000,
    clusterThreshold: 500,     // Files within distance -> cluster
    clusterMergeRadius: 100,
    lodDistances: [200, 500, 1500, 5000],
  },

  // ── Animation ──────────────────────────────────────────
  animation: {
    enabled: true,
    rotationSpeed: 0.001,
    orbitSpeed: 0.0005,
    pulseSpeed: 0.002,
    glowPulseSpeed: 0.0015,
    sparkleSpeed: 0.003,
    cometLifetime: 8000,
    meteorCount: 50,
    particleShimmer: true,
    parallaxStrength: 0.02,
    motionBlur: true,
    cinematicTransitions: true,
  },

  // ── Live Scan ──────────────────────────────────────────
  liveScan: {
    enabled: true,
    meteorTrails: true,
    planetSpawnAnimation: 600,
    nebulaGrowSpeed: 0.3,
    blackHoleFormThreshold: 50e9,      // 50 GB
    progressUpdateInterval: 100,
  },

  // ── AI Insights ────────────────────────────────────────
  insights: {
    enabled: true,
    autoShow: true,
    refreshInterval: 5000,
    maxInsights: 5,
    overlayOpacity: 0.85,
    fadeInDuration: 400,
    displayDuration: 6000,
  },

  // ── Interaction ────────────────────────────────────────
  interaction: {
    wasdFlight: true,
    mouseOrbit: true,
    scrollZoom: true,
    clickToOpen: true,
    hoverMetadata: true,
    inertialScroll: true,
    keyboardShortcuts: true,
  },

  // ── Time Travel ────────────────────────────────────────
  timeline: {
    enabled: true,
    snapshots: ["today", "7days", "30days", "90days"],
    transitionDuration: 1500,
  },

  // ── Performance ────────────────────────────────────────
  performance: {
    targetFPS: 60,
    lowPowerMode: false,
    workerThreads: navigator.hardwareConcurrency || 4,
    objectPoolSize: 50000,
    batchSize: 1000,
    frustumCulling: true,
    occlusionCulling: true,
    spatialIndexType: "octree",  // 'octree' | 'quadtree'
    useInstancedRendering: true,
    lazyRendering: true,
    progressiveLoad: true,
  },

  // ── Accessibility ──────────────────────────────────────
  accessibility: {
    reducedMotion: false,
    colorBlindPalette: "normal",     // 'normal' | 'deuteranopia' | 'protanopia' | 'tritanopia'
    keyboardNavigation: true,
    screenReaderSupport: false,
    animationIntensity: 1.0,          // 0.0 (off) to 1.0 (full)
    highContrast: false,
  },

  // ── Color Palettes ─────────────────────────────────────
  palettes: {
    normal: {
      starSSD: "#ffdd44",
      starHDD: "#88aaff",
      starNAS: "#aaddff",
      planetCode: "#44ddff",
      planetDocs: "#66ff88",
      planetMedia: "#ff66aa",
      planetArchive: "#ffaa44",
      planetOther: "#aaaaaa",
      moonExecutable: "#ff4466",
      moonImage: "#ff88dd",
      moonVideo: "#ff44aa",
      moonAudio: "#44ddff",
      moonDocument: "#66ff88",
      moonArchive: "#ffaa44",
      moonOther: "#888888",
      nebulaCode: "rgba(68, 221, 255, 0.15)",
      nebulaDocs: "rgba(102, 255, 136, 0.12)",
      nebulaMedia: "rgba(255, 102, 170, 0.18)",
      nebulaArchive: "rgba(255, 170, 68, 0.12)",
      blackHole: "#000000",
      diamond: "#44ffff",
      comet: "#ffffff",
      particle: "#666688",
      background: "#112233",
      ambientGlow: "#222244",
      orbitTrail: "rgba(100, 100, 180, 0.3)",
    },
    deuteranopia: {
      starSSD: "#ffdd00",
      starHDD: "#4488ff",
      starNAS: "#88ccff",
      planetCode: "#4488ff",
      planetDocs: "#88ff44",
      planetMedia: "#ff8800",
      planetArchive: "#dd8800",
      planetOther: "#888888",
      moonExecutable: "#ff4400",
      moonImage: "#ff8800",
      moonVideo: "#dd6600",
      moonAudio: "#4488ff",
      moonDocument: "#88ff44",
      moonArchive: "#dd8800",
      moonOther: "#666666",
      nebulaCode: "rgba(68, 136, 255, 0.2)",
      nebulaDocs: "rgba(136, 255, 68, 0.15)",
      nebulaMedia: "rgba(255, 136, 0, 0.2)",
      nebulaArchive: "rgba(221, 136, 0, 0.15)",
      blackHole: "#000000",
      diamond: "#44ffff",
      comet: "#ffffff",
      particle: "#666688",
      background: "#112233",
      ambientGlow: "#222244",
      orbitTrail: "rgba(100, 100, 180, 0.3)",
    },
  },
};
