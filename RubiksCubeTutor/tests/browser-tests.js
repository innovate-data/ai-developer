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
 * Set CHROME to point at a browser binary if none of the usual ones is found.
 */
let chromium;
try {
  ({ chromium } = require('playwright-core'));
} catch {
  console.log('skipped: playwright-core is not installed (npm i --no-save playwright-core)');
  process.exit(0);
}
const path = require('path');
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

  console.log('R15 cubes from 2x2 to 6x6 can be picked, turned, mixed and solved');
  { const p = await newPage();
    await p.locator('nav button[data-screen="play"]').click();
    await p.waitForTimeout(200);
    const stickers = () => p.evaluate(() => document.querySelectorAll('#play-cube .face:not(.inner)').length);
    const viewState = () => p.evaluate(() => [...document.querySelectorAll('#play-cube .face:not(.inner)')].map((f) => f.className.match(/c-\w/)[0]).join(''));
    const solvedOnScreen = () => p.evaluate(() => {
      const by = {};
      document.querySelectorAll('#play-cube .face:not(.inner)').forEach((f) => {
        const i = +f.dataset.index; const N = Math.round(Math.sqrt(document.querySelectorAll('#play-cube .face:not(.inner)').length / 6));
        (by[Math.floor(i / (N * N))] = by[Math.floor(i / (N * N))] || new Set()).add(f.className.match(/c-\w/)[0]);
      });
      return Object.values(by).every((set) => set.size === 1);
    });
    ck('five sizes are offered', await p.locator('#play-size .size-btn').count() === 5);
    for (const n of [2, 4, 5, 6, 3]) {
      await p.locator('#play-size .size-btn', { hasText: n + '×' + n }).click();
      await p.waitForTimeout(250);
      ck(n + 'x' + n + ' draws ' + (6 * n * n) + ' stickers', (await stickers()) === 6 * n * n, await stickers());
      const before = await viewState();
      await p.locator('#play-controls .pad-btn').first().click();
      await p.waitForTimeout(600);
      ck(n + 'x' + n + ' turns on a tap', (await viewState()) !== before);
      await p.locator('#play-undo').click();
      await p.waitForTimeout(600);
      ck(n + 'x' + n + ' undo puts it back', (await viewState()) === before);
      if (n >= 4) {
        const innerBtn = p.locator('#play-controls .pad-btn.inner').first();
        ck(n + 'x' + n + ' offers inner-layer buttons', (await innerBtn.count()) === 1);
        await innerBtn.click();
        await p.waitForTimeout(600);
        ck(n + 'x' + n + ' an inner layer turn changes the cube', (await viewState()) !== before);
        await p.locator('#play-reset').click();
        await p.waitForTimeout(400);
      }
      await p.locator('#play-scramble').click();
      await p.waitForTimeout(2600);
      ck(n + 'x' + n + ' mixes up', !(await solvedOnScreen()));
      await p.locator('#play-reset').click();
      await p.waitForTimeout(400);
      ck(n + 'x' + n + ' Make it solved', await solvedOnScreen());
    }
    // the guide works on a 2x2
    await p.locator('#play-size .size-btn', { hasText: '2×2' }).click();
    await p.waitForTimeout(250);
    await p.locator('#play-scramble').click();
    await p.waitForTimeout(2600);
    await p.locator('#play-help').click();
    await p.waitForTimeout(400);
    ck('2x2: the guide offers steps', /step 1 of/.test(await p.locator('#play-guide .guide-count').textContent()));
    ck('2x2: no step mentions a centre', !/centre/.test(await p.locator('#play-guide').textContent()));
    await p.locator('#play-guide .btn', { hasText: 'Watch the whole solve' }).click();
    await p.waitForFunction(() => document.querySelector('#play-guide .guide-done'), null, { timeout: 120000 });
    ck('2x2: the guide solves it', await solvedOnScreen());
    // and on a 4x4, where it builds centres and pairs edges before the 3x3 part
    await p.locator('#play-size .size-btn', { hasText: '4×4' }).click();
    await p.waitForTimeout(250);
    ck('4x4: help is offered', !(await p.locator('#play-help').isDisabled()));
    ck('4x4: the note explains the plan', /centres, then edges/.test(await p.locator('#play-size-note').textContent()));
    await p.locator('#play-scramble').click();
    await p.waitForTimeout(2600);
    await p.locator('#play-help').click();
    await p.waitForFunction(() => document.querySelector('#play-guide .guide-count'), null, { timeout: 30000 });
    const chips = await p.locator('#play-guide .stage-chip').allTextContents();
    ck('4x4: the stage bar starts with centres and edges', chips.indexOf('Centres') >= 0 && chips.indexOf('Pair the edges') > chips.indexOf('Centres') && chips.indexOf('White cross') > chips.indexOf('Pair the edges'), chips.join(','));
    ck('4x4: the first card explains the big-cube idea', /middle squares|centre/i.test(await p.locator('#play-guide .guide-text').textContent()));
    ck('4x4: the status says what to do', /Follow the steps/.test(await p.locator('#play-status').textContent()));
    await p.locator('#play-guide .btn', { hasText: 'Watch the whole solve' }).click();
    await p.waitForFunction(() => document.querySelector('#play-guide .guide-done'), null, { timeout: 240000 });
    ck('4x4: the guide solves it', await solvedOnScreen());
    // a 5x5 can turn its middle layer, which its guide asks for
    await p.locator('#play-size .size-btn', { hasText: '5×5' }).click();
    await p.waitForTimeout(250);
    const labels = await p.locator('#play-controls .pad-label').allTextContents();
    ck('5x5: the pad has a middle-layer row', labels.includes('the middle layer'), labels.join(','));
    const midBtn = p.locator('#play-controls .pad-row').nth(4).locator('.pad-btn').first();
    ck('5x5: the middle-layer button is a real move', /^3U/.test((await midBtn.textContent()).trim()));
    await midBtn.click();
    await p.waitForTimeout(600);
    ck('5x5: turning the middle layer changes the cube', !(await solvedOnScreen()));
    await p.locator('#play-reset').click();
    await p.waitForTimeout(300);

    // a 6x6 gets a guide too, without waiting for the whole solve to play out
    await p.locator('#play-size .size-btn', { hasText: '6×6' }).click();
    await p.waitForTimeout(250);
    await p.locator('#play-scramble').click();
    await p.waitForTimeout(2600);
    await p.locator('#play-help').click();
    ck('6x6: the status says it is working', /Thinking/.test(await p.locator('#play-status').textContent()));
    await p.waitForFunction(() => document.querySelector('#play-guide .guide-count'), null, { timeout: 60000 });
    const chips6 = await p.locator('#play-guide .stage-chip').allTextContents();
    ck('6x6: the guide plans centres, edges and the 3x3 stages', chips6.includes('Centres') && chips6.includes('Pair the edges') && chips6.includes('Finish'), chips6.join(','));
    await p.locator('#play-guide .btn', { hasText: 'Watch' }).first().click();
    await p.waitForTimeout(2500);
    ck('6x6: the first step plays without errors', (await p.locator('#play-guide .guide-count').textContent()).length > 0);

    // the choice is remembered, and My real cube knows Play is not a 3x3
    await p.locator('#play-size .size-btn', { hasText: '4×4' }).click();
    await p.waitForTimeout(250);
    await p.reload();
    await p.waitForTimeout(300);
    await p.locator('nav button[data-screen="play"]').click();
    await p.waitForTimeout(200);
    ck('the chosen size survives a reload', (await stickers()) === 6 * 16);
    await p.locator('nav button[data-screen="solve"]').click();
    await p.locator('#solve-from-play').click();
    ck('My real cube explains it needs a 3x3', /4×4/.test(await p.locator('#solve-msg').textContent()));
    await p.locator('nav button[data-screen="play"]').click();
    await p.locator('#play-size .size-btn', { hasText: '3×3' }).click();
    await p.waitForTimeout(200);
    await p.close(); }

  console.log('R16 changing cube size mid-flight leaves nothing stale behind');
  { const p = await newPage();
    const pick = async (n) => { await p.locator('#play-size .size-btn', { hasText: n + '×' + n }).click(); await p.waitForTimeout(220); };
    const solvedOnScreen = (n) => p.evaluate((N) => {
      const by = {};
      document.querySelectorAll('#play-cube .face:not(.inner)').forEach((f) => {
        const i = +f.dataset.index;
        (by[Math.floor(i / (N * N))] = by[Math.floor(i / (N * N))] || new Set()).add(f.className.match(/c-\w/)[0]);
      });
      return Object.values(by).every((set) => set.size === 1);
    }, n);
    await p.locator('nav button[data-screen="play"]').click();
    await p.waitForTimeout(200);

    // a move queued behind a running animation must not run against the next cube
    await pick(6);
    await p.locator('#play-scramble').click();
    await p.waitForTimeout(400);
    await p.locator('#play-controls .pad-btn.inner:not(.rot)').last().click();   // e.g. 3D', which a 2x2 has not got
    await p.waitForTimeout(150);
    await pick(2);
    await p.waitForTimeout(2200);
    ck('a queued deep move does not follow the cube to a smaller size', await solvedOnScreen(2));

    // mixing up, then switching size, must not leave the new cube marked as scrambled
    await pick(3);
    await p.locator('#play-scramble').click();
    await p.waitForTimeout(500);
    await pick(4);
    await p.waitForTimeout(2200);
    ck('the swapped-in cube is not announced as mixed', !/Go!/.test(await p.locator('#play-status').textContent()));
    await p.locator('#play-controls .pad-btn').first().click();
    await p.waitForTimeout(600);
    await p.locator('#play-undo').click();
    await p.waitForTimeout(800);
    ck('and a move plus an undo is not celebrated as a solve', !/Solved in/.test(await p.locator('#play-status').textContent()),
       (await p.locator('#play-status').textContent()).trim());

    // rotation buttons turn every layer, so they are not inner-layer buttons
    await pick(6);
    ck('rotations are not styled as inner layers', (await p.locator('#play-controls .pad-btn.rot.inner').count()) === 0);

    ck('no page errors', errs.length === 0, errs.join(' | ') || 'none');
    await p.close(); }

  console.log('R17 the narrator stops when the cube it was describing goes away');
  { const p = await b.newPage({ viewport: { width: 1280, height: 950 } });
    p.on('pageerror', (e) => errs.push(e.message));
    await p.addInitScript(() => {
      const log = { spoken: [], cancels: 0 };
      let cur = null;
      window.__speech = log;
      Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, value: function (t) { this.text = t; this.onend = null; this.onerror = null; } });
      Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
        speak(u) { cur = u; log.spoken.push(u.text); },
        // A real browser fires the utterance's end event when speech is cancelled.
        cancel() { log.cancels++; const u = cur; cur = null; if (u && u.onend) u.onend(); },
        getVoices: () => [] } });
    });
    await p.goto(URL);
    await p.locator('nav button[data-screen="play"]').click();
    await p.waitForTimeout(200);
    await p.locator('#play-scramble').click();
    await p.waitForTimeout(2600);
    await p.locator('#play-help').click();
    await p.waitForTimeout(300);
    const cancels = () => p.evaluate(() => window.__speech.cancels);

    await p.locator('#play-guide .btn', { hasText: 'Read' }).click();
    await p.waitForTimeout(120);
    let before = await cancels();
    await p.locator('#play-size .size-btn', { hasText: '5×5' }).click();
    await p.waitForTimeout(250);
    ck('changing size stops the narration', (await cancels()) > before);

    // and a manual move, which also tears the guide down
    await p.locator('#play-size .size-btn', { hasText: '3×3' }).click();
    await p.waitForTimeout(250);
    await p.locator('#play-scramble').click();
    await p.waitForTimeout(2600);
    await p.locator('#play-help').click();
    await p.waitForTimeout(300);
    await p.locator('#play-guide .btn', { hasText: 'Read' }).click();
    await p.waitForTimeout(120);
    before = await cancels();
    await p.locator('#play-controls .pad-btn').first().click();
    await p.waitForTimeout(400);
    ck('making your own move stops the narration', (await cancels()) > before);
    await p.close(); }

  console.log('R20 the child controls how the whole solve is shown');
  { const p = await newPage();
    const cubeState = () => p.evaluate(() => [...document.querySelectorAll('#play-cube .face:not(.inner)')].map((f) => f.className.match(/c-\w/)[0]).join(''));
    const solvedNow = () => p.evaluate(() => {
      const by = {};
      const faces = document.querySelectorAll('#play-cube .face:not(.inner)');
      const N = Math.round(Math.sqrt(faces.length / 6));
      faces.forEach((f) => { const i = +f.dataset.index; (by[(i / (N * N)) | 0] = by[(i / (N * N)) | 0] || new Set()).add(f.className.match(/c-\w/)[0]); });
      return Object.values(by).every((s) => s.size === 1);
    });
    await p.locator('nav button[data-screen="play"]').click();
    await p.waitForTimeout(200);
    await p.locator('#play-scramble').click();
    await p.waitForTimeout(2600);
    await p.locator('#play-help').click();
    await p.waitForFunction(() => document.querySelector('#play-guide .guide-count'), null, { timeout: 30000 });
    ck('three speeds are offered', await p.locator('#play-guide .speed-btn').count() === 3);
    ck('pause and stop stay out of the way until they are needed', await p.locator('#play-guide .btn', { hasText: 'Pause' }).isHidden());

    await p.locator('#play-guide .speed-btn', { hasText: 'Slow' }).click();
    await p.locator('#play-guide .btn', { hasText: 'Watch the whole solve' }).click();
    await p.waitForTimeout(700);
    ck('pause and stop appear while the solve plays', await p.locator('#play-guide .btn', { hasText: 'Pause' }).isVisible());
    ck('the step buttons are hidden while it plays', await p.locator('#play-guide .btn', { hasText: 'I did it' }).isHidden());

    await p.locator('#play-guide .btn', { hasText: 'Pause' }).click();
    await p.waitForTimeout(900);
    const frozen = await cubeState();
    await p.waitForTimeout(1100);
    ck('pause holds the cube still', frozen === (await cubeState()));
    // a new speed while paused, then carry on
    await p.locator('#play-guide .speed-btn', { hasText: 'Fast' }).click();
    await p.locator('#play-guide .btn', { hasText: 'Carry on' }).click();
    await p.waitForTimeout(1200);
    ck('carrying on starts the cube turning again', frozen !== (await cubeState()));

    await p.locator('#play-guide .btn', { hasText: 'Stop here' }).click();
    await p.waitForTimeout(1500);
    ck('stopping brings the step buttons back', await p.locator('#play-guide .btn', { hasText: 'I did it' }).isVisible());
    const card = await p.locator('#play-guide .guide-count').textContent();
    ck('stopping lands on a whole step', /step \d+ of \d+/.test(card), card);
    // The cube it hands back has to match the card: the rest of the steps must finish it.
    await p.locator('#play-guide .btn', { hasText: 'Watch the whole solve' }).click();
    await p.waitForFunction(() => document.querySelector('#play-guide .guide-done'), null, { timeout: 180000 });
    ck('the steps left after a stop still solve the cube', await solvedNow());

    await p.reload();
    await p.waitForTimeout(300);
    await p.locator('nav button[data-screen="play"]').click();
    await p.locator('#play-scramble').click();
    await p.waitForTimeout(2600);
    await p.locator('#play-help').click();
    await p.waitForFunction(() => document.querySelector('#play-guide .guide-count'), null, { timeout: 30000 });
    ck('the chosen speed is remembered', (await p.locator('#play-guide .speed-btn.active').textContent()).includes('Fast'));
    await p.close(); }

  console.log('R21 the drawn cube keeps up with the state it is meant to show');
  { const p = await newPage();
    // The view repaints only the stickers that changed, so a drifting diff would show
    // a cube that no longer matches the model. Drive it hard and compare every sticker.
    const drift = await p.evaluate(async () => {
      const host = document.createElement('div');
      host.style.cssText = 'position:fixed;left:0;top:0;width:420px;height:420px';
      document.body.appendChild(host);
      const out = [];
      for (const N of [3, 5]) {
        const model = RC.NCube.make(N);
        const view = new RC.CubeView(host, { model, size: 40 });
        let state = model.solved();
        const moves = model.scramble(14, (() => { let x = 7; return () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; }; })());
        for (const m of moves) state = model.applyMove(state, m);
        await view.play(moves, 20);
        view.setHighlights([0, 1, 2]);
        view.setHighlights([]);
        const drawn = [...host.querySelectorAll('.face:not(.inner)')]
          .map((f) => [+f.dataset.index, f.className.match(/c-(\w)/)[1]]);
        const wrong = drawn.filter(([i, c]) => c !== state[i]).length;
        out.push(N + 'x' + N + ':' + wrong + ' of ' + drawn.length);
        if (wrong) out.push('MISMATCH');
        host.innerHTML = '';
      }
      host.remove();
      return out.join(' ');
    });
    ck('every sticker drawn matches the state after a scramble', !/MISMATCH/.test(drift), drift);
    await p.close(); }

  console.log('R22 the grown-ups pages are reachable, readable and honest');
  { const p = await newPage();
    ck('the footer offers all three pages', await p.locator('.foot-links .linkish').count() === 3);
    await p.locator('.foot-links [data-info="privacy"]').click();
    await p.waitForTimeout(300);
    ck('a footer link opens the grown-ups screen', !(await p.locator('#screen-grownups').isHidden()));
    ck('the child screens step aside', await p.locator('#screen-learn').isHidden() && await p.locator('#screen-play').isHidden());
    const privacy = await p.locator('#privacy').textContent();
    ck('privacy says what is stored and that nothing leaves', /collects nothing/.test(privacy) && /Google Fonts/.test(privacy), privacy.slice(0, 60));
    const licence = await p.locator('#licence').textContent();
    ck('the licence is there in full, not just described', /MIT License/.test(licence) && /WITHOUT WARRANTY OF ANY KIND/.test(licence));
    ck('the trademark is acknowledged', /trademark/.test(licence));
    ck('for parents covers what it teaches and how long', /lessons/.test(await p.locator('#parents').textContent()));

    // The in-page links jump between sections without losing the screen.
    await p.locator('.info-nav a[href="#licence"]').click();
    await p.waitForTimeout(250);
    ck('the section links stay on the screen', !(await p.locator('#screen-grownups').isHidden()));
    ck('and land below the sticky header', await p.evaluate(() => {
      const bar = document.querySelector('.topbar').getBoundingClientRect();
      return document.querySelector('#licence h2').getBoundingClientRect().top >= bar.bottom - 1;
    }));

    // Clearing progress takes two taps, and really clears it.
    await p.evaluate(() => { localStorage.setItem('cubeclubhouse.progress', '{"daisy":3}'); localStorage.setItem('cubeclubhouse.size', '5'); });
    await p.locator('#clear-progress').click();
    await p.waitForTimeout(120);
    ck('one press only arms the erase', (await p.evaluate(() => localStorage.getItem('cubeclubhouse.progress'))) === '{"daisy":3}');
    ck('and says what it is about to do', /Tap again/.test(await p.locator('#clear-progress').textContent()));
    await p.locator('#clear-progress').click();
    await p.waitForTimeout(120);
    ck('the second press erases the lot', await p.evaluate(() => !localStorage.getItem('cubeclubhouse.progress') && !localStorage.getItem('cubeclubhouse.size') && !localStorage.getItem('cubeclubhouse.speed')));

    await p.locator('#screen-grownups .back-to-app').first().click();
    await p.waitForTimeout(250);
    ck('Back returns to the lessons', !(await p.locator('#screen-learn').isHidden()));
    // A deep link opens the right part, and a nonsense hash still shows a screen.
    await p.goto(URL + '#licence');
    await p.waitForTimeout(400);
    ck('a link to #licence opens the grown-ups screen', !(await p.locator('#screen-grownups').isHidden()));
    await p.goto(URL + '#toString');
    await p.waitForTimeout(400);
    ck('a nonsense hash still shows the lessons', !(await p.locator('#screen-learn').isHidden()));
    await p.close(); }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  console.log('page errors:', errs.length ? errs : 'none');
  await b.close();
  process.exit(fail || errs.length ? 1 : 0);
})().catch(e => { console.error('REGRESSION HARNESS FAILED', e); process.exit(1); });
