/* Cube Clubhouse - Copyright (c) 2026 Ira Learning LLC. All rights reserved. Proprietary software. See LICENSE, or the Licence page inside the app. */
/*
 * record.js - films the 20-second promo: promo.html with the real app running inside
 * its phone frame, driven on a fixed timeline, captured through Chrome's screencast at
 * 1080 x 1920, then encoded with the music from music.js into media/intro.mp4, where
 * the app's About page plays it and the App Store kit points at it.
 *
 *     npm i --no-save playwright-core
 *     FFMPEG=/path/to/ffmpeg node ios/app-store/promo/record.js
 *
 * The app is told it is the iPhone app (as WebAppView tells it), so it speaks iOS: the
 * tab bar along the bottom, "tap", and the device's name.
 */
/* global CSSStyleSheet -- used inside the page, not in Node */
const { chromium } = require('playwright-core');
const fs = require('fs');
const { Buffer } = require('buffer');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { writeMusic } = require('./music.js');

const HERE = __dirname;
const OUT = process.env.OUT || path.join(HERE, '..', '..', '..', 'media', 'intro.mp4');
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const LENGTH = 20;                                  // seconds
const EXE = process.env.CHROME || [
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].find((f) => fs.existsSync(f));

// A learner a few lessons in, with some Timer practice, so no screen is empty.
const PROGRESS = { meet: 3, moves: 3, daisy: 3, cross: 2, brain: { meet: true, moves: true, daisy: true } };
const TIMES = [95.4, 88.1, 91.7, 79.3, 82.6, 74.9, 77.2, 70.4, 72.8, 66.1, 69.5, 63.7]
  .map((s) => ({ ms: Math.round(s * 100) * 10, pen: 0 }));

