/*
 * ios-bundle-tests.js - checks the iOS app would ship a working copy of the web app.
 *
 * It does three things, none of which need macOS:
 *   1. pulls the "Copy web app into bundle" script out of CubeClubhouse.xcodeproj and
 *      runs it with the same variables Xcode sets, so the script cannot rot unnoticed;
 *   2. serves the resulting bundle with the same MIME types BundleSchemeHandler.swift
 *      uses, over a real http origin, which is what the custom scheme gives the page;
 *   3. drives the app on an iPhone and an iPad profile, by touch.
 *
 * The one thing this cannot prove is WebKit behaviour: the harness runs Chromium,
 * because no WebKit build ships in this environment. Run the app once in the iOS
 * Simulator before shipping.
 *
 *     npm i --no-save playwright-core
 *     node tests/ios-bundle-tests.js
 */
let chromium, devices;
try {
  ({ chromium, devices } = require('playwright-core'));
} catch {
  console.log('skipped: playwright-core is not installed (npm i --no-save playwright-core)');
  process.exit(0);
}
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const EXE = process.env.CHROME || [
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
].find((f) => { try { return require('fs').existsSync(f); } catch { return false; } });
if (!EXE) {
  console.log('skipped: no Chromium found. Set CHROME=/path/to/chrome and re-run.');
  process.exit(0);
}
const IOS = path.resolve(__dirname, '..', 'ios');
const PBXPROJ = path.join(IOS, 'CubeClubhouse.xcodeproj', 'project.pbxproj');
// mirrors BundleSchemeHandler.mimeTypes
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
               '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };

let pass = 0, fail = 0;
const ck = (name, ok, extra) => { (ok ? pass++ : fail++); console.log((ok ? '  PASS ' : '  FAIL ') + name + (extra !== undefined ? '  [' + extra + ']' : '')); };

function runCopyPhase() {
  const src = fs.readFileSync(PBXPROJ, 'utf8');
  const raw = /shellScript = "(.*?)";\n/s.exec(src);
  if (!raw) throw new Error('no shell script build phase in the Xcode project');
  const script = raw[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'cubeclubhouse-'));
  fs.mkdirSync(path.join(out, 'CubeClubhouse.app'), { recursive: true });
  execFileSync('sh', ['-c', script], {
    env: { ...process.env, SRCROOT: IOS, BUILT_PRODUCTS_DIR: out, UNLOCALIZED_RESOURCES_FOLDER_PATH: 'CubeClubhouse.app' },
    stdio: 'pipe',
  });
  return path.join(out, 'CubeClubhouse.app', 'Web');
}

