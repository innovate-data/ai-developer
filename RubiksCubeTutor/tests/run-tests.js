/* Node test-suite for the cube model and the beginner solver.  Run: node tests/run-tests.js */
const assert = require('assert');
const Cube = require('../js/cube.js');
const Solver = require('../js/solver.js');
const NCube = require('../js/ncube.js');
const BigSolver = require('../js/bigsolver.js');
const Store = require('../js/store.js');

let passed = 0;
const waiting = [];          // tests that answer later, awaited before the summary
function test(name, fn) {
  const ok = () => { passed++; console.log('ok   ' + name); };
  const bad = (e) => { console.log('FAIL ' + name + '\n     ' + (e && e.message)); process.exitCode = 1; };
  try {
    const result = fn();
    if (result && typeof result.then === 'function') waiting.push(result.then(ok, bad));
    else ok();
  } catch (e) { bad(e); }
}
const eq = (a, b) => Cube.toString(a) === Cube.toString(b);
const S = Cube.solved();

// deterministic RNG so failures are reproducible
function rng(seed) { let x = seed >>> 0 || 1; return () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; }; }

test('every move has order 4 and a working inverse', () => {
  for (const m of ['U', 'D', 'L', 'R', 'F', 'B', 'x', 'y', 'z', 'M', 'E', 'S', 'r', 'u', 'f']) {
    let t = S; for (let i = 0; i < 4; i++) t = Cube.applyMove(t, m);
    assert(eq(t, S), m + ' x4');
    assert(eq(Cube.applyAlg(Cube.applyMove(S, m), m + "'"), S), m + ' inverse');
    assert(eq(Cube.applyAlg(S, [m, m]), Cube.applyMove(S, m + '2')), m + ' double');
  }
});
test('R U R\' U\' has order 6', () => {
  let t = S; for (let i = 0; i < 6; i++) t = Cube.applyAlg(t, "R U R' U'");
  assert(eq(t, S));
  t = S; for (let i = 0; i < 3; i++) t = Cube.applyAlg(t, "R U R' U'");
  assert(!eq(t, S));
});
test('rotations equal their slice/face equivalents', () => {
  assert(eq(Cube.applyMove(S, 'x'), Cube.applyAlg(S, "R M' L'")));
  assert(eq(Cube.applyMove(S, 'y'), Cube.applyAlg(S, "U E' D'")));
  assert(eq(Cube.applyMove(S, 'z'), Cube.applyAlg(S, "F S B'")));
});
test('U sends the UF edge to UL; y brings the right face to the front', () => {
  assert.strictEqual(Cube.pieceColors(Cube.applyMove(S, 'U'), Cube.pieceAt('UL')).join(''), Cube.pieceColors(S, Cube.pieceAt('UF')).join(''));
  assert.strictEqual(Cube.center(Cube.applyMove(S, 'y'), 'F'), Cube.SOLVED_FACE_COLORS.R);
});
test('invertAlg undoes an algorithm', () => {
  const alg = "R U2 F' L D B2 x y' M";
  assert(eq(Cube.applyAlg(Cube.applyAlg(S, alg), Cube.invertAlg(alg)), S));
});
test('validate accepts scrambled and rotated cubes', () => {
  const r = rng(7);
  for (let i = 0; i < 50; i++) {
    const s = Cube.applyAlg(S, Cube.scramble(30, r));
    assert(Cube.validate(s).ok);
    assert(Cube.validate(Cube.applyAlg(s, ['x', "y'", 'z2'][i % 3])).ok);
  }
});
test('validate rejects a twisted corner, a flipped edge and a swapped pair', () => {
  const s = Cube.applyAlg(S, Cube.scramble(20, rng(3)));
  const tw = s.slice(); const c = Cube.pieceAt('UFR');
  const v = c.idx.map((i) => tw[i]); tw[c.idx[0]] = v[1]; tw[c.idx[1]] = v[2]; tw[c.idx[2]] = v[0];
  assert(!Cube.validate(tw).ok && /twisted/.test(Cube.validate(tw).reason));
  const fl = s.slice(); const e = Cube.pieceAt('UF'); [fl[e.idx[0]], fl[e.idx[1]]] = [fl[e.idx[1]], fl[e.idx[0]]];
  assert(!Cube.validate(fl).ok && /flipped/.test(Cube.validate(fl).reason));
  const sw = s.slice(); const e1 = Cube.pieceAt('UF'), e2 = Cube.pieceAt('UB');
  for (let i = 0; i < 2; i++) { const t = sw[e1.idx[i]]; sw[e1.idx[i]] = sw[e2.idx[i]]; sw[e2.idx[i]] = t; }
  assert(!Cube.validate(sw).ok && /swapped/.test(Cube.validate(sw).reason));
  const bad = s.slice(); bad[0] = bad[0] === 'W' ? 'Y' : 'W';
  assert(!Cube.validate(bad).ok);
});
test('lesson algorithms keep the first two layers intact', () => {
  for (const key of ['yellowCross', 'yellowEdges', 'yellowCorners']) {
    const s = Cube.applyAlg(S, Solver.ALGS[key]);
    assert(Solver.goals.middle(s), key + ' disturbs F2L');
  }
});
test('solver handles the solved cube and each single face turn', () => {
  assert.strictEqual(Solver.solve(S).steps.length, 0);
  for (const m of ['U', "U'", 'D', 'R2', 'F', 'B', 'L']) {
    const r = Solver.solve(Cube.applyMove(S, m));
    assert(Cube.isSolved(r.state), m);
  }
});
test('solver solves 400 random scrambles with stages in order', () => {
  const r = rng(12345);
  let totalMoves = 0, maxMoves = 0;
  for (let i = 0; i < 400; i++) {
    const scr = Cube.scramble(25, r);
    let s = Cube.applyAlg(S, scr);
    if (i % 4 === 0) s = Cube.applyAlg(s, ['x', 'y', "z'", 'x2'][(i / 4) % 4 | 0]);
    let res;
    try { res = Solver.solve(s); } catch (e) { throw new Error('scramble ' + scr.join(' ') + ': ' + e.message); }
    assert(Cube.isSolved(res.state), 'not solved: ' + scr.join(' '));
    // replaying the steps must reproduce the final state, and stages must be monotonic
    let replay = s, lastStage = -1;
    for (const st of res.steps) {
      const idx = Solver.STAGES.indexOf(st.stage);
      assert(idx >= lastStage, 'stage order broken');
      lastStage = idx;
      assert(st.text && st.text.length > 10, 'step without text');
      replay = Cube.applyAlg(replay, st.moves);
    }
    assert(eq(replay, res.state));
    // after the last step of each stage the stage goal holds
    let cur = s;
    for (let k = 0; k < res.steps.length; k++) {
      cur = Cube.applyAlg(cur, res.steps[k].moves);
      const st = res.steps[k].stage;
      if (k === res.steps.length - 1 || res.steps[k + 1].stage !== st) {
        assert(Solver.goals[st](cur), 'goal ' + st + ' not met after its steps for ' + scr.join(' '));
      }
    }
    const n = res.steps.reduce((a, b) => a + b.moves.length, 0);
    totalMoves += n; maxMoves = Math.max(maxMoves, n);
  }
  console.log('     average moves ' + (totalMoves / 400).toFixed(1) + ', max ' + maxMoves);
});
test('stateForStage returns a state where earlier goals hold and this one does not (usually)', () => {
  const r = rng(99);
  for (const stage of ['daisy', 'cross', 'corners', 'middle', 'ycross', 'yedges', 'ycorners', 'ytwist']) {
    const s = Solver.stateForStage(stage, Cube.scramble(25, r));
    const idx = Solver.STAGES.indexOf(stage);
    // the daisy is undone by the cross stage, so it only counts right before the cross
    for (let i = 1; i < idx; i++) {
      if (Solver.STAGES[i] === 'daisy' && idx > 2) continue;
      assert(Solver.goals[Solver.STAGES[i]](s), stage + ': earlier goal ' + Solver.STAGES[i] + ' not met');
    }
  }
});
test('yellow-cross positioning matches the lesson text (L at back-left, line horizontal)', () => {
  // build an L-shape and a line by inverting the alg on a solved cube
  const yellow = Cube.SOLVED_FACE_COLORS.U;
  const up = (s) => ['UF', 'UL', 'UB', 'UR'].filter((e) => s[Cube.sticker(e, 'U')] === yellow);
  const line = Cube.applyAlg(S, Cube.invertAlg(Solver.ALGS.yellowCross));
  const lineUp = up(line);
  assert.strictEqual(lineUp.length, 2);
  assert(lineUp.includes('UL') && lineUp.includes('UR'), 'line case is horizontal: ' + lineUp);
  const L = Cube.applyAlg(line, Cube.invertAlg(Solver.ALGS.yellowCross));
  const LUp = up(L);
  assert.strictEqual(LUp.length, 2);
  assert(LUp.includes('UB') && LUp.includes('UL'), 'L case sits at back-left: ' + LUp);
});

