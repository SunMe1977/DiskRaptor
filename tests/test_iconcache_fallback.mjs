import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../frontend/iconcache.js', import.meta.url), 'utf8');
let calls = 0;
const context = {
  navigator: { platform: 'Linux x86_64' },
  window: { __TAURI__: { invoke() { calls++; return Promise.resolve(''); } } },
};
runInNewContext(source, context);
const icons = context.window.__ICON_CACHE__;
const first = await icons.getIcon('__folder__', true);
const second = await icons.getIcon('__folder__', true);
assert.equal(first, '📁');
assert.equal(second, first);
assert.equal(calls, 0, 'Linux fallback should avoid native icon requests');
assert.equal(icons.cache.get('__folder__'), first);

context.navigator.platform = 'Darwin';
await icons.getIcon('other.txt', false);
assert.equal(calls, 0, 'macOS fallback should avoid native icon requests');

context.navigator.platform = 'Win32';
await icons.getIcon('unknown.custom', false);
await icons.getIcon('another.custom', false);
assert.equal(calls, 1, 'a failed Windows icon lookup should be cached');
console.log('IconCache fallback passed');
