"""Summary plots tab: grouped key list with filter, multi-select plotting vs time
or date, secondary axis, comparison overlay of a second results file, and
PNG/CSV export."""
from __future__ import annotations

import csv
import datetime as _dt
import os

import numpy as np
from matplotlib.backends.backend_qt5agg import FigureCanvasQTAgg, NavigationToolbar2QT
from matplotlib.figure import Figure
from PyQt5.QtCore import Qt, pyqtSignal
from PyQt5.QtWidgets import (QAbstractItemView, QCheckBox, QComboBox, QFileDialog, QFormLayout, QGroupBox,
                             QHBoxLayout, QLabel, QLineEdit, QMessageBox, QPushButton, QSplitter,
                             QTreeWidget, QTreeWidgetItem, QVBoxLayout, QWidget)

COLORS = ["#1f77b4", "#d62728", "#2ca02c", "#ff7f0e", "#9467bd", "#8c564b", "#e377c2", "#17becf",
          "#7f7f7f", "#bcbd22"]

KEY_DESCRIPTIONS = {
    "OPR": "oil production rate", "WPR": "water production rate", "GPR": "gas production rate",
    "LPR": "liquid production rate", "WIR": "water injection rate", "GIR": "gas injection rate",
    "OPT": "cumulative oil production", "WPT": "cumulative water production", "GPT": "cumulative gas production",
    "WIT": "cumulative water injection", "GIT": "cumulative gas injection", "PR": "average pressure",
    "WCT": "water cut", "GOR": "gas-oil ratio", "OIP": "oil in place", "GIP": "gas in place",
    "WIP": "water in place", "BHP": "bottom-hole pressure",
}


def describe_key(key: str) -> str:
    base, _, ent = key.partition(":")
    desc = KEY_DESCRIPTIONS.get(base[1:], "")
    who = "Field" if base.startswith("F") else (f"Well {ent}" if ent else "")
    return f"{who} {desc}".strip()


def group_keys(keys):
    """{'Field': [...], 'Wells': {name: [...]}, 'Other': [...]} preserving order."""
    field, wells, other = [], {}, []
    for k in keys:
        if ":" in k:
            base, name = k.split(":", 1)
            wells.setdefault(name, []).append(k)
        elif k.startswith("F"):
            field.append(k)
        else:
            other.append(k)
    return {"Field": field, "Wells": wells, "Other": other}


