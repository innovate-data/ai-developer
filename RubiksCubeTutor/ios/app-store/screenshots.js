/* Cube Clubhouse - Copyright (c) 2026 Ira Learning LLC. All rights reserved. Proprietary software. See LICENSE, or the Licence page inside the app. */
/*
 * screenshots.js - App Store screenshots of the app's five screens, at the two sizes App
 * Store Connect asks for (it scales them down for every smaller device):
 *
 *   iPhone 6.9-inch display   1320 x 2868   (440 x 956 points at 3x)
 *   iPad 13-inch display      2064 x 2752   (1032 x 1376 points at 2x)
 *
 * The page is drawn exactly as the app's web view draws it, told it is on an iPhone or an
 * iPad the way the app tells it, with some stars and Timer times already earned so the
 * screens are not empty. Written to ios/app-store/screenshots/.
 *
 *     npm i --no-save playwright-core
 *     npm run build:screenshots
 */
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const OUT = path.join(HERE, 'screenshots');
const URL = 'file://' + path.join(HERE, '..', '..', 'index.html');
const EXE = process.env.CHROME || [
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].find((f) => fs.existsSync(f));

const DEVICES = [
  { name: 'iPhone-6.9', device: 'iPhone', viewport: { width: 440, height: 956 }, scale: 3, size: [1320, 2868] },
  { name: 'iPad-13', device: 'iPad', viewport: { width: 1032, height: 1376 }, scale: 2, size: [2064, 2752] },
];

// A learner a few lessons in, with a fortnight of Timer practice on the 3x3.
const PROGRESS = { meet: 3, moves: 3, daisy: 3, cross: 2, brain: { meet: true, moves: true, daisy: true } };
const TIMES = [95.4, 88.1, 91.7, 79.3, 82.6, 74.9, 77.2, 70.4, 72.8, 66.1, 69.5, 63.7, 65.2, 61.9]
  .map((s) => ({ ms: Math.round(s * 100) * 10, pen: 0 }));
const TIMER = { size: 3, inspect: false, solves: { 3: TIMES } };

const SHOTS = [
  ['1-learn', async () => {}],
  ['2-lesson', async (p) => {
    await p.locator('.lesson-card').nth(3).click();
    await p.waitForTimeout(900);
  }],
  ['3-play', async (p) => {
    await p.locator('nav button[data-screen="play"]').click();
    await p.locator('#play-size .size-btn', { hasText: '3×3' }).click();
    await p.locator('#play-scramble').click(); await p.waitForTimeout(3500);
    await p.locator('#play-help').click();
    await p.waitForSelector('#play-guide .guide-count', { timeout: 60000 });
    await p.waitForTimeout(600);
  }, '#play-size-note'],
  ['4-timer', async (p) => {
    await p.locator('nav button[data-screen="timer"]').click();
    await p.waitForTimeout(900);
  }, 'h3.timer-step'],
  ['5-my-real-cube', async (p) => {
    await p.locator('nav button[data-screen="solve"]').click();
    await p.locator('#solve-random').click(); await p.waitForTimeout(400);
    await p.locator('#solve-check').click();
    await p.waitForTimeout(1500);
  }, '#solve-msg'],
];
// On an iPhone the screens stack in one column, so the shot starts at the part that shows
// what the screen is for (the guide, the clock) rather than at the top of the page.

(async () => {
  if (!EXE) throw new Error('no Chrome or Chromium found: set CHROME=/path/to/chrome');
  fs.mkdirSync(OUT, { recursive: true });
  const b = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
  for (const d of DEVICES) {
    for (const [shot, act, phoneStart] of SHOTS) {
      const ctx = await b.newContext({
        viewport: d.viewport, deviceScaleFactor: d.scale, hasTouch: true, isMobile: d.device === 'iPhone', colorScheme: 'light',
      });
      await ctx.addInitScript(([device, progress, timer]) => {
        window.CubeClubhouseHost = Object.freeze({ platform: 'ios', device });
        if (!localStorage.getItem('cubeclubhouse.progress')) {
          localStorage.setItem('cubeclubhouse.progress', progress);
          localStorage.setItem('cubeclubhouse.timer', timer);
        }
      }, [d.device, JSON.stringify(PROGRESS), JSON.stringify(TIMER)]);
      const p = await ctx.newPage();
      const errors = [];
      p.on('pageerror', (e) => errors.push(e.message));
      await p.goto(URL);
      await p.evaluate(() => document.fonts.ready);
      await p.waitForTimeout(400);
      await act(p);
      await p.evaluate((sel) => {
        const el = sel && document.querySelector(sel);
        const top = el ? el.getBoundingClientRect().top + window.scrollY - 24 : 0;
        window.scrollTo(0, Math.max(0, top));
      }, d.device === 'iPhone' ? phoneStart : null);
      await p.waitForTimeout(250);
      if (errors.length) throw new Error(d.name + ' ' + shot + ': ' + errors.join('; '));
      const file = path.join(OUT, d.name + '-' + shot + '.png');
      await p.screenshot({ path: file });
      console.log('wrote', path.relative(path.join(HERE, '..', '..'), file));
      await ctx.close();
    }
  }
  await b.close();
})().catch((e) => { console.error(e); process.exit(1); });
