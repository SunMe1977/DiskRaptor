import { readFileSync, writeFileSync, readdirSync } from 'fs';

const I18N_DIR = 'frontend/i18n';
const enContent = readFileSync(I18N_DIR + '/en.js', 'utf8');
const enMatch = enContent.match(/I18N_DATA\["en"\]\s*=\s*(\{[^;]+);/);
const enObj = JSON.parse(enMatch[1]);
const enKeys = new Set(Object.keys(enObj));

const files = readdirSync(I18N_DIR).filter(f => f.endsWith('.js') && f !== 'en.js');

for (const file of files) {
  const content = readFileSync(I18N_DIR + '/' + file, 'utf8');
  const locale = file.replace('.js', '');
  const pattern = new RegExp('I18N_DATA\\["' + locale + '"\\]\\s*=\\s*(\\{[^;]+);');
  const match = content.match(pattern);
  if (!match) { console.log(file + ': parse error'); continue; }
  const obj = JSON.parse(match[1]);
  const missing = [...enKeys].filter(k => !obj.hasOwnProperty(k));
  if (missing.length) {
    for (const key of missing) obj[key] = enObj[key];
    writeFileSync(I18N_DIR + '/' + file, content.replace(match[1], JSON.stringify(obj)));
    console.log(file + ': added ' + missing.length + ' keys');
  }
}