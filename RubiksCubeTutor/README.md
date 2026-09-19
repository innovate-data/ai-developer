# Cube Buddy – a Rubik's Cube tutor for kids

Cube Buddy teaches children (roughly ages 7–12) to solve a 3×3 Rubik's Cube using the
classic beginner "layer by layer" method. It is a single-page web app with **no build
step and no dependencies**: open `index.html` in any modern browser and it works,
including on a phone or tablet.

```
RubiksCubeTutor/
├── index.html          the app shell (three screens: Learn, Play, Solve my cube)
├── css/style.css       kid-friendly styling, 3D cube faces, net editor
├── js/cube.js          cube model: facelets, moves, pieces, validity check
├── js/solver.js        beginner-method solver that explains every step
├── js/view.js          3D cube (CSS transforms) and 2D net view
├── js/lessons.js       the course content (plain data, easy to edit or translate)
├── js/app.js           screens, move pad, guided walkthrough, practice, quiz
└── tests/run-tests.js  Node test-suite for the model and the solver
```

Run the tests with `node tests/run-tests.js` (Node 18+; no packages needed).

---

## 1. Goals and audience

| | |
|---|---|
| **Learner** | A child who has a real cube and wants to solve it, possibly with a parent alongside. |
| **Promise** | "Ten short lessons and you can solve any cube." |
| **Method** | The beginner layer-by-layer method used by most official guides: daisy → white cross → white corners → middle layer → yellow cross → yellow edges → yellow corners → twist corners. |
| **Not a goal** | Speed-cubing methods (CFOP, Roux) or optimal solutions. Move counts do not matter; understanding does. |

### Design principles for kids

1. **One idea per screen.** Each lesson introduces a single stage and at most two "tricks" (algorithms). Tricks get friendly names such as *Righty* (R U R' U') and are always shown as big coloured chips.
2. **See it, then do it.** Every trick has ▶ *Watch* (animated on the 3D cube) and ↩ *Undo*. Every hint has ▶ *Show me*.
3. **Practice on a cube that needs exactly this step.** The app scrambles a cube and solves it up to the current stage, so a child practising the yellow cross never has to redo the first two layers.
4. **Never stuck.** *Hint* gives one small step at a time, and warns gently when an earlier stage got broken so the child can *Undo* instead of panicking.
5. **Reassurance where the method looks scary.** The last stage temporarily scrambles two layers; the text says so up front and repeats "do not turn the whole cube".
6. **Rewards, not punishments.** Stars per lesson (3 without hints, 2 with hints) are stored locally; nothing resets, no timers in lessons, confetti when a Play solve finishes.
7. **Accessible.** Large targets, readable font, keyboard shortcuts, `aria-label`s on cube stickers and move buttons, and a 🔊 *Read* button using the browser's speech synthesis for early readers.
8. **Privacy by construction.** Everything runs in the browser; the only persisted data is the star progress in `localStorage`.

---

## 2. Learning path

| # | Lesson | What the child learns | Trick(s) |
|---|--------|-----------------------|----------|
| 1 | Meet Your Cube | Centres never move; edges have 2 colours; corners have 3. Light them up on the cube. | – |
| 2 | Cube Talk | Move notation R L U D F B, prime and 2. Try every move; quiz "name that move". | – |
| 3 | The Daisy | Bring four white edges around the yellow centre. Intuitive, no algorithm. | – |
| 4 | The White Cross | Match a petal's side colour to its centre, turn that side twice. | – |
| 5 | White Corners | Put a corner above its home and repeat Righty until it drops in. | Righty `R U R' U'` |
| 6 | The Middle Layer | Upside-down T, then the Right or Left trick. | Right trick `U R U' R' U' F' U F`, Left trick `U' L' U L U F U' F'` |
| 7 | The Yellow Cross | Dot → L → line → cross, with the L held at back-left. | Cross trick `F R U R' U' F'` |
| 8 | Yellow Edges Home | Match two edges at back and right; the trick swaps front and left. | Edge trick `R U R' U R U2 R' U` |
| 9 | Yellow Corners Home | Keep a correct corner at the front-right; the other three cycle. | Corner trick `U R U' L' U R' U' L` |
| 10 | The Grand Finale | Twist each corner with 2 or 4 repetitions; only the top layer turns between corners. | Twist trick `R' D' R D` |

Lessons 3–10 have a practice mode with a goal check, hints and a "new cube" button.

---

## 3. Screens

**Learn** – a grid of lesson cards with stars, then a two-column lesson page: sticky 3D
cube with a move pad on the left, text, tricks, interactive widgets, practice area and
tips on the right.

