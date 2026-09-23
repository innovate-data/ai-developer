# Cube Clubhouse® – a Cube tutor for kids

Cube Clubhouse teaches children (roughly ages 7–12) to solve a 3×3 Cube using the
classic beginner "layer by layer" method. It is a single-page web app with **no build
step and no dependencies**: open `index.html` in any modern browser and it works,
including on a phone or tablet.

> **Free to use, proprietary code.** Cube Clubhouse costs nothing to use — every
> feature, no purchases, no adverts — but it is not open source: Ira Learning LLC owns
> it, and the licence grants permission to use it and nothing more. See `LICENSE`, which
> is also shown to the reader on the app's own Licence page. The repository's root
> `LICENSE` covers the other projects beside this folder, not this one.
> Cube Clubhouse® is a registered trademark of Ira Learning LLC.

```
RubiksCubeTutor/
├── index.html            the app shell (three screens: Learn, Play, Solve my cube)
├── css/style.css         kid-friendly styling, light and dark themes, 3D cube, net editor
├── js/cube.js            3x3 model: facelets, moves, pieces, validity check
├── js/ncube.js           N x N model for 2x2 to 6x6, sticker-identical to cube.js at N=3
├── js/solver.js          beginner-method solver that explains every step
├── js/bigsolver.js       reduction solver for the 4x4, 5x5 and 6x6 (centres, edges, parity, then 3x3)
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
7. **Accessible.** Large targets, readable font, keyboard shortcuts (U D L R F B turn a side, X Y Z the whole cube, Shift for the ′ turn, and a digit first for an inner layer on a big cube), `aria-label`s on cube stickers and move buttons, and a 🔊 *Read* button using the browser's speech synthesis for early readers.
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
11. **Colours that rest the eyes on an iPad.** Kids hold a tablet close and look at it
   for a long time, so the app avoids blue-white glare. Light mode is warm paper
   (`#f6f3ea`) with soft ink (`#2b3040`, about 13:1), dark mode is warm charcoal, not
   black. There is one calm denim accent for anything tappable, so a child learns
   "blue means press me" once. Mistakes are coral rather than alarm red, success is a
   soft green, and the "turn this layer" highlight is pink because no sticker on the
   cube is pink. Stickers keep the six real cube colours so the app matches the cube in
   the child's hands. Every text and background pair passes WCAG AA, checked by a small
   script over all pairs in both themes; the pulse on highlighted stickers is a gentle
   brightness change rather than a flash, and animations are reduced when the device
   asks for reduced motion.
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

**Launch** – on iPhone and iPad the app opens on its logo, the cube face from the icon
with "Cube Clubhouse®", on the app's own background colour in light or dark. The same
picture stays up until the page has loaded and then fades, so there is no white flash.

**Learn** – a grid of lesson cards with stars, then a two-column lesson page: sticky 3D
cube with a move pad on the left, text, tricks, interactive widgets, practice area and
tips on the right.

**For grown-ups** – reached from the three footer links, never from the child's nav:
what the app teaches and how to sit with a child through it; a privacy page naming the
four things kept on the device and the fact that the app makes no network requests at
all, with a button that erases the lot after an iOS alert asks first; and the licence conditions in full - the app is
proprietary, owned by Ira Learning LLC - with the typeface's own licence and the
trademark notes. `#parents`, `#privacy` and `#licence` open it at the right
section, and anything unrecognised in the hash lands on the lessons.

**Play** – free play on a 2×2, 3×3, 4×4, 5×5 or 6×6, with a mix-up button, undo, a timer
that starts on the first move and a move counter. Bigger cubes get a row of buttons per
inner layer ("2U" is the second layer from the top). *Help me solve it* opens the guided
walkthrough on every size; making a manual move clears the (now stale) guide. The
chosen size is remembered on the device.

