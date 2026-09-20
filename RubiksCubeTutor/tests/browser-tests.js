/*
 * browser-tests.js - end-to-end regression tests for Cube Clubhouse.
 *
 * Each case is a bug that was found in the real app and fixed; they exist to stop it
 * coming back. Unlike tests/run-tests.js (pure model and solver logic, no browser),
 * these drive the actual page: animation interrupts, star awards, keyboard input,
 * navigation and the practice flow.
 *
 * Needs a Chromium and playwright-core, neither of which is a dependency of the app:
 *     npm i --no-save playwright-core
 *     node tests/browser-tests.js
 * Set CHROME to point at a browser binary if the default path is wrong.
 */
let chromium;
try {
  ({ chromium } = require('playwright-core'));
} catch {
  console.log('skipped: playwright-core is not installed (npm i --no-save playwright-core)');
  process.exit(0);
}
const path = require('path');
const EXE = process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const URL = 'file://' + path.resolve(__dirname, '..', 'index.html');
const view = (sel) => `(() => { const st=new Array(54);
  document.querySelectorAll('${sel} .face:not(.inner)').forEach(f=>{st[+f.dataset.index]=f.className.match(/c-(\\w)/)[1];});
  return st.join(''); })()`;
let pass = 0, fail = 0;
const ck = (name, ok, extra) => { (ok ? pass++ : fail++); console.log((ok ? '  PASS ' : '  FAIL ') + name + (extra !== undefined ? '  [' + extra + ']' : '')); };