test('solver resumes the twist stage from a mid-twist state instead of restarting', () => {
  const r = rng(2024);
  let checked = 0;
  for (let i = 0; i < 40 && checked < 15; i++) {
    const s = Solver.stateForStage('ytwist', Cube.scramble(25, r));
    const res = Solver.solve(s);
    const twistSteps = res.steps.filter((st) => st.stage === 'ytwist');
    if (twistSteps.length < 3) continue;   // need at least two corners to twist
    // stop after the first corner is twisted: bottom layers are scrambled now
    let cur = s;
    for (const st of res.steps) { cur = Cube.applyAlg(cur, st.moves); if (st.stage === 'ytwist' && st.moves.length > 2) break; }
    assert(!Solver.goals.middle(cur), 'expected broken F2L mid-twist');
    assert(Solver.midTwistPhase(cur) > 0, 'mid-twist not detected');
    const res2 = Solver.solve(cur);
    assert(res2.steps.every((st) => st.stage === 'ytwist' || st.stage === 'finish'), 'solver restarted from ' + res2.steps[0].stage);
    assert(Cube.isSolved(res2.state));
    // a learner who also turned the top layer by hand is still mid-twist
    const res3 = Solver.solve(Cube.applyMove(cur, 'U'));
    assert(res3.steps.every((st) => st.stage === 'ytwist' || st.stage === 'finish'));
    assert(Cube.isSolved(res3.state));
    checked++;
  }
  assert(checked >= 10, 'too few mid-twist cases checked: ' + checked);
});
test('a single R\' D\' R D on a ready cube is handled (learner twisted by hand)', () => {
  const r = rng(77);
  for (let i = 0; i < 10; i++) {
    const s = Cube.applyAlg(Solver.stateForStage('ytwist', Cube.scramble(25, r)), Solver.ALGS.twist);
    const res = Solver.solve(s);
    assert(Cube.isSolved(res.state));
  }
});

