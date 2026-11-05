// Release check: one version number everywhere, so browsers never mix old and new files.
// app.js APP_VERSION, package.json, sw.js cache name and every ?v= tag in index.html must match.
// Run: node tests/version.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
let failures = 0;
const ok = (c, m) => { console.log(`${c ? '  ✓' : '  ✗'} ${m}`); if (!c) failures++; };

const app = read('app.js').match(/APP_VERSION = '([\d.]+)'/)[1];
const pkg = JSON.parse(read('package.json')).version;
const sw = read('sw.js').match(/VERSION = 'hustl-v([\d.]+)'/)[1];
const html = read('index.html');
const tags = [...html.matchAll(/(?:href|src)="(styles\.css|config\.js|app\.js|sync\.js|chat\.js|ai\.js|lock\.js)(?:\?v=([\d.]+))?"/g)];

console.log('\n▶ version ' + app);
ok(pkg === app, `package.json matches (${pkg})`);
ok(sw === app, `service worker cache matches (hustl-v${sw})`);
ok(tags.length === 7, 'index.html loads all 7 app files');
for (const [, file, v] of tags) ok(v === app, `${file}?v=${v ?? '(none)'}`);
ok(/cache: 'reload'/.test(read('sw.js')), 'service worker skips the HTTP cache when saving a new version');

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
