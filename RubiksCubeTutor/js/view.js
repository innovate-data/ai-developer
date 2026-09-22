/*
 * Cube Clubhouse - Copyright (c) 2026 Ira Learning LLC. All rights reserved.
 * Proprietary software. See LICENSE, or the Licence page inside the app.
 */
/*
 * view.js - 3D cube drawn with CSS transforms (no WebGL, no libraries).
 *
 * The cube is N x N x N little cubies; each cubie has six faces. Faces that point
 * outwards get the colour of the matching facelet in the cube state. A layer
 * turn animates the cubies of that layer with a CSS transition, then the new
 * state is painted and the transforms are reset.
 *
 * The view is driven by a model (RC.NCube.make(N), or RC.Cube for a 3x3): it asks
 * the model where every sticker is, how to parse a move, and how to apply one.
 */
(function (root) {
  'use strict';
  const Cube = root.RC.Cube;
  const defaultModel = () => (root.RC.NCube ? root.RC.NCube.make(3) : Cube);

  // X is a sticker not painted yet, on the My real cube screen.
  const COLOR_CLASS = { W: 'c-W', Y: 'c-Y', G: 'c-G', B: 'c-B', R: 'c-R', O: 'c-O', X: 'c-X' };
  // Which way each of a cubie's six faces points. The transform itself lives in CSS
  // (class f-pz and friends, off a --fs custom property), so building a 6x6 does not
  // mean writing six inline styles onto each of nine hundred elements.
  const FACE_CLASS = {
    '0,0,1': 'f-pz', '0,0,-1': 'f-nz', '1,0,0': 'f-px',
    '-1,0,0': 'f-nx', '0,1,0': 'f-py', '0,-1,0': 'f-ny',
  };
  const NORMALS = [[0, 0, 1], [0, 0, -1], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]];
  const AXIS_IDX = { x: 0, y: 1, z: 2 };
  // CSS rotation that matches one quarter turn of the model's U, R and F direction.
  const CSS_ANGLE = { y: -90, x: 90, z: 90 };

  class CubeView {
    constructor(container, options) {
      // `size` is the sticker size a 3x3 would get; other sizes scale so the whole
      // cube stays about as big on screen.
      this.opts = Object.assign({ model: null, size: 54, gap: null, rotX: -28, rotY: -38, duration: 320 }, options || {});
      this.model = this.opts.model || defaultModel();
      this.container = container;
      this.state = this.model.solved();
      this.rotX = this.opts.rotX;
      this.rotY = this.opts.rotY;
      this.queue = Promise.resolve();
      // Bumped whenever the state is replaced from outside. An animation that was
      // in flight at that moment must not apply its move to the new state.
      this.gen = 0;
      this.highlights = new Set();
      this.build();
      this.enableDrag();
    }

    faceSize() {
      return Math.max(14, Math.round((this.opts.size * 3) / this.model.N));
    }
    gap() {
      return this.opts.gap !== null ? this.opts.gap : this.model.N >= 5 ? 2 : 3;
    }

    build() {
      const S = this.faceSize();
      const border = S >= 40 ? 3 : 2;
      const radius = Math.max(3, Math.round(S * 0.13));
      this.step = S + this.gap();
      this.painted = null;                      // nothing drawn yet: paint everything
      const lookup = new Map();
      for (const g of this.model.GEO) lookup.set(g.pos.join(',') + '|' + g.n.join(','), g.index);
      this.container.classList.add('cube-scene');
      this.container.style.setProperty('--fs', S + 'px');
      this.container.style.setProperty('--fb', border + 'px');
      this.container.style.setProperty('--fr', radius + 'px');
      this.container.innerHTML = '';
      this.cubeEl = document.createElement('div');
      this.cubeEl.className = 'cube';
      this.container.appendChild(this.cubeEl);
      this.cubies = [];
      const coords = this.model.coords;
      for (const x of coords) {
        for (const y of coords) {
          for (const z of coords) {
            const faces = [];
            const el = document.createElement('div');
            el.className = 'cubie';
            for (const n of NORMALS) {
              const f = document.createElement('div');
              const dir = FACE_CLASS[n.join(',')];
              const idx = lookup.get([x, y, z].join(',') + '|' + n.join(','));
              if (idx !== undefined) {
                f.className = 'face ' + dir;
                f.dataset.index = idx;
                faces.push({ el: f, index: idx, base: 'face ' + dir + ' ' });
              } else {
                f.className = 'face inner ' + dir;
              }
              el.appendChild(f);
            }
            // a cubie buried inside a big cube can never be seen: leave it out
            if (faces.length === 0) continue;
            this.cubeEl.appendChild(el);
            // The resting transform of a cubie never changes, so work it out once.
            this.cubies.push({ el, pos: [x, y, z], faces, base: this.translate([x, y, z]) });
          }
        }
      }
      this.resetTransforms();
      this.paint();
      this.applyView();
    }

    // Swap in a different-sized model: rebuilds the cubies, solved.
    setModel(model) {
      this.model = model;
      this.gen++;
      this.state = model.solved();
      this.highlights = new Set();
      this.build();
    }

    translate(pos) {
      const step = this.step || this.faceSize() + this.gap();
      return 'translate3d(' + pos[0] * step + 'px,' + -pos[1] * step + 'px,' + pos[2] * step + 'px)';
    }

    // Put cubies back at rest without animating the way back. Only the cubies that
    // actually turned need it, which on a 6x6 is a couple of dozen out of 152.
    resetTransforms(only) {
      const list = only || this.cubies;
      for (const c of list) {
        c.el.style.transition = 'none';
        c.el.style.transform = c.base;
      }
      // force style flush so the next transition starts from the reset transform
      void this.cubeEl.offsetWidth;
      for (const c of list) c.el.style.transition = '';
    }

    applyView() {
      this.cubeEl.style.transform = 'rotateX(' + this.rotX + 'deg) rotateY(' + this.rotY + 'deg)';
    }

    // Repaint only the stickers whose colour or highlight actually changed: a move
    // touches a fraction of them, and writing className costs a style recalculation
    // whether or not the value is new.
    paint() {
      const all = this.painted === null;
      if (all) this.painted = new Map();
      const hl = this.highlights;
      for (const c of this.cubies) {
        for (const f of c.faces) {
          const want = COLOR_CLASS[this.state[f.index]] + (hl.has(f.index) ? ' hl' : '');
          if (!all && this.painted.get(f.index) === want) continue;
          f.el.className = f.base + want;
          this.painted.set(f.index, want);
        }
      }
    }

    setState(state) {
      this.gen++;
      this.state = state.slice();
      this.resetTransforms();
      this.paint();
    }

    setHighlights(indices) {
      this.highlights = new Set(indices || []);
      this.paint();
    }

    // Animate a single move (face turn, slice, wide or whole-cube rotation).
    animateMove(token, duration) {
      const mv = this.model.parseMove(token);
      const ms = duration === undefined ? this.opts.duration : duration;
      const gen = this.gen;
      const ai = AXIS_IDX[mv.axis];
      const angle = CSS_ANGLE[mv.axis] * mv.k;
      const layer = [];
      for (const c of this.cubies) if (mv.layers.includes(c.pos[ai])) layer.push(c);
      const spin = 'rotate' + mv.axis.toUpperCase() + '(' + angle + 'deg) ';
      return new Promise((resolve) => {
        for (const c of layer) {
          c.el.style.transition = 'transform ' + ms + 'ms cubic-bezier(.4,.1,.3,1)';
          c.el.style.transform = spin + c.base;
        }
        // Finish on the real transitionend rather than a timer with slack in it: the
        // old fixed 20ms was a third of the run again at the fastest speed, and a
        // reader who asked for less motion waited the full time for no animation.
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          if (layer.length) layer[0].el.removeEventListener('transitionend', onEnd);
          if (gen !== this.gen) { resolve(); return; }  // superseded: setState already repainted
          this.state = this.model.applyMove(this.state, token);
          this.resetTransforms(layer);
          this.paint();
          resolve();
        };
        const onEnd = (e) => { if (e.propertyName === 'transform') finish(); };
        if (layer.length) layer[0].el.addEventListener('transitionend', onEnd);
        const timer = setTimeout(finish, ms + 60);      // in case the event never comes
      });
    }

    // Queue a sequence of moves; resolves when all are done. onMove(token, i) fires as each finishes.
    play(moves, duration, onMove) {
      const tokens = this.model.parseAlg(moves);
      // Captured here, not inside run(): a play queued behind a running animation
      // would otherwise read the generation AFTER a size change and animate its
      // old-size moves against the new cube.
      const myGen = this.gen;
      const run = async () => {
        for (let i = 0; i < tokens.length; i++) {
          if (this.gen !== myGen) break;       // the cube was replaced under us
          await this.animateMove(tokens[i], duration);
          if (this.gen !== myGen) break;
          if (onMove) onMove(tokens[i], i);
        }
      };
      this.queue = this.queue.then(run, run);
      return this.queue;
    }

    cancel() {
      this.gen++;
    }

    enableDrag() {
      let dragging = false, lx = 0, ly = 0, moved = 0;
      const el = this.container;
      el.addEventListener('pointerdown', (e) => {
        dragging = true; moved = 0; lx = e.clientX; ly = e.clientY;
        el.setPointerCapture(e.pointerId);
      });
      let pending = false;
      el.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const dx = e.clientX - lx, dy = e.clientY - ly;
        moved += Math.abs(dx) + Math.abs(dy);
        lx = e.clientX; ly = e.clientY;
        this.rotY += dx * 0.5;
        this.rotX = Math.max(-80, Math.min(80, this.rotX - dy * 0.5));
        // A phone can send pointer events faster than it draws; turning the cube once
        // per frame keeps the drag smooth instead of queueing style writes.
        if (pending) return;
        pending = true;
        requestAnimationFrame(() => { pending = false; this.applyView(); });
      });
      const stop = () => { dragging = false; };
      el.addEventListener('pointerup', stop);
      el.addEventListener('pointercancel', stop);
      this.wasDragged = () => moved > 6;
    }

    resetView() {
      this.rotX = this.opts.rotX;
      this.rotY = this.opts.rotY;
      this.applyView();
    }

    // The move buttons are named for the cube held the usual way. Once a drag has
    // turned the picture a quarter or more round, R would turn a side that is no longer
    // on the right of the screen, so swing the picture back before the turn plays. It
    // goes on the animation queue, so it waits for any turn already running.
    straighten() {
      if (Math.round((this.rotY - this.opts.rotY) / 90) % 4 === 0) return;
      const swing = () => {
        const still = typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        this.cubeEl.classList.toggle('swing', !still);
        this.resetView();
        return new Promise((done) => setTimeout(() => { this.cubeEl.classList.remove('swing'); done(); }, still ? 0 : 280));
      };
      this.queue = this.queue.then(swing, swing);
    }
  }

  // 2D net (unfolded cube). Editable when `onPick` is given.
  class NetView {
    constructor(container, options) {
      this.opts = Object.assign({ editable: false, onPick: null }, options || {});
      this.container = container;
      this.state = Cube.solved();
      this.build();
    }

    build() {
      // Face placement lives in CSS (class nf-U, nf-L, ...) so the net can fold into a
      // narrower cross on a phone, where a four-wide net makes the stickers too small.
      this.container.classList.add('net');
      this.container.innerHTML = '';
      this.cells = [];
      for (const face of Cube.FACES) {
        const fEl = document.createElement('div');
        fEl.className = 'net-face nf-' + face;
        for (let i = 0; i < 9; i++) {
          const idx = Cube.FACE_INDEX[face] * 9 + i;
          const cell = document.createElement('button');
          cell.type = 'button';
          cell.className = 'net-cell';
          cell.dataset.index = idx;
          if (i === 4) cell.classList.add('centre');
          if (this.opts.editable && i !== 4) {
            cell.addEventListener('click', () => this.opts.onPick && this.opts.onPick(idx));
          } else {
            cell.tabIndex = -1;
          }
          fEl.appendChild(cell);
          this.cells[idx] = cell;
        }
        this.container.appendChild(fEl);
      }
      this.paint();
    }

    paint() {
      for (let i = 0; i < 54; i++) {
        const c = this.cells[i];
        c.className = 'net-cell ' + COLOR_CLASS[this.state[i]] + (i % 9 === 4 ? ' centre' : '');
        c.setAttribute('aria-label', Cube.faceOfIndex(i) + ' ' + (i % 9 + 1) + ' ' + (Cube.COLOR_NAMES[this.state[i]] || 'not painted yet'));
      }
    }

    setState(state) {
      this.state = state.slice();
      this.paint();
    }
  }

  root.RC.CubeView = CubeView;
  root.RC.NetView = NetView;
})(window);
