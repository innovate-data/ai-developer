"""Qt-free ECLIPSE deck generation used by the model-builder form.

`DeckSpec` describes a simple box model (grid, rock, fluid, saturation
functions, equilibration, wells and report schedule).  `generate_deck` turns
it into ECLIPSE deck text that uses only a small, well supported keyword set:

    RUNSPEC TITLE DIMENS OIL WATER GAS DISGAS FIELD METRIC START TABDIMS WELLDIMS COMPS EOS
    GRID DX DY DZ TOPS PORO PERMX PERMY PERMZ
    PROPS PVTW PVDO PVTO PVDG DENSITY ROCK SWOF SGOF CNAMES TCRIT PCRIT ACF MW BIC ZI RTEMP STCOND
    SOLUTION EQUIL   SUMMARY (field vectors)
    SCHEDULE WELSPECS COMPDAT WCONPROD WCONINJE WELLSTRE WINJGAS TSTEP   END

`default_spec(fluid, units)` returns a ready-to-run specification with
sensible default PVT and SCAL data for each fluid type.  Unit conversion of
the defaults (which are stored in FIELD units, compositional component data
in METRIC/SI-like units) goes through `resim.units`.
"""
from __future__ import annotations

import copy
import datetime as _dt
from dataclasses import dataclass, field
from typing import Optional

import numpy as np

from ..units import get_units

FLUID_DEADOIL = "deadoil"
FLUID_BLACKOIL = "blackoil"
FLUID_COMPOSITIONAL = "compositional"
FLUID_CO2 = "co2store"
FLUID_TYPES = {
    FLUID_DEADOIL: "Dead oil + water",
    FLUID_BLACKOIL: "Black oil (live oil + gas)",
    FLUID_COMPOSITIONAL: "Compositional (Peng-Robinson)",
    FLUID_CO2: "CO2 storage in brine (CCUS)",
}

MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]

PROD_CONTROLS = ["ORAT", "WRAT", "GRAT", "LRAT", "BHP"]
INJ_CONTROLS = ["RATE", "BHP"]
INJ_PHASES = ["WATER", "GAS"]

# Column quantities of the tables (for unit conversion); None = dimensionless
PVDO_Q = ("pressure", "bo", "viscosity")
PVDG_Q = ("pressure", "bg", "viscosity")
PVTW_Q = ("pressure", "bo", "compressibility", "viscosity", "viscosibility")
DENSITY_Q = ("density", "density", "density")
PVTO_REC_Q = ("rs",)            # first item of each record; rest are (pressure, bo, viscosity) triples

# ----------------------------------------------------------------------------
# Default data (FIELD units unless noted)
# ----------------------------------------------------------------------------
_PVDO_FIELD = [
    [400.0, 1.0120, 1.160],
    [1200.0, 1.0040, 1.164],
    [2000.0, 0.9960, 1.167],
    [2800.0, 0.9880, 1.172],
    [3600.0, 0.9802, 1.177],
    [4400.0, 0.9724, 1.181],
    [5200.0, 0.9646, 1.185],
    [6400.0, 0.9530, 1.195],
    [8000.0, 0.9380, 1.205],
]

# SPE1 (Odeh 1981) live oil / dry gas
_PVTO_FIELD = [
    [0.0010, 14.7, 1.0620, 1.0400],
    [0.0905, 264.7, 1.1500, 0.9750],
    [0.1800, 514.7, 1.2070, 0.9100],
    [0.3710, 1014.7, 1.2950, 0.8300],
    [0.6360, 2014.7, 1.4350, 0.6950],
    [0.7750, 2514.7, 1.5000, 0.6410],
    [0.9300, 3014.7, 1.5650, 0.5940],
    [1.2700, 4014.7, 1.6950, 0.5100, 9014.7, 1.5790, 0.7400],
    [1.6180, 5014.7, 1.8270, 0.4490, 9014.7, 1.7370, 0.6310],
]
_PVDG_FIELD = [
    [14.7, 166.666, 0.0080],
    [264.7, 12.0930, 0.0096],
    [514.7, 6.2740, 0.0112],
    [1014.7, 3.1970, 0.0140],
    [2014.7, 1.6140, 0.0189],
    [2514.7, 1.2940, 0.0208],
    [3014.7, 1.0800, 0.0228],
    [4014.7, 0.8110, 0.0268],
    [5014.7, 0.6490, 0.0309],
    [9014.7, 0.3860, 0.0470],
]

