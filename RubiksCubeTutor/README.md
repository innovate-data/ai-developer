# Cube Clubhouse – a Rubik's Cube tutor for kids

Cube Clubhouse teaches children (roughly ages 7–12) to solve a 3×3 Rubik's Cube using the
classic beginner "layer by layer" method. It is a single-page web app with **no build
step and no dependencies**: open `index.html` in any modern browser and it works,
including on a phone or tablet.

```
RubiksCubeTutor/
├── index.html            the app shell (three screens: Learn, Play, Solve my cube)
├── css/style.css         kid-friendly styling, light and dark themes, 3D cube, net editor
├── js/cube.js            3x3 model: facelets, moves, pieces, validity check
├── js/ncube.js           N x N model for 2x2 to 6x6, sticker-identical to cube.js at N=3
├── js/solver.js          beginner-method solver that explains every step
├── js/view.js            3D cube (CSS transforms) and 2D net view
├── js/lessons.js         the course content (plain data, easy to edit or translate)
├── js/app.js             screens, move pad, guided walkthrough, practice, quiz
├── build-artifact.js     bundles index.html + css into a single publishable page
├── ios/                  Xcode project: the same web app as a native iPhone/iPad app
├── tests/run-tests.js    model and solver tests (Node only, no packages)
├── tests/browser-tests.js end-to-end regression tests (needs Chromium)
└── tests/ios-bundle-tests.js  checks what the Xcode build phase would ship
```

It also ships as a native iOS app for iPhone and iPad: open
[`ios/CubeClubhouse.xcodeproj`](./ios/README.md) in Xcode and press Run.

```sh
npm test           # model and solver tests, Node 18+, no packages needed
npm run lint       # eslint, fetched on demand by npx
npm run build      # dist/artifact.html, a single-page build
npm run test:browser   # end-to-end tests; needs: npm i --no-save playwright-core
npm run test:ios       # the iOS bundle the Xcode build phase produces
npm run test:all       # all three
```

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
8. **Written to be read at seven.** Every sentence a child sees, in lessons, hints and
   solver steps, scores at a word-weighted Flesch-Kincaid grade of 2.0, with an average
   sentence of nine words. New words (layer, front, front-right, home, twisted) are
   explained the first time they are used. Move meanings are things a hand can do
   ("rolls up and away from you"), not "clockwise".
9. **Nothing needs reading to be understood.** Every lesson has a Read to me button; every
   hint, guide step and trick card has one too, and it speaks the moves in words, not
   letters. A Read button is a toggle: while it is reading it says Stop, so pressing it
   again stops the narration. Only one thing speaks at a time, so starting another one,
   moving to the next step, leaving the lesson or switching away from the app all stop
   the voice and put the button that started it back.
   Every move chip is a button: tap it to hear what it means and watch the cube do it
   and undo it. Whole-cube turns carry a 🔄 picture. Repeated tricks show once with a
   "× 2" badge to count against.
10. **Hints are not cheating.** Finishing a practice earns all three stars; doing it
   without hints adds a 🧠 badge on top. A mistake reads "Oops, the white cross came
   apart. That happens to everyone!", never "wrong".
11. **Honest about the real cube.** The guide's next button says "I did it", because it
   applies the moves; auto-play ends with "That was the whole solve" and an offer to
   start again, not "You solved it".
12. **Privacy by construction.** Everything runs in the browser; the only persisted data is the star progress in `localStorage`, and the app still works when that throws or is blocked.
13. **Both themes.** Colours are CSS tokens with a light and a dark palette, honouring the reader's system setting and an explicit `data-theme`. The six cube colours are deliberately identical in both, because they are the cube itself.

The copy is British English throughout (centre, colour, memorise, anticlockwise).

---

## 2. Learning path

