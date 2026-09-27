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
               '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
               '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.mp4': 'video/mp4', '.jpg': 'image/jpeg' };
// mirrors BundleSchemeHandler.byteRange
function byteRange(header, size) {
  if (!(size > 0) || !/^bytes=/.test(header) || header.includes(',')) return null;
  const spec = header.slice(6).split('-');
  if (spec.length !== 2) return null;
  const first = spec[0].trim(), last = spec[1].trim();
  if (first === '') { const n = Number(last); return Number.isInteger(n) && n > 0 ? { from: Math.max(0, size - n), to: size - 1 } : null; }
  const from = Number(first);
  if (!Number.isInteger(from) || from < 0 || from >= size) return null;
  const to = last === '' ? size - 1 : Math.min(Number.isInteger(Number(last)) ? Number(last) : size - 1, size - 1);
  return to >= from ? { from, to } : null;
}

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
  console.log('the Xcode project itself');
  {
    const proj = fs.readFileSync(PBXPROJ, 'utf8');
    // Two objects sharing an id is the kind of thing Xcode notices and a person does not.
    const defined = [...proj.matchAll(/^\t\t([0-9A-F]{24}) /gm)].map((m) => m[1]);
    const twice = defined.filter((id, i) => defined.indexOf(id) !== i);
    ck('every object in the project has its own id', twice.length === 0, twice.join(',') || 'none');
    const referenced = [...new Set([...proj.matchAll(/\b([0-9A-F]{24})\b/g)].map((m) => m[1]))];
    const missing = referenced.filter((id) => !defined.includes(id) && !new RegExp('^\t\t' + id + ' = \\{', 'm').test(proj));
    ck('every id the project points at exists', missing.length === 0, missing.join(',') || 'none');
    ck('the target builds the privacy manifest', /PrivacyInfo\.xcprivacy in Resources/.test(proj));
    ck('nothing of the old shop is left in the project', !/StoreManager|storekit/i.test(proj));
    const targets = [...proj.matchAll(/IPHONEOS_DEPLOYMENT_TARGET = ([0-9.]+)/g)].map((m) => m[1]);
    ck('every configuration targets iOS 17', targets.length === 2 && targets.every((t) => t === '17.0'), targets.join(','));
    ck('the SDK is the device SDK', /SDKROOT = iphoneos/.test(proj));
    ck('it builds for iPhone and iPad', /TARGETED_DEVICE_FAMILY = "1,2"/.test(proj));
    // An #available check below the deployment target is dead code Xcode warns about.
    const swift = fs.readdirSync(path.join(IOS, 'CubeClubhouse'))
      .filter((f) => f.endsWith('.swift'))
      .map((f) => fs.readFileSync(path.join(IOS, 'CubeClubhouse', f), 'utf8')).join('\n');
    const stale = [...swift.matchAll(/#available\(iOS ([0-9.]+)/g)].map((m) => m[1]).filter((v) => parseFloat(v) <= 17);
    ck('no availability check the target already guarantees', stale.length === 0, stale.join(',') || 'none');

    // The web app promises it asks the internet for nothing; the shell has to hold that up.
    ck('the shell blocks every http(s) load', /WKContentRuleListStore/.test(swift)
      && /\^https\?:\/\//.test(swift) && /"type": "block"/.test(swift));
    ck('it refuses navigations off the bundle', /refused a navigation off the bundle/.test(swift));
    ck('the scheme handler can serve a font', /"woff2": "font\/woff2"/.test(swift));

    // Apple reads this file; it has to parse, and it has to say what the app's own
    // Privacy page says.
    const manifest = fs.readFileSync(path.join(IOS, 'CubeClubhouse', 'PrivacyInfo.xcprivacy'), 'utf8');
    ck('the privacy manifest is a plist', /<plist version="1.0">/.test(manifest) && /<\/plist>/.test(manifest));
    ck('it declares no tracking', /<key>NSPrivacyTracking<\/key>\s*<false\/>/.test(manifest));
    for (const key of ['NSPrivacyTrackingDomains', 'NSPrivacyCollectedDataTypes']) {
      ck('it declares an empty ' + key, new RegExp('<key>' + key + '<\\/key>\\s*<array\\/>').test(manifest));
    }
    // UserDefaults (the update check's switch and dates) is the one API Apple wants a
    // reason for: CA92.1, read only by this app. Nothing else may creep in unannounced.
    const apis = [...manifest.matchAll(/<key>NSPrivacyAccessedAPIType<\/key>\s*<string>([^<]+)<\/string>/g)].map((m) => m[1]);
    ck('the only reasoned API is UserDefaults, for this app alone', apis.join() === 'NSPrivacyAccessedAPICategoryUserDefaults'
      && /<string>CA92\.1<\/string>/.test(manifest), apis.join());
    const swiftAll = fs.readdirSync(path.join(IOS, 'CubeClubhouse')).filter((f) => f.endsWith('.swift'))
      .map((f) => fs.readFileSync(path.join(IOS, 'CubeClubhouse', f), 'utf8')).join('\n');
    ck('and UserDefaults is indeed used, so the declaration is needed', /UserDefaults\.standard/.test(swiftAll));
  }

  console.log('\nthe launch screen');
  {
    const proj = fs.readFileSync(PBXPROJ, 'utf8');
    const APP = path.join(IOS, 'CubeClubhouse');
    const ASSETS = path.join(APP, 'Assets.xcassets');
    // Info.plist: only the launch screen; Xcode generates and merges everything else
    const plist = fs.readFileSync(path.join(APP, 'Info.plist'), 'utf8');
    ck('Info.plist is a plist', /<plist version="1.0">/.test(plist) && /<\/plist>/.test(plist));
    const launch = /<key>UILaunchScreen<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(plist);
    const val = (k) => launch && (new RegExp('<key>' + k + '<\\/key>\\s*<string>([^<]+)<\\/string>').exec(launch[1]) || [])[1];
    ck('it names a background colour and an image', val('UIColorName') === 'LaunchBackground' && val('UIImageName') === 'LaunchLogo',
      val('UIColorName') + ' / ' + val('UIImageName'));
    const configs = [...proj.matchAll(/^\t+INFOPLIST_FILE = ([^;]+);/gm)].map((m) => m[1]);
    ck('both configurations use it', configs.length === 2 && configs.every((c) => c === 'CubeClubhouse/Info.plist'), configs.join(','));
    ck('the blank generated launch screen is gone', !/UILaunchScreen_Generation/.test(proj));
    ck('Info.plist is not copied as a resource', !/Info\.plist in Resources/.test(proj));

    // the colour: light and dark, and exactly the page's own background, so the
    // launch screen hands over to the app without a flash
    const colour = JSON.parse(fs.readFileSync(path.join(ASSETS, 'LaunchBackground.colorset', 'Contents.json'), 'utf8'));
    const hexOf = (c) => '#' + ['red', 'green', 'blue'].map((k) => Math.round(parseFloat(c.color.components[k]) * 255).toString(16).padStart(2, '0')).join('');
    const isDark = (c) => (c.appearances || []).some((a) => a.value === 'dark');
    const light = colour.colors.find((c) => !isDark(c)), dark = colour.colors.find(isDark);
    const css = fs.readFileSync(path.join(IOS, '..', 'css', 'style.css'), 'utf8');
    const bgLight = /:root \{[^}]*--bg: (#[0-9a-f]{6})/.exec(css)[1];
    const bgDark = /:root\[data-theme="dark"\] \{[^}]*--bg: (#[0-9a-f]{6})/.exec(css)[1];
    ck('the launch colour is the page background (light)', light && hexOf(light) === bgLight, light && hexOf(light) + ' vs ' + bgLight);
    ck('the launch colour is the page background (dark)', dark && hexOf(dark) === bgDark, dark && hexOf(dark) + ' vs ' + bgDark);

    // the image: every listed file exists, at 1x/2x/3x in light and dark, with the scales in step
    const set = path.join(ASSETS, 'LaunchLogo.imageset');
    const imgs = JSON.parse(fs.readFileSync(path.join(set, 'Contents.json'), 'utf8')).images;
    const png = (f) => { const d = fs.readFileSync(path.join(set, f)); return { sig: d.subarray(1, 4).toString(), w: d.readUInt32BE(16), h: d.readUInt32BE(20), type: d[25] }; };
    const files = imgs.map((i) => ({ ...i, ...png(i.filename) }));
    ck('the logo comes at 1x, 2x and 3x, light and dark', ['1x', '2x', '3x'].every((sc) => files.some((f) => f.scale === sc && !isDark(f)) && files.some((f) => f.scale === sc && isDark(f))));
    ck('every file is a PNG with transparency', files.every((f) => f.sig === 'PNG' && f.type === 6));
    const one = files.find((f) => f.scale === '1x' && !isDark(f));
    ck('the scales are in step', files.every((f) => f.w === one.w * parseInt(f.scale, 10) && f.h === one.h * parseInt(f.scale, 10)), one.w + 'x' + one.h + 'pt');
    ck('it fits the narrowest iPhone iOS 17 runs on', one.w <= 375 - 2 * 16, one.w + 'pt');

    // RootView keeps the same picture up until the page is ready, and never forever
    const app = fs.readFileSync(path.join(APP, 'CubeClubhouseApp.swift'), 'utf8');
    const web = fs.readFileSync(path.join(APP, 'WebAppView.swift'), 'utf8');
    ck('the cover draws the same colour and image', /Color\("LaunchBackground"\)/.test(app) && /Image\("LaunchLogo"\)/.test(app));
    ck('it comes down when the page has loaded', /WebAppView\(onReady: reveal\)/.test(app) && /didFinish navigation: WKNavigation!\) \{\s*onReady\(\)/.test(web));
    ck('or if loading fails', (web.match(/withError error: Error\) \{[^}]*onReady\(\)/g) || []).length === 2);
    ck('and after a few seconds regardless', /asyncAfter\(deadline: \.now\(\) \+ \d+\) \{ reveal\(\) \}/.test(app));
    ck('it respects Reduce Motion', /accessibilityReduceMotion/.test(app));
  }

  console.log('\nthe iOS side of the page');
  {
    const web = fs.readFileSync(path.join(IOS, 'CubeClubhouse', 'WebAppView.swift'), 'utf8');
    ck('the page is told it is the iOS app, and on which device, before it runs', /CubeClubhouseHost = Object\.freeze\(\{ platform: 'ios', device: '\\\(device\)', "\s*\+ "version: '\\\(version\)', updateCheck: \\\(updates\.enabled\) \}\);"/.test(web)
      && /injectionTime: \.atDocumentStart/.test(web) && /userInterfaceIdiom == \.pad \? "iPad" : "iPhone"/.test(web));
    ck('haptics: the page can ask, and four kinds are felt', /add\(context\.coordinator, name: "haptic"\)/.test(web)
      && ['"light"', '"medium"', '"success"', '"warning"'].every((k) => web.includes('case ' + k)));
    ck('Text Size: the page follows it, growing by at most a quarter', /preferredFont\(forTextStyle: \.body\)\.pointSize \/ 17/.test(web)
      && /pageZoom = min\(max\(scale, 1\), 1\.25\)/.test(web) && /UIContentSizeCategory\.didChangeNotification/.test(web));
  }

  console.log('\nthe Xcode copy phase');
  const root = runCopyPhase();
  for (const f of ['index.html', 'css/style.css', 'js/cube.js', 'js/ncube.js', 'js/solver.js', 'js/bigsolver.js', 'js/view.js', 'js/lessons.js', 'js/timer.js', 'js/app.js',
                   'fonts/fredoka-latin-var.woff2', 'fonts/OFL.txt', 'media/intro.mp4', 'media/intro-poster.jpg']) {
    ck('bundles ' + f, fs.existsSync(path.join(root, f)));
  }

  const ranged = [];                                   // paths asked for a piece at a time
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/' || p === '') p = '/index.html';
    const file = path.join(root, p);
    if (!file.startsWith(root)) { res.writeHead(403).end(); return; }   // the handler's guard
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404).end('not in bundle'); return; }
      const headers = { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Accept-Ranges': 'bytes' };
      const range = req.headers.range && byteRange(req.headers.range, data.length);
      if (range) {
        ranged.push(p);
        headers['Content-Range'] = 'bytes ' + range.from + '-' + range.to + '/' + data.length;
        res.writeHead(206, headers);
        res.end(data.subarray(range.from, range.to + 1));
        return;
      }
      res.writeHead(200, headers);
      res.end(data);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;

  console.log('\nthe tour video, served the way WebKit asks for it');
  {
    const size = fs.statSync(path.join(root, 'media/intro.mp4')).size;
    const piece = async (range) => { const r = await fetch(base + '/media/intro.mp4', { headers: { Range: range } });
      return { status: r.status, cr: r.headers.get('content-range'), len: (await r.arrayBuffer()).byteLength, type: r.headers.get('content-type') }; };
    const first = await piece('bytes=0-1');
    ck('the first two bytes, as WebKit asks first', first.status === 206 && first.cr === 'bytes 0-1/' + size && first.len === 2 && first.type === 'video/mp4', JSON.stringify(first));
    const tail = await piece('bytes=-100');
    ck('the last hundred', tail.status === 206 && tail.cr === 'bytes ' + (size - 100) + '-' + (size - 1) + '/' + size && tail.len === 100);
    const rest = await piece('bytes=1000-');
    ck('from a point to the end', rest.status === 206 && rest.len === size - 1000);
    const odd = await piece('bytes=0-1,5-6');
    ck('several ranges at once get the whole file', odd.status === 200 && odd.len === size);
    const whole = await fetch(base + '/media/intro.mp4');
    ck('without a range, the whole file, saying ranges work', whole.status === 200 && whole.headers.get('accept-ranges') === 'bytes' && (await whole.arrayBuffer()).byteLength === size);
  }

  const b = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
  for (const profile of ['iPhone 12', 'iPad Pro 11']) {
    console.log('\n' + profile + ', served from the bundle');
    const ctx = await b.newContext({ ...devices[profile] });
    const device = /iPad/.test(profile) ? 'iPad' : 'iPhone';
    await ctx.addInitScript((d) => { window.CubeClubhouseHost = Object.freeze({ platform: 'ios', device: d }); }, device);
    const p = await ctx.newPage();
    const errs = [];
    const offDevice = [];
    p.on('request', (r) => { if (!r.url().startsWith(base) && !/^(data|blob):/.test(r.url())) offDevice.push(r.url()); });
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

    // The typeface now ships in the bundle, so it must actually arrive over the origin
    // the custom scheme gives the page - and nothing may be fetched from anywhere.
    ck('the bundled typeface loads', await p.evaluate(async () => {
      await document.fonts.ready;
      return document.fonts.check('700 18px Fredoka');
    }));
    ck('the font is served as a font', (await (await fetch(base + '/fonts/fredoka-latin-var.woff2')).headers.get('content-type')) === 'font/woff2');
    ck('the licence ships beside it', /SIL OPEN FONT LICENSE/i.test(await (await fetch(base + '/fonts/OFL.txt')).text()));
    ck('the body still names the fallback stack', /ui-rounded|SF Pro Rounded|system-ui/.test(
      await p.evaluate(() => getComputedStyle(document.body).fontFamily)));
    ck('the bundle asked for nothing off the device', offDevice.length === 0, offDevice.join(' | ') || 'none');

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
    const lic = await p.locator('#licence').textContent();
    ck('the licence travels with the app', /END USER LICENCE AGREEMENT/.test(lic) && /Ira Learning LLC/.test(lic));
    const infoSmall = await p.evaluate(() => [...document.querySelectorAll('#screen-grownups button, #screen-grownups a')]
      .filter((b) => b.offsetParent !== null)
      .filter((b) => b.getBoundingClientRect().height < 44).length);
    ck('its controls are finger-sized too', infoSmall === 0, infoSmall);
    await p.locator('#screen-grownups .back-to-app').first().tap();
    await p.waitForTimeout(300);

    // Everything is free: the guide opens on a 3x3 with nothing in the way.
    await p.locator('nav button[data-screen="play"]').tap();
    await p.waitForTimeout(300);
    await p.locator('#play-scramble').tap();
    await p.waitForTimeout(2600);
    await p.locator('#play-help').tap();
    await p.waitForFunction(() => document.querySelector('#play-guide .guide-count'), null, { timeout: 60000 });
    ck('3x3: the guide opens with nothing to pay', (await p.locator('#play-guide .guide-count').count()) === 1
      && (await p.locator('#play-guide .paywall').count()) === 0);

    // The speed timer, by real touches: hold the pad, let go, then tap to stop.
    await p.locator('nav button[data-screen="timer"]').tap();
    await p.waitForTimeout(250);
    ck('the tab bar is one row', await p.evaluate(() => {
      const tops = [...document.querySelectorAll('nav button')].map((b) => Math.round(b.getBoundingClientRect().top));
      return tops.every((t) => t === tops[0]);
    }));
    ck('the Timer fits the screen', await p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
    await p.locator('#timer-pad').scrollIntoViewIfNeeded();
    const pb = await p.locator('#timer-pad').boundingBox();
    const cdp = await ctx.newCDPSession(p);
    const at = [{ x: Math.round(pb.x + pb.width / 2), y: Math.round(pb.y + pb.height / 2) }];
    const touch = (type) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : at });
    await touch('touchStart'); await p.waitForTimeout(420);
    ck('Timer: holding the pad makes it ready', (await p.locator('#timer-pad').getAttribute('data-phase')) === 'ready');
    await touch('touchEnd'); await p.waitForTimeout(700);
    ck('Timer: letting go starts it', (await p.locator('#timer-pad').getAttribute('data-phase')) === 'running');
    await touch('touchStart'); await touch('touchEnd'); await p.waitForTimeout(200);
    const got = await p.$$eval('#timer-list .timer-t', (l) => l.map((x) => x.textContent.trim()));
    ck('Timer: a tap stops it and keeps the time', got.length === 1 && /^0\.[5-9]\d$|^1\.\d\d$/.test(got[0]), got.join(','));
    ck('Timer: the page did not scroll or zoom under the finger', await p.evaluate(() => window.visualViewport ? window.visualViewport.scale === 1 : true));
    const timerSmall = await p.evaluate(() => [...document.querySelectorAll('#screen-timer button')]
      .filter((b) => b.offsetParent !== null)
      .map((b) => ({ t: b.textContent.trim().slice(0, 16), w: Math.round(b.getBoundingClientRect().width), h: Math.round(b.getBoundingClientRect().height) }))
      .filter((b) => b.w < 44 || b.h < 44));
    ck('Timer: every control is at least 44pt', timerSmall.length === 0, JSON.stringify(timerSmall).slice(0, 160));
    // tick off turns and ask for help, by touch
    await p.locator('#timer-scramble .mix-turn').first().tap();
    await p.waitForTimeout(350);
    ck('Timer: a tapped turn is ticked off', /1 of 25/.test(await p.locator('#timer-mix-progress').textContent()));
    await p.locator('#timer-solve-help').tap();
    await p.waitForSelector('#timer-guide .guide-count', { timeout: 60000 });
    ck('Timer: Help me solve this mix opens the steps', /step 1 of/.test(await p.locator('#timer-guide .guide-count').textContent()));
    const helpSmall = await p.evaluate(() => [...document.querySelectorAll('#screen-timer button')]
      .filter((b) => b.offsetParent !== null)
      .map((b) => ({ t: b.textContent.trim().slice(0, 16), w: Math.round(b.getBoundingClientRect().width), h: Math.round(b.getBoundingClientRect().height) }))
      .filter((b) => b.w < 44 || b.h < 44));
    ck('Timer: with the steps open, every control is still 44pt', helpSmall.length === 0, JSON.stringify(helpSmall).slice(0, 160));
    // a second time makes a chart, which has to fit the screen
    await p.locator('#timer-pad').scrollIntoViewIfNeeded();
    const pb2 = await p.locator('#timer-pad').boundingBox();
    const at2 = [{ x: Math.round(pb2.x + pb2.width / 2), y: Math.round(pb2.y + pb2.height / 2) }];
    const touch2 = (type) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : at2 });
    await touch2('touchStart'); await p.waitForTimeout(420); await touch2('touchEnd');
    await p.waitForTimeout(500);
    await touch2('touchStart'); await touch2('touchEnd'); await p.waitForTimeout(250);
    ck('Timer: two times draw a chart', (await p.locator('#timer-chart svg.chart').count()) === 1);
    ck('Timer: the chart fits the screen', await p.evaluate(() => {
      const c = document.querySelector('#timer-chart svg').getBoundingClientRect();
      return c.right <= document.documentElement.clientWidth && document.documentElement.scrollWidth <= document.documentElement.clientWidth;
    }));
    await p.evaluate(() => localStorage.removeItem('cubeclubhouse.timer'));

    // it speaks as the iOS app on this device
    await p.locator('.foot-links [data-info="privacy"]').tap(); await p.waitForTimeout(200);
    ck('the privacy page says this ' + device, new RegExp('on this ' + device + ', inside the app').test(await p.locator('#privacy').innerText()));
    const nav = await p.locator('header nav').boundingBox();
    const vh = await p.evaluate(() => window.innerHeight);
    ck(device === 'iPhone' ? 'the tab bar is along the bottom' : 'the tab bar is at the top',
      device === 'iPhone' ? Math.abs(nav.y + nav.height - vh) < 2 : nav.y < 80, Math.round(nav.y) + '/' + vh);

    ck('no page errors', errs.length === 0, errs.join(' | ') || 'none');
    await ctx.close();
  }
  console.log('\nat the largest Text Size, on the narrowest iPhone');
  {
    // pageZoom 1.25 on a 375pt iPhone SE lays the page out 300 CSS pixels wide
    // Not isMobile: a mobile layout viewport quietly widens to fit whatever overflows,
    // which would hide exactly the fault this is looking for.
    const ctx = await b.newContext({ viewport: { width: 300, height: 534 }, deviceScaleFactor: 2, hasTouch: true });
    await ctx.addInitScript(() => { window.CubeClubhouseHost = Object.freeze({ platform: 'ios', device: 'iPhone' }); });
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', (e) => errs.push(e.message));
    await p.goto(base + '/index.html'); await p.waitForTimeout(400);
    const wide = [];
    for (const screen of ['learn', 'play', 'timer', 'solve']) {
      await p.locator(`nav button[data-screen="${screen}"]`).tap(); await p.waitForTimeout(250);
      if (await p.evaluate(() => document.documentElement.scrollWidth > 300)) wide.push(screen);
    }
    await p.locator('.foot-links [data-info="parents"]').tap(); await p.waitForTimeout(200);
    if (await p.evaluate(() => document.documentElement.scrollWidth > 300)) wide.push('grown-ups');
    ck('nothing scrolls sideways on any screen', wide.length === 0, wide.join(',') || 'none');
    ck('the four tabs still fit one row', await p.evaluate(() => {
      const t = [...document.querySelectorAll('header nav button')].map((b) => Math.round(b.getBoundingClientRect().top));
      return t.every((x) => x === t[0]);
    }));
    ck('no page errors', errs.length === 0, errs.join(' | ') || 'none');
    await ctx.close();
  }

  await b.close();
  server.close();
  fs.rmSync(path.dirname(path.dirname(root)), { recursive: true, force: true });
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ios bundle tests failed to run:', e); process.exit(1); });