# SPE5 six-component system; Tc [K], Pc [bar], MW [g/mol]
_SPE5_COMPONENTS = [
    # name, Tc K, Pc bar, acf, MW, z oil, z inj
    ("C1", 190.6, 46.0, 0.013, 16.04, 0.50, 0.77),
    ("C3", 369.8, 42.5, 0.152, 44.10, 0.03, 0.20),
    ("C6", 507.4, 30.1, 0.301, 86.18, 0.07, 0.03),
    ("C10", 617.7, 21.0, 0.489, 142.29, 0.20, 0.00),
    ("C15", 705.6, 13.8, 0.650, 206.0, 0.15, 0.00),
    ("C20", 766.7, 11.2, 0.850, 282.0, 0.05, 0.00),
]


def _spe5_bic():
    names = [c[0] for c in _SPE5_COMPONENTS]
    n = len(names)
    b = np.zeros((n, n))
    pairs = {("C1", "C15"): 0.05, ("C1", "C20"): 0.05, ("C3", "C15"): 0.005, ("C3", "C20"): 0.005}
    for (a, c), v in pairs.items():
        i, j = names.index(a), names.index(c)
        b[i, j] = b[j, i] = v
    return b


# ----------------------------------------------------------------------------
# Unit conversion helpers
# ----------------------------------------------------------------------------
def convert(value, quantity: Optional[str], from_units: str, to_units: str):
    """Convert `value` (scalar or array) of `quantity` between FIELD/METRIC deck units."""
    if quantity is None or quantity in ("bo", "none") or from_units.upper() == to_units.upper():
        return value
    a, b = get_units(from_units), get_units(to_units)
    if quantity == "temperature":
        return b.from_si(a.to_si(value, "temperature"), "temperature")
    return np.asarray(value, float) * a.factors[quantity] / b.factors[quantity] if np.ndim(value) else \
        float(value) * a.factors[quantity] / b.factors[quantity]


def convert_table(rows, quantities, from_units, to_units):
    """Convert a 2D table column-wise. `quantities` gives one entry per column."""
    arr = np.array(rows, float, copy=True)
    for c, q in enumerate(quantities):
        if c < arr.shape[1]:
            arr[:, c] = convert(arr[:, c], q, from_units, to_units)
    return arr


def convert_pvto(records, from_units, to_units):
    out = []
    for rec in records:
        rec = list(map(float, rec))
        new = [convert(rec[0], "rs", from_units, to_units)]
        for m in range(1, len(rec), 3):
            p, bo, mu = rec[m:m + 3]
            new += [convert(p, "pressure", from_units, to_units), bo, mu]
        out.append(new)
    return out


def rate_quantity(kind: str, control: str, phase: str) -> str:
    """Quantity of a well's target rate (gas or liquid surface rate)."""
    if kind == "INJ":
        return "gas_surface_rate" if phase == "GAS" else "liquid_surface_rate"
    return "gas_surface_rate" if control == "GRAT" else "liquid_surface_rate"


# ----------------------------------------------------------------------------
# Saturation functions
# ----------------------------------------------------------------------------
@dataclass
class CoreyParams:
    swc: float = 0.20      # connate water
    sorw: float = 0.20     # residual oil to water
    sgc: float = 0.05      # critical gas
    sorg: float = 0.10     # residual oil to gas
    nw: float = 2.0
    now: float = 2.0
    ng: float = 2.0
    nog: float = 2.0
    krw_max: float = 0.4
    kro_max: float = 1.0
    krg_max: float = 0.8
    nrows: int = 11


def corey_swof(p: CoreyParams) -> np.ndarray:
    """SWOF table (Sw, krw, krow, Pcow=0) from Corey parameters."""
    span = 1.0 - p.swc - p.sorw
    if span <= 0:
        raise ValueError("Swc + Sorw must be < 1")
    sw = np.linspace(p.swc, 1.0 - p.sorw, max(p.nrows, 2))
    s = (sw - p.swc) / span
    krw = p.krw_max * s ** p.nw
    krow = p.kro_max * (1.0 - s) ** p.now
    rows = [list(r) for r in zip(sw, krw, krow, np.zeros_like(sw))]
    if p.sorw > 1e-9:
        rows.append([1.0, max(1.0, p.krw_max), 0.0, 0.0])
    return np.array(rows)


