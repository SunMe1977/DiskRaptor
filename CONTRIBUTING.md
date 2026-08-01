# Contributing to DiskRaptor

## Code Style

- **Rust**: Follow `rustfmt` conventions. Use `cargo fmt` before committing.
- **JavaScript**: ES6 classes, `var` for legacy compatibility with the embedded webview.
- **CSS**: Use CSS custom properties (variables) for theming. Avoid inline styles.

## Pull Request Process

1. Ensure your code compiles and tests pass.
2. Update the README if adding new features.
3. Add i18n strings to `frontend/i18n.js` for all new UI text.
4. Run `node --check frontend/*.js` to verify JavaScript syntax.

## Development Setup

```bash
# Build the Tauri app
cd src-tauri && cargo build --release

# Build the installer (Windows)
npx tauri build --bundles nsis --ci

# Run
./src-tauri/target/release/diskraptor
```

## Testing

```bash
# Scanner test
cd src-tauri && cargo run --example scanner_test -- /tmp

# UI test (launches app with CDP)
node tests/test_ui.mjs

# JavaScript syntax check
for f in frontend/*.js; do node --check "$f"; done
```
