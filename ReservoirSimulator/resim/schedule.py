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
    pimult: float = 1.0                 # WPIMULT multiplier of the connection factor


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
    inj_temp: Optional[float] = None    # injection temperature (K), WTEMP / WINJTEMP
    steam_quality: Optional[float] = None   # WINJTEMP: injected steam quality (steam runs)
    inj_pres: Optional[float] = None    # WINJTEMP: pressure fixing the saturation temperature (Pa)
    inj_enthalpy: Optional[float] = None    # WINJTEMP: injected specific enthalpy (J/kg)
    auto_shut: str = "SHUT"             # WELSPECS item 9: SHUT or STOP when closed automatically
    crossflow: bool = True              # WELSPECS item 10
    vfp_table: int = 0                  # VFP table number (WCONPROD item 11 / WCONINJE item 9)
    thp_limit: float = 0.0              # THP limit (Pa); 0 = none
    alq: float = 0.0
    econ: Optional[dict] = None         # WECON economic limits
    observed: Optional[dict] = None     # WCONHIST / WCONINJH observed rates and pressures (SI)
    test: Optional[dict] = None         # WTEST: interval (s) and reasons
    tracers: dict = field(default_factory=dict)   # WTRACER: injected concentration per tracer
    group_control: bool = False         # injector under group control (WCONINJE 'GRUP')

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
    touched: set = field(default_factory=set)     # wells whose status was set by keywords in this step
    vfp: dict = field(default_factory=dict)       # (kind, table number) -> VFPTable
    groups: dict = field(default_factory=dict)    # group -> parent group (GRUPTREE)
    options: dict = field(default_factory=dict)   # DRSDT / DRVDT / VAPPARS settings in force


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
        self.touched: set = set()
        self.vfp: dict = {}
        self.groups: dict = {"FIELD": None}
        self.options: dict = {}

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
        self.steps.append(ReportStep(end_time, date, copy.deepcopy(self.wells), dict(self.tuning),
                                     set(self.touched), dict(self.vfp), dict(self.groups), dict(self.options)))
        self.touched = set()
        self.tuning.pop("TSINIT", None)
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
            w.auto_shut = to_str(rec_get(rec, 8, "SHUT")).upper()
            w.crossflow = to_str(rec_get(rec, 9, "YES")).upper() != "NO"
            self.wells[name] = w
            if w.group not in self.groups:
                self.groups[w.group] = "FIELD"

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
                thp = self._num(rec, 9, "pressure")
                w.thp_limit = thp or 0.0
                if thp:
                    t["THP"] = thp
                w.vfp_table = to_int(rec_get(rec, 10), 0) or 0
                w.alq = to_float(rec_get(rec, 11), 0.0) or 0.0
                w.targets = t
                self.touched.add(name)
                if w.control == "THP" and not (thp and w.vfp_table):
                    self.warn(f"WCONPROD {name}: THP control needs a THP limit and a VFP table; using BHP")
                    w.control = "BHP"
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
                # history-matching producer: the observed rates are the targets; the BHP limit is the
                # one set before (WELTARG) or 1 atm, items 9-10 being observed THP and BHP
                bhp_lim = w.targets.get("BHP", ATM) if w.history and w.kind == "PROD" else ATM
                t = {"ORAT": orat, "WRAT": wrat, "GRAT": grat, "LRAT": orat + wrat, "BHP": bhp_lim}
                if w.control == "RESV":
                    t["RESV"] = 0.0              # reservoir volume of the observed rates, set by the solver
                elif w.control not in t:
                    self.warn(f"WCONHIST {name}: control {w.control} is not a history control; using RESV")
                    w.control = "RESV"
                    t["RESV"] = 0.0
                vfp = to_int(rec_get(rec, 6), 0) or 0
                if vfp:
                    w.vfp_table = vfp
                    w.alq = to_float(rec_get(rec, 7), 0.0) or 0.0
                w.thp_limit = 0.0
                w.observed = {"ORAT": orat, "WRAT": wrat, "GRAT": grat,
                              "THP": self._num(rec, 8, "pressure"), "BHP": self._num(rec, 9, "pressure")}
                w.targets = t
                self.touched.add(name)

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
                thp = self._num(rec, 7, "pressure")
                w.thp_limit = thp or 0.0
                if thp:
                    t["THP"] = thp
                w.vfp_table = to_int(rec_get(rec, 8), 0) or 0
                w.targets = t
                self.touched.add(name)
                if w.control == "THP" and not (thp and w.vfp_table):
                    self.warn(f"WCONINJE {name}: THP control needs a THP limit and a VFP table; using BHP")
                    w.control = "BHP"
                w.group_control = w.control == "GRUP"
                if w.group_control:
                    t.setdefault("RATE", BIG)            # share of the group target, set by the solver
                    w.control = "RATE"
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
                rate = self._num(rec, 3, q, 0.0)
                w.targets = {"RATE": rate, "BHP": 1.0e5 * PSI}
                w.control = "BHP" if to_str(rec_get(rec, 11, "RATE")).upper() == "BHP" else "RATE"
                w.observed = {"RATE": rate, "BHP": self._num(rec, 4, "pressure"), "THP": self._num(rec, 5, "pressure")}
                self.touched.add(name)

    def _kw_WELOPEN(self, data):
        for rec in data:
            if not rec:
                continue
            status = to_str(rec_get(rec, 1, "OPEN")).upper()
            # With all of items 3-7 defaulted the command applies to the well; otherwise it applies
            # to the matching connections, a zero or defaulted location item matching any value
            # ('SHUT' 0 0 0 closes every connection but leaves the well open).
            on_conns = any(rec_get(rec, m) is not None for m in range(2, 7))
            conn = [rec_get(rec, m) for m in range(2, 5)]
            conn = [None if v is None or to_int(v, 0) <= 0 else v for v in conn]
            if any(rec_get(rec, m) is not None and to_int(rec_get(rec, m), 0) > 0 for m in (5, 6)):
                self.warn("WELOPEN: completion-number selection (items 6-7) is not supported; "
                          "the location items select the connections")
            for name in self._match(rec[0]):
                w = self.wells[name]
                if not on_conns:
                    w.status = status
                    self.touched.add(name)
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
        # TSINIT applies to the next time step only (see _add_step); TSMAXZ stays in force
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

    def _kw_WTEMP(self, data):
        for rec in data:
            if not rec:
                continue
            for name in self._match(rec[0]):
                self.wells[name].inj_temp = self._num(rec, 1, "temperature")

    def _kw_WINJTEMP(self, data):
        """Injection temperature / steam quality / pressure / enthalpy (thermal option)."""
        for rec in data:
            if not rec:
                continue
            for name in self._match(rec[0]):
                w = self.wells[name]
                w.steam_quality = self._num(rec, 1, None, 1.0)
                w.inj_temp = self._num(rec, 2, "temperature")
                w.inj_pres = self._num(rec, 3, "pressure")
                w.inj_enthalpy = self._num(rec, 4, "specific_enthalpy")

    def _kw_WECON(self, data):
        """Economic limits, checked at the end of every time step (see BlackOilSolver.economic_limits)."""
        for rec in data:
            if not rec:
                continue
            e = {"min_orat": self._num(rec, 1, "liquid_surface_rate"), "min_grat": self._num(rec, 2, "gas_surface_rate"),
                 "max_wct": self._num(rec, 3), "max_gor": self._num(rec, 4, "rs"), "max_wgr": self._num(rec, 5, "wgr"),
                 "workover": to_str(rec_get(rec, 6, "NONE")).upper(), "end_run": to_str(rec_get(rec, 7, "NO")).upper() == "YES",
                 "quantity": to_str(rec_get(rec, 9, "RATE")).upper(), "sec_wct": self._num(rec, 10),
                 "sec_workover": to_str(rec_get(rec, 11, "NONE")).upper(), "max_glr": self._num(rec, 12, "rs"),
                 "min_lrat": self._num(rec, 13, "liquid_surface_rate")}
            followon = rec_get(rec, 8)
            if followon is not None and str(followon).strip("'") not in ("", "1*"):
                self.warn(f"WECON: follow-on well {followon} is not supported")
            if e["quantity"] == "POTN":
                self.warn("WECON: limits on well potentials (POTN) are checked against the actual rates")
            for name in self._match(rec[0]):
                self.wells[name].econ = dict(e)

    def _kw_GRUPTREE(self, data):
        for rec in data:
            if rec:
                self.groups[to_str(rec[0])] = to_str(rec_get(rec, 1, "FIELD"))

    def _kw_VFPPROD(self, data):
        from .vfp import parse_vfp
        t = parse_vfp("PROD", data, self.u)
        self.vfp[("PROD", t.number)] = t

    def _kw_VFPINJ(self, data):
        from .vfp import parse_vfp
        t = parse_vfp("INJ", data, self.u)
        self.vfp[("INJ", t.number)] = t

    # -------------------------------------------------------------- dissolution / vaporisation limits
    def _kw_DRSDT(self, data):
        """Maximum rate of increase of solution GOR (0: free gas cannot re-dissolve)."""
        rec = data[0] if data else []
        rate = self.u.to_si(to_float(rec_get(rec, 0), 0.0), "rs") / 86400.0
        self.options["DRSDT"] = (rate, to_str(rec_get(rec, 1, "ALL")).upper())
        self.options.pop("VAPPARS", None)

    def _kw_DRVDT(self, data):
        """Maximum rate of increase of vapour oil-gas ratio."""
        rec = data[0] if data else []
        self.options["DRVDT"] = self.u.to_si(to_float(rec_get(rec, 0), 0.0), "rv") / 86400.0
        self.options.pop("VAPPARS", None)

    def _kw_VAPPARS(self, data):
        """Oil vaporisation parameters: Rv and Rs scaled by (So / So_max) ** VAP1 / VAP2."""
        rec = data[0] if data else []
        self.options["VAPPARS"] = (to_float(rec_get(rec, 0), 0.0), to_float(rec_get(rec, 1), 0.0))
        self.options.pop("DRSDT", None)
        self.options.pop("DRVDT", None)

    # -------------------------------------------------------------- group injection, testing, tracers
    def _kw_GCONINJE(self, data):
        """Group injection limits: RATE (surface), RESV, REIN (re-injection of the group's
        produced phase) and VREP (voidage replacement)."""
        table = dict(self.options.get("GCONINJE", {}))
        for rec in data:
            if not rec:
                continue
            group = to_str(rec[0])
            phase = to_str(rec_get(rec, 1, "WATER")).upper()
            mode = to_str(rec_get(rec, 2, "NONE")).upper()
            q = "gas_surface_rate" if phase == "GAS" else "liquid_surface_rate"
            c = {"mode": mode, "RATE": self._num(rec, 3, q), "RESV": self._num(rec, 4, "reservoir_rate"),
                 "REIN": self._num(rec, 5), "VREP": self._num(rec, 6),
                 "control_group": to_str(rec_get(rec, 8, "")) or None}
            for m in ("REIN", "VREP"):
                if c["mode"] == m and c.get("control_group"):
                    self.warn(f"GCONINJE {group}: item 9 (another group's production for {m}) is not supported")
            if group not in self.groups:
                self.groups[group] = "FIELD"
            table[(group, phase)] = c
        self.options["GCONINJE"] = table

    def _kw_WTEST(self, data):
        """Re-open wells closed for the listed reasons (P physical, E economic, ...) every interval."""
        for rec in data:
            if not rec:
                continue
            t = {"interval": self._num(rec, 1, None, 0.0) * 86400.0,
                 "reasons": to_str(rec_get(rec, 2, "P")).upper(), "tests": to_int(rec_get(rec, 3), 0) or 0,
                 "startup": self._num(rec, 4, None, 0.0) * 86400.0}
            for name in self._match(rec[0]):
                self.wells[name].test = dict(t) if t["interval"] > 0 or t["reasons"] else None

    def _kw_WTRACER(self, data):
        """Tracer concentrations in the injected fluid."""
        for rec in data:
            if not rec:
                continue
            tracer = to_str(rec_get(rec, 1)).upper()
            conc = to_float(rec_get(rec, 2), 0.0)
            if rec_get(rec, 3) is not None or rec_get(rec, 4) is not None:
                self.warn("WTRACER: cumulative-dependent concentrations (items 4-5) are not supported")
            for name in self._match(rec[0]):
                tr = dict(self.wells[name].tracers)
                tr[tracer] = conc
                self.wells[name].tracers = tr

    def _kw_WPAVE(self, data):
        """Well block average pressure options (WBP, WBP4, WBP5, WBP9)."""
        rec = data[0] if data else []
        self.options["WPAVE"] = {"F1": to_float(rec_get(rec, 0), 0.5), "F2": to_float(rec_get(rec, 1), 1.0),
                                 "depth": to_str(rec_get(rec, 2, "WELL")).upper(),
                                 "conns": to_str(rec_get(rec, 3, "OPEN")).upper()}

    def _kw_WWPAVE(self, data):
        for rec in data:
            if not rec:
                continue
            opt = {"F1": to_float(rec_get(rec, 1), 0.5), "F2": to_float(rec_get(rec, 2), 1.0),
                   "depth": to_str(rec_get(rec, 3, "WELL")).upper(), "conns": to_str(rec_get(rec, 4, "OPEN")).upper()}
            per = dict(self.options.get("WWPAVE", {}))
            for name in self._match(rec[0]):
                per[name] = opt
            self.options["WWPAVE"] = per

    def _kw_WPAVEDEP(self, data):
        for rec in data:
            if not rec:
                continue
            per = dict(self.options.get("WPAVEDEP", {}))
            for name in self._match(rec[0]):
                per[name] = self._num(rec, 1, "length")
            self.options["WPAVEDEP"] = per

    def _kw_WPIMULT(self, data):
        """Multiply connection factors (cumulative, as in ECLIPSE). Location items that are zero or
        defaulted match any value; completion numbers (items 6-7) are not used."""
        for rec in data:
            if not rec:
                continue
            f = to_float(rec_get(rec, 1), 1.0)
            loc = [rec_get(rec, m) for m in range(2, 5)]
            loc = [None if v is None or to_int(v, 0) <= 0 else to_int(v) - 1 for v in loc]
            if any(rec_get(rec, m) is not None and to_int(rec_get(rec, m), 0) > 0 for m in (5, 6)):
                self.warn("WPIMULT: completion-number selection (items 6-7) is not supported; "
                          "the location items select the connections")
            for name in self._match(rec[0]):
                w = self.wells[name]
                for c in w.completions:
                    if all(v is None or v == x for v, x in zip(loc, (c.i, c.j, c.k))):
                        c.pimult *= f
