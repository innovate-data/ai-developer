"""Well and schedule data structures built from the SCHEDULE section."""
from __future__ import annotations

import copy
import fnmatch
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Optional

import numpy as np

from .deck.parser import rec_get, to_float, to_int, to_str
from .units import ATM, PSI

MONTHS = {m: i + 1 for i, m in enumerate(
    ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "JLY", "AUG", "SEP", "OCT", "NOV", "DEC"])}
MONTHS["JLY"] = 7
MONTHS.update({"AUG": 8, "SEP": 9, "OCT": 10, "NOV": 11, "DEC": 12})

BIG = 1.0e30


@dataclass
class Completion:
    i: int
    j: int
    k: int
    status: str = "OPEN"
    cf: Optional[float] = None          # connection transmissibility factor (SI)
    diameter: float = 0.3048 / 2        # m
    kh: Optional[float] = None          # m3
    skin: float = 0.0
    direction: str = "Z"
    r0: Optional[float] = None
    wi: float = 0.0                     # computed well index (SI, m3)
    cell: int = -1                      # active cell index


@dataclass
class Well:
    name: str
    group: str = "FIELD"
    i: int = 0
    j: int = 0
    ref_depth: Optional[float] = None
    phase: str = "OIL"
    completions: list = field(default_factory=list)
    kind: str = "PROD"                  # PROD or INJ
    status: str = "SHUT"                # OPEN / SHUT / STOP
    control: str = "BHP"
    targets: dict = field(default_factory=dict)   # ORAT WRAT GRAT LRAT RESV BHP (SI)
    inj_type: str = "WATER"
    inj_composition: Optional[np.ndarray] = None
    history: bool = False

    def limit(self, key):
        return self.targets.get(key, None)

    @property
    def is_open(self):
        return self.status == "OPEN" and any(c.status == "OPEN" for c in self.completions)


@dataclass
class ReportStep:
    end_time: float                     # seconds since start
    date: datetime
    wells: dict
    tuning: dict = field(default_factory=dict)


def parse_start(deck):
    kw = deck.get("START")
    if kw is None or not kw.data or not kw.data[0]:
        return datetime(2000, 1, 1)
    return _parse_date(kw.data[0])


def _parse_date(rec):
    day = to_int(rec_get(rec, 0), 1)
    mon = MONTHS.get(str(rec_get(rec, 1, "JAN")).upper()[:3], 1)
    year = to_int(rec_get(rec, 2), 2000)
    t = datetime(year, mon, day)
    hms = rec_get(rec, 3)
    if hms:
        parts = [float(x) for x in str(hms).split(":")]
        t += timedelta(hours=parts[0], minutes=parts[1] if len(parts) > 1 else 0,
                       seconds=parts[2] if len(parts) > 2 else 0)
    return t


