/*
 * solver.js - Beginner "layer by layer" solver for Cube Buddy.
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
    lefty: "L' U' L U",
    middleRight: "U R U' R' U' F' U F",
    middleLeft: "U' L' U L U F U' F'",
    yellowCross: "F R U R' U' F'",
    yellowEdges: "R U R' U R U2 R' U",
    yellowCorners: "U R U' L' U R' U' L",
    twist: "R' D' R D",
  };

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
  function midTwistPhase(s) {
    if (goals.middle(s)) return 0;
    let t = s;
    for (let j = 1; j <= 5; j++) {
      t = Cube.applyAlg(t, ALGS.twist);
      if (goals.middle(t)) {
        // the restored cube must also have its top layer ready for twisting
        const ready = [0, 1, 2, 3].some((k) => {
          const u = withU(t, k);
          return U_EDGE_CYCLE.every((e) => pieceSolved(u, e)) && U_CORNER_CYCLE.every((c) => cornerPositioned(u, c));
        });
        return ready ? j : 0;
      }
    }
    return 0;
  }

  // -------------------------------------------------------------- solver
  function solve(start) {
    const v = Cube.validate(start);
    if (!v.ok) throw new Error(v.reason);

    let cur = start.slice();
    const steps = [];
    if (Cube.isSolved(cur)) return { steps, state: cur };

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
    const uStickers = (list) => list.map((n) => Cube.sticker(n, 'U'));

    // ---- stage 0: hold the cube with white on the bottom
    {
      const f = faceOfCenter('W');
      const rotation = { D: '', U: 'x2', F: "x'", B: 'x', R: 'z', L: "z'" }[f];
      if (rotation) {
        emit('orient', 'First, hold the cube so the WHITE centre is on the bottom. The yellow centre will be on top.', rotation, [Cube.centerIndex(f)]);
      }
    }

    const resumeTwist = midTwistPhase(cur) > 0;

    // ---- stage 1: daisy
    if (!resumeTwist) {
      let guard = 0;
      while (!goals.daisy(cur) && guard++ < 8) {
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
        emit('daisy', 'Find the edge piece with WHITE and ' + CN(best.sc) + '. Bring it up to the top so its white sticker faces up, like a daisy petal.', best.path, best.piece.idx);
      }
      if (!goals.daisy(cur)) throw SolverBug('Daisy stage failed');
    }

    // ---- stage 2: white cross
    if (!resumeTwist) {
      let guard = 0;
      while (!goals.cross(cur) && guard++ < 6) {
        const pos = U_EDGE_CYCLE.find((e) => petal(cur, e));
        if (!pos) throw SolverBug('Cross: no petal left');
        const p = Cube.pieceAt(pos);
        const sideFace = p.faces.find((f) => f !== 'U');
        const sideColor = cur[Cube.sticker(pos, sideFace)];
        const target = faceOfCenter(sideColor);
        const k = uTurnsFor(SIDE_CYCLE, sideFace, target);
        const moves = [turnToken('U', k), target + '2'].filter(Boolean);
        emit('cross', 'Look at the petal with the ' + CN(sideColor) + ' sticker on its side. Turn the top until that sticker is right above the ' + cname(sideColor) + ' centre. Then turn that side twice to send the white sticker to the bottom.', moves, p.idx);
      }
      if (!goals.cross(cur)) throw SolverBug('Cross stage failed');
    }

    // ---- stage 3: white corners
    if (!resumeTwist) {
      let guard = 0;
      while (!goals.corners(cur) && guard++ < 20) {
        const topName = U_CORNER_CYCLE.find((n) => Cube.pieceColors(cur, Cube.pieceAt(n)).includes(white()));
        if (topName) {
          const cols = Cube.pieceColors(cur, Cube.pieceAt(topName)).filter((c) => c !== white());
          const yTok = yTokenForFR(faceOfCenter(cols[0]), faceOfCenter(cols[1]));
          if (yTok) {
            emit('corners', 'The white corner with ' + CN(cols[0]) + ' and ' + CN(cols[1]) + ' belongs between the ' + cname(cols[0]) + ' and ' + cname(cols[1]) + ' centres. Turn the whole cube so that home spot is at the front-right.', yTok, Cube.pieceAt(topName).idx);
          }
          const piece = Cube.findPiece(cur, [white(), cols[0], cols[1]]);
          const uTok = turnToken('U', uTurnsFor(U_CORNER_CYCLE, nameOf(piece), 'UFR'));
          if (uTok) emit('corners', 'Turn the top layer so the white corner sits right above its home (front-right, on top).', uTok, piece.idx);
          let reps = 0;
          while (!pieceSolved(cur, 'DFR') && reps < 6) {
            emit('corners', reps === 0
              ? 'Do Righty (R U R\' U\'). Then look at the front-right corner. Is white on the bottom? Do the side colours match the centres? If not, do Righty again.'
              : 'Not there yet? Do Righty once more and check again.', ALGS.righty, Cube.pieceAt('DFR').idx.concat(Cube.pieceAt('UFR').idx));
            reps++;
          }
          if (!pieceSolved(cur, 'DFR')) throw SolverBug('Corner insertion failed');
        } else {
          const bad = D_CORNERS.find((n) => !pieceSolved(cur, n));
          const p = Cube.pieceAt(bad);
          const sides = p.faces.filter((f) => f !== 'D');
          const yTok = yTokenForFR(sides[0], sides[1]);
          if (yTok) emit('corners', 'A white corner is in the bottom layer but in the wrong spot or twisted. Turn the whole cube so it is at the front-right.', yTok, p.idx);
          emit('corners', 'Pop that corner out of the bottom with one Righty. Then we will put it back the right way.', ALGS.righty, Cube.pieceAt('DFR').idx);
        }
      }
      if (!goals.corners(cur)) throw SolverBug('Corners stage failed');
    }

    // ---- stage 4: middle layer
    if (!resumeTwist) {
      let guard = 0;
      while (!goals.middle(cur) && guard++ < 20) {
        const topName = U_EDGE_CYCLE.find((n) => {
          const cols = Cube.pieceColors(cur, Cube.pieceAt(n));
          return !cols.includes(white()) && !cols.includes(yellow());
        });
        if (topName) {
          const p = Cube.pieceAt(topName);
          const sideFace = p.faces.find((f) => f !== 'U');
          const sideColor = cur[Cube.sticker(topName, sideFace)];
          const topColor = cur[Cube.sticker(topName, 'U')];
          const yTok = turnToken('y', yTurnsToFront(faceOfCenter(sideColor)));
          if (yTok) emit('middle', 'Find an edge on top with NO yellow: the ' + CN(sideColor) + ' and ' + CN(topColor) + ' edge. Turn the whole cube so the ' + cname(sideColor) + ' centre faces you.', yTok, p.idx);
          const piece = Cube.findPiece(cur, [sideColor, topColor]);
          const uTok = turnToken('U', uTurnsFor(U_EDGE_CYCLE, nameOf(piece), 'UF'));
          if (uTok) emit('middle', 'Turn the top layer until the ' + cname(sideColor) + ' sticker of that edge sits right above the ' + cname(sideColor) + ' centre. It makes an upside-down T.', uTok, piece.idx);
          if (topColor === C('R')) {
            emit('middle', 'The top sticker is ' + CN(topColor) + ' and the ' + cname(topColor) + ' centre is on the RIGHT. Do the RIGHT TRICK to slide the edge into its slot on the right.', ALGS.middleRight, piece.idx);
          } else if (topColor === C('L')) {
            emit('middle', 'The top sticker is ' + CN(topColor) + ' and the ' + cname(topColor) + ' centre is on the LEFT. Do the LEFT TRICK to slide the edge into its slot on the left.', ALGS.middleLeft, piece.idx);
          } else {
            throw SolverBug('Middle edge colour mismatch');
          }
        } else {
          const bad = E_EDGES.find((n) => !pieceSolved(cur, n));
          const p = Cube.pieceAt(bad);
          const yTok = yTokenForFR(p.faces[0], p.faces[1]);
          if (yTok) emit('middle', 'Every edge on top has yellow, but a middle edge is in the wrong slot. Turn the whole cube so that slot is at the front-right.', yTok, p.idx);
          emit('middle', 'Do the RIGHT TRICK once to pop the wrong edge up to the top. Then we will put the correct edge in.', ALGS.middleRight, Cube.pieceAt('FR').idx);
        }
      }
      if (!goals.middle(cur)) throw SolverBug('Middle stage failed');
    }

    // ---- stage 5: yellow cross
    if (!resumeTwist) {
      let guard = 0;
      while (!goals.ycross(cur) && guard++ < 4) {
        const plan = planAlg(cur, ALGS.yellowCross, (s) => countYellowEdges(s) === 4, 3);
        if (!plan) throw SolverBug('Yellow cross plan failed');
        const up = U_EDGE_CYCLE.filter((e) => yellowUp(cur, e));
        let text;
        if (up.length === 0) text = 'No yellow edges on top yet, just the yellow centre. That shape is called the DOT. Do the CROSS TRICK and you will get an L shape.';
        else if (up.length === 2 && up.includes('UF') === up.includes('UB')) text = 'Two yellow edges make a LINE. Turn the top so the line goes from left to right, then do the CROSS TRICK.';
        else text = 'Two yellow edges make an L shape. Turn the top so the L points to the back and to the left (like 9 o\'clock and 12 o\'clock), then do the CROSS TRICK.';
        emit('ycross', text, [turnToken('U', plan[0])].filter(Boolean).concat(Cube.parseAlg(ALGS.yellowCross)), uStickers(U_EDGE_CYCLE));
      }
      if (!goals.ycross(cur)) throw SolverBug('Yellow cross failed');
    }

    // ---- stage 6: yellow edges
    if (!resumeTwist) {
      const solvableByTopTurn = (s) => [0, 1, 2, 3].some((k) => U_EDGE_CYCLE.every((e) => pieceSolved(withU(s, k), e)));
      let guard = 0;
      while (!goals.yedges(cur) && guard++ < 5) {
        const auf = [0, 1, 2, 3].find((k) => U_EDGE_CYCLE.every((e) => pieceSolved(withU(cur, k), e)));
        if (auf !== undefined) {
          emit('yedges', 'Turn the top layer until every yellow edge matches the centre below it.', turnToken('U', auf), uStickers(U_EDGE_CYCLE));
          break;
        }
        const plan = planAlg(cur, ALGS.yellowEdges, solvableByTopTurn, 3);
        if (!plan) throw SolverBug('Yellow edge plan failed');
        const afterTurn = withU(cur, plan[0]);
        const matched = U_EDGE_CYCLE.filter((e) => pieceSolved(afterTurn, e));
        let text;
        if (matched.length === 0) text = 'No edge can match a centre right now. Do the EDGE TRICK once; it swaps the front and left edges. Then some will match.';
        else text = 'Turn the top so the ' + joinWords(matched.map((e) => POSITION_WORD[e].toUpperCase())) + ' edge' + (matched.length > 1 ? 's match their centres' : ' matches its centre') + '. Then do the EDGE TRICK: it swaps the front and left edges.';
        emit('yedges', text, [turnToken('U', plan[0])].filter(Boolean).concat(Cube.parseAlg(ALGS.yellowEdges)), uStickers(U_EDGE_CYCLE));
      }
      if (!goals.yedges(cur)) throw SolverBug('Yellow edges failed');
    }

    // ---- stage 7: yellow corners in place
    if (!resumeTwist) {
      const fixedSides = Cube.pieceAt(FIXED_CORNER).faces.filter((f) => f !== 'U').sort().join('');
      let guard = 0;
      while (!goals.ycorners(cur) && guard++ < 4) {
        const placed = U_CORNER_CYCLE.find((c) => cornerPositioned(cur, c));
        if (placed) {
          const p = Cube.pieceAt(placed);
          const sides = p.faces.filter((f) => f !== 'U');
          let k = 0;
          while (k < 4 && sides.map((f) => faceAfterY(f, k)).sort().join('') !== fixedSides) k++;
          const yTok = turnToken('y', k);
          if (yTok) emit('ycorners', 'One yellow corner is already in its right spot: its three colours match the centres around it, even if it is twisted. Turn the whole cube so that corner is at the front-right.', yTok, p.idx);
          emit('ycorners', 'Do the CORNER TRICK. The front-right corner stays, the other three move around. Then check: are all four corners in their correct spots? If not, do it once more.', ALGS.yellowCorners, uStickers(U_CORNER_CYCLE));
        } else {
          emit('ycorners', 'No yellow corner is in its right spot yet. Do the CORNER TRICK once, and one corner will land in its correct spot.', ALGS.yellowCorners, uStickers(U_CORNER_CYCLE));
        }
      }
      if (!goals.ycorners(cur)) throw SolverBug('Yellow corner placement failed');
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
        const moves = [];
        let s = cur;
        while (!yellowUp(s, 'UFR') && reps < 6) {
          s = Cube.applyAlg(s, ALGS.twist);
          moves.push(...Cube.parseAlg(ALGS.twist));
          reps++;
        }
        const text = (first
          ? 'Do the TWIST TRICK (R\' D\' R D) until the yellow sticker of the front-right corner faces up. That takes 2 or 4 times. The bottom layers will look messy. That is normal, they fix themselves at the end! '
          : 'Do the TWIST TRICK again until this corner has yellow on top. ') + 'This time you need it ' + reps + (reps === 1 ? ' time.' : ' times.');
        emit('ytwist', text, moves, Cube.pieceAt('UFR').idx);
        first = false;
      }
      if (!goals.middle(cur)) {
        // Only reachable when a learner twisted a corner by hand: finish the cycle.
        const j = midTwistPhase(cur);
        if (!j) throw SolverBug('Corner twist failed');
        const moves = [];
        for (let r = 0; r < j; r++) moves.push(...Cube.parseAlg(ALGS.twist));
        emit('ytwist', 'The bottom is still messy. Do the TWIST TRICK ' + j + ' more time' + (j > 1 ? 's' : '') + ' to fix it.', moves, []);
      }
      if (!goals.ytwist(cur)) throw SolverBug('Corner twist failed');
    }

    // ---- stage 9: finish
    if (!Cube.isSolved(cur)) {
      const k = [1, 2, 3].find((k) => Cube.isSolved(withU(cur, k)));
      if (k !== undefined) emit('finish', 'Turn the top layer to line everything up. Then you have solved the cube!', turnToken('U', k), []);
    }
    if (!Cube.isSolved(cur)) throw new Error('Solver did not reach a solved cube');
    return { steps, state: cur };
  }

  // State a learner sees at the start of `stage`: scramble, then solve every earlier stage.
  function buildStage(stage, scrambleMoves) {
    const scrambled = Cube.applyAlg(Cube.solved(), scrambleMoves || Cube.scramble(25));
    const idx = STAGES.indexOf(stage);
    const { steps } = solve(scrambled);
    let s = scrambled;
    for (const st of steps) {
      if (STAGES.indexOf(st.stage) >= idx) break;
      s = Cube.applyAlg(s, st.moves);
    }
    return s;
  }

  // A practice cube for `stage`. Some scrambles land on a state where the stage is
  // already done (about 1 in 9 for the yellow cross), which would hand a learner a win
  // they did not earn, so re-roll until the stage has real work in it. Passing an
  // explicit scramble keeps the result deterministic for tests.
  function stateForStage(stage, scrambleMoves) {
    let s = buildStage(stage, scrambleMoves);
    if (scrambleMoves) return s;
    for (let i = 0; i < 25 && goals[stage](s); i++) s = buildStage(stage);
    return s;
  }

  return { ALGS, STAGES, goals, solve, search, planAlg, stateForStage, midTwistPhase, fixedCorner: FIXED_CORNER };
});
