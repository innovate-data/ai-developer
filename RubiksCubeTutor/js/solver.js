/*
 * Cube Clubhouse - Copyright (c) 2026 Ira Learning LLC. All rights reserved.
 * Proprietary software. See LICENSE, or the Licence page inside the app.
 */
/*
 * solver.js - Beginner "layer by layer" solver for Cube Clubhouse.
 *
 * It solves the cube exactly the way the lessons teach it, so every step it
 * produces can be shown to a child with a short explanation:
 *
 *   orient   - hold the cube with white on the bottom
 *   daisy    - four white edges around the yellow centre
 *   cross    - white cross on the bottom
 *   corners  - white corners with the "Righty" algorithm (R U R' U')
 *   middle   - middle layer edges with the right/left algorithms
 *   ycross   - yellow cross (F R U R' U' F')
 *   yedges   - yellow edges in place (R U R' U R U2 R' U swaps front and left)
 *   ycorners - yellow corners in place (U R U' L' U R' U' L keeps front-right)
 *   ytwist   - twist yellow corners (R' D' R D)
 *   finish   - final turn of the top
 *
 * solve(state) -> { steps: [{stage, text, moves:[tokens], highlight:[facelet idx]}], state }
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./cube.js'));
  } else {
    root.RC = root.RC || {};
    root.RC.Solver = factory(root.RC.Cube);
  }
})(typeof self !== 'undefined' ? self : this, function (Cube) {
  'use strict';

  const ALGS = {
    righty: "R U R' U'",
    rightyBack: "U R U' R'",     // Righty backwards: equals five Righties in a row
    lefty: "L' U' L U",
    middleRight: "U R U' R' U' F' U F",
    middleLeft: "U' L' U L U F U' F'",
    yellowCross: "F R U R' U' F'",
    yellowEdges: "R U R' U R U2 R' U",
    yellowCorners: "U R U' L' U R' U' L",
    twist: "R' D' R D",
    twistBack: "D' R' D R",      // the Twist trick backwards: two of these equal four twists
  };

  // Both tricks have order 6: doing one six times changes nothing. So r repetitions
  // equal (6 - r) repetitions of the trick backwards, and whenever r is 4 or 5 the
  // backwards version is far shorter. A child learns one idea, "the same trick,
  // backwards", and saves about a sixth of the moves in a solve.
  function repeatOrBackwards(reps, alg, back) {
    if (reps > 3) return { count: 6 - reps, alg: back, backwards: true };
    return { count: reps, alg, backwards: false };
  }

  // Internal failures are tagged so the UI can show a friendly message instead of a
  // developer string. A bad cube reported by validate() stays a plain Error.
  function SolverBug(msg) { const e = new Error(msg); e.internal = true; return e; }

  const STAGES = ['orient', 'daisy', 'cross', 'corners', 'middle', 'ycross', 'yedges', 'ycorners', 'ytwist', 'finish'];

  const SIDE_CYCLE = ['F', 'L', 'B', 'R'];               // where the F face goes under U / y
  const U_EDGE_CYCLE = ['UF', 'UL', 'UB', 'UR'];          // U sends UF -> UL -> UB -> UR
  const U_CORNER_CYCLE = ['UFR', 'UFL', 'UBL', 'UBR'];    // U sends UFR -> UFL -> ...
  const D_EDGES = ['DF', 'DR', 'DB', 'DL'];
  const D_CORNERS = ['DFR', 'DFL', 'DBL', 'DBR'];
  const E_EDGES = ['FR', 'FL', 'BL', 'BR'];
  const FACE_MOVES = ['U', "U'", 'U2', 'D', "D'", 'D2', 'L', "L'", 'L2', 'R', "R'", 'R2', 'F', "F'", 'F2', 'B', "B'", 'B2'];
  const POSITION_WORD = { UF: 'front', UB: 'back', UL: 'left', UR: 'right' };

  const cname = (c) => Cube.COLOR_NAMES[c];
  const CN = (c) => cname(c).toUpperCase();
  const turnToken = (letter, k) => {
    k = ((k % 4) + 4) % 4;
    return k === 0 ? null : k === 1 ? letter : k === 2 ? letter + '2' : letter + "'";
  };
  const sortLetters = (t) => t.split('').sort().join('');
  const joinWords = (a) => (a.length < 2 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1]);
  const nameOf = (piece) => piece.faces.join('');
  function cycleIndex(cycle, name) {
    const want = sortLetters(name);
    const i = cycle.findIndex((n) => sortLetters(n) === want);
    if (i < 0) throw new Error(name + ' is not in this layer');
    return i;
  }
  const withU = (s, k) => {
    const t = turnToken('U', k);
    return t ? Cube.applyMove(s, t) : s;
  };
  const withY = (s, k) => {
    const t = turnToken('y', k);
    return t ? Cube.applyMove(s, t) : s;
  };

  // ------------------------------------------------------------ predicates
  const center = (s, f) => Cube.center(s, f);

  function pieceSolved(s, name) {
    const p = Cube.pieceAt(name);
    return p.idx.every((i, k) => s[i] === center(s, p.faces[k]));
  }
  function cornerPositioned(s, name) {
    const p = Cube.pieceAt(name);
    const want = p.faces.map((f) => center(s, f)).sort().join('');
    return Cube.pieceColors(s, p).sort().join('') === want;
  }
  // edge at a U position with white facing up
  const petal = (s, name) => s[Cube.sticker(name, 'U')] === center(s, 'D');
  const yellowUp = (s, name) => s[Cube.sticker(name, 'U')] === center(s, 'U');
  const countPetals = (s) => U_EDGE_CYCLE.filter((e) => petal(s, e)).length;
  const countCrossEdges = (s) => D_EDGES.filter((e) => pieceSolved(s, e)).length;
  const countYellowEdges = (s) => U_EDGE_CYCLE.filter((e) => yellowUp(s, e)).length;

  const goals = {
    orient: () => true,
    // every white edge is either a daisy petal or already part of the white cross
    daisy: (s) => countPetals(s) + countCrossEdges(s) === 4,
    cross: (s) => countCrossEdges(s) === 4,
    corners: (s) => goals.cross(s) && D_CORNERS.every((c) => pieceSolved(s, c)),
    middle: (s) => goals.corners(s) && E_EDGES.every((e) => pieceSolved(s, e)),
    ycross: (s) => goals.middle(s) && countYellowEdges(s) === 4,
    yedges: (s) => goals.ycross(s) && U_EDGE_CYCLE.every((e) => pieceSolved(s, e)),
    ycorners: (s) => goals.yedges(s) && U_CORNER_CYCLE.every((c) => cornerPositioned(s, c)),
    ytwist: (s) => goals.middle(s) && [0, 1, 2, 3].some((k) => Cube.isSolved(withU(s, k))),
    finish: (s) => Cube.isSolved(s),
  };

  // The top-layer turn that puts the yellow edges into a named shape, e.g. 'UB,UL'
  // for the L the lesson asks the child to hold at the back and the left.
  function aufForShape(s, target) {
    for (let k = 0; k < 4; k++) {
      const set = U_EDGE_CYCLE.filter((e) => yellowUp(withU(s, k), e)).sort().join(',');
      if (set === target) return k;
    }
    return null;
  }

  // A 2x2 is the corners of a 3x3. To guide one, the 3x3 solver runs with these goals,
  // which never look at an edge, and skips every stage that only moves edges.
  const dCorners = (s) => D_CORNERS.every((c) => pieceSolved(s, c));
  const allCorners = (s) => D_CORNERS.concat(U_CORNER_CYCLE).every((c) => pieceSolved(s, c));
  const cornerGoals = {
    orient: () => true,
    daisy: () => true,
    cross: () => true,
    corners: dCorners,
    middle: dCorners,
    ycross: dCorners,
    yedges: dCorners,
    ycorners: (s) => dCorners(s) && U_CORNER_CYCLE.every((c) => cornerPositioned(s, c)),
    ytwist: (s) => dCorners(s) && [0, 1, 2, 3].some((k) => allCorners(withU(s, k))),
    finish: allCorners,
  };

  // Parity of where the four top corners sit against where their colours say they
  // belong. On a 3x3 it is always even once the edges are solved; on a 2x2 a single
  // top turn flips it, which is how the corner trick (a 3-cycle) can finish the job.
  function uCornerParity(s) {
    const perm = U_CORNER_CYCLE.map((name) => {
      const cols = Cube.pieceColors(s, Cube.pieceAt(name)).sort().join('');
      return U_CORNER_CYCLE.findIndex((n) => Cube.pieceAt(n).faces.map((f) => center(s, f)).sort().join('') === cols);
    });
    if (perm.includes(-1)) return -1;
    let parity = 0;
    const seen = [false, false, false, false];
    for (let i = 0; i < 4; i++) {
      if (seen[i]) continue;
      let j = i, len = 0;
      while (!seen[j]) { seen[j] = true; j = perm[j]; len++; }
      parity ^= (len - 1) & 1;
    }
    return parity;
  }

  // Shortest list of top-layer turns k (0..3) such that doing "U^k then alg"
  // repeatedly makes done(state) true. Depth-limited iterative deepening.
  function planAlg(state, alg, done, maxDepth) {
    if (done(state)) return [];
    const moves = Cube.parseAlg(alg);
    function rec(s, depth) {
      for (let k = 0; k < 4; k++) {
        const s1 = Cube.applyAlg(withU(s, k), moves);
        if (depth === 1) {
          if (done(s1)) return [k];
        } else {
          const r = rec(s1, depth - 1);
          if (r) return [k].concat(r);
        }
      }
      return null;
    }
    for (let d = 1; d <= maxDepth; d++) {
      const r = rec(state, d);
      if (r) return r;
    }
    return null;
  }

  // Iterative deepening DFS over face turns; returns the shortest move list
  // for which goal(state) is true, or null.
  function search(state, maxDepth, goal) {
    if (goal(state)) return [];
    const perms = FACE_MOVES.map((m) => ({ m, letter: m[0], perm: Cube.movePerm(m) }));
    function dfs(s, depth, lastLetter, path) {
      for (const mv of perms) {
        if (mv.letter === lastLetter) continue;
        const ns = new Array(54);
        for (let i = 0; i < 54; i++) ns[i] = s[mv.perm[i]];
        path.push(mv.m);
        if (depth === 1) {
          if (goal(ns)) return true;
        } else if (dfs(ns, depth - 1, mv.letter, path)) {
          return true;
        }
        path.pop();
      }
      return false;
    }
    for (let depth = 1; depth <= maxDepth; depth++) {
      const path = [];
      if (dfs(state, depth, null, path)) return path;
    }
    return null;
  }

  // Which top corner the corner algorithm keeps in place (computed, not remembered).
  const FIXED_CORNER = (function () {
    const s0 = Cube.solved();
    const s1 = Cube.applyAlg(s0, ALGS.yellowCorners);
    return U_CORNER_CYCLE.find((c) => cornerPositioned(s1, c));
  })();

  // If the first two layers are broken only because a learner is in the middle
  // of the twist stage, return how many more R' D' R D would restore them (1-5).
  // Returns 0 when the cube is not in such a state.
  function midTwistPhase(s, G) {
    G = G || goals;
    if (G.middle(s)) return 0;
    let t = s;
    for (let j = 1; j <= 5; j++) {
      t = Cube.applyAlg(t, ALGS.twist);
      if (G.middle(t)) {
        // the restored cube must also have its top layer ready for twisting
        const ready = [0, 1, 2, 3].some((k) => {
          const u = withU(t, k);
          return (G === cornerGoals || U_EDGE_CYCLE.every((e) => pieceSolved(u, e))) && U_CORNER_CYCLE.every((c) => cornerPositioned(u, c));
        });
        return ready ? j : 0;
      }
    }
    return 0;
  }

  // -------------------------------------------------------------- solver
  function solve(start, options) {
    const opts = options || {};
    const G = opts.cornersOnly ? cornerGoals : goals;
    if (!opts.cornersOnly) {
      const v = Cube.validate(start);
      if (!v.ok) throw new Error(v.reason);
    }

    let cur = start.slice();
    const steps = [];
    if (G.finish(cur)) return { steps, state: cur };

    function emit(stage, text, alg, highlight) {
      const moves = Cube.parseAlg(alg || '');
      if (moves.length === 0) return;
      cur = Cube.applyAlg(cur, moves);
      steps.push({ stage, text, moves, highlight: highlight || [] });
    }

    const C = (f) => center(cur, f);
    const white = () => C('D');
    const yellow = () => C('U');
    const faceOfCenter = (c) => Cube.FACES.find((f) => C(f) === c);
    const yTurnsToFront = (face) => (4 - SIDE_CYCLE.indexOf(face)) % 4;
    const faceAfterY = (face, k) => SIDE_CYCLE[(SIDE_CYCLE.indexOf(face) + k) % 4];
    // y-turn so that faces a,b become F and R (in some order)
    function yTokenForFR(a, b) {
      let k = yTurnsToFront(a);
      if (faceAfterY(b, k) !== 'R') k = yTurnsToFront(b);
      return turnToken('y', k);
    }
    const uTurnsFor = (cycle, from, to) => (cycleIndex(cycle, to) - cycleIndex(cycle, from) + 4) % 4;
    // A highlighted piece may be round the back of the picture; say where it is in words.
    const SIDE_WORD = { U: 'on top', D: 'on the bottom', F: 'at the front', B: 'at the back', L: 'on the left', R: 'on the right' };
    // "on top, at the front and on the left" - three "and"s in a row is a mouthful
    // for a child reading it out, and worse for the Read button.
    const listWords = (parts) => (parts.length < 3 ? parts.join(' and ') : parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1]);
    const whereIs = (piece) => 'It is ' + listWords(piece.faces.map((f) => SIDE_WORD[f])) + '.';
    const stickerFaces = (piece, color) => { const f = Cube.faceOfColor(cur, piece, color); return f ? ' Its ' + cname(color) + ' sticker faces ' + SIDE_WORD[f].replace(/^(on|at) (the )?/, 'the ') + '.' : ''; };
    // After "turn the whole cube", tell the child what they should now be looking at.
    const facesYou = (yTok) => ' Now the ' + cname(Cube.center(Cube.applyMove(cur, yTok), 'F')) + ' side faces you.';
    const uStickers = (list) => list.map((n) => Cube.sticker(n, 'U'));

    // ---- stage 0: hold the cube with white on the bottom
    {
      const f = faceOfCenter('W');
      const rotation = { D: '', U: 'x2', F: "x'", B: 'x', R: 'z', L: "z'" }[f];
      if (rotation) {
        emit('orient', 'First, hold the cube so the WHITE centre (the middle square) is on the bottom. The yellow centre will be on top.', rotation, [Cube.centerIndex(f)]);
      }
    }

    const resumeTwist = midTwistPhase(cur, G) > 0;

    // ---- stage 1: daisy
    if (!resumeTwist) {
      let guard = 0;
      while (!G.daisy(cur) && guard++ < 8) {
        const before = countPetals(cur) + countCrossEdges(cur);
        let best = null;
        for (const sc of ['F', 'R', 'B', 'L'].map((f) => C(f))) {
          const piece = Cube.findPiece(cur, [white(), sc]);
          if (Cube.faceOfColor(cur, piece, white()) === 'U') continue;                  // already a petal
          if (piece.faces.includes('D') && pieceSolved(cur, nameOf(piece))) continue;   // already in the cross
          const path = search(cur, 5, (s) => {
            const p = Cube.findPiece(s, [white(), sc]);
            return Cube.faceOfColor(s, p, white()) === 'U' && countPetals(s) + countCrossEdges(s) === before + 1;
          });
          if (path && (!best || path.length < best.path.length)) best = { path, sc, piece };
        }
        if (!best) throw SolverBug('Daisy search failed');
        emit('daisy', 'Find the edge with WHITE and ' + CN(best.sc) + '. ' + whereIs(best.piece) + stickerFaces(best.piece, white()) + ' Bring it up to the top, white facing up, like a daisy petal.', best.path, best.piece.idx);
      }
      if (!G.daisy(cur)) throw SolverBug('Daisy stage failed');
    }

    // ---- stage 2: white cross
    if (!resumeTwist) {
      let guard = 0;
      while (!G.cross(cur) && guard++ < 6) {
        const pos = U_EDGE_CYCLE.find((e) => petal(cur, e));
        if (!pos) throw SolverBug('Cross: no petal left');
        const p = Cube.pieceAt(pos);
        const sideFace = p.faces.find((f) => f !== 'U');
        const sideColor = cur[Cube.sticker(pos, sideFace)];
        const target = faceOfCenter(sideColor);
        const k = uTurnsFor(SIDE_CYCLE, sideFace, target);
        const moves = [turnToken('U', k), target + '2'].filter(Boolean);
        emit('cross', 'Look at the petal with the ' + CN(sideColor) + ' sticker on its side. Turn ONLY the top layer until that sticker is right above the ' + cname(sideColor) + ' centre. Then turn that side twice. The white sticker goes down to the bottom.', moves, p.idx);
      }
      if (!G.cross(cur)) throw SolverBug('Cross stage failed');
    }

    // ---- stage 3: white corners
    if (!resumeTwist) {
      let guard = 0;
      while (!G.corners(cur) && guard++ < 20) {
        const topName = U_CORNER_CYCLE.find((n) => Cube.pieceColors(cur, Cube.pieceAt(n)).includes(white()));
        if (topName) {
          const cols = Cube.pieceColors(cur, Cube.pieceAt(topName)).filter((c) => c !== white());
          // Name the piece on whichever step comes first, so it is never left unsaid.
          let intro = 'The white corner with ' + CN(cols[0]) + ' and ' + CN(cols[1]) + ' belongs between the ' + cname(cols[0]) + ' and ' + cname(cols[1]) + ' centres. ' + whereIs(Cube.pieceAt(topName)) + ' ';
          const take = () => { const t = intro; intro = ''; return t; };
          const yTok = yTokenForFR(faceOfCenter(cols[0]), faceOfCenter(cols[1]));
          if (yTok) {
            emit('corners', take() + 'Turn the WHOLE cube so that home spot is at the front-right (nearest you, on your right).' + facesYou(yTok), yTok, Cube.pieceAt(topName).idx);
          }
          const piece = Cube.findPiece(cur, [white(), cols[0], cols[1]]);
          const uTok = turnToken('U', uTurnsFor(U_CORNER_CYCLE, nameOf(piece), 'UFR'));
          if (uTok) emit('corners', take() + 'Turn ONLY the top layer, so that corner sits right above its home, at the front-right on top.', uTok, piece.idx);
          let reps = 0;
          let probe = cur;
          while (!pieceSolved(probe, 'DFR') && reps < 6) { probe = Cube.applyAlg(probe, ALGS.righty); reps++; }
          if (!pieceSolved(probe, 'DFR')) throw SolverBug('Corner insertion failed');
          const plan = repeatOrBackwards(reps, ALGS.righty, ALGS.rightyBack);
          const moves = [];
          for (let k = 0; k < plan.count; k++) moves.push(...Cube.parseAlg(plan.alg));
          const times = plan.count === 1 ? 'once' : plan.count + ' times';
          const text = plan.backwards
            ? take() + 'This corner would take five Righties. Do Righty BACKWARDS instead (U R U\' R\'), just ' + times + '. Then peek at the bottom: the corner is home, white facing down.'
            : take() + 'Do Righty (R U R\' U\') ' + times + '. Then peek at the bottom: the corner is home, white facing down. Put white back on the bottom.';
          emit('corners', text, moves, Cube.pieceAt('DFR').idx.concat(Cube.pieceAt('UFR').idx));
        } else {
          const bad = D_CORNERS.find((n) => !pieceSolved(cur, n));
          const p = Cube.pieceAt(bad);
          const sides = p.faces.filter((f) => f !== 'D');
          const yTok = yTokenForFR(sides[0], sides[1]);
          if (yTok) emit('corners', 'A white corner is in the bottom layer, but in the wrong spot or twisted. ' + whereIs(p) + ' Turn the WHOLE cube so it is at the front-right.' + facesYou(yTok), yTok, p.idx);
          emit('corners', 'Pop that corner out of the bottom with one Righty. Then we will put it back the right way.', ALGS.righty, Cube.pieceAt('DFR').idx);
        }
      }
      if (!G.corners(cur)) throw SolverBug('Corners stage failed');
    }

    // ---- stage 4: middle layer
    if (!resumeTwist) {
      let guard = 0;
      while (!G.middle(cur) && guard++ < 20) {
        const topName = U_EDGE_CYCLE.find((n) => {
          const cols = Cube.pieceColors(cur, Cube.pieceAt(n));
          return !cols.includes(white()) && !cols.includes(yellow());
        });
        if (topName) {
          const p = Cube.pieceAt(topName);
          const sideFace = p.faces.find((f) => f !== 'U');
          const sideColor = cur[Cube.sticker(topName, sideFace)];
          const topColor = cur[Cube.sticker(topName, 'U')];
          let intro = 'Find an edge on top with NO yellow: the ' + CN(sideColor) + ' and ' + CN(topColor) + ' edge. ' + whereIs(p) + ' ';
          const take = () => { const t = intro; intro = ''; return t; };
          const yTok = turnToken('y', yTurnsToFront(faceOfCenter(sideColor)));
          if (yTok) emit('middle', take() + 'Turn the WHOLE cube so the ' + cname(sideColor) + ' centre faces you.', yTok, p.idx);
          const piece = Cube.findPiece(cur, [sideColor, topColor]);
          const uTok = turnToken('U', uTurnsFor(U_EDGE_CYCLE, nameOf(piece), 'UF'));
          if (uTok) emit('middle', take() + 'Turn ONLY the top layer, until the ' + cname(sideColor) + ' sticker of that edge sits right above the ' + cname(sideColor) + ' centre. It makes an upside-down T.', uTok, piece.idx);
          // by now the edge has been turned to UF, so highlight where it actually is
          const atUF = Cube.pieceAt('UF').idx;
          if (topColor === C('R')) {
            emit('middle', take() + 'The top sticker is ' + CN(topColor) + ' and the ' + cname(topColor) + ' centre is on the RIGHT. Do the SLIDE-RIGHT TRICK to slide the edge into its place on the right.', ALGS.middleRight, atUF);
          } else if (topColor === C('L')) {
            emit('middle', take() + 'The top sticker is ' + CN(topColor) + ' and the ' + cname(topColor) + ' centre is on the LEFT. Do the SLIDE-LEFT TRICK to slide the edge into its place on the left.', ALGS.middleLeft, atUF);
          } else {
            throw SolverBug('Middle edge colour mismatch');
          }
        } else {
          const bad = E_EDGES.find((n) => !pieceSolved(cur, n));
          const p = Cube.pieceAt(bad);
          const yTok = yTokenForFR(p.faces[0], p.faces[1]);
          if (yTok) emit('middle', 'Every edge on top has yellow, but a middle edge is in the wrong place. Turn the WHOLE cube so that place is at the front-right.' + facesYou(yTok), yTok, p.idx);
          emit('middle', 'Do the SLIDE-RIGHT TRICK once. It pops the wrong edge up to the top. Then we will put the correct edge in.', ALGS.middleRight, Cube.pieceAt('FR').idx);
        }
      }
      if (!G.middle(cur)) throw SolverBug('Middle stage failed');
    }

    // ---- stage 5: yellow cross
    // The shape decides the top-layer turn, exactly as the lesson teaches it: hold an
    // L at back-left and a line left-to-right. Searching for any turn that "works"
    // would print those words and then do something else, which is worse than useless
    // to a child holding a real cube. Verified: L at back-left -> line left-to-right
    // -> cross, and the dot lands on the back-left L by itself.
    if (!resumeTwist) {
      let guard = 0;
      while (!G.ycross(cur) && guard++ < 5) {
        const up = U_EDGE_CYCLE.filter((e) => yellowUp(cur, e));
        const isLine = up.length === 2 && up.includes('UF') === up.includes('UB');
        let k = 0;
        let text;
        if (up.length === 0) {
          text = 'No yellow edges on top yet, just the yellow centre. That shape is called the DOT. Do the CROSS TRICK and you will get an L shape.';
        } else if (isLine) {
          k = aufForShape(cur, 'UL,UR');
          text = 'Two yellow edges make a LINE. Turn ONLY the top layer so the line goes from left to right. Then do the CROSS TRICK.';
        } else {
          k = aufForShape(cur, 'UB,UL');
          text = 'Two yellow edges make an L shape. Turn ONLY the top layer so one yellow edge is at the BACK and one is on the LEFT. Then do the CROSS TRICK.';
        }
        if (k === null) throw SolverBug('Yellow cross shape not recognised');
        emit('ycross', text, [turnToken('U', k)].filter(Boolean).concat(Cube.parseAlg(ALGS.yellowCross)), uStickers(U_EDGE_CYCLE));
      }
      if (!G.ycross(cur)) throw SolverBug('Yellow cross failed');
    }

    // ---- stage 6: yellow edges
    // Turning the top chooses how many edges match; it cannot move a matched pair,
    // because the centres stay put. Turning the WHOLE cube moves the pieces and the
    // centres together, so that is how the matching pair is brought to the back and
    // the right. Verified over 500 states: the best top turn always leaves exactly 2
    // or 4 matching, an adjacent pair held at back-right is finished by one trick,
    // and an opposite pair becomes an adjacent one after a single trick.
    if (!resumeTwist) {
      const matchesOf = (s) => U_EDGE_CYCLE.filter((e) => pieceSolved(s, e));
      const bestAuf = (s) => {
        let bk = 0;
        let bc = -1;
        for (let k = 0; k < 4; k++) {
          const n = matchesOf(withU(s, k)).length;
          if (n > bc) { bc = n; bk = k; }
        }
        return { k: bk, count: bc };
      };
      let guard = 0;
      while (!G.yedges(cur) && guard++ < 6) {
        const auf = bestAuf(cur);
        if (auf.count === 4) {
          emit('yedges', 'Turn ONLY the top layer until every yellow edge matches the centre under it.', turnToken('U', auf.k), uStickers(U_EDGE_CYCLE));
          break;
        }
        const uTok = turnToken('U', auf.k);
        if (uTok) {
          emit('yedges', 'Turn ONLY the top layer until two yellow edges match the centres under them. Two is the most you can get.', uTok, uStickers(U_EDGE_CYCLE));
        }
        const matched = matchesOf(cur);
        const opposite = matched.length === 2 && matched.includes('UF') === matched.includes('UB');
        if (!opposite && matched.length === 2) {
          let k = 0;
          while (k < 4 && !(pieceSolved(withY(cur, k), 'UB') && pieceSolved(withY(cur, k), 'UR'))) k++;
          if (k === 4) throw SolverBug('Yellow edge pair could not be held at the back and right');
          const yTok = turnToken('y', k);
          if (yTok) {
            emit('yedges', 'The ' + joinWords(matched.map((e) => POSITION_WORD[e].toUpperCase())) + ' edges match their centres. Turn the WHOLE cube so those two are at the BACK and the RIGHT.' + facesYou(yTok), yTok, uStickers(U_EDGE_CYCLE));
          }
          emit('yedges', 'Now do the EDGE TRICK. It swaps the front and left edges and leaves the back and right ones alone, so all four end up right.', ALGS.yellowEdges, uStickers(U_EDGE_CYCLE));
        } else {
          emit('yedges', 'The two matching edges are opposite each other, so the trick cannot finish in one go. Do the EDGE TRICK once and they will end up next to each other.', ALGS.yellowEdges, uStickers(U_EDGE_CYCLE));
        }
      }
      if (!G.yedges(cur)) throw SolverBug('Yellow edges failed');
    }

    // ---- stage 7: yellow corners in place
    if (!resumeTwist) {
      const fixedSides = Cube.pieceAt(FIXED_CORNER).faces.filter((f) => f !== 'U').sort().join('');
      if (opts.cornersOnly && uCornerParity(cur) === 1) {
        let bestK = -1, bestPlaced = -1;
        for (let k = 0; k < 4; k++) {
          const u = withU(cur, k);
          if (uCornerParity(u) !== 0) continue;
          const n = U_CORNER_CYCLE.filter((c) => cornerPositioned(u, c)).length;
          if (n > bestPlaced) { bestPlaced = n; bestK = k; }
        }
        if (bestK > 0) emit('ycorners', 'Turn ONLY the top layer, so that as many yellow corners as possible are home.', turnToken('U', bestK), uStickers(U_CORNER_CYCLE));
      }
      let guard = 0;
      while (!G.ycorners(cur) && guard++ < 4) {
        const placed = U_CORNER_CYCLE.find((c) => cornerPositioned(cur, c));
        if (placed) {
          const p = Cube.pieceAt(placed);
          const sides = p.faces.filter((f) => f !== 'U');
          let k = 0;
          while (k < 4 && sides.map((f) => faceAfterY(f, k)).sort().join('') !== fixedSides) k++;
          const yTok = turnToken('y', k);
          if (yTok) emit('ycorners', 'One yellow corner is already home: its three colours match the centres round it, even if it is twisted. Turn the WHOLE cube so that corner is at the front-right.' + facesYou(yTok), yTok, p.idx);
          emit('ycorners', 'Do the CORNER TRICK once. The front-right corner stays. The other three move round.', ALGS.yellowCorners, uStickers(U_CORNER_CYCLE));
        } else {
          emit('ycorners', 'No yellow corner is home yet. Do the CORNER TRICK once, and one corner will land in its home.', ALGS.yellowCorners, uStickers(U_CORNER_CYCLE));
        }
      }
      if (!G.ycorners(cur)) throw SolverBug('Yellow corner placement failed');
    }

    // ---- stage 8: twist yellow corners
    {
      const needsTwist = () => U_CORNER_CYCLE.some((c) => !yellowUp(cur, c));
      let guard = 0;
      let first = true;
      while (needsTwist() && guard++ < 8) {
        const bad = !yellowUp(cur, 'UFR') ? 'UFR' : U_CORNER_CYCLE.find((c) => !yellowUp(cur, c));
        const uTok = turnToken('U', uTurnsFor(U_CORNER_CYCLE, bad, 'UFR'));
        if (uTok) emit('ytwist', 'Turn ONLY the top layer (not the whole cube!) so a corner without yellow on top is at the front-right.', uTok, Cube.pieceAt(bad).idx);
        let reps = 0;
        let s = cur;
        while (!yellowUp(s, 'UFR') && reps < 6) { s = Cube.applyAlg(s, ALGS.twist); reps++; }
        const plan = repeatOrBackwards(reps, ALGS.twist, ALGS.twistBack);
        const moves = [];
        for (let k = 0; k < plan.count; k++) moves.push(...Cube.parseAlg(plan.alg));
        const times = plan.count === 1 ? 'once' : plan.count + ' times';
        const messy = first ? ' The bottom will look messy. That is normal. It all comes back at the end!' : '';
        const text = plan.backwards
          ? 'This corner would take four twists. Do the TWIST TRICK BACKWARDS instead (D\' R\' D R), ' + times + '. Then the yellow sticker of the front-right corner faces up.' + messy
          : 'Do the TWIST TRICK (R\' D\' R D) ' + times + '. Then the yellow sticker of the front-right corner faces up.' + messy;
        emit('ytwist', text, moves, Cube.pieceAt('UFR').idx);
        first = false;
      }
      if (!G.middle(cur)) {
        // Only reachable when a learner twisted a corner by hand: finish the cycle.
        const j = midTwistPhase(cur, G);
        if (!j) throw SolverBug('Corner twist failed');
        const plan = repeatOrBackwards(j, ALGS.twist, ALGS.twistBack);
        const moves = [];
        for (let r = 0; r < plan.count; r++) moves.push(...Cube.parseAlg(plan.alg));
        emit('ytwist', 'The bottom is still messy. Do the TWIST TRICK' + (plan.backwards ? ' BACKWARDS' : '') + ' ' + (plan.count === 1 ? 'once' : plan.count + ' more times') + ' to fix it.', moves, []);
      }
      if (!G.ytwist(cur)) throw SolverBug('Corner twist failed');
    }

    // ---- stage 9: finish
    if (!G.finish(cur)) {
      const k = [1, 2, 3].find((k) => G.finish(withU(cur, k)));
      if (k !== undefined) emit('finish', 'Turn ONLY the top layer to line everything up. You did it!', turnToken('U', k), []);
    }
    if (!G.finish(cur)) throw SolverBug('Solver did not reach a solved cube');
    return { steps, state: cur };
  }

  // State a learner sees at the start of `stage`: scramble, then solve every earlier stage.
  // ------------------------------------------------------------- 2x2 cubes
  // A 2x2 sticker (face f, row r, column c in 0..1) is the 3x3 corner sticker at
  // row 2r, column 2c of the same face. Put the 2x2's stickers on those spots of a
  // solved 3x3, and the 3x3 solver's corner stages solve it with the same tricks.
  const TWO_TO_THREE = [];
  const THREE_TO_TWO = new Map();
  for (let f = 0; f < 6; f++) for (let r = 0; r < 2; r++) for (let c = 0; c < 2; c++) {
    const i3 = f * 9 + 2 * r * 3 + 2 * c;
    TWO_TO_THREE.push(i3);
    THREE_TO_TWO.set(i3, TWO_TO_THREE.length - 1);
  }

  // A 2x2 has no centres, so all 24 ways of holding a solved one are solved.
  function isSolved2x2(s) {
    for (let f = 0; f < 6; f++) {
      const c = s[f * 4];
      for (let k = 1; k < 4; k++) if (s[f * 4 + k] !== c) return false;
    }
    return true;
  }

  // The 24 ways to hold a 2x2, as permutations of its 24 stickers. Turning the whole
  // cube is only a relabelling on a 2x2, so the solver may pick whichever way of
  // holding it needs the least work, and tell the child to turn the cube once.
  const ROTATIONS_2 = (function () {
    const out = [];
    for (const tilt of ['', 'x', "x'", 'x2', 'z', "z'"]) {
      for (const spin of ['', 'y', 'y2', "y'"]) {
        const alg = (tilt + ' ' + spin).trim();
        const labels = Cube.solved().map((_, i) => i);
        const moved = alg ? Cube.applyAlg(labels, alg) : labels;   // moved[dest] = source
        out.push({ alg, perm: TWO_TO_THREE.map((i3) => THREE_TO_TWO.get(moved[i3])) });
      }
    }
    return out;
  })();

  function validate2x2(state2) {
    if (!state2 || state2.length !== 24) return { ok: false, reason: 'A 2\u00d72 has exactly 24 stickers.' };
    const counts = {};
    for (const c of state2) counts[c] = (counts[c] || 0) + 1;
    for (const c of Object.keys(Cube.COLOR_NAMES)) {
      if ((counts[c] || 0) !== 4) return { ok: false, reason: 'There should be 4 ' + Cube.COLOR_NAMES[c] + ' stickers, but I count ' + (counts[c] || 0) + '.' };
    }
    const ref = Cube.solved();
    const s3 = ref.slice();
    for (let i2 = 0; i2 < 24; i2++) s3[TWO_TO_THREE[i2]] = state2[i2];
    const used = new Set();
    let twist = 0;
    for (const corner of Cube.CORNERS) {
      const cols3 = Cube.cornerClockwise(corner).map((k) => s3[k]);
      let home = null, rot = -1;
      for (let i = 0; i < Cube.CORNERS.length && home === null; i++) {
        const refCols = Cube.cornerClockwise(Cube.CORNERS[i]).map((k) => ref[k]);
        const r = refCols.indexOf(cols3[0]);
        if (r >= 0 && cols3.every((x, j) => x === refCols[(r + j) % 3])) { home = i; rot = r; }
      }
      if (home === null) return { ok: false, reason: 'There is no ' + cols3.map((x) => Cube.COLOR_NAMES[x]).join('-') + ' corner on a real cube. Check that corner\'s three stickers.' };
      if (used.has(home)) return { ok: false, reason: 'The ' + cols3.map((x) => Cube.COLOR_NAMES[x]).join('-') + ' corner appears twice.' };
      used.add(home);
      twist += rot;
    }
    if (twist % 3 !== 0) return { ok: false, reason: 'One corner looks twisted. Double-check its stickers.' };
    return { ok: true, embedded: s3 };
  }

  function solve2x2(input) {
    const state2 = Array.prototype.slice.call(input);
    const v = validate2x2(state2);
    if (!v.ok) throw new Error(v.reason);
    // Already done, however the child happens to be holding it.
    if (isSolved2x2(state2)) return { steps: [], state: state2 };

    // Pick the way of holding it that starts with the most corners already home.
    const homeCount = (s3) => Cube.CORNERS.filter((c) => c.idx.every((i, k) => s3[i] === Cube.center(s3, c.faces[k]))).length;
    let best = { alg: '', state2, embedded: v.embedded, home: homeCount(v.embedded) };
    for (const r of ROTATIONS_2) {
      if (!r.alg) continue;
      const turned = r.perm.map((src) => state2[src]);
      const s3 = Cube.solved();
      for (let i2 = 0; i2 < 24; i2++) s3[TWO_TO_THREE[i2]] = turned[i2];
      const home = homeCount(s3);
      if (home > best.home) best = { alg: r.alg, state2: turned, embedded: s3, home };
    }

    const res = solve(best.embedded, { cornersOnly: true });
    const steps = res.steps.map((st) => ({
      stage: st.stage,
      // a 2x2 has no centres; its "sides" are wherever the corners say they are
      text: st.text.replace(/centres/g, 'sides').replace(/centre/g, 'side'),
      moves: st.moves,
      highlight: st.highlight.map((i) => THREE_TO_TWO.get(i)).filter((i) => i !== undefined),
    }));
    if (best.alg) {
      steps.unshift({
        stage: 'orient',
        text: 'First, turn the WHOLE cube to hold it the easy way. A 2\u00d72 has no middle squares, so any way up is fine.',
        moves: Cube.parseAlg(best.alg),
        highlight: [],
      });
    }
    const state = new Array(24);
    for (let i2 = 0; i2 < 24; i2++) state[i2] = res.state[TWO_TO_THREE[i2]];
    return { steps, state };
  }

  // The cube as a learner meets it at the start of `stage`: scramble, then replay the
  // steps of every earlier stage. `needsStage` is false when the solve contains no
  // step for this stage at all, i.e. the scramble happened to arrive with it done.
  function buildStage(stage, scrambleMoves) {
    const scrambled = Cube.applyAlg(Cube.solved(), scrambleMoves || Cube.scramble(25));
    const idx = STAGES.indexOf(stage);
    const { steps } = solve(scrambled);
    let s = scrambled;
    let needsStage = false;
    for (const st of steps) {
      const k = STAGES.indexOf(st.stage);
      if (k >= idx) { needsStage = k === idx; break; }
      s = Cube.applyAlg(s, st.moves);
    }
    return { state: s, needsStage };
  }

  // A practice cube for `stage`. Some scrambles land on a state where the stage is
  // already done (about 1 in 9 for the yellow cross), which would hand a learner a
  // win they did not earn, so re-roll until the stage has real work in it. With an
  // explicit scramble the extra rolls are derived from it, so tests stay repeatable.
  function stateForStage(stage, scrambleMoves) {
    let out = buildStage(stage, scrambleMoves);
    let extra = scrambleMoves ? Cube.parseAlg(scrambleMoves) : null;
    for (let i = 0; i < 25 && !out.needsStage; i++) {
      if (extra) {
        extra = extra.concat(FACE_MOVES[(i * 7 + 3) % FACE_MOVES.length]);
        out = buildStage(stage, extra);
      } else {
        out = buildStage(stage);
      }
    }
    return out.state;
  }

  return { ALGS, STAGES, goals, cornerGoals, solve, solve2x2, validate2x2, isSolved2x2, search, planAlg, stateForStage, midTwistPhase, fixedCorner: FIXED_CORNER };
});
