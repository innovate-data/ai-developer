"""Syntax highlighter for ECLIPSE decks (.DATA).

Highlights section names, known keywords, other keyword-like words at the
start of a line (e.g. SUMMARY vectors), quoted strings, numbers and repeat
counts, record terminators ``/`` and comments (``--`` and anything after a
terminating ``/`` on the same line).
"""
from __future__ import annotations

import re

from PyQt5.QtGui import QColor, QFont, QSyntaxHighlighter, QTextCharFormat

from ..deck.keywords import SECTIONS, is_known_keyword

_WORD_AT_START = re.compile(r"^\s*([A-Za-z][A-Za-z0-9_+\-]{0,7})\s*(?:--.*)?$")
_STRING = re.compile(r"'[^']*'?|\"[^\"]*\"?")
_NUMBER = re.compile(r"(?<![A-Za-z_\d.])(\d+\*)?[-+]?(\d+\.?\d*|\.\d+)([eEdD][-+]?\d+)?(?![A-Za-z_\d])|"
                     r"(?<![A-Za-z_\d])\d+\*(?![\d.])")


def _fmt(color, bold=False, italic=False):
    f = QTextCharFormat()
    f.setForeground(QColor(color))
    if bold:
        f.setFontWeight(QFont.Bold)
    if italic:
        f.setFontItalic(True)
    return f


class EclipseHighlighter(QSyntaxHighlighter):
    """QSyntaxHighlighter for ECLIPSE keyword syntax."""

    def __init__(self, document, dark: bool = False):
        super().__init__(document)
        if dark:
            self.f_section = _fmt("#ff7b72", bold=True)
            self.f_keyword = _fmt("#79c0ff", bold=True)
            self.f_other = _fmt("#d2a8ff", bold=True)
            self.f_string = _fmt("#a5d6ff")
            self.f_number = _fmt("#ffa657")
            self.f_slash = _fmt("#ff7b72", bold=True)
            self.f_comment = _fmt("#8b949e", italic=True)
        else:
            self.f_section = _fmt("#b31d28", bold=True)
            self.f_keyword = _fmt("#0550ae", bold=True)
            self.f_other = _fmt("#6f42c1", bold=True)
            self.f_string = _fmt("#0a7b25")
            self.f_number = _fmt("#953800")
            self.f_slash = _fmt("#cf222e", bold=True)
            self.f_comment = _fmt("#6e7781", italic=True)

    def highlightBlock(self, text: str):  # noqa: N802 (Qt API)
        # comment start: '--' outside quotes, or text after a terminating '/'
        comment_at = self._comment_start(text)
        code = text[:comment_at]

        m = _WORD_AT_START.match(code)
        if m:
            word = m.group(1).upper()
            if word in SECTIONS or word == "END":
                self.setFormat(m.start(1), len(m.group(1)), self.f_section)
            elif is_known_keyword(word):
                self.setFormat(m.start(1), len(m.group(1)), self.f_keyword)
            elif word == m.group(1) and not word.isdigit():
                self.setFormat(m.start(1), len(m.group(1)), self.f_other)
        else:
            strings = []
            for s in _STRING.finditer(code):
                self.setFormat(s.start(), s.end() - s.start(), self.f_string)
                strings.append((s.start(), s.end()))
            for n in _NUMBER.finditer(code):
                if not any(a <= n.start() < b for a, b in strings):
                    self.setFormat(n.start(), n.end() - n.start(), self.f_number)
            idx = code.find("/")
            while idx >= 0:
                if not any(a <= idx < b for a, b in strings):
                    self.setFormat(idx, 1, self.f_slash)
                idx = code.find("/", idx + 1)
        if comment_at < len(text):
            self.setFormat(comment_at, len(text) - comment_at, self.f_comment)

    @staticmethod
    def _comment_start(text: str) -> int:
        quote = None
        i, n = 0, len(text)
        while i < n:
            c = text[i]
            if quote:
                if c == quote:
                    quote = None
            elif c in "'\"":
                quote = c
            elif text.startswith("--", i):
                return i
            elif c == "/":
                return i + 1      # the slash itself is code, the rest is comment
            i += 1
        return n