def corey_sgof(p: CoreyParams) -> np.ndarray:
    """SGOF table (Sg, krg, krog, Pcog=0) from Corey parameters (So includes connate water)."""
    sg_max = 1.0 - p.swc - p.sorg
    if sg_max <= p.sgc:
        raise ValueError("Swc + Sorg + Sgc must be < 1")
    sg = np.unique(np.concatenate([[0.0, p.sgc], np.linspace(p.sgc, sg_max, max(p.nrows - 1, 2))]))
    krg = np.where(sg > p.sgc, p.krg_max * ((sg - p.sgc) / (sg_max - p.sgc)) ** p.ng, 0.0)
    so = 1.0 - p.swc - sg
    krog = p.kro_max * np.clip((so - p.sorg) / (1.0 - p.swc - p.sorg), 0.0, 1.0) ** p.nog
    rows = [list(r) for r in zip(sg, krg, krog, np.zeros_like(sg))]
    if p.sorg > 1e-9:
        top = 1.0 - p.swc
        rows.append([top, p.krg_max, 0.0, 0.0])
    return np.array(rows)


def corey_sgwfn(p: CoreyParams) -> np.ndarray:
    """SGWFN table (Sg, krg, krw, Pcgw=0) for gas (CO2) - brine systems."""
    sg_max = 1.0 - p.swc
    if sg_max <= p.sgc:
        raise ValueError("Swc + Sgc must be < 1")
    sg = np.unique(np.concatenate([[0.0, p.sgc], np.linspace(p.sgc, sg_max, max(p.nrows - 1, 2))]))
    krg = np.where(sg > p.sgc, p.krg_max * ((sg - p.sgc) / (sg_max - p.sgc)) ** p.ng, 0.0)
    sw = 1.0 - sg
    krw = p.krw_max * np.clip((sw - p.swc) / (1.0 - p.swc), 0.0, 1.0) ** p.nw
    return np.column_stack([sg, krg, krw, np.zeros_like(sg)])


def _visc_temperature_table(units, rtemp, activation_k):
    """Viscosity-temperature table (absolute values only matter as ratios) using an
    Arrhenius law mu ~ exp(E (1/T - 1/T_ref))."""
    if units == "FIELD":
        temps = [60, 100, 150, 200, 250, 300, 400, 500]
        tk = [(t + 459.67) * 5 / 9 for t in temps]
        tref = (rtemp + 459.67) * 5 / 9
    else:
        temps = [15, 40, 65, 95, 120, 150, 200, 260]
        tk = [t + 273.15 for t in temps]
        tref = rtemp + 273.15
    return [[t, float(np.exp(activation_k * (1 / k - 1 / tref)))] for t, k in zip(temps, tk)]


# ----------------------------------------------------------------------------
# Specification
# ----------------------------------------------------------------------------
@dataclass
class WellSpec:
    name: str
    kind: str = "PROD"          # PROD | INJ
    i: int = 1                  # 1-based
    j: int = 1
    k1: int = 1
    k2: int = 1
    control: str = "ORAT"       # PROD: ORAT WRAT GRAT LRAT BHP; INJ: RATE BHP
    rate: float = 1000.0        # target (or limit) rate
    bhp: float = 1000.0         # BHP limit (min for producers, max for injectors)
    phase: str = "WATER"        # injected phase (injectors)


@dataclass
class Component:
    name: str
    tc: float        # K (METRIC) or degR (FIELD)
    pc: float        # bar or psia
    acf: float
    mw: float
    z_oil: float
    z_inj: float


@dataclass
class DeckSpec:
    case_name: str = "MYCASE"
    title: str = "Generated by ReSim model builder"
    units: str = "FIELD"
    start: _dt.date = field(default_factory=lambda: _dt.date(2025, 1, 1))
    nx: int = 10
    ny: int = 10
    nz: int = 3
    dx: str = "1000"
    dy: str = "1000"
    dz: str = "20, 30, 50"
    top: float = 8325.0
    poro: str = "0.3"
    permx: str = "500, 50, 200"
    permy: str = "500, 50, 200"
    permz: str = "50, 5, 20"
    rock_pref: float = 3600.0
    rock_comp: float = 4.0e-6
    fluid: str = FLUID_BLACKOIL
    pvtw: list = field(default_factory=lambda: [3600.0, 1.00341, 3.0e-6, 0.52, 0.0])
    density: list = field(default_factory=lambda: [53.66, 64.49, 0.0533])
    pvdo: list = field(default_factory=lambda: copy.deepcopy(_PVDO_FIELD))
    pvto: list = field(default_factory=lambda: copy.deepcopy(_PVTO_FIELD))
    pvdg: list = field(default_factory=lambda: copy.deepcopy(_PVDG_FIELD))
    components: list = field(default_factory=list)
    bic: Optional[np.ndarray] = None
    rtemp: float = 160.0
    stcond: tuple = (60.0, 14.696)
    corey: CoreyParams = field(default_factory=CoreyParams)
    datum: float = 8400.0
    datum_pressure: float = 4800.0
    woc: float = 8450.0
    goc: float = 8300.0
    wells: list = field(default_factory=list)
    salinity: float = 1.0          # mol NaCl / kg water (CO2 storage)
    thermal: bool = False          # energy equation (dead oil / black oil)
    inj_temp: float = 300.0        # injection temperature of injectors (deck temperature unit)
    total_time: float = 3650.0
    report_step: float = 365.0
    summary: list = field(default_factory=lambda: [
        "FOPR", "FOPT", "FWPR", "FWPT", "FGPR", "FGPT", "FWIR", "FWIT", "FGIR", "FGIT",
        "FPR", "FWCT", "FGOR", "FOIP"])

    @property
    def nc(self):
        return len(self.components)