test('validate rejects a corner whose colours are in the wrong order (a mirrored corner)', () => {
  const r = rng(909);
  let rejected = 0, total = 0;
  for (let i = 0; i < 20; i++) {
    const base = Cube.applyAlg(S, Cube.scramble(20, r));
    for (const name of ['UFR', 'UFL', 'UBL', 'UBR', 'DFR', 'DFL', 'DBL', 'DBR']) {
      const p = Cube.pieceAt(name);
      const sides = p.faces.map((f, k) => ({ f, k })).filter((o) => o.f !== 'U' && o.f !== 'D');
      const bad = base.slice();
      const a = p.idx[sides[0].k], b = p.idx[sides[1].k];
      [bad[a], bad[b]] = [bad[b], bad[a]];
      total++;
      if (!Cube.validate(bad).ok) rejected++;
    }
  }
  assert.strictEqual(rejected, total, 'mirrored corners accepted: ' + (total - rejected));
});
test('anything validate accepts, the solver can actually solve', () => {
  const r = rng(4242);
  for (let i = 0; i < 60; i++) {
    const s = Cube.applyAlg(Cube.applyAlg(S, Cube.scramble(25, r)), ['', 'x', "y'", 'z2'][i % 4]);
    assert(Cube.validate(s).ok);
    assert(Cube.isSolved(Solver.solve(s).state));
  }
});
test('the yellow-cross step holds the shape where its words say', () => {
  const r = rng(555);
  const U = ['UF', 'UL', 'UB', 'UR'];
  const yUp = (s, n) => s[Cube.sticker(n, 'U')] === Cube.center(s, 'U');
  let lines = 0, els = 0, dots = 0;
  for (let i = 0; i < 120; i++) {
    let cur = Cube.applyAlg(S, Cube.scramble(25, r));
    for (const st of Solver.solve(cur).steps) {
      if (st.stage === 'ycross') {
        const before = U.filter((e) => yUp(cur, e));
        const lead = st.moves[0] && st.moves[0][0] === 'U' ? [st.moves[0]] : [];
        const held = U.filter((e) => yUp(Cube.applyAlg(cur, lead), e)).sort().join(',');
        if (before.length === 0) { dots++; assert.strictEqual(lead.length, 0, 'the dot case needs no top turn'); }
        else if (before.includes('UF') === before.includes('UB')) { lines++; assert.strictEqual(held, 'UL,UR', 'the line must be held left to right'); }
        else { els++; assert.strictEqual(held, 'UB,UL', 'the L must be held at the back and the left'); }
      }
      cur = Cube.applyAlg(cur, st.moves);
    }
  }
  assert(lines > 10 && els > 10 && dots > 5, 'too few shapes sampled: ' + [dots, els, lines]);
});
test('the yellow-edge step delivers what it promises, and never claims nothing matches', () => {
  const r = rng(556);
  const U = ['UF', 'UL', 'UB', 'UR'];
  let promises = 0;
  for (let i = 0; i < 120; i++) {
    let cur = Cube.applyAlg(S, Cube.scramble(25, r));
    for (const st of Solver.solve(cur).steps) {
      if (st.stage === 'yedges') {
        assert(!/No edge can match/.test(st.text), 'the best top turn always matches two or four edges');
        const after = Cube.applyAlg(cur, st.moves);
        if (/BACK and the RIGHT/.test(st.text)) {
          assert(Solver.goals.ycross(after), 'must not break the yellow cross');
          assert(['UB', 'UR'].every((e) => Cube.pieceAt(e).idx.every((k, j) => after[k] === Cube.center(after, Cube.pieceAt(e).faces[j]))),
            'the pair must end up at the back and the right');
        }
        if (/all four end up right/.test(st.text)) {
          promises++;
          assert(U.every((e) => Cube.pieceAt(e).idx.every((k, j) => after[k] === Cube.center(after, Cube.pieceAt(e).faces[j]))),
            'the step promised all four would match');
        }
      }
      cur = Cube.applyAlg(cur, st.moves);
    }
  }
  assert(promises > 20, 'too few promises checked: ' + promises);
});
test('every step highlights a real piece, and the middle trick highlights the edge it means', () => {
  const r = rng(557);
  let checked = 0;
  for (let i = 0; i < 80; i++) {
    let cur = Cube.applyAlg(S, Cube.scramble(25, r));
    for (const st of Solver.solve(cur).steps) {
      for (const h of st.highlight) assert(Number.isInteger(h) && h >= 0 && h < 54, 'bad highlight ' + h);
      assert(st.moves.length > 0, 'a step with no moves would be dropped');
      if (st.stage === 'middle' && /TRICK to slide/.test(st.text)) {
        checked++;
        assert.deepStrictEqual(st.highlight.slice().sort(), Cube.pieceAt('UF').idx.slice().sort(),
          'the trick step must highlight the edge it is about to insert');
      }
      cur = Cube.applyAlg(cur, st.moves);
    }
  }
  assert(checked > 100, 'too few middle steps: ' + checked);
});
test('the lesson text and the solver cannot drift apart', () => {
  const { LESSONS, MOVE_WORDS, STAGE_TITLES } = require('../js/lessons.js');
  // every algorithm a lesson prints must be the one the solver actually performs
  const taught = {};
  for (const L of LESSONS) for (const a of L.algs) taught[a.name] = a.moves;
  const expect = {
    Righty: Solver.ALGS.righty,
    'Righty backwards': Solver.ALGS.rightyBack,
    'Slide-right trick': Solver.ALGS.middleRight,
    'Slide-left trick': Solver.ALGS.middleLeft,
    'Cross trick': Solver.ALGS.yellowCross,
    'Edge trick': Solver.ALGS.yellowEdges,
    'Corner trick': Solver.ALGS.yellowCorners,
    'Twist trick': Solver.ALGS.twist,
    'Twist trick backwards': Solver.ALGS.twistBack,
  };
  for (const [name, moves] of Object.entries(expect)) {
    assert.strictEqual(taught[name], moves, 'lesson "' + name + '" does not match the solver');
  }
  // every lesson stage is a real solver stage, and every stage has a title
  for (const L of LESSONS) {
    if (L.stage) assert(Solver.STAGES.includes(L.stage), 'unknown stage ' + L.stage);
  }
  for (const st of Solver.STAGES) assert(STAGE_TITLES[st], 'no title for stage ' + st);
  // every move the app can describe must parse, and doubles/primes must agree
  for (const token of Object.keys(MOVE_WORDS)) {
    const mv = Cube.parseMove(token);
    assert(mv, token + ' does not parse');
    assert(!eq(Cube.applyMove(S, token), S), token + ' does nothing');
  }
  // the claims the lessons make about direction, checked against the geometry
  assert.strictEqual(Cube.pieceColors(Cube.applyMove(S, 'U'), Cube.pieceAt('UL')).join(''),
    Cube.pieceColors(S, Cube.pieceAt('UF')).join(''), 'U should send the front edge to the left');
  assert.strictEqual(Cube.pieceColors(Cube.applyMove(S, 'D'), Cube.pieceAt('DR')).join(''),
    Cube.pieceColors(S, Cube.pieceAt('DF')).join(''), 'D should send the front edge to the right');
  // "never more than five Righties", and the backwards versions the solver leans on
  let t = S;
  for (let i = 1; i <= 5; i++) { t = Cube.applyAlg(t, Solver.ALGS.righty); assert(!eq(t, S) || i === 6); }
  assert(eq(Cube.applyAlg(t, Solver.ALGS.righty), S), 'Righty should have order 6');
  assert(eq(Cube.applyAlg(S, Solver.ALGS.righty + ' ' + Solver.ALGS.rightyBack), S), 'Righty backwards must undo Righty');
  assert(eq(Cube.applyAlg(S, Solver.ALGS.twist + ' ' + Solver.ALGS.twistBack), S), 'the Twist trick backwards must undo the Twist trick');
  assert(eq(Cube.applyAlg(S, (Solver.ALGS.righty + ' ').repeat(5)), Cube.applyAlg(S, Solver.ALGS.rightyBack)), 'five Righties equal one backwards');
  assert(eq(Cube.applyAlg(S, (Solver.ALGS.twist + ' ').repeat(4)), Cube.applyAlg(S, (Solver.ALGS.twistBack + ' ').repeat(2))), 'four twists equal two backwards');
});
test('stateForStage always hands back a cube that still needs the stage', () => {
  const r = rng(558);
  for (const stage of ['daisy', 'cross', 'corners', 'middle', 'ycross', 'yedges', 'ycorners', 'ytwist']) {
    for (let i = 0; i < 25; i++) {
      const s = Solver.stateForStage(stage, Cube.scramble(25, r));
      assert(!Solver.goals[stage](s), stage + ' practice cube is already finished');
    }
    for (let i = 0; i < 10; i++) {
      assert(!Solver.goals[stage](Solver.stateForStage(stage)), stage + ' practice cube (no scramble) is already finished');
    }
  }
});