(async () => {
  const b = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
  const errs = [];
  // A layer turn is a CSS transform; the sticker colours only change when the move
  // lands. So wait for every cubie to be back at a plain translate, then settle.
  const settle = async (p, sel) => {
    await p.waitForFunction((s) => {
      const c = document.querySelectorAll(s + ' .cubie');
      return c.length > 0 && [...c].every((e) => !/rotate/.test(e.style.transform));
    }, sel, { timeout: 30000 });
    await p.waitForTimeout(120);
    return p.evaluate(view(sel));
  };
  const newPage = async () => {
    const p = await b.newPage({ viewport: { width: 1280, height: 950 } });
    p.on('pageerror', e => errs.push(e.message));
    p.on('console', m => { if (m.type() === 'error' && !/ERR_CERT/.test(m.text())) errs.push('console: ' + m.text()); });
    await p.goto(URL); return p;
  };

  console.log('R1  lesson list is hidden while a lesson is open');
  { const p = await newPage();
    await p.locator('.lesson-card').nth(5).click(); await p.waitForTimeout(250);
    const h = await p.evaluate(() => document.getElementById('lesson-list').getBoundingClientRect().height);
    ck('lesson grid collapsed', h === 0, 'height=' + h); await p.close(); }

  console.log('R2  interrupting an animation keeps view and state in sync');
  { const p = await newPage();
    await p.locator('.lesson-card').nth(2).click(); await p.waitForTimeout(250);
    await p.locator('#lesson-practice .btn', { hasText: 'Hint' }).click(); await p.waitForTimeout(50);
    await p.locator('.hint-box .btn', { hasText: '▶ Watch' }).click(); await p.waitForTimeout(100);
    await p.locator('#lesson-practice .btn', { hasText: 'Another puzzle' }).click(); await p.waitForTimeout(1500);
    for (let k = 0; k < 30; k++) {
      if (await p.locator('.practice-status.win').count()) break;
      await p.locator('#lesson-practice .btn', { hasText: 'Hint' }).click(); await p.waitForTimeout(60);
      if (await p.locator('.hint-box .guide-done').count()) break;
      await p.locator('.hint-box .btn', { hasText: '▶ Watch' }).click(); await p.waitForTimeout(120);
      await settle(p, '#lesson-cube');
    }
    const final = await settle(p, '#lesson-cube');
    const won = await p.locator('.practice-status.win').count() > 0;
    const goalOnScreen = await p.evaluate(`RC.Solver.goals.daisy('${final}'.split(''))`);
    ck('win banner matches the visible cube', won && goalOnScreen, 'won=' + won + ' visibleGoal=' + goalOnScreen);
    await p.close(); }

  console.log('R2b the win banner waits for the cube to stop turning');
  { const p = await newPage();
    await p.locator('.lesson-card').nth(2).click(); await p.waitForTimeout(250);
    let early = false;
    for (let k = 0; k < 25; k++) {
      if (await p.locator('.practice-status.win').count()) break;
      await p.locator('#lesson-practice .btn', { hasText: 'Hint' }).click(); await p.waitForTimeout(60);
      if (await p.locator('.hint-box .guide-done').count()) break;
      await p.locator('.hint-box .btn', { hasText: '▶ Watch' }).click(); await p.waitForTimeout(120);
      if (await p.locator('.practice-status.win').count()) {
        const stillTurning = await p.evaluate(() =>
          [...document.querySelectorAll('#lesson-cube .cubie')].some((e) => /rotate/.test(e.style.transform)));
        if (stillTurning) early = true;
      }
      await settle(p, '#lesson-cube');
    }
    ck('banner not shown mid-animation', !early);
    await p.close(); }

  console.log('R3  Reset mid-scramble leaves a genuinely solved cube');
  { const p = await newPage();
    await p.locator('nav button[data-screen="play"]').click();
    await p.locator('#play-scramble').click(); await p.waitForTimeout(600);
    await p.locator('#play-reset').click(); await p.waitForTimeout(2500);
    ck('displayed cube is solved', await p.evaluate(`RC.Cube.isSolved(${view('#play-cube')}.split(''))`));
    await p.close(); }

  console.log('R4  two scrambles in a row do not leave two loops fighting');
  { const p = await newPage();
    await p.locator('nav button[data-screen="play"]').click();
    await p.locator('#play-scramble').click(); await p.waitForTimeout(700);
    await p.locator('#play-scramble').click(); await p.waitForTimeout(4000);
    await p.locator('#play-help').click(); await p.waitForTimeout(400);
    await p.locator('#play-guide .btn', { hasText: 'Watch the whole solve' }).click();
    await p.waitForFunction(() => document.querySelector('#play-guide .guide-done'), null, { timeout: 120000 });
    ck('auto-solve ends on a visibly solved cube', await p.evaluate(`RC.Cube.isSolved(${view('#play-cube')}.split(''))`));
    await p.close(); }

  console.log('R5  clearing the guide mid auto-play does not wedge it');
  { const p = await newPage();
    await p.locator('nav button[data-screen="play"]').click();
    await p.locator('#play-scramble').click(); await p.waitForTimeout(2600);
    await p.locator('#play-help').click(); await p.waitForTimeout(300);
    await p.locator('#play-guide .btn', { hasText: 'Watch the whole solve' }).click(); await p.waitForTimeout(900);
    await p.locator('#play-controls .pad-btn').first().click();   // tears down the guide mid-run
    await p.waitForTimeout(1200);
    await p.locator('#play-help').click(); await p.waitForTimeout(400);
    const before = await p.evaluate(view('#play-cube'));
    await p.locator('#play-guide .btn', { hasText: '▶ Watch' }).click(); await p.waitForTimeout(1400);
    const after = await p.evaluate(view('#play-cube'));
    ck('guide still responds after being torn down', before !== after);
    await p.close(); }

  console.log('R6  no unearned stars when visiting a lesson with no practice');
  { const p = await newPage();
    await p.evaluate(() => localStorage.clear());
    await p.locator('.lesson-card').nth(4).click(); await p.waitForTimeout(250);
    await p.locator('#lesson-back').click();
    await p.locator('.lesson-card').nth(0).click(); await p.waitForTimeout(400);
    const prog = await p.evaluate(() => localStorage.getItem('cubeclubhouse.progress'));
    ck('progress untouched', prog === null || prog === '{}', 'progress=' + prog);
    await p.close(); }

  console.log('R7  keyboard still works after clicking a button');
  { const p = await newPage();
    await p.locator('nav button[data-screen="play"]').click();
    await p.locator('#play-controls .pad-btn').first().click(); await p.waitForTimeout(600);
    const s1 = await p.evaluate(view('#play-cube'));
    await p.keyboard.press('r'); await p.waitForTimeout(700);
    ck('keyboard move registered', s1 !== await p.evaluate(view('#play-cube')));
    await p.close(); }

  console.log('R8  browser Back moves between screens');
  { const p = await newPage();
    await p.locator('nav button[data-screen="play"]').click(); await p.waitForTimeout(150);
    await p.locator('nav button[data-screen="solve"]').click(); await p.waitForTimeout(150);
    await p.goBack(); await p.waitForTimeout(300);
    ck('back returns to Play', await p.evaluate(() => !document.getElementById('screen-play').hidden));
    await p.close(); }

  console.log('R9  a junk hash does not blank the app');
  { const p = await b.newPage(); p.on('pageerror', e => errs.push(e.message));
    await p.goto(URL + '#toString'); await p.waitForTimeout(300);
    ck('Learn screen shown', await p.evaluate(() => !document.getElementById('screen-learn').hidden));
    await p.close(); }

  console.log('R10 a stale hint is retired when the child moves');
  { const p = await newPage();
    await p.locator('.lesson-card').nth(4).click(); await p.waitForTimeout(250);
    await p.locator('#lesson-practice .btn', { hasText: 'Hint' }).click(); await p.waitForTimeout(100);
    const visibleBefore = await p.locator('.hint-box').isVisible();
    await p.locator('#lesson-controls .pad-btn').nth(4).click(); await p.waitForTimeout(800);
    ck('hint hidden after a manual move', visibleBefore && !(await p.locator('.hint-box').isVisible()));
    ck('no stale highlight left on the cube', await p.locator('#lesson-cube .face.hl').count() === 0);
    await p.close(); }

  console.log('R11 Undo on Play invalidates the guide');
  { const p = await newPage();
    await p.locator('nav button[data-screen="play"]').click();
    await p.locator('#play-scramble').click(); await p.waitForTimeout(2600);
    await p.locator('#play-help').click(); await p.waitForTimeout(300);
    await p.locator('#play-undo').click(); await p.waitForTimeout(600);
    ck('guide cleared', await p.locator('#play-guide').evaluate(e => e.childElementCount === 0));
    await p.close(); }

  console.log('R12 practice never opens on an already-finished puzzle');
  { const p = await newPage();
    let instant = 0;
    await p.locator('.lesson-card').nth(6).click(); await p.waitForTimeout(300);   // yellow cross, was 11%
    for (let k = 0; k < 40; k++) {
      if (await p.locator('.practice-status.win').count()) instant++;
      await p.locator('#lesson-practice .btn', { hasText: 'Another puzzle' }).click(); await p.waitForTimeout(120);
    }
    ck('40 fresh yellow-cross cubes all need work', instant === 0, 'instant wins=' + instant);
    await p.close(); }

  console.log('R13 invalid painted cube still explains itself in plain words');
  { const p = await newPage();
    await p.locator('nav button[data-screen="solve"]').click();
    await p.locator('.swatch').nth(0).click();
    await p.locator('.net-cell').nth(0).click();
    await p.locator('#solve-check').click(); await p.waitForTimeout(200);
    const m = await p.locator('#solve-msg').textContent();
    ck('friendly message', /9 white stickers/.test(m), m.trim());
    await p.close(); }

  console.log('R14 the Read button stops the narration when pressed again');
  { // Headless Chromium has no voices, so stand a controllable engine in its place.
    // It records what was spoken and lets the test end an utterance on cue.
    const p = await b.newPage({ viewport: { width: 1280, height: 950 } });
    p.on('pageerror', (e) => errs.push(e.message));
    await p.addInitScript(() => {
      const log = { spoken: [], cancels: 0 };
      let current = null;
      window.__speech = log;
      window.__endSpeech = () => { const u = current; current = null; if (u && u.onend) u.onend(); };
      Object.defineProperty(window, 'SpeechSynthesisUtterance', {
        configurable: true,
        value: function (text) { this.text = text; this.onend = null; this.onerror = null; },
      });
      Object.defineProperty(window, 'speechSynthesis', {
        configurable: true,
        value: {
          speak(u) { current = u; log.spoken.push(u.text); },
          // real engines fire the end event late, after cancel() has returned
          cancel() { log.cancels++; const u = current; current = null; if (u && u.onend) setTimeout(() => u.onend(), 0); },
          getVoices: () => [],
        },
      });
    });
    await p.goto(URL);
    await p.locator('.lesson-card').nth(4).click();
    await p.waitForTimeout(300);

    const read = p.locator('#lesson-story .btn').first();
    const label = () => read.textContent();
    const pressed = () => read.getAttribute('aria-pressed');
    const spoken = () => p.evaluate(() => window.__speech.spoken.length);
    const cancels = () => p.evaluate(() => window.__speech.cancels);

    ck('it starts out offering to read', /Read to me/.test(await label()) && (await pressed()) === 'false');

    await read.click(); await p.waitForTimeout(80);
    const saidFirst = await spoken();
    ck('one press starts reading', saidFirst === 1 && /Stop/.test(await label()) && (await pressed()) === 'true');

    const before = await cancels();
    await read.click(); await p.waitForTimeout(80);
    ck('a second press stops it', (await cancels()) > before, 'cancel called');
    ck('and the button offers to read again', /Read to me/.test(await label()) && (await pressed()) === 'false');
    ck('stopping does not start a new narration', (await spoken()) === saidFirst);

    // a third press starts again, and finishing on its own also resets the button
    await read.click(); await p.waitForTimeout(80);
    ck('it can be started again', (await spoken()) === saidFirst + 1 && /Stop/.test(await label()));
    await p.evaluate(() => window.__endSpeech());
    await p.waitForTimeout(80);
    ck('finishing on its own resets the button', /Read to me/.test(await label()) && (await pressed()) === 'false');

    // only one thing reads at a time: another Read button takes over and resets this one
    await read.click(); await p.waitForTimeout(80);
    const alg = p.locator('#lesson-algs .btn[aria-pressed]').first();
    await alg.click(); await p.waitForTimeout(80);
    ck('another Read button takes over', /Read to me/.test(await label()) && (await pressed()) === 'false');
    ck('and that one is now reading', (await alg.getAttribute('aria-pressed')) === 'true');

    // a late end event from the cancelled utterance must not reset the new reader
    await p.waitForTimeout(120);
    ck('a late end event does not disturb the new reader', (await alg.getAttribute('aria-pressed')) === 'true');

    // leaving the lesson stops the voice
    await p.locator('#lesson-back').click();
    await p.waitForTimeout(150);
    ck('leaving the lesson stops the narration', (await cancels()) > 0);
    await p.close();
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  console.log('page errors:', errs.length ? errs : 'none');
  await b.close();
  process.exit(fail || errs.length ? 1 : 0);
})().catch(e => { console.error('REGRESSION HARNESS FAILED', e); process.exit(1); });