**Timer** – a speedcubing timer for the child's real cube, for once they can solve. It
shows a mix in standard notation (11 turns for a 2×2, 25 for a 3×3, then 40, 60 and 80),
held yellow-up green-front like the rest of the app, with a picture of how the cube should
look afterwards. Hold the big pad (or the space bar) until it turns green, let go to start,
and touch anywhere or press any key to stop; letting go too soon starts nothing. Times
read to the hundredth. An optional 15 seconds to look first follows competition rules:
starting after 15 seconds adds two, after 17 is a DNF. The last solve can be marked +2 or
DNF, or deleted once an iOS alert has asked. For each size it keeps the best time, the best average
of 5, and the current averages of 5 and 12, worked out the way the World Cube Association
does (drop the best and worst, average the rest; two DNFs make a DNF average), and stars
the best in the list. A new best says what the old one was, with confetti. Leaving the
screen mid-solve throws that solve away. Times are stored on the device only when the
child records one, with nothing but the time and its penalty — no dates.

Each turn of the mix is a button: tap it once it is done, and it turns green while the
picture makes that turn, so a child never loses their place in a long mix (a 6×6 has 80
turns). Tapping a done turn steps back to just before it. **Help me solve this mix** walks
the child from that exact mix to solved on any size, with the same guided steps, speeds,
Pause and Stop as Play; a note says the steps assume the cube has not been turned since,
and offers My real cube for one that has. Starting the clock, ticking a turn or a new mix
puts the steps away: a timed solve is the child's own. During the 15 seconds to look, the
app calls out "Eight seconds" and "Twelve seconds" as a competition judge would, since
the child is looking at the cube, not the screen. A chart of the last 50 solves (lower is
faster) labels only the best and the latest; touching the line or using the arrow keys
reads any point, and **Show all** lists every time, so nothing is only in the chart.

The walkthrough plays at a speed the child picks — 🐢 Slow, 🚶 Steady or 🐇 Fast, also
remembered — and while *Watch the whole solve* is running, the step buttons give way to
**Pause** (which becomes *Carry on*) and **Stop here**. The run plays one move at a
time, so those answer immediately even in the middle of a long trick, and a new speed
is used from the very next move. Stopping finishes the trick it is in and hands back a
cube that matches the card on screen, so the child can carry on by hand from there.

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
  whole cube. Each size's move pad shows a row per layer down to the middle. An odd
  cube above 3×3 gets one extra row for its middle layer, which is the same layer from
  either side, so six buttons cover it: without them a child could not make the
  middle-slice turns the 5×5 guide asks for.
* **A 2×2 has no centres**, so all 24 ways of holding a solved one are solved. The
  solver checks that first and says nothing when there is nothing to do, and otherwise
  picks whichever of the 24 ways to hold it starts with the most corners already home,
  prepending one "turn the whole cube" step. That is worth about 6 moves a solve.
* **A 2×2 is solved by the 3×3 solver.** Its 24 stickers are the corner stickers of a
  3×3, so they are placed on a solved 3×3 and the solver runs in a corners-only mode:
  every edge stage is skipped, and the goals never look at an edge. One extra step
  covers the difference between the puzzles: on a 2×2 a single top turn changes the
  parity of the top corners, so the solver makes it even before the corner trick, which
  is a 3-cycle, can finish. Average: 66 moves over 3,600 solves, counting every
  scramble in all 24 orientations.

### Big cubes (`js/bigsolver.js`)
* The 4×4, 5×5 and 6×6 are solved by **reduction**: build the six centres, pair up the
  edge pieces so every edge is one colour on each side, fix the one or two things an
  even cube can do that a 3×3 cannot, and then hand a 54-sticker "reduced" cube to the
  3×3 solver, whose steps are replayed on the big cube (outer turns and rotations are
  the same moves on any size).
* There is no case table. Each centre and edge step is found by **template search**:
  a few hundred short algorithm shapes (`s`, `A s B s'`, the two-slice commutator
  `s1 B s2 B' s1' B s2' B` that moves exactly three centre squares, and `P s X s'`
  with `X` a conjugate or the edge-flip trick) are expanded into a few thousand
  permutations per size, and the shortest one that makes progress without undoing
  finished work is taken. When nothing helps, each single face turn is tried as a
  set-up first. Every candidate is scored on the model, and the whole solve is replayed
  before it is returned, so a wrong step cannot reach the guide: a failed search throws
  and the app says it got stuck.