(async () => {
  if (!EXE) throw new Error('no Chrome or Chromium found: set CHROME=/path/to/chrome');
  const b = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox', '--allow-file-access-from-files'] });
  const ctx = await b.newContext({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1, hasTouch: true });
  await ctx.addInitScript(([progress, timer]) => {
    if (window === window.top) return;               // only the app inside the phone
    window.CubeClubhouseHost = Object.freeze({ platform: 'ios', device: 'iPhone', version: '1.0', updateCheck: true });
    window.webkit = { messageHandlers: { haptic: { postMessage() {} }, updates: { postMessage() {} } } };
    const mm = window.matchMedia.bind(window);       // a phone has no hover
    window.matchMedia = (q) => mm(/hover:\s*hover/.test(q) ? '(max-width: 0px)' : q);
    localStorage.setItem('cubeclubhouse.progress', progress);
    localStorage.setItem('cubeclubhouse.timer', timer);
    localStorage.setItem('cubeclubhouse.speed', 'fast');
    // an iPhone's safe areas (the Dynamic Island, the home indicator), which WKWebView
    // passes to the page as env(safe-area-inset-*) and a plain iframe does not
    // (a constructed sheet, since the page's Content-Security-Policy rightly refuses <style>)
    document.addEventListener('DOMContentLoaded', () => {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync('.topbar { padding-top: 59px !important; } .topbar nav { padding-bottom: 34px !important; }'
        + ' body { padding-bottom: 100px !important; } html { scroll-padding-bottom: 110px !important; }');
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    });
  }, [JSON.stringify(PROGRESS), JSON.stringify({ size: 3, inspect: false, solves: { 3: TIMES } })]);

  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('file://' + path.join(HERE, 'promo.html'));
  await page.evaluate(() => { document.getElementById('app').src = '../../../index.html'; });
  let frame = null;
  for (let i = 0; i < 100 && !frame; i++) {
    frame = page.frames().find((f) => /\/index\.html/.test(f.url())) || null;
    if (!frame) await page.waitForTimeout(100);
  }
  if (!frame) throw new Error('the app did not load in the phone');
  await frame.waitForSelector('.lesson-card');
  await page.evaluate(() => document.fonts.ready);
  await frame.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(800);

  // ---- helpers
  const promo = (fn, ...a) => page.evaluate(([f, args]) => window.promo[f](...args), [fn, a]);
  const screenBox = await page.locator('.screen').boundingBox();
  // Show a tap where the element is (if it is on the phone's screen), then press it
  // without scrolling, the way a finger would.
  const tap = async (sel, nth = 0) => {
    const el = frame.locator(sel).nth(nth);
    const bb = await el.boundingBox();
    if (bb) {
      const x = bb.x + bb.width / 2, y = bb.y + bb.height / 2;
      if (x > screenBox.x && x < screenBox.x + screenBox.width && y > screenBox.y && y < screenBox.y + screenBox.height) await promo('tap', x, y);
    }
    await el.evaluate((e) => e.click());
  };
  const click = (sel, nth = 0) => frame.locator(sel).nth(nth).evaluate((e) => e.click());
  const top = () => frame.evaluate(() => window.scrollTo(0, 0));     // a new tab starts at its top
  const scrollTo = (y) => frame.evaluate((top) => window.scrollTo({ top, behavior: 'smooth' }), y);
  const scrollToEl = (sel, above) => frame.evaluate(([s, a]) => {
    const el = document.querySelector(s);
    window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - a, behavior: 'smooth' });
  }, [sel, above]);
  const pad = (kind) => frame.locator('#timer-pad').evaluate((p, k) => {
    p.dispatchEvent(new PointerEvent(k, { bubbles: true, pointerId: 1, pointerType: 'touch' }));
  }, kind);
  const padTapMark = async () => {
    const bb = await frame.locator('#timer-pad').boundingBox();
    await promo('tap', bb.x + bb.width / 2, bb.y + bb.height / 2);
  };

  // ---- film
  const frames = [];
  const cdp = await ctx.newCDPSession(page);
  cdp.on('Page.screencastFrame', (f) => {
    frames.push({ ts: f.metadata.timestamp, data: f.data });
    cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 90, maxWidth: 1080, maxHeight: 1920, everyNthFrame: 1 });
  await page.waitForTimeout(300);
  const t0 = Date.now() / 1000;
  const at = async (t) => { const wait = (t0 + t) * 1000 - Date.now(); if (wait > 0) await page.waitForTimeout(wait); };

  await promo('show', '#title');
  await at(1.9); await promo('hide', '#title', 'away'); await promo('show', '#phone');
  await at(2.2); await promo('show', '#cap-learn');
  await at(2.7); await scrollTo(230);
  await at(3.3); await tap('.lesson-card', 2);                    // The Daisy
  await at(4.2); await tap('#lesson-controls .pad-btn', 0);        // U
  await at(4.7); await tap('#lesson-controls .pad-btn', 6);        // R
  await at(5.2); await tap('#lesson-controls .pad-btn', 4);        // F

  await at(5.6); await promo('hide', '#cap-learn');
  await at(5.75); await promo('show', '#cap-play'); await tap('nav button[data-screen="play"]'); await top();
  await at(6.0); await click('#play-scramble');
  await at(7.9); await click('#play-help');
  await frame.waitForSelector('#play-guide .speed-btn', { timeout: 10000 });
  await click('#play-guide button:has-text("Watch the Whole Solve")');
  // the app glides down to the steps; stay on the cube, solving itself
  for (let i = 0; i < 6; i++) { await frame.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' })); await page.waitForTimeout(60); }

  await at(9.8); await promo('hide', '#cap-play');
  await at(9.95); await promo('show', '#cap-real'); await tap('nav button[data-screen="solve"]'); await top();
  await at(10.1); await scrollToEl('#solve-palette', 14);           // the colours and the flat cube
  await at(10.5); await tap('#solve-random');
  await at(11.1); await tap('#solve-check');
  await at(11.4); await scrollToEl('#solve-msg', 20);

  await at(12.6); await promo('hide', '#cap-real');
  await at(12.75); await promo('show', '#cap-timer'); await tap('nav button[data-screen="timer"]'); await top();
  await at(13.1); await tap('#timer-scramble button', 0);
  await at(13.4); await tap('#timer-scramble button', 1);
  await at(13.7); await tap('#timer-scramble button', 2);
  await at(14.0); await scrollToEl('h3.timer-step', 16);
  await at(14.5); await padTapMark(); await pad('pointerdown');     // hold: the numbers go green
  await at(15.1); await pad('pointerup');                          // let go: the clock runs

  await at(16.5); await promo('hide', '#cap-timer'); await promo('hide', '#phone');
  await at(16.8); await promo('show', '#end');
  await at(LENGTH + 0.3);
  await cdp.send('Page.stopScreencast');
  await b.close();
  if (errors.length) throw new Error('page errors: ' + errors.join('; '));

  // ---- encode: each frame lasts until the next one arrived, from t0 for LENGTH seconds
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promo-'));
  let list = '', n = 0, last = null;
  const kept = frames.filter((f) => f.ts >= t0 - 1).sort((a, c) => a.ts - c.ts);
  const start = kept.findIndex((f) => f.ts >= t0);
  const seq = start > 0 ? [Object.assign({}, kept[start - 1], { ts: t0 }), ...kept.slice(start)] : kept;
  for (let i = 0; i < seq.length; i++) {
    const from = Math.max(seq[i].ts, t0), to = i + 1 < seq.length ? seq[i + 1].ts : t0 + LENGTH;
    if (from >= t0 + LENGTH) break;
    const file = path.join(dir, String(n++).padStart(5, '0') + '.jpg');
    fs.writeFileSync(file, Buffer.from(seq[i].data, 'base64'));
    list += "file '" + file + "'\nduration " + Math.max(0.001, Math.min(to, t0 + LENGTH) - from).toFixed(4) + '\n';
    last = file;
  }
  list += "file '" + last + "'\n";                     // the concat demuxer wants the last one twice
  fs.writeFileSync(path.join(dir, 'list.txt'), list);
  const gaps = seq.slice(1).map((f, i) => ({ at: seq[i].ts - t0, gap: f.ts - seq[i].ts })).filter((g) => g.at < LENGTH);
  const worst = gaps.reduce((w, g) => (g.gap > w.gap ? g : w), { at: 0, gap: 0 });
  console.log(n + ' frames, ' + (n / LENGTH).toFixed(1) + ' fps on average, longest gap '
    + (worst.gap * 1000).toFixed(0) + ' ms at ' + worst.at.toFixed(2) + ' s');

  const music = path.join(dir, 'music.wav');
  writeMusic(music, LENGTH);
  execFileSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'concat', '-safe', '0', '-i', path.join(dir, 'list.txt'), '-i', music,
    '-vf', 'fps=30,format=yuv420p', '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-profile:v', 'high',
    '-c:a', 'aac', '-b:a', '192k', '-t', String(LENGTH), '-movflags', '+faststart', OUT], { stdio: 'inherit' });
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('wrote', OUT);
})().catch((e) => { console.error(e); process.exit(1); });
