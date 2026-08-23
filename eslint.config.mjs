import globals from "globals";

export default [
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: "script",
      globals: {
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
      },
    },
    rules: {
      "no-unused-vars": ["warn", { args: "none", caughtErrors: "none", vars: "local" }],
      "no-undef": "warn",
      "no-var": "off",
      "prefer-const": "warn",
      "no-console": "off",
    },
  },
];