class ScheduleBuilder:
    def __init__(self, units, start, warn, ncomps=0):
        self.u = units
        self.start = start
        self.warn = warn
        self.wells: dict = {}
        self.streams: dict = {}
        self.steps: list = []
        self.time = 0.0
        self.tuning: dict = {}
        self.ncomps = ncomps

    # -------------------------------------------------------------- helpers
    def _match(self, pattern):
        pattern = str(pattern)
        names = [n for n in self.wells if fnmatch.fnmatchcase(n.upper(), pattern.upper())]
        if not names:
            self.warn(f"No well matches {pattern!r}")
        return names

    def _num(self, rec, idx, quantity=None, default=None):
        v = rec_get(rec, idx)
        if v is None:
            return default
        x = to_float(v)
        return self.u.to_si(x, quantity) if quantity else x

    def _add_step(self, end_time, date):
        if end_time <= self.time + 1e-6:
            return
        self.steps.append(ReportStep(end_time, date, copy.deepcopy(self.wells), dict(self.tuning)))
        self.time = end_time

    # -------------------------------------------------------------- keywords
    def process(self, kw):
        name, data = kw.name, kw.data
        handler = getattr(self, "_kw_" + name.replace("-", "_"), None)
        if handler is None:
            return False
        handler(data)
        return True

    def _kw_WELSPECS(self, data):
        for rec in data:
            if not rec:
                continue
            name = to_str(rec[0])
            w = self.wells.get(name) or Well(name)
            w.group = to_str(rec_get(rec, 1, "FIELD"))
            w.i = to_int(rec_get(rec, 2), 1) - 1
            w.j = to_int(rec_get(rec, 3), 1) - 1
            w.ref_depth = self._num(rec, 4, "length")
            w.phase = to_str(rec_get(rec, 5, "OIL")).upper()
            self.wells[name] = w

    def _kw_COMPDAT(self, data):
        for rec in data:
            if not rec:
                continue
            for name in self._match(rec[0]):
                w = self.wells[name]
                i = to_int(rec_get(rec, 1), 0) - 1
                j = to_int(rec_get(rec, 2), 0) - 1
                i = w.i if i < 0 else i
                j = w.j if j < 0 else j
                k1 = to_int(rec_get(rec, 3), 1) - 1
                k2 = to_int(rec_get(rec, 4), k1 + 1) - 1
                status = to_str(rec_get(rec, 5, "OPEN")).upper()
                cf = self._num(rec, 7, "transmissibility")
                diam = self._num(rec, 8, "length", 0.3048 / 2 if self.u.name == "FIELD" else 0.15)
                kh = self._num(rec, 9)
                if kh is not None:
                    kh = kh * self.u.to_si(1.0, "perm") * self.u.to_si(1.0, "length")
                skin = self._num(rec, 10, None, 0.0)
                direction = to_str(rec_get(rec, 12, "Z")).upper()
                r0 = self._num(rec, 13, "length")
                for k in range(k1, k2 + 1):
                    # replace an existing connection in the same cell
                    w.completions = [c for c in w.completions if (c.i, c.j, c.k) != (i, j, k)]
                    w.completions.append(Completion(i, j, k, "OPEN" if status == "OPEN" else "SHUT", cf,
                                                    diam, kh, skin, direction, r0))

    def _kw_WCONPROD(self, data):
        for rec in data:
            if not rec:
                continue
            for name in self._match(rec[0]):
                w = self.wells[name]
                w.kind = "PROD"
                w.history = False
                w.status = to_str(rec_get(rec, 1, "OPEN")).upper()
                w.control = to_str(rec_get(rec, 2, "BHP")).upper()
                t = {}
                for key, idx, q in (("ORAT", 3, "liquid_surface_rate"), ("WRAT", 4, "liquid_surface_rate"),
                                    ("GRAT", 5, "gas_surface_rate"), ("LRAT", 6, "liquid_surface_rate"),
                                    ("RESV", 7, "reservoir_rate"), ("BHP", 8, "pressure")):
                    v = self._num(rec, idx, q)
                    if v is not None:
                        t[key] = v
                t.setdefault("BHP", ATM)
                w.targets = t
                if w.control not in t and w.control != "BHP":
                    self.warn(f"WCONPROD {name}: control {w.control} has no target; using BHP")
                    w.control = "BHP"

    def _kw_WCONHIST(self, data):
        for rec in data:
            if not rec:
                continue
            for name in self._match(rec[0]):
                w = self.wells[name]
                w.kind = "PROD"
                w.history = True
                w.status = to_str(rec_get(rec, 1, "OPEN")).upper()
                w.control = to_str(rec_get(rec, 2, "RESV")).upper()
                orat = self._num(rec, 3, "liquid_surface_rate", 0.0)
                wrat = self._num(rec, 4, "liquid_surface_rate", 0.0)
                grat = self._num(rec, 5, "gas_surface_rate", 0.0)
                t = {"ORAT": orat, "WRAT": wrat, "GRAT": grat, "LRAT": orat + wrat,
                     "BHP": self._num(rec, 9, "pressure", ATM)}
                if w.control == "RESV":
                    self.warn(f"WCONHIST {name}: RESV history control approximated by LRAT")
                    w.control = "LRAT"
                w.targets = t

    def _kw_WCONINJE(self, data):
        for rec in data:
            if not rec:
                continue
            for name in self._match(rec[0]):
                w = self.wells[name]
                w.kind = "INJ"
                w.inj_type = to_str(rec_get(rec, 1, "WATER")).upper()
                w.status = to_str(rec_get(rec, 2, "OPEN")).upper()
                w.control = to_str(rec_get(rec, 3, "RATE")).upper()
                q = "gas_surface_rate" if w.inj_type == "GAS" else "liquid_surface_rate"
                t = {}
                v = self._num(rec, 4, q)
                if v is not None:
                    t["RATE"] = v
                v = self._num(rec, 5, "reservoir_rate")
                if v is not None:
                    t["RESV"] = v
                t["BHP"] = self._num(rec, 6, "pressure", 1.0e5 * PSI)
                w.targets = t
                if w.control not in t:
                    w.control = "BHP"

    def _kw_WCONINJH(self, data):
        for rec in data:
            if not rec:
                continue
            for name in self._match(rec[0]):
                w = self.wells[name]
                w.kind = "INJ"
                w.history = True
                w.inj_type = to_str(rec_get(rec, 1, "WATER")).upper()
                w.status = to_str(rec_get(rec, 2, "OPEN")).upper()
                q = "gas_surface_rate" if w.inj_type == "GAS" else "liquid_surface_rate"
                w.targets = {"RATE": self._num(rec, 3, q, 0.0), "BHP": 1.0e5 * PSI}
                w.control = "RATE"

    def _kw_WELOPEN(self, data):
        for rec in data:
            if not rec:
                continue
            status = to_str(rec_get(rec, 1, "OPEN")).upper()
            conn = [rec_get(rec, m) for m in range(2, 5)]
            for name in self._match(rec[0]):
                w = self.wells[name]
                if all(c is None for c in conn):
                    w.status = status
                else:
                    for c in w.completions:
                        ijk = (c.i, c.j, c.k)
                        if all(v is None or to_int(v) - 1 == ijk[m] for m, v in enumerate(conn)):
                            c.status = "OPEN" if status == "OPEN" else "SHUT"

    def _kw_WELTARG(self, data):
        for rec in data:
            if not rec:
                continue
            key = to_str(rec_get(rec, 1)).upper()
            for name in self._match(rec[0]):
                w = self.wells[name]
                if key == "BHP":
                    q = "pressure"
                elif key in ("GRAT",) or (key == "RATE" and w.inj_type == "GAS"):
                    q = "gas_surface_rate"
                elif key == "RESV":
                    q = "reservoir_rate"
                else:
                    q = "liquid_surface_rate"
                w.targets[key] = self._num(rec, 2, q)

    def _kw_WELLSTRE(self, data):
        for rec in data:
            if rec:
                self.streams[to_str(rec[0])] = np.array([to_float(v, 0.0) for v in rec[1:]], float)

    def _kw_WINJGAS(self, data):
        for rec in data:
            if not rec:
                continue
            kind = to_str(rec_get(rec, 1, "STREAM")).upper()
            src = to_str(rec_get(rec, 2, ""))
            for name in self._match(rec[0]):
                if kind == "STREAM" and src in self.streams:
                    self.wells[name].inj_composition = self.streams[src] / self.streams[src].sum()
                else:
                    self.warn(f"WINJGAS {name}: injection fluid {kind} {src} not supported; lightest component used")

    def _kw_TUNING(self, data):
        rec = data[0] if data else []
        if rec_get(rec, 0) is not None:
            self.tuning["TSINIT"] = to_float(rec[0]) * 86400.0
        if rec_get(rec, 1) is not None:
            self.tuning["TSMAXZ"] = to_float(rec[1]) * 86400.0

    def _kw_TSTEP(self, data):
        for dt in np.asarray(data, float):
            t = self.time + dt * 86400.0
            self._add_step(t, self.start + timedelta(seconds=t))

    def _kw_DATES(self, data):
        for rec in data:
            if not rec:
                continue
            d = _parse_date(rec)
            t = (d - self.start).total_seconds()
            if t < self.time - 1:
                self.warn(f"DATES {d:%d %b %Y} is before the current time; ignored")
                continue
            self._add_step(t, d)

    def _kw_WECON(self, data):
        self.warn("WECON economic limits are ignored")