test('a corner is never asked for more than three Righties or two twists, and the count in the text is honest', () => {
  const r = rng(808);
  let corners = 0, twists = 0, backwards = 0;
  for (let i = 0; i < 100; i++) {
    for (const st of Solver.solve(Cube.applyAlg(S, Cube.scramble(25, r))).steps) {
      if (!/Righty|TWIST TRICK/.test(st.text) || /more times|to fix it/.test(st.text)) continue;
      const m = /\b(once|(\d+) times)\b/.exec(st.text);
      if (!m) continue;
      const said = m[1] === 'once' ? 1 : +m[2];
      const alg = st.stage === 'corners' ? (/BACKWARDS/.test(st.text) ? Solver.ALGS.rightyBack : Solver.ALGS.righty)
                                         : (/BACKWARDS/.test(st.text) ? Solver.ALGS.twistBack : Solver.ALGS.twist);
      assert.strictEqual(st.moves.join(' '), (alg + ' ').repeat(said).trim(), 'the moves must be exactly what the text says: ' + st.text);
      assert(said <= 3, 'never more than three repetitions: ' + st.text);
      if (st.stage === 'corners') corners++; else twists++;
      if (/BACKWARDS/.test(st.text)) backwards++;
    }
  }
  assert(corners > 200 && twists > 100 && backwards > 50, 'too few sampled: ' + [corners, twists, backwards]);
});

