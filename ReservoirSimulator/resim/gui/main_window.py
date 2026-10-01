"""Main window of the ReSim desktop GUI: deck editor, model builder, run panel,
3D viewer and summary plots in tabs."""
from __future__ import annotations

import os
from pathlib import Path

from PyQt5.QtCore import QSettings, Qt
from PyQt5.QtGui import QKeySequence
from PyQt5.QtWidgets import QAction, QApplication, QFileDialog, QMainWindow, QMessageBox, QTabWidget

from .deck_editor import DECK_FILTER, DeckEditor
from .model_builder import ModelBuilder
from .plots import PlotsWidget
from .run_panel import RunPanel
from .viewer3d import Viewer3D

EXAMPLES_DIR = Path(__file__).resolve().parents[2] / "examples"
MAX_RECENT = 10
APP_NAME = "ReSim"


class MainWindow(QMainWindow):
    """Top-level window. Tabs are exposed as attributes: editor, builder, run_panel, viewer, plots."""

    TAB_EDITOR, TAB_BUILDER, TAB_RUN, TAB_VIEWER, TAB_PLOTS = range(5)

    def __init__(self, parent=None, settings: QSettings = None):
        super().__init__(parent)
        self.settings = settings or QSettings(APP_NAME, "ReservoirSimulator")
        self.results = None
        self.results_path = ""

        self.editor = DeckEditor()
        self.builder = ModelBuilder()
        self.run_panel = RunPanel(self.editor)
        self.viewer = Viewer3D()
        self.plots = PlotsWidget()

        self.tabs = QTabWidget()
        self.tabs.addTab(self.editor, "Deck editor")
        self.tabs.addTab(self.builder, "Model builder")
        self.tabs.addTab(self.run_panel, "Run")
        self.tabs.addTab(self.viewer, "3D viewer")
        self.tabs.addTab(self.plots, "Plots")
        self.setCentralWidget(self.tabs)

        for w in (self.editor, self.builder, self.run_panel, self.viewer, self.plots):
            w.statusMessage.connect(self.show_status)
        self.editor.pathChanged.connect(lambda *_: self._update_title())
        self.editor.modifiedChanged.connect(lambda *_: self._update_title())
        self.builder.deckGenerated.connect(self._on_deck_generated)
        self.run_panel.resultsReady.connect(self._on_results_ready)
        self.run_panel.runningChanged.connect(self._on_running_changed)

        self._build_menus()
        self.statusBar().showMessage("Ready")
        self.resize(1400, 900)
        self._update_title()

    # ------------------------------------------------------------------ menus
    def _action(self, text, slot, shortcut=None, tip=None):
        act = QAction(text, self)
        act.triggered.connect(lambda *_: slot())
        if shortcut:
            act.setShortcut(QKeySequence(shortcut))
        if tip:
            act.setStatusTip(tip)
        return act

    def _build_menus(self):
        mb = self.menuBar()
        m = mb.addMenu("&File")
        m.addAction(self._action("&New deck", self.new_deck, QKeySequence.New))
        self.examples_menu = m.addMenu("New from &example")
        self._fill_examples_menu()
        m.addSeparator()
        m.addAction(self._action("&Open deck...", self.open_deck_dialog, QKeySequence.Open))
        m.addAction(self._action("Open &results (.npz)...", self.open_results_dialog, "Ctrl+R"))
        self.recent_menu = m.addMenu("Recent files")
        self._fill_recent_menu()
        m.addSeparator()
        m.addAction(self._action("&Save deck", self.editor.save, QKeySequence.Save))
        m.addAction(self._action("Save deck &as...", self.editor.save_as, QKeySequence.SaveAs))
        m.addSeparator()
        m.addAction(self._action("E&xit", self.close, QKeySequence.Quit))

        m = mb.addMenu("&Simulation")
        self.act_validate = self._action("&Validate deck", self._validate, "F7")
        self.act_run = self._action("&Run", self._run, "F5")
        self.act_stop = self._action("&Stop", self.run_panel.stop, "Shift+F5")
        self.act_stop.setEnabled(False)
        for a in (self.act_validate, self.act_run, self.act_stop):
            m.addAction(a)

        m = mb.addMenu("&View")
        for idx, name in enumerate(["Deck editor", "Model builder", "Run", "3D viewer", "Plots"]):
            m.addAction(self._action(name, lambda i=idx: self.tabs.setCurrentIndex(i), f"Ctrl+{idx + 1}"))

        m = mb.addMenu("&Help")
        m.addAction(self._action("&About", self.about))

    def _fill_examples_menu(self):
        self.examples_menu.clear()
        files = sorted(EXAMPLES_DIR.glob("*.DATA")) + sorted(EXAMPLES_DIR.glob("*.data")) \
            if EXAMPLES_DIR.is_dir() else []
        if not files:
            a = self.examples_menu.addAction("(no examples found)")
            a.setEnabled(False)
        for f in files:
            self.examples_menu.addAction(self._action(f.name, lambda p=str(f): self.new_from_example(p)))

    def _recent(self):
        val = self.settings.value("recent_files", [])
        if isinstance(val, str):
            val = [val]
        return [v for v in (val or []) if v]

    def _add_recent(self, path):
        path = os.path.abspath(path)
        items = [p for p in self._recent() if p != path]
        self.settings.setValue("recent_files", [path] + items[:MAX_RECENT - 1])
        self._fill_recent_menu()

    def _fill_recent_menu(self):
        self.recent_menu.clear()
        items = self._recent()
        if not items:
            a = self.recent_menu.addAction("(empty)")
            a.setEnabled(False)
        for p in items:
            self.recent_menu.addAction(self._action(p, lambda p=p: self.open_path(p)))

    # ------------------------------------------------------------------ actions
    def show_status(self, msg, timeout=8000):
        self.statusBar().showMessage(msg, timeout)

    def _update_title(self):
        p = self.editor.path
        name = os.path.basename(p) if p else "untitled"
        mod = "*" if self.editor.is_modified() else ""
        self.setWindowTitle(f"{APP_NAME} - {name}{mod}")

    def new_deck(self):
        if not self.editor.confirm_discard():
            return
        self.editor.set_text("RUNSPEC\n\nGRID\n\nPROPS\n\nSOLUTION\n\nSUMMARY\n\nSCHEDULE\n\nEND\n")
        self.tabs.setCurrentIndex(self.TAB_EDITOR)

    def new_from_example(self, path):
        """Load an example deck as a new, unsaved document (Save As will ask for a location)."""
        if not self.editor.confirm_discard():
            return
        text = Path(path).read_text(errors="replace")
        self.editor.set_text(text, "", modified=True)
        self.editor.default_dir = os.path.dirname(os.path.abspath(path))
        self.tabs.setCurrentIndex(self.TAB_EDITOR)
        self.show_status(f"New deck from example {os.path.basename(path)} (unsaved)")

    def open_deck_dialog(self):
        if not self.editor.confirm_discard():
            return
        path, _ = QFileDialog.getOpenFileName(self, "Open deck", self.editor.base_dir(), DECK_FILTER)
        if path:
            self.open_deck(path, confirm=False)

    def open_deck(self, path, confirm=True):
        if confirm and not self.editor.confirm_discard():
            return False
        if self.editor.open_file(path):
            self._add_recent(path)
            self.tabs.setCurrentIndex(self.TAB_EDITOR)
            # load existing results of this deck, if any
            from .run_panel import results_paths
            npz = results_paths(path)[0]
            if os.path.isfile(npz) and self.results is None:
                self.open_results(npz, switch=False)
            return True
        return False

    def open_results_dialog(self):
        start = os.path.dirname(self.results_path or self.editor.path or os.getcwd())
        path, _ = QFileDialog.getOpenFileName(self, "Open results", start, "ReSim results (*.npz);;All files (*)")
        if path:
            self.open_results(path)

    def open_results(self, path, switch=True):
        from ..results import Results
        try:
            res = Results.load(path)
        except Exception as exc:  # noqa: BLE001
            QMessageBox.critical(self, "Open results", f"Cannot load {path}:\n{exc}")
            return False
        self.load_results(res, os.path.abspath(path), switch=switch)
        self._add_recent(path)
        return True

    def open_path(self, path):
        """Open a deck or results file depending on its extension."""
        if str(path).lower().endswith(".npz"):
            return self.open_results(path)
        return self.open_deck(path)

    def load_results(self, results, path="", switch=True):
        """Show `results` in the 3D viewer and plots tabs."""
        self.results = results
        self.results_path = path
        label = results.meta.get("case") or (os.path.basename(path).split(".")[0] if path else "results")
        self.viewer.set_results(results, path)
        self.plots.set_results(results, label)
        if switch:
            self.tabs.setCurrentIndex(self.TAB_VIEWER)
        self.show_status(f"Loaded results {label}: {results.n_reports} report steps, "
                         f"{len(results.summary_keys())} summary vectors")

    def _on_deck_generated(self, text, case):
        if not self.editor.confirm_discard():
            return
        self.editor.set_text(text, "", modified=True)
        self.tabs.setCurrentIndex(self.TAB_EDITOR)
        self.show_status(f"Deck for {case} generated - save it (Ctrl+S) and run it from the Run tab")

    def _on_results_ready(self, results, path):
        self.load_results(results, path)
        if path:
            self._add_recent(path)

    def _on_running_changed(self, running):
        self.act_run.setEnabled(not running)
        self.act_stop.setEnabled(running)

    def _validate(self):
        self.tabs.setCurrentIndex(self.TAB_EDITOR)
        self.editor.validate()

    def _run(self):
        self.tabs.setCurrentIndex(self.TAB_RUN)
        self.run_panel.start()

    def about(self):
        QMessageBox.about(self, f"About {APP_NAME}",
                          f"<h3>{APP_NAME} reservoir simulator</h3>"
                          "<p>Black-oil and compositional (Peng-Robinson) reservoir simulation of "
                          "ECLIPSE-format decks.</p>"
                          "<p>Desktop GUI: deck editor, model builder, run control, 3D grid viewer and "
                          "summary plots. Built with PyQt5, matplotlib and (optionally) pyvista.</p>")

    def closeEvent(self, event):  # noqa: N802
        if self.run_panel.is_running():
            r = QMessageBox.question(self, "Simulation running", "A simulation is running. Stop it and exit?")
            if r != QMessageBox.Yes:
                event.ignore()
                return
            self.run_panel.stop()
            self.run_panel.wait(10000)
        if not self.editor.confirm_discard():
            event.ignore()
            return
        event.accept()


def run_app(argv=None):
    """Create the QApplication and main window; open files given on the command line."""
    import sys
    argv = list(sys.argv if argv is None else argv)
    app = QApplication.instance() or QApplication(argv)
    app.setApplicationName(APP_NAME)
    app.setAttribute(Qt.AA_UseHighDpiPixmaps, True)
    win = MainWindow()
    for path in argv[1:]:
        if os.path.exists(path):
            win.open_path(path)
        else:
            win.show_status(f"File not found: {path}")
    win.show()
    return app.exec_()