* Parity on the even cubes is two fixed algorithms checked on the model: a pure one-pair
  flip (`2R2 B2 U2 2L U2 2R' U2 2R U2 F2 2R F2 2L' B2 2R2`, written with single inner
  layers so it also keeps the centres of a 5×5 and 6×6) for an edge that looks flipped,
  and an edge swap for two edges that look swapped. On a 6×6 the flip is applied per
  wing orbit, and the pairing stage uses it when an edge's outer and inner pairs
  disagree. An odd cube can never need either.
* A whole permutation per candidate (216 stickers on a 6×6) cost 165 MB of tables,
  enough for an iPad to kill the tab. Each candidate now keeps only the squares it
  actually moves, packed into one typed array — face offsets, then (square, where it
  comes from) pairs — and only the size in play is cached. That is 14 MB for a 4×4,
  22 MB for a 5×5 and 30 MB for a 6×6, and the search got faster with it, because it
  touches far less memory.
* The work is sliced, not blocking. `solveAsync` drives the solver as a generator,
  running about 40 ms at a time and handing the thread back through a `MessageChannel`
  (`setTimeout` is clamped to 4 ms, which over five hundred slices is seconds of
  nothing). The page keeps painting at roughly 17 fps on a 4× throttled phone, the
  status line says which part is running, and Play holds its controls meanwhile so the
  cube cannot change under a running solve. Building the tables shares one permutation
  per template family instead of one per variant, which took a 6×6 from 680 ms to
  500 ms in Node.
* Cost: about 56 cards / 220 moves on a 4×4, 71 / 340 on a 5×5 and 95 / 510 on a 6×6
  (200, 100 and 60 random scrambles, no failures, plus short scrambles of 1 to 34
  moves and solved cubes held every way). Tables build in 0.2–0.8 s on first use and a
  6×6 solve takes about 0.4 s in Node, so the Play screen shows "Thinking…" first and
  holds the button until the answer is ready.
* The cards a child reads are written as the solve is found: the first card for a
  centre explains the job, the rest count it up ("This trick brings 2 more white
  squares to the BOTTOM side. That makes 12 out of 16."), an edge is always named with
  its two colours in the same order, and when a step has to take a finished edge apart
  again the card says so instead of quietly showing that edge twice.

### 3D view (`js/view.js`)
* **What it costs to draw.** A 6×6 is 152 cubies of six faces each: 912 elements, of
  which only 216 are stickers a child can see. The rest are the dark insides that stop
  you seeing through the gaps, and they used to carry a CSS `filter`, a border and a
  corner radius each — the browser gave every one its own filtered layer, and it was
  most of the cost of drawing a big cube. They are now a plain pre-darkened colour with
  no border: same picture, roughly twice the frame rate. (A single six-panel shell
  instead of those faces is faster still, but a static shell swallows a turning layer,
  so the faces stay.)
* **Per move**, the view used to rewrite the transform of every cubie, force a layout,
  repaint every sticker and then wait a fixed 20 ms of slack. Now only the layer that
  turned is reset, each cubie's resting transform is worked out once at build time,
  only stickers whose colour or highlight changed are repainted, and the move finishes
  on the real `transitionend` (with a timer as a backstop). A 3×3 move at the fastest
  speed went from 84 ms to 59 ms — the speed actually asked for — with no long tasks
  left. On a 6×6 with the CPU throttled 4× the frame rate went from 16 fps to 36-40.
* Dragging the cube turns it once per animation frame rather than once per pointer
  event, because a phone reports pointers faster than it draws.
* Face geometry (size, border, radius) is set once per cube as CSS custom properties,
  and which way a face points is a class, so building a 6×6 no longer writes six inline
  styles onto each of nine hundred elements.

* N³ cubie `<div>`s with six faces each, positioned with CSS 3D transforms. The view
  takes a model and sizes stickers so every cube is about the same size on screen;
  cubies buried inside a big cube are never created. A layer turn
  transitions the cubies of that layer, then the new state is painted and transforms
  reset. No WebGL, no canvas, so it works everywhere and is easy to style.
* Drag to orbit; highlights pulse the stickers a step talks about.
* `NetView` draws the unfolded cube; in editable mode each sticker is a button.

### Timer (`js/timer.js`)
* The timer's arithmetic, with no page in it: clock readings cut to hundredths, formatting
  (9.87, 1:02.35, DNF), WCA averages of 5 and 12, bests anywhere in the history, and the
  inspection penalties. The Timer screen in `js/app.js` is a small state machine around
  it: idle, holding, ready, running, plus inspecting.

### App (`js/app.js`)
* `Station` couples a view with the state the app trusts and a move history (undo).
* `Guide` drives solver steps on a station.
* Lessons are data (`js/lessons.js`); `MOVE_WORDS` gives the plain-English meaning of every
  move token, used for tooltips, the notation lesson and speech.

### Speaking and feeling like iOS

The app is meant to feel at home on iPad and iPhone, so it follows Apple's conventions
rather than a website's:

* **Words.** On a touch screen you *tap*; a long press is *touch and hold*; only keys are
  *pressed* (the space bar). Buttons, tabs and screen titles are in Title Case, as iOS
  buttons are ("Mix It Up", "Help Me Solve This Mix"). Settings are named as iOS names
  them: Aeroplane Mode, Reduce Motion, Guided Access, Screen Time, Text Size.
* **Where it is.** `WebAppView.swift` tells the page, before any script runs, that it is
  the iOS app and whether it is on an iPad or an iPhone. The page then says "on this
  iPad" where a browser would say "in this browser's storage" (`.w-ios` / `.w-web` in
  `index.html`); in a browser nothing changes.