test('the N x N model agrees with the 3x3 model sticker for sticker', () => {
  const M = NCube.make(3);
  assert.strictEqual(M.COUNT, 54);
  for (let i = 0; i < 54; i++) {
    assert.deepStrictEqual(M.GEO[i].pos, Cube.GEO[i].pos, 'position of sticker ' + i);
    assert.deepStrictEqual(M.GEO[i].n, Cube.GEO[i].n, 'normal of sticker ' + i);
  }
  assert(eq(M.solved(), S));
  for (const m of ['U', "U'", 'U2', 'D', 'L', 'R', 'F', 'B', "B'", 'x', 'y', "z'", 'M', 'E', 'S', 'u', "r'", 'f']) {
    assert.deepStrictEqual(M.movePerm(m), Cube.movePerm(m), 'move ' + m);
  }
  const alg = "R U R' U' F2 D L' B x y' M";
  assert(eq(M.applyAlg(S, alg), Cube.applyAlg(S, alg)));
});
test('every size from 2 to 6: moves have order 4, invert, and scrambles stay legal', () => {
  const r = rng(66);
  for (const N of NCube.SIZES) {
    const M = NCube.make(N);
    const s0 = M.solved();
    assert.strictEqual(M.COUNT, 6 * N * N);
    const tokens = M.padRows().flatMap((row) => row.moves).concat(N % 2 ? ['M', 'E', 'S'] : []);
    for (const t of tokens) {
      let s = s0;
      for (let i = 0; i < 4; i++) s = M.applyMove(s, t);
      assert(eq(s, s0), N + 'x' + N + ' ' + t + ' x4');
      assert(eq(M.applyMove(M.applyMove(s0, t), M.invertMove(t)), s0), N + 'x' + N + ' inverse of ' + t);
      assert(!eq(M.applyMove(s0, t), s0), N + 'x' + N + ' ' + t + ' must do something');
    }
    // a scramble keeps N*N stickers of each colour, and undoing it returns to solved
    const scr = M.scramble(30, r);
    const s = M.applyAlg(s0, scr);
    const counts = {};
    for (const c of s) counts[c] = (counts[c] || 0) + 1;
    for (const c of 'WYGBRO') assert.strictEqual(counts[c], N * N, N + 'x' + N + ' count of ' + c);
    assert(!M.isSolved(s) && M.isSolved(M.applyAlg(s, M.invertAlg(scr))));
    // a wide turn is the outer turn plus the inner slices; on a 4x4, Rw equals R + 2R
    if (N >= 4) assert(eq(M.applyMove(s0, 'Rw'), M.applyAlg(s0, 'R 2R')), 'Rw = R 2R on ' + N);
    // x is every layer turning like R
    // x is every layer turning like R: the R side layers, the middle if there is one, the L side layers
    const inner = []; for (let d = 2; d <= M.maxDepth; d++) inner.push(d);
    const xAlg = ['R'].concat(inner.map((d) => d + 'R')).concat(N % 2 ? ["M'"] : []).concat(inner.slice().reverse().map((d) => d + "L'")).concat(["L'"]);
    assert(eq(M.applyMove(s0, 'x'), M.applyAlg(s0, xAlg)), 'x on ' + N + ' = ' + xAlg.join(' '));
    // an inner layer that does not exist is refused
    assert.throws(() => M.parseMove(N + 'U'), N + 'x' + N + ' layer ' + N);
    // every pad token has words a child can act on
    for (const t of tokens) assert(/^Turn|^Roll|^Tilt/.test(M.describe(t)), 'no words for ' + t);
  }
});