class PlotsWidget(QWidget):
    """Summary vector plotting."""

    statusMessage = pyqtSignal(str)

    def __init__(self, parent=None):
        super().__init__(parent)
        self.results = None
        self.results_label = ""
        self.compare = None
        self.compare_label = ""

        # left: key tree
        self.filter = QLineEdit()
        self.filter.setPlaceholderText("Filter keys (e.g. OPR, BHP, PROD)")
        self.filter.textChanged.connect(self._apply_filter)
        self.tree = QTreeWidget()
        self.tree.setHeaderLabels(["Summary key", "Unit"])
        self.tree.setColumnWidth(0, 150)
        self.tree.setSelectionMode(QAbstractItemView.ExtendedSelection)
        self.tree.itemSelectionChanged.connect(self.replot)
        left = QWidget()
        ll = QVBoxLayout(left)
        ll.setContentsMargins(0, 0, 0, 0)
        ll.addWidget(self.filter)
        ll.addWidget(self.tree, 1)
        hint = QLabel("Ctrl/Shift-click to select several keys.")
        hint.setStyleSheet("color: gray")
        ll.addWidget(hint)

        opts = QGroupBox("Options")
        f = QFormLayout(opts)
        self.xaxis = QComboBox()
        self.xaxis.addItems(["Time [days]", "Date"])
        self.xaxis.currentIndexChanged.connect(self.replot)
        f.addRow("X axis", self.xaxis)
        self.secondary = QCheckBox("Secondary y-axis for a second unit")
        self.secondary.setChecked(True)
        self.secondary.setToolTip("Keys whose unit differs from the first selected key go on a right-hand axis")
        self.secondary.toggled.connect(self.replot)
        f.addRow(self.secondary)
        self.markers = QCheckBox("Markers")
        self.markers.toggled.connect(self.replot)
        self.logy = QCheckBox("Log y")
        self.logy.toggled.connect(self.replot)
        hl = QHBoxLayout()
        hl.addWidget(self.markers)
        hl.addWidget(self.logy)
        f.addRow(hl)
        ll.addWidget(opts)

        cmp_box = QGroupBox("Comparison")
        cl = QVBoxLayout(cmp_box)
        self.compare_info = QLabel("No comparison case")
        self.compare_info.setWordWrap(True)
        b1 = QPushButton("Load comparison results...")
        b1.clicked.connect(lambda: self.load_comparison_dialog())
        b2 = QPushButton("Clear")
        b2.clicked.connect(self.clear_comparison)
        bl = QHBoxLayout()
        bl.addWidget(b1)
        bl.addWidget(b2)
        cl.addWidget(self.compare_info)
        cl.addLayout(bl)
        ll.addWidget(cmp_box)

        exp = QHBoxLayout()
        b_png = QPushButton("Export PNG...")
        b_png.clicked.connect(lambda: self.export_png())
        b_csv = QPushButton("Export CSV...")
        b_csv.clicked.connect(lambda: self.export_csv())
        exp.addWidget(b_png)
        exp.addWidget(b_csv)
        ll.addLayout(exp)

        # right: figure
        self.figure = Figure(figsize=(8, 5), layout="constrained")
        self.canvas = FigureCanvasQTAgg(self.figure)
        self.toolbar = NavigationToolbar2QT(self.canvas, self)
        right = QWidget()
        rl = QVBoxLayout(right)
        rl.setContentsMargins(0, 0, 0, 0)
        rl.addWidget(self.toolbar)
        rl.addWidget(self.canvas, 1)

        split = QSplitter(Qt.Horizontal)
        split.addWidget(left)
        split.addWidget(right)
        split.setSizes([300, 900])
        lay = QVBoxLayout(self)
        lay.addWidget(split)
        self.replot()

    # ------------------------------------------------------------------ data
    def set_results(self, results, label: str = ""):
        selected = self.selected_keys()
        self.results = results
        self.results_label = label or results.meta.get("case", "") or "results"
        self._populate()
        keys = [k for k in selected if k in results.summary] or \
            [k for k in ("FOPR",) if k in results.summary]
        if keys:
            self.select_keys(keys)
        self.replot()

    def _populate(self):
        self.tree.blockSignals(True)
        self.tree.clear()
        r = self.results
        groups = group_keys(r.summary_keys())

        def add(parent, key):
            it = QTreeWidgetItem([key, r.unit_label(key)])
            it.setData(0, Qt.UserRole, key)
            it.setToolTip(0, describe_key(key))
            parent.addChild(it)

        def folder(title):
            it = QTreeWidgetItem([title, ""])
            it.setFlags(it.flags() & ~Qt.ItemIsSelectable)
            f = it.font(0)
            f.setBold(True)
            it.setFont(0, f)
            return it

        if groups["Field"]:
            top = folder("Field")
            for k in groups["Field"]:
                add(top, k)
            self.tree.addTopLevelItem(top)
            top.setExpanded(True)
        if groups["Wells"]:
            top = folder("Wells")
            self.tree.addTopLevelItem(top)
            for name, keys in groups["Wells"].items():
                sub = folder(name)
                for k in keys:
                    add(sub, k)
                top.addChild(sub)
                sub.setExpanded(True)
            top.setExpanded(True)
        if groups["Other"]:
            top = folder("Other")
            for k in groups["Other"]:
                add(top, k)
            self.tree.addTopLevelItem(top)
            top.setExpanded(True)
        self.tree.blockSignals(False)
        self._apply_filter(self.filter.text())

    def _leaf_items(self):
        out = []

        def walk(item):
            for i in range(item.childCount()):
                c = item.child(i)
                if c.data(0, Qt.UserRole):
                    out.append(c)
                walk(c)
        walk(self.tree.invisibleRootItem())
        return out

    def _apply_filter(self, text):
        terms = text.upper().split()
        for it in self._leaf_items():
            key = it.data(0, Qt.UserRole).upper()
            desc = describe_key(key).upper()
            it.setHidden(bool(terms) and not all(t in key or t in desc for t in terms))

        def hide_empty(item):
            visible = False
            for i in range(item.childCount()):
                c = item.child(i)
                if c.data(0, Qt.UserRole):
                    visible |= not c.isHidden()
                else:
                    v = hide_empty(c)
                    c.setHidden(not v)
                    visible |= v
            return visible
        hide_empty(self.tree.invisibleRootItem())

    def selected_keys(self):
        return [it.data(0, Qt.UserRole) for it in self.tree.selectedItems() if it.data(0, Qt.UserRole)]

    def select_keys(self, keys):
        self.tree.blockSignals(True)
        self.tree.clearSelection()
        for it in self._leaf_items():
            if it.data(0, Qt.UserRole) in keys:
                it.setSelected(True)
        self.tree.blockSignals(False)
        self.replot()

    # ------------------------------------------------------------------ comparison
    def load_comparison_dialog(self):
        path, _ = QFileDialog.getOpenFileName(self, "Comparison results", "", "ReSim results (*.npz)")
        if path:
            self.load_comparison(path)

    def load_comparison(self, path_or_results, label=""):
        from ..results import Results
        try:
            res = path_or_results if isinstance(path_or_results, Results) else Results.load(path_or_results)
        except Exception as exc:  # noqa: BLE001
            QMessageBox.warning(self, "Comparison", f"Cannot load {path_or_results}:\n{exc}")
            return
        self.compare = res
        self.compare_label = label or (os.path.basename(path_or_results) if isinstance(path_or_results, str)
                                       else res.meta.get("case", "comparison"))
        self.compare_info.setText(f"Overlay (dashed): {self.compare_label}")
        self.replot()

    def clear_comparison(self):
        self.compare = None
        self.compare_info.setText("No comparison case")
        self.replot()

    # ------------------------------------------------------------------ plotting
    def _x(self, res):
        t = np.asarray(res.summary["TIME"], float)
        if self.xaxis.currentIndex() == 1:
            start = res.meta.get("start_date") or "2000-01-01"
            try:
                d0 = _dt.datetime.fromisoformat(str(start))
            except ValueError:
                d0 = _dt.datetime(2000, 1, 1)
            return [d0 + _dt.timedelta(days=float(v)) for v in t]
        return t

    def replot(self, *_):
        self.figure.clear()
        ax = self.figure.add_subplot(111)
        keys = self.selected_keys() if self.results is not None else []
        if not keys:
            ax.set_axis_off()
            msg = "Select one or more summary keys" if self.results is not None else \
                "No results loaded\n\nRun a simulation or use File > Open results (.npz)"
            ax.text(0.5, 0.5, msg, ha="center", va="center", color="gray", fontsize=12, transform=ax.transAxes)
            self.canvas.draw_idle()
            return
        r = self.results
        units = [r.unit_label(k) for k in keys]
        u1 = units[0]
        u2 = next((u for u in units if u != u1), None) if self.secondary.isChecked() else None
        ax2 = ax.twinx() if u2 is not None else None
        style = "-o" if self.markers.isChecked() else "-"
        handles = []
        for n, (k, u) in enumerate(zip(keys, units)):
            target = ax2 if (ax2 is not None and u == u2) else ax
            color = COLORS[n % len(COLORS)]
            lab = f"{k} [{u}]" if u else k
            if self.compare is not None:
                lab += f" ({self.results_label})"
            h, = target.plot(self._x(r), r.summary[k], style, color=color, lw=1.6, ms=3, label=lab)
            handles.append(h)
            if self.compare is not None and k in self.compare.summary:
                h2, = target.plot(self._x(self.compare), self.compare.summary[k], "--", color=color, lw=1.4,
                                  label=f"{k} ({self.compare_label})")
                handles.append(h2)
        ax.set_xlabel("Date" if self.xaxis.currentIndex() == 1 else "Time [days]")
        left_keys = [k for k, u in zip(keys, units) if ax2 is None or u != u2]
        ax.set_ylabel(self._axis_label(left_keys, u1))
        if ax2 is not None:
            ax2.set_ylabel(self._axis_label([k for k, u in zip(keys, units) if u == u2], u2))
        for a in (ax, ax2):
            if a is not None and self.logy.isChecked():
                a.set_yscale("log")
        ax.grid(alpha=0.3)
        ax.legend(handles=handles, loc="best", fontsize=8)
        title = self.results_label + (f"  vs  {self.compare_label}" if self.compare is not None else "")
        ax.set_title(title, fontsize=10)
        if self.xaxis.currentIndex() == 1:
            ax.tick_params(axis="x", labelrotation=30)
        self.canvas.draw_idle()

    @staticmethod
    def _axis_label(keys, unit):
        names = ", ".join(keys[:4]) + (", ..." if len(keys) > 4 else "")
        return f"{names} [{unit}]" if unit else names

    # ------------------------------------------------------------------ export
    def export_png(self, path=None):
        if path is None:
            path, _ = QFileDialog.getSaveFileName(self, "Export plot", "summary_plot.png",
                                                  "PNG image (*.png);;PDF (*.pdf);;SVG (*.svg)")
            if not path:
                return False
        self.figure.savefig(path, dpi=150)
        self.statusMessage.emit(f"Plot saved to {path}")
        return True

    def export_csv(self, path=None):
        """Export the selected keys (all keys if none selected), plus the comparison case if loaded."""
        if self.results is None:
            return False
        if path is None:
            path, _ = QFileDialog.getSaveFileName(self, "Export CSV", "summary.csv", "CSV (*.csv)")
            if not path:
                return False
        keys = self.selected_keys() or self.results.summary_keys()
        if self.compare is None:
            self.results.summary_to_csv(path, keys)
        else:
            with open(path, "w", newline="") as fh:
                w = csv.writer(fh)
                for label, res in ((self.results_label, self.results), (self.compare_label, self.compare)):
                    ks = [k for k in keys if k in res.summary]
                    w.writerow([f"# {label}"])
                    w.writerow(["TIME"] + ks)
                    w.writerow(["days"] + [res.unit_label(k) for k in ks])
                    for i, t in enumerate(res.summary["TIME"]):
                        w.writerow([f"{t:.6g}"] + [f"{res.summary[k][i]:.8g}" for k in ks])
                    w.writerow([])
        self.statusMessage.emit(f"CSV saved to {path}")
        return True
