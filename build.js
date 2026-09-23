// Kokoaa src/-kansion palaset yhdeksi tuotanto-index.html:ksi. Ei riippuvuuksia, ei bundleria –
// vain tiedostojen liittäminen samassa järjestyksessä kuin kehityksessä. Aja: node src/build.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const ORDER = ['01-core', '02-seed', '03-logic', '04-views-a', '05-views-b', '06-views-c', '07-views-d', '07b-sync', '07c-geo', '07d-planner', '07e-import', '08-boot'];

const css = fs.readFileSync(path.join(here, 'style.css'), 'utf8');
const js = ORDER.map((n) => fs.readFileSync(path.join(here, `${n}.src.js`), 'utf8').replace(/\n+$/, '')).join('\n');
let html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

const styleStart = html.indexOf('<style>\n') + 8;
const styleEnd = html.indexOf('\n</style>');
const scriptStart = html.indexOf('<script>\n', styleEnd) + 9;
const scriptEnd = html.indexOf('\n</script>', scriptStart);
if (styleStart < 8 || scriptStart < 9) throw new Error('index.html-mallia ei tunnistettu (style/script-merkit puuttuvat)');

html = html.slice(0, styleStart) + css + html.slice(styleEnd, scriptStart - 9) + '<script>\n' + js + html.slice(scriptEnd);
fs.writeFileSync(path.join(root, 'index.html'), html);
console.log(`index.html päivitetty (${(html.length / 1024).toFixed(0)} kt).`);
