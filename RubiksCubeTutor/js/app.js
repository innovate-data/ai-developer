/*
 * Cube Clubhouse - Copyright (c) 2026 Ira Learning LLC. All rights reserved.
 * Proprietary software. See LICENSE, or the Licence page inside the app.
 */
/*
 * app.js - Cube Clubhouse user interface.
 *
 * Screens:  Learn (lessons + practice)   Play (free play, timer, help)   Solve (paint your cube, guided solve)
 * Shared:   MovePad (buttons for moves)  Guide (step-by-step walkthrough from the solver)
 */
(function (root) {
  'use strict';
  const { Cube, Solver, BigSolver, CubeView, NetView, NCube, LESSONS, MOVE_WORDS, STAGE_TITLES, Timer } = root.RC;
  // The biggest cube knows every move token the app can show, so it does the describing.
  const ANY = NCube.make(NCube.SIZES[NCube.SIZES.length - 1]);

  const $ = (sel, el) => (el || document).querySelector(sel);
  const el = (tag, cls, html) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  };
  const speakable = (text) => text.replace(/\b([UDLRFBxyz])'/g, '$1 prime').replace(/\b([UDLRFBxyz])2\b/g, '$1 two');

  // ---- the platform the app is running on
  // The iOS app tells the page, before anything else runs, that it is the iOS app and
  // whether it is on an iPad or an iPhone (WebAppView.swift). In a browser there is no
  // such note, and the words fall back to the browser's.
  const HOST = root.CubeClubhouseHost || null;
  const IOS_APP = !!HOST && HOST.platform === 'ios';
  const DEVICE = IOS_APP && (HOST.device === 'iPad' || HOST.device === 'iPhone') ? HOST.device : null;
  // "this iPad", "this iPhone", or "this browser"
  const here = () => (DEVICE ? 'this ' + DEVICE : 'this browser');
  // A small tap on the hand, where the device has a haptic engine (iPhone). Anywhere
  // else there is nobody listening, and nothing happens.
  if (IOS_APP) {
    document.documentElement.classList.add('ios-app');
    document.documentElement.dataset.device = DEVICE || '';
    // "this device" in the grown-ups pages becomes "this iPad" or "this iPhone"
    if (DEVICE) document.querySelectorAll('.device-name').forEach((e) => { e.textContent = DEVICE; });
  }
  function haptic(kind) {
    try { root.webkit.messageHandlers.haptic.postMessage(kind); } catch { /* not the iOS app */ }
  }

  // ---- an iOS alert, drawn by the page
  // A question that needs a deliberate answer before something is lost: a title, a line
  // of explanation, Cancel, and the action in red. Cancel is the safe choice, so it has
  // the focus and Escape means Cancel; tapping outside the alert does nothing, as on iOS.
  // Drawn in the page rather than with confirm(), because WKWebView shows no confirm()
  // unless the app implements it, and a browser's confirm() looks nothing like iOS.
  function askFirst({ title, message, action, cancel = 'Cancel' }) {
    return new Promise((answer) => {
      const back = el('div', 'ios-alert-backdrop');
      const box = el('div', 'ios-alert');
      box.setAttribute('role', 'alertdialog');
      box.setAttribute('aria-modal', 'true');
      box.setAttribute('aria-labelledby', 'ios-alert-title');
      box.setAttribute('aria-describedby', 'ios-alert-message');
      const head = el('div', 'ios-alert-text');
      const t = el('h2', 'ios-alert-title'); t.id = 'ios-alert-title'; t.textContent = title;
      const m = el('p', 'ios-alert-message'); m.id = 'ios-alert-message'; m.textContent = message;
      head.append(t, m);
      const row = el('div', 'ios-alert-buttons');
      const no = el('button', 'ios-alert-cancel'); no.type = 'button'; no.textContent = cancel;
      const yes = el('button', 'ios-alert-action'); yes.type = 'button'; yes.textContent = action;
      row.append(no, yes);
      box.append(head, row);
      back.appendChild(box);
      const before = document.activeElement;
      const done = (ok) => {
        document.removeEventListener('keydown', keys, true);
        back.remove();
        if (before && before.focus) { try { before.focus({ preventScroll: true }); } catch { /* gone */ } }
        answer(ok);
      };
      const keys = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); return; }
        if (e.key === 'Tab') {                // keep the focus inside the alert
          e.preventDefault();
          (document.activeElement === no ? yes : no).focus();
          return;
        }
        // nothing behind the alert may hear a key (the timer's space bar, a cube move)
        if (e.key !== 'Enter' && e.key !== ' ') { e.stopPropagation(); e.preventDefault(); }
        else e.stopPropagation();
      };
      no.addEventListener('click', () => done(false));
      yes.addEventListener('click', () => { haptic('warning'); done(true); });
      document.addEventListener('keydown', keys, true);
      document.body.appendChild(back);
      no.focus();
    });
  }
  // One voice at a time, and one place that knows who is speaking. A Read button asks
  // the narrator to speak on its behalf; pressing it again stops it. Whenever the
  // narration ends, is stopped, or is replaced by another one, the button that started
  // it is told, so it can put its own label back.
  const narrator = (function () {
    const ANON = {};                  // speech nobody owns, such as a chip tap
    let owner = null;
    let onStop = null;

    function release() {
      const tell = onStop;
      owner = null;
      onStop = null;
      if (tell) tell();
    }
    function stop() {
      if ('speechSynthesis' in window) speechSynthesis.cancel();
      release();
    }
    function speak(text, who, whenStopped) {
      const holder = who || ANON;
      stop();                         // never two voices at once
      if (!('speechSynthesis' in window)) {
        if (whenStopped) whenStopped();
        return;
      }
      const u = new SpeechSynthesisUtterance(speakable(text));
      u.rate = 0.9;                   // a touch slower for young listeners
      // A cancelled utterance can still fire its end event late, by which time someone
      // else may be speaking, so only the current owner is allowed to release.
      const ended = () => { if (owner === holder) release(); };
      u.onend = ended;
      u.onerror = ended;
      owner = holder;
      onStop = whenStopped || null;
      speechSynthesis.speak(u);
    }
    return { speak, stop, isReading: (who) => owner === who };
  })();
  const speak = (text) => narrator.speak(text);
  const hush = () => narrator.stop();
  // If a step is one trick repeated, say so once ("the Twist trick, 2 times") instead
  // of reading sixteen letters; otherwise say each move in words.
  // A merged guide card is "set-up turns, then one trick N times". Find that shape:
  // up to three leading top-layer or whole-cube turns, then a trick repeated at
  // least twice. Returns null for anything else.
  function repeatedAlg(moves) {
    const isSetup = (m) => /^[Uy]/.test(m);
    for (let lead = 0; lead <= 3 && lead < moves.length; lead++) {
      if (lead > 0 && !isSetup(moves[lead - 1])) break;
      const rest = moves.slice(lead);
      for (const [key, alg] of Object.entries(Solver.ALGS)) {
        const a = Cube.parseAlg(alg);
        if (rest.length >= a.length * 2 && rest.length % a.length === 0) {
          const n = rest.length / a.length;
          if (rest.join(' ') === Array(n).fill(alg).join(' ')) {
            return { key, alg, tokens: a, times: n, setup: moves.slice(0, lead) };
          }
        }
      }
    }
    return null;
  }
  const words = (m) => { if (MOVE_WORDS[m]) return MOVE_WORDS[m]; try { return ANY.describe(m); } catch { return m; } };
  const movesInWords = (moves) => {
    const rep = repeatedAlg(moves);
    if (rep) return rep.setup.map(words).join(' ') + ' Then the trick: ' + rep.alg + '. Do it ' + rep.times + ' times.';
    return moves.slice(0, 10).map(words).join(' ') + (moves.length > 10 ? ' Tap each letter to hear the rest.' : '');
  };
  // Chips for a step: a repeated trick shows once with a "× N" badge a child can count with.
  const stepChips = (moves) => {
    const rep = repeatedAlg(moves);
    if (!rep) return moveChips(moves);
    return moveChips(rep.setup) + (rep.setup.length ? '<span class="then">then</span>' : '') + moveChips(rep.tokens) + '<span class="times">× ' + rep.times + '</span>';
  };
  const wordsList = (moves) => {
    const rep = repeatedAlg(moves);
    const list = rep ? rep.setup.concat(rep.tokens) : moves.slice(0, 12);
    const items = list.map((m) => '<li><b>' + m + '</b> – ' + words(m) + '</li>').join('');
    const more = !rep && moves.length > 12 ? '<li>Tap a letter above to hear it.</li>' : '';
    const count = rep ? '<li>Do the trick <b>' + rep.times + ' times</b>.</li>' : '';
    return '<ul class="guide-words">' + items + count + more + '</ul>';
  };
  // How fast the app shows a move. One step on its own is slower than the same move
  // inside a whole solve: watching one trick is for copying, watching a whole solve is
  // for seeing where it goes. "Steady" is what the app did before there was a choice.
  const SPEED_KEY = 'cubeclubhouse.speed';
  const SPEEDS = [
    { key: 'slow', label: '🐢 Slow', step: 800, run: 450 },
    { key: 'steady', label: '🚶 Steady', step: 380, run: 150 },
    { key: 'fast', label: '🐇 Fast', step: 170, run: 60 },
  ];
  let speedKey = 'steady';
  try { if (SPEEDS.some((x) => x.key === localStorage.getItem(SPEED_KEY))) speedKey = localStorage.getItem(SPEED_KEY); } catch { /* no storage */ }
  const speed = () => SPEEDS.find((x) => x.key === speedKey) || SPEEDS[1];
  function setSpeed(key) {
    speedKey = key;
    try { localStorage.setItem(SPEED_KEY, key); } catch { /* no storage */ }
  }
  // A row of speed buttons. It sets the speed for every guide at once, and a solve
  // already running picks the new speed up on its next move.
  function speedPicker() {
    const row = el('div', 'speed-row');
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', 'How fast to show the moves');
    // The word is hidden on a phone to keep the three buttons on one line, so each
    // button says what it does on its own.
    row.appendChild(el('span', 'speed-label', 'Speed'));
    // an iOS segmented control: one rounded track, the chosen speed raised out of it
    const seg = el('div', 'segmented');
    row.appendChild(seg);
    for (const s of SPEEDS) {
      const b = el('button', 'speed-btn' + (s.key === speedKey ? ' active' : ''), s.label);
      b.type = 'button';
      b.setAttribute('aria-label', 'Show the moves ' + s.key.replace('steady', 'at a steady speed').replace('slow', 'slowly').replace('fast', 'fast'));
      b.setAttribute('aria-pressed', String(s.key === speedKey));
      b.addEventListener('click', () => {
        setSpeed(s.key);
        row.querySelectorAll('.speed-btn').forEach((other, k) => {
          const on = SPEEDS[k].key === speedKey;
          other.classList.toggle('active', on);
          other.setAttribute('aria-pressed', String(on));
        });
      });
      seg.appendChild(b);
    }
    return row;
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // A Read button reads aloud, and says "Stop" while it is reading, so a child can
  // press the same button again to stop it. An empty label makes an icon-only button.
  const readButton = (getText, label, cls) => {
    const icon = label === '';
    const idle = icon ? '🔊' : '🔊 ' + (label || 'Read to Me');
    const busy = icon ? '⏹' : '⏹ Stop';
    const b = el('button', cls || 'btn small ghost', idle);
    b.setAttribute('aria-pressed', 'false');
    b.setAttribute('aria-label', icon ? 'Read aloud' : idle.slice(2).trim());
    const reset = () => {
      b.textContent = idle;
      b.setAttribute('aria-pressed', 'false');
      b.classList.remove('reading');
    };
    b.addEventListener('click', () => {
      if (narrator.isReading(b)) { narrator.stop(); return; }   // a second press stops it
      narrator.speak(getText(), b, reset);
      if (!narrator.isReading(b)) return;    // no voice on this device, or it failed at once
      b.textContent = busy;
      b.setAttribute('aria-pressed', 'true');
      b.classList.add('reading');
    });
    return b;
  };
  // Every move chip is a button: tap it to hear what the move means and watch the cube
  // do it and undo it. A hover tooltip is invisible on an iPad, and to a child who
  // cannot read yet, so the chip has to speak for itself.
  // ANY is the biggest cube, which has no middle slice, so M/E/S would throw here.
  const isRotation = (m) => { try { return ANY.parseMove(m).isRotation; } catch { return false; } };
  const moveChips = (moves) => Cube.parseAlg(moves).map((m) => '<button type="button" class="chip' + (isRotation(m) ? ' rot' : '') + '" data-move="' + m + '" aria-label="' + m + ': ' + words(m) + '">' + m + '</button>').join('');
  const plain = (html) => html.replace(/<[^>]+>/g, '');

  // Wire up chip taps for one screen: show the words, say them, and wiggle the cube.
  function explainChipsIn(section, station) {
    section.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip[data-move]');
      if (!chip) return;
      const m = chip.dataset.move;
      const meaning = words(m);
      const box = chip.parentElement;
      let cap = box.nextElementSibling;
      if (!cap || !cap.classList.contains('chip-words')) {
        cap = el('div', 'chip-words');
        cap.setAttribute('aria-live', 'polite');
        box.after(cap);
      }
      cap.innerHTML = '<b>' + m + '</b> ' + meaning;
      speak(m + '. ' + meaning);
      station.demo(m);
    });
  }

  // ------------------------------------------------------------ progress
  const PROGRESS_KEY = 'cubeclubhouse.progress';
  const LEGACY_PROGRESS_KEY = 'cubebuddy.progress';   // the app's earlier name
  const SIZE_KEY = 'cubeclubhouse.size';
  const TIMER_KEY = 'cubeclubhouse.timer';        // the Timer screen's times, per cube size
  function loadProgress() {
    try {
      const raw = localStorage.getItem(PROGRESS_KEY) || localStorage.getItem(LEGACY_PROGRESS_KEY);
      const p = JSON.parse(raw);
      return p && typeof p === 'object' && !Array.isArray(p) ? p : {};
    } catch { return {}; }   // private mode, blocked site data, or junk
  }
  function saveProgress(p) {
    try { localStorage.setItem(PROGRESS_KEY, JSON.stringify(p)); } catch { /* private mode, or the quota is full */ }
  }
  let progress = loadProgress();
  function award(lessonId, stars, noHints) {
    progress[lessonId] = Math.max(progress[lessonId] || 0, stars);
    if (noHints) {
      if (!progress.brain || typeof progress.brain !== 'object') progress.brain = {};
      progress.brain[lessonId] = true;
    }
    saveProgress(progress);
  }
  const hasBrain = (lessonId) => !!(progress.brain && progress.brain[lessonId]);
  const starString = (n) => '★'.repeat(n) + '☆'.repeat(3 - n);

  // ------------------------------------------------------------- MovePad
  // The move buttons for one cube: the outer sides, then a row per inner layer on a
  // bigger cube ("2U" is the second layer from the top), then the whole-cube turns.
  const ORDINAL = ['', '', '2nd', '3rd', '4th', '5th'];
  function MovePad(container, onMove, model) {
    const M = model || NCube.make(3);
    container.classList.add('move-pad');
    container.innerHTML = '';
    let lastDepth = 1;
    for (const row of M.padRows()) {
      if (row.middle) container.appendChild(el('div', 'pad-label', 'the middle layer'));
      else if (row.depth > 1 && row.depth !== lastDepth) container.appendChild(el('div', 'pad-label', ORDINAL[row.depth] + ' layer in from each side'));
      if (row.depth === 0 && lastDepth !== 0) container.appendChild(el('div', 'pad-label', 'whole cube'));
      lastDepth = row.depth;
      const r = el('div', 'pad-row');
      for (const m of row.moves) {
        const mv = M.parseMove(m);
        const b = el('button', 'pad-btn' + (mv.isRotation ? ' rot' : '') + (mv.depth > 1 && !mv.isRotation ? ' inner' : ''), m.replace("'", '<sup>′</sup>'));
        b.type = 'button';
        b.title = words(m);
        b.setAttribute('aria-label', words(m));
        b.addEventListener('click', () => onMove(m));
        r.appendChild(b);
      }
      container.appendChild(r);
    }
    const hasKeyboard = !window.matchMedia || window.matchMedia('(hover: hover)').matches;
    const inner = M.padRows().some((row) => row.depth > 1);
    const hint = el('div', 'pad-hint', hasKeyboard
      ? 'Drag the cube to look around. Keyboard: U, D, L, R, F or B turn a side, and X, Y or Z turn the whole cube. Hold Shift for the ′ turn.'
        + (inner ? ' For a layer further in, type its number first: 2 then R turns the 2nd layer from the right.' : '')
      : 'Drag the cube to look around.');
    container.appendChild(hint);
  }

  // A cube "station": a 3D view plus the state that the app trusts.
  function Station(container, options, model) {
    let M = model || NCube.make(3);
    const view = new CubeView(container, Object.assign({ model: M }, options || {}));
    const st = {
      view,
      get model() { return M; },
      state: M.solved(),
      history: [],
      listeners: [],
      onChange(fn) { st.listeners.push(fn); },
      emit() { st.listeners.forEach((fn) => fn(st.state)); },
      set(state, keepHistory) {
        st.state = state.slice();
        if (!keepHistory) st.history = [];
        view.cancel();
        view.queue = Promise.resolve();
        view.setState(st.state);
        view.setHighlights([]);
        st.emit();
      },
      // Change the cube's size: a fresh, solved cube of the new model.
      setModel(m) {
        M = m;
        view.cancel();
        view.queue = Promise.resolve();      // drop anything still queued for the old cube
        view.setModel(m);
        st.state = m.solved();
        st.history = [];
        st.emit();
      },
      // Moves before this point are not the child's to take back (the mix in Play).
      forget() { st.history = []; },
      // Only a child's own turn comes through here, and it is named for the cube held
      // the usual way, so swing the picture back first if a drag turned it round.
      move(token, duration) {
        view.straighten();
        st.state = M.applyMove(st.state, token);
        st.history.push(token);
        st.emit();
        return view.play([token], duration);
      },
      play(moves, duration, onMove) {
        const tokens = M.parseAlg(moves);
        st.state = M.applyAlg(st.state, tokens);
        st.history.push(...tokens);
        st.emit();
        return view.play(tokens, duration, onMove);
      },
      // Show one move and take it straight back. Only the picture moves: st.state is
      // untouched, so a hint, the guide and the practice goal all stay exactly as they
      // were. If the cube is replaced mid-wiggle, set() repaints it, so nothing is lost.
      demo(token) {
        view.straighten();
        return view.play([token, M.invertMove(token)], 450);
      },
      // st.state updates the moment a move is applied, while the cube is still
      // turning on screen. Celebrations wait for the picture to catch up. emit()
      // runs before play() queues the animation, so let this tick finish first.
      settled() {
        return Promise.resolve().then(() => view.queue).catch(() => {});
      },
      undo() {
        const last = st.history.pop();
        if (!last) return Promise.resolve();
        const inv = M.invertMove(last);
        st.state = M.applyMove(st.state, inv);
        st.emit();
        return view.play([inv]);
      },
    };
    return st;
  }

  // The solver emits small steps (turn the cube, turn the top, do the trick) so a hint can
  // be a small nudge. For the walkthrough, fold each piece's set-up turns into the trick
  // that follows, so a child sees one card per piece: 47 steps become about 27. The
  // highlight of the first step is kept, because it is right for the cube as it is now.
  function mergeSteps(steps) {
    const isSetup = (st) => st.moves.length === 1 && /^[Uy]/.test(st.moves[0]);
    const out = [];
    for (const st of steps) {
      const prev = out[out.length - 1];
      if (prev && prev.stage === st.stage && prev.open) {
        prev.moves = prev.moves.concat(st.moves);
        prev.text += ' ' + st.text;
        prev.open = isSetup(st);
      } else {
        out.push({ stage: st.stage, text: st.text, moves: st.moves.slice(), highlight: st.highlight, open: isSetup(st) });
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- Guide
  // Walks through solver steps on a station, one card per piece.
  function Guide(container, station, options) {
    const opts = Object.assign({ onFinish: null, compact: false }, options || {});
    let steps = [];
    let i = 0;
    let shown = false;   // has the current step been animated already?
    let busy = false;
    let paused = false;      // the child pressed Pause during a whole-solve run
    let stopping = false;    // ...or Stop, so settle on the next step and hand back
    let watchedAll = false;   // the app did the solve, so do not praise the child for it

    // The big cubes answer a little later, a slice of work at a time, so a solver may
    // hand back a promise. Either way this settles to true when there are steps to show.
    function start(state) {
      steps = [];
      i = 0;
      shown = false;
      watchedAll = false;
      const failed = (e) => {
        const why = e && e.internal
          ? 'Something went wrong on my side. Tap Mix It Up and try again.'
          : ((e && e.message) || 'One of the stickers does not look right.') + ' Let\'s check the stickers together.';
        container.innerHTML = '<div class="guide-error">Hmm, this does not look like a real cube yet. ' + why + '</div>';
        return false;
      };
      const ready = (res) => {
        steps = mergeSteps(res.steps);
        i = 0;
        shown = false;
        busy = false;
        watchedAll = false;
        render();
        return true;
      };
      let res;
      try {
        res = (opts.solve || Solver.solve)(state);
      } catch (e) {
        return failed(e);
      }
      return res && typeof res.then === 'function' ? res.then(ready, failed) : ready(res);
    }

    function stagesOf() {
      const seen = [];
      for (const s of steps) if (!seen.includes(s.stage)) seen.push(s.stage);
      return seen;
    }

    function render() {
      hush();                       // moving on stops whatever was being read
      container.innerHTML = '';
      container.classList.add('guide');
      if (steps.length === 0) {
        container.appendChild(el('div', 'guide-done', '🎉 The cube is already solved. Amazing!'));
        if (opts.onFinish) opts.onFinish();
        return;
      }
      if (i >= steps.length) {
        if (watchedAll) {
          container.appendChild(el('div', 'guide-done', '👀 That was the whole solve! Want to do it yourself, step by step?'));
          const again = el('button', 'btn primary', '◀ Start from the First Step');
          again.addEventListener('click', () => {
            let s = station.state;
            for (let k = steps.length - 1; k >= 0; k--) s = station.model.applyAlg(s, station.model.invertAlg(steps[k].moves));
            station.set(s);
            i = 0; shown = false; watchedAll = false;
            render();
          });
          container.appendChild(again);
        } else {
          container.appendChild(el('div', 'guide-done', '🎉 <b>You solved it!</b> Take a bow, cube master!'));
        }
        station.view.setHighlights([]);
        if (opts.onFinish) opts.onFinish();
        return;
      }
      const step = steps[i];
      const stages = stagesOf();
      const bar = el('div', 'stage-bar');
      bar.dataset.at = stages.indexOf(step.stage) + 1;
      bar.dataset.of = stages.length;
      for (const st of stages) {
        const idx = BigSolver.STAGES.indexOf(st);
        const curIdx = BigSolver.STAGES.indexOf(step.stage);
        bar.appendChild(el('span', 'stage-chip' + (idx < curIdx ? ' done' : idx === curIdx ? ' current' : ''), STAGE_TITLES[st]));
      }
      container.appendChild(bar);
      // "Step 3 of 47" is a wall to a child; count within the stage instead.
      const inStage = steps.filter((s) => s.stage === step.stage);
      const count = el('div', 'guide-count', STAGE_TITLES[step.stage] + ' · step ' + (inStage.indexOf(step) + 1) + ' of ' + inStage.length);
      container.appendChild(count);
      container.appendChild(el('p', 'guide-text', step.text));
      container.appendChild(el('div', 'guide-moves', stepChips(step.moves)));
      container.insertAdjacentHTML('beforeend', wordsList(step.moves));

      const btns = el('div', 'guide-btns');
      const showBtn = el('button', 'btn primary', shown ? '▶ Watch Again' : '▶ Watch');
      const nextBtn = el('button', 'btn', 'I Did It ▶');
      const backBtn = el('button', 'btn ghost', '◀ Last Step');
      const sayBtn = readButton(() => step.text + ' ' + movesInWords(step.moves), 'Read', 'btn ghost');
      const autoBtn = el('button', 'btn ghost', '⏩ Watch the Whole Solve');
      backBtn.disabled = i === 0;
      showBtn.addEventListener('click', async () => {
        if (busy) return;
        if (shown) {
          // rewind this step first, then play it again
          busy = true;
          station.set(station.model.applyAlg(station.state, station.model.invertAlg(step.moves)));
          busy = false;
        }
        busy = true;
        station.view.setHighlights(step.highlight);
        await station.play(step.moves, speed().step);
        station.view.setHighlights([]);
        shown = true;
        busy = false;
        showBtn.textContent = '▶ Watch Again';
        nextBtn.classList.add('primary');
        showBtn.classList.remove('primary');
      });
      nextBtn.addEventListener('click', () => {
        if (busy) return;
        if (!shown) station.set(station.model.applyAlg(station.state, step.moves));
        i++;
        shown = false;
        render();
      });
      backBtn.addEventListener('click', () => {
        if (busy || i === 0) return;
        if (shown) station.set(station.model.applyAlg(station.state, station.model.invertAlg(step.moves)));
        i--;
        station.set(station.model.applyAlg(station.state, station.model.invertAlg(steps[i].moves)));
        shown = false;
        render();
      });
      // While the whole solve plays, these two replace the ordinary buttons.
      const runBtns = el('div', 'guide-btns');
      const pauseBtn = el('button', 'btn primary', '⏸️ Pause');
      const stopBtn = el('button', 'btn', '⏹️ Stop Here');
      runBtns.append(pauseBtn, stopBtn);
      runBtns.hidden = true;
      pauseBtn.addEventListener('click', () => {
        paused = !paused;
        pauseBtn.textContent = paused ? '▶️ Carry On' : '⏸️ Pause';
      });
      stopBtn.addEventListener('click', () => { stopping = true; paused = false; });

      autoBtn.addEventListener('click', async () => {
        if (busy) return;
        busy = true;
        paused = false;
        stopping = false;
        btns.hidden = true;
        runBtns.hidden = false;
        pauseBtn.textContent = '⏸️ Pause';
        const myGen = station.view.gen;
        // The guide panel can be torn down mid-run (a manual move, a new cube), and
        // the cube can be replaced under us. Either way, stop quietly.
        const gone = () => !$('.guide-text', container) || !$('.guide-moves', container) || station.view.gen !== myGen;
        let moved = false;
        try {
          if (shown) { i++; shown = false; }
          for (; i < steps.length; i++) {
            if (gone()) return;
            const st = steps[i];
            const same = steps.filter((s) => s.stage === st.stage);
            count.textContent = STAGE_TITLES[st.stage] + ' · step ' + (same.indexOf(st) + 1) + ' of ' + same.length;
            $('.guide-text', container).textContent = st.text;
            $('.guide-moves', container).innerHTML = stepChips(st.moves);
            station.view.setHighlights(st.highlight);
            // Move by move, so Pause and Stop answer straight away even in the middle
            // of a long trick, and a new speed is used from the very next move.
            for (let k = 0; k < st.moves.length; k++) {
              while (paused && !stopping) {
                await wait(100);
                if (gone()) return;
              }
              if (gone()) return;
              if (stopping) {
                // Land on the end of this step, so the guide can hand back a cube that
                // matches a card rather than one stuck halfway through a trick.
                await station.play(st.moves.slice(k), 70);
                moved = true;
                break;
              }
              await station.play([st.moves[k]], speed().run);
              moved = true;
            }
            if (stopping) { i++; shown = false; break; }
          }
        } finally {
          busy = false;
          runBtns.hidden = true;
          btns.hidden = false;
        }
        if (gone()) return;
        watchedAll = moved && i >= steps.length;
        render();
      });
      btns.append(showBtn, nextBtn, backBtn, sayBtn);
      if (!opts.compact) btns.append(autoBtn);
      container.appendChild(btns);
      if (!opts.compact) {
        container.appendChild(runBtns);
        container.appendChild(speedPicker());
      }
      station.view.setHighlights(step.highlight);
    }

    return { start, get steps() { return steps; } };
  }

  // ------------------------------------------------------------- screens
  const screens = {};
  function showScreen(name) {
    hush();
    for (const k of Object.keys(screens)) {
      if (k !== name && !screens[k].section.hidden && screens[k].onHide) screens[k].onHide();
      screens[k].section.hidden = k !== name;
      // The grown-ups screen has no button in the child's nav; it is reached from the
      // footer, so there is nothing to mark as active.
      const tab = $('nav button[data-screen="' + k + '"]');
      if (tab) tab.classList.toggle('active', k === name);
    }
    if (screens[name] && screens[name].onShow) screens[name].onShow();
    location.hash = name;
  }

  // ================================================================ LEARN
  function buildLearn() {
    const section = $('#screen-learn');
    const list = $('#lesson-list', section);
    const viewWrap = $('#lesson-view', section);
    const station = Station($('#lesson-cube', section));
    let current = null;

    // Never let a solver failure strand the learner on a half-built lesson.
    function practiceCube(stage) {
      try { return Solver.stateForStage(stage); } catch { return Cube.solved(); }
    }

    function renderList() {
      list.innerHTML = '';
      LESSONS.forEach((L, n) => {
        const stars = progress[L.id] || 0;
        const card = el('button', 'lesson-card' + (stars ? ' done' : ''));
        card.type = 'button';
        const badge = hasBrain(L.id) ? ' <span class="brain" title="Done without hints">🧠</span>' : '';
        card.innerHTML = '<span class="lesson-num">' + (n + 1) + '</span><span class="lesson-emoji">' + L.emoji + '</span><span class="lesson-name">' + L.title + '</span><span class="lesson-sub">' + L.subtitle + '</span><span class="stars">' + (L.stage || L.interactive === 'notation' ? starString(stars) + badge : '') + '</span>';
        card.addEventListener('click', () => openLesson(n));
        list.appendChild(card);
      });
    }

    function openLesson(n) {
      current = n;
      const L = LESSONS[n];
      list.hidden = true;
      viewWrap.hidden = false;
      hush();
      $('#lesson-title').textContent = L.emoji + ' ' + L.title;
      $('#lesson-subtitle').textContent = L.subtitle;
      $('#lesson-story').innerHTML = L.story.map((p) => '<p>' + p + '</p>').join('');
      const readRow = el('div', 'btn-row read-row');
      readRow.appendChild(readButton(() => L.title + '. ' + L.subtitle + '. ' + L.story.map(plain).join(' ')));
      $('#lesson-story').prepend(readRow);
      $('#lesson-tips').innerHTML = L.tips.length ? '<h3>💡 Tips</h3><ul>' + L.tips.map((t) => '<li>' + t + '</li>').join('') + '</ul>' : '';
      $('#lesson-prev').disabled = n === 0;
      $('#lesson-next').textContent = n === LESSONS.length - 1 ? 'Back to Lessons' : 'Next Lesson ▶';
      renderAlgs(L);
      renderInteractive(L);
      renderPractice(L);
      station.view.resetView();
      station.set(L.stage ? practiceCube(L.stage) : Cube.solved());
      lessonStart = station.state.slice();
      $('#lesson-reset-msg').textContent = '';
      window.scrollTo(0, 0);
    }

    // Reset Cube puts the cube back to how this lesson set it up: the same practice
    // puzzle, not a new one (Another Puzzle does that), or a solved cube in the lessons
    // without practice. Undo history goes too, so Undo cannot turn the reset back.
    let lessonStart = Cube.solved();
    let resetPractice = null;                 // set by renderPractice for lessons with a puzzle
    function resetCube() {
      hush();
      station.set(lessonStart);
      if (resetPractice) resetPractice();
      const msg = $('#lesson-reset-msg');
      msg.textContent = LESSONS[current].stage ? 'Back to the start of this puzzle.' : 'The cube is solved again.';
      // the message is about this reset; the next turn makes it old news
      const clear = () => {
        msg.textContent = '';
        station.listeners = station.listeners.filter((fn) => fn !== clear);
      };
      station.onChange(clear);
    }

    // A trick card's Watch and Undo turn the practice cube for the child. play() applies
    // the moves and tells the practice goal at once, inside this call, so the flag is
    // up exactly while the goal hears about the app's own turns and at no other time.
    let appMoving = false;
    function appPlay(moves, ms) {
      appMoving = true;
      try { return station.play(moves, ms); } finally { appMoving = false; }
    }

    function renderAlgs(L) {
      const box = $('#lesson-algs');
      box.innerHTML = '';
      if (!L.algs.length) return;
      box.appendChild(el('h3', '', '🪄 Tricks to learn'));
      for (const a of L.algs) {
        const card = el('div', 'alg-card');
        card.innerHTML = '<div class="alg-name">' + a.name + '</div><div class="alg-moves">' + moveChips(a.moves) + '</div><div class="alg-note">' + a.note + '</div>';
        const btns = el('div', 'alg-btns');
        const watch = el('button', 'btn small primary', '▶ Watch');
        const undo = el('button', 'btn small ghost', '↩ Undo');
        const say = readButton(() => a.name + '. ' + movesInWords(Cube.parseAlg(a.moves)), '', 'btn small ghost');
        watch.addEventListener('click', () => appPlay(a.moves, 380));
        undo.addEventListener('click', () => appPlay(Cube.invertAlg(a.moves), 200));
        btns.append(watch, undo, say);
        card.appendChild(btns);
        box.appendChild(card);
      }
    }

    function renderInteractive(L) {
      const box = $('#lesson-interactive');
      box.innerHTML = '';
      if (L.interactive === 'parts') {
        box.appendChild(el('h3', '', '👀 Light them up'));
        const row = el('div', 'btn-row');
        const groups = {
          Centres: Cube.FACES.map((f) => Cube.centerIndex(f)),
          Edges: Cube.EDGES.flatMap((e) => e.idx),
          Corners: Cube.CORNERS.flatMap((c) => c.idx),
          'Lights Off': [],
        };
        for (const name of Object.keys(groups)) {
          const b = el('button', 'btn small', name);
          b.addEventListener('click', () => {
            station.view.setHighlights(groups[name]);
            const fact = { Centres: '6 centres. They never move!', Edges: '12 edges with 2 colours each.', Corners: '8 corners with 3 colours each.', 'Lights Off': '' }[name];
            $('#parts-fact').textContent = fact;
          });
          row.appendChild(b);
        }
        box.appendChild(row);
        const fact = el('p', 'fact', 'Tap a button to light up that kind of block.');
        fact.id = 'parts-fact';
        box.appendChild(fact);
        const spin = el('button', 'btn small ghost', '🔄 Turn the Right Side');
        spin.addEventListener('click', () => station.move('R'));
        box.appendChild(spin);
      } else if (L.interactive === 'notation') {
        box.appendChild(el('h3', '', '🎛️ Try every move'));
        const grid = el('div', 'notation-grid');
        for (const m of ['U', "U'", 'D', "D'", 'L', "L'", 'R', "R'", 'F', "F'", 'B', "B'", 'U2', 'R2', 'y', "y'", 'x', "x'"]) {
          const b = el('button', 'btn small', m);
          b.addEventListener('click', async () => {
            $('#move-words').textContent = m + ': ' + MOVE_WORDS[m];
            await station.play([m], 500);
          });
          grid.appendChild(b);
        }
        box.appendChild(grid);
        const words = el('p', 'fact');
        words.id = 'move-words';
        words.textContent = 'Tap a move to see it and read what it means.';
        box.appendChild(words);
        buildQuiz(box);
      }
    }

    function buildQuiz(box) {
      box.appendChild(el('h3', '', '🎯 Quiz: name that move'));
      const q = el('div', 'quiz');
      const status = el('p', 'fact', 'Watch the cube do a move, then tap the right letter. Get 5 in a row to earn 3 stars!');
      const choices = el('div', 'btn-row');
      const go = el('button', 'btn primary', '▶ Do a Move');
      const again = el('button', 'btn ghost', '▶ Show It Again');
      again.hidden = true;
      let answer = null, lastMove = null, streak = 0, best = 0;
      again.addEventListener('click', async () => {
        if (!lastMove) return;
        station.set(Cube.solved());
        again.disabled = true;
        await station.play([lastMove], 650);
        again.disabled = false;
      });
      const pool = ['U', "U'", 'D', "D'", 'L', "L'", 'R', "R'", 'F', "F'", 'B', "B'"];
      go.addEventListener('click', async () => {
        choices.innerHTML = '';
        station.set(Cube.solved());
        answer = pool[Math.floor(Math.random() * pool.length)];
        lastMove = answer;
        again.hidden = false;
        go.disabled = true;
        await station.play([answer], 650);
        go.disabled = false;
        const opts = new Set([answer]);
        while (opts.size < 4) opts.add(pool[Math.floor(Math.random() * pool.length)]);
        [...opts].sort(() => Math.random() - 0.5).forEach((m) => {
          const b = el('button', 'btn small', m);
          b.addEventListener('click', () => {
            if (!answer) return;
            if (m === answer) {
              streak++;
              best = Math.max(best, streak);
              status.textContent = '✅ Yes! That was ' + answer + '. In a row: ' + streak;
              if (streak >= 5) { award('moves', 3); status.textContent += ' 🌟 Three stars!'; renderList(); }
              else if (streak >= 2) award('moves', Math.max(progress.moves || 0, 1));
            } else {
              status.textContent = 'Almost! It was ' + answer + ': ' + MOVE_WORDS[answer] + ' Tap Show It Again to see it. Best so far: ' + best + ' in a row.';
              streak = 0;
              award('moves', Math.max(progress.moves || 0, 1));
            }
            answer = null;
            choices.innerHTML = '';
          });
          choices.appendChild(b);
        });
      });
      const row = el('div', 'btn-row');
      row.append(go, again);
      q.append(row, choices, status);
      box.appendChild(q);
    }

    function renderPractice(L) {
      const box = $('#lesson-practice');
      box.innerHTML = '';
      // Drop the previous lesson's goal watcher BEFORE returning early, otherwise it
      // keeps scoring moves made in a lesson that has no practice of its own.
      station.listeners = [];
      resetPractice = null;
      if (!L.stage) return;
      box.appendChild(el('h3', '', '🎮 Your turn'));
      const intro = el('p', '', 'This is a pretend cube on the screen, not your real one. It is set up for this step. Use the buttons under the cube and try it. Stuck? Tap <b>Hint</b>.');
      const status = el('div', 'practice-status', 'Goal: ' + L.subtitle);
      const row = el('div', 'btn-row');
      const hintBtn = el('button', 'btn primary', '💡 Hint');
      const newBtn = el('button', 'btn ghost', '🎲 Another Puzzle');
      const undoBtn = el('button', 'btn ghost', '↩ Undo');
      const hintBox = el('div', 'hint-box');
      hintBox.hidden = true;
      let hintsUsed = 0, solvedThis = false, hintFor = null;

      // The first solver step that belongs to this lesson's stage, for the state as it
      // is right now. Recomputed on every use so a hint can never go stale.
      function nextStep() {
        const stageIdx = Solver.STAGES.indexOf(L.stage);
        let res;
        try { res = Solver.solve(station.state); } catch { return null; }
        return res.steps.filter((s) => Solver.STAGES.indexOf(s.stage) <= stageIdx)[0] || null;
      }

      function check(state) {
        // any move of the child's own retires the hint on screen
        if (hintFor && Cube.toString(state) !== hintFor) {
          hintFor = null;
          hush();
          hintBox.hidden = true;
          station.view.setHighlights([]);
        }
        if (solvedThis) return;
        if (Solver.goals[L.stage](state)) {
          solvedThis = true;                       // latch now so this fires exactly once
          // Finishing earns all three stars. Hints are how a child learns, not cheating;
          // doing it without any earns a separate brain badge on top. If a trick card's
          // Watch made the last turns, the app did it, so that is help too.
          const byWatch = appMoving;
          award(L.id, 3, hintsUsed === 0 && !byWatch);
          renderList();
          station.settled().then(() => {
            haptic('success');
            status.innerHTML = '🎉 <b>You did it!</b> ★★★' + (byWatch
              ? ' The Watch button did the last turns, so no 🧠 this time. Try Another puzzle with your own turns!'
              : hintsUsed ? '' : ' 🧠 No hints!');
            status.classList.add('win');
            hintBox.hidden = true;
            station.view.setHighlights([]);
          });
        }
      }
      station.onChange(check);

      hintBtn.addEventListener('click', () => {
        hush();
        hintsUsed++;
        hintBox.hidden = false;
        const one = nextStep();
        if (!one) { hintBox.innerHTML = '<div class="guide-done">This step is already done. Nice!</div>'; return; }
        hintFor = Cube.toString(station.state);
        hintBox.innerHTML = '';
        const stageIdx = Solver.STAGES.indexOf(L.stage);
        if (one.stage !== 'orient' && Solver.STAGES.indexOf(one.stage) < stageIdx) {
          hintBox.appendChild(el('p', 'guide-warn', 'Oops, the ' + STAGE_TITLES[one.stage].toLowerCase() + ' came apart. That happens to everyone! Tap Undo a few times, or follow the hints to fix it.'));
        }
        hintBox.appendChild(el('p', 'guide-text', '💡 ' + one.text));
        hintBox.appendChild(el('div', 'guide-moves', stepChips(one.moves)));
        hintBox.insertAdjacentHTML('beforeend', wordsList(one.moves));
        const say = readButton(() => one.text + ' ' + movesInWords(one.moves), 'Read');
        const b = el('button', 'btn small primary', '▶ Watch');
        b.addEventListener('click', async () => {
          const fresh = nextStep();          // the cube may have moved since the hint
          if (!fresh) return;
          hintFor = null;                    // this play is ours, do not retire the hint
          station.view.setHighlights(fresh.highlight);
          await station.play(fresh.moves, 380);
          station.view.setHighlights([]);
          hintFor = Cube.toString(station.state);
        });
        const hintBtns = el('div', 'btn-row');
        hintBtns.append(b, say);
        hintBox.appendChild(hintBtns);
        station.view.setHighlights(one.highlight);
      });
      // Back to the start of the same puzzle: the hint and the win go, so it can be done
      // again, but hints already seen for this puzzle still count against the 🧠 badge.
      resetPractice = () => {
        solvedThis = false;
        hintFor = null;
        status.textContent = 'Goal: ' + L.subtitle;
        status.classList.remove('win');
        hintBox.hidden = true;
      };
      newBtn.addEventListener('click', () => {
        resetPractice();
        hintsUsed = 0;
        station.set(practiceCube(L.stage));
        lessonStart = station.state.slice();
        $('#lesson-reset-msg').textContent = '';
      });
      undoBtn.addEventListener('click', () => station.undo());
      row.append(hintBtn, undoBtn, newBtn);
      box.append(intro, status, row, hintBox);
    }

    MovePad($('#lesson-controls', section), (m) => station.move(m));
    explainChipsIn(section, station);
    $('#lesson-back').addEventListener('click', () => { viewWrap.hidden = true; list.hidden = false; renderList(); });
    $('#lesson-prev').addEventListener('click', () => openLesson(Math.max(0, current - 1)));
    $('#lesson-next').addEventListener('click', () => {
      if (current === LESSONS.length - 1) { viewWrap.hidden = true; list.hidden = false; renderList(); }
      else openLesson(current + 1);
    });
    $('#lesson-reset-view').addEventListener('click', () => station.view.resetView());
    $('#lesson-reset-cube').addEventListener('click', resetCube);
    renderList();
    screens.learn = { section, station, openLesson };
  }

  // ================================================================= PLAY
  function buildPlay() {
    const section = $('#screen-play');
    let size = 3;
    try { size = parseInt(localStorage.getItem(SIZE_KEY), 10) || 3; } catch { /* no storage */ }
    if (!NCube.SIZES.includes(size)) size = 3;
    const station = Station($('#play-cube', section), { size: 60 }, NCube.make(size));
    const padBox = $('#play-controls', section);
    const sizeBox = $('#play-size', section);
    const sizeNote = $('#play-size-note', section);
    const timerEl = $('#play-timer', section);
    const statusEl = $('#play-status', section);
    const guideBox = $('#play-guide', section);
    let timerStart = null, timerId = null, scrambled = false, moveCount = 0, thinking = false, mixing = false;
    const guide = Guide(guideBox, station, {
      onFinish: () => { stopTimer(); },
      solve: (s) => BigSolver.solveAnyAsync(station.model, s, (what) => { statusEl.textContent = 'Thinking… ' + what + '.'; }),
    });

    function fmt(ms) {
      const s = Math.floor(ms / 1000);
      return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
    }
    function startTimer() {
      timerStart = Date.now();
      clearInterval(timerId);
      timerId = setInterval(() => { timerEl.textContent = fmt(Date.now() - timerStart); }, 250);
    }
    function stopTimer() {
      clearInterval(timerId);
      timerId = null;
    }
    station.onChange((state) => {
      if (station.model.isSolved(state) && scrambled && timerStart) {
        const took = Date.now() - timerStart;      // the solve ended on this move
        const moves = moveCount;
        stopTimer();
        scrambled = false;
        station.settled().then(() => {
          statusEl.innerHTML = '🎉 <b>Solved</b> in ' + fmt(took) + ' with ' + moves + (moves === 1 ? ' move!' : ' moves!');
          confetti();
          haptic('success');
        });
      }
    });
    function staleGuide() {
      if (!guideBox.childElementCount) return;
      hush();                       // the Read button being removed cannot stop itself
      guideBox.innerHTML = '';
      statusEl.textContent = 'You made your own move, so the steps changed. Tap Help Me Solve It for new steps.';
    }
    function userMove(m) {
      if (thinking) return false;      // the solver is working on this very cube
      staleGuide();
      if (scrambled && !timerId) startTimer();
      moveCount++;
      station.move(m);
      return true;
    }
    function applySize(n, first) {
      hush();                       // stop any step being read for the old cube
      size = n;
      try { localStorage.setItem(SIZE_KEY, String(n)); } catch { /* no storage */ }
      if (!first) station.setModel(NCube.make(n));
      MovePad(padBox, userMove, station.model);
      sizeBox.querySelectorAll('.size-btn').forEach((b) => {
        b.classList.toggle('active', +b.dataset.size === n);
        b.setAttribute('aria-pressed', String(+b.dataset.size === n));
      });
      guideBox.innerHTML = '';
      stopTimer();
      timerEl.textContent = '00:00';
      timerStart = null;
      scrambled = false;
      moveCount = 0;
      sizeNote.textContent = noteFor(n);
      statusEl.textContent = 'The cube is solved. Tap Mix It Up to start.';
    }
    function noteFor(n) {
      return n <= 3
        ? 'Cube Clubhouse can guide you through this one.'
        : 'Cube Clubhouse can guide this one too: centres, then edges, then it works like a 3×3. Lessons and My real cube use the 3×3.';
    }
    // A new size means a new cube. With a mixed cube on screen that throws away the
    // child's work, so an iOS alert asks first; a solved cube swaps straight away.
    for (const n of NCube.SIZES) {
      const b = el('button', 'size-btn', n + '×' + n);
      b.type = 'button';
      b.dataset.size = n;
      b.setAttribute('aria-label', n + ' by ' + n + ' cube');
      b.addEventListener('click', async () => {
        if (n === size) return;
        if (!station.model.isSolved(station.state)) {
          const was = size;
          const ok = await askFirst({
            title: 'Start a ' + n + '×' + n + '?',
            message: 'Your mixed-up ' + was + '×' + was + ' will be lost.',
            action: 'Swap Cubes',
          });
          if (!ok || size !== was) return;
        }
        applySize(n, false);
      });
      sizeBox.appendChild(b);
    }
    applySize(size, true);
    explainChipsIn(section, station);
    $('#play-scramble').addEventListener('click', async () => {
      hush();
      guideBox.innerHTML = '';
      stopTimer();
      timerEl.textContent = '00:00';
      timerStart = null;
      moveCount = 0;
      statusEl.textContent = 'Mixing it up…';
      station.set(station.model.solved());
      const myGen = station.view.gen;
      mixing = true;
      await station.play(station.model.scramble(20), 90);
      mixing = false;
      // A size change (or a Reset) during the mixing replaces the cube. Without this
      // the solved new cube would be marked as scrambled, and the next move plus an
      // undo would be celebrated as a solve.
      if (station.view.gen !== myGen) return;
      // Undo takes back the child's own turns, never the mix: otherwise one turn and
      // twenty-one Undos is a "solve" in two seconds, with confetti.
      station.forget();
      scrambled = true;
      statusEl.textContent = 'Go! The clock starts on your first move. Stuck? Tap Help Me Solve It.';
    });
    $('#play-reset').addEventListener('click', () => {
      hush();
      guideBox.innerHTML = '';
      stopTimer();
      timerEl.textContent = '00:00';
      scrambled = false;
      moveCount = 0;
      station.set(station.model.solved());
      statusEl.textContent = 'The cube is solved. Tap Mix It Up to start.';
    });
    $('#play-undo').addEventListener('click', () => {
      if (mixing) return;                 // the mix is not the child's to take back
      if (!station.history.length) {
        if (scrambled) statusEl.textContent = 'Undo takes back your own turns, not the mix. Tap Make It Solved to start again.';
        return;
      }
      staleGuide();
      station.undo();
    });
    // Working out a 6x6 is a second or two of real work. It runs a slice at a time so
    // the page keeps painting and can say what it is doing, and the controls are held
    // meanwhile: a size change or a stray turn under a running solve would leave the
    // guide describing a cube that no longer exists.
    const controls = ['#play-scramble', '#play-reset', '#play-undo', '#play-help'];
    function setThinking(on) {
      thinking = on;
      for (const sel of controls) $(sel).disabled = on;
      sizeBox.querySelectorAll('.size-btn').forEach((b) => { b.disabled = on; });
      padBox.querySelectorAll('.pad-btn').forEach((b) => { b.disabled = on; });
      section.classList.toggle('thinking', on);
    }
    const runGuide = async () => {
      const myGen = station.view.gen;
      const solved = station.model.isSolved(station.state);
      const ok = await guide.start(station.state);
      if (station.view.gen !== myGen) return;       // the cube was replaced meanwhile
      statusEl.textContent = !ok ? 'Hmm, I could not work that one out. Read the message below.'
        : solved ? 'This cube is already solved! Tap Mix It Up for a new one.'
          : 'Follow the steps below. Tap Watch to see each one.';
      guideBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    };
    $('#play-help').addEventListener('click', async () => {
      if (thinking) return;
      stopTimer();
      scrambled = false;
      statusEl.textContent = 'Thinking\u2026';
      setThinking(true);
      try {
        await runGuide();
      } finally {
        setThinking(false);
      }
    });
    $('#play-reset-view').addEventListener('click', () => station.view.resetView());
    screens.play = { section, station, userMove };
  }

  // ================================================================ TIMER
  // A speedcubing timer for the child's real cube: a mix to copy, hold-and-release to
  // start, any touch or key to stop, optional competition inspection, and personal bests
  // for each size. The arithmetic lives in js/timer.js; this is the page around it.
  function buildTimer() {
    const section = $('#screen-timer');
    const pad = $('#timer-pad', section);
    const display = $('#timer-display', section);
    const help = $('#timer-help', section);
    const sizeBox = $('#timer-size', section);
    const scrambleEl = $('#timer-scramble', section);
    const inspectBtn = $('#timer-inspect', section);
    const lastBox = $('#timer-last', section);
    const said = $('#timer-said', section);
    const plus2 = $('#timer-plus2', section);
    const dnf = $('#timer-dnf', section);
    const del = $('#timer-delete', section);
    const statsBox = $('#timer-stats', section);
    const list = $('#timer-list', section);
    const mixProgress = $('#timer-mix-progress', section);
    const solveHelp = $('#timer-solve-help', section);
    const checkEl = $('#timer-check', section);
    const guideBox = $('#timer-guide', section);
    const guideNote = $('#timer-guide-note', section);
    const chartBox = $('#timer-chart', section);
    const showAllBtn = $('#timer-show-all', section);
    const KEEP = 1000;                 // times kept per size; the oldest go first
    const CHART_LAST = 50;             // times drawn on the progress chart
    let showAll = false;               // the list shows every time, not just the last few
    const HOLD_MS = 300;               // how long to hold before the clock is ready
    const SHOWN = 12;                  // times listed on screen

    // Storage is the child's own device. Anything that is not a well-formed time is
    // dropped on the way in, so a damaged entry cannot break the page.
    const good = (x) => !!x && Number.isFinite(x.ms) && x.ms >= 0 && (x.pen === 0 || x.pen === 2 || x.pen === Timer.DNF);
    function load() {
      let d = null;
      try { d = JSON.parse(localStorage.getItem(TIMER_KEY)); } catch { /* no storage, or not ours */ }
      if (!d || typeof d !== 'object') d = {};
      const out = { size: NCube.SIZES.includes(d.size) ? d.size : 3, inspect: d.inspect === true, solves: {} };
      if (d.solves && typeof d.solves === 'object') {
        for (const n of NCube.SIZES) {
          if (Array.isArray(d.solves[n])) out.solves[n] = d.solves[n].filter(good).map((x) => ({ ms: x.ms, pen: x.pen }));
        }
      }
      return out;
    }
    let data = load();
    const save = () => { try { localStorage.setItem(TIMER_KEY, JSON.stringify(data)); } catch { /* private mode, or full */ } };
    const solves = () => (data.solves[data.size] = data.solves[data.size] || []);

    const station = Station($('#timer-cube', section), { size: 40 }, NCube.make(data.size));
    let mix = [];
    let mixDone = 0;                   // turns of the mix the child has ticked off
    let guideOpen = false;             // "Help me solve this mix" is showing steps
    let thinking = false;              // ...or working them out
    const after = (k) => station.model.applyAlg(station.model.solved(), mix.slice(0, k));
    const guide = Guide(guideBox, station, {
      solve: (s) => BigSolver.solveAnyAsync(station.model, s, (what) => { mixProgress.textContent = 'Thinking… ' + what + '.'; }),
    });
    function closeGuide() {
      if (!guideOpen) return;
      guideOpen = false;
      hush();
      guideBox.innerHTML = '';
      guideNote.hidden = true;
    }
    function newMix() {
      const M = station.model;
      closeGuide();
      mix = M.scramble(Timer.SCRAMBLE_LENGTH[M.N] || 25);
      mixDone = 0;
      // One button per turn, with a space between so the mix still reads (and copies)
      // as ordinary notation.
      scrambleEl.innerHTML = '';
      mix.forEach((m, i) => {
        if (i) scrambleEl.appendChild(document.createTextNode(' '));
        const b = el('button', 'mix-turn');
        b.type = 'button';
        b.textContent = m;
        b.setAttribute('aria-label', 'Turn ' + (i + 1) + ' of ' + mix.length + ', ' + m);
        b.addEventListener('click', () => tickTurn(i));
        scrambleEl.appendChild(b);
      });
      paintMix();
      station.view.resetView();
      station.set(after(mix.length));
    }
    // A long mix is easy to lose your place in (a 6x6 has 80 turns), so each turn is a
    // button: tap it once it is done. Tapping a turn already done steps back to just
    // before it, to put a slip right.
    function paintMix() {
      scrambleEl.querySelectorAll('.mix-turn').forEach((b, i) => {
        b.classList.toggle('done', i < mixDone);
        b.classList.toggle('next', i === mixDone);
        b.setAttribute('aria-pressed', String(i < mixDone));
      });
      const n = mix.length;
      mixProgress.textContent = mixDone === 0 ? 'Tap each turn once you have done it.'
        : mixDone < n ? mixDone + ' of ' + n + ' turns done.'
          : '✅ All ' + n + ' turns done! Put the cube down and time your solve.';
      if (!guideOpen) {
        checkEl.textContent = mixDone === 0 || mixDone === n
          ? 'Your cube should look like this after the mix.'
          : 'Your cube after ' + mixDone + ' of ' + n + ' turns. The picture turns with you.';
      }
    }
    function tickTurn(i) {
      if (phase !== 'idle' || inspecting || thinking) return;
      closeGuide();
      const was = mixDone;
      mixDone = i < mixDone ? i : i + 1;
      if (mixDone === was + 1) {
        // One turn on: show it turning. Set the picture to exactly where the mix was
        // first, which also stops anything still playing (a guided solve, say).
        station.set(was === 0 ? station.model.solved() : after(was));
        station.play([mix[was]], 260);
      } else {
        station.set(after(mixDone === 0 ? mix.length : mixDone));
      }
      paintMix();
      if (mixDone === mix.length) pad.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    // "Help me solve this mix": the app knows the exact mix it gave out, so it can walk
    // the child from that cube to solved, any size, with the same steps as Play.
    solveHelp.addEventListener('click', async () => {
      if (thinking || phase !== 'idle' || inspecting) return;
      hush();
      mixDone = mix.length;                 // the steps start from the whole mix
      paintMix();
      const state = after(mix.length);
      station.view.resetView();
      station.set(state);
      guideOpen = true;
      guideNote.hidden = false;
      guideNote.innerHTML = '';
      guideNote.appendChild(document.createTextNode('These steps are for a cube mixed with exactly the turns above. '
        + 'If you have turned it since, mix it again from solved' + (station.model.N === 3 ? ', or paint it in on My real cube.' : '.')));
      if (station.model.N === 3) {
        const go = el('button', 'btn small ghost', '🔍 My Real Cube');
        go.type = 'button';
        go.addEventListener('click', () => showScreen('solve'));
        guideNote.appendChild(document.createTextNode(' '));
        guideNote.appendChild(go);
      }
      checkEl.textContent = 'Follow the steps below on your real cube. Tap Watch to see each one here.';
      thinking = true;
      setPhase('idle');
      const myMix = mix;
      let ok = false;
      try { ok = await guide.start(state); } finally { thinking = false; setPhase('idle'); }
      if (mix !== myMix || !guideOpen) return;
      mixProgress.textContent = ok ? 'Follow the steps below. When you can do it on your own, time a fresh mix!'
        : 'Hmm, I could not work that one out. Tap New Mix and try another.';
      guideBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });

    // ---- the clock
    // idle -> hold -> ready -> (let go) running -> (any touch or key) idle.
    // With inspection on, a first tap starts 15 seconds of looking; the hold, ready and
    // let-go that start the solve then happen while the looking time runs on.
    let phase = 'idle';
    let inspecting = false, inspectStart = 0, startAt = 0, startPen = 0;
    let holdTimer = null, raf = 0;
    let justStopped = false;    // the touch or key that stopped the clock is still down
    let tapToInspect = false;   // a press that will start inspection when it lets go
    let called = {};            // inspection call-outs already made

    const HELP = {
      idle: () => (data.inspect
        ? 'Tap here, or press the space bar, to start your 15 seconds of looking.'
        : 'Touch and hold here, or hold down the space bar, until the numbers turn green. Let go to start. Tap to stop.'),
      inspecting: () => 'Look at your cube, but do not turn it yet. Touch and hold here when you are ready, and let go to start.',
      holding: () => 'Keep holding…',
      ready: () => 'Let go to start!',
      running: () => 'Tap anywhere, or press any key, to stop.',
    };
    function setPhase(p) {
      phase = p;
      const shown = p === 'idle' && inspecting ? 'inspecting' : p;
      pad.dataset.phase = shown;
      help.textContent = HELP[shown]();
      const busy = p !== 'idle' || inspecting || thinking;
      section.classList.toggle('timing', p !== 'idle' || inspecting);
      sizeBox.querySelectorAll('.size-btn').forEach((b) => { b.disabled = busy; });
      scrambleEl.querySelectorAll('.mix-turn').forEach((b) => { b.disabled = busy; });
      for (const b of [inspectBtn, $('#timer-new-mix', section), solveHelp, plus2, dnf, del]) b.disabled = busy;
    }
    function frame() {
      const now = performance.now();
      if (phase === 'running') display.textContent = Timer.format(Timer.clockTime(now - startAt));
      else if (inspecting) {
        const t = now - inspectStart;
        // A judge calls out 8 and 12 seconds, because the solver is looking at the
        // cube, not the clock. So does this.
        if (t >= 8000 && !called[8]) { called[8] = true; speak('Eight seconds'); }
        if (t >= 12000 && !called[12]) { called[12] = true; speak('Twelve seconds'); }
        display.textContent = t < Timer.INSPECTION_MS ? String(Math.ceil((Timer.INSPECTION_MS - t) / 1000))
          : t <= Timer.INSPECTION_DNF_MS ? '+2' : 'DNF';
      } else { raf = 0; return; }
      raf = requestAnimationFrame(frame);
    }
    const run = () => { if (!raf) raf = requestAnimationFrame(frame); };

    function press() {
      if (justStopped || thinking) return;
      if (phase === 'running') { stop(); return; }
      if (phase !== 'idle') return;
      if (data.inspect && !inspecting) { tapToInspect = true; return; }
      setPhase('holding');
      clearTimeout(holdTimer);
      holdTimer = setTimeout(() => { if (phase === 'holding') { setPhase('ready'); haptic('light'); } }, HOLD_MS);
    }
    function release() {
      if (justStopped) { justStopped = false; return; }
      if (tapToInspect) {
        tapToInspect = false;
        inspecting = true;
        inspectStart = performance.now();
        called = {};
        setPhase('idle');
        run();
        return;
      }
      clearTimeout(holdTimer);
      if (phase === 'ready') start();
      else if (phase === 'holding') setPhase('idle');      // let go too soon: try again
    }
    function start() {
      closeGuide();                     // a timed solve is the child's own
      hush();                           // and no call-out talks over it
      startPen = inspecting ? Timer.inspectionPenalty(performance.now() - inspectStart) : 0;
      inspecting = false;
      startAt = performance.now();
      setPhase('running');
      lastBox.hidden = true;
      run();
    }
    function stop() {
      const ms = Timer.clockTime(performance.now() - startAt);
      haptic('medium');
      justStopped = true;
      cancelAnimationFrame(raf); raf = 0;
      display.textContent = Timer.format(ms);
      setPhase('idle');
      record({ ms, pen: startPen });
    }
    // Leaving the screen, hiding the app or changing size throws a running solve away:
    // a time that nobody stopped is not a time.
    function abort() {
      const busy = phase !== 'idle' || inspecting;
      clearTimeout(holdTimer);
      cancelAnimationFrame(raf); raf = 0;
      inspecting = false; tapToInspect = false; justStopped = false;
      if (busy) display.textContent = '0.00';
      setPhase('idle');
    }

    // ---- times and bests
    function record(solve) {
      const before = Timer.stats(solves());
      solves().push(solve);
      if (solves().length > KEEP) solves().splice(0, solves().length - KEEP);
      save();
      const after = Timer.stats(solves());
      const lines = [];
      if (solve.pen === 2) lines.push('You started after 15 seconds of looking, so 2 seconds were added.');
      if (solve.pen === Timer.DNF) lines.push('You looked for more than 17 seconds, so this one counts as DNF (did not finish).');
      let party = false;
      if (after.best !== null && (before.best === null || after.best < before.best)) {
        lines.push(before.best === null ? '⏱️ Your first time on the board!' : '🎉 New best time! Your old best was ' + Timer.format(before.best) + '.');
        party = before.best !== null;
      }
      if (Number.isFinite(after.bestAo5) && (before.bestAo5 === null || !Number.isFinite(before.bestAo5) || after.bestAo5 < before.bestAo5)) {
        lines.push(before.bestAo5 === null || !Number.isFinite(before.bestAo5) ? '🏅 Your first average of 5: ' + Timer.format(after.bestAo5) + '!' : '🏆 New best average of 5: ' + Timer.format(after.bestAo5) + '!');
        party = true;
      }
      said.textContent = lines.join(' ') || 'Nice solve! Mix it again for another go.';
      showLast();
      renderAll();
      newMix();
      if (party) { confetti(); haptic('success'); }
    }
    function showLast() {
      const s = solves()[solves().length - 1];
      lastBox.hidden = !s;
      if (!s) return;
      plus2.setAttribute('aria-pressed', String(s.pen === 2));
      dnf.setAttribute('aria-pressed', String(s.pen === Timer.DNF));
      plus2.classList.toggle('on', s.pen === 2);
      dnf.classList.toggle('on', s.pen === Timer.DNF);
    }
    // +2 and DNF are for the child (or a grown-up judging) to mark the last solve: a
    // piece a quarter-turn off at the end is +2, a cube left unsolved is DNF.
    function penalise(pen) {
      const s = solves()[solves().length - 1];
      if (!s) return;
      s.pen = s.pen === pen ? 0 : pen;
      save();
      showLast();
      renderAll();
      said.textContent = 'That time is now ' + Timer.formatSolve(s) + '.';
      display.textContent = Timer.format(Timer.value(s));
    }
    plus2.addEventListener('click', () => penalise(2));
    dnf.addEventListener('click', () => penalise(Timer.DNF));
    del.addEventListener('click', async () => {
      const s0 = solves()[solves().length - 1];
      if (!s0) return;
      const ok = await askFirst({
        title: 'Delete This Time?',
        message: Timer.formatSolve(s0) + ' will be taken off your ' + data.size + '×' + data.size + ' times.',
        action: 'Delete',
      });
      if (!ok || solves()[solves().length - 1] !== s0) return;
      solves().pop();
      save();
      lastBox.hidden = true;
      display.textContent = '0.00';
      renderAll();
    });

    function render() {
      const all = solves();
      const st = Timer.stats(all);
      const tiles = [
        ['Best time', st.best], ['Best average of 5', st.bestAo5],
        ['Average of last 5', st.ao5], ['Average of last 12', st.ao12],
      ];
      statsBox.innerHTML = '';
      for (const [label, v] of tiles) {
        const t = el('div', 'stat');
        t.appendChild(el('span', 'stat-value', Timer.format(v)));
        t.appendChild(el('span', 'stat-label', label));
        statsBox.appendChild(t);
      }
      const count = el('div', 'stat');
      count.appendChild(el('span', 'stat-value', String(st.count)));
      count.appendChild(el('span', 'stat-label', st.count === 1 ? 'Solve' : 'Solves'));
      statsBox.appendChild(count);

      list.innerHTML = '';
      if (!all.length) {
        list.appendChild(el('li', 'timer-empty', 'No times yet for the ' + data.size + '×' + data.size + '. Mix your cube and go!'));
        return;
      }
      const bestAt = all.findIndex((x) => Timer.value(x) === st.best);
      const upTo = showAll ? all.length : SHOWN;
      for (let i = all.length - 1; i >= Math.max(0, all.length - upTo); i--) {
        const li = el('li', i === bestAt ? 'best' : '');
        li.appendChild(el('span', 'timer-n', String(i + 1) + '.'));
        li.appendChild(el('span', 'timer-t', Timer.formatSolve(all[i])));
        if (i === bestAt) {
          const star = el('span', 'timer-star', '⭐');
          star.setAttribute('aria-label', 'your best');
          star.title = 'Your best';
          li.appendChild(star);
        }
        list.appendChild(li);
      }
      if (!showAll && all.length > SHOWN) list.appendChild(el('li', 'timer-more', 'and ' + (all.length - SHOWN) + ' earlier ' + (all.length - SHOWN === 1 ? 'time' : 'times')));
    }
    function renderAll() {
      render();
      const n = solves().length;
      showAllBtn.hidden = n <= SHOWN;
      showAllBtn.textContent = showAll ? 'Show Only the Last ' + SHOWN : 'Show All ' + n + ' Times';
      showAllBtn.setAttribute('aria-expanded', String(showAll));
      drawChart();
    }
    showAllBtn.addEventListener('click', () => { showAll = !showAll; renderAll(); });

    // ---- the progress chart: one line, the last few dozen times, lower is faster
    const SVG = 'http://www.w3.org/2000/svg';
    const svg = (tag, attrs, parent) => {
      const n = document.createElementNS(SVG, tag);
      for (const k of Object.keys(attrs)) n.setAttribute(k, attrs[k]);
      if (parent) parent.appendChild(n);
      return n;
    };
    function drawChart() {
      chartBox.innerHTML = '';
      const all = solves();
      const pts = [];
      for (let i = Math.max(0, all.length - CHART_LAST); i < all.length; i++) {
        const v = Timer.value(all[i]);
        if (v !== Infinity) pts.push({ n: i + 1, v, s: all[i] });   // a DNF has no time to plot
      }
      if (pts.length < 2) {
        if (all.length) chartBox.appendChild(el('p', 'fact chart-wait', '📈 Your chart appears after two times. Keep going!'));
        return;
      }
      const W = chartBox.clientWidth;
      if (!W) return;                  // not on screen yet: drawn when the screen is shown
      const best = Timer.best(all);
      const span = all.length - Math.max(0, all.length - CHART_LAST);        // solves in view, DNFs too
      const head = el('div', 'chart-head');
      head.appendChild(el('h3', 'chart-title', span === all.length ? 'Your ' + span + ' solves so far' : 'Your last ' + span + ' solves'));
      head.appendChild(el('p', 'chart-sub', 'Lower is faster. Touch the line to see any time.'
        + (pts.length < span ? ' A DNF has no time, so it is left out.' : '')));
      chartBox.appendChild(head);

      const H = 190, L = 36, R = 84, T = 16, B = 26;
      const lo = Math.min(...pts.map((p) => p.v)), hi = Math.max(...pts.map((p) => p.v));
      const axis = Timer.niceTicks(lo, hi, 5);
      const x = (n) => L + (pts.length === 1 ? 0 : (n - pts[0].n) / (pts[pts.length - 1].n - pts[0].n)) * (W - L - R);
      const y = (v) => T + (1 - (v - axis.lo) / (axis.hi - axis.lo)) * (H - T - B);
      const bestPt = pts.reduce((a, p) => (p.v < a.v ? p : a), pts[0]);
      const last = pts[pts.length - 1];

      const wrap = el('div', 'chart-wrap');
      const root = svg('svg', { width: W, height: H, viewBox: '0 0 ' + W + ' ' + H, class: 'chart', role: 'img', tabindex: '0',
        'aria-label': 'Your last ' + span + ' solves. Fastest ' + Timer.format(bestPt.v) + ', latest ' + Timer.format(last.v) + '. Use the arrow keys to read each one.' }, null);
      for (const t of axis.ticks) {
        svg('line', { x1: L, x2: W - R, y1: y(t), y2: y(t), class: 'chart-grid' }, root);
        svg('text', { x: L - 8, y: y(t) + 4, class: 'chart-axis', 'text-anchor': 'end' }, root).textContent = Timer.formatTick(t);
      }
      svg('text', { x: L, y: H - 6, class: 'chart-axis' }, root).textContent = 'solve ' + pts[0].n;
      svg('text', { x: W - R, y: H - 6, class: 'chart-axis', 'text-anchor': 'end' }, root).textContent = 'solve ' + last.n;
      svg('path', { d: pts.map((p, i) => (i ? 'L' : 'M') + x(p.n).toFixed(1) + ' ' + y(p.v).toFixed(1)).join(' '), class: 'chart-line' }, root);
      // the two points worth a label: the fastest here, and the latest
      svg('circle', { cx: x(bestPt.n), cy: y(bestPt.v), r: 5, class: 'chart-dot' }, root);
      const bestLabel = (bestPt.v === best ? '⭐ ' : 'fastest here ') + Timer.format(bestPt.v);
      if (bestPt === last) {
        // the latest is the best: one label, at the end of the line like any latest time
        svg('text', { x: x(last.n) + 9, y: y(last.v) + 4, class: 'chart-label' }, root).textContent = bestLabel;
      } else {
        const below = y(bestPt.v) < T + 22;
        svg('text', { x: Math.min(Math.max(x(bestPt.n), L + 30), W - R - 10), y: y(bestPt.v) + (below ? 20 : -10), class: 'chart-label', 'text-anchor': 'middle' }, root).textContent = bestLabel;
      }
      if (last !== bestPt) {
        svg('circle', { cx: x(last.n), cy: y(last.v), r: 4, class: 'chart-dot' }, root);
        svg('text', { x: x(last.n) + 9, y: y(last.v) + 4, class: 'chart-label' }, root).textContent = Timer.format(last.v);
      }
      // the crosshair and its readout: finds the nearest solve, by touch, mouse or keys
      const cross = svg('line', { y1: T, y2: H - B, class: 'chart-cross', visibility: 'hidden' }, root);
      const hot = svg('circle', { r: 6, class: 'chart-dot hot', visibility: 'hidden' }, root);
      const hit = svg('rect', { x: L, y: 0, width: W - L - R, height: H, class: 'chart-hit' }, root);
      const tip = el('div', 'chart-tip');
      tip.hidden = true;
      let at = pts.length - 1;
      const show = (k) => {
        at = Math.max(0, Math.min(pts.length - 1, k));
        const p = pts[at];
        cross.setAttribute('x1', x(p.n)); cross.setAttribute('x2', x(p.n)); cross.setAttribute('visibility', 'visible');
        hot.setAttribute('cx', x(p.n)); hot.setAttribute('cy', y(p.v)); hot.setAttribute('visibility', 'visible');
        tip.innerHTML = '';
        tip.appendChild(el('strong', ''));
        tip.lastChild.textContent = Timer.formatSolve(p.s);
        tip.appendChild(el('span', ''));
        tip.lastChild.textContent = 'solve ' + p.n + (p.v === best ? ' · your best' : '');
        tip.hidden = false;
        // Beside the crosshair, never over the point it describes: to the right, or to
        // the left near the right edge; at the top, or at the bottom for a high point.
        const px = x(p.n), tw = tip.offsetWidth || 120, th = tip.offsetHeight || 52;
        tip.style.left = (px + 12 + tw <= W ? px + 12 : px - 12 - tw) + 'px';
        tip.style.top = (y(p.v) < T + th + 8 ? H - B - th : T) + 'px';
      };
      const hide = () => { cross.setAttribute('visibility', 'hidden'); hot.setAttribute('visibility', 'hidden'); tip.hidden = true; };
      const nearest = (e) => {
        const r = root.getBoundingClientRect();
        const px = e.clientX - r.left;
        let k = 0;
        pts.forEach((p, i) => { if (Math.abs(x(p.n) - px) < Math.abs(x(pts[k].n) - px)) k = i; });
        return k;
      };
      hit.addEventListener('pointermove', (e) => show(nearest(e)));
      hit.addEventListener('pointerdown', (e) => show(nearest(e)));
      // a mouse that leaves puts the readout back on the latest time, where keys start
      hit.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') { hide(); at = pts.length - 1; } });
      root.addEventListener('focus', () => show(at));
      root.addEventListener('blur', hide);
      root.addEventListener('keydown', (e) => {
        const to = { ArrowLeft: at - 1, ArrowRight: at + 1, Home: 0, End: pts.length - 1 }[e.key];
        if (to === undefined) return;
        e.preventDefault();
        show(to);
      });
      wrap.appendChild(root);
      wrap.appendChild(tip);
      chartBox.appendChild(wrap);
    }
    let redraw = 0;
    window.addEventListener('resize', () => {
      if (section.hidden) return;
      cancelAnimationFrame(redraw);
      redraw = requestAnimationFrame(drawChart);
    });

    // ---- controls
    // Only a choice the child makes is saved: opening the Timer, or the grown-ups
    // clearing it, writes nothing to the device.
    function applySize(n, chosen) {
      data.size = n;
      if (chosen) save();
      sizeBox.querySelectorAll('.size-btn').forEach((b) => {
        b.classList.toggle('active', +b.dataset.size === n);
        b.setAttribute('aria-pressed', String(+b.dataset.size === n));
      });
      if (station.model.N !== n) station.setModel(NCube.make(n));
      lastBox.hidden = true;
      display.textContent = '0.00';
      showAll = false;
      newMix();
      renderAll();
    }
    for (const n of NCube.SIZES) {
      const b = el('button', 'size-btn', n + '×' + n);
      b.type = 'button';
      b.dataset.size = n;
      b.setAttribute('aria-label', n + ' by ' + n + ' cube');
      b.addEventListener('click', () => { if (n !== data.size) applySize(n, true); });
      sizeBox.appendChild(b);
    }
    // an iOS switch: the words say what it is, the knob says whether it is on
    function showInspect() {
      inspectBtn.setAttribute('aria-checked', String(data.inspect));
    }
    inspectBtn.addEventListener('click', () => { data.inspect = !data.inspect; save(); showInspect(); haptic('light'); abort(); });
    $('#timer-new-mix', section).addEventListener('click', newMix);

    // Touch: hold on the pad; the pointer is captured so letting go off the pad still
    // counts. Any touch anywhere stops a running clock, so a child need not aim.
    pad.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (pad.setPointerCapture) { try { pad.setPointerCapture(e.pointerId); } catch { /* synthetic event */ } }
      press();
    });
    pad.addEventListener('pointerup', () => release());
    pad.addEventListener('pointercancel', () => { clearTimeout(holdTimer); tapToInspect = false; if (phase === 'holding' || phase === 'ready') setPhase('idle'); });
    document.addEventListener('pointerdown', () => { if (!section.hidden && phase === 'running') stop(); }, true);
    document.addEventListener('pointerup', (e) => { if (!section.hidden && justStopped && e.target !== pad && !pad.contains(e.target)) justStopped = false; }, true);

    // Keyboard: the space bar is the timer here, as on every speedcubing timer. It never
    // reaches a focused button, which would otherwise be pressed by it.
    document.addEventListener('keydown', (e) => {
      if (section.hidden) return;
      if (phase === 'running') { e.preventDefault(); if (!e.repeat) stop(); return; }
      if (e.key === 'Escape') { abort(); return; }
      if (e.key !== ' ') return;
      e.preventDefault();
      if (e.repeat) return;
      if (document.activeElement && document.activeElement !== document.body && document.activeElement.blur) document.activeElement.blur();
      press();
    });
    document.addEventListener('keyup', (e) => {
      if (section.hidden) return;
      if (e.key === ' ') { e.preventDefault(); release(); }
      else if (justStopped) justStopped = false;
    });
    document.addEventListener('visibilitychange', () => { if (document.hidden) abort(); });

    showInspect();
    applySize(data.size, false);
    setPhase('idle');
    screens.timer = {
      section,
      onHide: () => { abort(); hush(); },
      onShow: drawChart,
      // after Clear saved progress on the grown-ups screen
      reload() { abort(); data = load(); showInspect(); applySize(data.size, false); },
    };
  }

  // ============================================================ GROWN-UPS
  // Not in the child's nav: the footer links lead here, one per section.
  // ---- Updates (the iOS app only)
  // The app itself asks the App Store about new versions (UpdateChecker.swift); the page
  // makes no request. This is its switch and its Check Now button, and the answer comes
  // back through window.CubeClubhouseUpdates.result().
  function buildUpdates() {
    const box = $('#updates-section');
    const bridge = root.webkit && root.webkit.messageHandlers && root.webkit.messageHandlers.updates;
    if (!box || !HOST || HOST.platform !== 'ios' || !bridge) return;
    box.hidden = false;
    if (HOST.version) $('#app-version').textContent = HOST.version;
    const toggle = $('#update-check-switch');
    const now = $('#update-check-now');
    const msg = $('#update-check-msg');
    toggle.setAttribute('aria-checked', String(HOST.updateCheck !== false));
    toggle.addEventListener('click', () => {
      const on = toggle.getAttribute('aria-checked') !== 'true';
      toggle.setAttribute('aria-checked', String(on));
      try { bridge.postMessage({ action: 'set', enabled: on }); } catch { /* the app has gone away */ }
      haptic('light');
      msg.textContent = on ? 'The app will check about once a day.' : 'The app will not check. Check Now still works.';
    });
    let waiting = null;
    const ANSWERS = {
      newer: (v) => 'Version ' + v + ' is in the App Store. Tap Update in the message to get it.',
      'up-to-date': () => 'You have the newest version.',
      unavailable: () => 'The App Store could not be reached just now. Check the internet connection and try again.',
    };
    root.CubeClubhouseUpdates = Object.freeze({
      result(r) {
        if (!waiting) return;               // only ever an answer to Check Now
        clearTimeout(waiting);
        waiting = null;
        now.disabled = false;
        const say = ANSWERS[r && r.outcome] || ANSWERS.unavailable;
        msg.textContent = say((String((r && r.version) || '').match(/^\d+(?:\.\d+)*/) || [''])[0]);
      },
    });
    now.addEventListener('click', () => {
      if (waiting) return;
      now.disabled = true;
      msg.textContent = 'Checking…';
      // The app gives up after ten seconds; this is the same, in case no answer comes.
      waiting = setTimeout(() => { root.CubeClubhouseUpdates.result({ outcome: 'unavailable' }); }, 12000);
      try { bridge.postMessage({ action: 'check' }); } catch { root.CubeClubhouseUpdates.result({ outcome: 'unavailable' }); }
    });
  }

  function buildGrownUps() {
    const section = $('#screen-grownups');
    const msg = $('#clear-progress-msg', section);
    const clearBtn = $('#clear-progress', section);
    // An iOS alert asks first: a child cannot wipe a week of stars by brushing the button.
    clearBtn.addEventListener('click', async () => {
      const ok = await askFirst({
        title: 'Clear Saved Progress?',
        message: 'This erases every star, the chosen settings and every Timer time on ' + here() + '. It cannot be undone.',
        action: 'Clear',
      });
      if (!ok) return;
      try {
        for (const key of [PROGRESS_KEY, LEGACY_PROGRESS_KEY, SIZE_KEY, SPEED_KEY, TIMER_KEY]) localStorage.removeItem(key);
        if (screens.timer) screens.timer.reload();
        msg.textContent = 'Erased. The lessons start fresh next time, and the Timer has no times.';
      } catch {
        msg.textContent = (DEVICE ? 'This ' + DEVICE : 'This browser') + ' will not let the app save or erase anything, so there was nothing stored.';
      }
    });
    section.querySelectorAll('.back-to-app').forEach((b) => b.addEventListener('click', () => showScreen('learn')));

    // Leaving the About screen stops the tour, as leaving any iOS screen stops its video.
    const tour = $('#intro-video');
    screens.grownups = { section, onHide: () => { if (tour && !tour.paused) tour.pause(); } };
  }
  const openGrownUps = (part) => {
    showScreen('grownups');
    const target = part && $('#' + part);
    if (!target) { window.scrollTo(0, 0); return; }
    // Where the top bar is sticky (not on a phone, where the tabs sit at the bottom),
    // scroll to just above the heading rather than under it.
    const bar = $('.topbar');
    const sticky = bar && getComputedStyle(bar).position === 'sticky';
    const top = target.getBoundingClientRect().top + window.scrollY - (sticky ? bar.offsetHeight : 0) - 10;
    window.scrollTo(0, Math.max(0, top));
  };

  // ================================================================ SOLVE
  function buildSolve() {
    const section = $('#screen-solve');
    const netBox = $('#solve-net', section);
    const palette = $('#solve-palette', section);
    const msg = $('#solve-msg', section);
    const station = Station($('#solve-cube', section), { size: 44 });
    let color = 'W';
    let painted = Cube.solved();
    const guideBox = $('#solve-guide', section);
    const guide = Guide(guideBox, station);
    const net = new NetView(netBox, { editable: true, onPick: (idx) => {
      painted[idx] = color;
      net.setState(painted);
      station.set(painted);
      guideBox.innerHTML = '';
      msg.textContent = '';
    } });

    for (const c of ['W', 'Y', 'G', 'B', 'R', 'O']) {
      const b = el('button', 'swatch c-' + c + (c === color ? ' active' : ''));
      b.type = 'button';
      b.title = Cube.COLOR_NAMES[c];
      b.setAttribute('aria-label', Cube.COLOR_NAMES[c]);
      b.addEventListener('click', () => {
        color = c;
        palette.querySelectorAll('.swatch').forEach((s) => s.classList.toggle('active', s === b));
      });
      palette.appendChild(b);
    }
    function setPainted(state) {
      painted = state.slice();
      net.setState(painted);
      station.set(painted);
      guideBox.innerHTML = '';
      msg.textContent = '';
    }
    $('#solve-check').addEventListener('click', () => {
      const grey = painted.filter((c) => c === 'X').length;
      if (grey) {
        msg.innerHTML = '🎨 ' + grey + (grey === 1 ? ' sticker is' : ' stickers are') + ' still grey. Paint each one to match your cube, then tap Check My Cube.';
        msg.className = 'msg bad';
        return;
      }
      const v = Cube.validate(painted);
      if (!v.ok) {
        msg.innerHTML = '🤔 ' + v.reason;
        msg.className = 'msg bad';
        return;
      }
      station.view.resetView();
      station.set(painted);
      msg.innerHTML = '✅ That is a real cube! Hold your cube like the picture, then follow the steps below.';
      msg.className = 'msg good';
      guide.start(painted);
      guideBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    // Clear means clear: every sticker but the centres goes grey, so none can be left
    // showing a colour the child never painted. The centres never move, so they stay.
    $('#solve-clear').addEventListener('click', () => {
      setPainted(Cube.solved().map((c, i) => (i % 9 === 4 ? c : 'X')));
      msg.textContent = 'All clear. Now paint every grey sticker to match your cube.';
      msg.className = 'msg';
    });
    $('#solve-random').addEventListener('click', () => setPainted(Cube.applyAlg(Cube.solved(), Cube.scramble(20))));
    $('#solve-from-play').addEventListener('click', () => {
      if (screens.play.station.model.N !== 3) {
        msg.textContent = 'Play is showing a ' + screens.play.station.model.N + '×' + screens.play.station.model.N + '. My real cube works with the 3×3.';
        msg.className = 'msg bad';
        return;
      }
      setPainted(screens.play.station.state);
    });
    explainChipsIn(section, station);
    screens.solve = { section, station };
  }

  // -------------------------------------------------------------- extras
  function confetti() {
    const box = el('div', 'confetti');
    for (let i = 0; i < 60; i++) {
      const p = el('i');
      p.style.left = Math.random() * 100 + 'vw';
      p.style.animationDelay = Math.random() * 0.8 + 's';
      p.style.background = ['#ffd500', '#009b48', '#0046ad', '#b71234', '#ff5800', '#fff'][i % 6];
      box.appendChild(p);
    }
    document.body.appendChild(box);
    setTimeout(() => box.remove(), 3500);
  }

  // Switching app or tab should not leave a voice talking to an empty room.
  function stopSpeakingWhenHidden() {
    document.addEventListener('visibilitychange', () => { if (document.hidden) hush(); });
  }

  // U D L R F B turn a side and X Y Z the whole cube; Shift gives the ′ turn. On a big
  // cube a digit typed first picks the layer: 2 then R is 2R, the second layer in.
  function keyboard() {
    let layer = 0, layerTimer = null;
    const dropLayer = () => { layer = 0; clearTimeout(layerTimer); };
    document.addEventListener('keydown', (e) => {
      if (e.target.matches && e.target.matches('input, textarea, select, [contenteditable]')) return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1) return;
      const active = Object.keys(screens).find((k) => !screens[k].section.hidden);
      const station = active === 'play' ? screens.play.station
        : active === 'learn' && !$('#lesson-view').hidden ? screens.learn.station : null;
      if (!station) return;
      const key = e.key.toUpperCase();
      if (/^[2-9]$/.test(key)) {
        e.preventDefault();
        if (e.repeat) return;
        layer = +key;
        clearTimeout(layerTimer);
        layerTimer = setTimeout(dropLayer, 2000);
        return;
      }
      let token;
      if ('UDLRFB'.includes(key)) token = (layer || '') + key;
      else if ('XYZ'.includes(key)) token = key.toLowerCase();
      else { dropLayer(); return; }
      dropLayer();
      e.preventDefault();
      // Holding a key down repeats it many times a second. Each repeat would queue a
      // turn, and the cube would go on spinning for seconds after the key came up.
      if (e.repeat) return;
      if (e.shiftKey) token += "'";
      try { station.model.parseMove(token); } catch { return; }   // no such layer on this cube
      if (active === 'play') screens.play.userMove(token);
      else station.move(token);
    });
  }

  // --------------------------------------------------------------- boot
  document.addEventListener('DOMContentLoaded', () => {
    buildLearn();
    buildPlay();
    buildSolve();
    buildTimer();
    buildGrownUps();
    buildUpdates();
    keyboard();
    stopSpeakingWhenHidden();
    document.querySelectorAll('nav button[data-screen]').forEach((b) => b.addEventListener('click', () => showScreen(b.dataset.screen)));
    document.querySelectorAll('.foot-links [data-info]').forEach((b) => b.addEventListener('click', () => openGrownUps(b.dataset.info)));
    document.querySelectorAll('.info-nav a, .info-card a[href^="#"]').forEach((a) => a.addEventListener('click', (e) => {
      e.preventDefault();                       // the hash belongs to the screens, not the sections
      openGrownUps(a.getAttribute('href').slice(1));
    }));
    // A link straight to one of the grown-ups sections opens that screen at it.
    const INFO_PARTS = ['parents', 'privacy', 'licence'];
    const go = (raw) => {
      if (INFO_PARTS.includes(raw)) { openGrownUps(raw); return true; }
      if (Object.prototype.hasOwnProperty.call(screens, raw)) { showScreen(raw); return true; }
      return false;
    };
    // hasOwnProperty inside go(), so that a hash like #toString cannot hide every
    // screen at once; anything unknown lands on the lessons rather than nowhere.
    window.addEventListener('hashchange', () => { if (!go(location.hash.replace('#', ''))) showScreen('learn'); });
    if (!go(location.hash.replace('#', ''))) showScreen('learn');
  });
})(window);
