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
  // Only the size in play is kept: the tables are tens of megabytes on a 6x6, and a
  // phone should not hold three sets of them because a child tried every size.
  const built = new Map();
  function make(model) {
    if (built.has(model.N)) return built.get(model.N);
    built.clear();
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
    const W = N - 2;                       // wings per edge slot
    slots.forEach((s, k) => {
      s.index = k;
      s.wings.sort((p, q) => p.along - q.along);
      s.aIdx = Uint16Array.from(s.wings.map((w) => w.a));
      s.bIdx = Uint16Array.from(s.wings.map((w) => w.b));
      // On an odd cube the middle piece of an edge cannot move, so it says which
      // colours the whole edge has to end up with.
      s.middleIdx = N % 2 ? s.wings.findIndex((w) => w.along === 0) : -1;
    });

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
    // Keeping a whole permutation per candidate would cost a phone tens of
    // megabytes, so each one keeps only the squares it actually moves, packed into
    // a single array: six face offsets, an end offset, then (square, where it comes
    // from) pairs grouped by the face the square sits on.
    function packCentres(perm) {
      const cells = [];
      const off = [];
      for (const f of FACES) {
        off.push(cells.length / 2);
        for (const i of centres[f]) if (perm[i] !== i) cells.push(i, perm[i]);
      }
      off.push(cells.length / 2);
      return Uint16Array.from(off.concat(cells));
    }
    // Scoring only looks at those squares, and only candidates that carry something
    // onto the target face can help it.
    const byTarget = {};
    for (const f of FACES) byTarget[f] = [];
    centreCands.sort((p, q) => p.alg.length - q.alg.length);
    for (const c of centreCands) {
      if (!keepsFixed(c.perm)) continue;
      const packed = { alg: c.alg.join(' '), cells: packCentres(c.perm) };
      for (let fi = 0; fi < 6; fi++) {
        let helps = false;
        for (let k = packed.cells[fi]; k < packed.cells[fi + 1] && !helps; k++) {
          helps = GEO[packed.cells[7 + 2 * k + 1]].face !== FACES[fi];    // comes from another face
        }
        if (helps) byTarget[FACES[fi]].push(packed);
      }
    }

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
    // Packed the same way: how many slots this candidate disturbs, which ones, and
    // then, for each of them, where every one of that slot's wing stickers comes from.
    const packedEdges = edgeCands.map((c) => {
      const touched = slots.filter((sl) => sl.wings.some((w) => c.perm[w.a] !== w.a || c.perm[w.b] !== w.b));
      const data = [touched.length];
      for (const sl of touched) data.push(sl.index);
      for (const sl of touched) for (const w of sl.wings) data.push(c.perm[w.a], c.perm[w.b]);
      return { alg: c.alg.join(' '), slots: Uint16Array.from(data) };
    });

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

    const parityAlgs = { flipParts: depths.map(pureFlip), swap: SWAP[N] || '' };
    if (N % 2 === 0) {
      for (const alg of parityAlgs.flipParts.concat(parityAlgs.swap)) {
        if (!alg || !centreSafe(permOf(toks(alg)))) throw SolverBug('parity trick moves centres on a ' + N + 'x' + N);
      }
    }

    const facePerms = {};
    for (const t of FACE_MOVES) facePerms[t] = model.movePerm(t);
    const out = {
      N, H, W, type, centres, inner, depths, slots, byTarget, edgeCands: packedEdges, facePerms,
      permOf, compose, centreSafe, reduce, GROUPS, parityAlgs, toks, COL,
    };
    built.set(N, out);
    return out;
  }

  // -------------------------------------------------------------- scoring
  // Colours are small numbers while solving, so a pair of wing stickers is one number.
  const CODE = { W: 0, Y: 1, G: 2, B: 3, R: 4, O: 5 };
  const LETTER = ['W', 'Y', 'G', 'B', 'R', 'O'];
  // An edge is always named with its two colours in the same order, so the same edge
  // is called the same thing every time the guide mentions it.
  function pairName(key) {
    const a = key >> 3, b = key & 7;
    const lo = Math.min(a, b), hi = Math.max(a, b);
    return cname(LETTER[lo]) + ' and ' + cname(LETTER[hi]);
  }

  // How far one edge slot is: the most wings that already agree. On an odd cube the
  // middle piece cannot move, so it decides the pair; on an even cube the most common
  // pair does. The pairs go through one shared scratch buffer, because this runs
  // millions of times in a search.
  const PAIRS = new Int32Array(8);
  function bestOfPairs(w, middleIdx) {
    let best = 0;
    if (middleIdx >= 0) {
      const ref = PAIRS[middleIdx];
      for (let i = 0; i < w; i++) if (PAIRS[i] === ref) best++;
      return best;
    }
    for (let i = 0; i < w; i++) {
      let n = 0;
      for (let j = 0; j < w; j++) if (PAIRS[j] === PAIRS[i]) n++;
      if (n > best) best = n;
    }
    return best;
  }
  // ...as the slot stands now
  function slotBest(state, s, w) {
    for (let i = 0; i < w; i++) PAIRS[i] = state[s.aIdx[i]] * 8 + state[s.bIdx[i]];
    return bestOfPairs(w, s.middleIdx);
  }
  // ...and as it would stand after a candidate, whose packed data says where each of
  // the slot's wing stickers would come from.
  function slotBestAfter(state, data, base, s, w) {
    for (let i = 0; i < w; i++) PAIRS[i] = state[data[base + 2 * i]] * 8 + state[data[base + 2 * i + 1]];
    return bestOfPairs(w, s.middleIdx);
  }
  // The colour pair the slot is settling on, and how many of its wings have it.
  function slotInfo(state, s, w) {
    for (let i = 0; i < w; i++) PAIRS[i] = state[s.aIdx[i]] * 8 + state[s.bIdx[i]];
    if (s.middleIdx >= 0) {
      const ref = PAIRS[s.middleIdx];
      let count = 0;
      for (let i = 0; i < w; i++) if (PAIRS[i] === ref) count++;
      return { ref, count };
    }
    let ref = PAIRS[0], count = 0;
    for (let i = 0; i < w; i++) {
      let n = 0;
      for (let j = 0; j < w; j++) if (PAIRS[j] === PAIRS[i]) n++;
      if (n > count) { count = n; ref = PAIRS[i]; }
    }
    return { ref, count };
  }
  // Every edge that is finished, named by its colour pair. Two finished edges can
  // trade places in one step, so the colours, not the place, say which edge is which.
  const pairedEdges = (T, state) => T.slots.filter((s) => slotBest(state, s, T.W) === T.W)
    .map((s) => ({ slot: s, ref: slotInfo(state, s, T.W).ref }));

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
          : 'First, turn the WHOLE cube like this. On a ' + N + '\u00d7' + N + ' any way up is fine, and this way has the most centre squares already in place.', best.alg, []);
      }
    }

    // ---- centres
    const ORDER = ['D', 'U', 'F', 'R', 'B', 'L'];
    const done = [];
    let intro = 'On a big cube the middle squares can move about, so first we build the six centres, one colour each. ';
    for (const f of ORDER.slice(0, 5)) {
      const want = col(f);
      const colour = cname(want);
      const side = SIDE[f].toUpperCase();
      const fi = FACES.indexOf(f);
      const doneFi = done.map((g) => FACES.indexOf(g));
      let first = true;
      while (countFace(cur, f) < T.inner) {
        const best = search(T, T.byTarget[f], cur, (state, c) => {
          const cells = c.cells;
          for (const gi of doneFi) {                       // never spoil a finished centre
            const cg = col(FACES[gi]);
            for (let k = cells[gi]; k < cells[gi + 1]; k++) if (state[cells[7 + 2 * k + 1]] !== cg) return null;
          }
          let gain = 0;
          for (let k = cells[fi]; k < cells[fi + 1]; k++) {
            gain += (state[cells[7 + 2 * k + 1]] === want) - (state[cells[7 + 2 * k]] === want);
          }
          return gain > 0 ? gain : null;
        });
        if (!best) throw SolverBug('Centre search stuck on ' + f);
        const moves = model.parseAlg(best.setup.concat(best.c.alg.split(' ')));
        const p = T.permOf(moves);
        const highlight = [];
        for (const i of T.centres[f]) if (cur[p[i]] === want && model.GEO[p[i]].face !== f) highlight.push(p[i]);
        const placed = countFace(model.applyAlg(cur, moves), f);
        const gain = placed - countFace(cur, f);
        if (gain < 1) throw SolverBug('Centre step made no progress on ' + f);
        const squares = gain === 1 ? 'one more ' + colour + ' square' : gain + ' more ' + colour + ' squares';
        // The first card for a side explains the job; the rest count the progress, so
        // a child can see the side filling up instead of reading the same words again.
        const score = placed === T.inner ? ' That side is done!' : ' That makes ' + placed + ' out of ' + T.inner + '.';
        emit('centres', first
          ? intro + 'Make the middle of the ' + side + ' side all ' + colour.toUpperCase() + '. This trick brings ' + squares + ' there.' + (placed === T.inner ? ' That side is done!' : '')
          : 'This trick brings ' + squares + ' to the ' + side + ' side.' + score,
        moves, highlight);
        intro = '';
        first = false;
      }
      done.push(f);
    }
    for (const f of FACES) if (countFace(cur, f) !== T.inner) throw SolverBug('Centres not finished on ' + f);

    // ---- edges
    intro = 'Now we join the edge pieces, so each edge is one colour on each side, like a 3\u00d73 edge. ';
    {
      const W = T.W;
      let state = cur.map((c) => CODE[c]);
      let was = pairedEdges(T, state);
      while (was.length < 12) {
        const wasKeys = was.map((e) => e.ref);
        let base = null, baseState = null;
        const best = search(T, T.edgeCands, state, (st, c) => {
          if (st !== baseState) {
            baseState = st;
            base = T.slots.map((s) => { const b = slotBest(st, s, W); return b * b; });
          }
          const data = c.slots;
          const n = data[0];
          let gain = 0;
          for (let j = 0; j < n; j++) {
            const s = T.slots[data[1 + j]];
            const b = slotBestAfter(st, data, 1 + n + j * 2 * W, s, W);
            gain += b * b - base[s.index];               // squared, so joining a third piece beats starting a new pair
          }
          return gain > 0 ? gain : null;
        });
        if (!best) throw SolverBug('Edge search stuck');
        const moves = model.parseAlg(best.setup.concat(best.c.alg.split(' ')));
        const p = T.permOf(moves);
        const next = new Array(state.length);
        for (let i = 0; i < state.length; i++) next[i] = state[p[i]];
        const now = pairedEdges(T, next);
        const nowKeys = now.map((e) => e.ref);
        // Which edge did this step help? One that is finished now, or the one closest to it.
        const fresh = now.find((e) => !wasKeys.includes(e.ref));
        // Sometimes the only way on is to take a finished edge apart again. Say so,
        // so a child is not puzzled when that edge comes round a second time.
        const broke = wasKeys.filter((k) => !nowKeys.includes(k)).length;
        const apology = broke === 0 ? ''
          : broke === 1 ? ' It pulls another edge apart for a moment, and we come back to that one later.'
            : ' It pulls ' + broke + ' other edges apart for a moment, and we come back to those later.';
        let slot, info, text;
        if (fresh !== undefined) {
          slot = fresh.slot;
          info = { ref: fresh.ref, count: W };
          const joined = W - slotInfo(state, slot, W).count;
          text = 'Join the last ' + (joined === 1 ? 'piece' : joined + ' pieces') + ' of the ' + pairName(info.ref) + ' edge. That whole edge matches now.';
        } else {
          let top = null;
          for (const s of T.slots) {
            const si = slotInfo(next, s, W);
            if (si.count < W && (!top || si.count > top.count)) top = { slot: s, ref: si.ref, count: si.count };
          }
          if (!top) throw SolverBug('Edge step helped nothing');
          slot = top.slot;
          info = top;
          text = 'Join another ' + pairName(info.ref) + ' piece. That edge now has ' + info.count + ' of ' + W + ' pieces matching.';
        }
        const highlight = [];
        for (let i = 0; i < W; i++) {
          if (next[slot.aIdx[i]] * 8 + next[slot.bIdx[i]] === info.ref) highlight.push(p[slot.aIdx[i]], p[slot.bIdx[i]]);
        }
        emit('edges', intro + text + apology, moves, highlight);
        intro = '';
        state = next;
        was = now;
      }
      if (state.map((c) => LETTER[c]).join('') !== cur.join('')) throw SolverBug('Edge bookkeeping drifted');
    }
    if (FACES.some((f) => countFace(cur, f) !== T.inner)) throw SolverBug('Centres broken while pairing edges');

    // ---- parity: only an even cube can look like an impossible 3x3 here
    const UF = T.GROUPS[7].concat(T.GROUPS[2 * 9 + 1]);
    const UB = T.GROUPS[1].concat(T.GROUPS[5 * 9 + 1]);
    for (let round = 0; round < 3; round++) {
      const v = Cube.validate(T.reduce(cur));
      if (v.ok) break;
      if (round === 2) throw SolverBug('Reduced cube is not a real 3x3: ' + v.reason);
      const bigCubeDoes = 'A big cube can do something a 3\u00d73 never does: ';
      if (/flipped/.test(v.reason)) {
        // On a 6x6 each set of edge pieces needs the trick once. Two 15-move halves
        // are friendlier on a card than one 30-move wall.
        const parts = T.parityAlgs.flipParts;
        parts.forEach((alg, k) => {
          emit('parity', bigCubeDoes + 'one whole edge is turned round. ' + (parts.length === 1
            ? 'Hold the cube still and do this long trick slowly, one move at a time. It turns the top-front edge round.'
            : 'The fix comes in ' + parts.length + ' halves, one for each set of edge pieces. Hold the cube still and do half ' + (k + 1) + ' slowly, one move at a time.'), alg, UF);
        });
      } else if (/swapped/.test(v.reason)) {
        if (!T.parityAlgs.swap) throw SolverBug('No swap parity algorithm for ' + N);
        emit('parity', bigCubeDoes + 'two edges are swapped. Hold the cube still and do this trick slowly, one move at a time. It swaps the top-front and top-back edges.', T.parityAlgs.swap, UF.concat(UB));
      } else {
        throw SolverBug('Reduced cube is not a real 3x3: ' + v.reason);
      }
      if (pairedEdges(T, cur.map((c) => CODE[c])).length !== 12 || FACES.some((f) => countFace(cur, f) !== T.inner)) throw SolverBug('Parity trick broke the cube');
    }

    // ---- the 3x3 from here
    const res = Solver.solve(T.reduce(cur));
    intro = 'Now the cube works just like a 3\u00d73! ';
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