def default_spec(fluid: str = FLUID_BLACKOIL, units: str = "FIELD") -> DeckSpec:
    """A complete, runnable default specification for the given fluid type and unit system."""
    s = DeckSpec(fluid=fluid, units="FIELD")
    s.case_name = {FLUID_DEADOIL: "WATERFLOOD", FLUID_BLACKOIL: "GASINJ", FLUID_COMPOSITIONAL: "SPE5COMP",
                   FLUID_CO2: "CO2STORE"}[fluid]
    if fluid == FLUID_DEADOIL:
        s.title = "Dead oil waterflood"
        s.datum_pressure = 4000.0
        s.density = [49.1, 64.0, 0.06]
        s.wells = [WellSpec("PROD", "PROD", 10, 10, 1, 3, "LRAT", 15000.0, 1500.0),
                   WellSpec("INJ", "INJ", 1, 1, 1, 3, "RATE", 15000.0, 8000.0, "WATER")]
    elif fluid == FLUID_BLACKOIL:
        s.title = "Black oil gas injection"
        s.wells = [WellSpec("PROD", "PROD", 10, 10, 3, 3, "ORAT", 20000.0, 1000.0),
                   WellSpec("INJ", "INJ", 1, 1, 1, 1, "RATE", 100000.0, 9014.0, "GAS")]
    elif fluid == FLUID_CO2:
        s.title = "CO2 storage in a saline aquifer"
        s.case_name = "CO2STORE"
        s.nx = s.ny = 15
        s.nz = 6
        s.dx = s.dy = "500"
        s.dz = "33"
        s.top = 3300.0
        s.poro = "0.22"
        s.permx = s.permy = "300, 80, 400, 150, 500, 250"
        s.permz = "30, 8, 40, 15, 50, 25"
        s.rock_pref = 1450.0
        s.rock_comp = 3.4e-6
        s.datum, s.datum_pressure = 3300.0, 1450.0
        s.woc, s.goc = 4000.0, 3000.0
        s.rtemp = 113.0
        s.salinity = 1.0
        s.corey = CoreyParams(swc=0.2, sorw=0.0, sgc=0.1, sorg=0.0, nw=3.0, now=3.0, ng=2.0, nog=2.0,
                              krw_max=1.0, kro_max=1.0, krg_max=0.8)
        s.wells = [WellSpec("CO2INJ", "INJ", 8, 8, 4, 6, "RATE", 5191.0, 2600.0, "GAS")]
        s.total_time, s.report_step = 7305.0, 365.25
        s.summary = ["FGIR", "FGIT", "FGIP", "FGIPL", "FGIPG", "FGIPR", "FGIPM", "FCO2M", "FPR"]
    else:
        s.title = "SPE5-type compositional gas injection"
        s.nx = s.ny = 7
        s.dx = s.dy = "500"
        s.datum_pressure = 4000.0
        s.density = [38.53, 62.4, 0.06]
        s.rtemp = 160.0
        comps = []
        for name, tc, pc, acf, mw, zo, zi in _SPE5_COMPONENTS:
            comps.append(Component(name, tc * 1.8, convert(pc, "pressure", "METRIC", "FIELD"), acf, mw, zo, zi))
        s.components = comps
        s.bic = _spe5_bic()
        s.wells = [WellSpec("PROD", "PROD", 7, 7, 3, 3, "ORAT", 12000.0, 1000.0),
                   WellSpec("INJ", "INJ", 1, 1, 1, 1, "RATE", 12000.0, 10000.0, "GAS")]
    return convert_spec(s, units) if units.upper() != "FIELD" else s