test('a 2x2 solves with the corner tricks only, from any scramble', () => {
  const M2 = NCube.make(2);
  const r = rng(222);
  let moves = 0, steps = 0, n = 0, maxSteps = 0;
  for (let i = 0; i < 300; i++) {
    const scr = M2.scramble(20, r);
    const s2 = M2.applyAlg(M2.solved(), scr);
    let res;
    try { res = Solver.solve2x2(s2); } catch (e) { throw new Error('2x2 scramble ' + scr.join(' ') + ': ' + e.message); }
    assert(M2.isSolved(res.state), 'not solved: ' + scr.join(' '));
    let replay = s2;
    for (const st of res.steps) {
      assert(['orient', 'corners', 'ycorners', 'ytwist', 'finish'].includes(st.stage), 'a 2x2 has no ' + st.stage + ' stage');
      assert(!/centre/.test(st.text), 'a 2x2 has no centres: ' + st.text);
      for (const h of st.highlight) assert(h >= 0 && h < 24, 'highlight off the 2x2: ' + h);
      replay = M2.applyAlg(replay, st.moves);
      moves += st.moves.length;
    }
    assert(M2.isSolved(replay), 'replaying the steps on a 2x2 did not solve it: ' + scr.join(' '));
    steps += res.steps.length; maxSteps = Math.max(maxSteps, res.steps.length); n++;
  }
  console.log('     2x2: average moves ' + (moves / n).toFixed(1) + ', steps ' + (steps / n).toFixed(1) + ', max steps ' + maxSteps);
  assert.strictEqual(Solver.solve2x2(M2.solved()).steps.length, 0);
  const bad = M2.solved(); const t = bad[0]; bad[0] = bad[8]; bad[8] = t;
  assert.throws(() => Solver.solve2x2(bad), /corner|stickers/);
});
test('the 3x3 solver is unchanged by the corners-only option', () => {
  const r = rng(2026);
  for (let i = 0; i < 50; i++) {
    const s = Cube.applyAlg(S, Cube.scramble(25, r));
    const a = Solver.solve(s), b = Solver.solve(s, {});
    assert.strictEqual(a.steps.map((x) => x.moves.join(' ')).join('|'), b.steps.map((x) => x.moves.join(' ')).join('|'));
  }
});

test('a 2x2 is solved however you hold it, and the solver says so', () => {
  const M2 = NCube.make(2);
  const rots = [];
  for (const t of ['', 'x', "x'", 'x2', 'z', "z'"]) for (const spin of ['', 'y', 'y2', "y'"]) rots.push((t + ' ' + spin).trim());
  assert.strictEqual(rots.length, 24);
  for (const rot of rots) {
    const s = rot ? M2.applyAlg(M2.solved(), rot) : M2.solved();
    assert(M2.isSolved(s), 'a turned solved 2x2 is still solved: ' + rot);
    assert(Solver.isSolved2x2(s), 'isSolved2x2 must agree: ' + rot);
    assert.strictEqual(Solver.solve2x2(s).steps.length, 0, 'no help is needed for a solved 2x2 held ' + (rot || 'normally'));
  }
});
test('a 2x2 solves from every scramble in every one of the 24 ways of holding it', () => {
  const M2 = NCube.make(2);
  const r = rng(31337);
  const rots = [];
  for (const t of ['', 'x', "x'", 'x2', 'z', "z'"]) for (const spin of ['', 'y', 'y2', "y'"]) rots.push((t + ' ' + spin).trim());
  let n = 0, moves = 0;
  for (let i = 0; i < 25; i++) {
    const base = M2.applyAlg(M2.solved(), M2.scramble(20, r));
    for (const rot of rots) {
      const s = rot ? M2.applyAlg(base, rot) : base;
      const res = Solver.solve2x2(s);
      let replay = s;
      for (const st of res.steps) {
        for (const t of st.moves) M2.parseMove(t);          // every token must be legal on a 2x2
        assert(!/centre/i.test(st.text), 'a 2x2 has no centres: ' + st.text);
        replay = M2.applyAlg(replay, st.moves);
      }
      assert(M2.isSolved(replay), 'replaying the steps must solve it (held ' + (rot || 'normally') + ')');
      assert(M2.isSolved(res.state), 'the returned state must be solved');
      moves += res.steps.reduce((a, b) => a + b.moves.length, 0);
      n++;
    }
  }
  console.log('     2x2 over all 24 orientations: ' + n + ' solves, average ' + (moves / n).toFixed(1) + ' moves');
});
test('validate2x2 takes a string, like the 3x3 validator does', () => {
  const M2 = NCube.make(2);
  assert(Solver.validate2x2(M2.solved().join('')).ok);
  assert(Solver.validate2x2(M2.solved()).ok);
  assert(!Solver.validate2x2('YYY').ok);
  assert(!Solver.validate2x2(null).ok);
  assert(Solver.solve2x2(M2.applyAlg(M2.solved(), M2.scramble(10, rng(5))).join('')).steps.length > 0);
});
test('every move token describes itself distinctly, at any depth', () => {
  const M3 = NCube.make(3);
  const said = ['M', 'E', 'S'].map((t) => M3.describe(t));
  assert.strictEqual(new Set(said).size, 3, 'the three slice moves must not share one sentence: ' + said.join(' | '));
  for (const t of ['M', 'E', 'S']) assert(!/^Turn the middle layer\.$/.test(M3.describe(t)));
  // an ordinal exists for any depth, not just the first few
  const M16 = NCube.make(16);
  for (let d = 2; d <= M16.maxDepth; d++) {
    const words = M16.describe(d + 'R');
    assert(!/undefined/.test(words), 'no ordinal for depth ' + d + ': ' + words);
  }
  assert(/11th/.test(M16.describe('11R')), M16.describe('11R'));
  assert(/12th/.test(M16.describe('12R')), M16.describe('12R'));
});
test('a rejected move names the token that was typed, not an internal rewrite', () => {
  assert.strictEqual(NCube.make(3).parseMove('u').token, 'u');
  assert.throws(() => NCube.make(2).parseMove('u'), /^Error: u:/);
  assert.throws(() => NCube.make(4).parseMove('7U'), /^Error: 7U:/);
  assert.throws(() => NCube.make(4).parseMove('M'), /middle layer/);
  assert.throws(() => NCube.make(3).parseMove('Z'), /Unknown move: Z/);
});
test('a scramble never turns a layer back through moves that commute with it', () => {
  for (const N of NCube.SIZES) {
    const M = NCube.make(N);
    const r = rng(4242 + N);
    let wasted = 0, accidentallySolved = 0;
    for (let i = 0; i < 400; i++) {
      const scr = M.scramble(20, r);
      if (M.isSolved(M.applyAlg(M.solved(), scr))) accidentallySolved++;
      const sig = scr.map((t) => { const mv = M.parseMove(t); return mv.axis + ':' + mv.layers[0]; });
      for (let k = 1; k < sig.length; k++) {
        if (sig[k] === sig[k - 1]) wasted++;
        else if (k >= 2 && sig[k] === sig[k - 2] && sig[k - 1].split(':')[0] === sig[k].split(':')[0]) wasted++;
      }
    }
    assert.strictEqual(wasted, 0, N + 'x' + N + ' wasted ' + wasted + ' move pairs');
    assert.strictEqual(accidentallySolved, 0, N + 'x' + N + ' produced a solved cube');
  }
});

