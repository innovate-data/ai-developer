"""Run tab: simulation options, Run/Stop, progress, elapsed time and a log console.

The simulation runs in a `QThread` (`SimulationWorker`).  Progress and log
callbacks from `resim.simulator.run_simulation` are marshalled back to the GUI
thread through Qt signals; Stop sets a flag polled by the `should_stop`
callback, which makes the simulator raise `SimulationAborted`.
"""
from __future__ import annotations

import dataclasses
import os
import tempfile
import threading
import time
import traceback

from PyQt5.QtCore import QObject, Qt, QThread, QTimer, pyqtSignal, pyqtSlot
from PyQt5.QtGui import QFontDatabase, QTextCursor
from PyQt5.QtWidgets import (QCheckBox, QComboBox, QFormLayout, QGroupBox, QHBoxLayout,
                             QLabel, QPlainTextEdit, QProgressBar, QPushButton, QSpinBox, QVBoxLayout,
                             QWidget)

from .widgets import SciSpinBox

# Defaults of resim.simulator.SimOptions (used when the simulator is not importable yet)
OPTION_DEFAULTS = {"max_dt_days": 30.0, "min_dt_days": 1e-4, "initial_dt_days": 1.0, "newton_tol": 1e-3,
                   "max_newton": 15, "linear_solver": "direct"}
LINEAR_SOLVERS = ["direct", "iterative"]


def results_paths(deck_path: str):
    """(<CASE>.resim.npz, <CASE>_summary.csv) next to the deck."""
    base = os.path.splitext(os.path.abspath(deck_path))[0]
    return base + ".resim.npz", base + "_summary.csv"


class SimulationWorker(QObject):
    """Runs `run_simulation` in a worker thread. Emits exactly one of finished/failed/aborted."""

    progress = pyqtSignal(float, str)
    log = pyqtSignal(str)
    finished = pyqtSignal(object)          # Results
    failed = pyqtSignal(str)
    aborted = pyqtSignal()

    def __init__(self, deck_path, options: dict, runner=None):
        super().__init__()
        self.deck_path = deck_path
        self.options = options
        self.runner = runner               # injectable for tests: runner(deck, options, progress, log, should_stop)
        self._stop = threading.Event()

    def stop(self):
        self._stop.set()

    @pyqtSlot()
    def run(self):
        try:
            if self.runner is not None:
                results = self.runner(self.deck_path, self.options, self.progress.emit, self.log.emit,
                                      self._stop.is_set)
            else:
                from ..simulator import SimOptions, run_simulation
                names = {f.name for f in dataclasses.fields(SimOptions)}
                opts = SimOptions(**{k: v for k, v in self.options.items() if k in names})
                results = run_simulation(self.deck_path, options=opts,
                                         progress=lambda f, m="": self.progress.emit(float(f), str(m)),
                                         log=lambda t: self.log.emit(str(t)),
                                         should_stop=self._stop.is_set)
        except Exception as exc:  # noqa: BLE001
            if type(exc).__name__ == "SimulationAborted" or self._stop.is_set():
                self.aborted.emit()
            else:
                self.log.emit(traceback.format_exc())
                self.failed.emit(f"{type(exc).__name__}: {exc}")
            return
        self.finished.emit(results)