**Play** – free play with a scramble button, undo, a timer that starts on the first move
and a move counter. *Help me solve it* opens the guided walkthrough for the current
cube; making a manual move clears the (now stale) guide.

**Solve my cube** – a net editor: pick a colour, tap stickers to copy a real cube
(centres are fixed to yellow on top, green in front). *Check my cube* runs the validity
check and either explains what is wrong in plain words ("one corner looks twisted") or
starts the step-by-step guide. *Copy from Play* imports the Play cube.

The **guide** component shows a progress bar of stages, the step text, move chips with
plain-English tooltips, and buttons *Show me* (animate), *Next*, *Back*, *Read* and
*Do it all for me* (fast auto-play).

---

## 4. Architecture

### Cube model (`js/cube.js`)
* State = array of 54 sticker letters (W Y G B R O), faces in order U R F D L B, nine
  stickers per face, row-major as seen from outside.
* Every sticker knows its 3D position and normal. **Moves are generated geometrically**:
  rotate the positions and normals of the stickers in the affected layers and look up
  where they land. Face turns, prime/double turns, slice moves (M E S), wide moves and
  whole-cube rotations (x y z) all come from the same code, so they cannot disagree.
* Pieces (12 edges, 8 corners) are derived from the geometry, giving helpers such as
  `findPiece(state, ['W','R'])` and `sticker('UFR','U')`.
* `validate(state)` checks sticker counts, that every piece exists exactly once, edge
  flip parity, corner twist parity and permutation parity, and reports a child-readable
  reason. Rotated cubes are handled by matching the centres to one of the 24 solved
  orientations.

### Solver (`js/solver.js`)
* Follows the lesson method stage by stage. Each stage is a loop "while the goal is not
  met: find a piece, explain, apply moves" so the output is a list of
  `{stage, text, moves, highlight}` steps. Whole-cube `y` rotations are emitted as
  steps too, because that is how children actually hold the cube ("put it at the
  front-right").
* Daisy petals use a tiny iterative-deepening search (depth ≤ 5) so each petal is a
  short, explainable sequence. Yellow cross and yellow edge stages use a lookahead over
  "top-layer turn + trick" sequences (depth ≤ 3) so they always terminate and always
  match the rule taught in the lesson.
* Facts the text relies on (which corner the corner trick keeps, which edges the edge
  trick swaps, where the L must be held) are computed by simulation and asserted in
  tests, not remembered.
* `midTwistPhase()` recognises a cube whose bottom layers are scrambled only because the
  learner is halfway through the final twist stage, and resumes there instead of
  restarting from the daisy. This matters for hints.
* `stateForStage(stage)` produces a practice cube: scramble, solve, replay the steps of
  earlier stages.
* Average solution length is ~170 moves over 400 random scrambles (normal for the
  beginner method).

### 3D view (`js/view.js`)
* 27 cubie `<div>`s with six faces each, positioned with CSS 3D transforms. A layer turn
  transitions the cubies of that layer, then the new state is painted and transforms
  reset. No WebGL, no canvas, so it works everywhere and is easy to style.
* Drag to orbit; highlights pulse the stickers a step talks about.
* `NetView` draws the unfolded cube; in editable mode each sticker is a button.

### App (`js/app.js`)
* `Station` couples a view with the state the app trusts and a move history (undo).
* `Guide` drives solver steps on a station.
* Lessons are data (`js/lessons.js`); `MOVE_WORDS` gives the plain-English meaning of every
  move token, used for tooltips, the notation lesson and speech.

---

## 5. Testing

`node tests/run-tests.js` covers:
* move algebra (order 4, inverses, doubles, rotation identities such as x = R M' L');
* validity checks accepting scrambled/rotated cubes and rejecting a twisted corner, a
  flipped edge, a swapped pair and bad sticker counts;
* 400 random scrambles solved with stages in order, every stage goal holding after its
  steps and the replayed steps reproducing the final state;
* lesson facts (algorithms keep the first two layers; L shape at back-left; line
  horizontal);
* resuming from mid-twist states, including after an extra top-layer turn.

A headless-browser smoke test (Playwright with the system Chromium) was used during
development to click through every screen, win practice lessons via hints, auto-solve
in Play, validate/reject painted cubes and check for horizontal overflow on a phone
viewport.

---

## 6. Ideas for later

* Camera scanning of a real cube instead of painting the net.
* A "parent mode" printable cheat sheet of the seven tricks.
* Translations: all copy lives in `js/lessons.js` and `MOVE_WORDS`.
* Badges for solving in Play under a time, and a simple leaderboard per device.
* Optional 2×2 cube mode (same corners stage, no edges) as an even gentler start.