* **Tabs.** A capsule at the top on iPad, as iPadOS draws it; on iPhone a translucent tab
  bar along the bottom, in reach of a thumb and clear of the home indicator, with the
  title scrolling away like a large title.
* **Controls.** Filled, tinted and gray buttons without borders, dimming while touched;
  segmented controls for cube size and guide speed; a real switch for the 15 seconds
  to look; no text-selection magnifier on a touch and hold.
* **Alerts.** Anything that loses work (clearing progress, deleting a time, swapping a
  mixed cube for another size) asks with an iOS alert: a title, one line, a bold Cancel
  with the focus, and the action in red. It is drawn by the page, because WKWebView
  shows no `confirm()` unless the app builds one.
* **Haptics.** A light tap when the timer turns green and on a switch, a firmer one when
  it stops, success on a solve or a finished practice, a warning on a destructive
  choice — through a `haptic` message handler in `WebAppView.swift`. iPad has no haptic
  engine, and a browser has no handler, so there it quietly does nothing.
* **Text Size.** The app follows Settings › Display & Brightness › Text Size, growing the
  whole page by up to a quarter; `npm run test:ios` checks every screen at that size on
  the narrowest iPhone.

### Nothing reaches the network

The app makes no requests at all, and three separate things keep it that way, because a
privacy promise held up only by nobody having typed a URL is not worth making to a
parent.

1. **There is nothing to fetch.** The page, the styles, the seven scripts and the
   typeface are all local. Fredoka lives in `fonts/` as a 29 KB variable WOFF2 under the
   SIL Open Font Licence, whose text ships beside it; it used to come from Google Fonts,
   which handed Google the device's address and the time of every launch.
2. **The page forbids it.** A `Content-Security-Policy` in `index.html` sets
   `default-src 'none'` and `connect-src 'none'`, and names no http(s) source in any
   directive — so `fetch`, `XMLHttpRequest`, beacons, sockets, remote scripts, remote
   styles, remote fonts and remote images are all refused by the browser itself. The
   three local ways the app is opened are allowed by scheme: a server (`'self'`), the
   iOS bundle (`cubeclubhouse:`) and a double-clicked file (`file:`).
3. **The iOS shell forbids it.** `WebAppView` compiles a `WKContentRuleList` that blocks
   every `^https?://` load inside the web view, and the navigation delegate cancels
   anything that is not the bundle's own scheme. This is the half a web page cannot
   switch off, and it fails open: if the rule will not compile the app still runs, with
   the policy above still in force.