// ------------------------------------------------------------ big cubes
const bigStageIndex = (st) => BigSolver.STAGES.indexOf(st);
function checkBigSolve(M, start, res) {
  let s = start;
  let last = -1;
  for (const st of res.steps) {
    assert(bigStageIndex(st.stage) >= 0, 'unknown stage ' + st.stage);
    assert(bigStageIndex(st.stage) >= last, 'stages out of order at ' + st.stage);
    last = bigStageIndex(st.stage);
    assert(st.moves.length > 0 && typeof st.text === 'string' && st.text.length > 10, 'empty step');
    for (const m of st.moves) M.parseMove(m);                       // throws on a bad token
    for (const i of st.highlight) assert(i >= 0 && i < M.COUNT, 'highlight out of range');
    s = M.applyAlg(s, st.moves);
  }
  assert(M.isSolved(s), 'replaying the steps does not solve the cube');
  assert.strictEqual(M.toString(res.state), M.toString(s));
}

test('the parity tricks touch nothing but the edges they are meant to', () => {
  const wingsMoved = (M, alg) => {
    const labels = M.solved().map((_, i) => i);
    const moved = M.applyAlg(labels, alg);
    const isEnd = (v) => v === 0 || v === M.N - 1;
    const out = [];
    for (let i = 0; i < M.COUNT; i++) {
      const g = M.GEO[i];
      const centre = !isEnd(g.r) && !isEnd(g.c);
      if (centre) assert.strictEqual(M.solved()[moved[i]], M.solved()[i], alg + ' changes a centre colour on the ' + M.N + 'x' + M.N);
      if (moved[i] !== i && (isEnd(g.r) !== isEnd(g.c))) out.push(g.face);
    }
    return out;
  };
  for (const N of [4, 5, 6]) {
    const M = NCube.make(N);
    for (let d = 2; d <= Math.floor(N / 2); d++) {
      const faces = wingsMoved(M, BigSolver.pureFlip(d));
      assert.deepStrictEqual([...new Set(faces)].sort(), ['F', 'U'], 'pure flip ' + d + ' on ' + N);
      assert.strictEqual(faces.length, 4, 'pure flip moves one pair');
    }
    if (BigSolver.SWAP[N]) {
      const faces = wingsMoved(M, BigSolver.SWAP[N]);
      assert.deepStrictEqual([...new Set(faces)].sort(), ['B', 'F', 'U'], 'swap on ' + N);
      assert.strictEqual(faces.length, 4 * (N - 2), 'swap moves the whole top-front and top-back edges');
    }
  }
});

test('4x4, 5x5 and 6x6 scrambles are solved by the reduction solver', () => {
  const r = rng(2024);
  for (const N of [4, 5, 6]) {
    const M = NCube.make(N);
    const runs = N === 6 ? 3 : 6;
    for (let k = 0; k < runs; k++) {
      const start = M.applyAlg(M.solved(), M.scramble(30 + k * 5, r));
      const res = BigSolver.solve(M, start);
      checkBigSolve(M, start, res);
      const stages = res.steps.map((st) => st.stage);
      assert(stages.includes('centres') && stages.includes('edges'), 'a scramble needs centres and edges');
      if (N % 2) assert(!stages.includes('parity'), 'an odd cube never needs a parity fix');
      assert(!stages.includes('orient') || stages[0] === 'orient', 'orient comes first');
    }
  }
});