| # | Lesson | What the child learns | Trick(s) |
|---|--------|-----------------------|----------|
| 1 | Meet Your Cube | Centres never move; edges have 2 colours; corners have 3. Light them up on the cube. | – |
| 2 | Cube Talk | Move notation R L U D F B, prime and 2. Try every move; quiz "name that move". | – |
| 3 | The Daisy | Bring four white edges around the yellow centre. Intuitive, no algorithm. | – |
| 4 | The White Cross | Match a petal's side colour to its centre, turn that side twice. | – |
| 5 | White Corners | Put a corner above its home and do Righty 1 or 3 times. A corner that would need 5 gets Righty backwards instead. | Righty `R U R' U'`, Righty backwards `U R U' R'` |
| 6 | The Middle Layer | Upside-down T, then the Slide-right or Slide-left trick. | Slide-right `U R U' R' U' F' U F`, Slide-left `U' L' U L U F U' F'` |
| 7 | The Yellow Cross | Dot → L → line → cross, with the L held at back-left. | Cross trick `F R U R' U' F'` |
| 8 | Yellow Edges Home | Turn the top to match two edges, turn the whole cube to hold them at back and right. | Edge trick `R U R' U R U2 R' U` |
| 9 | Yellow Corners Home | Keep a correct corner at the front-right; the other three cycle. | Corner trick `U R U' L' U R' U' L` |
| 10 | The Grand Finale | Twist each corner with 2 repetitions, forwards or backwards; only the top layer turns between corners. | Twist trick `R' D' R D`, backwards `D' R' D R` |

Lessons 3–10 have a practice mode with a goal check, hints and a "new cube" button.

---

## 3. Screens

**Learn** – a grid of lesson cards with stars, then a two-column lesson page: sticky 3D
cube with a move pad on the left, text, tricks, interactive widgets, practice area and
tips on the right.

**Play** – free play on a 2×2, 3×3, 4×4, 5×5 or 6×6, with a mix-up button, undo, a timer
that starts on the first move and a move counter. Bigger cubes get a row of buttons per
inner layer ("2U" is the second layer from the top). *Help me solve it* opens the guided
walkthrough on the 2×2 and the 3×3; making a manual move clears the (now stale) guide.
The chosen size is remembered on the device.

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
* **The words drive the moves, not the other way round.** For the last-layer stages the
  top-layer turn is derived from the case the lesson names, not from a search for any
  turn that happens to work. An earlier version searched, and so printed "hold the L at
  the back and the left" while doing something else: harmless on screen, but it would
  strand a child following along with a real cube. The tests now assert the shape is
  where the sentence says it is.
* One subtlety worth knowing when editing: turning the **top** changes *which* last-layer
  edges match their centres, because the centres stay put. Only turning the **whole cube**
  carries the pieces and their centres together, so that is how a matching pair is
  brought round to the back and the right.
* `midTwistPhase()` recognises a cube whose bottom layers are scrambled only because the
  learner is halfway through the final twist stage, and resumes there instead of
  restarting from the daisy. This matters for hints.
* `stateForStage(stage)` produces a practice cube: scramble, solve, replay the steps of
  earlier stages.
* **The same trick, backwards.** Both Righty and the Twist trick have order 6, so a
  corner that would need five Righties gets one Righty backwards (`U R U' R'`), and one
  that would need four twists gets two backwards (`D' R' D R`). One idea for the child
  to learn, and 17% fewer moves: the average solve is 142 moves over 400 random
  scrambles, down from 172, with never more than three repetitions of anything.
* The solver emits small steps (turn the cube, turn the top, do the trick) so a hint can
  be a small nudge. The walkthrough folds each piece's set-up turns into its trick, so a
  child sees about 23 cards per solve instead of 47.

### Other sizes (`js/ncube.js`)
* `NCube.make(N)` builds a model the same way cube.js does, from sticker positions and
  normals, for any N from 2 up. At N = 3 its sticker indices are identical to cube.js,
  which a test asserts move by move, so a 3×3 state from either module works in both.
* Move tokens follow the usual notation: outer faces, `2U` for the second layer in from
  the top, `Uw` and lowercase `u` for wide turns, `M E S` on odd cubes, `x y z` for the
  whole cube. Each size's move pad shows depths down to the middle, since the exact
  middle of an odd cube never needs to turn.
