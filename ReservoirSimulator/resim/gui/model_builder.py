"""Model builder tab: a form that creates an ECLIPSE deck without typing keywords.

The widget collects a `deckgen.DeckSpec` from its fields (`get_spec`), can be
populated from one (`set_spec`) and emits `deckGenerated(text, case_name)`
when the user presses *Generate deck*.  Unit-system changes convert all
unit-dependent values in place; fluid-type changes load the default PVT data
of the new fluid.
"""
from __future__ import annotations

import datetime as _dt

import numpy as np
from PyQt5.QtCore import QDate, Qt, pyqtSignal
from PyQt5.QtWidgets import (QAbstractItemView, QComboBox, QDateEdit, QFormLayout,
                             QGridLayout, QGroupBox, QHBoxLayout, QHeaderView, QLabel, QLineEdit,
                             QMessageBox, QPushButton, QScrollArea, QSpinBox, QStackedWidget,
                             QTableWidget, QTableWidgetItem, QTabWidget, QVBoxLayout, QWidget)

from ..units import get_units
from . import deckgen as dg
from .widgets import SciSpinBox


def _dspin(value=0.0, lo=-1e12, hi=1e12, decimals=None, step=1.0, width=110):
    """Spin box showing compact/scientific notation (`decimals` kept for call compatibility)."""
    w = SciSpinBox(value, lo, hi, step)
    w.setMinimumWidth(width)
    return w


def _ispin(value=1, lo=1, hi=100000):
    w = QSpinBox()
    w.setRange(lo, hi)
    w.setValue(value)
    return w


def _num(text, what):
    try:
        return float(str(text).strip())
    except ValueError as exc:
        raise ValueError(f"{what}: {text!r} is not a number") from exc


# ----------------------------------------------------------------------------
# Editable numeric table
# ----------------------------------------------------------------------------
class TableEditor(QWidget):
    """A titled QTableWidget with add/remove-row buttons, exchanging lists of rows."""

    def __init__(self, title, headers, rows=None, allow_blank_first=False, fixed_rows=False, parent=None):
        super().__init__(parent)
        self.headers = list(headers)
        self.allow_blank_first = allow_blank_first
        self.title_name = title
        self.title = QLabel(f"<b>{title}</b>")
        self.table = QTableWidget(0, len(headers))
        self.table.setHorizontalHeaderLabels(self.headers)
        self.table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        self.table.verticalHeader().setDefaultSectionSize(22)
        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        head = QHBoxLayout()
        head.addWidget(self.title)
        head.addStretch(1)
        if not fixed_rows:
            add = QPushButton("+ row")
            rem = QPushButton("- row")
            add.clicked.connect(self.add_row)
            rem.clicked.connect(self.remove_row)
            head.addWidget(add)
            head.addWidget(rem)
        lay.addLayout(head)
        lay.addWidget(self.table)
        if fixed_rows:
            self.table.setMaximumHeight(60)
        if rows is not None:
            self.set_rows(rows)

    def set_headers(self, headers):
        self.headers = list(headers)
        self.table.setHorizontalHeaderLabels(self.headers)

    def set_rows(self, rows):
        self.table.setRowCount(0)
        for r in rows:
            self._append([("" if v is None else f"{float(v):.6g}") for v in r])

    def _append(self, texts):
        row = self.table.rowCount()
        self.table.insertRow(row)
        for c in range(self.table.columnCount()):
            self.table.setItem(row, c, QTableWidgetItem(texts[c] if c < len(texts) else ""))

    def add_row(self):
        row = self.table.currentRow()
        row = self.table.rowCount() if row < 0 else row + 1
        self.table.insertRow(row)
        for c in range(self.table.columnCount()):
            self.table.setItem(row, c, QTableWidgetItem(""))

    def remove_row(self):
        row = self.table.currentRow()
        if row < 0:
            row = self.table.rowCount() - 1
        if row >= 0:
            self.table.removeRow(row)

    def rows(self):
        """Rows as lists of floats (None for a blank first column if allowed); empty rows skipped."""
        out = []
        for r in range(self.table.rowCount()):
            texts = [(self.table.item(r, c).text().strip() if self.table.item(r, c) else "")
                     for c in range(self.table.columnCount())]
            if not any(texts):
                continue
            vals = []
            for c, t in enumerate(texts):
                if not t:
                    if c == 0 and self.allow_blank_first:
                        vals.append(None)
                        continue
                    raise ValueError(f"{self.title_name}: empty cell in row {r + 1}, column "
                                     f"{self.headers[c]}")
                vals.append(_num(t, f"{self.title_name} row {r + 1}"))
            out.append(vals)
        return out