def _convert_list_text(text: str, quantity: str, a: str, b: str) -> str:
    vals = [float(v) for v in str(text).replace(";", ",").split(",") if v.strip()]
    return ", ".join(f"{convert(v, quantity, a, b):.6g}" for v in vals)


def convert_spec(spec: DeckSpec, units: str) -> DeckSpec:
    """Return a copy of `spec` with all unit-dependent values converted to `units`."""
    a, b = spec.units.upper(), units.upper()
    s = copy.deepcopy(spec)
    s.units = b
    if a == b:
        return s
    for attr in ("dx", "dy", "dz"):
        setattr(s, attr, _convert_list_text(getattr(s, attr), "length", a, b))
    for attr in ("top", "datum", "woc", "goc"):
        setattr(s, attr, convert(getattr(s, attr), "length", a, b))
    s.rock_pref = convert(s.rock_pref, "pressure", a, b)
    s.rock_comp = convert(s.rock_comp, "compressibility", a, b)
    s.datum_pressure = convert(s.datum_pressure, "pressure", a, b)
    s.pvtw = list(convert_table([s.pvtw], PVTW_Q, a, b)[0])
    s.density = list(convert_table([s.density], DENSITY_Q, a, b)[0])
    s.pvdo = convert_table(s.pvdo, PVDO_Q, a, b).tolist()
    s.pvdg = convert_table(s.pvdg, PVDG_Q, a, b).tolist()
    s.pvto = convert_pvto(s.pvto, a, b)
    s.rtemp = convert(s.rtemp, "temperature", a, b)
    s.inj_temp = convert(s.inj_temp, "temperature", a, b)
    for c in s.components:
        c.tc = convert(c.tc, "abs_temperature", a, b)
        c.pc = convert(c.pc, "pressure", a, b)
    for w in s.wells:
        w.rate = convert(w.rate, rate_quantity(w.kind, w.control, w.phase), a, b)
        w.bhp = convert(w.bhp, "pressure", a, b)
    # standard conditions: use the conventional values of the target unit system
    s.stcond = (15.56, 1.01325) if b == "METRIC" else (60.0, 14.696)
    return s


# ----------------------------------------------------------------------------
# Deck text generation
# ----------------------------------------------------------------------------
def parse_values(text, n: int, name: str, per: str = "layer") -> list:
    """Parse 'v' or 'v1, v2, ...' (length n) into a list of n floats."""
    if isinstance(text, (int, float)):
        return [float(text)] * n
    parts = [p.strip() for p in str(text).replace(";", ",").split(",") if p.strip()]
    if not parts:
        raise ValueError(f"{name}: no value given")
    try:
        vals = [float(p) for p in parts]
    except ValueError as exc:
        raise ValueError(f"{name}: invalid number in {text!r}") from exc
    if len(vals) == 1:
        return vals * n
    if len(vals) != n:
        raise ValueError(f"{name}: expected 1 or {n} values (one per {per}), got {len(vals)}")
    return vals


def _fmt(v) -> str:
    v = float(v)
    if v == int(v) and abs(v) < 1e12:
        return str(int(v))
    return f"{v:.6g}"


def _array_kw(name: str, values, per_line: int = 6) -> str:
    """Array keyword using repeat counts for runs of equal values."""
    runs = []
    for v in values:
        s = _fmt(v)
        if runs and runs[-1][1] == s:
            runs[-1][0] += 1
        else:
            runs.append([1, s])
    items = [f"{c}*{s}" if c > 1 else s for c, s in runs]
    lines = ["   " + " ".join(items[i:i + per_line]) for i in range(0, len(items), per_line)]
    return f"{name}\n" + "\n".join(lines) + " /\n"


def _table_kw(name: str, rows, header: str = "") -> str:
    out = [name]
    if header:
        out.append("-- " + header)
    rows = list(rows)
    for m, r in enumerate(rows):
        line = "   " + "  ".join(f"{_fmt(v):>10s}" for v in r)
        out.append(line + (" /" if m == len(rows) - 1 else ""))
    return "\n".join(out) + "\n"


def _layered(spec, text, name):
    """Cell array (natural order) from a constant or per-layer list."""
    per_layer = parse_values(text, spec.nz, name)
    return np.repeat(per_layer, spec.nx * spec.ny)


