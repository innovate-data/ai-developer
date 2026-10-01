"""3D / 2D-slice grid viewer for `Results` using matplotlib embedded in Qt.

Performance notes: face geometry (exterior faces of the visible cell set, or
the polygons of a slice) is computed once per geometry change and cached; a
change of report step, property, colormap or color range only updates the
face colour array of the existing collection.
"""
from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import matplotlib
import numpy as np
from matplotlib.backends.backend_qt5agg import FigureCanvasQTAgg, NavigationToolbar2QT
from matplotlib.collections import PolyCollection
from matplotlib.colors import Normalize
from matplotlib.figure import Figure
from mpl_toolkits.mplot3d.art3d import Poly3DCollection
from PyQt5.QtCore import Qt, QTimer, pyqtSignal
from PyQt5.QtWidgets import (QCheckBox, QComboBox, QDoubleSpinBox, QFormLayout, QGridLayout, QGroupBox,
                             QHBoxLayout, QLabel, QMessageBox, QPushButton, QScrollArea, QSlider,
                             QSpinBox, QVBoxLayout, QWidget)

from ..grid import FACE_CORNERS
from ..units import get_units
from .widgets import SciSpinBox, format_date

COLORMAPS = ["viridis", "plasma", "inferno", "magma", "cividis", "turbo", "jet", "coolwarm", "RdBu_r",
             "Spectral_r", "Blues", "YlOrRd"]
RANGE_MODES = ["Auto (this step)", "Auto (all steps)", "Fixed"]

_PROP_QUANTITY = {"PRESSURE": "pressure", "PBUB": "pressure", "PDEW": "pressure", "RS": "rs",
                  "DEPTH": "length", "DX": "length", "DY": "length", "DZ": "length",
                  "PORV": "reservoir_volume", "DENO": "density", "DENG": "density", "DENW": "density",
                  "TEMP": "temperature"}


def property_unit(name: str, units_name: str) -> str:
    """Display unit for a cell property."""
    if name.startswith("PERM"):
        return "mD"
    if name in ("SWAT", "SOIL", "SGAS", "PORO", "NTG") or name.startswith(("ZMF", "XMF", "YMF")):
        return "fraction"
    q = _PROP_QUANTITY.get(name)
    if q is None:
        return ""
    try:
        return get_units(units_name).label(q)
    except ValueError:
        return ""


# ----------------------------------------------------------------------------
# Geometry (Qt-free)
# ----------------------------------------------------------------------------
def _neighbour_shift(a, axis, sign):
    """out[idx] = a[idx + sign along axis] (False outside the array)."""
    out = np.zeros_like(a)
    src = [slice(None)] * 3
    dst = [slice(None)] * 3
    if sign < 0:
        dst[axis], src[axis] = slice(1, None), slice(None, -1)
    else:
        dst[axis], src[axis] = slice(None, -1), slice(1, None)
    out[tuple(dst)] = a[tuple(src)]
    return out


