/*
 * app.js - Cube Buddy user interface.
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
  function speak(text) {
    if (!('speechSynthesis' in window)) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(speakable(text));
    u.rate = 0.95;
    speechSynthesis.speak(u);
  }
  const moveChips = (moves) => Cube.parseAlg(moves).map((m) => '<span class="chip' + (Cube.parseMove(m).isRotation ? ' rot' : '') + '" title="' + (MOVE_WORDS[m] || m) + '">' + m + '</span>').join('');

  // ------------------------------------------------------------ progress
  const PROGRESS_KEY = 'cubebuddy.progress';
  function loadProgress() {
    try {
      const p = JSON.parse(localStorage.getItem(PROGRESS_KEY));
      return p && typeof p === 'object' && !Array.isArray(p) ? p : {};
    } catch { return {}; }   // private mode, blocked site data, or junk
  }
  function saveProgress(p) {
    try { localStorage.setItem(PROGRESS_KEY, JSON.stringify(p)); } catch { /* private mode, or the quota is full */ }
  }
  let progress = loadProgress();
  function award(lessonId, stars) {
    progress[lessonId] = Math.max(progress[lessonId] || 0, stars);
    saveProgress(progress);
  }
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
    const hint = el('div', 'pad-hint', 'Keyboard: press U, D, L, R, F or B to turn a side; hold Shift for the ′ (prime) turn. Drag the cube to look around.');
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

  // ---------------------------------------------------------------- Guide
  // Walks through solver steps on a station. `filterStage` limits to one stage (lesson hints).
  function Guide(container, station, options) {
    const opts = Object.assign({ onFinish: null, compact: false }, options || {});
    let steps = [];
    let i = 0;
    let shown = false;   // has the current step been animated already?
    let busy = false;

    function start(state) {
      let res;
      try {
        res = Solver.solve(state);
      } catch (e) {
        const why = e && e.internal
          ? 'Something went wrong on my side. Press Scramble and try again.'
          : (e && e.message) || 'I do not recognise this cube.';
        container.innerHTML = '<div class="guide-error">Hmm, I cannot solve this cube. ' + why + '</div>';
        return false;
      }
      steps = res.steps;
      i = 0;
      shown = false;
      busy = false;
      render();
      return true;
    }

    function stagesOf() {
      const seen = [];
      for (const s of steps) if (!seen.includes(s.stage)) seen.push(s.stage);
      return seen;
    }

    function render() {
      container.innerHTML = '';
      container.classList.add('guide');
      if (steps.length === 0) {
        container.appendChild(el('div', 'guide-done', '🎉 The cube is already solved. Amazing!'));
        if (opts.onFinish) opts.onFinish();
        return;
      }
      if (i >= steps.length) {
        container.appendChild(el('div', 'guide-done', '🎉 <b>You solved it!</b> Take a bow, cube master!'));
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
      const count = el('div', 'guide-count', 'Step ' + (i + 1) + ' of ' + steps.length + ' · ' + STAGE_TITLES[step.stage]);
      container.appendChild(count);
      container.appendChild(el('p', 'guide-text', step.text));
      container.appendChild(el('div', 'guide-moves', moveChips(step.moves)));
      const words = el('ul', 'guide-words');
      for (const m of step.moves.slice(0, 12)) words.appendChild(el('li', '', '<b>' + m + '</b> – ' + (MOVE_WORDS[m] || '')));
      if (step.moves.length > 12) words.appendChild(el('li', '', '… and so on, the same pattern.'));
      container.appendChild(words);

      const btns = el('div', 'guide-btns');
      const showBtn = el('button', 'btn primary', shown ? '▶ Show me again' : '▶ Show me');
      const nextBtn = el('button', 'btn', 'Next ▶');
      const backBtn = el('button', 'btn ghost', '◀ Back');
      const sayBtn = el('button', 'btn ghost', '🔊 Read');
      const autoBtn = el('button', 'btn ghost', '⏩ Do it all for me');
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
        showBtn.textContent = '▶ Show me again';
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
      sayBtn.addEventListener('click', () => speak(step.text + ' The moves are: ' + step.moves.join(', ')));
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
            count.textContent = 'Step ' + (i + 1) + ' of ' + steps.length + ' · ' + STAGE_TITLES[steps[i].stage];
            textEl.textContent = steps[i].text;
            movesEl.innerHTML = moveChips(steps[i].moves);
            station.view.setHighlights(steps[i].highlight);
            await station.play(steps[i].moves, 140);
          }
        } finally {
          busy = false;
        }
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
        card.innerHTML = '<span class="lesson-num">' + (n + 1) + '</span><span class="lesson-emoji">' + L.emoji + '</span><span class="lesson-name">' + L.title + '</span><span class="lesson-sub">' + L.subtitle + '</span><span class="stars">' + (L.stage || L.interactive === 'notation' ? starString(stars) : '') + '</span>';
        card.addEventListener('click', () => openLesson(n));
        list.appendChild(card);
      });
    }

    function openLesson(n) {
      current = n;
      const L = LESSONS[n];
      list.hidden = true;
      viewWrap.hidden = false;
      $('#lesson-title').textContent = L.emoji + ' ' + L.title;
      $('#lesson-subtitle').textContent = L.subtitle;
      $('#lesson-story').innerHTML = L.story.map((p) => '<p>' + p + '</p>').join('');
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
        const say = el('button', 'btn small ghost', '🔊');
        watch.addEventListener('click', () => station.play(a.moves, 380));
        undo.addEventListener('click', () => station.play(Cube.invertAlg(a.moves), 200));
        say.addEventListener('click', () => speak(a.name + ': ' + a.moves.split(' ').join(', ')));
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
          Clear: [],
        };
        for (const name of Object.keys(groups)) {
          const b = el('button', 'btn small', name);
          b.addEventListener('click', () => {
            station.view.setHighlights(groups[name]);
            const fact = { Centres: '6 centres. They never move!', Edges: '12 edges with 2 colours each.', Corners: '8 corners with 3 colours each.', Clear: '' }[name];
            $('#parts-fact').textContent = fact;
          });
          row.appendChild(b);
        }
        box.appendChild(row);
        const fact = el('p', 'fact', 'Tap a button to light up that kind of block.');
        fact.id = 'parts-fact';
        box.appendChild(fact);
        const spin = el('button', 'btn small ghost', '🔄 Spin one side (R)');
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
      const go = el('button', 'btn primary', '▶ Play a move');
      let answer = null, streak = 0, best = 0;
      const pool = ['U', "U'", 'D', "D'", 'L', "L'", 'R', "R'", 'F', "F'", 'B', "B'"];
      go.addEventListener('click', async () => {
        choices.innerHTML = '';
        station.set(Cube.solved());
        answer = pool[Math.floor(Math.random() * pool.length)];
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
              status.textContent = '✅ Yes! That was ' + answer + '. Streak: ' + streak;
              if (streak >= 5) { award('moves', 3); status.textContent += ' 🌟 Three stars!'; renderList(); }
              else if (streak >= 2) award('moves', Math.max(progress.moves || 0, 1));
            } else {
              status.textContent = '❌ Not quite. It was ' + answer + ' (' + MOVE_WORDS[answer] + '). Streak: 0';
              streak = 0;
              award('moves', Math.max(progress.moves || 0, 1));
            }
            answer = null;
            choices.innerHTML = '';
          });
          choices.appendChild(b);
        });
      });
      q.append(go, choices, status);
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
      const intro = el('p', '', 'The cube next to this text is ready for this step. Use the move buttons under the cube (or your keyboard) and try it yourself. Press <b>Hint</b> if you get stuck.');
      const status = el('div', 'practice-status', 'Goal: ' + L.subtitle);
      const row = el('div', 'btn-row');
      const hintBtn = el('button', 'btn primary', '💡 Hint');
      const newBtn = el('button', 'btn ghost', '🎲 New cube');
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
          hintBox.hidden = true;
          station.view.setHighlights([]);
        }
        if (solvedThis) return;
        if (Solver.goals[L.stage](state)) {
          solvedThis = true;                       // latch now so this fires exactly once
          const stars = hintsUsed === 0 ? 3 : 2;
          award(L.id, stars);
          renderList();
          station.settled().then(() => {
            status.innerHTML = '🎉 <b>You did it!</b> ' + starString(stars) + (hintsUsed ? ' (Try again without hints for 3 stars.)' : ' Perfect, no hints!');
            status.classList.add('win');
            hintBox.hidden = true;
            station.view.setHighlights([]);
          });
        }
      }
      station.onChange(check);

      hintBtn.addEventListener('click', () => {
        hintsUsed++;
        hintBox.hidden = false;
        const one = nextStep();
        if (!one) { hintBox.innerHTML = '<div class="guide-done">This step is already done. Nice!</div>'; return; }
        hintFor = Cube.toString(station.state);
        hintBox.innerHTML = '';
        const stageIdx = Solver.STAGES.indexOf(L.stage);
        if (one.stage !== 'orient' && Solver.STAGES.indexOf(one.stage) < stageIdx) {
          hintBox.appendChild(el('p', 'guide-warn', '😮 Uh-oh, an earlier part got broken: the ' + STAGE_TITLES[one.stage].toLowerCase() + '. Press Undo a few times to go back, or follow the hints to rebuild it.'));
        }
        hintBox.appendChild(el('p', 'guide-text', '💡 ' + one.text));
        hintBox.appendChild(el('div', 'guide-moves', moveChips(one.moves)));
        const b = el('button', 'btn small primary', '▶ Show me');
        b.addEventListener('click', async () => {
          const fresh = nextStep();          // the cube may have moved since the hint
          if (!fresh) return;
          hintFor = null;                    // this play is ours, do not retire the hint
          station.view.setHighlights(fresh.highlight);
          await station.play(fresh.moves, 380);
          station.view.setHighlights([]);
          hintFor = Cube.toString(station.state);
        });
        hintBox.appendChild(b);
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
      statusEl.textContent = 'You moved the cube yourself. Press "Help me solve it" again for fresh steps.';
    }
    function userMove(m) {
      staleGuide();
      if (scrambled && !timerId) startTimer();
      moveCount++;
      station.move(m);
    }
    MovePad($('#play-controls', section), userMove);
    $('#play-scramble').addEventListener('click', async () => {
      guideBox.innerHTML = '';
      stopTimer();
      timerEl.textContent = '00:00';
      timerStart = null;
      moveCount = 0;
      statusEl.textContent = 'Scrambling…';
      station.set(Cube.solved());
      await station.play(Cube.scramble(20), 90);
      scrambled = true;
      statusEl.textContent = 'Go! The timer starts on your first move. Stuck? Press "Help me solve it".';
    });
    $('#play-reset').addEventListener('click', () => {
      guideBox.innerHTML = '';
      stopTimer();
      timerEl.textContent = '00:00';
      scrambled = false;
      moveCount = 0;
      station.set(Cube.solved());
      statusEl.textContent = 'Fresh cube. Press Scramble to start a challenge.';
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
      msg.innerHTML = '✅ That is a real cube! Follow the steps below. Hold your cube exactly like the picture.';
      msg.className = 'msg good';
      station.set(painted);
      guide.start(painted);
      guideBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    $('#solve-clear').addEventListener('click', () => setPainted(Cube.solved()));
    $('#solve-random').addEventListener('click', () => setPainted(Cube.applyAlg(Cube.solved(), Cube.scramble(20))));
    $('#solve-from-play').addEventListener('click', () => setPainted(screens.play.station.state));
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