def _validate(spec: DeckSpec):
    if min(spec.nx, spec.ny, spec.nz) < 1:
        raise ValueError("Grid dimensions must be >= 1")
    if not spec.wells:
        raise ValueError("Define at least one well")
    names = set()
    for w in spec.wells:
        if not w.name or " " in w.name or len(w.name) > 8:
            raise ValueError(f"Invalid well name {w.name!r} (1-8 characters, no spaces)")
        if w.name.upper() in names:
            raise ValueError(f"Duplicate well name {w.name}")
        names.add(w.name.upper())
        if not (1 <= w.i <= spec.nx and 1 <= w.j <= spec.ny):
            raise ValueError(f"Well {w.name}: I/J outside the grid")
        if not (1 <= w.k1 <= w.k2 <= spec.nz):
            raise ValueError(f"Well {w.name}: need 1 <= K1 <= K2 <= NZ")
    if spec.total_time <= 0 or spec.report_step <= 0:
        raise ValueError("Total time and report step must be positive")
    if spec.fluid == FLUID_COMPOSITIONAL and spec.nc < 2:
        raise ValueError("Compositional fluid needs at least 2 components")
    if spec.fluid == FLUID_CO2 and any(w.kind == "INJ" and w.phase != "GAS" for w in spec.wells):
        raise ValueError("CO2 storage: injectors inject CO2 (set the injected phase to GAS)")


