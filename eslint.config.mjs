import js from "@eslint/js";
import globals from "globals";

// Rules that fire a lot on this legacy JS codebase without indicating real
// bugs (empty catch stubs, classes that redeclare the ambient cross-file
// globals, stylistic dead-assignment checks). Reported as warnings so they are
// visible but do not block CI; the genuinely bug-catching rules stay errors.
const NOISY_WARN_RULES = {
  "no-empty": "warn",
  "no-useless-assignment": "warn",
  "no-case-declarations": "warn",
  "no-prototype-builtins": "warn",
  "no-redeclare": "warn",
  "no-useless-escape": "warn",
  "no-constant-condition": "warn",
  "no-unused-vars": ["warn", { args: "none", caughtErrors: "none", vars: "local" }],
  "no-console": "off",
};

// WebView globals used across the app's classic scripts.
const APP_GLOBALS = {
  ...globals.browser,
  QWebChannel: "readonly",
  qt: "readonly",
  GalaxyView: "readonly",
  ChunkLoader: "readonly",
  TreeView: "readonly",
  DiagramRenderer: "readonly",
  StatsPanel: "readonly",
  TopFilesPanel: "readonly",
  DupScanner: "readonly",
  VirtualScroll: "readonly",
};

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/frontend-dist/**",
      "**/frontend/images/**",
    ],
  },
  {
    // App source: classic browser scripts loaded via <script> tags.
    files: [
      "frontend/*.js",
      "frontend/app-modules/**/*.js",
      "frontend/galaxyview/**/*.js",
      "frontend/i18n/*.js",
    ],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: APP_GLOBALS,
    },
    rules: {
      ...js.configs.recommended.rules,
      ...NOISY_WARN_RULES,
    },
  },
  {
    // Node ESM tooling (tests, build scripts, this config). Linted for
    // visibility; node --check already guards their syntax in CI.
    files: ["tests/**/*.mjs", "scripts/**/*.mjs", "eslint.config.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      ...js.configs.recommended.rules,
      ...NOISY_WARN_RULES,
      "no-undef": "warn",
    },
  },
];
