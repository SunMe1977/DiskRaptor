import { readFileSync } from 'fs';
const c = readFileSync('frontend/i18n/en.js','utf8');
const m = c.match(/I18N_DATA\["en"\]\s*=\s*(\{[^;]+);/);
const obj = JSON.parse(m[1]);
console.log('action.move_selected_to_trash:', obj['action.move_selected_to_trash']);