(async () => {
  console.log('the Xcode copy phase');
  const root = runCopyPhase();
  for (const f of ['index.html', 'css/style.css', 'js/cube.js', 'js/ncube.js', 'js/solver.js', 'js/bigsolver.js', 'js/view.js', 'js/lessons.js', 'js/app.js']) {
    ck('bundles ' + f, fs.existsSync(path.join(root, f)));
  }

  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/' || p === '') p = '/index.html';
    const file = path.join(root, p);
    if (!file.startsWith(root)) { res.writeHead(403).end(); return; }   // the handler's guard
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404).end('not in bundle'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;

  const b = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
  for (const profile of ['iPhone 12', 'iPad Pro 11']) {
    console.log('\n' + profile + ', served from the bundle');
    const ctx = await b.newContext({ ...devices[profile] });
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', (e) => errs.push(e.message));
    // the font CDN is unreachable offline, which is the case on a device in flight mode
    p.on('console', (m) => {
      if (m.type() === 'error' && !/ERR_CERT_AUTHORITY_INVALID|fonts\.googleapis|ERR_(NAME|INTERNET|PROXY)/.test(m.text())) errs.push('console: ' + m.text());
    });
    await p.goto(base + '/index.html');
    await p.waitForTimeout(500);

    ck('the lessons render', await p.locator('.lesson-card').count() === 10);
    ck('the cube model loads', await p.evaluate(() => typeof RC !== 'undefined' && RC.Cube.validate(RC.Cube.solved()).ok));
    ck('nothing scrolls sideways', await p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));

    // A real origin is the whole reason for the custom scheme: on a file:// URL WKWebView
    // gives the page an opaque origin and the child's stars vanish on every launch.
    await p.evaluate(() => localStorage.setItem('cubeclubhouse.progress', JSON.stringify({ daisy: 3 })));
    await p.reload();
    await p.waitForTimeout(400);
    ck('stars survive a relaunch', await p.evaluate(() => localStorage.getItem('cubeclubhouse.progress')) === '{"daisy":3}');
    await p.evaluate(() => { localStorage.clear(); localStorage.setItem('cubebuddy.progress', JSON.stringify({ cross: 2 })); });
    await p.reload();
    await p.waitForTimeout(400);
    ck('progress saved under the old app name still counts', await p.locator('.lesson-card.done').count() >= 1);
    await p.evaluate(() => localStorage.clear());

    ck('the font falls back without the CDN', /ui-rounded|SF Pro Rounded|system-ui/.test(
      await p.evaluate(() => getComputedStyle(document.body).fontFamily)));

    // a whole solve, driven only by taps
    await p.locator('nav button[data-screen="play"]').tap();
    await p.locator('#play-scramble').tap();
    await p.waitForTimeout(2600);
    await p.locator('#play-help').tap();
    await p.waitForTimeout(400);
    await p.locator('#play-guide .btn', { hasText: 'Watch the whole solve' }).tap();
    await p.waitForFunction(() => document.querySelector('#play-guide .guide-done'), null, { timeout: 120000 });
    ck('a tap-only solve reaches a solved cube', await p.evaluate(() => {
      const by = {};
      document.querySelectorAll('#play-cube .face:not(.inner)').forEach((f) => {
        const i = +f.dataset.index;
        (by[(i / 9) | 0] = by[(i / 9) | 0] || new Set()).add(f.className.match(/c-\w/)[0]);
      });
      return Object.values(by).every((s) => s.size === 1);
    }));

    // Every control has to be big enough for a child's finger. Apple's own floor is
    // 44pt, and the icon-only buttons used to come out at 41x32.
    const tooSmall = await p.evaluate(() => [...document.querySelectorAll('nav button, #screen-play button, .foot-links button')]
      .filter((b) => b.offsetParent !== null)
      .map((b) => ({ t: (b.getAttribute('aria-label') || b.textContent || '').trim().slice(0, 18), w: Math.round(b.getBoundingClientRect().width), h: Math.round(b.getBoundingClientRect().height) }))
      .filter((b) => b.w < 44 || b.h < 44));
    ck('every control is at least 44pt', tooSmall.length === 0, JSON.stringify(tooSmall).slice(0, 160));

    // A big cube is real work: it must not freeze the app, and it must not let the
    // child change the cube halfway through working it out.
    await p.locator('#play-size .size-btn', { hasText: '4×4' }).tap();
    await p.waitForTimeout(400);
    await p.locator('#play-scramble').tap();
    await p.waitForTimeout(3000);
    // Watch rather than sample: on a fast machine a 4x4 is worked out between two
    // polls, and the point is that the app said something, not that it was slow.
    await p.evaluate(() => {
      window.__frames = 0;
      const t = () => { window.__frames++; requestAnimationFrame(t); };
      requestAnimationFrame(t);
      window.__said = [];
      window.__held = false;
      new MutationObserver(() => window.__said.push(document.querySelector('#play-status').textContent.trim()))
        .observe(document.querySelector('#play-status'), { childList: true, characterData: true, subtree: true });
      new MutationObserver(() => { if (document.querySelector('#play-scramble').disabled) window.__held = true; })
        .observe(document.querySelector('#play-scramble'), { attributes: true, attributeFilter: ['disabled'] });
    });
    await p.locator('#play-help').tap();
    await p.waitForFunction(() => document.querySelector('#play-guide .guide-count'), null, { timeout: 60000 });
    const said = await p.evaluate(() => window.__said);
    ck('4x4: the controls are held while it thinks', await p.evaluate(() => window.__held));
    ck('4x4: it says what it is doing', said.some((t) => /Thinking/.test(t)), said.join(' / ').slice(0, 120));
    ck('4x4: the page keeps painting while it thinks', await p.evaluate(() => window.__frames) > 3, await p.evaluate(() => window.__frames));
    ck('4x4: the controls come back', !(await p.locator('#play-scramble').isDisabled()));
    await p.locator('#play-guide .btn', { hasText: 'Watch the whole solve' }).tap();
    await p.waitForFunction(() => document.querySelector('#play-guide .guide-done'), null, { timeout: 300000 });
    ck('4x4: a tap-only guided solve reaches a solved cube', await p.evaluate(() => {
      const faces = document.querySelectorAll('#play-cube .face:not(.inner)');
      const by = {};
      faces.forEach((f) => { const i = +f.dataset.index; (by[(i / 16) | 0] = by[(i / 16) | 0] || new Set()).add(f.className.match(/c-\w/)[0]); });
      return Object.values(by).every((s) => s.size === 1);
    }));
    // ...and the tables a big cube needs must not eat the device's memory
    const heap = await p.evaluate(() => (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : 0));
    ck('4x4: the solver tables stay small', heap < 120, heap + 'MB');
    await p.locator('#play-size .size-btn', { hasText: '3×3' }).tap();
    await p.waitForTimeout(300);

    // the folded net must be tappable, and the stickers big enough to hit
    await p.locator('nav button[data-screen="solve"]').tap();
    await p.waitForTimeout(250);
    const cell = await p.evaluate(() => {
      const r = document.querySelector('.net-cell:not(.centre)').getBoundingClientRect();
      return Math.round(Math.min(r.width, r.height));
    });
    ck('sticker targets are at least 28px', cell >= 28, cell + 'px');
    await p.locator('.swatch').nth(0).tap();
    await p.locator('.nf-U .net-cell:not(.centre)').first().tap();
    await p.locator('#solve-check').tap();
    await p.waitForTimeout(300);
    const msg = (await p.locator('#solve-msg').textContent()).trim();
    ck('painting a sticker by touch registers', /There should be 9 \w+ stickers/.test(msg), msg);

    // The grown-ups pages are what a parent (and an app reviewer) looks for.
    await p.locator('.foot-links [data-info="privacy"]').tap();
    await p.waitForTimeout(400);
    ck('the footer reaches the grown-ups pages by touch', !(await p.locator('#screen-grownups').isHidden()));
    ck('privacy names what is stored on the device', /cube size|stars/.test(await p.locator('#privacy').textContent()));
    ck('the licence travels with the app', /MIT License/.test(await p.locator('#licence').textContent()));
    const infoSmall = await p.evaluate(() => [...document.querySelectorAll('#screen-grownups button, #screen-grownups a')]
      .filter((b) => b.offsetParent !== null)
      .filter((b) => b.getBoundingClientRect().height < 44).length);
    ck('its controls are finger-sized too', infoSmall === 0, infoSmall);
    await p.locator('#screen-grownups .back-to-app').first().tap();
    await p.waitForTimeout(300);

    ck('no page errors', errs.length === 0, errs.join(' | ') || 'none');
    await ctx.close();
  }
  await b.close();
  server.close();
  fs.rmSync(path.dirname(path.dirname(root)), { recursive: true, force: true });
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ios bundle tests failed to run:', e); process.exit(1); });