test('a rotated solved big cube needs no steps, and a parity-only cube gets just the fix', () => {
  for (const N of [4, 5, 6]) {
    const M = NCube.make(N);
    for (const rot of ['', 'x', "y'", 'z2 y']) {
      const res = BigSolver.solve(M, rot ? M.applyAlg(M.solved(), rot) : M.solved());
      assert.strictEqual(res.steps.length, 0, N + 'x' + N + ' rotated by ' + rot);
    }
  }
  for (const N of [4, 6]) {
    const M = NCube.make(N);
    const flipAlg = [];
    for (let d = 2; d <= N / 2; d++) flipAlg.push(BigSolver.pureFlip(d));
    for (const alg of [flipAlg.join(' '), BigSolver.SWAP[N]]) {
      const start = M.applyAlg(M.solved(), alg);
      const res = BigSolver.solve(M, start);
      checkBigSolve(M, start, res);
      assert(res.steps.some((st) => st.stage === 'parity'), 'parity step expected on ' + N);
      assert(!res.steps.some((st) => st.stage === 'centres' || st.stage === 'edges'), 'centres and edges were already done');
    }
  }
});

test('the 6x6 is fixed when only one wing orbit of an edge is turned round', () => {
  const M = NCube.make(6);
  const start = M.applyAlg(M.solved(), BigSolver.pureFlip(2));   // outer wings of UF turned, inner not
  const res = BigSolver.solve(M, start);
  checkBigSolve(M, start, res);
  assert(res.steps.some((st) => st.stage === 'edges'), 'the mismatched edge is paired again');
});

test('a big cube solve is checked as it goes: every text names a real colour or side', () => {
  const M = NCube.make(4);
  const start = M.applyAlg(M.solved(), M.scramble(30, rng(7)));
  const res = BigSolver.solve(M, start);
  const colours = /white|yellow|green|blue|red|orange/;
  for (const st of res.steps) {
    if (st.stage === 'centres') { assert(colours.test(st.text)); assert(/TOP|BOTTOM|FRONT|BACK|LEFT|RIGHT/.test(st.text)); assert(st.highlight.length >= 1); }
    if (st.stage === 'edges') { assert(colours.test(st.text)); assert(st.highlight.length >= 2 && st.highlight.length % 2 === 0); }
    assert(!/undefined|NaN|\[object/.test(st.text), st.text);
  }
  assert(/big cube/.test(res.steps.find((st) => st.stage === 'centres').text), 'the first centre step explains the idea');
  assert(/like a 3×3/.test(res.steps.find((st) => bigStageIndex(st.stage) > bigStageIndex('parity')).text), 'the 3x3 part is announced');
});

test('solveAny hands the 2x2 and 3x3 to their own solvers', () => {
  const two = NCube.make(2), three = NCube.make(3);
  const s2 = two.applyAlg(two.solved(), 'R U F');
  const r2 = BigSolver.solveAny(two, s2);
  assert(two.isSolved(r2.state) && r2.steps.every((st) => Solver.STAGES.includes(st.stage)));
  const s3 = three.applyAlg(three.solved(), "R U R' U' F2");
  const r3 = BigSolver.solveAny(three, s3);
  assert(three.isSolved(r3.state) && r3.steps.some((st) => st.stage === 'daisy' || st.stage === 'cross' || st.stage === 'corners'));
  assert.throws(() => BigSolver.solve(three, s3), /4 layers/);
});

test('the 2x2 walkthrough is free and the rest is bought once', () => {
  Store.__reset();
  assert.strictEqual(Store.needsUnlock(2), false, 'a 2x2 never needs paying for');
  for (const n of [3, 4, 5, 6]) assert.strictEqual(Store.needsUnlock(n), true, n + 'x' + n + ' needs the purchase');
  assert.strictEqual(Store.isUnlocked(), false);
  assert.strictEqual(Store.price(), '$0.99');
  // With no host there is no shop, and asking to buy says so rather than pretending.
  assert.strictEqual(Store.canBuy(), false);
  return Store.buy().then((res) => {
    assert.deepStrictEqual(res, { ok: false, reason: 'no-shop' });
    // StoreKit's answer is the one that counts, and it carries the local price.
    Store.applyNative({ unlocked: true, price: '£0.99', shopReady: true });
    assert.strictEqual(Store.isUnlocked(), true);
    assert.strictEqual(Store.price(), '£0.99');
    for (const n of [2, 3, 6]) assert.strictEqual(Store.needsUnlock(n), false);
    // ...and it can take the unlock away again, which is what a refund looks like.
    Store.applyNative({ unlocked: false });
    assert.strictEqual(Store.needsUnlock(3), true);
    assert.strictEqual(Store.needsUnlock(2), false);
    Store.__reset();
  });
});

test('the store tells listeners when the answer changes', () => {
  Store.__reset();
  const seen = [];
  const off = Store.onChange((s) => seen.push(s.unlocked));
  Store.applyNative({ unlocked: true });
  Store.applyNative({ unlocked: false });
  off();
  Store.applyNative({ unlocked: true });
  assert.deepStrictEqual(seen, [true, false], 'one call per change, and none after unsubscribing');
  Store.__reset();
});

Promise.all(waiting).then(() => {
  console.log('\n' + passed + ' test group(s) passed' + (process.exitCode ? ', some FAILED' : ''));
});
