"""Deck editor tab: code editor with line numbers and ECLIPSE highlighting,
a section/keyword outline, and a validation panel."""
from __future__ import annotations

import os
import re
import traceback
from pathlib import Path

from PyQt5.QtCore import QRect, QSize, Qt, QTimer, pyqtSignal
from PyQt5.QtGui import QColor, QFontDatabase, QPainter, QTextCursor, QTextFormat
from PyQt5.QtWidgets import (QFileDialog, QHBoxLayout, QLabel, QListWidget, QListWidgetItem,
                             QMessageBox, QPlainTextEdit, QPushButton, QSplitter, QTextEdit,
                             QTreeWidget, QTreeWidgetItem, QVBoxLayout, QWidget)

from ..deck.keywords import SECTIONS, is_known_keyword
from ..deck.parser import parse_deck_string, tokenize
from .highlighter import EclipseHighlighter

_KW_RE = re.compile(r"^[A-Z][A-Z0-9_+\-]{0,7}$")
_LINE_RE = re.compile(r"(?:^|[:\s])(\d+):")
DECK_FILTER = "ECLIPSE decks (*.DATA *.data *.INC *.inc);;All files (*)"


# ----------------------------------------------------------------------------
# Code editor with line numbers
# ----------------------------------------------------------------------------
class _LineNumberArea(QWidget):
    def __init__(self, editor):
        super().__init__(editor)
        self.editor = editor

    def sizeHint(self):  # noqa: N802
        return QSize(self.editor.line_number_width(), 0)

    def paintEvent(self, event):  # noqa: N802
        self.editor.paint_line_numbers(event)


class CodeEditor(QPlainTextEdit):
    """QPlainTextEdit with a line-number gutter and current-line highlight."""

    def __init__(self, parent=None):
        super().__init__(parent)
        font = QFontDatabase.systemFont(QFontDatabase.FixedFont)
        font.setPointSize(10)
        self.setFont(font)
        self.setLineWrapMode(QPlainTextEdit.NoWrap)
        self.setTabStopDistance(4 * self.fontMetrics().horizontalAdvance(" "))
        self._gutter = _LineNumberArea(self)
        self.blockCountChanged.connect(self._update_gutter_width)
        self.updateRequest.connect(self._update_gutter)
        self.cursorPositionChanged.connect(self._highlight_current_line)
        self._update_gutter_width()
        self._highlight_current_line()

    def line_number_width(self):
        digits = max(3, len(str(max(1, self.blockCount()))))
        return 10 + self.fontMetrics().horizontalAdvance("9") * digits

    def _update_gutter_width(self, *_):
        self.setViewportMargins(self.line_number_width(), 0, 0, 0)

    def _update_gutter(self, rect, dy):
        if dy:
            self._gutter.scroll(0, dy)
        else:
            self._gutter.update(0, rect.y(), self._gutter.width(), rect.height())
        if rect.contains(self.viewport().rect()):
            self._update_gutter_width()

    def resizeEvent(self, event):  # noqa: N802
        super().resizeEvent(event)
        cr = self.contentsRect()
        self._gutter.setGeometry(QRect(cr.left(), cr.top(), self.line_number_width(), cr.height()))

    def paint_line_numbers(self, event):
        painter = QPainter(self._gutter)
        painter.fillRect(event.rect(), QColor("#f0f0f0"))
        block = self.firstVisibleBlock()
        number = block.blockNumber()
        top = round(self.blockBoundingGeometry(block).translated(self.contentOffset()).top())
        bottom = top + round(self.blockBoundingRect(block).height())
        painter.setPen(QColor("#888888"))
        while block.isValid() and top <= event.rect().bottom():
            if block.isVisible() and bottom >= event.rect().top():
                painter.drawText(0, top, self._gutter.width() - 4, self.fontMetrics().height(),
                                 Qt.AlignRight, str(number + 1))
            block = block.next()
            top = bottom
            bottom = top + round(self.blockBoundingRect(block).height())
            number += 1

    def _highlight_current_line(self):
        sel = QTextEdit.ExtraSelection()
        sel.format.setBackground(QColor("#fff8dc"))
        sel.format.setProperty(QTextFormat.FullWidthSelection, True)
        sel.cursor = self.textCursor()
        sel.cursor.clearSelection()
        self.setExtraSelections([sel])

    def goto_line(self, line: int):
        """Move the cursor to 1-based `line` and centre it."""
        block = self.document().findBlockByNumber(max(0, line - 1))
        if not block.isValid():
            return
        cursor = QTextCursor(block)
        self.setTextCursor(cursor)
        self.centerCursor()
        self.setFocus()


