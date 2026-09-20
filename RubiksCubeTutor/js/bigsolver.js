/*
 * bigsolver.js - guided solving for the 4x4, 5x5 and 6x6 (the "reduction" method).
 *
 * A big cube is solved by turning it into a 3x3 and then using the beginner method
 * the lessons already teach:
 *
 *   orient   - hold the cube the easy way
 *   centres  - make the middle squares of every side one colour
 *   edges    - pair up the edge pieces so every edge is one colour on each side
 *   parity   - the two fixes a 4x4 or 6x6 sometimes needs that a 3x3 never does
 *   then     - the 3x3 stages from solver.js on the reduced cube
 *
 * There is no hand-written case table. Each centre and edge step is found by trying
 * short algorithm templates on the cube model and keeping the shortest one that
 * makes progress without undoing earlier work. Every step is checked on the model
 * before it is emitted, so the guide can never show a wrong move: if the search
 * ever fails it throws a SolverBug and the app says it got stuck.
 *
 * solve(model, state) -> { steps: [{stage, text, moves, highlight}], state }
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./cube.js'), require('./ncube.js'), require('./solver.js'));
  } else {
    root.RC = root.RC || {};
    root.RC.BigSolver = factory(root.RC.Cube, root.RC.NCube, root.RC.Solver);
  }
})(typeof self !== 'undefined' ? self : this, function (Cube, NCube, Solver) {
  'use strict';

  const STAGES = ['orient', 'centres', 'edges', 'parity'].concat(Solver.STAGES.slice(1));
  function SolverBug(msg) { const e = new Error(msg); e.internal = true; return e; }

  const cname = (c) => Cube.COLOR_NAMES[c] || c;
  const SIDE = { U: 'top', D: 'bottom', F: 'front', B: 'back', L: 'left', R: 'right' };
  const FACES = ['U', 'R', 'F', 'D', 'L', 'B'];
  const SUFFIXES = ['', "'", '2'];
  const FACE_MOVES = [];
  for (const f of FACES) for (const s of SUFFIXES) FACE_MOVES.push(f + s);
  const QUARTER = FACE_MOVES.filter((t) => !t.endsWith('2'));
  // The 24 ways of holding a cube, as whole-cube rotations.
  const ROTATIONS = [];
  for (const tilt of ['', 'x', "x'", 'x2', 'z', "z'"]) for (const spin of ['', 'y', 'y2', "y'"]) ROTATIONS.push((tilt + ' ' + spin).trim());

  // Flips the edge at the front-right (and disturbs the top layer). With a slice
  // turn before and after it, it joins two edge pieces without breaking centres.
  const FLIP = "R U R' F R' F' R";
  // One edge pair of the wing orbit at depth d is turned round, nothing else moves.
  // This is the classic 4x4 "OLL parity", written with single inner layers so the
  // same algorithm keeps the centres of a 5x5 and a 6x6 too.
  const pureFlip = (d) => `${d}R2 B2 U2 ${d}L U2 ${d}R' U2 ${d}R U2 F2 ${d}R F2 ${d}L' B2 ${d}R2`;
  // Swaps the whole top-front and top-back edges and nothing else ("PLL parity").
  // Only an even cube can need it. Both were checked on the model.
  const SWAP = {
    4: '2R2 U2 2R2 Uw2 2R2 2U2',
    6: '2R2 3R2 U2 2R2 3R2 U2 2U2 3U2 2R2 3R2 2U2 3U2',
  };
  // Faces a slice runs through: every face but the two it is parallel to.
  const AXIS_FACES = { U: 'UD', D: 'UD', R: 'RL', L: 'RL', F: 'FB', B: 'FB' };
  const pathFaces = (f) => FACES.filter((g) => !AXIS_FACES[f].includes(g));
  const onPath = (f, moves) => moves.filter((t) => pathFaces(f).includes(t[0]));

  // ------------------------------------------------------------ per-size tables
  const built = new Map();
  function make(model) {
    if (built.has(model.N)) return built.get(model.N);
    const { N, H, COUNT, GEO } = model;
    const COL = model.SOLVED_FACE_COLORS;
    const isEnd = (v) => v === 0 || v === N - 1;
    // 3 corner, 2 wing (edge piece), 1 centre
    const type = GEO.map((g) => (isEnd(g.r) && isEnd(g.c) ? 3 : isEnd(g.r) || isEnd(g.c) ? 2 : 1));
    const centres = {};
    for (const f of FACES) centres[f] = [];
    GEO.forEach((g, i) => { if (type[i] === 1) centres[g.face].push(i); });
    const inner = (N - 2) * (N - 2);
    const depths = [];
    for (let d = 2; d <= Math.floor(N / 2); d++) depths.push(d);

    // Wings grouped into the twelve edge slots of the 3x3 they will become.
    const byPos = new Map();
    GEO.forEach((g, i) => {
      if (type[i] !== 2) return;
      const k = g.pos.join(',');
      if (!byPos.has(k)) byPos.set(k, []);
      byPos.get(k).push(i);
    });
    const slotMap = new Map();
    for (const idx of byPos.values()) {
      const faces = idx.map((i) => GEO[i].face);
      const key = faces.slice().sort().join('');
      const pos = GEO[idx[0]].pos;
      const along = pos[pos.findIndex((v) => Math.abs(v) !== H)];
      const wing = { a: idx[faces.indexOf(key[0])], b: idx[faces.indexOf(key[1])], along };
      if (!slotMap.has(key)) slotMap.set(key, { key, wings: [] });
      slotMap.get(key).wings.push(wing);
    }
    const slots = [...slotMap.values()];
    for (const s of slots) {
      s.wings.sort((p, q) => p.along - q.along);
      s.middle = N % 2 ? s.wings.find((w) => w.along === 0) : null;
    }

    // ---- permutations: apply(state, p)[i] = state[p[i]]; "p then q" is p[q[i]]
    const Perm = COUNT <= 256 ? Uint8Array : Uint16Array;
    const identity = () => { const p = new Perm(COUNT); for (let i = 0; i < COUNT; i++) p[i] = i; return p; };
    const compose = (p, q) => { const out = new Perm(COUNT); for (let i = 0; i < COUNT; i++) out[i] = p[q[i]]; return out; };
    const permOf = (tokens) => { let p = identity(); for (const t of tokens) p = compose(p, model.movePerm(t)); return p; };
    const toks = (alg) => model.parseAlg(alg);
    const centreSafe = (p) => { for (const f of FACES) for (const i of centres[f]) if (GEO[p[i]].face !== f) return false; return true; };

    // The same moves after the whole cube is turned by `rotation`.
    function conjugate(tokens, rotation) {
      if (!rotation) return tokens.slice();
      const p = permOf(toks(rotation));
      const map = {};
      for (const f of FACES) map[f] = GEO[p[model.FACE_INDEX[f] * N * N]].face;
      return tokens.map((t) => {
        const m = /^(\d*)([UDLRFB])(w?)(['2]?)$/.exec(t);
        if (m) return m[1] + map[m[2]] + m[3] + m[4];
        const l = /^([udlrfb])(['2]?)$/.exec(t);
        if (l) return map[l[1].toUpperCase()].toLowerCase() + l[2];
        throw SolverBug('cannot rotate move ' + t);
      });
    }

    // Inner slice turns. Centres need single layers down to the middle one (a 5x5's
    // plus-shaped pieces sit on it) and blocks of layers of every depth, because
    // some centre pieces of a 5x5 or 6x6 only a block can move without breaking the
    // rest. Edges need only the single layers the move pad shows. A layer counted
    // from either side is the same layer, so keep one name for it.
    const wideToken = (d, f) => (d === 2 ? f.toLowerCase() : d + f + 'w');
    const seen = new Set();
    const singles = [], wides = [], edgeSlices = [];
    for (const f of FACES) {
      for (const s of SUFFIXES) {
        for (let d = 2; d <= Math.ceil(N / 2); d++) {
          const token = d + f + s;
          const mv = model.parseMove(token);
          const sig = mv.axis + ':' + mv.layers[0] + ':' + mv.k;
          if (seen.has(sig)) continue;
          seen.add(sig);
          singles.push({ token, faceOf: f, axis: mv.axis });
        }
        for (let d = 2; d <= N - 1; d++) wides.push({ token: wideToken(d, f) + s, faceOf: f });
        for (const d of depths) edgeSlices.push({ token: d + f + s, faceOf: f });
      }
    }

    // ---- centre templates
    //   s                        one slice
    //   A s B s'                 bring a line across, turn the face, bring it back
    //   A s1 B s2 B' s1' B s2' B  a commutator of two parallel slices: moves exactly
    //                            three centre squares, one of them onto the target
    // A and B turn faces the slice runs through.
    const centreCands = [];
    for (const sl of singles.concat(wides)) {
      const s = [sl.token], si = [model.invertMove(sl.token)];
      centreCands.push({ alg: s, perm: model.movePerm(sl.token) });
      const inside = onPath(sl.faceOf, FACE_MOVES);
      for (const A of [''].concat(inside)) {
        const pre = A ? compose(model.movePerm(A), model.movePerm(sl.token)) : model.movePerm(sl.token);
        for (const B of inside) {
          const alg = (A ? [A] : []).concat(s, [B], si);
          centreCands.push({ alg, perm: compose(compose(pre, model.movePerm(B)), model.movePerm(si[0])) });
        }
      }
    }
    for (const s1 of singles) {
      for (const s2 of singles) {
        if (s2.axis !== s1.axis) continue;
        for (const B of onPath(s1.faceOf, QUARTER)) {
          const Bi = model.invertMove(B);
          const core = [s1.token, B, s2.token, Bi, model.invertMove(s1.token), B, model.invertMove(s2.token), Bi];
          const cp = permOf(core);
          for (const A of [''].concat(onPath(s1.faceOf, FACE_MOVES))) {
            centreCands.push({ alg: (A ? [A] : []).concat(core), perm: A ? compose(model.movePerm(A), cp) : cp });
          }
        }
      }
    }
    // An odd cube's middle squares never move: a step that carried one away would
    // count as progress and could never be undone.
    const fixed = N % 2 ? FACES.map((f) => centres[f][(inner - 1) / 2]) : [];
    const keepsFixed = (p) => fixed.every((i) => p[i] === i);
    const centreCandsAll = centreCands.filter((c) => keepsFixed(c.perm));
    centreCandsAll.sort((p, q) => p.alg.length - q.alg.length);
    // Scoring only looks at the centre squares a candidate actually moves, face by
    // face; and only candidates that carry something onto the target face can help.
    const byTarget = {};
    for (const c of centreCandsAll) {
      c.moved = {};
      for (const f of FACES) c.moved[f] = centres[f].filter((i) => c.perm[i] !== i);
    }
    for (const f of FACES) byTarget[f] = centreCandsAll.filter((c) => c.moved[f].some((i) => GEO[c.perm[i]].face !== f));

    // ---- edge templates: P s X s'  where X is a conjugate A B A' (A on a face the
    // slice runs through, B on a face beside it) or the flip trick in any position.
    // Every face the slice runs through ends X with no net turn, so the centre row
    // the slice carried goes back where it came from; the check below makes sure.
    // Then P P' pure(d): the one-orbit flip, for a pair that is the wrong way round.
    const flips = new Map();
    for (const r of ROTATIONS) {
      for (const alg of [toks(FLIP), model.invertAlg(toks(FLIP))]) {
        const c = conjugate(alg, r);
        flips.set(c.join(' '), c);
      }
    }
    const flipCores = [...flips.values()].map((alg) => ({ alg, perm: permOf(alg) }));
    const wingIdx = [];
    GEO.forEach((g, i) => { if (type[i] === 2) wingIdx.push(i); });
    const edgeCands = [];
    for (const sl of edgeSlices) {
      const s = [sl.token], si = [model.invertMove(sl.token)];
      const sp = model.movePerm(sl.token);
      const sip = model.movePerm(si[0]);
      const carried = wingIdx.filter((i) => sp[i] !== i);   // wings this slice moves
      const beside = FACE_MOVES.filter((t) => AXIS_FACES[sl.faceOf].includes(t[0]));
      const cores = flipCores.slice();
      for (const A of onPath(sl.faceOf, FACE_MOVES)) {
        for (const B of beside) {
          const alg = [A, B, model.invertMove(A)];
          cores.push({ alg, perm: permOf(alg) });
        }
      }
      for (const X of cores) {
        if (!carried.some((i) => X.perm[i] !== i)) continue;
        const mid = compose(compose(sp, X.perm), sip);
        if (!centreSafe(mid)) continue;
        for (const P of [''].concat(onPath(sl.faceOf, FACE_MOVES))) {
          const alg = (P ? [P] : []).concat(s, X.alg, si);
          edgeCands.push({ alg, perm: P ? compose(model.movePerm(P), mid) : mid });
        }
      }
    }
    for (const d of depths) {
      const pure = toks(pureFlip(d));
      for (const P1 of [''].concat(FACE_MOVES)) {
        for (const P2 of [''].concat(FACE_MOVES)) {
          if (!P1 && P2) continue;
          if (P1 && P2 && P1[0] === P2[0]) continue;
          const alg = [P1, P2].filter(Boolean).concat(pure);
          edgeCands.push({ alg, perm: permOf(alg) });
        }
      }
    }
    for (const c of edgeCands) if (!centreSafe(c.perm)) throw SolverBug('edge template moves centres: ' + c.alg.join(' '));
    edgeCands.sort((p, q) => p.alg.length - q.alg.length);
    // ...and only at the edge slots whose wings it moves.
    for (const c of edgeCands) {
      c.touched = [];
      slots.forEach((sl, k) => { if (sl.wings.some((w) => c.perm[w.a] !== w.a || c.perm[w.b] !== w.b)) c.touched.push(k); });
    }

    // ---- the reduced 3x3: one sticker stands for each corner, edge slot and centre
    const rep = (v) => (v === 0 ? 0 : v === 2 ? N - 1 : N % 2 ? H : 1);
    const group = (v) => { if (v === 0) return [0]; if (v === 2) return [N - 1]; const out = []; for (let k = 1; k < N - 1; k++) out.push(k); return out; };
    const REDUCE = [];
    const GROUPS = [];
    for (let f = 0; f < 6; f++) {
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
          REDUCE.push(f * N * N + rep(r) * N + rep(c));
          const g = [];
          for (const rr of group(r)) for (const cc of group(c)) g.push(f * N * N + rr * N + cc);
          GROUPS.push(g);
        }
      }
    }
    const reduce = (state) => REDUCE.map((i) => state[i]);

    const parityAlgs = { flip: depths.map(pureFlip).join(' '), swap: SWAP[N] || '' };
    if (N % 2 === 0) {
      for (const alg of [parityAlgs.flip, parityAlgs.swap]) {
        if (!alg || !centreSafe(permOf(toks(alg)))) throw SolverBug('parity trick moves centres on a ' + N + 'x' + N);
      }
    }

    const facePerms = {};
    for (const t of FACE_MOVES) facePerms[t] = model.movePerm(t);
    const out = {
      N, H, type, centres, inner, depths, slots, byTarget, edgeCands, facePerms,
      permOf, compose, centreSafe, reduce, GROUPS, parityAlgs, toks, COL,
    };
    built.set(N, out);
    return out;
  }

  // -------------------------------------------------------------- scoring
  // Colours are small numbers while solving, so a pair of wing stickers is one number.
  const CODE = { W: 0, Y: 1, G: 2, B: 3, R: 4, O: 5 };
  const LETTER = ['W', 'Y', 'G', 'B', 'R', 'O'];
  const pairAt = (state, p, w) => state[p[w.a]] * 8 + state[p[w.b]];

  // How far one edge slot is: the most wings that already agree. On an odd cube the
  // middle piece decides the pair; on an even cube the most common pair does.
  function slotBest(state, p, s) {
    const w = s.wings;
    let best = 0;
    if (s.middle) {
      const ref = pairAt(state, p, s.middle);
      for (let i = 0; i < w.length; i++) if (pairAt(state, p, w[i]) === ref) best++;
    } else {
      for (let i = 0; i < w.length; i++) {
        const k = pairAt(state, p, w[i]);
        let n = 0;
        for (let j = 0; j < w.length; j++) if (pairAt(state, p, w[j]) === k) n++;
        if (n > best) best = n;
      }
    }
    return best;
  }
  // Squared, so joining a third piece is worth more than starting another pair.
  const slotValue = (state, p, s) => { const b = slotBest(state, p, s); return b * b; };
  const allPaired = (T, state, p) => T.slots.every((s) => slotBest(state, p, s) === s.wings.length);
  const pairedKeys = (T, state, p) => T.slots.filter((s) => { const ref = pairAt(state, p, s.wings[0]); return s.wings.every((w) => pairAt(state, p, w) === ref); }).map((s) => pairAt(state, p, s.wings[0]));
  function slotInfo(T, state, p, s) {
    const counts = new Map();
    for (const w of s.wings) { const k = pairAt(state, p, w); counts.set(k, (counts.get(k) || 0) + 1); }
    let ref = s.middle ? pairAt(state, p, s.middle) : null;
    if (ref === null) for (const [k, n] of counts) if (ref === null || n > counts.get(ref)) ref = k;
    return { ref, count: counts.get(ref) };
  }

  // The best candidate by `score` (null means "does not help"). When nothing helps,
  // try again after each single face turn, which never undoes finished work; the
  // turn becomes part of the step.
  function search(T, cands, state, score) {
    let best = null;
    for (const c of cands) {
      const v = score(state, c);
      if (v !== null && (!best || v > best.v)) best = { c, v, setup: [] };
    }
    if (best) return best;
    for (const m of FACE_MOVES) {
      const pm = T.facePerms[m];
      const turned = state.map((_, i) => state[pm[i]]);
      for (const c of cands) {
        const v = score(turned, c);
        if (v !== null && (!best || v > best.v)) best = { c, v, setup: [m] };
      }
    }
    return best;
  }

  // -------------------------------------------------------------- solver
  function solve(model, input) {
    if (model.N < 4) throw new Error('This solver is for cubes of 4 layers and more');
    const T = make(model);
    const N = model.N;
    let cur = Array.prototype.slice.call(input);
    const steps = [];
    if (model.isSolved(cur)) return { steps, state: cur };
    const col = (f) => T.COL[f];
    function emit(stage, text, moves, highlight) {
      moves = model.parseAlg(moves);
      if (!moves.length) return;
      cur = model.applyAlg(cur, moves);
      steps.push({ stage, text, moves, highlight: highlight || [] });
    }
    const countFace = (state, f) => { let n = 0; for (const i of T.centres[f]) if (state[i] === col(f)) n++; return n; };
    const identity = T.permOf([]);

    // ---- orient: odd cubes have fixed centres; on an even cube any way up works, so
    // pick the way that already has the most centre squares in place.
    {
      let best = null;
      for (const alg of ROTATIONS) {
        const s = alg ? model.applyAlg(cur, alg) : cur;
        if (N % 2) {
          if (FACES.every((f) => s[T.centres[f][(T.centres[f].length - 1) / 2]] === col(f))) { best = { alg, score: 1 }; break; }
        } else {
          let score = 0;
          for (const f of FACES) score += countFace(s, f);
          if (!best || score > best.score) best = { alg, score };
        }
      }
      if (!best) throw new Error('The centre stickers are not arranged like a real cube.');
      if (best.alg) {
        emit('orient', N % 2
          ? 'First, hold the cube so the WHITE middle square is on the bottom and the GREEN one faces you.'
          : 'First, turn the WHOLE cube like this. On a ' + N + 'x' + N + ' any way up is fine, and this way has the most centre squares already in place.', best.alg, []);
      }
    }

    // ---- centres
    const ORDER = ['D', 'U', 'F', 'R', 'B', 'L'];
    const done = [];
    let intro = 'On a big cube the middle squares can move about, so first we build the six centres, one colour each. ';
    for (const f of ORDER.slice(0, 5)) {
      while (countFace(cur, f) < T.inner) {
        const isDone = {};
        for (const g of done) isDone[g] = true;
        const want = col(f);
        const best = search(T, T.byTarget[f], cur, (state, c) => {
          const p = c.perm;
          for (const g of done) { const cg = col(g); for (const i of c.moved[g]) if (state[p[i]] !== cg) return null; }
          let gain = 0;
          for (const i of c.moved[f]) gain += (state[p[i]] === want) - (state[i] === want);
          return gain > 0 ? gain : null;
        });
        if (!best) throw SolverBug('Centre search stuck on ' + f);
        const p = best.setup.length ? T.compose(T.facePerms[best.setup[0]], best.c.perm) : best.c.perm;
        const highlight = [];
        for (const i of T.centres[f]) if (cur[p[i]] === col(f) && model.GEO[p[i]].face !== f) highlight.push(p[i]);
        const k = best.v;
        const many = k === 1 ? 'one more ' + cname(col(f)) + ' square' : k + ' more ' + cname(col(f)) + ' squares';
        emit('centres', intro + 'Make the middle of the ' + SIDE[f].toUpperCase() + ' side all ' + cname(col(f)).toUpperCase() + '. This trick brings ' + many + ' there.', best.setup.concat(best.c.alg), highlight);
        intro = '';
      }
      done.push(f);
    }
    for (const f of FACES) if (countFace(cur, f) !== T.inner) throw SolverBug('Centres not finished on ' + f);

    // ---- edges
    intro = 'Now we join the edge pieces, so each edge is one colour on each side, like a 3x3 edge. ';
    {
      const codes = cur.map((c) => CODE[c]);
      let state = codes;
      while (!allPaired(T, state, identity)) {
        let base = null, baseState = null;
        const best = search(T, T.edgeCands, state, (st, c) => {
          if (st !== baseState) { baseState = st; base = T.slots.map((s) => slotValue(st, identity, s)); }
          let gain = 0;
          for (const k of c.touched) gain += slotValue(st, c.perm, T.slots[k]) - base[k];
          return gain > 0 ? gain : null;
        });
        if (!best) throw SolverBug('Edge search stuck');
        const p = best.setup.length ? T.compose(T.facePerms[best.setup[0]], best.c.perm) : best.c.perm;
        // Which edge did this step help? A newly finished pair, or the best partly-done slot.
        const was = pairedKeys(T, state, identity);
        const now = pairedKeys(T, state, p);
        const fresh = now.find((k) => !was.includes(k));
        let slot, ref, text;
        if (fresh !== undefined) {
          slot = T.slots.find((s) => s.wings.every((w) => pairAt(state, p, w) === fresh));
          ref = fresh;
          text = 'Finish the ' + cname(LETTER[ref >> 3]) + ' and ' + cname(LETTER[ref & 7]) + ' edge: this brings its last piece' + (N > 4 ? 's' : '') + ' together.';
        } else {
          let top = null;
          for (const s of T.slots) { const st = slotInfo(T, state, p, s); if (st.count < s.wings.length && (!top || st.count > top.count)) top = { s, ref: st.ref, count: st.count }; }
          slot = top.s;
          ref = top.ref;
          text = 'Bring another ' + cname(LETTER[ref >> 3]) + ' and ' + cname(LETTER[ref & 7]) + ' edge piece next to its twin' + (top.count > 2 ? 's' : '') + '.';
        }
        const highlight = [];
        for (const w of slot.wings) if (pairAt(state, p, w) === ref) highlight.push(p[w.a], p[w.b]);
        emit('edges', intro + text, best.setup.concat(best.c.alg), highlight);
        intro = '';
        state = state.map((_, i) => state[p[i]]);
      }
      if (state.map((c) => LETTER[c]).join('') !== cur.join('')) throw SolverBug('Edge bookkeeping drifted');
    }
    if (FACES.some((f) => countFace(cur, f) !== T.inner)) throw SolverBug('Centres broken while pairing edges');

    // ---- parity: only an even cube can look like an impossible 3x3 here
    for (let round = 0; round < 3; round++) {
      const v = Cube.validate(T.reduce(cur));
      if (v.ok) break;
      if (round === 2) throw SolverBug('Reduced cube is not a real 3x3: ' + v.reason);
      if (/flipped/.test(v.reason)) {
        emit('parity', 'A big cube can do something a 3x3 never does: one whole edge is turned round. Hold the cube still and do this long trick slowly, one move at a time. It turns the top-front edge round.', T.parityAlgs.flip, T.GROUPS[7].concat(T.GROUPS[2 * 9 + 1]));
      } else if (/swapped/.test(v.reason)) {
        if (!T.parityAlgs.swap) throw SolverBug('No swap parity algorithm for ' + N);
        emit('parity', 'A big cube can do something a 3x3 never does: two edges are swapped. Hold the cube still and do this trick slowly, one move at a time. It swaps the top-front and top-back edges.', T.parityAlgs.swap, T.GROUPS[7].concat(T.GROUPS[1], T.GROUPS[2 * 9 + 1], T.GROUPS[5 * 9 + 1]));
      } else {
        throw SolverBug('Reduced cube is not a real 3x3: ' + v.reason);
      }
      if (!allPaired(T, cur.map((c) => CODE[c]), identity) || FACES.some((f) => countFace(cur, f) !== T.inner)) throw SolverBug('Parity trick broke the cube');
    }

    // ---- the 3x3 from here
    const res = Solver.solve(T.reduce(cur));
    intro = 'Now the cube works just like a 3x3! ';
    for (const st of res.steps) {
      const highlight = [];
      for (const i of st.highlight) for (const j of T.GROUPS[i]) highlight.push(j);
      emit(st.stage, intro + st.text, st.moves, highlight);
      intro = '';
    }
    if (!model.isSolved(cur)) throw SolverBug('Solver did not reach a solved cube');
    return { steps, state: cur };
  }

  // Any size: the 2x2 and 3x3 solvers live in solver.js.
  function solveAny(model, state) {
    if (model.N === 2) return Solver.solve2x2(state);
    if (model.N === 3) return Solver.solve(state);
    return solve(model, state);
  }

  return { STAGES, solve, solveAny, make, pureFlip, SWAP };
});
