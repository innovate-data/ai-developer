"""ECLIPSE deck (.DATA) tokenizer and parser.

The parser understands the general ECLIPSE syntax:

* ``--`` comments, and anything following a terminating ``/`` on the same line
* quoted and unquoted strings, repeat counts (``3*0.25``) and defaults (``2*``)
* ``INCLUDE`` (relative to the including file) and ``PATHS`` aliases
* sections (RUNSPEC, GRID, EDIT, PROPS, REGIONS, SOLUTION, SUMMARY, SCHEDULE)
* the different keyword layouts: flags, single records, arrays, multi-record
  lists terminated by an empty ``/``, numbered tables and PVTO/PVTG style
  tables of records.

Keywords that are not in the registry are parsed heuristically, so decks
containing unsupported keywords still load (the keywords are reported as
unsupported by the model builder).
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from typing import Any, Optional

import numpy as np

from .keywords import SECTIONS, keyword_layout

_KEYWORD_RE = re.compile(r"^[A-Z][A-Z0-9_+\-]{0,7}$")


class DeckError(Exception):
    pass


@dataclass
class Token:
    text: str
    quoted: bool
    line: int
    file: str
    line_start: bool          # first token on its line
    slash: bool = False       # record terminator


@dataclass
class Keyword:
    name: str
    section: str
    data: Any = None           # None | list[list] | np.ndarray | list[np.ndarray] ...
    file: str = ""
    line: int = 0

    def __repr__(self) -> str:  # pragma: no cover - debugging helper
        return f"Keyword({self.name}, section={self.section}, line={self.line})"


@dataclass
class Deck:
    keywords: list = field(default_factory=list)
    path: str = ""
    warnings: list = field(default_factory=list)

    def __iter__(self):
        return iter(self.keywords)

    def __contains__(self, name: str) -> bool:
        return any(k.name == name for k in self.keywords)

    def get(self, name: str, default=None) -> Optional[Keyword]:
        for kw in reversed(self.keywords):
            if kw.name == name:
                return kw
        return default

    def get_all(self, name: str) -> list:
        return [k for k in self.keywords if k.name == name]

    def section(self, section: str) -> list:
        return [k for k in self.keywords if k.section == section]

    @property
    def case_name(self) -> str:
        return os.path.splitext(os.path.basename(self.path))[0] if self.path else "CASE"


# --------------------------------------------------------------------------
# Tokenizer
# --------------------------------------------------------------------------
def tokenize(text: str, filename: str = "<string>") -> list:
    tokens: list[Token] = []
    for lineno, raw in enumerate(text.splitlines(), start=1):
        i, n = 0, len(raw)
        first = True
        while i < n:
            c = raw[i]
            if c in " \t\r,":
                i += 1
                continue
            if raw.startswith("--", i):
                break
            if c == "/":
                tokens.append(Token("/", False, lineno, filename, first, slash=True))
                break  # rest of line after a terminating slash is a comment
            if c in "'\"":
                j = raw.find(c, i + 1)
                if j < 0:
                    j = n
                tokens.append(Token(raw[i + 1:j], True, lineno, filename, first))
                i = j + 1
                first = False
                continue
            j = i
            while j < n and raw[j] not in " \t\r,/'\"":
                if raw.startswith("--", j):
                    break
                j += 1
            tokens.append(Token(raw[i:j], False, lineno, filename, first))
            first = False
            i = j
    return tokens


class _Stream:
    """Token stream supporting INCLUDE via a stack of files."""

    def __init__(self):
        self.stack: list[list] = []   # [tokens, pos]

    def push(self, tokens):
        self.stack.append([tokens, 0])

    def _top(self):
        while self.stack and self.stack[-1][1] >= len(self.stack[-1][0]):
            self.stack.pop()
        return self.stack[-1] if self.stack else None

    def peek(self) -> Optional[Token]:
        top = self._top()
        return top[0][top[1]] if top else None

    def next(self) -> Optional[Token]:
        top = self._top()
        if top is None:
            return None
        tok = top[0][top[1]]
        top[1] += 1
        return tok

    def peek_line(self) -> list:
        """Tokens on the same line as the next token (without consuming)."""
        top = self._top()
        if top is None:
            return []
        toks, pos = top
        line = toks[pos].line
        out = []
        while pos < len(toks) and toks[pos].line == line:
            out.append(toks[pos])
            pos += 1
        return out


# --------------------------------------------------------------------------
# Value helpers
# --------------------------------------------------------------------------
_REPEAT_RE = re.compile(r"^(\d+)\*(.*)$")


def _expand(tok: Token):
    """Expand repeat counts. Returns list of values (None for defaults)."""
    if tok.quoted:
        return [tok.text]
    m = _REPEAT_RE.match(tok.text)
    if m:
        count = int(m.group(1))
        val = m.group(2)
        return [None if val == "" else val] * count
    return [tok.text]


def to_float(value, default=None):
    if value is None:
        return default
    if isinstance(value, (int, float)):
        return float(value)
    try:
        return float(value.replace("D", "E").replace("d", "e"))
    except ValueError as exc:
        raise DeckError(f"Expected a number, got {value!r}") from exc


def to_int(value, default=None):
    if value is None:
        return default
    return int(round(to_float(value)))


def to_str(value, default=None):
    if value is None:
        return default
    return str(value).strip().upper() if not isinstance(value, str) else value.strip()


def rec_get(record, index, default=None):
    """Item `index` (0-based) of a record, or default if missing/defaulted."""
    if record is None or index >= len(record) or record[index] is None:
        return default
    return record[index]


# --------------------------------------------------------------------------
# Parser
# --------------------------------------------------------------------------
class DeckParser:
    def __init__(self):
        self.dims = {"NTSFUN": 1, "NTPVT": 1, "NTEQUL": 1, "NTROCC": None, "NCOMPS": 0}
        self.paths: dict = {}
        self.warnings: list = []

    # public API ------------------------------------------------------------
    def parse_file(self, path: str) -> Deck:
        path = os.path.abspath(path)
        with open(path, "r", errors="replace") as fh:
            text = fh.read()
        deck = self.parse_string(text, filename=path)
        deck.path = path
        return deck

    def parse_string(self, text: str, filename: str = "<string>") -> Deck:
        stream = _Stream()
        stream.push(tokenize(text, filename))
        deck = Deck(path=filename if os.path.isfile(filename) else "")
        section = "RUNSPEC"
        while True:
            tok = stream.next()
            if tok is None:
                break
            if tok.slash:
                continue  # stray slash
            name = tok.text.upper()
            if tok.quoted or not _KEYWORD_RE.match(name):
                self.warnings.append(f"{os.path.basename(tok.file)}:{tok.line}: unexpected token {tok.text!r} skipped")
                continue
            if name in SECTIONS:
                section = name
                deck.keywords.append(Keyword(name, section, None, tok.file, tok.line))
                continue
            if name == "END":
                break
            layout = keyword_layout(name, section)
            data = self._read_data(stream, name, layout, section)
            if name == "INCLUDE":
                inc = self._resolve_include(data, tok.file)
                with open(inc, "r", errors="replace") as fh:
                    stream.push(tokenize(fh.read(), inc))
                continue
            if name == "PATHS":
                for rec in data or []:
                    if len(rec) >= 2:
                        self.paths[str(rec[0])] = str(rec[1])
                continue
            kw = Keyword(name, section, data, tok.file, tok.line)
            deck.keywords.append(kw)
            self._update_dims(kw)
        deck.warnings = self.warnings
        return deck

    # internals ---------------------------------------------------------------
    def _resolve_include(self, data, current_file):
        if not data or not data[0]:
            raise DeckError("INCLUDE without file name")
        fname = str(data[0][0])
        for alias, value in self.paths.items():
            fname = fname.replace("$" + alias, value)
        base = os.path.dirname(current_file)
        if not base or not os.path.isdir(base):
            base = os.getcwd()
        cand = fname if os.path.isabs(fname) else os.path.join(base, fname)
        if not os.path.isfile(cand):
            # case-insensitive fallback (decks written on Windows)
            d = os.path.dirname(cand) or "."
            low = os.path.basename(cand).lower()
            if os.path.isdir(d):
                for f in os.listdir(d):
                    if f.lower() == low:
                        return os.path.join(d, f)
            raise DeckError(f"INCLUDE file not found: {cand}")
        return cand

    def _update_dims(self, kw: Keyword):
        rec = kw.data[0] if isinstance(kw.data, list) and kw.data else None
        if kw.name == "TABDIMS" and rec is not None:
            self.dims["NTSFUN"] = to_int(rec_get(rec, 0), 1)
            self.dims["NTPVT"] = to_int(rec_get(rec, 1), 1)
        elif kw.name == "EQLDIMS" and rec is not None:
            self.dims["NTEQUL"] = to_int(rec_get(rec, 0), 1)
            self.dims["NTTRVD"] = to_int(rec_get(rec, 3), 1)
        elif kw.name == "ROCKCOMP" and rec is not None:
            self.dims["NTROCC"] = to_int(rec_get(rec, 1), None)
        elif kw.name == "COMPS" and rec is not None:
            self.dims["NCOMPS"] = to_int(rec_get(rec, 0), 0)

    def _count(self, spec):
        if isinstance(spec, int):
            return spec
        if spec == "NTROCC":
            return self.dims["NTROCC"] or self.dims["NTPVT"]
        return self.dims.get(spec, 1)

    def _read_record(self, stream) -> list:
        values = []
        while True:
            tok = stream.next()
            if tok is None:
                return values
            if tok.slash:
                return values
            values.extend(_expand(tok))

    def _read_array(self, stream, name) -> np.ndarray:
        rec = self._read_record(stream)
        try:
            return np.array([to_float(v, np.nan) for v in rec], dtype=float)
        except DeckError:
            return np.array(rec, dtype=object)

    def _looks_like_keyword_line(self, stream) -> bool:
        line = stream.peek_line()
        if not line:
            return True
        t = line[0]
        if t.quoted or t.slash:
            return False
        name = t.text.upper()
        if not _KEYWORD_RE.match(name):
            return False
        from .keywords import is_known_keyword
        if is_known_keyword(name):
            return True
        # unknown word: a keyword line normally holds only the keyword itself
        return len(line) == 1

    def _read_data(self, stream, name, layout, section):
        kind = layout[0]
        if kind == "none":
            return None
        if kind == "record":
            return [self._read_record(stream)]
        if kind == "line":               # TITLE: free text on the next line
            line = stream.peek_line()
            for _ in line:
                stream.next()
            return [[t.text for t in line if not t.slash]]
        if kind == "records":           # fixed number of records
            return [self._read_record(stream) for _ in range(self._count(layout[1]))]
        if kind == "array":
            return self._read_array(stream, name)
        if kind == "strings":
            return [str(v) for v in self._read_record(stream)]
        if kind == "tables":             # N numeric tables, each ending with '/'
            n = self._count(layout[1])
            tables = []
            for _ in range(n):
                vals = self._read_record(stream)
                tables.append(np.array([to_float(v, np.nan) for v in vals], dtype=float))
            return tables
        if kind == "table_records":      # PVTO/PVTG: tables of records, each ends with empty '/'
            n = self._count(layout[1])
            tables = []
            for _ in range(n):
                recs = []
                while True:
                    rec = self._read_record(stream)
                    if not rec:
                        break
                    recs.append([to_float(v, np.nan) for v in rec])
                tables.append(recs)
            return tables
        if kind == "multi":              # records until an empty '/'
            recs = []
            while True:
                nxt = stream.peek()
                if nxt is None:
                    break
                if nxt.slash:
                    stream.next()
                    break
                if (nxt.line_start and not nxt.quoted and len(stream.peek_line()) == 1
                        and self._is_registered_other_keyword(nxt, name)):
                    self.warnings.append(f"{name}: missing terminating '/' before {nxt.text}")
                    break
                recs.append(self._read_record(stream))
            return recs
        if kind == "vfp":
            # VFPPROD: header, FLO, THP, WFR, GFR, ALQ axes, then NT*NW*NG*NA rows;
            # VFPINJ: header, FLO, THP axes, then NT rows
            recs = [self._read_record(stream)]
            n_axes = 5 if layout[1] == "VFPPROD" else 2
            for _ in range(n_axes):
                recs.append(self._read_record(stream))
            n_rows = 1
            for ax in recs[2:]:
                n_rows *= max(1, len(ax))
            for _ in range(n_rows):
                recs.append(self._read_record(stream))
            return recs
        if kind == "unknown":
            # Heuristic: keyword without data if the next line is a keyword
            if self._looks_like_keyword_line(stream):
                return None
            recs = []
            while True:
                recs.append(self._read_record(stream))
                nxt = stream.peek()
                if nxt is None:
                    break
                if nxt.slash:             # empty record terminates list
                    stream.next()
                    break
                if self._looks_like_keyword_line(stream):
                    break
            return recs
        raise DeckError(f"Unknown layout {layout} for {name}")

    @staticmethod
    def _is_registered_other_keyword(tok, current):
        from .keywords import is_known_keyword
        name = tok.text.upper()
        return name != current and _KEYWORD_RE.match(name) and is_known_keyword(name) and name not in (
            "OPEN", "SHUT", "STOP", "AUTO", "WATER", "GAS", "OIL", "BHP", "RATE", "RESV", "ORAT",
            "WRAT", "GRAT", "LRAT", "THP", "GRUP", "FIELD", "LIQ", "X", "Y", "Z", "NONE")


def parse_deck(path: str) -> Deck:
    """Parse an ECLIPSE .DATA file (following INCLUDEs)."""
    return DeckParser().parse_file(path)


def parse_deck_string(text: str, base_dir: str | None = None) -> Deck:
    fname = os.path.join(base_dir, "<string>") if base_dir else "<string>"
    parser = DeckParser()
    deck = parser.parse_string(text, filename=fname)
    return deck