# ----------------------------------------------------------------------------
# Outline extraction (fast, tolerant of incomplete decks)
# ----------------------------------------------------------------------------
def deck_outline(text: str):
    """Return [(section, line, [(keyword, line), ...]), ...] for the deck text.

    Keywords are recognised as an unquoted, keyword-like word that is the only
    token on its line (the ECLIPSE convention).  Keywords before the first
    section are grouped under a pseudo-section "(header)".
    """
    toks = tokenize(text)
    by_line = {}
    for t in toks:
        by_line.setdefault(t.line, []).append(t)
    outline = []
    current = ("(header)", 1, [])
    skip_next = False
    for line in sorted(by_line):
        ts = by_line[line]
        if skip_next:
            skip_next = False
            continue
        first = ts[0]
        if first.quoted or first.slash:
            continue
        word = first.text.upper()
        if not _KW_RE.match(word) or len(ts) != 1 or first.text != word:
            continue
        if word in SECTIONS:
            if current[2] or current[0] != "(header)":
                outline.append(current)
            current = (word, line, [])
        else:
            current[2].append((word, line))
            if word == "TITLE":
                skip_next = True
    if current[2] or current[0] != "(header)":
        outline.append(current)
    return outline


# ----------------------------------------------------------------------------
# Deck editor widget
# ----------------------------------------------------------------------------
class DeckEditor(QWidget):
    """Editor tab. Emits `pathChanged(str)` and `statusMessage(str)`."""

    pathChanged = pyqtSignal(str)
    modifiedChanged = pyqtSignal(bool)
    statusMessage = pyqtSignal(str)

    def __init__(self, parent=None):
        super().__init__(parent)
        self.path = ""
        self.default_dir = ""          # base directory for untitled decks (e.g. the examples folder)
        self.editor = CodeEditor()
        self.highlighter = EclipseHighlighter(self.editor.document())

        self.outline = QTreeWidget()
        self.outline.setHeaderLabels(["Section / keyword", "Line"])
        self.outline.setColumnWidth(0, 170)
        self.outline.itemActivated.connect(self._outline_clicked)
        self.outline.itemClicked.connect(self._outline_clicked)

        self.messages = QListWidget()
        self.messages.itemActivated.connect(self._message_clicked)
        self.messages.itemClicked.connect(self._message_clicked)

        btn_validate = QPushButton("Validate")
        btn_validate.setToolTip("Parse the deck and build the simulation model to check for errors")
        btn_validate.clicked.connect(self.validate)
        self.file_label = QLabel("(untitled)")
        self.file_label.setTextInteractionFlags(Qt.TextSelectableByMouse)

        top = QHBoxLayout()
        top.addWidget(QLabel("File:"))
        top.addWidget(self.file_label, 1)
        top.addWidget(btn_validate)

        right = QSplitter(Qt.Vertical)
        right.addWidget(self.editor)
        msg_box = QWidget()
        ml = QVBoxLayout(msg_box)
        ml.setContentsMargins(0, 0, 0, 0)
        ml.addWidget(QLabel("Validation messages (click to jump to line):"))
        ml.addWidget(self.messages)
        right.addWidget(msg_box)
        right.setSizes([600, 140])

        split = QSplitter(Qt.Horizontal)
        split.addWidget(self.outline)
        split.addWidget(right)
        split.setSizes([250, 900])

        lay = QVBoxLayout(self)
        lay.addLayout(top)
        lay.addWidget(split, 1)

        self._outline_timer = QTimer(self)
        self._outline_timer.setSingleShot(True)
        self._outline_timer.setInterval(600)
        self._outline_timer.timeout.connect(self.refresh_outline)
        self.editor.textChanged.connect(self._outline_timer.start)
        self.editor.document().modificationChanged.connect(self._on_modified)

    # ----------------------------------------------------------------- state
    def text(self) -> str:
        return self.editor.toPlainText()

    def is_modified(self) -> bool:
        return self.editor.document().isModified()

    def base_dir(self) -> str:
        """Directory used to resolve INCLUDEs: the deck's folder, else `default_dir`, else the cwd."""
        if self.path:
            return os.path.dirname(self.path)
        return self.default_dir if self.default_dir and os.path.isdir(self.default_dir) else os.getcwd()

    def set_text(self, text: str, path: str = "", modified: bool = False):
        """Replace the editor contents; `path` becomes the current file ('' = untitled)."""
        self.editor.setPlainText(text)
        self.path = path
        self.editor.document().setModified(modified)
        self._update_label()
        self.refresh_outline()
        self.messages.clear()
        self.pathChanged.emit(path)

    def _on_modified(self, mod):
        self._update_label()
        self.modifiedChanged.emit(mod)

    def _update_label(self):
        name = self.path or "(untitled)"
        self.file_label.setText(name + (" *" if self.is_modified() else ""))

    # ----------------------------------------------------------------- file IO
    def open_file(self, path: str) -> bool:
        try:
            with open(path, "r", errors="replace") as fh:
                text = fh.read()
        except OSError as exc:
            QMessageBox.critical(self, "Open deck", f"Cannot open {path}:\n{exc}")
            return False
        self.set_text(text, os.path.abspath(path))
        self.statusMessage.emit(f"Opened {path}")
        return True

    def open_dialog(self):
        path, _ = QFileDialog.getOpenFileName(self, "Open deck", self.base_dir(), DECK_FILTER)
        return self.open_file(path) if path else False

    def save(self) -> bool:
        if not self.path:
            return self.save_as()
        return self.save_to(self.path)

    def save_as(self) -> bool:
        start = self.path or os.path.join(self.base_dir(), self._guess_case() + ".DATA")
        path, _ = QFileDialog.getSaveFileName(self, "Save deck as", start, DECK_FILTER)
        if not path:
            return False
        return self.save_to(path)

    def save_to(self, path: str) -> bool:
        try:
            Path(path).write_text(self.text())
        except OSError as exc:
            QMessageBox.critical(self, "Save deck", f"Cannot write {path}:\n{exc}")
            return False
        self.path = os.path.abspath(path)
        self.editor.document().setModified(False)
        self._update_label()
        self.pathChanged.emit(self.path)
        self.statusMessage.emit(f"Saved {path}")
        return True

    def _guess_case(self) -> str:
        m = re.search(r"^--\s*([A-Za-z0-9_\-]+): generated", self.text(), re.M)
        return m.group(1) if m else "UNTITLED"

    def confirm_discard(self) -> bool:
        """Ask to save unsaved changes. Returns False if the user cancels."""
        if not self.is_modified():
            return True
        r = QMessageBox.question(self, "Unsaved changes", "The deck has unsaved changes. Save them?",
                                 QMessageBox.Save | QMessageBox.Discard | QMessageBox.Cancel)
        if r == QMessageBox.Cancel:
            return False
        if r == QMessageBox.Save:
            return self.save()
        return True

    # ----------------------------------------------------------------- outline
    def refresh_outline(self):
        expanded = {self.outline.topLevelItem(i).text(0) for i in range(self.outline.topLevelItemCount())
                    if self.outline.topLevelItem(i).isExpanded()}
        first = self.outline.topLevelItemCount() == 0
        self.outline.clear()
        try:
            outline = deck_outline(self.text())
        except Exception:  # noqa: BLE001 - outline must never break editing
            return
        for section, line, kws in outline:
            it = QTreeWidgetItem([section, str(line)])
            it.setData(0, Qt.UserRole, line)
            f = it.font(0)
            f.setBold(True)
            it.setFont(0, f)
            for kw, kl in kws:
                child = QTreeWidgetItem([kw, str(kl)])
                child.setData(0, Qt.UserRole, kl)
                if not is_known_keyword(kw) and section != "SUMMARY":
                    child.setForeground(0, QColor("#888888"))
                    child.setToolTip(0, "Keyword not in the parser registry")
                it.addChild(child)
            self.outline.addTopLevelItem(it)
            it.setExpanded(first or section in expanded)

    def _outline_clicked(self, item, _col=0):
        line = item.data(0, Qt.UserRole)
        if line:
            self.editor.goto_line(int(line))

    # ----------------------------------------------------------------- validation
    def validate(self):
        """Parse the deck (and build the model when possible); list warnings/errors."""
        self.messages.clear()
        text = self.text()
        ok = True

        def add(msg, kind="info"):
            item = QListWidgetItem({"error": "ERROR: ", "warning": "Warning: ", "info": ""}[kind] + msg)
            item.setForeground(QColor({"error": "#c00000", "warning": "#b36b00", "info": "#006400"}[kind]))
            self.messages.addItem(item)

        try:
            deck = parse_deck_string(text, self.base_dir())
            if self.path:
                deck.path = self.path
        except Exception as exc:  # noqa: BLE001
            add(f"Parse failed: {exc}", "error")
            self.statusMessage.emit("Deck validation failed")
            return False
        for w in deck.warnings:
            add(w, "warning")
        add(f"Parsed {len(deck.keywords)} keywords")
        try:
            from ..model import load_model
        except Exception:  # noqa: BLE001 - model builder not available
            load_model = None
        if load_model is not None:
            try:
                model = load_model(deck)
                for w in model.warnings:
                    if w not in deck.warnings:
                        add(w, "warning")
                g = model.grid
                add(f"Model OK: {g.nx}x{g.ny}x{g.nz} grid, {model.n_active} active cells, "
                    f"{model.fluid_type}, {len(model.schedule)} report steps")
            except Exception as exc:  # noqa: BLE001
                ok = False
                add(f"Model build failed: {exc}", "error")
                tb = traceback.format_exc().strip().splitlines()
                if tb:
                    add(tb[-1], "error")
        self.statusMessage.emit("Deck is valid" if ok else "Deck has errors")
        return ok

    def _message_clicked(self, item):
        m = _LINE_RE.search(item.text())
        if m:
            self.editor.goto_line(int(m.group(1)))
