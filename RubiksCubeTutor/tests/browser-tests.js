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
// Swapping size with a mixed cube on screen takes a second tap (R29). The cases that
// use this are about what happens after a swap, so they make both taps.
const swapSize = async (p, n) => {
  const b = p.locator('#play-size .size-btn', { hasText: n + '×' + n });
  await b.click();
  if (!(await b.evaluate((x) => x.classList.contains('active')))) await b.click();
};
const ck = (name, ok, extra) => { (ok ? pass++ : fail++); console.log((ok ? '  PASS ' : '  FAIL ') + name + (extra !== undefined ? '  [' + extra + ']' : '')); };

(async () => {
  const b = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
  const errs = [];
  // A layer turn is a CSS transform; the sticker colours only change when the move
  // lands. So wait for every cubie to be back at a plain translate, then settle.
  const settle = async (p, sel) => {
    await p.waitForFunction((s) => {
      const c = document.querySelectorAll(s + ' .cubie');
      // .swing is the picture turning back to the usual view before a turn (R27)
      return c.length > 0 && [...c].every((e) => !/rotate/.test(e.style.transform)) && !document.querySelector(s + ' .cube.swing');
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
    await p.keyboard.press('r'); await p.waitForTimeout(500);      // a turn of the child's own to undo
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
    await swapSize(p, 4);
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
    const pick = async (n) => { await swapSize(p, n); await p.waitForTimeout(220); };
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
    await swapSize(p, 5);
    await p.waitForTimeout(250);
    ck('changing size stops the narration', (await cancels()) > before);

    // and a manual move, which also tears the guide down
    await swapSize(p, 3);
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
    ck('privacy says what is stored and that nothing leaves', /collects nothing/.test(privacy)
      && /What the app asks the internet for/.test(privacy) && /Nothing\./.test(privacy)
      && !/Google Fonts/.test(privacy), privacy.replace(/\s+/g, ' ').slice(0, 70));
    const licence = await p.locator('#licence').textContent();
    ck('the licence is there in full, not just described', /END USER LICENCE AGREEMENT/.test(licence) && /WITHOUT\s+WARRANTY OF ANY KIND/.test(licence));
    ck('it says who owns the app, and that it is not open source', /Ira Learning LLC/.test(licence) && /not open source/.test(licence));
    ck('the restrictions are spelled out', /RESTRICTIONS/.test(licence) && /RESERVATION OF RIGHTS/.test(licence));
    ck('the trademarks are acknowledged', /trademark/.test(licence));
    ck('every screen carries the copyright line', /2026 Ira Learning LLC/.test(await p.locator('.foot-copy').textContent()));
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

  console.log('R23 every part of the app is free, with nothing to buy anywhere');
  { const p = await newPage();
    await p.locator('nav button[data-screen="play"]').click();
    await p.waitForTimeout(200);
    // The guide used to stop at a paywall on anything bigger than a 2x2.
    for (const n of [2, 3, 4]) {
      await p.locator('#play-size .size-btn', { hasText: n + '×' + n }).click();
      await p.waitForTimeout(350);
      await p.locator('#play-scramble').click();
      await p.waitForTimeout(2700);
      await p.locator('#play-help').click();
      await p.waitForFunction(() => document.querySelector('#play-guide .guide-count'), null, { timeout: 60000 });
      ck(n + 'x' + n + ': the guide just opens', (await p.locator('#play-guide .guide-count').count()) === 1);
      ck(n + 'x' + n + ': nothing asks for money', (await p.locator('#play-guide .paywall').count()) === 0
        && !/purchase|unlock|\$/i.test(await p.locator('#play-guide').textContent()));
    }
    // My real cube gives its steps without a gate too
    await p.locator('nav button[data-screen="solve"]').click();
    await p.locator('#solve-random').click();
    await p.waitForTimeout(400);
    await p.locator('#solve-check').click();
    await p.waitForFunction(() => document.querySelector('#solve-guide .guide-count'), null, { timeout: 30000 });
    ck('My real cube: steps, no gate', (await p.locator('#solve-guide .paywall').count()) === 0);

    // and the grown-ups pages say so in as many words
    await p.locator('.foot-links [data-info="parents"]').click();
    await p.waitForTimeout(300);
    const parents = await p.locator('#parents').textContent();
    ck('For parents says it costs nothing', /free to use/i.test(parents) && /Nothing\./.test(parents), parents.slice(parents.indexOf('What it costs'), parents.indexOf('What it costs') + 60));
    ck('and offers nothing to buy', (await p.locator('#solver-unlock').count()) === 0 && (await p.locator('#solver-restore').count()) === 0);
    const licence = await p.locator('#licence').textContent();
    ck('the licence says free to use and still proprietary', /free of charge/i.test(licence) && /proprietary/i.test(licence) && /not\s+open source/i.test(licence));
    ck('and still forbids copying and selling', /may not/i.test(licence) && /resell/i.test(licence));
    const privacy = await p.locator('#privacy').textContent();
    ck('privacy says there is nothing to pay for', /no purchases/i.test(privacy) && /Nothing to buy/i.test(privacy));
    await p.close(); }

  console.log('R24 the app asks the network for nothing');
  { const p = await b.newPage({ viewport: { width: 1280, height: 950 } });
    p.on('pageerror', e => errs.push(e.message));
    const asked = [];
    // Record everything the page tries to load, and refuse anything that is not local,
    // so a request that slipped back in shows up as a broken page as well as a failure.
    await p.route('**/*', (route) => {
      const u = route.request().url();
      asked.push(u);
      if (/^(file|data|blob):/.test(u)) route.continue();
      else route.abort();
    });
    await p.goto(URL);
    await p.waitForTimeout(400);
    // walk the whole app, since a stray request could hide behind any screen
    for (const screen of ['play', 'solve', 'learn']) {
      await p.locator(`nav button[data-screen="${screen}"]`).click();
      await p.waitForTimeout(250);
    }
    await p.locator('.lesson-card').first().click();
    await p.waitForTimeout(400);
    await p.locator('.foot-links [data-info="privacy"]').click();
    await p.waitForTimeout(300);

    const remote = asked.filter((u) => !/^(file|data|blob):/.test(u));
    ck('not one request leaves the device', remote.length === 0, remote.join(' | ') || 'none of ' + asked.length);
    ck('the typeface is not fetched from anywhere', !asked.some((u) => /fonts\.(googleapis|gstatic)/.test(u)), 'none');

    // the policy is the thing that keeps it that way, so check the browser applied it
    const blocked = await p.evaluate(async () => {
      try { await fetch('https://example.com/ping'); return 'allowed'; } catch { return 'blocked'; }
    });
    ck('the policy blocks fetch outright', blocked === 'blocked', blocked);
    ck('the page declares a policy with no http source', await p.evaluate(() => {
      const m = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
      return !!m && !/https?:/.test(m.content) && /connect-src 'none'/.test(m.content);
    }));
    ck('the app still works with the network refused', await p.evaluate(
      () => typeof RC !== 'undefined' && RC.Cube.validate(RC.Cube.solved()).ok)
      && (await p.locator('.lesson-card').count()) === 10);
    await p.close(); }

  // ---- R25-R31: found by playing with the app the way a curious 12-year-old would ----
  // Every sticker of the Play cube, by index, for a cube of any size.
  const stickersOf = (p, sel) => p.evaluate((s) => {
    const out = [];
    document.querySelectorAll(s + ' .face:not(.inner)').forEach((f) => { out[+f.dataset.index] = f.className.match(/c-(\w)/)[1]; });
    return out.join('');
  }, sel);
  const expectAfter = (p, n, moves) => p.evaluate(([N, ms]) => {
    const M = RC.NCube.make(N);
    return M.applyAlg(M.solved(), ms).join('');
  }, [n, moves]);

  console.log('R25 Undo takes back your own turns, never the mix');
  { const p = await newPage();
    await p.locator('nav button[data-screen="play"]').click();
    await p.locator('#play-scramble').click();
    await p.waitForFunction(() => /Go!/.test(document.querySelector('#play-status').textContent), null, { timeout: 10000 });
    const mixed = await settle(p, '#play-cube');
    await p.keyboard.press('r');
    await settle(p, '#play-cube');
    await p.locator('#play-undo').click();
    ck('one Undo takes back the one turn', (await settle(p, '#play-cube')) === mixed);
    // the trick that used to work: twenty more Undos walked the mix back to solved
    for (let i = 0; i < 20; i++) { await p.locator('#play-undo').click(); await p.waitForTimeout(30); }
    ck('twenty more Undos leave the cube mixed', (await settle(p, '#play-cube')) === mixed);
    await p.waitForTimeout(300);
    const status = (await p.locator('#play-status').textContent()).trim();
    ck('no fake "Solved" and no confetti', !/Solved in/.test(status) && (await p.locator('.confetti').count()) === 0, status);
    ck('it says why', /not the mix/.test(status));
    // pressing Undo while the cube is still mixing does nothing either
    await p.locator('#play-scramble').click();
    await p.waitForTimeout(500);
    for (let i = 0; i < 5; i++) await p.locator('#play-undo').click();
    await p.waitForFunction(() => /Go!/.test(document.querySelector('#play-status').textContent), null, { timeout: 10000 });
    const after = await settle(p, '#play-cube');
    await p.keyboard.press('r'); await settle(p, '#play-cube');
    for (let i = 0; i < 21; i++) { await p.locator('#play-undo').click(); await p.waitForTimeout(30); }
    ck('Undo during the mix cannot shorten it', (await settle(p, '#play-cube')) === after);
    await p.close(); }

  console.log('R26 holding a key down turns the cube once, not once per repeat');
  { const p = await newPage();
    await p.locator('nav button[data-screen="play"]').click();
    await p.waitForTimeout(200);
    // what a held key sends: one press, then a stream of auto-repeats
    for (let i = 0; i < 30; i++) {
      await p.evaluate((rep) => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', repeat: rep, bubbles: true })), i > 0);
      await p.waitForTimeout(20);
    }
    const t0 = Date.now();
    const shown = await settle(p, '#play-cube');
    const tail = Date.now() - t0;
    ck('the cube stops when the key comes up', tail < 1500, tail + 'ms');
    ck('and turned exactly once', shown === await expectAfter(p, 3, 'R'));
    await p.close(); }

  console.log('R27 a spun picture swings back before a turn, so R is on the right');
  { const p = await newPage();
    await p.locator('nav button[data-screen="play"]').click();
    await p.waitForTimeout(200);
    const cube = () => p.evaluate(() => document.querySelector('#play-cube .cube').style.transform);
    const box = await (await p.$('#play-cube')).boundingBox();
    const drag = async (px) => {
      const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
      await p.mouse.move(cx - px / 2, cy); await p.mouse.down();
      await p.mouse.move(cx + px / 2, cy, { steps: 12 }); await p.mouse.up();
      await p.waitForTimeout(150);
    };
    const usual = await cube();
    await drag(360);                                   // half way round: R is now on the left
    ck('a big drag turns the picture round', (await cube()) !== usual, await cube());
    await p.keyboard.press('r');
    await settle(p, '#play-cube'); await p.waitForTimeout(350);
    ck('a key turn swings it back first', (await cube()) === usual, await cube());
    ck('and the turn is still R', (await stickersOf(p, '#play-cube')) === await expectAfter(p, 3, 'R'));
    await drag(360);
    await p.locator('#play-controls .pad-btn', { hasText: /^U$/ }).click();
    await settle(p, '#play-cube'); await p.waitForTimeout(350);
    ck('so does a button', (await cube()) === usual);
    await drag(50);                                    // a peek round the side is left alone
    const peek = await cube();
    await p.keyboard.press('r');
    await settle(p, '#play-cube'); await p.waitForTimeout(350);
    ck('a small look-around is not undone', (await cube()) === peek && peek !== usual, peek);
    await p.close(); }

  console.log('R28 a trick card\'s Watch finishing the practice is help, not a 🧠');
  { // Practice cubes are random; seed them so both runs get the same cube.
    const seeded = async () => {
      const p = await b.newPage({ viewport: { width: 1280, height: 950 } });
      p.on('pageerror', (e) => errs.push(e.message));
      await p.addInitScript(() => {
        let x = 20260923;
        Math.random = () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
      });
      await p.goto(URL);
      await p.evaluate(() => localStorage.clear());
      await p.reload(); await p.waitForTimeout(300);
      await p.locator('.lesson-card', { hasText: 'The Yellow Cross' }).click();
      await p.waitForTimeout(400);
      return p;
    };
    // The solver's plan for the yellow cross, from the cube on screen.
    const plan = (p) => stickersOf(p, '#lesson-cube').then((st) => p.evaluate((str) => {
      const upTo = RC.Solver.STAGES.indexOf('ycross');
      return RC.Solver.solve(str.split('')).steps
        .filter((x) => RC.Solver.STAGES.indexOf(x.stage) <= upTo).map((x) => x.moves.slice());
    }, st));
    const type = async (p, moves) => {
      for (const m of moves) {
        const key = m[0].toLowerCase();
        const times = m.endsWith('2') ? 2 : 1;
        for (let t = 0; t < times; t++) await p.keyboard.press(m.endsWith("'") ? 'Shift+' + key.toUpperCase() : key);
      }
      await settle(p, '#lesson-cube'); await p.waitForTimeout(80);
    };
    const statusOf = async (p) => (await p.locator('#lesson-practice .practice-status').textContent()).trim();
    const trick = "F R U R' U' F'";

    const p = await seeded();
    const steps = await plan(p);
    const last = steps[steps.length - 1];
    ck('the plan ends with the Cross trick', last.join(' ') === trick, last.join(' '));
    // the child does everything else, then lets the trick card make the last turns
    for (const st of steps.slice(0, -1)) await type(p, st);
    await p.locator('#lesson-algs .alg-card .btn', { hasText: 'Watch' }).first().click();
    await settle(p, '#lesson-cube'); await p.waitForTimeout(300);
    const status = await statusOf(p);
    ck('Watch making the last turns still finishes it', /You did it/.test(status), status);
    ck('but it earns no 🧠', !/No hints/.test(status));
    ck('and says so kindly', /Watch button did the last turns/.test(status));
    ck('no brain badge is stored', await p.evaluate(() => !(JSON.parse(localStorage.getItem('cubeclubhouse.progress') || '{}').brain || {}).ycross));
    await p.close();

    // the same cube, the same turns, all typed by the child: that is a real 🧠
    const q = await seeded();
    for (const st of await plan(q)) await type(q, st);
    await q.waitForTimeout(300);
    ck('the same turns done by hand earn the 🧠', /No hints/.test(await statusOf(q)), await statusOf(q));
    // watching the trick and taking it back first does not cost the badge
    const r = await seeded();
    await r.locator('#lesson-algs .alg-card .btn', { hasText: 'Watch' }).first().click();
    await settle(r, '#lesson-cube');
    await r.locator('#lesson-algs .alg-card .btn', { hasText: 'Undo' }).first().click();
    await settle(r, '#lesson-cube');
    for (const st of await plan(r)) await type(r, st);
    await r.waitForTimeout(300);
    ck('watching the trick first, then doing it, still earns the 🧠', /No hints/.test(await statusOf(r)), await statusOf(r));
    await q.close(); await r.close(); }

  console.log('R29 swapping size with a mixed cube takes a second tap');
  { const p = await newPage();
    await p.locator('nav button[data-screen="play"]').click();
    await p.locator('#play-scramble').click();
    await p.waitForFunction(() => /Go!/.test(document.querySelector('#play-status').textContent), null, { timeout: 10000 });
    const mixed = await settle(p, '#play-cube');
    const four = p.locator('#play-size .size-btn', { hasText: '4×4' });
    await four.click(); await p.waitForTimeout(200);
    ck('the first tap keeps the mixed cube', (await stickersOf(p, '#play-cube')) === mixed);
    ck('and says what a second tap will do', /Tap 4×4 again/.test(await p.locator('#play-size-note').textContent()));
    ck('the tapped size is marked', await four.evaluate((x) => x.classList.contains('confirm')));
    await four.click(); await p.waitForTimeout(300);
    ck('the second tap swaps', (await stickersOf(p, '#play-cube')).length === 96);
    // a solved cube has nothing to lose, so one tap is enough
    await p.locator('#play-size .size-btn', { hasText: '2×2' }).click(); await p.waitForTimeout(300);
    ck('a solved cube swaps on one tap', (await stickersOf(p, '#play-cube')).length === 24);
    await p.close(); }

  console.log('R30 the keyboard reaches every layer, and turns the whole cube');
  { const p = await newPage();
    await p.locator('nav button[data-screen="play"]').click();
    await p.locator('#play-size .size-btn', { hasText: '4×4' }).click();
    await p.waitForTimeout(300);
    ck('the pad says how', /type its number first/.test(await p.locator('#play-controls .pad-hint').textContent())
      && /X, Y or Z/.test(await p.locator('#play-controls .pad-hint').textContent()));
    await p.keyboard.press('2'); await p.keyboard.press('r');
    await settle(p, '#play-cube');
    ck('2 then R turns the 2nd layer in', (await stickersOf(p, '#play-cube')) === await expectAfter(p, 4, '2R'));
    await p.keyboard.press('x'); await settle(p, '#play-cube');
    await p.keyboard.press('Shift+Z'); await settle(p, '#play-cube');
    ck('X and Shift+Z turn the whole cube', (await stickersOf(p, '#play-cube')) === await expectAfter(p, 4, "2R x z'"));
    await p.keyboard.press('3'); await p.keyboard.press('Shift+U'); await settle(p, '#play-cube');
    ck('3 then Shift+U turns the 3rd layer back', (await stickersOf(p, '#play-cube')) === await expectAfter(p, 4, "2R x z' 3U'"));
    await p.keyboard.press('r'); await settle(p, '#play-cube');
    ck('the number only counts for the next turn', (await stickersOf(p, '#play-cube')) === await expectAfter(p, 4, "2R x z' 3U' R"));
    await p.keyboard.press('7'); await p.keyboard.press('r'); await settle(p, '#play-cube');
    ck('a layer the cube has not got is ignored', (await stickersOf(p, '#play-cube')) === await expectAfter(p, 4, "2R x z' 3U' R"));
    await p.close(); }

  console.log('R31 Clear my colours really clears');
  { const p = await newPage();
    await p.locator('nav button[data-screen="solve"]').click();
    await p.locator('#solve-random').click(); await p.waitForTimeout(300);
    await p.locator('#solve-clear').click(); await p.waitForTimeout(300);
    const cells = await p.evaluate(() => [...document.querySelectorAll('#solve-net .net-cell')].map((c) => ({ centre: c.classList.contains('centre'), grey: c.classList.contains('c-X') })));
    ck('every sticker but the centres goes grey', cells.filter((c) => c.grey).length === 48 && cells.filter((c) => c.centre && !c.grey).length === 6);
    ck('the 3D cube shows the grey too', (await p.locator('#solve-cube .face.c-X').count()) === 48);
    ck('and it says what to do next', /paint every grey sticker/.test(await p.locator('#solve-msg').textContent()));
    await p.locator('#solve-check').click(); await p.waitForTimeout(200);
    const said = (await p.locator('#solve-msg').textContent()).trim();
    ck('Check asks for the grey stickers first', /48 stickers are still grey/.test(said), said);
    ck('and does not call it a real cube', !/real cube/.test(said) && (await p.locator('#solve-guide').evaluate((e) => e.childElementCount)) === 0);
    await p.locator('.swatch.c-W').click();
    await p.locator('#solve-net .net-cell.c-X').first().click();
    await p.locator('#solve-check').click(); await p.waitForTimeout(200);
    ck('painting one counts down', /47 stickers are still grey/.test(await p.locator('#solve-msg').textContent()));
    await p.close(); }

  // ---- R32-R36: the speed timer ----
  const TKEY = 'cubeclubhouse.timer';
  const timerPage = async (seed) => {
    const p = await newPage();
    await p.evaluate(([k, v]) => { localStorage.clear(); if (v) localStorage.setItem(k, JSON.stringify(v)); }, [TKEY, seed || null]);
    await p.reload(); await p.waitForTimeout(250);
    await p.locator('nav button[data-screen="timer"]').click();
    await p.waitForTimeout(150);
    // Fast-forward the clock without waiting: the page reads performance.now().
    await p.evaluate(() => { const real = performance.now.bind(performance); let off = 0; performance.now = () => real() + off; window.__skip = (ms) => { off += ms; }; });
    return p;
  };
  const phase = (p) => p.locator('#timer-pad').getAttribute('data-phase');
  const times = (p) => p.$$eval('#timer-list li:not(.timer-empty):not(.timer-more) .timer-t', (l) => l.map((x) => x.textContent.trim()));
  const stat = (p, label) => p.evaluate((l) => [...document.querySelectorAll('#timer-stats .stat')]
    .find((t) => t.querySelector('.stat-label').textContent === l).querySelector('.stat-value').textContent, label);
  // hold the space bar until ready, let go, "solve" for ms, then stop with a key
  const spaceSolve = async (p, ms, stopKey = ' ') => {
    await p.keyboard.down(' '); await p.waitForTimeout(380);
    await p.keyboard.up(' ');
    await p.evaluate((t) => window.__skip(t), ms);
    await p.waitForTimeout(60);
    await p.keyboard.down(stopKey); await p.keyboard.up(stopKey);
    await p.waitForTimeout(120);
  };

  console.log('R32 the speed timer: hold, let go, stop');
  { const p = await timerPage();
    ck('it starts empty', (await times(p)).length === 0 && /No times yet for the 3×3/.test(await p.locator('#timer-list').textContent()));
    ck('a 3x3 mix is 25 turns', (await p.locator('#timer-scramble').textContent()).trim().split(/\s+/).length === 25);
    // let go too soon and nothing starts
    await p.keyboard.down(' '); await p.waitForTimeout(80);
    ck('holding turns the pad amber first', (await phase(p)) === 'holding');
    await p.keyboard.up(' '); await p.waitForTimeout(60);
    ck('letting go too soon does not start the clock', (await phase(p)) === 'idle');
    await p.keyboard.down(' '); await p.waitForTimeout(380);
    ck('after a moment it is ready (green)', (await phase(p)) === 'ready');
    await p.keyboard.up(' '); await p.waitForTimeout(60);
    ck('letting go starts it', (await phase(p)) === 'running');
    ck('the size buttons are held while it runs', await p.locator('#timer-size .size-btn').first().isDisabled());
    await p.evaluate(() => window.__skip(12340));
    await p.waitForTimeout(80);
    ck('it counts in hundredths as it runs', /^1[23]\.\d\d$/.test((await p.locator('#timer-display').textContent()).trim()), await p.locator('#timer-display').textContent());
    const mixBefore = await p.locator('#timer-scramble').textContent();
    await p.keyboard.down('a'); await p.keyboard.up('a');           // any key stops it
    await p.waitForTimeout(120);
    const t = await times(p);
    ck('any key stops it, and the time is kept', t.length === 1 && /^12\.\d\d$/.test(t[0]), t.join(','));
    ck('the first time is welcomed', /first time on the board/.test(await p.locator('#timer-said').textContent()));
    ck('and a fresh mix is ready for the next go', (await p.locator('#timer-scramble').textContent()) !== mixBefore);
    // the space bar belongs to the timer: it never presses a focused button
    await p.locator('#timer-new-mix').focus();
    const mix = await p.locator('#timer-scramble').textContent();
    await p.keyboard.down(' '); await p.waitForTimeout(60); await p.keyboard.up(' ');
    await p.waitForTimeout(100);
    ck('space never presses the focused button', (await p.locator('#timer-scramble').textContent()) === mix);
    // and it stops on a touch anywhere, too
    await p.keyboard.down(' '); await p.waitForTimeout(380); await p.keyboard.up(' ');
    await p.evaluate(() => window.__skip(8000));
    await p.mouse.click(5, 400);
    await p.waitForTimeout(120);
    ck('a tap anywhere stops it', (await times(p)).length === 2 && (await phase(p)) === 'idle');
    await p.close(); }

  console.log('R33 best times and averages, per size, kept after a reload');
  { const seed = { size: 3, inspect: false, solves: { 3: [10000, 12000, 11000, 9000, 13000].map((ms) => ({ ms, pen: 0 })) } };
    const p = await timerPage(seed);
    ck('best time', (await stat(p, 'Best time')) === '9.00');
    ck('best average of 5', (await stat(p, 'Best average of 5')) === '11.00');
    ck('average of last 5', (await stat(p, 'Average of last 5')) === '11.00');
    ck('average of last 12 waits for 12 solves', (await stat(p, 'Average of last 12')) === '–');
    ck('the best is starred in the list', /9\.00\s*⭐/.test(await p.locator('#timer-list').textContent())
      && (await p.locator('#timer-list li.best .timer-star').getAttribute('aria-label')) === 'your best');
    // beat it
    await spaceSolve(p, 7500);
    const said = await p.locator('#timer-said').textContent();
    ck('a faster solve is a new best, and says the old one', /New best time! Your old best was 9\.00/.test(said), said);
    ck('with confetti', (await p.locator('.confetti').count()) === 1);
    ck('the tiles follow', /^7\.\d\d$/.test(await stat(p, 'Best time')) && (await stat(p, 'Solves')) === '6');
    // every size keeps its own
    await p.locator('#timer-size .size-btn', { hasText: '2×2' }).click(); await p.waitForTimeout(150);
    ck('a 2x2 has its own (empty) list', (await times(p)).length === 0 && (await stat(p, 'Best time')) === '–');
    ck('and an 11-turn mix', (await p.locator('#timer-scramble').textContent()).trim().split(/\s+/).length === 11);
    await p.locator('#timer-size .size-btn', { hasText: '6×6' }).click(); await p.waitForTimeout(150);
    const six = (await p.locator('#timer-scramble').textContent()).trim().split(/\s+/);
    ck('a 6x6 mix is 80 turns, inner layers included', six.length === 80 && six.some((m) => /^[23]/.test(m)));
    await p.locator('#timer-size .size-btn', { hasText: '3×3' }).click(); await p.waitForTimeout(150);
    await p.reload(); await p.waitForTimeout(250);
    await p.locator('nav button[data-screen="timer"]').click(); await p.waitForTimeout(150);
    ck('everything is still there after a reload', (await times(p)).length === 6 && (await p.locator('#timer-size .size-btn.active').textContent()) === '3×3');
    await p.close(); }

  console.log('R34 +2, DNF and delete, and the 15 seconds to look');
  { const p = await timerPage();
    await spaceSolve(p, 10000);
    await p.locator('#timer-plus2').click();
    ck('+2 adds two seconds', /^12\.\d\d \(\+2\)$/.test((await times(p))[0]) && (await p.locator('#timer-plus2').getAttribute('aria-pressed')) === 'true');
    await p.locator('#timer-dnf').click();
    ck('DNF replaces it', /^DNF \(10\.\d\d\)$/.test((await times(p))[0]) && (await p.locator('#timer-plus2').getAttribute('aria-pressed')) === 'false');
    ck('a DNF is never the best time', (await stat(p, 'Best time')) === '–');
    await p.locator('#timer-dnf').click();
    ck('tapping DNF again takes it off', /^10\.\d\d$/.test((await times(p))[0]));
    await p.locator('#timer-delete').click();
    ck('delete asks for a second tap', (await times(p)).length === 1 && /Tap again/.test(await p.locator('#timer-delete').textContent()));
    await p.locator('#timer-delete').click();
    ck('the second tap deletes it', (await times(p)).length === 0);

    // inspection: a tap starts 15 seconds of looking, counted down
    await p.locator('#timer-inspect').click();
    ck('inspection can be switched on', (await p.locator('#timer-inspect').getAttribute('aria-pressed')) === 'true');
    await p.keyboard.down(' '); await p.keyboard.up(' '); await p.waitForTimeout(100);
    ck('a tap starts the looking time', (await phase(p)) === 'inspecting' && (await p.locator('#timer-display').textContent()) === '15');
    await p.evaluate(() => window.__skip(5200)); await p.waitForTimeout(100);
    ck('it counts down', (await p.locator('#timer-display').textContent()) === '10');
    await spaceSolve(p, 9000);
    ck('starting within 15 seconds costs nothing', /^9\.\d\d$/.test((await times(p))[0]));
    await p.keyboard.down(' '); await p.keyboard.up(' '); await p.waitForTimeout(60);
    await p.evaluate(() => window.__skip(15800)); await p.waitForTimeout(100);
    ck('after 15 seconds it shows +2', (await p.locator('#timer-display').textContent()) === '+2');
    await spaceSolve(p, 9000);
    ck('and the solve gets the +2', /\(\+2\)$/.test((await times(p))[0]) && /2 seconds were added/.test(await p.locator('#timer-said').textContent()));
    await p.keyboard.down(' '); await p.keyboard.up(' '); await p.waitForTimeout(60);
    await p.evaluate(() => window.__skip(17600)); await p.waitForTimeout(100);
    await spaceSolve(p, 9000);
    ck('after 17 seconds the solve is a DNF', /^DNF/.test((await times(p))[0]));
    ck('the setting is remembered', await p.evaluate((k) => JSON.parse(localStorage.getItem(k)).inspect === true, TKEY));
    await p.close(); }

  console.log('R35 a solve cut short is not a time');
  { const p = await timerPage();
    await p.keyboard.down(' '); await p.waitForTimeout(380); await p.keyboard.up(' ');
    await p.evaluate(() => { location.hash = 'learn'; });           // left the screen mid-solve
    await p.waitForTimeout(200);
    await p.locator('nav button[data-screen="timer"]').click(); await p.waitForTimeout(150);
    ck('leaving the screen throws the running solve away', (await times(p)).length === 0 && (await phase(p)) === 'idle');
    await p.keyboard.down(' '); await p.waitForTimeout(380); await p.keyboard.up(' ');
    await p.keyboard.press('Escape');
    ck('Escape does not throw it away; it stops it, like any key', (await times(p)).length === 1);
    await p.locator('#timer-inspect').click();
    await p.keyboard.down(' '); await p.keyboard.up(' '); await p.waitForTimeout(60);
    await p.keyboard.press('Escape'); await p.waitForTimeout(60);
    ck('Escape cancels the looking time', (await phase(p)) === 'idle' && (await times(p)).length === 1);
    await p.close(); }

  console.log('R36 the grown-ups pages know about the times');
  { const seed = { size: 3, inspect: false, solves: { 3: [{ ms: 9000, pen: 0 }] } };
    const p = await timerPage(seed);
    await p.locator('.foot-links [data-info="privacy"]').click(); await p.waitForTimeout(200);
    ck('privacy lists the times', /times from the Timer screen/.test(await p.locator('#privacy').textContent()));
    ck('for parents describes the Timer', /speedcubing timer/.test(await p.locator('#parents').textContent()));
    await p.locator('#clear-progress').click(); await p.locator('#clear-progress').click();
    await p.waitForTimeout(150);
    ck('Clear saved progress erases the times', await p.evaluate((k) => localStorage.getItem(k) === null, TKEY));
    // opening the Timer on a fresh device leaves storage alone until the child does something
    await p.locator('nav button[data-screen="timer"]').click(); await p.waitForTimeout(150);
    ck('just opening the Timer stores nothing', await p.evaluate((k) => localStorage.getItem(k) === null, TKEY));
    await p.locator('nav button[data-screen="timer"]').click(); await p.waitForTimeout(150);
    ck('and the Timer shows none straight away', (await times(p)).length === 0);
    // a damaged entry cannot break the page
    await p.evaluate((k) => localStorage.setItem(k, '{"size":9,"solves":{"3":[{"ms":"x"},{"ms":5000,"pen":0},null]}}'), TKEY);
    await p.reload(); await p.waitForTimeout(250);
    await p.locator('nav button[data-screen="timer"]').click(); await p.waitForTimeout(150);
    ck('bad saved data is skipped, good data kept', (await times(p)).length === 1 && (await p.locator('#timer-size .size-btn.active').textContent()) === '3×3');
    await p.close(); }

  console.log('R37 Cube Clubhouse® carries its registered-trademark sign');
  { const p = await newPage();
    const brand = await p.locator('.topbar .brand').textContent();
    ck('the header brand, on every screen', /Cube Clubhouse®/.test(brand) && (await p.locator('.topbar .brand sup.reg').count()) === 1);
    ck('the footer, with the notice', /Cube Clubhouse® ·/.test(await p.locator('footer').textContent())
      && /Cube Clubhouse® is a registered trademark of Ira Learning LLC/.test(await p.locator('.foot-copy').textContent()));
    await p.locator('.foot-links [data-info="licence"]').click(); await p.waitForTimeout(200);
    ck('the first mention on the grown-ups pages', /know about Cube Clubhouse®/.test(await p.locator('.info-lede').textContent()));
    ck('the licence opens with it', /^\s*CUBE CLUBHOUSE END USER LICENCE AGREEMENT[\s\S]*?Cube Clubhouse\(R\) is provided/.test(await p.locator('.licence-text').textContent()));
    ck('the trademark note says who owns it', /Cube Clubhouse® is a registered trademark of Ira Learning LLC/.test(await p.locator('#licence').textContent()));
    ck('the sign does not push the header taller', await p.evaluate(() => {
      const b = document.querySelector('.topbar .brand');
      return b.getBoundingClientRect().height <= 44;
    }));
    // names that a device shows on its own stay plain: a tab title, a home-screen label
    ck('the page title stays plain', (await p.title()) === 'Cube Clubhouse');
    await p.close(); }

  // ---- R38-R41: the Timer grows up ----
  const mixOf = (p) => p.$$eval('#timer-scramble .mix-turn', (b) => b.map((x) => x.textContent));
  const cubeAfter = (p, n, moves) => p.evaluate(([N, ms]) => { const M = RC.NCube.make(N); return M.applyAlg(M.solved(), ms).join(''); }, [n, moves]);
  const solvedPicture = (p, n) => p.evaluate((N) => {
    const by = {};
    document.querySelectorAll('#timer-cube .face:not(.inner)').forEach((f) => { const i = +f.dataset.index; (by[(i / (N * N)) | 0] ||= new Set()).add(f.className.match(/c-\w/)[0]); });
    return Object.values(by).every((x) => x.size === 1);
  }, n);

  console.log('R38 Help me solve this mix');
  { const p = await timerPage();
    await p.locator('#timer-solve-help').click();
    await p.waitForSelector('#timer-guide .guide-count', { timeout: 60000 });
    ck('it opens the guided steps for this very mix', /step 1 of/.test(await p.locator('#timer-guide .guide-count').textContent()));
    ck('the steps start from the whole mix, so every turn is ticked', (await p.locator('#timer-scramble .mix-turn.done').count()) === 25);
    ck('the picture shows the mixed cube', (await stickersOf(p, '#timer-cube')) === await cubeAfter(p, 3, (await mixOf(p)).join(' ')));
    const note = await p.locator('#timer-guide-note').textContent();
    ck('it says the steps are for a cube mixed exactly so', /exactly the turns above/.test(note));
    ck('and offers My real cube for one turned since', (await p.locator('#timer-guide-note .btn', { hasText: 'My real cube' }).count()) === 1);
    await p.locator('#play-guide, #timer-guide').locator('.speed-btn', { hasText: 'Fast' }).click().catch(() => {});
    await p.locator('#timer-guide .btn', { hasText: 'Watch the whole solve' }).click();
    await p.waitForSelector('#timer-guide .guide-done', { timeout: 120000 });
    await settle(p, '#timer-cube');
    ck('watching the whole solve ends on a solved cube', await solvedPicture(p, 3));
    // ticking a turn, a new mix, or starting the clock all put the steps away
    await p.locator('#timer-scramble .mix-turn').first().click(); await p.waitForTimeout(150);
    ck('tapping a turn closes the steps', (await p.locator('#timer-guide').evaluate((e) => e.childElementCount)) === 0 && await p.locator('#timer-guide-note').isHidden());
    await p.locator('#timer-solve-help').click();
    await p.waitForSelector('#timer-guide .guide-count', { timeout: 60000 });
    await p.keyboard.down(' '); await p.waitForTimeout(380); await p.keyboard.up(' ');
    ck('starting the clock closes them: a timed solve is your own', (await p.locator('#timer-guide').evaluate((e) => e.childElementCount)) === 0);
    await p.keyboard.press('a'); await p.waitForTimeout(150);
    // big cubes too
    await p.locator('#timer-size .size-btn', { hasText: '5×5' }).click(); await p.waitForTimeout(200);
    await p.locator('#timer-solve-help').click();
    ck('a 5x5 holds the controls while it thinks', await p.locator('#timer-new-mix').isDisabled());
    await p.waitForSelector('#timer-guide .guide-count', { timeout: 120000 });
    const chips = await p.locator('#timer-guide .stage-chip').allTextContents();
    ck('a 5x5 gets centres, edges and the 3x3 stages', chips.includes('Centres') && chips.includes('Pair the edges'), chips.slice(0, 4).join(','));
    ck('and gives the controls back', !(await p.locator('#timer-new-mix').isDisabled()));
    ck('the note sends a 5x5 back to its mix, not to My real cube', (await p.locator('#timer-guide-note .btn').count()) === 0);
    await p.locator('#timer-new-mix').click(); await p.waitForTimeout(150);
    ck('New mix closes the steps', (await p.locator('#timer-guide').evaluate((e) => e.childElementCount)) === 0);
    await p.locator('#timer-size .size-btn', { hasText: '3×3' }).click(); await p.waitForTimeout(150);
    await p.locator('#timer-solve-help').click();
    await p.waitForSelector('#timer-guide .guide-count', { timeout: 60000 });
    await p.locator('#timer-guide-note .btn', { hasText: 'My real cube' }).click(); await p.waitForTimeout(150);
    ck('the My real cube button goes there', !(await p.locator('#screen-solve').isHidden()));
    await p.close(); }

  console.log('R39 tick off the mix as you go');
  { const p = await timerPage();
    const mix = await mixOf(p);
    ck('every turn is a button', mix.length === 25 && /Tap each turn/.test(await p.locator('#timer-mix-progress').textContent()));
    const tap = async (i) => { await p.locator('#timer-scramble .mix-turn').nth(i).click(); await settle(p, '#timer-cube'); };
    await tap(0);
    ck('one tap: 1 of 25, and the picture makes that turn', /1 of 25/.test(await p.locator('#timer-mix-progress').textContent())
      && (await stickersOf(p, '#timer-cube')) === await cubeAfter(p, 3, mix.slice(0, 1).join(' ')));
    await tap(4);
    ck('tapping further on ticks everything up to it', /5 of 25/.test(await p.locator('#timer-mix-progress').textContent())
      && (await p.locator('#timer-scramble .mix-turn.done').count()) === 5
      && (await stickersOf(p, '#timer-cube')) === await cubeAfter(p, 3, mix.slice(0, 5).join(' ')));
    ck('the next turn is marked', (await p.locator('#timer-scramble .mix-turn').nth(5).getAttribute('class')).includes('next'));
    ck('done turns say so to a screen reader', (await p.locator('#timer-scramble .mix-turn').nth(0).getAttribute('aria-pressed')) === 'true');
    await tap(2);
    ck('tapping a done turn steps back to just before it', /2 of 25/.test(await p.locator('#timer-mix-progress').textContent())
      && (await stickersOf(p, '#timer-cube')) === await cubeAfter(p, 3, mix.slice(0, 2).join(' ')));
    ck('the words under the picture follow', /after 2 of 25 turns/.test(await p.locator('#timer-check').textContent()));
    await tap(24);
    ck('the last turn: all done, time to solve', /All 25 turns done/.test(await p.locator('#timer-mix-progress').textContent())
      && (await stickersOf(p, '#timer-cube')) === await cubeAfter(p, 3, mix.join(' ')));
    await p.keyboard.down(' '); await p.waitForTimeout(380); await p.keyboard.up(' ');
    ck('turns cannot be ticked while the clock runs', await p.locator('#timer-scramble .mix-turn').first().isDisabled());
    await p.keyboard.press('a'); await p.waitForTimeout(150);
    ck('a solve brings a fresh mix with nothing ticked', (await p.locator('#timer-scramble .mix-turn.done').count()) === 0);
    await p.close(); }

  console.log('R40 inspection calls out 8 and 12 seconds');
  { const p = await b.newPage({ viewport: { width: 1280, height: 950 } });
    p.on('pageerror', (e) => errs.push(e.message));
    await p.addInitScript(() => {
      const log = { spoken: [], cancels: 0 };
      window.__speech = log;
      Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, value: function (text) { this.text = text; } });
      Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: { speak(u) { log.spoken.push(u.text); }, cancel() { log.cancels++; }, getVoices: () => [] } });
    });
    await p.goto(URL);
    await p.evaluate((k) => localStorage.setItem(k, JSON.stringify({ size: 3, inspect: true, solves: {} })), TKEY);
    await p.reload(); await p.waitForTimeout(250);
    await p.locator('nav button[data-screen="timer"]').click(); await p.waitForTimeout(150);
    await p.evaluate(() => { const real = performance.now.bind(performance); let off = 0; performance.now = () => real() + off; window.__skip = (ms) => { off += ms; }; });
    const said = () => p.evaluate(() => window.__speech.spoken.slice());
    await p.keyboard.down(' '); await p.keyboard.up(' '); await p.waitForTimeout(100);
    ck('nothing is said at the start', (await said()).length === 0);
    await p.evaluate(() => window.__skip(8100)); await p.waitForTimeout(150);
    ck('"Eight seconds" at 8 seconds', (await said()).join('|') === 'Eight seconds');
    await p.evaluate(() => window.__skip(4000)); await p.waitForTimeout(150);
    ck('"Twelve seconds" at 12', (await said()).join('|') === 'Eight seconds|Twelve seconds');
    await p.waitForTimeout(300);
    ck('each is said once', (await said()).length === 2);
    await spaceSolve(p, 5000);
    ck('and never during the solve', (await said()).length === 2);
    await p.close(); }

  console.log('R41 a chart of your times');
  { const t = [31200, 28400, 29900, 25100, 26800, 24300, 27700, 22900, 23500, 21800, 24900, 20400, 22100, 19800, 21200, 23800, 18900, 20600, 19500, 20100];
    const seed = { size: 3, inspect: false, solves: { 3: t.map((ms, i) => ({ ms, pen: i === 6 ? 'DNF' : 0 })) } };
    const p = await timerPage(seed);
    ck('it is drawn', (await p.locator('#timer-chart svg.chart').count()) === 1);
    ck('its title counts the solves', (await p.locator('.chart-title').textContent()) === 'Your 20 solves so far');
    ck('and says a DNF is left out', /DNF has no time/.test(await p.locator('.chart-sub').textContent()));
    const d = await p.locator('.chart-line').getAttribute('d');
    ck('one point per timed solve', (d.match(/[ML]/g) || []).length === 19);
    const labels = await p.locator('.chart-label').allTextContents();
    ck('the best and the latest are labelled, nothing else', labels.length === 2 && labels[0] === '⭐ 18.90' && labels[1] === '20.10', labels.join(' / '));
    ck('the axis reads in round seconds', (await p.locator('.chart-axis').allTextContents()).slice(0, 3).join(',') === '15,20,25');
    const box = await p.locator('#timer-chart svg').boundingBox();
    await p.mouse.move(box.x + box.width * 0.45, box.y + box.height / 2); await p.waitForTimeout(100);
    const tip = await p.locator('.chart-tip').textContent();
    ck('touching the line reads a time', await p.locator('.chart-tip').isVisible() && /^\d+\.\d\dsolve \d+/.test(tip), tip);
    await p.mouse.move(5, 5); await p.waitForTimeout(80);             // the mouse moves off the chart
    ck('the readout goes when the mouse leaves', await p.locator('.chart-tip').isHidden());
    await p.locator('#timer-chart svg').focus();
    ck('the keyboard reads the latest first', /^20\.10solve 20/.test(await p.locator('.chart-tip').textContent()));
    await p.keyboard.press('ArrowLeft'); await p.keyboard.press('ArrowLeft'); await p.keyboard.press('ArrowLeft');
    ck('and the arrows step back, to the best three solves ago', /^18\.90solve 17 · your best/.test(await p.locator('.chart-tip').textContent()), await p.locator('.chart-tip').textContent());
    // the list is the chart's table: every value can be read without touching the line
    ck('the list shows the last 12', (await times(p)).length === 12 && /Show all 20 times/.test(await p.locator('#timer-show-all').textContent()));
    await p.locator('#timer-show-all').click();
    ck('Show all lists every time', (await times(p)).length === 20 && (await p.locator('#timer-show-all').getAttribute('aria-expanded')) === 'true');
    await p.locator('#timer-show-all').click();
    ck('and folds back', (await times(p)).length === 12);
    // it redraws for the space it has, and for dark mode
    const wide = (await p.locator('#timer-chart svg').boundingBox()).width;
    await p.setViewportSize({ width: 700, height: 950 }); await p.waitForTimeout(250);
    ck('it redraws to fit a narrower screen', (await p.locator('#timer-chart svg').boundingBox()).width < wide);
    await p.emulateMedia({ colorScheme: 'dark' }); await p.waitForTimeout(100);
    ck('dark mode draws the line in its own blue', (await p.locator('.chart-line').evaluate((e) => getComputedStyle(e).stroke)) === 'rgb(90, 146, 224)');
    await p.close();
    const q = await timerPage({ size: 3, inspect: false, solves: { 3: [{ ms: 20000, pen: 0 }] } });
    ck('one time is not a chart yet', (await q.locator('#timer-chart svg').count()) === 0 && /after two times/.test(await q.locator('#timer-chart').textContent()));
    await q.close();
    const many = Array.from({ length: 60 }, (_, i) => ({ ms: 30000 - i * 100, pen: 0 }));
    const r = await timerPage({ size: 3, inspect: false, solves: { 3: many } });
    ck('with more than 50, it shows the last 50', (await r.locator('.chart-title').textContent()) === 'Your last 50 solves'
      && ((await r.locator('.chart-line').getAttribute('d')).match(/[ML]/g) || []).length === 50);
    const one = await r.locator('.chart-label').allTextContents();
    ck('when the latest is the best, it gets one label, at the end of the line', one.length === 1 && one[0] === '⭐ 24.10', one.join(' / '));
    await r.close(); }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  console.log('page errors:', errs.length ? errs : 'none');
  await b.close();
  process.exit(fail || errs.length ? 1 : 0);
})().catch(e => { console.error('REGRESSION HARNESS FAILED', e); process.exit(1); });