def pvto_to_rows(records):
    rows = []
    for rec in records:
        rs, rest = rec[0], rec[1:]
        for m in range(0, len(rest), 3):
            rows.append([rs if m == 0 else None] + list(rest[m:m + 3]))
    return rows


def rows_to_pvto(rows):
    recs = []
    for r in rows:
        if r[0] is not None or not recs:
            if r[0] is None:
                raise ValueError("PVTO: the first row needs an Rs value")
            recs.append([r[0]] + list(r[1:4]))
        else:
            recs[-1] += list(r[1:4])
    return recs


# ----------------------------------------------------------------------------
# Wells table
# ----------------------------------------------------------------------------
class WellsTable(QWidget):
    COLS = ["Name", "Type", "I", "J", "K1", "K2", "Control", "Target rate", "BHP limit", "Inj. phase"]

    def __init__(self, parent=None):
        super().__init__(parent)
        self.table = QTableWidget(0, len(self.COLS))
        self.table.setHorizontalHeaderLabels(self.COLS)
        self.table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        self.table.setSelectionBehavior(QAbstractItemView.SelectRows)
        add = QPushButton("Add well")
        rem = QPushButton("Remove selected")
        add.clicked.connect(lambda: self.add_well(None))
        rem.clicked.connect(self.remove_selected)
        bl = QHBoxLayout()
        bl.addWidget(add)
        bl.addWidget(rem)
        bl.addStretch(1)
        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.addWidget(self.table)
        lay.addLayout(bl)

    def _combo(self, items, value):
        cb = QComboBox()
        cb.addItems(items)
        if value in items:
            cb.setCurrentText(value)
        return cb

    def add_well(self, w: dg.WellSpec = None):
        if w is None:
            n = self.table.rowCount() + 1
            w = dg.WellSpec(f"P{n}", "PROD", 1, 1, 1, 1, "ORAT", 1000.0, 1000.0)
        row = self.table.rowCount()
        self.table.insertRow(row)
        self.table.setItem(row, 0, QTableWidgetItem(w.name))
        kind = self._combo(["PROD", "INJ"], w.kind)
        self.table.setCellWidget(row, 1, kind)
        for c, v in zip((2, 3, 4, 5), (w.i, w.j, w.k1, w.k2)):
            self.table.setItem(row, c, QTableWidgetItem(str(v)))
        ctrl = self._combo(dg.PROD_CONTROLS if w.kind == "PROD" else dg.INJ_CONTROLS, w.control)
        self.table.setCellWidget(row, 6, ctrl)
        self.table.setItem(row, 7, QTableWidgetItem(f"{w.rate:.6g}"))
        self.table.setItem(row, 8, QTableWidgetItem(f"{w.bhp:.6g}"))
        phase = self._combo(dg.INJ_PHASES, w.phase)
        phase.setEnabled(w.kind == "INJ")
        self.table.setCellWidget(row, 9, phase)

        def on_kind(text, ctrl=ctrl, phase=phase):
            ctrl.blockSignals(True)
            ctrl.clear()
            ctrl.addItems(dg.PROD_CONTROLS if text == "PROD" else dg.INJ_CONTROLS)
            ctrl.blockSignals(False)
            phase.setEnabled(text == "INJ")
        kind.currentTextChanged.connect(on_kind)

    def remove_selected(self):
        rows = sorted({i.row() for i in self.table.selectedIndexes()}, reverse=True)
        if not rows and self.table.rowCount():
            rows = [self.table.rowCount() - 1]
        for r in rows:
            self.table.removeRow(r)

    def set_wells(self, wells):
        self.table.setRowCount(0)
        for w in wells:
            self.add_well(w)

    def wells(self):
        out = []
        for r in range(self.table.rowCount()):
            name = (self.table.item(r, 0).text() if self.table.item(r, 0) else "").strip().upper()

            def cell(c, what, conv=float):
                t = self.table.item(r, c).text() if self.table.item(r, c) else ""
                try:
                    return conv(float(t)) if conv is int else conv(t)
                except ValueError as exc:
                    raise ValueError(f"Well {name or r + 1}: {what} {t!r} is not a number") from exc
            out.append(dg.WellSpec(
                name=name, kind=self.table.cellWidget(r, 1).currentText(),
                i=cell(2, "I", int), j=cell(3, "J", int), k1=cell(4, "K1", int), k2=cell(5, "K2", int),
                control=self.table.cellWidget(r, 6).currentText(), rate=cell(7, "rate"), bhp=cell(8, "BHP"),
                phase=self.table.cellWidget(r, 9).currentText()))
        return out

    def force_phase(self, phase):
        for r in range(self.table.rowCount()):
            self.table.cellWidget(r, 9).setCurrentText(phase)