class RunPanel(QWidget):
    """Run tab.  `deck_editor` provides the deck path/text; emits `resultsReady(results, npz_path)`."""

    resultsReady = pyqtSignal(object, str)
    statusMessage = pyqtSignal(str)
    runningChanged = pyqtSignal(bool)

    def __init__(self, deck_editor, parent=None):
        super().__init__(parent)
        self.editor = deck_editor
        self.runner = None                 # optional override of the simulator call (tests)
        self._thread = None
        self._worker = None
        self._t0 = 0.0
        self._deck_path = ""

        self.deck_label = QLabel()
        self.deck_label.setTextInteractionFlags(Qt.TextSelectableByMouse)
        self.deck_label.setWordWrap(True)

        opts = QGroupBox("Simulation options (SimOptions)")
        f = QFormLayout(opts)
        self.max_dt = self._dspin(OPTION_DEFAULTS["max_dt_days"], 1e-4, 1e5, 4)
        self.min_dt = self._dspin(OPTION_DEFAULTS["min_dt_days"], 1e-8, 1e3, step=0)
        self.init_dt = self._dspin(OPTION_DEFAULTS["initial_dt_days"], 1e-6, 1e4, 6)
        self.newton_tol = self._dspin(OPTION_DEFAULTS["newton_tol"], 1e-10, 1.0, step=0)
        self.max_newton = QSpinBox()
        self.max_newton.setRange(1, 200)
        self.max_newton.setValue(OPTION_DEFAULTS["max_newton"])
        self.linear_solver = QComboBox()
        self.linear_solver.setEditable(True)
        self.linear_solver.addItems(LINEAR_SOLVERS)
        f.addRow("Max time step [days]", self.max_dt)
        f.addRow("Min time step [days]", self.min_dt)
        f.addRow("Initial time step [days]", self.init_dt)
        f.addRow("Newton tolerance", self.newton_tol)
        f.addRow("Max Newton iterations", self.max_newton)
        f.addRow("Linear solver", self.linear_solver)
        self.autosave = QCheckBox("Save unsaved editor changes to the deck file before running")
        self.autosave.setChecked(True)
        self.autosave.setToolTip("If unchecked, the edited text is written to a temporary deck next to the "
                                 "original file (so INCLUDE paths still resolve)")
        f.addRow(self.autosave)
        self.advanced = {}
        adv = self._build_advanced()

        self.btn_run = QPushButton("▶  Run")
        self.btn_run.setStyleSheet("font-weight: bold; padding: 6px 18px;")
        self.btn_stop = QPushButton("■  Stop")
        self.btn_stop.setEnabled(False)
        self.btn_run.clicked.connect(lambda: self.start())
        self.btn_stop.clicked.connect(self.stop)
        self.progress = QProgressBar()
        self.progress.setRange(0, 1000)
        self.progress.setFormat("%p%")
        self.progress_msg = QLabel("Idle")
        self.elapsed = QLabel("Elapsed: 0:00")

        self.console = QPlainTextEdit()
        self.console.setReadOnly(True)
        self.console.setMaximumBlockCount(20000)
        font = QFontDatabase.systemFont(QFontDatabase.FixedFont)
        self.console.setFont(font)
        btn_clear = QPushButton("Clear log")
        btn_clear.clicked.connect(self.console.clear)

        top = QHBoxLayout()
        left = QVBoxLayout()
        dl = QGroupBox("Deck")
        dll = QVBoxLayout(dl)
        dll.addWidget(self.deck_label)
        left.addWidget(dl)
        left.addWidget(opts)
        if adv is not None:
            left.addWidget(adv)
        left.addStretch(1)
        top.addLayout(left, 2)
        right = QVBoxLayout()
        bl = QHBoxLayout()
        bl.addWidget(self.btn_run)
        bl.addWidget(self.btn_stop)
        bl.addStretch(1)
        bl.addWidget(self.elapsed)
        right.addLayout(bl)
        right.addWidget(self.progress)
        right.addWidget(self.progress_msg)
        lh = QHBoxLayout()
        lh.addWidget(QLabel("Log:"))
        lh.addStretch(1)
        lh.addWidget(btn_clear)
        right.addLayout(lh)
        right.addWidget(self.console, 1)
        top.addLayout(right, 3)
        self.setLayout(top)

        self._timer = QTimer(self)
        self._timer.setInterval(500)
        self._timer.timeout.connect(self._tick)
        self.editor.pathChanged.connect(lambda *_: self.update_deck_label())
        self.editor.modifiedChanged.connect(lambda *_: self.update_deck_label())
        self.update_deck_label()

    def _build_advanced(self):
        """Spin boxes for any further SimOptions fields (discovered from the dataclass)."""
        try:
            from ..simulator import SimOptions
            fields = dataclasses.fields(SimOptions)
        except Exception:  # noqa: BLE001 - simulator not available
            return None
        extra = [f for f in fields if f.name not in OPTION_DEFAULTS]
        if not extra:
            return None
        box = QGroupBox("Advanced options")
        f = QFormLayout(box)
        for fld in extra:
            default = fld.default if fld.default is not dataclasses.MISSING else None
            if isinstance(default, bool):
                w = QCheckBox()
                w.setChecked(default)
            elif isinstance(default, int):
                w = QSpinBox()
                w.setRange(-10 ** 9, 10 ** 9)
                w.setValue(default)
            elif isinstance(default, float):
                w = self._dspin(default, -1e12, 1e12, step=0.1 * abs(default) if default else 0.1)
            else:
                continue
            self.advanced[fld.name] = w
            f.addRow(fld.name, w)
        return box if self.advanced else None

    @staticmethod
    def _dspin(value, lo, hi, decimals=None, step=1.0):
        return SciSpinBox(value, lo, hi, step)

    # ------------------------------------------------------------------ state
    def is_running(self):
        return self._thread is not None

    def options(self) -> dict:
        """SimOptions keyword arguments from the widgets."""
        opts = {"max_dt_days": self.max_dt.value(), "min_dt_days": self.min_dt.value(),
                "initial_dt_days": self.init_dt.value(), "newton_tol": self.newton_tol.value(),
                "max_newton": self.max_newton.value(), "linear_solver": self.linear_solver.currentText().strip()}
        for name, w in self.advanced.items():
            opts[name] = w.isChecked() if isinstance(w, QCheckBox) else w.value()
        return opts

    def update_deck_label(self):
        p = self.editor.path
        if not p and not self.editor.text().strip():
            self.deck_label.setText("<i>No deck loaded. Open a deck or generate one in the Model builder.</i>")
        else:
            mod = " <span style='color:#b36b00'>(unsaved changes)</span>" if self.editor.is_modified() else ""
            self.deck_label.setText((p or "<i>untitled deck</i>") + mod)

    def append_log(self, text):
        self.console.appendPlainText(text.rstrip("\n"))
        self.console.moveCursor(QTextCursor.End)

    # ------------------------------------------------------------------ deck preparation
    def prepare_deck(self, interactive=True):
        """Return the deck path to simulate, saving editor changes as needed (None = cancelled)."""
        ed = self.editor
        if not ed.text().strip():
            self.statusMessage.emit("Nothing to run: the deck editor is empty")
            return None
        if not ed.path:
            if interactive and ed.save_as():
                return ed.path
            # fall back to a temporary directory (or next to the example the text came from)
            d = ed.default_dir if ed.default_dir and os.access(ed.default_dir, os.W_OK) else \
                tempfile.mkdtemp(prefix="resim_")
            path = os.path.join(d, ed._guess_case() + ".DATA")
            with open(path, "w") as fh:
                fh.write(ed.text())
            self.append_log(f"Untitled deck written to {path}")
            return path
        if ed.is_modified():
            if self.autosave.isChecked():
                if not ed.save_to(ed.path):
                    return None
                self.append_log(f"Saved {ed.path}")
            else:
                base, ext = os.path.splitext(ed.path)
                path = base + "_run" + (ext or ".DATA")
                with open(path, "w") as fh:
                    fh.write(ed.text())
                self.append_log(f"Unsaved changes written to {path}")
                return path
        return ed.path

    # ------------------------------------------------------------------ run control
    def start(self, deck_path=None, interactive=True):
        """Start a simulation of `deck_path` (default: the editor's deck). Returns True if started."""
        if self.is_running():
            return False
        path = deck_path or self.prepare_deck(interactive)
        if not path:
            return False
        self._deck_path = os.path.abspath(path)
        self.progress.setValue(0)
        self.progress_msg.setText("Starting...")
        self.append_log(f"=== Running {self._deck_path} ===")
        self.append_log("Options: " + ", ".join(f"{k}={v}" for k, v in self.options().items()))
        self._worker = SimulationWorker(self._deck_path, self.options(), self.runner)
        self._thread = QThread(self)
        self._worker.moveToThread(self._thread)
        self._thread.started.connect(self._worker.run)
        self._worker.progress.connect(self._on_progress)
        self._worker.log.connect(self.append_log)
        self._worker.finished.connect(self._on_finished)
        self._worker.failed.connect(self._on_failed)
        self._worker.aborted.connect(self._on_aborted)
        self._t0 = time.monotonic()
        self._timer.start()
        self._set_running(True)
        self._thread.start()
        self.statusMessage.emit(f"Simulation started: {os.path.basename(self._deck_path)}")
        return True

    def stop(self):
        if self._worker is not None:
            self._worker.stop()
            self.progress_msg.setText("Stopping...")
            self.append_log("Stop requested")

    def wait(self, msecs=60000):
        """Block until the worker thread ends (used by tests/close)."""
        if self._thread is not None:
            self._thread.wait(msecs)

    def _set_running(self, running):
        self.btn_run.setEnabled(not running)
        self.btn_stop.setEnabled(running)
        self.runningChanged.emit(running)

    def _cleanup(self):
        self._timer.stop()
        self._tick()
        if self._thread is not None:
            self._thread.quit()
            self._thread.wait()
            self._thread.deleteLater()
        if self._worker is not None:
            self._worker.deleteLater()
        self._thread = self._worker = None
        self._set_running(False)

    def _tick(self):
        s = int(time.monotonic() - self._t0) if self._t0 else 0
        self.elapsed.setText(f"Elapsed: {s // 3600}:{s // 60 % 60:02d}:{s % 60:02d}" if s >= 3600
                             else f"Elapsed: {s // 60}:{s % 60:02d}")

    def _on_progress(self, fraction, message):
        self.progress.setValue(int(round(max(0.0, min(1.0, fraction)) * 1000)))
        if message:
            self.progress_msg.setText(message)

    def _on_finished(self, results):
        self._cleanup()
        self.progress.setValue(1000)
        npz, csv = results_paths(self._deck_path)
        try:
            results.save(npz)
            results.summary_to_csv(csv)
            self.append_log(f"Results saved to {npz}\nSummary CSV saved to {csv}")
        except Exception as exc:  # noqa: BLE001
            self.append_log(f"Could not save results: {exc}")
            npz = ""
        self.progress_msg.setText("Finished")
        self.statusMessage.emit(f"Simulation finished in {self.elapsed.text()[9:]}")
        self.resultsReady.emit(results, npz)

    def _on_failed(self, message):
        self._cleanup()
        self.progress_msg.setText("Failed: " + message)
        self.append_log("SIMULATION FAILED: " + message)
        self.statusMessage.emit("Simulation failed")

    def _on_aborted(self):
        self._cleanup()
        self.progress_msg.setText("Stopped by user")
        self.append_log("Simulation stopped by user")
        self.statusMessage.emit("Simulation stopped")
