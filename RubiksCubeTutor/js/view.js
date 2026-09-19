/*
 * view.js - 3D cube drawn with CSS transforms (no WebGL, no libraries).
 *
 * The cube is 27 little cubies; each cubie has six faces. Faces that point
 * outwards get the colour of the matching facelet in the cube state. A layer
 * turn animates the cubies of that layer with a CSS transition, then the new
 * state is painted and the transforms are reset.
 */
(function (root) {
  'use strict';
  const Cube = root.RC.Cube;

  const COLOR_CLASS = { W: 'c-W', Y: 'c-Y', G: 'c-G', B: 'c-B', R: 'c-R', O: 'c-O' };
  const FACE_TRANSFORMS = {
    '0,0,1': 'translateZ(H)',
    '0,0,-1': 'rotateY(180deg) translateZ(H)',
    '1,0,0': 'rotateY(90deg) translateZ(H)',
    '-1,0,0': 'rotateY(-90deg) translateZ(H)',
    '0,1,0': 'rotateX(90deg) translateZ(H)',
    '0,-1,0': 'rotateX(-90deg) translateZ(H)',
  };
  const NORMALS = [[0, 0, 1], [0, 0, -1], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]];
  const AXIS_IDX = { x: 0, y: 1, z: 2 };
  // CSS rotation that matches one quarter turn of the model's U, R and F direction.
  const CSS_ANGLE = { y: -90, x: 90, z: 90 };

  class CubeView {
    constructor(container, options) {
      this.opts = Object.assign({ size: 54, gap: 3, rotX: -28, rotY: -38, duration: 320 }, options || {});
      this.container = container;
      this.state = Cube.solved();
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

    build() {
      const S = this.opts.size;
      this.container.classList.add('cube-scene');
      this.container.innerHTML = '';
      this.cubeEl = document.createElement('div');
      this.cubeEl.className = 'cube';
      this.container.appendChild(this.cubeEl);
      this.cubies = [];
      for (let x = -1; x <= 1; x++) {
        for (let y = -1; y <= 1; y++) {
          for (let z = -1; z <= 1; z++) {
            const el = document.createElement('div');
            el.className = 'cubie';
            const faces = [];
            for (const n of NORMALS) {
              const f = document.createElement('div');
              f.className = 'face';
              f.style.transform = FACE_TRANSFORMS[n.join(',')].replace('H', S / 2 + 'px');
              const idx = Cube.GEO.findIndex((g) => g.pos[0] === x && g.pos[1] === y && g.pos[2] === z && g.n[0] === n[0] && g.n[1] === n[1] && g.n[2] === n[2]);
              if (idx >= 0) {
                f.dataset.index = idx;
                faces.push({ el: f, index: idx });
              } else {
                f.classList.add('inner');
              }
              el.appendChild(f);
            }
            this.cubeEl.appendChild(el);
            this.cubies.push({ el, pos: [x, y, z], faces });
          }
        }
      }
      this.resetTransforms();
      this.paint();
      this.applyView();
    }

    translate(pos) {
      const step = this.opts.size + this.opts.gap;
      return 'translate3d(' + pos[0] * step + 'px,' + -pos[1] * step + 'px,' + pos[2] * step + 'px)';
    }

    resetTransforms() {
      for (const c of this.cubies) {
        c.el.style.transition = 'none';
        c.el.style.transform = this.translate(c.pos);
      }
      // force style flush so the next transition starts from the reset transform
      void this.cubeEl.offsetWidth;
      for (const c of this.cubies) c.el.style.transition = '';
    }

    applyView() {
      this.cubeEl.style.transform = 'rotateX(' + this.rotX + 'deg) rotateY(' + this.rotY + 'deg)';
    }

    paint() {
      for (const c of this.cubies) {
        for (const f of c.faces) {
          f.el.className = 'face ' + COLOR_CLASS[this.state[f.index]] + (this.highlights.has(f.index) ? ' hl' : '');
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
      const mv = Cube.parseMove(token);
      const ms = duration === undefined ? this.opts.duration : duration;
      const gen = this.gen;
      const ai = AXIS_IDX[mv.axis];
      const angle = CSS_ANGLE[mv.axis] * mv.k;
      const layer = this.cubies.filter((c) => mv.layers.includes(c.pos[ai]));
      return new Promise((resolve) => {
        for (const c of layer) {
          c.el.style.transition = 'transform ' + ms + 'ms cubic-bezier(.4,.1,.3,1)';
          c.el.style.transform = 'rotate' + mv.axis.toUpperCase() + '(' + angle + 'deg) ' + this.translate(c.pos);
        }
        setTimeout(() => {
          if (gen !== this.gen) { resolve(); return; }  // superseded: setState already repainted
          this.state = Cube.applyMove(this.state, token);
          this.resetTransforms();
          this.paint();
          resolve();
        }, ms + 20);
      });
    }

    // Queue a sequence of moves; resolves when all are done. onMove(token, i) fires as each finishes.
    play(moves, duration, onMove) {
      const tokens = Cube.parseAlg(moves);
      const run = async () => {
        const myGen = this.gen;
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
      el.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const dx = e.clientX - lx, dy = e.clientY - ly;
        moved += Math.abs(dx) + Math.abs(dy);
        lx = e.clientX; ly = e.clientY;
        this.rotY += dx * 0.5;
        this.rotX = Math.max(-80, Math.min(80, this.rotX - dy * 0.5));
        this.applyView();
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
        c.setAttribute('aria-label', Cube.faceOfIndex(i) + ' ' + (i % 9 + 1) + ' ' + Cube.COLOR_NAMES[this.state[i]]);
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
