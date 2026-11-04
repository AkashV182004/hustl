// Renders the vinyl-record app icons to PNG. Run: node tests/make-icons.mjs
import { chromium } from 'playwright';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const font = pathToFileURL(path.join(root, 'fonts/playfair-italic.woff2')).href;

function svg({ bg, scale, rounded }) {
  const grooves = Array.from({ length: 14 }, (_, i) => `<circle cx="256" cy="256" r="${200 - i * 7}" fill="none" stroke="${i % 2 ? '#2d2522' : '#1d1715'}" stroke-width="3"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs><radialGradient id="g" cx=".35" cy=".3"><stop offset="0" stop-color="#fbf3df"/><stop offset="1" stop-color="#e8d9b5"/></radialGradient></defs>
  ${bg ? `<rect width="512" height="512" rx="${rounded ? 112 : 0}" fill="${bg}"/>` : ''}
  <g transform="translate(256 256) scale(${scale}) translate(-256 -256)">
    <circle cx="256" cy="262" r="236" fill="rgba(0,0,0,.25)"/>
    <circle cx="256" cy="256" r="232" fill="#151110"/>
    ${grooves}
    <path d="M110 140 A190 190 0 0 1 220 72" stroke="rgba(255,255,255,.28)" stroke-width="10" fill="none" stroke-linecap="round"/>
    <path d="M400 372 A190 190 0 0 1 300 440" stroke="rgba(255,255,255,.18)" stroke-width="8" fill="none" stroke-linecap="round"/>
    <circle cx="256" cy="256" r="88" fill="#c8642b"/>
    <circle cx="256" cy="256" r="80" fill="none" stroke="#c9a227" stroke-width="5"/>
    <text x="256" y="292" text-anchor="middle" font-family="PF" font-style="italic" font-weight="900" font-size="104" fill="#f3e9d2">H</text>
    <circle cx="256" cy="256" r="8" fill="#2b1d14"/>
  </g></svg>`;
}

const variants = [
  { file: 'icon-512.png', size: 512, bg: '#5b3a29', scale: .9, rounded: true },
  { file: 'icon-192.png', size: 192, bg: '#5b3a29', scale: .9, rounded: true },
  { file: 'maskable-512.png', size: 512, bg: '#5b3a29', scale: .7, rounded: false },
  { file: 'apple-touch-icon.png', size: 180, bg: '#5b3a29', scale: .82, rounded: false },
  { file: 'favicon.png', size: 64, bg: null, scale: 1, rounded: false },
];

const browser = await chromium.launch();
const page = await browser.newPage();
for (const v of variants) {
  await page.setViewportSize({ width: v.size, height: v.size });
  await page.setContent(`<style>@font-face{font-family:PF;src:url(${font});font-weight:900;font-style:italic}html,body{margin:0;background:transparent}svg{width:${v.size}px;height:${v.size}px;display:block}</style>${svg(v)}`);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(root, 'icons', v.file), omitBackground: true });
}
await browser.close();
console.log('icons done');
