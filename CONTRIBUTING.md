# Contributing to DiskRaptor

## Code Style

- **Rust**: Follow `rustfmt` conventions. Use `cargo fmt` before committing.
- **C++**: Follow Qt coding style (camelCase methods, PascalCase classes).
- **JavaScript**: ES6 classes, `var` for legacy compatibility with Qt WebEngine.
- **CSS**: Use CSS custom properties (variables) for theming. Avoid inline styles.

## Pull Request Process

1. Ensure your code compiles and tests pass.
2. Update the README if adding new features.
3. Add i18n strings to `frontend/i18n.js` for all new UI text.
4. Run `node --check frontend/*.js` to verify JavaScript syntax.

## Development Setup

```bash
# Build Rust scanner
cd src-tauri && cargo build --release

# Build Qt app
cd qt-app && mkdir build && cd build
cmake .. -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build .

# Update dist app bundle
cp -r frontend dist/DiskRaptor.app/Contents/Resources/frontend
cp src-tauri/target/release/libdiskraptor_scanner.dylib dist/DiskRaptor.app/Contents/MacOS/
cp qt-app/build/DiskRaptor.app/Contents/MacOS/DiskRaptor dist/DiskRaptor.app/Contents/MacOS/
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
