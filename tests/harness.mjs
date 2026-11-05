// Shared test helpers: a static server for the app (served under /hustl/ like GitHub Pages)
// and "devices" (browser contexts) wired to the in-memory fake Supabase.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const shots = path.join(root, 'tests', 'shots');
await fs.mkdir(shots, { recursive: true });

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.woff2': 'font/woff2' };

export async function startServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (!url.pathname.startsWith('/hustl/')) { res.writeHead(404); return res.end(); }
    const file = path.join(root, decodeURIComponent(url.pathname.slice(7)) || 'index.html');
    if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
    try { const body = await fs.readFile(file); res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' }); res.end(body); }
    catch { res.writeHead(404); res.end(); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}/hustl/` };
}

export function checker() {
  const state = { failures: 0 };
  const ok = (cond, msg) => { console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`); if (!cond) state.failures++; };
  return { ok, state };
}

/** A browser context acting as one device, using the fake Supabase backend. */
export async function device(browser, { name, base, fake, errors, init, ...opts }) {
  const ctx = await browser.newContext({ ...opts, serviceWorkers: 'block' });
  if (init) await ctx.addInitScript(init);   // runs in the page before the app (e.g. a fake Notification)
  await ctx.exposeFunction('__fakeDb', fake.handle);
  await ctx.route('**/vendor/supabase.js', r => r.fulfill({ path: path.join(root, 'tests', 'fake-supabase.js'), contentType: 'text/javascript' }));
  // the "push" Edge Function: record what the app asks it to do
  await ctx.route('https://example.supabase.co/functions/v1/push', async r => {
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
    (fake.pushCalls ||= []).push({ device: name, auth: r.request().headers().authorization, body: JSON.parse(r.request().postData() || '{}') });
    return r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"sent":0}' });
  });
  await ctx.route('**/config.js*', r => r.fulfill({ contentType: 'text/javascript',
    body: "window.HUSTL_CONFIG = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_ANON_KEY: 'public-anon-key' };" }));
  const page = await ctx.newPage();
  fake.subscribe(ev => page.evaluate(e => window.__fakeRealtime && window.__fakeRealtime(e), ev).catch(() => {}));
  page.on('console', m => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
  page.on('pageerror', e => errors.push(`${name}: ${e}`));
  await page.goto(base);
  await page.evaluate(() => window.Hustl.ready);
  return { ctx, page };
}

// Signs in with this username, creating the account first if it's new.
export async function signIn(page, username, password = 'hustl-pass-1') {
  await page.click('.radio-key[data-screen="settings"]');
  await page.fill('#acctUser', username);
  await page.fill('#acctPassword', password);
  await page.click('#acctCreate');
  await page.waitForTimeout(150);
  if (await page.locator('#acctSignin').isVisible()) {
    await page.fill('#acctPassword', password);
    await page.click('#acctGo');
  }
}