# ----------------------------------------------------------------------------
# Main form
# ----------------------------------------------------------------------------
class ModelBuilder(QWidget):
    """Form-based deck generator."""

    deckGenerated = pyqtSignal(str, str)     # deck text, case name
    statusMessage = pyqtSignal(str)

    def __init__(self, parent=None):
        super().__init__(parent)
        self._units = "FIELD"
        self._unit_labels = []               # (QLabel, text template, quantity)
        self._loading = False

        self.pages = QTabWidget()
        self.pages.addTab(self._scroll(self._build_grid_page()), "Case && grid")
        self.pages.addTab(self._build_fluid_page(), "Fluid && PVT")
        self.pages.addTab(self._build_scal_page(), "Rel. perm")
        self.pages.addTab(self._scroll(self._build_init_page()), "Initial conditions")
        self.pages.addTab(self._build_wells_page(), "Wells && schedule")

        self.btn_reset = QPushButton("Reset to defaults")
        self.btn_reset.clicked.connect(self.reset_defaults)
        self.btn_generate = QPushButton("Generate deck  →  Deck editor")
        self.btn_generate.setStyleSheet("font-weight: bold; padding: 6px 14px;")
        self.btn_generate.clicked.connect(self._on_generate)
        bl = QHBoxLayout()
        bl.addWidget(QLabel("Fill in the pages, then generate an ECLIPSE deck into the editor."))
        bl.addStretch(1)
        bl.addWidget(self.btn_reset)
        bl.addWidget(self.btn_generate)

        lay = QVBoxLayout(self)
        lay.addWidget(self.pages, 1)
        lay.addLayout(bl)
        self.set_spec(dg.default_spec(dg.FLUID_BLACKOIL, "FIELD"))

    # ------------------------------------------------------------------ helpers
    @staticmethod
    def _scroll(w):
        sa = QScrollArea()
        sa.setWidgetResizable(True)
        sa.setWidget(w)
        return sa

    def _ulabel(self, text, quantity):
        """Label whose '{u}' placeholder shows the unit of `quantity` in the current unit system."""
        lab = QLabel()
        self._unit_labels.append((lab, text, quantity))
        return lab

    def _refresh_unit_labels(self):
        u = get_units(self._units)
        extra = {"compressibility": "1/psi" if self._units == "FIELD" else "1/bar",
                 "abs_temperature": "degR" if self._units == "FIELD" else "K",
                 "temperature": "degF" if self._units == "FIELD" else "degC",
                 "bg": "rb/Mscf" if self._units == "FIELD" else "rm3/sm3"}
        for lab, text, q in self._unit_labels:
            lab.setText(text.replace("{u}", extra.get(q) or u.label(q)))
        self.pvdo.set_headers([f"P [{u.label('pressure')}]", "Bo [rb/stb]" if self._units == "FIELD"
                               else "Bo [rm3/sm3]", "mu_o [cP]"])
        self.pvto.set_headers([f"Rs [{u.label('rs')}]", f"P [{u.label('pressure')}]",
                               "Bo", "mu_o [cP]"])
        self.pvdg.set_headers([f"P [{u.label('pressure')}]", f"Bg [{extra['bg']}]", "mu_g [cP]"])
        self.pvtw.set_headers([f"Pref [{u.label('pressure')}]", "Bw", f"cw [{extra['compressibility']}]",
                               "mu_w [cP]", f"Cv [{extra['compressibility']}]"])
        self.density.set_headers([f"Oil [{u.label('density')}]", f"Water [{u.label('density')}]",
                                  f"Gas [{u.label('density')}]"])
        self.comp_table.set_headers(["Name", f"Tc [{extra['abs_temperature']}]", f"Pc [{u.label('pressure')}]",
                                     "acentric", "MW [g/mol]", "z oil", "z inj. gas"])

    # ------------------------------------------------------------------ pages
    def _build_grid_page(self):
        w = QWidget()
        lay = QVBoxLayout(w)
        case = QGroupBox("Case")
        f = QFormLayout(case)
        self.case_name = QLineEdit()
        self.title = QLineEdit()
        self.units = QComboBox()
        self.units.addItems(["FIELD", "METRIC"])
        self.units.currentTextChanged.connect(self._on_units_changed)
        self.start = QDateEdit()
        self.start.setCalendarPopup(True)
        self.start.setDisplayFormat("yyyy-MM-dd")
        f.addRow("Case name", self.case_name)
        f.addRow("Title", self.title)
        f.addRow("Units", self.units)
        f.addRow("Start date", self.start)
        lay.addWidget(case)

        grid = QGroupBox("Grid (block-centred Cartesian)")
        g = QGridLayout(grid)
        self.nx, self.ny, self.nz = _ispin(10), _ispin(10), _ispin(3)
        g.addWidget(QLabel("NX"), 0, 0)
        g.addWidget(self.nx, 0, 1)
        g.addWidget(QLabel("NY"), 0, 2)
        g.addWidget(self.ny, 0, 3)
        g.addWidget(QLabel("NZ"), 0, 4)
        g.addWidget(self.nz, 0, 5)
        self.dx, self.dy, self.dz = QLineEdit(), QLineEdit(), QLineEdit()
        self.dx.setToolTip("Constant, or NX comma-separated values (one per column)")
        self.dy.setToolTip("Constant, or NY comma-separated values (one per row)")
        self.dz.setToolTip("Constant, or NZ comma-separated values (one per layer)")
        g.addWidget(self._ulabel("DX [{u}]", "length"), 1, 0)
        g.addWidget(self.dx, 1, 1)
        g.addWidget(self._ulabel("DY [{u}]", "length"), 1, 2)
        g.addWidget(self.dy, 1, 3)
        g.addWidget(self._ulabel("DZ [{u}]", "length"), 1, 4)
        g.addWidget(self.dz, 1, 5)
        self.top = _dspin(8325, 0, 1e6, 2)
        g.addWidget(self._ulabel("Top depth [{u}]", "length"), 2, 0)
        g.addWidget(self.top, 2, 1)
        lay.addWidget(grid)

        rock = QGroupBox("Rock properties (constant, or per-layer comma lists)")
        r = QFormLayout(rock)
        self.poro, self.permx, self.permy, self.permz = QLineEdit(), QLineEdit(), QLineEdit(), QLineEdit()
        r.addRow("Porosity [-]", self.poro)
        r.addRow("PERMX [mD]", self.permx)
        r.addRow("PERMY [mD]", self.permy)
        r.addRow("PERMZ [mD]", self.permz)
        self.rock_pref = _dspin(3600, 0, 1e7, 3)
        self.rock_comp = _dspin(4e-6, 0, 1, None, 0)
        r.addRow(self._ulabel("Rock ref. pressure [{u}]", "pressure"), self.rock_pref)
        r.addRow(self._ulabel("Rock compressibility [{u}]", "compressibility"), self.rock_comp)
        lay.addWidget(rock)
        lay.addStretch(1)
        return w

    def _build_fluid_page(self):
        w = QWidget()
        lay = QVBoxLayout(w)
        top = QHBoxLayout()
        top.addWidget(QLabel("Fluid type:"))
        self.fluid = QComboBox()
        for key, label in dg.FLUID_TYPES.items():
            self.fluid.addItem(label, key)
        self.fluid.currentIndexChanged.connect(self._on_fluid_changed)
        top.addWidget(self.fluid)
        top.addStretch(1)
        btn = QPushButton("Load default PVT for this fluid")
        btn.clicked.connect(self._load_fluid_defaults)
        top.addWidget(btn)
        lay.addLayout(top)

        common = QHBoxLayout()
        self.pvtw = dg_table = TableEditor("PVTW (water)", ["Pref", "Bw", "cw", "mu_w", "Cv"], fixed_rows=True)
        self.density = TableEditor("DENSITY (surface)", ["Oil", "Water", "Gas"], fixed_rows=True)
        common.addWidget(dg_table, 5)
        common.addWidget(self.density, 3)
        lay.addLayout(common)

        self.fluid_stack = QStackedWidget()
        # dead oil
        self.pvdo = TableEditor("PVDO (dead oil)", ["P", "Bo", "mu_o"])
        self.fluid_stack.addWidget(self.pvdo)
        # black oil
        bo = QWidget()
        bl = QHBoxLayout(bo)
        bl.setContentsMargins(0, 0, 0, 0)
        self.pvto = TableEditor("PVTO (live oil)", ["Rs", "P", "Bo", "mu_o"], allow_blank_first=True)
        self.pvto.title.setText("<b>PVTO (live oil)</b> &nbsp; blank Rs = undersaturated row of the record above")
        self.pvto.title_name = "PVTO"
        self.pvdg = TableEditor("PVDG (dry gas)", ["P", "Bg", "mu_g"])
        bl.addWidget(self.pvto, 4)
        bl.addWidget(self.pvdg, 3)
        self.fluid_stack.addWidget(bo)
        # compositional
        co = QWidget()
        cl = QVBoxLayout(co)
        cl.setContentsMargins(0, 0, 0, 0)
        self.comp_table = QTableWidget(0, 7)
        self.comp_table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        self.comp_table.verticalHeader().setDefaultSectionSize(22)
        self.comp_table.set_headers = lambda h: self.comp_table.setHorizontalHeaderLabels(h)
        self.bic_table = QTableWidget(0, 0)
        self.bic_table.verticalHeader().setDefaultSectionSize(22)
        ch = QHBoxLayout()
        ch.addWidget(QLabel("<b>Components (Peng-Robinson EOS)</b>"))
        ch.addStretch(1)
        addc = QPushButton("+ component")
        remc = QPushButton("- component")
        addc.clicked.connect(self._add_component)
        remc.clicked.connect(self._remove_component)
        ch.addWidget(addc)
        ch.addWidget(remc)
        cl.addLayout(ch)
        cl.addWidget(self.comp_table, 3)
        cl.addWidget(QLabel("<b>Binary interaction coefficients</b> (lower triangle is used)"))
        cl.addWidget(self.bic_table, 3)
        cf = QHBoxLayout()
        self.rtemp = _dspin(160, -300, 2000, 2)
        self.stc_t = _dspin(60, -300, 300, 3)
        self.stc_p = _dspin(14.696, 0, 1e4, 5)
        cf.addWidget(self._ulabel("Reservoir temperature [{u}]", "temperature"))
        cf.addWidget(self.rtemp)
        cf.addWidget(self._ulabel("Std. temperature [{u}]", "temperature"))
        cf.addWidget(self.stc_t)
        cf.addWidget(self._ulabel("Std. pressure [{u}]", "pressure"))
        cf.addWidget(self.stc_p)
        cf.addStretch(1)
        cl.addLayout(cf)
        self.fluid_stack.addWidget(co)
        lay.addWidget(self.fluid_stack, 1)
        return w

    def _build_scal_page(self):
        w = QWidget()
        lay = QHBoxLayout(w)
        box = QGroupBox("Corey relative permeability")
        f = QFormLayout(box)
        self.corey = {}
        defaults = dg.CoreyParams()
        spec = [("swc", "Connate water Swc", 0, 0.9), ("sorw", "Residual oil to water Sorw", 0, 0.9),
                ("sgc", "Critical gas Sgc", 0, 0.9), ("sorg", "Residual oil to gas Sorg", 0, 0.9),
                ("nw", "Water exponent nw", 0.5, 8), ("now", "Oil exponent (o/w) now", 0.5, 8),
                ("ng", "Gas exponent ng", 0.5, 8), ("nog", "Oil exponent (o/g) nog", 0.5, 8),
                ("krw_max", "krw at Sorw", 0, 1), ("kro_max", "kro at Swc", 0, 1), ("krg_max", "krg at Sorg", 0, 1)]
        for key, label, lo, hi in spec:
            sp = _dspin(getattr(defaults, key), lo, hi, 3, 0.05, 80)
            sp.valueChanged.connect(self._update_scal_preview)
            self.corey[key] = sp
            f.addRow(label, sp)
        self.corey_rows = _ispin(defaults.nrows, 3, 100)
        self.corey_rows.valueChanged.connect(self._update_scal_preview)
        f.addRow("Table rows", self.corey_rows)
        lay.addWidget(box)

        from matplotlib.backends.backend_qt5agg import FigureCanvasQTAgg
        from matplotlib.figure import Figure
        self.scal_fig = Figure(figsize=(6, 4), tight_layout=True)
        self.scal_canvas = FigureCanvasQTAgg(self.scal_fig)
        lay.addWidget(self.scal_canvas, 1)
        return w

    def _build_init_page(self):
        w = QWidget()
        lay = QVBoxLayout(w)
        box = QGroupBox("Hydrostatic equilibrium (EQUIL)")
        f = QFormLayout(box)
        self.datum = _dspin(8400, -1e5, 1e6, 2)
        self.datum_p = _dspin(4800, 0, 1e6, 3)
        self.woc = _dspin(8450, -1e5, 1e6, 2)
        self.goc = _dspin(8300, -1e5, 1e6, 2)
        f.addRow(self._ulabel("Datum depth [{u}]", "length"), self.datum)
        f.addRow(self._ulabel("Pressure at datum [{u}]", "pressure"), self.datum_p)
        f.addRow(self._ulabel("Water-oil contact [{u}]", "length"), self.woc)
        f.addRow(self._ulabel("Gas-oil contact [{u}]", "length"), self.goc)
        self.goc_note = QLabel("The GOC is ignored for dead oil and compositional fluids without a gas cap.")
        self.goc_note.setStyleSheet("color: gray")
        f.addRow(self.goc_note)
        lay.addWidget(box)
        lay.addStretch(1)
        return w

    def _build_wells_page(self):
        w = QWidget()
        lay = QVBoxLayout(w)
        wb = QGroupBox("Wells (I, J, K are 1-based; rates in surface units, BHP limit is the minimum for "
                       "producers and the maximum for injectors)")
        wl = QVBoxLayout(wb)
        self.wells = WellsTable()
        wl.addWidget(self.wells)
        self.rate_hint = self._ulabel("Rate units: liquid {u}", "liquid_surface_rate")
        self.rate_hint2 = self._ulabel("gas {u}", "gas_surface_rate")
        self.bhp_hint = self._ulabel("pressure {u}", "pressure")
        hl = QHBoxLayout()
        for lab in (self.rate_hint, self.rate_hint2, self.bhp_hint):
            lab.setStyleSheet("color: gray")
            hl.addWidget(lab)
        hl.addStretch(1)
        wl.addLayout(hl)
        lay.addWidget(wb, 1)
        sb = QGroupBox("Schedule && output")
        f = QFormLayout(sb)
        self.total_time = _dspin(3650, 1e-3, 1e6, 2, 30)
        self.report_step = _dspin(365, 1e-3, 1e6, 2, 30)
        f.addRow("Total simulation time [days]", self.total_time)
        f.addRow("Report step [days]", self.report_step)
        self.summary = QLineEdit()
        self.summary.setToolTip("Field summary vectors written to the SUMMARY section")
        f.addRow("Summary vectors", self.summary)
        lay.addWidget(sb)
        return w

    # ------------------------------------------------------------------ components
    def _set_components(self, comps, bic):
        self.comp_table.setRowCount(0)
        for c in comps:
            self._append_component_row([c.name, c.tc, c.pc, c.acf, c.mw, c.z_oil, c.z_inj])
        self._set_bic(bic if bic is not None else np.zeros((len(comps), len(comps))))

    def _append_component_row(self, vals):
        r = self.comp_table.rowCount()
        self.comp_table.insertRow(r)
        for c, v in enumerate(vals):
            self.comp_table.setItem(r, c, QTableWidgetItem(v if isinstance(v, str) else f"{v:.6g}"))

    def _set_bic(self, bic):
        n = self.comp_table.rowCount()
        names = [self.comp_table.item(r, 0).text() if self.comp_table.item(r, 0) else f"C{r + 1}"
                 for r in range(n)]
        self.bic_table.setRowCount(n)
        self.bic_table.setColumnCount(n)
        self.bic_table.setHorizontalHeaderLabels(names)
        self.bic_table.setVerticalHeaderLabels(names)
        for i in range(n):
            for j in range(n):
                v = bic[i, j] if i < bic.shape[0] and j < bic.shape[1] else 0.0
                it = QTableWidgetItem(f"{v:.6g}" if j < i else "")
                if j >= i:
                    it.setFlags(Qt.ItemIsEnabled)
                    it.setBackground(Qt.lightGray)
                self.bic_table.setItem(i, j, it)

    def _bic(self):
        n = self.bic_table.rowCount()
        b = np.zeros((n, n))
        for i in range(n):
            for j in range(i):
                it = self.bic_table.item(i, j)
                t = it.text().strip() if it else ""
                b[i, j] = b[j, i] = _num(t, f"BIC({i + 1},{j + 1})") if t else 0.0
        return b

    def _add_component(self):
        old = self._bic()
        n = self.comp_table.rowCount()
        self._append_component_row([f"X{n + 1}", 300.0, 40.0, 0.1, 50.0, 0.0, 0.0])
        new = np.zeros((n + 1, n + 1))
        new[:n, :n] = old
        self._set_bic(new)

    def _remove_component(self):
        n = self.comp_table.rowCount()
        if n <= 2:
            return
        r = self.comp_table.currentRow()
        r = n - 1 if r < 0 else r
        old = self._bic()
        self.comp_table.removeRow(r)
        keep = [i for i in range(n) if i != r]
        self._set_bic(old[np.ix_(keep, keep)])

    def _components(self):
        comps = []
        for r in range(self.comp_table.rowCount()):
            txt = [(self.comp_table.item(r, c).text().strip() if self.comp_table.item(r, c) else "")
                   for c in range(7)]
            if not txt[0]:
                raise ValueError(f"Component {r + 1}: name missing")
            vals = [_num(t, f"Component {txt[0]}") for t in txt[1:]]
            comps.append(dg.Component(txt[0].upper(), *vals))
        return comps

    # ------------------------------------------------------------------ spec <-> widgets
    def set_spec(self, s: dg.DeckSpec):
        """Populate all fields from a DeckSpec."""
        self._loading = True
        try:
            self._units = s.units.upper()
            self.units.setCurrentText(self._units)
            self.case_name.setText(s.case_name)
            self.title.setText(s.title)
            self.start.setDate(QDate(s.start.year, s.start.month, s.start.day))
            self.nx.setValue(s.nx)
            self.ny.setValue(s.ny)
            self.nz.setValue(s.nz)
            self.dx.setText(str(s.dx))
            self.dy.setText(str(s.dy))
            self.dz.setText(str(s.dz))
            self.top.setValue(s.top)
            self.poro.setText(str(s.poro))
            self.permx.setText(str(s.permx))
            self.permy.setText(str(s.permy))
            self.permz.setText(str(s.permz))
            self.rock_pref.setValue(s.rock_pref)
            self.rock_comp.setValue(s.rock_comp)
            idx = self.fluid.findData(s.fluid)
            self.fluid.setCurrentIndex(idx)
            self.fluid_stack.setCurrentIndex(idx)
            self._set_fluid_tables(s)
            for k, sp in self.corey.items():
                sp.setValue(getattr(s.corey, k))
            self.corey_rows.setValue(s.corey.nrows)
            self.datum.setValue(s.datum)
            self.datum_p.setValue(s.datum_pressure)
            self.woc.setValue(s.woc)
            self.goc.setValue(s.goc)
            self.wells.set_wells(s.wells)
            self.total_time.setValue(s.total_time)
            self.report_step.setValue(s.report_step)
            self.summary.setText(" ".join(s.summary))
        finally:
            self._loading = False
        self.goc.setEnabled(s.fluid == dg.FLUID_BLACKOIL)
        self._refresh_unit_labels()
        self._update_scal_preview()

    def _set_fluid_tables(self, s: dg.DeckSpec):
        self.pvtw.set_rows([s.pvtw])
        self.density.set_rows([s.density])
        self.pvdo.set_rows(s.pvdo)
        self.pvto.set_rows(pvto_to_rows(s.pvto))
        self.pvdg.set_rows(s.pvdg)
        if s.components:
            self._set_components(s.components, s.bic)
        elif self.comp_table.rowCount() == 0:
            d = dg.default_spec(dg.FLUID_COMPOSITIONAL, s.units)
            self._set_components(d.components, d.bic)
        self.rtemp.setValue(s.rtemp)
        self.stc_t.setValue(s.stcond[0])
        self.stc_p.setValue(s.stcond[1])

    def _corey_params(self):
        p = dg.CoreyParams(**{k: sp.value() for k, sp in self.corey.items()})
        p.nrows = self.corey_rows.value()
        return p

    def get_spec(self) -> dg.DeckSpec:
        """Collect a DeckSpec from the form. Raises ValueError with a readable message."""
        fluid = self.fluid.currentData()
        qd = self.start.date()
        case = self.case_name.text().strip().upper().replace(" ", "_") or "CASE"
        pvtw = self.pvtw.rows()
        dens = self.density.rows()
        if len(pvtw) != 1 or len(pvtw[0]) != 5:
            raise ValueError("PVTW needs one row of 5 values")
        if len(dens) != 1:
            raise ValueError("DENSITY needs one row of 3 values")
        s = dg.DeckSpec(
            case_name=case, title=self.title.text().strip() or case, units=self._units,
            start=_dt.date(qd.year(), qd.month(), qd.day()),
            nx=self.nx.value(), ny=self.ny.value(), nz=self.nz.value(),
            dx=self.dx.text(), dy=self.dy.text(), dz=self.dz.text(), top=self.top.value(),
            poro=self.poro.text(), permx=self.permx.text(), permy=self.permy.text(), permz=self.permz.text(),
            rock_pref=self.rock_pref.value(), rock_comp=self.rock_comp.value(), fluid=fluid,
            pvtw=pvtw[0], density=dens[0], corey=self._corey_params(),
            datum=self.datum.value(), datum_pressure=self.datum_p.value(), woc=self.woc.value(),
            goc=self.goc.value(), wells=self.wells.wells(), total_time=self.total_time.value(),
            report_step=self.report_step.value(),
            summary=[k.upper() for k in self.summary.text().replace(",", " ").split()],
            rtemp=self.rtemp.value(), stcond=(self.stc_t.value(), self.stc_p.value()))
        # tables of the inactive fluid types are kept but not validated strictly
        if fluid == dg.FLUID_DEADOIL:
            s.pvdo = self.pvdo.rows()
            if len(s.pvdo) < 2:
                raise ValueError("PVDO needs at least 2 rows")
        elif fluid == dg.FLUID_BLACKOIL:
            s.pvto = rows_to_pvto(self.pvto.rows())
            s.pvdg = self.pvdg.rows()
            if len(s.pvto) < 2 or len(s.pvdg) < 2:
                raise ValueError("PVTO and PVDG need at least 2 rows each")
        else:
            s.components = self._components()
            s.bic = self._bic()
        return s

    # ------------------------------------------------------------------ reactions
    def _on_units_changed(self, new):
        if self._loading or new == self._units:
            return
        try:
            spec = self._collect_lenient()
        except ValueError as exc:
            QMessageBox.warning(self, "Units", f"Cannot convert the current values:\n{exc}")
            self._units = new
            self._refresh_unit_labels()
            return
        self.set_spec(dg.convert_spec(spec, new))
        self.statusMessage.emit(f"Converted model-builder values to {new} units")

    def _collect_lenient(self):
        """Like get_spec but also collects the tables of all fluid types (for unit conversion)."""
        s = self.get_spec()
        try:
            s.pvdo = self.pvdo.rows()
            s.pvto = rows_to_pvto(self.pvto.rows())
            s.pvdg = self.pvdg.rows()
            s.components = self._components()
            s.bic = self._bic()
        except ValueError:
            pass
        return s

    def _on_fluid_changed(self, idx):
        self.fluid_stack.setCurrentIndex(idx)
        if self._loading:
            return
        self._load_fluid_defaults()

    def _load_fluid_defaults(self):
        """Load default PVT tables (and initial pressure) of the selected fluid type."""
        fluid = self.fluid.currentData()
        d = dg.default_spec(fluid, self._units)
        self._loading = True
        try:
            self._set_fluid_tables(d)
            self.datum_p.setValue(d.datum_pressure)
            if fluid == dg.FLUID_DEADOIL:
                self.wells.force_phase("WATER")
        finally:
            self._loading = False
        self.goc.setEnabled(fluid == dg.FLUID_BLACKOIL)
        self.statusMessage.emit(f"Loaded default PVT data for {dg.FLUID_TYPES[fluid]}")

    def reset_defaults(self):
        fluid = self.fluid.currentData()
        self.set_spec(dg.default_spec(fluid, self._units))

    def _update_scal_preview(self, *_):
        if self._loading or not hasattr(self, "scal_fig"):
            return
        self.scal_fig.clear()
        ax1 = self.scal_fig.add_subplot(1, 2, 1)
        ax2 = self.scal_fig.add_subplot(1, 2, 2)
        try:
            p = self._corey_params()
            wo = dg.corey_swof(p)
            go = dg.corey_sgof(p)
        except ValueError as exc:
            ax1.text(0.5, 0.5, str(exc), ha="center", va="center", transform=ax1.transAxes, color="red")
            self.scal_canvas.draw_idle()
            return
        ax1.plot(wo[:, 0], wo[:, 1], "b.-", label="krw")
        ax1.plot(wo[:, 0], wo[:, 2], "g.-", label="krow")
        ax1.set_xlabel("Sw")
        ax1.set_title("SWOF")
        ax2.plot(go[:, 0], go[:, 1], "r.-", label="krg")
        ax2.plot(go[:, 0], go[:, 2], "g.-", label="krog")
        ax2.set_xlabel("Sg")
        ax2.set_title("SGOF")
        for ax in (ax1, ax2):
            ax.set_xlim(0, 1)
            ax.set_ylim(0, 1.02)
            ax.grid(alpha=0.3)
            ax.legend(fontsize=8)
        self.scal_canvas.draw_idle()

    # ------------------------------------------------------------------ generate
    def generate_text(self) -> str:
        """Deck text for the current form contents (raises ValueError on bad input)."""
        return dg.generate_deck(self.get_spec())

    def _on_generate(self):
        try:
            spec = self.get_spec()
            text = dg.generate_deck(spec)
        except ValueError as exc:
            QMessageBox.warning(self, "Generate deck", str(exc))
            return
        self.deckGenerated.emit(text, spec.case_name)
        self.statusMessage.emit(f"Generated deck for case {spec.case_name}")
