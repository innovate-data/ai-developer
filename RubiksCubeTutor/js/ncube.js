/*
 * ncube.js - an N x N x N cube model, for N from 2 to 6 (and beyond).
 *
 * Built exactly like cube.js: every sticker knows its 3D position and outward normal,
 * and a move is "rotate the stickers in these layers". For N = 3 the sticker indices
 * are identical to cube.js, so a 3x3 state from either module can be handed to the
 * other. cube.js stays the home of the 3x3 solver and validity check.
 *
 * Coordinates: layer c (0..N-1) sits at c - (N-1)/2, so a 3x3 uses -1, 0, 1 and a 4x4
 * uses -1.5, -0.5, 0.5, 1.5.
 *
 * Move tokens: U D L R F B with ' or 2; a leading depth turns one inner layer
 * ("2U" is the second layer from the top, turning like U); a trailing w turns all
 * layers to that depth ("Uw", "3Rw"); lowercase u..b is a two-layer wide turn;
 * M E S the middle slice of an odd cube; x y z the whole cube.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.RC = root.RC || {};
    root.RC.NCube = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const FACES = ['U', 'R', 'F', 'D', 'L', 'B'];
  const COLOR_NAMES = { W: 'white', Y: 'yellow', G: 'green', B: 'blue', R: 'red', O: 'orange' };
  const SOLVED_FACE_COLORS = { U: 'Y', R: 'O', F: 'G', D: 'W', L: 'R', B: 'B' };
  const AXIS_OF = { x: 0, y: 1, z: 2 };
  // face -> axis, which end of the axis, and the direction of one quarter turn
  const FACE_AXIS = { U: ['y', 1, 1], D: ['y', -1, -1], R: ['x', 1, 1], L: ['x', -1, -1], F: ['z', 1, 1], B: ['z', -1, -1] };
  const SLICE = { M: ['x', -1], E: ['y', -1], S: ['z', 1] };
  const SIDE_NAME = { U: 'top', D: 'bottom', R: 'right', L: 'left', F: 'front', B: 'back' };
  const ordinal = (n) => {
    const tens = n % 100;
    if (tens >= 11 && tens <= 13) return n + 'th';
    return n + (['th', 'st', 'nd', 'rd'][n % 10] || 'th');
  };

  function rot(v, axis, k) {
    k = ((k % 4) + 4) % 4;
    let [x, y, z] = v;
    for (let s = 0; s < k; s++) {
      if (axis === 'y') [x, y, z] = [-z, y, x];
      else if (axis === 'x') [x, y, z] = [x, z, -y];
      else [x, y, z] = [y, -x, z];
    }
    return [x, y, z];
  }
  const key = (p, n) => p.join(',') + '|' + n.join(',');

  function make(N) {
    if (!Number.isInteger(N) || N < 2) throw new Error('A cube needs at least 2 layers');
    const H = (N - 1) / 2;
    const coords = [];
    for (let c = 0; c < N; c++) coords.push(c - H);
    const FACE_INDEX = {};
    FACES.forEach((f, i) => { FACE_INDEX[f] = i; });

    const z0 = (v) => (v === 0 ? 0 : v);   // never a negative zero in a coordinate
    function faceletGeo(face, r, c) {
      const pr = r - H, pc = c - H;
      const at = (a, b, c2, n) => ({ pos: [z0(a), z0(b), z0(c2)], n });
      switch (face) {
        case 'U': return at(pc, H, pr, [0, 1, 0]);
        case 'D': return at(pc, -H, -pr, [0, -1, 0]);
        case 'F': return at(pc, -pr, H, [0, 0, 1]);
        case 'B': return at(-pc, -pr, -H, [0, 0, -1]);
        case 'R': return at(H, -pr, -pc, [1, 0, 0]);
        case 'L': return at(-H, -pr, pc, [-1, 0, 0]);
      }
      throw new Error('bad face ' + face);
    }

    const GEO = [];
    const LOOKUP = new Map();
    for (let f = 0; f < 6; f++) {
      for (let r = 0; r < N; r++) {
        for (let c = 0; c < N; c++) {
          const g = faceletGeo(FACES[f], r, c);
          g.face = FACES[f]; g.r = r; g.c = c; g.index = GEO.length;
          GEO.push(g);
          LOOKUP.set(key(g.pos, g.n), g.index);
        }
      }
    }
    const COUNT = GEO.length;

    // depth d from a face's end of the axis: 1 is the outer layer
    const layerAt = (end, d) => end * (H - (d - 1));

    const MOVE_RE = /^(\d*)([UDLRFB])(w?)(['2]?)$/;
    function parseMove(token) {
      let m;
      if ((m = /^([xyz])(['2]?)$/.exec(token))) {
        const mult = m[2] === "'" ? -1 : m[2] === '2' ? 2 : 1;
        return { token, letter: m[1], axis: m[1], layers: coords.slice(), k: mult, isRotation: true, depth: N, wide: true, suffix: m[2] };
      }
      if ((m = /^([MES])(['2]?)$/.exec(token))) {
        if (N % 2 === 0) throw new Error(token + ' needs a middle layer, and a ' + N + 'x' + N + ' has none');
        const [axis, dir] = SLICE[m[1]];
        const mult = m[2] === "'" ? -1 : m[2] === '2' ? 2 : 1;
        return { token, letter: m[1], axis, layers: [0], k: dir * mult, isRotation: false, depth: 0, wide: false, suffix: m[2] };
      }
      const typed = token;                     // lowercase moves are rewritten below
      if ((m = /^([udlrfb])(['2]?)$/.exec(token))) token = '2' + m[1].toUpperCase() + 'w' + m[2];
      m = MOVE_RE.exec(token);
      if (!m) throw new Error('Unknown move: ' + typed);
      const wide = m[3] === 'w';
      const depth = m[1] ? parseInt(m[1], 10) : wide ? 2 : 1;   // a plain "Rw" is two layers
      if (depth < 1 || depth >= N) throw new Error(typed + ': a ' + N + 'x' + N + ' has no layer ' + depth + ' from that side');
      const [axis, end, dir] = FACE_AXIS[m[2]];
      const mult = m[4] === "'" ? -1 : m[4] === '2' ? 2 : 1;
      const layers = [];
      if (wide) for (let d = 1; d <= depth; d++) layers.push(layerAt(end, d));
      else layers.push(layerAt(end, depth));
      return { token: typed, letter: m[2], axis, layers, k: dir * mult, isRotation: false, depth, wide, suffix: m[4] };
    }

    const permCache = new Map();
    function movePerm(token) {
      if (permCache.has(token)) return permCache.get(token);
      const mv = parseMove(token);
      const ai = AXIS_OF[mv.axis];
      const perm = new Array(COUNT);
      for (let i = 0; i < COUNT; i++) perm[i] = i;
      for (let i = 0; i < COUNT; i++) {
        const g = GEO[i];
        if (!mv.layers.includes(g.pos[ai])) continue;
        const dest = LOOKUP.get(key(rot(g.pos, mv.axis, mv.k), rot(g.n, mv.axis, mv.k)));
        perm[dest] = i;
      }
      permCache.set(token, perm);
      return perm;
    }
    const applyPerm = (state, perm) => { const out = new Array(COUNT); for (let i = 0; i < COUNT; i++) out[i] = state[perm[i]]; return out; };
    const parseAlg = (alg) => (Array.isArray(alg) ? alg.slice() : alg.replace(/[()[\]]/g, ' ').trim().split(/\s+/).filter(Boolean));
    const applyMove = (state, token) => applyPerm(state, movePerm(token));
    const applyAlg = (state, alg) => { let s = state; for (const t of parseAlg(alg)) s = applyMove(s, t); return s; };
    function invertMove(token) {
      const mv = parseMove(token);
      if (mv.suffix === '2') return token;
      const base = token.replace(/['2]$/, '');
      return mv.suffix === "'" ? base : base + "'";
    }
    const invertAlg = (alg) => parseAlg(alg).reverse().map(invertMove);

    const solved = () => { const s = new Array(COUNT); for (let f = 0; f < 6; f++) for (let i = 0; i < N * N; i++) s[f * N * N + i] = SOLVED_FACE_COLORS[FACES[f]]; return s; };
    const isSolved = (state) => { for (let f = 0; f < 6; f++) { const c = state[f * N * N]; for (let i = 1; i < N * N; i++) if (state[f * N * N + i] !== c) return false; } return true; };
    const toString = (state) => state.join('');

    // The moves a child gets buttons for: outer faces, then each inner layer down to
    // the middle. On a 5x5 that is depths 1 and 2; the exact middle never needs to move.
    const maxDepth = Math.floor(N / 2);
    function padRows() {
      const rows = [];
      for (let d = 1; d <= maxDepth; d++) {
        const p = d === 1 ? '' : String(d);
        rows.push({ depth: d, moves: [p + 'U', p + "U'", p + 'L', p + "L'", p + 'F', p + "F'"] });
        rows.push({ depth: d, moves: [p + 'R', p + "R'", p + 'B', p + "B'", p + 'D', p + "D'"] });
      }
      rows.push({ depth: 0, moves: ['y', "y'", 'x', "x'"] });
      return rows;
    }
    const scrambleMoves = (() => { const out = []; for (let d = 1; d <= maxDepth; d++) for (const f of FACES) out.push((d === 1 ? '' : d) + f); return out; })();
    // Which layer a move turns. Two moves commute exactly when they share an axis, so
    // turning the same layer again with only same-axis moves in between wastes both.
    const layerSig = (m) => { const mv = parseMove(m); return mv.axis + ':' + mv.layers[0]; };
    function scramble(n, rng) {
      rng = rng || Math.random;
      const suffixes = ['', "'", '2'];
      const out = [];
      let last = null;
      let prev = null;
      for (let i = 0; i < n; i++) {
        let m, sig;
        do {
          m = scrambleMoves[Math.floor(rng() * scrambleMoves.length)];
          sig = layerSig(m);
        } while (sig === last || (prev && sig === prev && last && last.split(':')[0] === sig.split(':')[0]));
        prev = last;
        last = sig;
        out.push(m + suffixes[Math.floor(rng() * 3)]);
      }
      return out;
    }

    // Words a child can act on, for the tokens the 3x3 lessons do not already describe.
    function describe(token) {
      const mv = parseMove(token);
      const twice = mv.suffix === '2';
      const prime = mv.suffix === "'";
      if (mv.isRotation) {
        const w = { y: ['Turn the WHOLE cube to the left, like a spinning plate.', 'Turn the WHOLE cube to the right, like a spinning plate.'],
                    x: ['Roll the WHOLE cube away from you.', 'Roll the WHOLE cube towards you.'],
                    z: ['Tilt the WHOLE cube to the right, like a steering wheel.', 'Tilt the WHOLE cube to the left, like a steering wheel.'] }[mv.axis];
        return twice ? w[0].replace('.', ', twice.') : w[prime ? 1 : 0];
      }
      if (mv.depth === 0) {
        const slice = { M: ['between the LEFT and RIGHT sides, the same way as the left side', 'x'],
                        E: ['between the TOP and BOTTOM, the same way as the bottom', 'y'],
                        S: ['between the FRONT and BACK, the same way as the front', 'z'] }[mv.letter];
        if (twice) return 'Turn the middle slice ' + slice[0] + ', twice.';
        return 'Turn the middle slice ' + slice[0] + (prime ? ', the other way.' : '.');
      }
      const side = SIDE_NAME[mv.letter];
      const which = mv.wide ? 'the ' + mv.depth + ' layers nearest the ' + side
        : mv.depth === 1 ? 'the ' + side.toUpperCase() + (mv.letter === 'U' || mv.letter === 'D' ? ' layer' : ' side')
        : 'ONLY the ' + ordinal(mv.depth) + ' layer from the ' + side;
      const how = {
        U: ['to the left. The part nearest you goes left', 'to the right. The part nearest you goes right'],
        D: ['to the right. The part nearest you goes right', 'to the left. The part nearest you goes left'],
        R: ['so it rolls up and away from you', 'so it rolls down towards you'],
        L: ['so it rolls down towards you', 'so it rolls up and away from you'],
        F: ['so its top goes to the right', 'so its top goes to the left'],
        B: ['so its top goes to the left', 'so its top goes to the right'],
      }[mv.letter];
      if (twice) return 'Turn ' + which + ' twice, halfway round.';
      return 'Turn ' + which + ' ' + how[prime ? 1 : 0] + '.';
    }

    return {
      N, H, coords, FACES, FACE_INDEX, COLOR_NAMES, SOLVED_FACE_COLORS, GEO, COUNT,
      parseMove, movePerm, applyMove, applyAlg, parseAlg, invertMove, invertAlg,
      solved, isSolved, toString, scramble, padRows, describe, maxDepth,
    };
  }

  const cache = new Map();
  const get = (N) => { if (!cache.has(N)) cache.set(N, make(N)); return cache.get(N); };
  return { make: get, SIZES: [2, 3, 4, 5, 6] };
});