class GridGeometry:
    """Cached geometric helpers for a corner-point description (corners (N, 8, 3))."""

    # (face name, axis in the (k, j, i) reshaped array, direction)
    _FACES = (("I-", 2, -1), ("I+", 2, 1), ("J-", 1, -1), ("J+", 1, 1), ("K-", 0, -1), ("K+", 0, 1))

    def __init__(self, nx, ny, nz, corners, active=None):
        self.nx, self.ny, self.nz = int(nx), int(ny), int(nz)
        self.n = self.nx * self.ny * self.nz
        self.corners = np.asarray(corners, dtype=np.float64).reshape(self.n, 8, 3)
        self.active = np.ones(self.n, bool) if active is None else np.asarray(active, bool).ravel()
        self.centers = self.corners.mean(axis=1)
        idx = np.arange(self.n)
        self.i = idx % self.nx
        self.j = (idx // self.nx) % self.ny
        self.k = idx // (self.nx * self.ny)
        act = self.corners[self.active] if self.active.any() else self.corners
        self.lo = act.reshape(-1, 3).min(axis=0)
        self.hi = act.reshape(-1, 3).max(axis=0)
        self._face_cache = {}

    def index(self, i, j, k):
        return int(i) + self.nx * (int(j) + self.ny * int(k))

    def visible_mask(self, irange=None, jrange=None, krange=None):
        """Active cells inside the (0-based, inclusive) I/J/K ranges."""
        m = self.active.copy()
        for arr, rng in ((self.i, irange), (self.j, jrange), (self.k, krange)):
            if rng is not None:
                m &= (arr >= rng[0]) & (arr <= rng[1])
        return m

    def exterior_faces(self, mask):
        """Faces of `mask` cells whose neighbour is outside the grid or not in `mask`.

        Returns (face_cells (F,), verts (F, 4, 3)).  Results are cached per mask.
        """
        key = mask.tobytes()
        if key in self._face_cache:
            return self._face_cache[key]
        m3 = mask.reshape(self.nz, self.ny, self.nx)
        cells, verts = [], []
        for name, axis, sign in self._FACES:
            vis = m3 & ~_neighbour_shift(m3, axis, sign)
            idx = np.flatnonzero(vis.ravel())
            if idx.size:
                cells.append(idx)
                verts.append(self.corners[idx][:, FACE_CORNERS[name], :])
        if cells:
            out = (np.concatenate(cells), np.concatenate(verts))
        else:
            out = (np.zeros(0, int), np.zeros((0, 4, 3)))
        if len(self._face_cache) > 8:
            self._face_cache.clear()
        self._face_cache[key] = out
        return out

    def slice_polygons(self, direction: str, index: int):
        """Polygons of a mid-cell section.  Returns (cells, polys (M, 4, 2), (xlabel, ylabel)).

        direction 'K': map view (x, y) of layer `index`; 'I': (y, depth) section at column `index`;
        'J': (x, depth) section at row `index`.  Only active cells are returned.
        """
        c = self.corners
        if direction == "K":
            cells = np.flatnonzero((self.k == index) & self.active)
            p = 0.5 * (c[cells][:, [0, 1, 3, 2], :] + c[cells][:, [4, 5, 7, 6], :])
            return cells, p[..., [0, 1]], ("x", "y")
        if direction == "I":
            cells = np.flatnonzero((self.i == index) & self.active)
            p = 0.5 * (c[cells][:, [0, 2, 6, 4], :] + c[cells][:, [1, 3, 7, 5], :])
            return cells, p[..., [1, 2]], ("y", "depth")
        cells = np.flatnonzero((self.j == index) & self.active)
        p = 0.5 * (c[cells][:, [0, 1, 5, 4], :] + c[cells][:, [2, 3, 7, 6], :])
        return cells, p[..., [0, 2]], ("x", "depth")


# ----------------------------------------------------------------------------
# Viewer widget
# ----------------------------------------------------------------------------
class Viewer3D(QWidget):
    """Property viewer with a 3D mode (exterior faces) and a 2D slice mode."""

    statusMessage = pyqtSignal(str)

    def __init__(self, parent=None):
        super().__init__(parent)
        self.results = None
        self.results_path = ""
        self.geom = None
        self._coll = None
        self._cbar = None
        self._ax = None
        self._face_cells = np.zeros(0, int)
        self._view = (25.0, -60.0)
        self._building = False
        self._vtk_procs = []
        self._range_cache = {}
        self._slice_title = ""

        self.figure = Figure(figsize=(8, 6))
        self.canvas = FigureCanvasQTAgg(self.figure)
        self.toolbar = NavigationToolbar2QT(self.canvas, self)
        self.canvas.mpl_connect("button_press_event", self._on_click)

        controls = self._build_controls()
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setWidget(controls)
        scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        scroll.setMinimumWidth(340)
        scroll.setMaximumWidth(400)

        plot = QWidget()
        pl = QVBoxLayout(plot)
        pl.setContentsMargins(0, 0, 0, 0)
        pl.addWidget(self.toolbar)
        pl.addWidget(self.canvas, 1)
        lay = QHBoxLayout(self)
        lay.addWidget(scroll)
        lay.addWidget(plot, 1)

        self._play_timer = QTimer(self)
        self._play_timer.setInterval(500)
        self._play_timer.timeout.connect(self._advance)
        self._set_enabled(False)
        self._draw_placeholder()

    # ------------------------------------------------------------------ UI
    def _build_controls(self):
        w = QWidget()
        lay = QVBoxLayout(w)

        g = QGroupBox("Property")
        f = QFormLayout(g)
        self.prop = QComboBox()
        self.prop.currentTextChanged.connect(self._on_property)
        f.addRow("Property", self.prop)
        self.step = QSlider(Qt.Horizontal)
        self.step.setRange(0, 0)
        self.step.valueChanged.connect(self._on_step)
        self.btn_play = QPushButton("▶")
        self.btn_play.setCheckable(True)
        self.btn_play.setFixedWidth(32)
        self.btn_play.setToolTip("Animate report steps")
        self.btn_play.toggled.connect(self._on_play)
        sl = QHBoxLayout()
        sl.addWidget(self.step, 1)
        sl.addWidget(self.btn_play)
        f.addRow("Report step", sl)
        self.time_label = QLabel("-")
        self.time_label.setWordWrap(True)
        f.addRow(self.time_label)
        lay.addWidget(g)

        g = QGroupBox("Colors")
        f = QFormLayout(g)
        self.cmap = QComboBox()
        self.cmap.addItems(COLORMAPS)
        self.cmap.currentTextChanged.connect(lambda *_: self.update_colors())
        f.addRow("Colormap", self.cmap)
        self.range_mode = QComboBox()
        self.range_mode.addItems(RANGE_MODES)
        self.range_mode.currentIndexChanged.connect(self._on_range_mode)
        f.addRow("Range", self.range_mode)
        self.vmin = SciSpinBox(0.0, -1e15, 1e15, 0.1, sig=6)
        self.vmax = SciSpinBox(1.0, -1e15, 1e15, 0.1, sig=6)
        for sp in (self.vmin, self.vmax):
            sp.setEnabled(False)
            sp.valueChanged.connect(lambda *_: self.update_colors())
        f.addRow("Min", self.vmin)
        f.addRow("Max", self.vmax)
        lay.addWidget(g)

        g = QGroupBox("Display")
        f = QFormLayout(g)
        self.mode = QComboBox()
        self.mode.addItems(["3D", "2D slice"])
        self.mode.currentIndexChanged.connect(self._on_mode)
        f.addRow("Mode", self.mode)
        self.show_wells = QCheckBox("Show wells")
        self.show_wells.setChecked(True)
        self.show_wells.toggled.connect(lambda *_: self.rebuild())
        self.show_edges = QCheckBox("Cell edges")
        self.show_edges.setChecked(True)
        self.show_edges.toggled.connect(lambda *_: self.rebuild())
        hl = QHBoxLayout()
        hl.addWidget(self.show_wells)
        hl.addWidget(self.show_edges)
        f.addRow(hl)
        lay.addWidget(g)

        # 3D options
        self.box3d = QGroupBox("3D view")
        f = QFormLayout(self.box3d)
        self.exag = QDoubleSpinBox()
        self.exag.setRange(0.1, 1000.0)
        self.exag.setDecimals(1)
        self.exag.setValue(5.0)
        self.exag.setKeyboardTracking(False)
        self.exag.valueChanged.connect(self._apply_aspect)
        f.addRow("Vertical exaggeration", self.exag)
        grid = QGridLayout()
        self.filters = {}
        for row, axis in enumerate("IJK"):
            lo, hi = QSpinBox(), QSpinBox()
            for sp in (lo, hi):
                sp.setRange(1, 1)
                sp.setKeyboardTracking(False)
                sp.valueChanged.connect(self._on_filter)
            grid.addWidget(QLabel(f"{axis}"), row, 0)
            grid.addWidget(lo, row, 1)
            grid.addWidget(QLabel("to"), row, 2)
            grid.addWidget(hi, row, 3)
            self.filters[axis] = (lo, hi)
        f.addRow(QLabel("Filter (show cells in range):"))
        f.addRow(grid)
        btn_reset = QPushButton("Reset filter")
        btn_reset.clicked.connect(self.reset_filter)
        f.addRow(btn_reset)
        lay.addWidget(self.box3d)

        # slice options
        self.box2d = QGroupBox("2D slice")
        f = QFormLayout(self.box2d)
        self.slice_dir = QComboBox()
        self.slice_dir.addItems(["K (map view)", "I (Y-Z section)", "J (X-Z section)"])
        self.slice_dir.currentIndexChanged.connect(self._on_slice_dir)
        self.slice_index = QSpinBox()
        self.slice_index.setRange(1, 1)
        self.slice_index.valueChanged.connect(lambda *_: self.rebuild())
        f.addRow("Direction", self.slice_dir)
        f.addRow("Index (1-based)", self.slice_index)
        self.box2d.setVisible(False)
        lay.addWidget(self.box2d)

        self.btn_vtk = QPushButton("Open interactive VTK window")
        self.btn_vtk.setToolTip("Opens a pyvista window in a separate process")
        self.btn_vtk.clicked.connect(lambda: self.open_vtk())
        lay.addWidget(self.btn_vtk)
        self.info = QLabel("")
        self.info.setWordWrap(True)
        self.info.setStyleSheet("color: #444")
        lay.addWidget(self.info)
        lay.addStretch(1)
        return w

    def _set_enabled(self, on):
        for wdg in (self.prop, self.step, self.btn_play, self.cmap, self.range_mode, self.mode,
                    self.box3d, self.box2d, self.btn_vtk, self.show_wells, self.show_edges):
            wdg.setEnabled(on)

    def _draw_placeholder(self):
        self.figure.clear()
        ax = self.figure.add_subplot(111)
        ax.set_axis_off()
        ax.text(0.5, 0.5, "No results loaded\n\nRun a simulation or use File > Open results (.npz)",
                ha="center", va="center", fontsize=12, color="gray", transform=ax.transAxes)
        self.canvas.draw_idle()

    # ------------------------------------------------------------------ data
    def set_results(self, results, path: str = ""):
        """Display a `Results` object (path = its .npz file, if any)."""
        self._play_timer.stop()
        self.btn_play.setChecked(False)
        self.results = results
        self.results_path = path or ""
        self._range_cache = {}
        self.geom = GridGeometry(results.nx, results.ny, results.nz, results.corners, results.active)
        self._building = True
        try:
            cur = self.prop.currentText()
            self.prop.clear()
            names = list(results.cell_data.keys()) + [k for k in results.static.keys()
                                                      if k not in results.cell_data]
            self.prop.addItems(names)
            if cur in names:
                self.prop.setCurrentText(cur)
            elif "PRESSURE" in names:
                self.prop.setCurrentText("PRESSURE")
            nr = max(1, results.n_reports)
            self.step.setRange(0, nr - 1)
            self.step.setValue(0)
            for axis, n in zip("IJK", (results.nx, results.ny, results.nz)):
                lo, hi = self.filters[axis]
                for sp in (lo, hi):
                    sp.setRange(1, n)
                lo.setValue(1)
                hi.setValue(n)
            self._update_slice_range()
            span = self.geom.hi - self.geom.lo
            hspan = max(span[0], span[1], 1e-9)
            zspan = max(span[2], 1e-9)
            self.exag.setValue(float(np.clip(round(0.35 * hspan / zspan, 1), 1.0, 1000.0)))
        finally:
            self._building = False
        self._set_enabled(True)
        self._on_property(self.prop.currentText(), rebuild=False)
        self.rebuild()
        na = int(self.geom.active.sum())
        self.info.setText(f"Grid {results.nx} x {results.ny} x {results.nz} ({na} active cells), "
                          f"{results.n_reports} report steps, {len(results.wells)} wells"
                          + (f"\n{os.path.basename(path)}" if path else ""))

    def current_values(self):
        """Full-grid (N,) array of the selected property at the selected report step."""
        r = self.results
        name = self.prop.currentText()
        if r is None or not name:
            return None
        step = self.step.value() if name in r.cell_data else 0
        return np.asarray(r.get_cell_array(name, step), dtype=float).ravel()

    def _clim(self, values):
        mode = self.range_mode.currentIndex()
        if mode == 2:
            return self.vmin.value(), self.vmax.value()
        name = self.prop.currentText()
        if mode == 1 and name in self.results.cell_data:
            if name not in self._range_cache:
                data = np.asarray(self.results.cell_data[name], float)[:, self.geom.active]
                finite = data[np.isfinite(data)]
                self._range_cache[name] = (finite.min(), finite.max()) if finite.size else (0.0, 1.0)
            lo, hi = self._range_cache[name]
            data = np.array([lo, hi], float)
        else:
            data = values[self.geom.active]
        finite = data[np.isfinite(data)]
        if finite.size == 0:
            return 0.0, 1.0
        lo, hi = float(finite.min()), float(finite.max())
        if hi - lo < 1e-12 * max(1.0, abs(hi)):
            lo, hi = lo - 0.5 * max(abs(lo) * 1e-3, 1e-6), hi + 0.5 * max(abs(hi) * 1e-3, 1e-6)
        return lo, hi

    def _cmap(self):
        return matplotlib.colormaps[self.cmap.currentText()].with_extremes(bad="lightgray")

    # ------------------------------------------------------------------ reactions
    def _on_property(self, name, rebuild=True):
        if self._building or self.results is None or not name:
            return
        dynamic = name in self.results.cell_data
        self.step.setEnabled(dynamic and self.results.n_reports > 1)
        self.btn_play.setEnabled(dynamic and self.results.n_reports > 1)
        self._update_time_label()
        if self.range_mode.currentIndex() == 2:
            vals = self.current_values()
            lo, hi = self._clim_auto(vals)
            self.vmin.setValue(lo)
            self.vmax.setValue(hi)
        self.update_colors()

    def _clim_auto(self, vals):
        mode = self.range_mode.currentIndex()
        self.range_mode.blockSignals(True)
        self.range_mode.setCurrentIndex(0)
        out = self._clim(vals)
        self.range_mode.setCurrentIndex(mode)
        self.range_mode.blockSignals(False)
        return out

    def _on_step(self, *_):
        if self._building:
            return
        self._update_time_label()
        self.update_colors()

    def _update_time_label(self):
        r = self.results
        if r is None:
            return
        name = self.prop.currentText()
        if name and name not in r.cell_data:
            self.time_label.setText("Static property")
            return
        s = self.step.value()
        t = float(r.report_times[s]) if s < len(r.report_times) else 0.0
        date = format_date(r.report_dates[s]) if s < len(r.report_dates) else ""
        self.time_label.setText(f"Step {s} / {max(0, r.n_reports - 1)}:  {date}   (t = {t:.6g} days)")

    def _on_range_mode(self, idx):
        fixed = idx == 2
        if fixed and self.results is not None:
            vals = self.current_values()
            lo, hi = self._clim_auto(vals)
            for sp, v in ((self.vmin, lo), (self.vmax, hi)):
                sp.blockSignals(True)
                sp.setValue(v)
                sp.blockSignals(False)
        self.vmin.setEnabled(fixed)
        self.vmax.setEnabled(fixed)
        self.update_colors()

    def _on_mode(self, idx):
        self.box3d.setVisible(idx == 0)
        self.box2d.setVisible(idx == 1)
        self.rebuild()

    def _on_slice_dir(self, *_):
        self._update_slice_range()
        self.rebuild()

    def _update_slice_range(self):
        if self.results is None:
            return
        n = {0: self.results.nz, 1: self.results.nx, 2: self.results.ny}[self.slice_dir.currentIndex()]
        self.slice_index.blockSignals(True)
        self.slice_index.setRange(1, max(1, n))
        self.slice_index.blockSignals(False)

    def _on_filter(self, *_):
        if not self._building:
            self.rebuild()

    def reset_filter(self):
        if self.results is None:
            return
        self._building = True
        for axis, n in zip("IJK", (self.results.nx, self.results.ny, self.results.nz)):
            self.filters[axis][0].setValue(1)
            self.filters[axis][1].setValue(n)
        self._building = False
        self.rebuild()

    def set_filter(self, axis, lo, hi):
        """Programmatic filter (1-based inclusive)."""
        self._building = True
        self.filters[axis][0].setValue(lo)
        self.filters[axis][1].setValue(hi)
        self._building = False
        self.rebuild()

    def _on_play(self, on):
        self.btn_play.setText("■" if on else "▶")
        if on:
            self._play_timer.start()
        else:
            self._play_timer.stop()

    def _advance(self):
        if self.step.maximum() == 0:
            self.btn_play.setChecked(False)
            return
        self.step.setValue((self.step.value() + 1) % (self.step.maximum() + 1))

    # ------------------------------------------------------------------ drawing
    def rebuild(self):
        """Recreate axes and geometry (mode, filter, slice or well display changed)."""
        if self._building or self.results is None:
            return
        if self._ax is not None and getattr(self._ax, "name", "") == "3d":
            self._view = (self._ax.elev, self._ax.azim)
        self.figure.clear()
        self._cbar = None
        if self.mode.currentIndex() == 0:
            self._build_3d()
        else:
            self._build_slice()
        if self._coll is not None:
            if self.mode.currentIndex() == 0:
                self._ax.set_position([0.0, 0.02, 0.84, 0.93])
                cax = self.figure.add_axes([0.88, 0.2, 0.018, 0.6])
                self._cbar = self.figure.colorbar(self._coll, cax=cax)
            else:
                self._cbar = self.figure.colorbar(self._coll, ax=self._ax, shrink=0.8, pad=0.03)
        self.update_colors()

    def _ranges(self):
        return [(self.filters[a][0].value() - 1, self.filters[a][1].value() - 1) for a in "IJK"]

    def _build_3d(self):
        g = self.geom
        ax = self.figure.add_subplot(111, projection="3d")
        self._ax = ax
        ir, jr, kr = self._ranges()
        mask = g.visible_mask(ir, jr, kr)
        cells, verts = g.exterior_faces(mask)
        self._face_cells = cells
        edges = self.show_edges.isChecked() and cells.size < 30000
        coll = Poly3DCollection(verts, cmap=self._cmap(), norm=Normalize(0, 1),
                                edgecolors="k" if edges else "face", linewidths=0.15 if edges else 0.0)
        coll.set_array(np.zeros(cells.size))
        ax.add_collection3d(coll)
        self._coll = coll
        lo, hi = g.lo, g.hi
        zspan = max(hi[2] - lo[2], 1e-6)
        ztop = lo[2]
        if self.show_wells.isChecked() and self.results.wells:
            ztop = lo[2] - 0.25 * zspan
            self._draw_wells_3d(ax, ztop)
        ax.set_xlim(lo[0], hi[0])
        ax.set_ylim(lo[1], hi[1])
        ax.set_zlim(hi[2], ztop)          # inverted: depth increases downwards
        u = self._len_unit()
        ax.set_xlabel(f"x [{u}]")
        ax.set_ylabel(f"y [{u}]")
        ax.set_zlabel(f"depth [{u}]")
        ax.view_init(*self._view)
        self._apply_aspect(draw=False)
        self.statusMessage.emit(f"3D view: {cells.size} faces of {int(mask.sum())} cells")

    def _apply_aspect(self, *_, draw=True):
        ax = self._ax
        if ax is None or getattr(ax, "name", "") != "3d" or self.geom is None:
            return
        x0, x1 = ax.get_xlim()
        y0, y1 = ax.get_ylim()
        z0, z1 = ax.get_zlim()
        span = np.array([abs(x1 - x0), abs(y1 - y0), abs(z1 - z0) * self.exag.value()])
        span = np.maximum(span, 1e-6 * span.max())
        ax.set_box_aspect(span / span.max(), zoom=1.0)
        if draw:
            self.canvas.draw_idle()

    def _well_xy(self, w):
        comps = w.get("completions") or []
        g = self.geom
        if comps:
            c = comps[0]
            return g.centers[g.index(c[0], c[1], c[2])][:2], comps
        i, j = int(w.get("i", 0)), int(w.get("j", 0))
        return g.centers[g.index(i, j, 0)][:2], []

    def _draw_wells_3d(self, ax, ztop):
        g = self.geom
        for w in self.results.wells:
            (x, y), comps = self._well_xy(w)
            color = "#1f4fd1" if str(w.get("kind", "")).upper().startswith("INJ") else "#111111"
            if comps:
                zbot = max(g.corners[g.index(*c)][:, 2].max() for c in comps)
                ztc = [g.centers[g.index(*c)][2] for c in comps]
            else:
                zbot, ztc = g.lo[2], []
            ax.plot([x, x], [y, y], [ztop, zbot], color=color, lw=2.2, zorder=10)
            if ztc:
                ax.scatter([x] * len(ztc), [y] * len(ztc), ztc, color=color, s=12, depthshade=False)
            ax.text(x, y, ztop, str(w.get("name", "")), color=color, fontsize=9, fontweight="bold",
                    zorder=11, ha="center", va="bottom")

    def _build_slice(self):
        g = self.geom
        ax = self.figure.add_subplot(111)
        self._ax = ax
        direction = "KIJ"[self.slice_dir.currentIndex()]
        idx = self.slice_index.value() - 1
        cells, polys, (xl, yl) = g.slice_polygons(direction, idx)
        self._face_cells = cells
        edges = self.show_edges.isChecked() and cells.size < 20000
        coll = PolyCollection(polys, cmap=self._cmap(), norm=Normalize(0, 1),
                              edgecolors="k" if edges else "face", linewidths=0.2 if edges else 0.0)
        coll.set_array(np.zeros(cells.size))
        ax.add_collection(coll)
        self._coll = coll
        if polys.size:
            pts = polys.reshape(-1, 2)
            lo, hi = pts.min(axis=0), pts.max(axis=0)
            pad = 0.02 * (hi - lo + 1e-9)
            ax.set_xlim(lo[0] - pad[0], hi[0] + pad[0])
            ax.set_ylim(lo[1] - pad[1], hi[1] + pad[1])
        u = self._len_unit()
        ax.set_xlabel(f"{xl} [{u}]")
        ax.set_ylabel(f"{yl} [{u}]")
        if direction == "K":
            ax.set_aspect("equal", adjustable="box")
            self._slice_title = f"layer K = {idx + 1}"
        else:
            ax.invert_yaxis()
            self._slice_title = f"{direction} = {idx + 1} cross-section"
        ax.set_title(self._slice_title)
        if self.show_wells.isChecked():
            self._draw_wells_2d(ax, direction, idx)
        self.statusMessage.emit(f"Slice {direction}={idx + 1}: {cells.size} cells (click a cell for its value)")

    def _draw_wells_2d(self, ax, direction, idx):
        g = self.geom
        for w in self.results.wells:
            (x, y), comps = self._well_xy(w)
            color = "#1f4fd1" if str(w.get("kind", "")).upper().startswith("INJ") else "#111111"
            name = str(w.get("name", ""))
            if direction == "K":
                ax.plot([x], [y], "o", color=color, ms=7, mfc="white", mew=2)
                ax.annotate(name, (x, y), xytext=(5, 5), textcoords="offset points", color=color,
                            fontweight="bold", fontsize=9)
                continue
            sel = [c for c in comps if (c[0] if direction == "I" else c[1]) == idx]
            if not sel:
                continue
            h = 1 if direction == "I" else 0
            pos = g.centers[g.index(*sel[0])][h]
            zs = [g.corners[g.index(*c)][:, 2] for c in sel]
            z0 = ax.get_ylim()[1]
            ax.plot([pos, pos], [z0, max(z.max() for z in zs)], color=color, lw=2.2)
            ax.annotate(name, (pos, z0), xytext=(3, -12), textcoords="offset points", color=color,
                        fontweight="bold", fontsize=9)

    def _len_unit(self):
        try:
            return get_units(self.results.meta.get("units", "METRIC")).label("length")
        except ValueError:
            return ""

    def update_colors(self):
        """Update face colours for the current property/step/colormap/range (no geometry rebuild)."""
        if self.results is None or self._coll is None or self._building:
            return
        vals = self.current_values()
        if vals is None:
            return
        lo, hi = self._clim(vals)
        if self.range_mode.currentIndex() != 2:      # show the automatic range in the (disabled) boxes
            for sp, v in ((self.vmin, lo), (self.vmax, hi)):
                sp.blockSignals(True)
                sp.setValue(v)
                sp.blockSignals(False)
        face_vals = np.ma.masked_invalid(vals[self._face_cells])
        self._coll.set_cmap(self._cmap())
        self._coll.set_norm(Normalize(lo, hi))
        self._coll.set_array(face_vals)
        name = self.prop.currentText()
        unit = property_unit(name, self.results.meta.get("units", "METRIC"))
        if self._cbar is not None:
            self._cbar.update_normal(self._coll)
            self._cbar.set_label(f"{name} [{unit}]" if unit else name)
        if self._ax is not None:
            title = f"{name}"
            if name in self.results.cell_data and self.step.value() < len(self.results.report_dates):
                title += f"  -  {format_date(self.results.report_dates[self.step.value()])}"
            if self.mode.currentIndex() == 1:
                title += f"  |  {self._slice_title}"
            self._ax.set_title(title, fontsize=10)
        self.canvas.draw_idle()

    def _on_click(self, event):
        if self.results is None or self.mode.currentIndex() != 1 or self._coll is None:
            return
        if event.inaxes is not self._ax:
            return
        hit, info = self._coll.contains(event)
        if not hit or not len(info.get("ind", [])):
            return
        cell = int(self._face_cells[info["ind"][0]])
        g = self.geom
        val = self.current_values()[cell]
        msg = (f"Cell ({g.i[cell] + 1}, {g.j[cell] + 1}, {g.k[cell] + 1}): "
               f"{self.prop.currentText()} = {val:.6g}")
        self.info.setText(msg)
        self.statusMessage.emit(msg)

    # ------------------------------------------------------------------ VTK
    def open_vtk(self, block=False):
        """Open a pyvista window in a separate process. Returns the Popen object or None."""
        if self.results is None:
            return None
        if importlib.util.find_spec("pyvista") is None:
            QMessageBox.information(self, "VTK viewer", "pyvista is not installed (pip install pyvista).")
            return None
        if sys.platform.startswith("linux") and not (os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")):
            QMessageBox.information(self, "VTK viewer", "No graphical display is available for the VTK window.")
            return None
        path = self.results_path
        if not path or not os.path.isfile(path):
            fd, path = tempfile.mkstemp(suffix=".resim.npz", prefix="resim_view_")
            os.close(fd)
            self.results.save(path)
            self.results_path = path
        prop = self.prop.currentText()
        step = self.step.value() if prop in self.results.cell_data else 0
        root = str(Path(__file__).resolve().parents[2])
        env = dict(os.environ)
        env["PYTHONPATH"] = root + os.pathsep + env.get("PYTHONPATH", "")
        cmd = [sys.executable, "-m", "resim.gui.vtk_view", path, prop, str(step),
               "--exaggeration", str(self.exag.value()), "--cmap", self.cmap.currentText()]
        try:
            proc = subprocess.Popen(cmd, env=env, cwd=root)
        except OSError as exc:
            QMessageBox.warning(self, "VTK viewer", f"Could not start the VTK viewer:\n{exc}")
            return None
        self._vtk_procs.append(proc)
        self.statusMessage.emit("Opening interactive VTK window (separate process)...")
        if block:
            proc.wait()
        else:
            QTimer.singleShot(4000, lambda p=proc: self._check_vtk(p))
        return proc

    def _check_vtk(self, proc):
        """Report a VTK viewer process that died during start-up (e.g. no OpenGL context)."""
        code = proc.poll()
        if code not in (None, 0):
            self.statusMessage.emit(f"The VTK viewer exited with code {code} (is an OpenGL display available?)")

    def close_vtk_windows(self):
        for p in self._vtk_procs:
            if p.poll() is None:
                p.terminate()
        self._vtk_procs = []