A test in each of the three suites holds this down — see R24 and the offline group in
§5. The published single-page artifact inlines the typeface as a `data:` URL for the
same reason.

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
* the big cubes: the parity tricks move only the edges they claim to and keep every
  centre on the 4×4, 5×5 and 6×6; seeded scrambles of each size solve, with the stages
  in order and the replayed steps ending solved; a rotated solved cube needs no steps;
  a cube that only has parity gets just the fix; a 6×6 edge whose outer and inner pairs
  disagree is paired again; and the 2×2 and 3×3 still go to their own solvers.
* that the app stays offline: no shipped file names a remote address, the page's
  `Content-Security-Policy` allows no http(s) source anywhere and sets `connect-src
  'none'`, the typeface and its licence are really in `fonts/`, and the iOS shell
  both blocks http(s) inside the web view and refuses navigation off the bundle.
* the speed timer's arithmetic: times cut to hundredths and printed as a competition
  timer prints them; averages of 5 and 12 that drop the best and worst, count a +2, drop
  one DNF and fail on two, and round to the nearest hundredth; bests found anywhere in
  the history; inspection at exactly 15 and 17 seconds; and a mix of the right length for
  every size.
* the progress chart's axis: round whole-second ticks, evenly spaced, never below zero,
  that always cover every time plotted.

49 groups in all.

