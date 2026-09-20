/*
 * app.js - Cube Clubhouse user interface.
 *
 * Screens:  Learn (lessons + practice)   Play (free play, timer, help)   Solve (paint your cube, guided solve)
 * Shared:   MovePad (buttons for moves)  Guide (step-by-step walkthrough from the solver)
 */
(function (root) {
  'use strict';
  const { Cube, Solver, CubeView, NetView, LESSONS, MOVE_WORDS, STAGE_TITLES } = root.RC;

  const $ = (sel, el) => (el || document).querySelector(sel);
  const el = (tag, cls, html) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  };
  const speakable = (text) => text.replace(/\b([UDLRFBxyz])'/g, '$1 prime').replace(/\b([UDLRFBxyz])2\b/g, '$1 two');
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
  const words = (m) => MOVE_WORDS[m] || m;
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
  // A Read button reads aloud, and says "Stop" while it is reading, so a child can
  // press the same button again to stop it. An empty label makes an icon-only button.
  const readButton = (getText, label, cls) => {
    const icon = label === '';
    const idle = icon ? '🔊' : '🔊 ' + (label || 'Read to me');
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
  const moveChips = (moves) => Cube.parseAlg(moves).map((m) => '<button type="button" class="chip' + (Cube.parseMove(m).isRotation ? ' rot' : '') + '" data-move="' + m + '" aria-label="' + m + ': ' + (MOVE_WORDS[m] || m) + '">' + m + '</button>').join('');
  const plain = (html) => html.replace(/<[^>]+>/g, '');

  // Wire up chip taps for one screen: show the words, say them, and wiggle the cube.
  function explainChipsIn(section, station) {
    section.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip[data-move]');
      if (!chip) return;
      const m = chip.dataset.move;
      const words = MOVE_WORDS[m] || m;
      const box = chip.parentElement;
      let cap = box.nextElementSibling;
      if (!cap || !cap.classList.contains('chip-words')) {
        cap = el('div', 'chip-words');
        cap.setAttribute('aria-live', 'polite');
        box.after(cap);
      }
      cap.innerHTML = '<b>' + m + '</b> ' + words;
      speak(m + '. ' + words);
      station.demo(m);
    });
  }

  // ------------------------------------------------------------ progress
  const PROGRESS_KEY = 'cubeclubhouse.progress';
  const LEGACY_PROGRESS_KEY = 'cubebuddy.progress';   // the app's earlier name
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
  const PAD_ROWS = [
    ['U', "U'", 'L', "L'", 'F', "F'"],
    ['R', "R'", 'B', "B'", 'D', "D'"],
    ['y', "y'", 'x', "x'"],
  ];
  function MovePad(container, onMove) {
    container.classList.add('move-pad');
    container.innerHTML = '';
    for (const row of PAD_ROWS) {
      const r = el('div', 'pad-row');
      for (const m of row) {
        const b = el('button', 'pad-btn' + (Cube.parseMove(m).isRotation ? ' rot' : ''), m.replace("'", '<sup>′</sup>'));
        b.type = 'button';
        b.title = MOVE_WORDS[m];
        b.setAttribute('aria-label', MOVE_WORDS[m]);
        b.addEventListener('click', () => onMove(m));
        r.appendChild(b);
      }
      container.appendChild(r);
    }
    const hasKeyboard = !window.matchMedia || window.matchMedia('(hover: hover)').matches;
    const hint = el('div', 'pad-hint', hasKeyboard
      ? 'Drag the cube to look around. Keyboard: U, D, L, R, F or B turn a side; hold Shift for the ′ turn.'
      : 'Drag the cube to look around.');
    container.appendChild(hint);
  }

  // A cube "station": a 3D view plus the state that the app trusts.
  function Station(container, options) {
    const view = new CubeView(container, options);
    const st = {
      view,
      state: Cube.solved(),
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
      move(token, duration) {
        st.state = Cube.applyMove(st.state, token);
        st.history.push(token);
        st.emit();
        return view.play([token], duration);
      },
      play(moves, duration, onMove) {
        const tokens = Cube.parseAlg(moves);
        st.state = Cube.applyAlg(st.state, tokens);
        st.history.push(...tokens);
        st.emit();
        return view.play(tokens, duration, onMove);
      },
      // Show one move and take it straight back. Only the picture moves: st.state is
      // untouched, so a hint, the guide and the practice goal all stay exactly as they
      // were. If the cube is replaced mid-wiggle, set() repaints it, so nothing is lost.
      demo(token) {
        return view.play([token, Cube.invertMove(token)], 450);
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
        const inv = Cube.invertMove(last);
        st.state = Cube.applyMove(st.state, inv);
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
    let watchedAll = false;   // the app did the solve, so do not praise the child for it

    function start(state) {
      let res;
      try {
        res = Solver.solve(state);
      } catch (e) {
        const why = e && e.internal
          ? 'Something went wrong on my side. Press Mix it up and try again.'
          : ((e && e.message) || 'One of the stickers does not look right.') + ' Let\'s check the stickers together.';
        container.innerHTML = '<div class="guide-error">Hmm, this does not look like a real cube yet. ' + why + '</div>';
        return false;
      }
      steps = mergeSteps(res.steps);
      i = 0;
      shown = false;
      busy = false;
      watchedAll = false;
      render();
      return true;
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
          const again = el('button', 'btn primary', '◀ Start from the first step');
          again.addEventListener('click', () => {
            let s = station.state;
            for (let k = steps.length - 1; k >= 0; k--) s = Cube.applyAlg(s, Cube.invertAlg(steps[k].moves));
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
      for (const st of stages) {
        const idx = Solver.STAGES.indexOf(st);
        const curIdx = Solver.STAGES.indexOf(step.stage);
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
      const showBtn = el('button', 'btn primary', shown ? '▶ Watch again' : '▶ Watch');
      const nextBtn = el('button', 'btn', 'I did it ▶');
      const backBtn = el('button', 'btn ghost', '◀ Last step');
      const sayBtn = readButton(() => step.text + ' ' + movesInWords(step.moves), 'Read', 'btn ghost');
      const autoBtn = el('button', 'btn ghost', '⏩ Watch the whole solve');
      backBtn.disabled = i === 0;
      showBtn.addEventListener('click', async () => {
        if (busy) return;
        if (shown) {
          // rewind this step first, then play it again
          busy = true;
          station.set(Cube.applyAlg(station.state, Cube.invertAlg(step.moves)));
          busy = false;
        }
        busy = true;
        station.view.setHighlights(step.highlight);
        await station.play(step.moves, 380);
        station.view.setHighlights([]);
        shown = true;
        busy = false;
        showBtn.textContent = '▶ Watch again';
        nextBtn.classList.add('primary');
        showBtn.classList.remove('primary');
      });
      nextBtn.addEventListener('click', () => {
        if (busy) return;
        if (!shown) station.set(Cube.applyAlg(station.state, step.moves));
        i++;
        shown = false;
        render();
      });
      backBtn.addEventListener('click', () => {
        if (busy || i === 0) return;
        if (shown) station.set(Cube.applyAlg(station.state, Cube.invertAlg(step.moves)));
        i--;
        station.set(Cube.applyAlg(station.state, Cube.invertAlg(steps[i].moves)));
        shown = false;
        render();
      });
      autoBtn.addEventListener('click', async () => {
        if (busy) return;
        busy = true;
        try {
          if (shown) { i++; shown = false; }
          const myGen = station.view.gen;
          for (; i < steps.length; i++) {
            // The guide panel can be torn down mid-run (a manual move, a new cube),
            // and the cube can be replaced under us. Either way, stop quietly.
            const textEl = $('.guide-text', container);
            const movesEl = $('.guide-moves', container);
            if (!textEl || !movesEl || station.view.gen !== myGen) return;
            const st = steps[i];
            const same = steps.filter((s) => s.stage === st.stage);
            count.textContent = STAGE_TITLES[st.stage] + ' · step ' + (same.indexOf(st) + 1) + ' of ' + same.length;
            textEl.textContent = st.text;
            movesEl.innerHTML = stepChips(st.moves);
            station.view.setHighlights(steps[i].highlight);
            await station.play(steps[i].moves, 140);
          }
        } finally {
          busy = false;
        }
        watchedAll = true;
        render();
      });
      btns.append(showBtn, nextBtn, backBtn, sayBtn);
      if (!opts.compact) btns.append(autoBtn);
      container.appendChild(btns);
      station.view.setHighlights(step.highlight);
    }

    return { start, get steps() { return steps; } };
  }

  // ------------------------------------------------------------- screens
  const screens = {};
  function showScreen(name) {
    hush();
    for (const k of Object.keys(screens)) {
      screens[k].section.hidden = k !== name;
      $('nav button[data-screen="' + k + '"]').classList.toggle('active', k === name);
    }
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
      $('#lesson-next').textContent = n === LESSONS.length - 1 ? 'Back to lessons' : 'Next lesson ▶';
      renderAlgs(L);
      renderInteractive(L);
      renderPractice(L);
      station.view.resetView();
      station.set(L.stage ? practiceCube(L.stage) : Cube.solved());
      window.scrollTo(0, 0);
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
        watch.addEventListener('click', () => station.play(a.moves, 380));
        undo.addEventListener('click', () => station.play(Cube.invertAlg(a.moves), 200));
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
          'Lights off': [],
        };
        for (const name of Object.keys(groups)) {
          const b = el('button', 'btn small', name);
          b.addEventListener('click', () => {
            station.view.setHighlights(groups[name]);
            const fact = { Centres: '6 centres. They never move!', Edges: '12 edges with 2 colours each.', Corners: '8 corners with 3 colours each.', 'Lights off': '' }[name];
            $('#parts-fact').textContent = fact;
          });
          row.appendChild(b);
        }
        box.appendChild(row);
        const fact = el('p', 'fact', 'Tap a button to light up that kind of block.');
        fact.id = 'parts-fact';
        box.appendChild(fact);
        const spin = el('button', 'btn small ghost', '🔄 Turn the right side');
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
      const go = el('button', 'btn primary', '▶ Do a move');
      const again = el('button', 'btn ghost', '▶ Show it again');
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
              status.textContent = 'Almost! It was ' + answer + ': ' + MOVE_WORDS[answer] + ' Press Show it again to see it. Best so far: ' + best + ' in a row.';
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
      if (!L.stage) return;
      box.appendChild(el('h3', '', '🎮 Your turn'));
      const intro = el('p', '', 'This is a pretend cube on the screen, not your real one. It is set up for this step. Use the buttons under the cube and try it. Stuck? Press <b>Hint</b>.');
      const status = el('div', 'practice-status', 'Goal: ' + L.subtitle);
      const row = el('div', 'btn-row');
      const hintBtn = el('button', 'btn primary', '💡 Hint');
      const newBtn = el('button', 'btn ghost', '🎲 Another puzzle');
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
          // doing it without any earns a separate brain badge on top.
          award(L.id, 3, hintsUsed === 0);
          renderList();
          station.settled().then(() => {
            status.innerHTML = '🎉 <b>You did it!</b> ★★★' + (hintsUsed ? '' : ' 🧠 No hints!');
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
          hintBox.appendChild(el('p', 'guide-warn', 'Oops, the ' + STAGE_TITLES[one.stage].toLowerCase() + ' came apart. That happens to everyone! Press Undo a few times, or follow the hints to fix it.'));
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
      newBtn.addEventListener('click', () => {
        solvedThis = false;
        hintsUsed = 0;
        hintFor = null;
        status.textContent = 'Goal: ' + L.subtitle;
        status.classList.remove('win');
        hintBox.hidden = true;
        station.set(practiceCube(L.stage));
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
    renderList();
    screens.learn = { section, station, openLesson };
  }

  // ================================================================= PLAY
  function buildPlay() {
    const section = $('#screen-play');
    const station = Station($('#play-cube', section), { size: 60 });
    const timerEl = $('#play-timer', section);
    const statusEl = $('#play-status', section);
    const guideBox = $('#play-guide', section);
    let timerStart = null, timerId = null, scrambled = false, moveCount = 0;
    const guide = Guide(guideBox, station, { onFinish: () => { stopTimer(); } });

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
      if (Cube.isSolved(state) && scrambled && timerStart) {
        const took = Date.now() - timerStart;      // the solve ended on this move
        const moves = moveCount;
        stopTimer();
        scrambled = false;
        station.settled().then(() => {
          statusEl.innerHTML = '🎉 <b>Solved</b> in ' + fmt(took) + ' with ' + moves + (moves === 1 ? ' move!' : ' moves!');
          confetti();
        });
      }
    });
    function staleGuide() {
      if (!guideBox.childElementCount) return;
      guideBox.innerHTML = '';
      statusEl.textContent = 'You made your own move, so the steps changed. Press "Help me solve it" for new steps.';
    }
    function userMove(m) {
      staleGuide();
      if (scrambled && !timerId) startTimer();
      moveCount++;
      station.move(m);
    }
    MovePad($('#play-controls', section), userMove);
    explainChipsIn(section, station);
    $('#play-scramble').addEventListener('click', async () => {
      guideBox.innerHTML = '';
      stopTimer();
      timerEl.textContent = '00:00';
      timerStart = null;
      moveCount = 0;
      statusEl.textContent = 'Mixing it up…';
      station.set(Cube.solved());
      await station.play(Cube.scramble(20), 90);
      scrambled = true;
      statusEl.textContent = 'Go! The clock starts on your first move. Stuck? Press "Help me solve it".';
    });
    $('#play-reset').addEventListener('click', () => {
      guideBox.innerHTML = '';
      stopTimer();
      timerEl.textContent = '00:00';
      scrambled = false;
      moveCount = 0;
      station.set(Cube.solved());
      statusEl.textContent = 'The cube is solved. Press Mix it up to start.';
    });
    $('#play-undo').addEventListener('click', () => {
      staleGuide();
      station.undo();
    });
    $('#play-help').addEventListener('click', () => {
      stopTimer();
      scrambled = false;
      guide.start(station.state);
      guideBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
    $('#play-reset-view').addEventListener('click', () => station.view.resetView());
    screens.play = { section, station, userMove };
  }

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
      const v = Cube.validate(painted);
      if (!v.ok) {
        msg.innerHTML = '🤔 ' + v.reason;
        msg.className = 'msg bad';
        return;
      }
      msg.innerHTML = '✅ That is a real cube! Hold your cube like the picture, then follow the steps below.';
      msg.className = 'msg good';
      station.view.resetView();
      station.set(painted);
      guide.start(painted);
      guideBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    $('#solve-clear').addEventListener('click', () => setPainted(Cube.solved()));
    $('#solve-random').addEventListener('click', () => setPainted(Cube.applyAlg(Cube.solved(), Cube.scramble(20))));
    $('#solve-from-play').addEventListener('click', () => setPainted(screens.play.station.state));
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

  function keyboard() {
    document.addEventListener('keydown', (e) => {
      if (e.target.matches('input, textarea, select, [contenteditable]')) return;
      const letter = e.key.toUpperCase();
      if (!'UDLRFB'.includes(letter) || e.ctrlKey || e.metaKey || e.altKey || letter.length !== 1) return;
      const active = Object.keys(screens).find((k) => !screens[k].section.hidden);
      if (!active) return;
      const token = letter + (e.shiftKey ? "'" : '');
      if (active === 'play') screens.play.userMove(token);
      else if (active === 'learn' && !$('#lesson-view').hidden) screens.learn.station.move(token);
      else return;
      e.preventDefault();
    });
  }

  // --------------------------------------------------------------- boot
  document.addEventListener('DOMContentLoaded', () => {
    buildLearn();
    buildPlay();
    buildSolve();
    keyboard();
    stopSpeakingWhenHidden();
    document.querySelectorAll('nav button[data-screen]').forEach((b) => b.addEventListener('click', () => showScreen(b.dataset.screen)));
    window.addEventListener('hashchange', () => {
      const n = location.hash.replace('#', '');
      if (Object.prototype.hasOwnProperty.call(screens, n)) showScreen(n);
    });
    const start = location.hash.replace('#', '');
    // hasOwnProperty, so that a hash like #toString cannot hide every screen at once
    showScreen(Object.prototype.hasOwnProperty.call(screens, start) ? start : 'learn');
  });
})(window);