def generate_deck(spec: DeckSpec) -> str:
    """Return the ECLIPSE deck text for `spec`. Raises ValueError for invalid input."""
    _validate(spec)
    fl = spec.fluid
    units = spec.units.upper()
    nx, ny, nz = spec.nx, spec.ny, spec.nz
    comp = fl == FLUID_COMPOSITIONAL
    co2 = fl == FLUID_CO2
    thermal = spec.thermal and fl in (FLUID_DEADOIL, FLUID_BLACKOIL)
    has_gas = fl in (FLUID_BLACKOIL, FLUID_COMPOSITIONAL)
    nwells = len(spec.wells)
    maxconn = max(w.k2 - w.k1 + 1 for w in spec.wells)
    L = []
    a = L.append
    lu = "ft" if units == "FIELD" else "m"
    pu = "psia" if units == "FIELD" else "bar"

    a("-- " + "=" * 70)
    a(f"-- {spec.case_name}: generated by the ReSim model builder")
    a(f"-- Fluid: {FLUID_TYPES[fl]};  units: {units}")
    a("-- " + "=" * 70)
    a("RUNSPEC\n")
    a(f"TITLE\n   {spec.title or spec.case_name}\n")
    a(f"DIMENS\n   {nx} {ny} {nz} /\n")
    if co2:
        a("GAS\nWATER\nCO2STORE\nDISGASW\nVAPWAT")
    else:
        a("OIL\nWATER")
        if has_gas:
            a("GAS")
        if fl == FLUID_BLACKOIL:
            a("DISGAS")
    if thermal:
        a("THERMAL")
    a("")
    a(units + "\n")
    d = spec.start
    a(f"START\n   {d.day} '{MONTHS[d.month - 1]}' {d.year} /\n")
    a("TABDIMS\n-- NTSFUN NTPVT NSSFUN NPPVT\n   1 1 40 40 /\n")
    a(f"WELLDIMS\n-- wells conn/well groups wells/group\n   {nwells} {maxconn} 1 {nwells} /\n")
    if comp:
        a(f"COMPS\n   {spec.nc} /\n")
        a("EOS\n   PR /\n")

    # ------------------------------------------------------------------ GRID
    a("-- " + "-" * 70)
    a("GRID\n")
    dx = parse_values(spec.dx, nx, "DX", "column (NX)")
    dy = parse_values(spec.dy, ny, "DY", "row (NY)")
    dz = parse_values(spec.dz, nz, "DZ")
    a(f"-- cell sizes [{lu}]")
    a(_array_kw("DX", np.tile(dx, ny * nz)))
    a(_array_kw("DY", np.tile(np.repeat(dy, nx), nz)))
    a(_array_kw("DZ", np.repeat(dz, nx * ny)))
    a(f"-- depth of the top face of layer 1 [{lu}]")
    a(_array_kw("TOPS", [spec.top] * (nx * ny)))
    a(_array_kw("PORO", _layered(spec, spec.poro, "PORO")))
    for kw in ("PERMX", "PERMY", "PERMZ"):
        a(_array_kw(kw, _layered(spec, getattr(spec, kw.lower()), kw)))
    if thermal:
        n = nx * ny * nz
        hc, tc = (35.0, 24.0) if units == "FIELD" else (2350.0, 190.0)
        a("-- rock heat capacity per rock volume [" + ("Btu/ft3/F" if units == "FIELD" else "kJ/m3/K") + "]")
        a(_array_kw("HEATCR", [hc] * n))
        a("-- thermal conductivity [" + ("Btu/ft/day/F" if units == "FIELD" else "kJ/m/day/K") + "]")
        a(_array_kw("THCONR", [tc] * n))

    # ------------------------------------------------------------------ PROPS
    a("-- " + "-" * 70)
    a("PROPS\n")
    tu = "F" if units == "FIELD" else "C"
    if co2:
        a("-- CO2 and brine properties are computed internally (Spycher-Pruess solubility,")
        a("-- Peng-Robinson CO2 density, Batzle-Wang brine) at the reservoir temperature")
        a(_table_kw("ROCK", [[spec.rock_pref, spec.rock_comp]], f"Pref[{pu}] cr"))
        a(_table_kw("SGWFN", corey_sgwfn(spec.corey), "Sg krg krw Pcgw"))
        a(f"SALINITY\n-- mol NaCl per kg water\n   {_fmt(spec.salinity)} /\n")
        a(f"RTEMP\n-- reservoir temperature [{tu}]\n   {_fmt(spec.rtemp)} /\n")
    if co2:
        pass
    else:
        a(_table_kw("PVTW", [spec.pvtw], f"Pref[{pu}] Bw cw muw cv"))
    if co2:
        pass
    elif fl == FLUID_DEADOIL:
        a(_table_kw("PVDO", spec.pvdo, f"P[{pu}] Bo muo[cP]"))
    elif fl == FLUID_BLACKOIL:
        a("PVTO")
        a(f"-- Rs  P[{pu}]  Bo  muo[cP]  (undersaturated rows continue a record)")
        for rec in spec.pvto:
            rs, rest = rec[0], rec[1:]
            triples = [rest[m:m + 3] for m in range(0, len(rest), 3)]
            for m, t in enumerate(triples):
                pre = f"   {_fmt(rs):>10s}" if m == 0 else " " * 13
                line = pre + "  " + "  ".join(f"{_fmt(v):>10s}" for v in t)
                a(line + (" /" if m == len(triples) - 1 else ""))
        a("/\n")
        a(_table_kw("PVDG", spec.pvdg, f"P[{pu}] Bg muG[cP]"))
    else:
        cs = spec.components
        a("CNAMES\n   " + " ".join(f"'{c.name}'" for c in cs) + " /\n")
        a(f"-- critical temperatures [{'degR' if units == 'FIELD' else 'K'}]")
        a(_array_kw("TCRIT", [c.tc for c in cs], per_line=8))
        a(f"-- critical pressures [{pu}]")
        a(_array_kw("PCRIT", [c.pc for c in cs], per_line=8))
        a(_array_kw("ACF", [c.acf for c in cs], per_line=8))
        a(_array_kw("MW", [c.mw for c in cs], per_line=8))
        bic = np.zeros((spec.nc, spec.nc)) if spec.bic is None else np.asarray(spec.bic, float)
        a("BIC\n-- lower triangle, row by row")
        for i in range(1, spec.nc):
            a("   " + " ".join(_fmt(bic[i, j]) for j in range(i)) + (" /" if i == spec.nc - 1 else ""))
        a("")
        ztot = sum(c.z_oil for c in cs) or 1.0
        a("-- initial (reservoir) composition")
        a(_array_kw("ZI", [c.z_oil / ztot for c in cs], per_line=8))
        a(f"RTEMP\n   {_fmt(spec.rtemp)} /\n")
        a(f"STCOND\n   {_fmt(spec.stcond[0])} {_fmt(spec.stcond[1])} /\n")
    if not co2:
        a(_table_kw("DENSITY", [spec.density], "oil water gas"))
        a(_table_kw("ROCK", [[spec.rock_pref, spec.rock_comp]], f"Pref[{pu}] cr"))
        a(_table_kw("SWOF", corey_swof(spec.corey), "Sw krw krow Pcow"))
        if has_gas:
            a(_table_kw("SGOF", corey_sgof(spec.corey), "Sg krg krog Pcog"))
    if thermal:
        a(f"RTEMP\n-- reservoir temperature [{tu}] (PVT viscosities apply here)\n   {_fmt(spec.rtemp)} /\n")
        cpu = "Btu/lb/F" if units == "FIELD" else "kJ/kg/K"
        rows = [[32, 0.50, 1.00, 0.26], [572, 0.60, 1.07, 0.29]] if units == "FIELD" else \
               [[0, 2.10, 4.18, 1.10], [300, 2.50, 4.48, 1.20]]
        a(_table_kw("SPECHEAT", rows, f"T[{tu}] cp_oil cp_water cp_gas [{cpu}]"))
        a(_table_kw("OILVISCT", _visc_temperature_table(units, spec.rtemp, 3500.0), f"T[{tu}] relative mu_oil"))
        a(_table_kw("WATVISCT", _visc_temperature_table(units, spec.rtemp, 1800.0), f"T[{tu}] relative mu_water"))

    # ------------------------------------------------------------------ SOLUTION
    a("-- " + "-" * 70)
    a("SOLUTION\n")
    a("EQUIL")
    a(f"-- datum[{lu}] pressure[{pu}] WOC Pcow GOC Pcgo")
    goc = _fmt(spec.goc) if (has_gas or co2) else "1*"
    a(f"   {_fmt(spec.datum)} {_fmt(spec.datum_pressure)} {_fmt(spec.woc)} 0 {goc} 0 /\n")

    # ------------------------------------------------------------------ SUMMARY
    a("-- " + "-" * 70)
    a("SUMMARY\n")
    for key in spec.summary:
        a(key)
    a("")

    # ------------------------------------------------------------------ SCHEDULE
    a("-- " + "-" * 70)
    a("SCHEDULE\n")
    a("WELSPECS\n-- name group I J refdepth phase")
    for w in spec.wells:
        ph = "OIL" if w.kind == "PROD" else w.phase
        a(f"   '{w.name}' 'G1' {w.i} {w.j} 1* '{ph}' /")
    a("/\n")
    a("COMPDAT\n-- name I J K1 K2 status")
    for w in spec.wells:
        a(f"   '{w.name}' {w.i} {w.j} {w.k1} {w.k2} 'OPEN' /")
    a("/\n")
    prods = [w for w in spec.wells if w.kind == "PROD"]
    injs = [w for w in spec.wells if w.kind != "PROD"]
    if prods:
        a("WCONPROD\n-- name status ctrl ORAT WRAT GRAT LRAT RESV BHP")
        for w in prods:
            ctrl = w.control if w.control in PROD_CONTROLS else "BHP"
            if ctrl == "BHP":
                a(f"   '{w.name}' 'OPEN' 'BHP' 5* {_fmt(w.bhp)} /")
            else:
                pos = PROD_CONTROLS.index(ctrl)       # 0..3 within ORAT WRAT GRAT LRAT
                items = ["1*"] * 5
                items[pos] = _fmt(w.rate)
                a(f"   '{w.name}' 'OPEN' '{ctrl}' {_compress_defaults(items)} {_fmt(w.bhp)} /")
        a("/\n")
    if comp and any(w.phase == "GAS" for w in injs):
        a("WELLSTRE\n-- stream name, mole fractions")
        ztot = sum(c.z_inj for c in spec.components) or 1.0
        a("   'INJGAS' " + " ".join(_fmt(round(c.z_inj / ztot, 8)) for c in spec.components) + " /")
        a("/\n")
    if injs:
        a("WCONINJE\n-- name type status ctrl rate resv BHP")
        for w in injs:
            ctrl = w.control if w.control in INJ_CONTROLS else "RATE"
            a(f"   '{w.name}' '{w.phase}' 'OPEN' '{ctrl}' {_fmt(w.rate)} 1* {_fmt(w.bhp)} /")
        a("/\n")
        if comp and any(w.phase == "GAS" for w in injs):
            a("WINJGAS")
            for w in injs:
                if w.phase == "GAS":
                    a(f"   '{w.name}' 'STREAM' 'INJGAS' /")
            a("/\n")
    if thermal and injs:
        a(f"WTEMP\n-- injection temperature [{tu}]")
        for w in injs:
            a(f"   '{w.name}' {_fmt(spec.inj_temp)} /")
        a("/\n")
    a(f"-- {_fmt(spec.total_time)} days in report steps of {_fmt(spec.report_step)} days")
    nfull = int(np.floor(spec.total_time / spec.report_step + 1e-9))
    rem = spec.total_time - nfull * spec.report_step
    steps = []
    if nfull:
        steps.append(f"{nfull}*{_fmt(spec.report_step)}" if nfull > 1 else _fmt(spec.report_step))
    if rem > 1e-6:
        steps.append(_fmt(rem))
    a("TSTEP\n   " + " ".join(steps) + " /\n")
    a("END")
    return "\n".join(L) + "\n"


def _compress_defaults(items):
    """Collapse consecutive '1*' defaults into 'N*'."""
    out, count = [], 0
    for it in items:
        if it == "1*":
            count += 1
            continue
        if count:
            out.append(f"{count}*")
            count = 0
        out.append(it)
    if count:
        out.append(f"{count}*")
    return " ".join(out)