`npm run test:browser` (`tests/browser-tests.js`) drives the real page in Chromium: 300 checks.
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
| R15 | Every size from 2×2 to 6×6 draws, turns, undoes, mixes and resets; the guide solves a 2×2 and a 4×4 (centres, edges, then the 3×3 stages); the size survives a reload. |
| R16 | Changing size mid-animation ran a queued move against the new cube, and left it wrongly marked as mixed, so a move and an undo were celebrated as a solve. |
| R17 | Tearing down the guide or changing size left the narrator reading steps for a cube that was gone, with no Stop button to press. |
| R18 | The 5×5 guide asked for middle-layer turns that the move pad could not make; the pad now has a row for them. |
| R19 | A 6×6 guide opens from a real scramble, with "Thinking…" while it works, and its stage bar no longer fills a phone screen with thirteen chips. |
| R20 | The whole-solve run can be paused, resumed, stopped and re-speeded; stopping lands on a whole step, and the steps left still solve the cube. |
| R21 | The view repaints only what changed, so every sticker on screen is checked against the state it is meant to show. |
| R22 | The grown-ups pages open from the footer and from a deep link, say what is stored and carry the licence in full, and erasing progress asks first with an iOS alert (Cancel keeps everything). |
| R23 | Every part of the app is free: the guide opens on a 2×2, 3×3 and 4×4 and from My real cube with nothing in the way, no page asks for money, and the grown-ups pages say so — free to use, still proprietary, still no copying or reselling. |
| R24 | The app asks the network for nothing. Every request the page makes is recorded and anything off-device is refused outright; the walk covers all four screens, `fetch` to the outside is blocked by the page's own policy, and the app still works with the network cut. |
| R25 | Undo takes back the child's own turns, never the mix. One turn and twenty-one Undos used to walk the mix back and announce "Solved in 00:02 with 1 move!" with confetti; now the mix is cleared from the history when it finishes, and Undo does nothing while it is still mixing. |
| R26 | Holding a key down turns the cube once. Every auto-repeat used to queue a turn, so the cube spun on for about nine seconds after the key came up. |
| R27 | A drag that turns the picture a quarter or more round swings it back before a button, key or move chip turns a layer, so R is always the side on the right. A small peek round the side is left alone. |
| R28 | When a trick card's Watch makes the last turns of a practice, the stars are still earned but the 🧠 badge is not, and the app says why. The same turns typed by the child, or watched first and then taken back, still earn it. |
| R29 | Swapping cube size with a mixed cube on screen asks first with an iOS alert that says what will be lost; Escape or Cancel keeps the cube, Swap Cubes swaps. A solved cube swaps on one tap. |
| R30 | The keyboard reaches every layer: X, Y and Z turn the whole cube, and a digit typed first picks an inner layer on a big cube (2 then R is 2R). A layer the cube has not got is ignored. |
| R31 | Clear my colours really clears: every sticker but the centres goes grey, and Check asks for the grey ones before it says anything about the cube. |
| R32 | The speed timer: holding turns the pad amber, then green; letting go too soon starts nothing; it counts in hundredths; any key or a touch anywhere stops it and keeps the time; a fresh mix follows; and the space bar never presses a focused button. |
| R33 | Best time, best average of 5 and the averages of 5 and 12 match the WCA arithmetic; a faster solve is announced as a new best with the old one named; each size keeps its own times and mix length; everything survives a reload. |
| R34 | +2 and DNF toggle on the last solve (a DNF is never the best), delete asks first with an alert that names the time, and the 15 seconds to look count down, then give +2, then DNF. The clock is fast-forwarded rather than waited for. |
| R35 | Leaving the screen mid-solve throws the solve away; Escape cancels the looking time. |
| R36 | The Privacy and For parents pages describe the times; Clear saved progress erases them at once; opening the Timer stores nothing; damaged saved data is skipped, not fatal. |
| R37 | Cube Clubhouse® carries its ® in the header on every screen, the footer (with the ownership notice), the first mention on the grown-ups pages, the licence and the trademark note, without making the header taller; the page title stays plain. |
| R38 | Help me solve this mix opens guided steps for that exact mix (every turn ticked, the picture mixed), a whole watched solve ends solved, the steps close on a tick, a new mix or a started clock, a 5×5 holds the controls while it thinks and plans centres and edges, and a 3×3 note links to My real cube. |
| R39 | Ticking the mix: one tap turns the picture by one move, a later tap ticks everything up to it, a done turn steps back, the last turn says it is time to solve, and turns cannot be ticked while the clock runs. |
| R40 | Inspection says "Eight seconds" and "Twelve seconds", once each, and nothing during the solve. |
| R41 | The progress chart: one point per timed solve (a DNF left out, and said so), round-second ticks, only the best and the latest labelled (one label when they are the same solve), a readout by touch and by arrow keys, a Show all list, a redraw on resize, its own dark-mode blue, no chart for a single time, and the last 50 of a longer history. |
| R42 | On a touch screen you tap: nothing on any screen says to press a button or to click, the timer says "Touch and hold", and every button label is in Title Case. |
| R43 | In the iOS app the page says "this iPad" or "this iPhone" where a browser would say "this browser" (privacy, footer), and never mentions a browser; in a browser it still does. For Parents lists Guided Access, Screen Time and Text Size. |
| R44 | Haptics: a light tap when the clock turns green and on a switch, a firmer one when it stops, a warning on a destructive choice; with no haptic engine listening, nothing breaks. |
| R45 | On iPhone the tabs sit along the bottom and the title scrolls away; nothing at the foot of the page hides under the bar; the grown-ups section links stay in the page. On iPad the tabs are a capsule at the top. |
| R46 | The iOS alert: Cancel has the focus, it is announced as a modal alert, Tab stays inside it, keys do not reach the cube behind, tapping outside does nothing, and Escape cancels. |

`npm run test:ios` (`tests/ios-bundle-tests.js`) reads the Xcode project (no duplicate
object ids, nothing pointed at that is not there, the shop and the privacy manifest in
the build phases, both configurations on iOS 17.0, no `#available` check the target
already guarantees, and the shell's own network blocker), checks `PrivacyInfo.xcprivacy`
says what the app's Privacy page says, then drives the bundle the build phase
produces, by touch, on an iPhone and an iPad profile (each told it is the iOS app, as the
real one is): 130 checks, including every screen at the largest Text Size on the narrowest
iPhone, the tab bar at the bottom on iPhone and the top on iPad, the launch
screen (Info.plist wired into both configurations, a background colour identical to the
page's in light and dark, the logo at every scale and appearance and narrow enough for
the smallest iPhone, and a cover that lifts on load, on failure and after a timeout), a whole
4×4 solved by tapping, a timed solve by real touch events (hold, let go, tap to stop),
the tab bar staying on one row, that the app keeps painting and holds its controls while it
works a big cube out, that the bundled typeface really loads and nothing is fetched
from off the device, and that no control is smaller than 44pt.

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
