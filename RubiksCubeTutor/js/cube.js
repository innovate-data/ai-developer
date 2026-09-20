/*
 * Cube Clubhouse - Copyright (c) 2026 Ira Learning LLC. All rights reserved.
 * Proprietary software. See LICENSE, or the Licence page inside the app.
 */
/*
 * cube.js - Rubik's cube model used by Cube Clubhouse.
 *
 * The cube is stored as 54 "facelets" (stickers). Face order is U R F D L B,
 * nine stickers per face, row-major as seen from outside the cube:
 *   U: row 0 is the back row, D: row 0 is the front row,
 *   F/R/B/L: row 0 is the top row; columns run left-to-right as you look at the face.
 *
 * Every move is derived geometrically (rotate cubie positions + sticker normals),
 * so face turns, slice moves, wide moves and whole-cube rotations all come from
 * the same code and cannot disagree with each other.
 *
 * Works both in the browser (window.RC.Cube) and in Node (module.exports).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.RC = root.RC || {};
    root.RC.Cube = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const FACES = ['U', 'R', 'F', 'D', 'L', 'B'];
  const FACE_INDEX = { U: 0, R: 1, F: 2, D: 3, L: 4, B: 5 };
  const OPPOSITE = { U: 'D', D: 'U', R: 'L', L: 'R', F: 'B', B: 'F' };

  // Colour letters and friendly names. Solved cube: yellow on top, white on the
  // bottom (the way the beginner method holds the cube), green in front.
  const COLOR_NAMES = { W: 'white', Y: 'yellow', G: 'green', B: 'blue', R: 'red', O: 'orange' };
  const SOLVED_FACE_COLORS = { U: 'Y', R: 'O', F: 'G', D: 'W', L: 'R', B: 'B' };
  const OPPOSITE_COLOR = { W: 'Y', Y: 'W', G: 'B', B: 'G', R: 'O', O: 'R' };

  // ---------------------------------------------------------------- geometry
  function faceletGeo(face, i) {
    const r = (i / 3) | 0;
    const c = i % 3;
    switch (face) {
      case 'U': return { pos: [c - 1, 1, r - 1], n: [0, 1, 0] };
      case 'D': return { pos: [c - 1, -1, 1 - r], n: [0, -1, 0] };
      case 'F': return { pos: [c - 1, 1 - r, 1], n: [0, 0, 1] };
      case 'B': return { pos: [1 - c, 1 - r, -1], n: [0, 0, -1] };
      case 'R': return { pos: [1, 1 - r, 1 - c], n: [1, 0, 0] };
      case 'L': return { pos: [-1, 1 - r, c - 1], n: [-1, 0, 0] };
    }
    throw new Error('bad face ' + face);
  }

  const key = (p, n) => p.join(',') + '|' + n.join(',');

  const GEO = [];              // index -> {face, i, pos, n}
  const LOOKUP = new Map();    // "pos|normal" -> index
  for (let f = 0; f < 6; f++) {
    for (let i = 0; i < 9; i++) {
      const g = faceletGeo(FACES[f], i);
      g.face = FACES[f];
      g.i = i;
      g.index = f * 9 + i;
      GEO.push(g);
      LOOKUP.set(key(g.pos, g.n), g.index);
    }
  }

  // Quarter-turn rotation of a vector. k=1 is the direction of U (axis y),
  // R (axis x) and F (axis z) respectively.
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

  const AXIS_OF = { x: 0, y: 1, z: 2 };

  // Base moves: which axis, which layers (coordinate along that axis) and the
  // direction of one quarter turn relative to the U/R/F direction.
  const BASE_MOVES = {
    U: { axis: 'y', layers: [1], k: 1 },
    D: { axis: 'y', layers: [-1], k: -1 },
    R: { axis: 'x', layers: [1], k: 1 },
    L: { axis: 'x', layers: [-1], k: -1 },
    F: { axis: 'z', layers: [1], k: 1 },
    B: { axis: 'z', layers: [-1], k: -1 },
    u: { axis: 'y', layers: [1, 0], k: 1 },
    d: { axis: 'y', layers: [-1, 0], k: -1 },
    r: { axis: 'x', layers: [1, 0], k: 1 },
    l: { axis: 'x', layers: [-1, 0], k: -1 },
    f: { axis: 'z', layers: [1, 0], k: 1 },
    b: { axis: 'z', layers: [-1, 0], k: -1 },
    M: { axis: 'x', layers: [0], k: -1 },
    E: { axis: 'y', layers: [0], k: -1 },
    S: { axis: 'z', layers: [0], k: 1 },
    x: { axis: 'x', layers: [-1, 0, 1], k: 1 },
    y: { axis: 'y', layers: [-1, 0, 1], k: 1 },
    z: { axis: 'z', layers: [-1, 0, 1], k: 1 },
  };

  const MOVE_RE = /^([UDLRFBudlrfbMESxyz])(['2]?)$/;

  function parseMove(token) {
    const m = MOVE_RE.exec(token);
    if (!m) throw new Error('Unknown move: ' + token);
    const base = BASE_MOVES[m[1]];
    const mult = m[2] === "'" ? -1 : m[2] === '2' ? 2 : 1;
    return { token, letter: m[1], suffix: m[2], axis: base.axis, layers: base.layers, k: base.k * mult, isRotation: 'xyz'.includes(m[1]) };
  }

  const permCache = new Map();

  // perm[dest] = src : newState[dest] = oldState[src]
  function movePerm(token) {
    if (permCache.has(token)) return permCache.get(token);
    const mv = parseMove(token);
    const ai = AXIS_OF[mv.axis];
    const perm = new Array(54);
    for (let i = 0; i < 54; i++) perm[i] = i;
    for (let i = 0; i < 54; i++) {
      const g = GEO[i];
      if (!mv.layers.includes(g.pos[ai])) continue;
      const dest = LOOKUP.get(key(rot(g.pos, mv.axis, mv.k), rot(g.n, mv.axis, mv.k)));
      perm[dest] = i;
    }
    permCache.set(token, perm);
    return perm;
  }

  function applyPerm(state, perm) {
    const out = new Array(54);
    for (let i = 0; i < 54; i++) out[i] = state[perm[i]];
    return out;
  }

  function parseAlg(alg) {
    if (Array.isArray(alg)) return alg.slice();
    return alg.replace(/[()\[\]]/g, ' ').trim().split(/\s+/).filter(Boolean);
  }

  function applyMove(state, token) {
    return applyPerm(state, movePerm(token));
  }

  function applyAlg(state, alg) {
    let s = state;
    for (const t of parseAlg(alg)) s = applyMove(s, t);
    return s;
  }

  function invertMove(token) {
    const mv = parseMove(token);
    if (mv.suffix === '2') return token;
    return mv.suffix === "'" ? mv.letter : mv.letter + "'";
  }

  function invertAlg(alg) {
    return parseAlg(alg).reverse().map(invertMove);
  }

  // ------------------------------------------------------------------ pieces
  const cubieMap = new Map(); // pos key -> {pos, faces, idx}
  for (const g of GEO) {
    const k = g.pos.join(',');
    if (!cubieMap.has(k)) cubieMap.set(k, { pos: g.pos, faces: [], idx: [] });
    const cb = cubieMap.get(k);
    cb.faces.push(g.face);
    cb.idx.push(g.index);
  }
  const CUBIES = Array.from(cubieMap.values());
  const EDGES = CUBIES.filter((c) => c.idx.length === 2);
  const CORNERS = CUBIES.filter((c) => c.idx.length === 3);
  const PIECE_BY_FACES = new Map();
  for (const c of CUBIES) {
    if (c.idx.length < 2) continue;
    c.name = c.faces.join('');
    PIECE_BY_FACES.set(sortLetters(c.faces.join('')), c);
  }

  function sortLetters(s) {
    return s.split('').sort().join('');
  }

  // The piece (edge or corner) sitting at a given position name, e.g. 'UF', 'DFR'.
  function pieceAt(name) {
    const p = PIECE_BY_FACES.get(sortLetters(name));
    if (!p) throw new Error('No piece position ' + name);
    return p;
  }

  // Facelet index of the sticker on `face` of the piece position `name`.
  function sticker(name, face) {
    const p = pieceAt(name);
    const i = p.faces.indexOf(face);
    if (i < 0) throw new Error('Position ' + name + ' has no sticker on ' + face);
    return p.idx[i];
  }

  function pieceColors(state, piece) {
    return piece.idx.map((i) => state[i]);
  }

  // Find the piece whose stickers are exactly `colors` (any order).
  function findPiece(state, colors) {
    const want = sortLetters(colors.join(''));
    const list = colors.length === 2 ? EDGES : CORNERS;
    for (const p of list) {
      if (sortLetters(pieceColors(state, p).join('')) === want) return p;
    }
    return null;
  }

  // Which face of position `piece` currently shows `color`.
  function faceOfColor(state, piece, color) {
    const i = piece.idx.findIndex((k) => state[k] === color);
    return i < 0 ? null : piece.faces[i];
  }

  function centerIndex(face) {
    return FACE_INDEX[face] * 9 + 4;
  }

  function center(state, face) {
    return state[centerIndex(face)];
  }

  function faceOfIndex(index) {
    return FACES[(index / 9) | 0];
  }

  // ------------------------------------------------------------------- state
  function solved() {
    const s = new Array(54);
    for (let f = 0; f < 6; f++) for (let i = 0; i < 9; i++) s[f * 9 + i] = SOLVED_FACE_COLORS[FACES[f]];
    return s;
  }

  function isSolved(state) {
    for (let f = 0; f < 6; f++) {
      const c = state[f * 9];
      for (let i = 1; i < 9; i++) if (state[f * 9 + i] !== c) return false;
    }
    return true;
  }

  function toString(state) {
    return state.join('');
  }

  function fromString(str) {
    const s = str.replace(/\s+/g, '').split('');
    if (s.length !== 54) throw new Error('State must have 54 stickers');
    return s;
  }

  // Random scramble of face turns, avoiding two consecutive turns of the same axis
  // (so "R L R" style sequences are allowed but "R R'" are not).
  function scramble(n, rng) {
    rng = rng || Math.random;
    const faces = ['U', 'D', 'L', 'R', 'F', 'B'];
    const suffixes = ['', "'", '2'];
    const out = [];
    let lastFace = null;
    let lastAxisFace = null;
    for (let i = 0; i < n; i++) {
      let f;
      do {
        f = faces[Math.floor(rng() * 6)];
      } while (f === lastFace || (lastAxisFace && OPPOSITE[f] === lastFace && f === lastAxisFace));
      lastAxisFace = lastFace;
      lastFace = f;
      out.push(f + suffixes[Math.floor(rng() * 3)]);
    }
    return out;
  }

  // -------------------------------------------------------------- validation
  // Build the 24 orientations of the solved cube so any rotated solved cube
  // can serve as the reference for a state whose centres have been rotated.
  const ORIENTATIONS = (function () {
    const out = [];
    const seen = new Set();
    const base = solved();
    const tops = ['', 'x', "x'", 'x2', 'z', "z'"];
    for (const t of tops) {
      for (const yy of ['', 'y', "y'", 'y2']) {
        const s = applyAlg(applyAlg(base, t), yy);
        const k = toString(s);
        if (!seen.has(k)) {
          seen.add(k);
          out.push(s);
        }
      }
    }
    return out;
  })();

  function referenceFor(state) {
    for (const o of ORIENTATIONS) {
      let ok = true;
      for (const f of FACES) if (center(o, f) !== center(state, f)) { ok = false; break; }
      if (ok) return o;
    }
    return null;
  }

  function permutationParity(perm) {
    let parity = 0;
    const seen = new Array(perm.length).fill(false);
    for (let i = 0; i < perm.length; i++) {
      if (seen[i]) continue;
      let len = 0;
      let j = i;
      while (!seen[j]) { seen[j] = true; j = perm[j]; len++; }
      parity ^= (len - 1) & 1;
    }
    return parity;
  }

  function cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  }
  function dot(a, b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  }

  // Return the corner's three facelet indices ordered clockwise as seen from
  // outside the cube, starting from the U/D sticker.
  function cornerClockwise(corner) {
    const ud = corner.faces.findIndex((f) => f === 'U' || f === 'D');
    const others = [0, 1, 2].filter((i) => i !== ud);
    const n0 = GEO[corner.idx[ud]].n;
    const n1 = GEO[corner.idx[others[0]]].n;
    const n2 = GEO[corner.idx[others[1]]].n;
    // Viewer sits outside along +pos. Triangle (n0,n1,n2) is counter-clockwise
    // for the viewer when its normal points toward the viewer.
    const ccw = dot(cross([n1[0] - n0[0], n1[1] - n0[1], n1[2] - n0[2]], [n2[0] - n0[0], n2[1] - n0[1], n2[2] - n0[2]]), corner.pos) > 0;
    return ccw ? [corner.idx[ud], corner.idx[others[1]], corner.idx[others[0]]] : [corner.idx[ud], corner.idx[others[0]], corner.idx[others[1]]];
  }

  /**
   * Check whether a facelet array describes a cube that can actually exist
   * (correct sticker counts, real pieces, no flipped edge, twisted corner or
   * swapped pair). Returns {ok:true} or {ok:false, reason:string}.
   */
  function validate(state) {
    if (!state || state.length !== 54) return { ok: false, reason: 'A cube has exactly 54 stickers.' };
    const counts = {};
    for (const c of state) counts[c] = (counts[c] || 0) + 1;
    for (const c of Object.keys(COLOR_NAMES)) {
      if ((counts[c] || 0) !== 9) {
        return { ok: false, reason: 'There should be 9 ' + COLOR_NAMES[c] + ' stickers, but I count ' + (counts[c] || 0) + '.' };
      }
    }
    const ref = referenceFor(state);
    if (!ref) return { ok: false, reason: 'The centre stickers are not arranged like a real cube.' };

    const udColors = [center(state, 'U'), center(state, 'D')];
    const fbColors = [center(state, 'F'), center(state, 'B')];

    // Edges: every edge must be a real piece, used once; flips must be even.
    const edgeHome = new Array(EDGES.length).fill(-1);
    let flips = 0;
    for (let i = 0; i < EDGES.length; i++) {
      const e = EDGES[i];
      const cols = pieceColors(state, e);
      const home = EDGES.findIndex((h) => sortLetters(pieceColors(ref, h).join('')) === sortLetters(cols.join('')));
      if (home < 0) return { ok: false, reason: 'There is no ' + COLOR_NAMES[cols[0]] + '-' + COLOR_NAMES[cols[1]] + ' edge on a real cube. Check the edge stickers.' };
      if (edgeHome.includes(home)) return { ok: false, reason: 'The ' + COLOR_NAMES[cols[0]] + '-' + COLOR_NAMES[cols[1]] + ' edge appears twice.' };
      edgeHome[i] = home;
      const refFaceIdx = e.faces.findIndex((f) => f === 'U' || f === 'D');
      const refFace = refFaceIdx >= 0 ? refFaceIdx : e.faces.findIndex((f) => f === 'F' || f === 'B');
      const refColor = cols.find((c) => udColors.includes(c)) || cols.find((c) => fbColors.includes(c));
      if (state[e.idx[refFace]] !== refColor) flips++;
    }
    if (flips % 2 !== 0) return { ok: false, reason: 'One edge piece looks flipped. Double-check the edge stickers.' };

    // Corners
    const cornerHome = new Array(CORNERS.length).fill(-1);
    let twist = 0;
    for (let i = 0; i < CORNERS.length; i++) {
      const c = CORNERS[i];
      const cols = pieceColors(state, c);
      const home = CORNERS.findIndex((h) => sortLetters(pieceColors(ref, h).join('')) === sortLetters(cols.join('')));
      if (home < 0) return { ok: false, reason: 'There is no ' + cols.map((x) => COLOR_NAMES[x]).join('-') + ' corner on a real cube. Check the corner stickers.' };
      if (cornerHome.includes(home)) return { ok: false, reason: 'The ' + cols.map((x) => COLOR_NAMES[x]).join('-') + ' corner appears twice.' };
      cornerHome[i] = home;
      // Compare the three colours in clockwise order, not as an unordered set. A corner
      // with two of its side stickers swapped is a mirror image: it has the right colours
      // and the right U/D sticker on top, so counts, piece identity and twist parity all
      // pass, yet no such corner exists on a real cube.
      const cwHome = cornerClockwise(CORNERS[home]);
      const refCols = cwHome.map((k) => ref[k]);
      const cols3 = cornerClockwise(c).map((k) => state[k]);
      const rot = refCols.indexOf(cols3[0]);
      if (rot < 0 || cols3.some((x, j) => x !== refCols[(rot + j) % 3])) {
        return { ok: false, reason: 'The three colours on one corner are in the wrong order: ' + cols3.map((x) => COLOR_NAMES[x]).join(', ') + '. Two of them need swapping.' };
      }
      twist += rot;
    }
    if (twist % 3 !== 0) return { ok: false, reason: 'One corner piece looks twisted. Double-check the corner stickers.' };

    if (permutationParity(edgeHome) !== permutationParity(cornerHome)) {
      return { ok: false, reason: 'Two pieces look swapped. That cannot happen on a real cube. Check the stickers again.' };
    }
    return { ok: true };
  }

  return {
    FACES, FACE_INDEX, OPPOSITE, COLOR_NAMES, OPPOSITE_COLOR, SOLVED_FACE_COLORS,
    GEO, EDGES, CORNERS, CUBIES,
    parseMove, parseAlg, movePerm, applyMove, applyAlg, invertMove, invertAlg,
    pieceAt, sticker, pieceColors, findPiece, faceOfColor, center, centerIndex, faceOfIndex,
    solved, isSolved, toString, fromString, scramble, validate, referenceFor, cornerClockwise,
  };
});