* **A 2×2 is solved by the 3×3 solver.** Its 24 stickers are the corner stickers of a
  3×3, so they are placed on a solved 3×3 and the solver runs in a corners-only mode:
  every edge stage is skipped, and the goals never look at an edge. One extra step
  covers the difference between the puzzles: on a 2×2 a single top turn changes the
  parity of the top corners, so the solver makes it even before the corner trick, which
  is a 3-cycle, can finish. Average: 72 moves, 19 steps, over 300 scrambles.
* **4×4 and up are free play only.** Guiding those needs the reduction method (centres,
  edge pairing, parity algorithms), a different curriculum from the one this app
  teaches, so the guide says so rather than pretending.

### 3D view (`js/view.js`)
* N³ cubie `<div>`s with six faces each, positioned with CSS 3D transforms. The view
  takes a model and sizes stickers so every cube is about the same size on screen;
  cubies buried inside a big cube are never created. A layer turn
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

`npm test` (`tests/run-tests.js`) covers the logic, with no browser and no packages:
* move algebra (order 4, inverses, doubles, rotation identities such as x = R M' L');
* validity checks accepting scrambled and rotated cubes, and rejecting a twisted
  corner, a flipped edge, a swapped pair and bad sticker counts;
* 400 random scrambles solved with stages in order, every stage goal holding after
  its steps, and the replayed steps reproducing the final state;
* lesson facts (algorithms keep the first two layers; L shape at back-left; line
  horizontal);
* resuming from mid-twist states, including after an extra top-layer turn;
* that each step's words match the moves it performs: the yellow-cross shape really
  is held where the text says, the yellow-edge step really delivers what it promises,
  and the middle-layer step highlights the edge it is talking about;
* that anything `validate()` accepts, the solver can actually solve;
* that the algorithms printed in the lessons are the ones the solver runs, so the
  teaching and the code cannot drift apart;
* that a practice cube always still needs the stage it was built for.

`npm run test:browser` (`tests/browser-tests.js`) drives the real page in Chromium.
Every case is a bug that was found and fixed, kept so it cannot come back:

| Case | The bug it guards against |
|------|---------------------------|
| R1 | The lesson list stayed on screen behind every open lesson, because a class-level `display: grid` outranks the `hidden` attribute. |
| R2, R3, R4 | Interrupting an animation desynchronised the drawn cube from the state the app reasons about, so "Reset" mid-scramble left an unsolved cube. |
| R2b | The celebration appeared while the cube was still turning. |
| R5 | "Do it all for me" wedged every guide button until a page reload if the guide was dismissed mid-run. |
| R6 | Opening a lesson with no practice awarded stars for the previously opened lesson. |
| R7 | Keyboard shortcuts stopped working after any button click. |
| R8, R9 | The browser Back button did not change screens; a hash like `#toString` hid every screen. |
| R10 | A hint replayed an algorithm for a cube that had since moved on. |
| R11 | Undo on Play left stale guide steps on screen. |
| R12 | A practice cube could open already solved, handing out an unearned win. |
| R13 | An impossible painted cube has to be explained in words a child understands. |
| R14 | The Read button had no way to stop; a second press now stops the narration. |
| R15 | Every size from 2×2 to 6×6 draws, turns, undoes, mixes and resets; the guide solves a 2×2 and declines a 4×4; the size survives a reload. |

`npm run test:ios` (`tests/ios-bundle-tests.js`) drives the bundle the Xcode build phase
produces, by touch, on an iPhone and an iPad profile: 27 checks.

A note on testing animations: a layer turn is a CSS transform, so the sticker colours
do not change until the move lands. Tests that wait for colours to stop changing pass
while the cube is mid-turn. The harness waits for every cubie to return to a plain
translate instead.

## 6. Ideas for later

* Camera scanning of a real cube instead of painting the net.
* A "parent mode" printable cheat sheet of the seven tricks.
* Translations: all copy lives in `js/lessons.js` and `MOVE_WORDS`.
* Badges for solving in Play under a time, and a simple leaderboard per device.
* Optional 2×2 cube mode (same corners stage, no edges) as an even gentler start.
