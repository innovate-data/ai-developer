"""Build a `SimulationModel` (SI units, active cells only) from a parsed deck."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional

import numpy as np

from .deck.gridprops import GridProperties
from .deck.parser import Deck, parse_deck, rec_get, to_float, to_int, to_str
from .faults import fault_overlaps, half_trans_area, pinch_connections
from .grid import Grid, cartesian_corners, corner_point_corners
from .props.blackoil_pvt import (BlackOilPVT, ConstCompressibilityFluid, DeadOil, DryGas, LiveOil, TabulatedFluid,
                                 TemperatureFunction, WetGas)
from .props.tables import interp as _interp
from .props.eos import CubicEOS
from .props import steam as steam_props
from .props.steam import SteamGas
from .props.relperm import SaturationTable, default_sgof, default_swof, family2_to_family1
from .props.satfunc import EP_NAMES, SatFunctions
from .schedule import ScheduleBuilder, parse_start
from .units import ATM, GRAVITY, get_units

HANDLED = {
    # RUNSPEC
    "TITLE", "DIMENS", "INIT", "OIL", "WATER", "GAS", "DISGAS", "FIELD", "METRIC", "START", "TABDIMS", "WELLDIMS",
    "EQLDIMS", "REGDIMS", "COMPS", "EOS", "NCOMPS", "UNIFOUT", "UNIFIN", "FMTOUT", "NOSIM", "ECHO", "NOECHO",
    "FULLIMP", "IMPES", "NSTACK", "AQUDIMS", "VFPPDIMS", "VFPIDIMS", "FAULTDIM", "MESSAGES", "RUNSUM",
    "RPTRUNSP", "GRIDOPTS", "ROCKCOMP", "CPR", "ISGAS", "NUPCOL", "UDQDIMS", "UDADIMS", "SMRYDIMS", "LIVEOIL",
    # GRID/EDIT
    "COORD", "ZCORN", "MINPV", "MINPORV", "RPTGRID", "INIT", "GRIDFILE", "NEWTRAN", "OLDTRAN", "MAPAXES",
    "MAPUNITS", "GRIDUNIT", "COORDSYS", "PINCH", "NOGGF", "SPECGRID", "FAULTS", "MULTFLT", "GDORIENT",
    "MONITOR", "NOMONITO", "NUMRES", "FILLEPS", "MULTREGT", "FLUXNUM", "MULTNUM", "OPERNUM", "MESSAGES", "NSTACK",
    "UNIFIN", "UNIFOUT", "GRIDOPTS", "ZIPPY2", "NETBALAN", "WRFTPLT", "WRFT", "END", "NOSIM",
    # PROPS
    "THERMAL", "CO2STORE", "VAPOIL", "VAPWAT", "DISGASW", "SALINITY", "SPECHEAT", "HEATCR", "THCONR",
    "OILVISCT", "WATVISCT", "GASVISCT", "WATDENT", "RTEMPVD", "WTEMP", "WINJTEMP", "RVVD", "SGWFN", "WSF", "GSF",
    "SWOF", "SGOF", "SWFN", "SGFN", "SOF3", "SOF2", "PVTW", "PVDO", "PVCDO", "PVTO", "PVDG", "PVTG", "DENSITY",
    "GRAVITY", "ROCK", "RPTPROPS", "CNAMES", "TCRIT", "PCRIT", "VCRIT", "ZCRIT", "ACF", "MW", "BIC", "OMEGAA",
    "OMEGAB", "SSHIFT", "STCOND", "RTEMP", "TEMPI", "ZI", "PARACHOR", "VCRITVIS", "ZCRITVIS", "LBCCOEF",
    "PRCORR", "TREF", "DREF",
    # SOLUTION
    "EQUIL", "RSVD", "PBVD", "RPTSOL", "RPTRST", "ZMFVD", "TEMPVD", "THPRES", "EQLOPTS", "TRACERS", "TRACER",
    # SCHEDULE
    "RPTSCHED", "TUNING", "WELSPECS", "COMPDAT", "WCONPROD", "WCONINJE", "WCONHIST", "WCONINJH", "WELOPEN",
    "WELTARG", "WELLSTRE", "WINJGAS", "TSTEP", "DATES", "WECON", "RPTSMRY", "GRUPTREE", "VFPPROD", "VFPINJ",
    "ROCKOPTS",
    # end-point scaling, hysteresis, array operators in PROPS / REGIONS
    "ENDSCALE", "SATOPTS", "SCALECRS", "EHYSTR", "EQUALS", "COPY", "ADD", "MULTIPLY", "BOX", "ENDBOX",
    "MINVALUE", "MAXVALUE", "SWATINIT", "SWL", "SWCR", "SWU", "SGL", "SGCR", "SGU", "SOWCR", "SOGCR", "ISWL",
    "ISWCR", "ISWU", "ISGL", "ISGCR", "ISGU", "ISOWCR", "ISOGCR", "PCW", "PCG", "IPCW", "IPCG", "IMBNUM", "ENDNUM",
}


@dataclass
class SimulationModel:
    deck: Deck
    case_name: str
    title: str
    units: object
    start_date: datetime
    grid: Grid
    active: np.ndarray                  # (N,) bool
    global_to_active: np.ndarray        # (N,) int, -1 for inactive
    active_cells: np.ndarray            # (Na,) natural indices
    pore_volume: np.ndarray             # (Na,) at reference pressure
    depth: np.ndarray                   # (Na,)
    conn_a: np.ndarray
    conn_b: np.ndarray
    conn_T: np.ndarray                  # transmissibilities (m3)
    perm: tuple                         # (kx, ky, kz) full-grid SI
    ntg: np.ndarray
    phases: dict
    fluid_type: str                     # "blackoil" or "compositional"
    rock: list                          # [(pref, cr)] per PVTNUM/ROCKNUM
    rocknum: np.ndarray
    pvtnum: np.ndarray
    satnum: np.ndarray
    eqlnum: np.ndarray
    pvt: list = field(default_factory=list)
    sat: list = field(default_factory=list)
    eos: Optional[CubicEOS] = None
    temperature: float = 373.15
    std_cond: tuple = (288.71, ATM)
    water_pvt: object = None
    rho_ws: float = 1000.0
    equil: list = field(default_factory=list)
    rsvd: list = field(default_factory=list)
    pbvd: list = field(default_factory=list)
    zmfvd: list = field(default_factory=list)
    zi: Optional[np.ndarray] = None
    explicit_init: dict = field(default_factory=dict)
    schedule: list = field(default_factory=list)
    summary_keywords: list = field(default_factory=list)
    warnings: list = field(default_factory=list)
    gravity: float = GRAVITY
    thermal: Optional[dict] = None      # energy equation data (THERMAL)
    co2store: bool = False              # CO2-brine storage mode (CO2STORE)
    steam: bool = False                 # THERMAL with a steam (water vapour) gas phase
    salinity: float = 0.0               # mol NaCl per kg water (CO2STORE)
    rvvd: list = field(default_factory=list)
    satfunc: object = None              # per-cell saturation functions (props.satfunc.SatFunctions)
    swatinit: Optional[np.ndarray] = None
    fipnum: Optional[np.ndarray] = None    # FIPNUM region (0-based) per active cell
    thpres: list = field(default_factory=list)   # [(eqlnum i, eqlnum j, threshold Pa or None)]
    thpres_irrevers: bool = False
    tracers: list = field(default_factory=list)  # [{'name', 'phase', 'init': [depth/conc tables]}]
    summary_connections: dict = field(default_factory=dict)
    summary_region_flows: dict = field(default_factory=dict)
    summary_blocks: dict = field(default_factory=dict)
    n_fip_regions: int = 1

    @property
    def n_active(self):
        return self.active_cells.size

    def to_full(self, values, fill=np.nan):
        out = np.full(self.grid.n_cells, fill, dtype=float)
        out[self.active_cells] = values
        return out


def load_model(path_or_deck) -> SimulationModel:
    deck = path_or_deck if isinstance(path_or_deck, Deck) else parse_deck(path_or_deck)
    return ModelBuilder(deck).build()


class ModelBuilder:
    def __init__(self, deck: Deck):
        self.deck = deck
        self.warnings = list(deck.warnings)

    def warn(self, msg):
        if msg not in self.warnings:
            self.warnings.append(msg)

    # ----------------------------------------------------------------------
    def build(self) -> SimulationModel:
        d = self.deck
        dims = d.get("DIMENS")
        if dims is None:
            raise ValueError("DIMENS keyword missing in RUNSPEC")
        nx, ny, nz = (to_int(v) for v in dims.data[0][:3])
        units = get_units("FIELD" if "FIELD" in d else "METRIC")
        if "LAB" in d or "PVT-M" in d:
            raise ValueError("LAB and PVT-M unit systems are not supported")
        self.u = units
        compositional = "COMPS" in d
        co2 = "CO2STORE" in d
        thermal = "THERMAL" in d
        phases = {"water": "WATER" in d, "oil": "OIL" in d or compositional,
                  "gas": "GAS" in d or compositional, "disgas": "DISGAS" in d, "vapoil": "VAPOIL" in d}
        if co2:
            if compositional:
                raise ValueError("CO2STORE cannot be combined with COMPS")
            if not ("GAS" in d and ("WATER" in d or "OIL" in d)):
                raise ValueError("CO2STORE needs GAS and WATER (brine) phases")
            # brine is carried in the liquid (oil) slot, CO2 in the gas slot; dissolution is always on
            phases = {"water": False, "oil": True, "gas": True, "disgas": True,
                      "vapoil": "VAPWAT" in d or "VAPOIL" in d}
        if thermal and compositional:
            self.warn("THERMAL is only supported for black-oil models; the compositional run is isothermal")
            thermal = False
        if not phases["oil"]:
            raise ValueError("Models without an oil phase are not supported")
        # THERMAL with water and a gas phase that has no gas PVT table: the gas phase is steam
        steam = (thermal and not co2 and phases["water"] and phases["gas"]
                 and not any(k in d for k in ("PVDG", "PVTG")))
        if steam:
            if phases["disgas"] or phases["vapoil"]:
                self.warn("Steam runs use dead oil; DISGAS/VAPOIL ignored")
            phases["disgas"] = phases["vapoil"] = False

        # ---------------- grid & properties
        gp = GridProperties(nx, ny, nz, self.warn)
        coord = zcorn = None
        minpv = 1e-6
        pinch = None
        faults = {}          # fault name -> list of (low-side natural cell index, direction 'I'/'J'/'K')
        multflt = []         # (pattern, multiplier) in deck order
        for kw in d.keywords:
            if kw.name == "MULTFLT" and kw.section in ("GRID", "EDIT"):
                multflt.extend((str(r[0]), to_float(rec_get(r, 1), 1.0)) for r in kw.data if r)
                continue
            if kw.name == "MULTFLT" and kw.section == "SCHEDULE":
                self.warn("MULTFLT in SCHEDULE (changing fault multipliers during the run) is not supported; ignored")
                continue
            if kw.section not in ("GRID",):
                continue
            if kw.name == "COORD":
                coord = kw.data
            elif kw.name == "ZCORN":
                zcorn = kw.data
            elif kw.name in ("MINPV", "MINPORV"):
                minpv = units.to_si(to_float(kw.data[0][0], 1e-6), "volume")
            elif kw.name == "PINCH":
                r = kw.data[0] if kw.data else []
                pinch = {"threshold": to_float(rec_get(r, 0), 0.001) * units.to_si(1.0, "length"),
                         "gap": to_str(rec_get(r, 1), "GAP").upper() != "NOGAP",
                         "max_gap": to_float(rec_get(r, 2), 1e20) * units.to_si(1.0, "length"),
                         "trans": to_str(rec_get(r, 3), "TOPBOT").upper(),
                         "multz": to_str(rec_get(r, 4), "TOP").upper()}
            elif kw.name == "FAULTS":
                for r in kw.data:
                    if not r:
                        continue
                    name = str(r[0])
                    i1, i2, j1, j2, k1, k2 = (to_int(rec_get(r, m), 1) - 1 for m in range(1, 7))
                    face = to_str(rec_get(r, 7), "X").upper().replace("I", "X").replace("J", "Y").replace("K", "Z")
                    dirn = {"X": "I", "Y": "J", "Z": "K"}[face[0]]
                    minus = face.endswith("-")
                    for k in range(k1, k2 + 1):
                        for j in range(j1, j2 + 1):
                            for i in range(i1, i2 + 1):
                                ii, jj, kk = i, j, k
                                if minus:            # the X- face of a cell is the X+ face of its neighbour
                                    ii, jj, kk = (i - 1, j, k) if dirn == "I" else (i, j - 1, k) if dirn == "J" else (i, j, k - 1)
                                if ii >= 0 and jj >= 0 and kk >= 0:
                                    faults.setdefault(name.upper(), []).append((ii + nx * (jj + ny * kk), dirn))
            elif kw.name == "SPECGRID":
                r = kw.data[0] if kw.data else []
                sg = tuple(to_int(rec_get(r, m), 0) for m in range(3))
                if sg != (nx, ny, nz):
                    raise ValueError(f"SPECGRID dimensions {sg} differ from DIMENS {(nx, ny, nz)}")
                if to_int(rec_get(r, 3), 1) > 1:
                    self.warn("SPECGRID: more than one reservoir (NUMRES) is not supported; treated as one grid")
            elif kw.name == "COORDSYS":
                if kw.data is not None and len(kw.data) > 6 and to_str(kw.data[2], "COMP").upper() == "INCOMP":
                    pass    # single reservoir, completely contained in the grid: nothing to join
            elif not gp.process(kw):
                self._unhandled(kw)
        L = units.to_si(1.0, "length")
        if coord is not None and zcorn is not None:
            corners = corner_point_corners(nx, ny, nz, np.asarray(coord) * L, np.asarray(zcorn) * L)
            cp = True
        else:
            for req in ("DX", "DY", "DZ", "TOPS"):
                if not gp.has(req):
                    raise ValueError(f"Grid keyword {req} (or DXV/DYV/DZV, or COORD/ZCORN) missing")
            dz = gp.get("DZ")
            tops = gp.get("TOPS").copy()
            tz = tops.reshape((nx, ny, nz), order="F")
            dzz = dz.reshape((nx, ny, nz), order="F")
            for k in range(1, nz):
                miss = np.isnan(tz[:, :, k])
                tz[:, :, k][miss] = (tz[:, :, k - 1] + dzz[:, :, k - 1])[miss]
            corners = cartesian_corners(nx, ny, nz, gp.get("DX") * L, gp.get("DY") * L, dz * L,
                                        tz.ravel(order="F") * L)
            cp = False
        grid = Grid(nx, ny, nz, corners, gp.get("ACTNUM").astype(int), cp)
        grid.pillars = (np.asarray(coord, float).reshape((ny + 1, nx + 1, 6)).transpose(1, 0, 2) * L) if cp else None

        for req in ("PORO", "PERMX"):
            if not gp.has(req):
                raise ValueError(f"Grid keyword {req} missing")
        poro = np.nan_to_num(gp.get("PORO"))
        kx = np.nan_to_num(gp.get("PERMX")) * units.to_si(1.0, "perm")
        ky = (np.nan_to_num(gp.get("PERMY")) if gp.has("PERMY") else kx / units.to_si(1.0, "perm")) * units.to_si(1.0, "perm")
        kz = (np.nan_to_num(gp.get("PERMZ")) if gp.has("PERMZ") else kx / units.to_si(1.0, "perm")) * units.to_si(1.0, "perm")
        ntg = np.nan_to_num(gp.get("NTG"), nan=1.0)

        # transmissibilities (deck units so that EDIT operations apply naturally)
        tu = units.to_si(1.0, "transmissibility")
        tran = {}
        nnc = []          # non-neighbour connections: (cell a, cell b, T in SI, direction of the face)
        for dirn, face_p, face_m, perm, mult in (("I", "I+", "I-", kx * ntg, "MULTX"),
                                                 ("J", "J+", "J-", ky * ntg, "MULTY"),
                                                 ("K", "K+", "K-", kz, "MULTZ")):
            a, b = grid.neighbour_pairs(dirn)
            ta = grid.half_trans(face_p, perm)[a]
            tb = grid.half_trans(face_m, perm)[b]
            with np.errstate(divide="ignore", invalid="ignore"):
                t = np.where((ta > 0) & (tb > 0), ta * tb / (ta + tb), 0.0)
            full = np.zeros(grid.n_cells)
            mval = np.nan_to_num(gp.get(mult), nan=1.0)
            full[a] = t * mval[a]
            if cp and dirn in ("I", "J"):
                # displaced (faulted) column interfaces: exact face overlaps; same-layer overlaps
                # stay logical-neighbour connections, the others become NNCs
                faulted, fa, fb, farea = fault_overlaps(grid, grid.pillars, dirn)
                full[faulted] = 0.0
                if fa.size:
                    ha = half_trans_area(grid, fa, face_p, farea, perm)
                    hb = half_trans_area(grid, fb, face_m, farea, perm)
                    with np.errstate(divide="ignore", invalid="ignore"):
                        tf = np.where((ha > 0) & (hb > 0), ha * hb / (ha + hb), 0.0) * mval[fa]
                    step = 1 if dirn == "I" else nx
                    same = fb == fa + step
                    full[fa[same]] = tf[same]
                    for x, y, tv in zip(fa[~same], fb[~same], tf[~same]):
                        if tv > 0:
                            nnc.append((x, y, tv, dirn))
            tran[dirn] = full
        # fault transmissibility multipliers (MULTFLT on faces named in FAULTS)
        face_mult = {}
        for pat, mval in multflt:
            import fnmatch
            names = [n for n in faults if fnmatch.fnmatchcase(n, pat.upper())]
            if not names:
                self.warn(f"MULTFLT: fault {pat} is not defined in FAULTS")
            for n in names:
                for key in faults[n]:
                    face_mult[key] = face_mult.get(key, 1.0) * mval
        if face_mult:
            for (cell, dirn), mval in face_mult.items():
                tran[dirn][cell] *= mval
            step = {"I": 1, "J": nx}
            for n_i, (x, y, tv, dirn) in enumerate(nnc):
                f = face_mult.get((x, dirn), face_mult.get((y - step[dirn], dirn), 1.0))
                if f != 1.0:
                    nnc[n_i] = (x, y, tv * f, dirn)
        self.faults = faults
        # negative-direction multipliers MULTX- / MULTY- / MULTZ- (GRIDOPTS item 1 = YES): applied to the
        # connection on the minus face of the higher-index cell
        for dirn, key in (("I", "MULTX-"), ("J", "MULTY-"), ("K", "MULTZ-")):
            if gp.has(key):
                step = {"I": 1, "J": nx, "K": nx * ny}[dirn]
                mm = np.nan_to_num(gp.get(key), nan=1.0)
                a_, b_ = grid.neighbour_pairs(dirn)
                tran[dirn][a_] *= mm[b_]
                for n_i, (x, y, tv, dd) in enumerate(nnc):
                    if dd == dirn:
                        nnc[n_i] = (x, y, tv * mm[y], dd)
        # MULTREGT: transmissibility multipliers between regions (MULTNUM, FLUXNUM or OPERNUM)
        multregt = [r for kw in d.keywords if kw.name == "MULTREGT" and kw.section in ("GRID", "EDIT") for r in kw.data if r]
        if multregt:
            self._multregt(multregt, gp, grid, tran, [])          # NNCs: after PINCH, below
        gp.arrays["TRANX"] = tran["I"] / tu
        gp.arrays["TRANY"] = tran["J"] / tu
        gp.arrays["TRANZ"] = tran["K"] / tu
        # pore volume
        pv_full = grid.volume * poro * ntg * np.nan_to_num(gp.get("MULTPV"), nan=1.0)
        gp.arrays["PORV"] = pv_full / units.to_si(1.0, "volume")

        for kw in d.keywords:
            if kw.section in ("EDIT", "PROPS", "REGIONS", "SOLUTION"):
                if kw.section == "SOLUTION" and kw.name in ("EQUIL", "RSVD", "PBVD", "ZMFVD", "TEMPVD"):
                    continue
                if not gp.process(kw):
                    if kw.section not in ("SOLUTION", "PROPS"):
                        self._unhandled(kw)
        pv_full = np.nan_to_num(gp.get("PORV")) * units.to_si(1.0, "volume")
        active = (grid.actnum > 0) & (pv_full > minpv)
        if pinch is not None:
            # vertical connections across pinched-out (thin) cells, and with GAP across cells removed by MINPV
            thick = grid.cell_dims()[2]
            bridge = (thick < pinch["threshold"]) | (pinch["gap"] & (grid.actnum > 0) & ~active)
            pu, pl = pinch_connections(grid, active, bridge, thick, pinch["max_gap"])
            if pu.size:
                tu_half = grid.half_trans("K+", kz)[pu]
                tl_half = grid.half_trans("K-", kz)[pl]
                with np.errstate(divide="ignore", invalid="ignore"):
                    tp = np.where((tu_half > 0) & (tl_half > 0), tu_half * tl_half / (tu_half + tl_half), 0.0)
                mz = np.nan_to_num(gp.get("MULTZ"), nan=1.0)
                for x, y, tv in zip(pu, pl, tp):
                    if pinch["multz"] == "ALL":
                        col = np.arange(x, y, nx * ny)
                        tv *= mz[col].min()
                    else:
                        tv *= mz[x]
                    if tv > 0:
                        nnc.append((x, y, tv, "K"))
                self.warn(f"PINCH: {pu.size} vertical connections across pinched-out cells") if pu.size else None
        if multregt and nnc:
            self._multregt(multregt, gp, grid, None, nnc)
        g2a = np.full(grid.n_cells, -1, int)
        act_cells = np.nonzero(active)[0]
        g2a[act_cells] = np.arange(act_cells.size)

        conn_a, conn_b, conn_T, conn_k = [], [], [], []
        if thermal:
            kq = units.to_si(1.0, "thermal_conductivity")
            if gp.has("THCONR"):
                thcon = np.nan_to_num(gp.get("THCONR")) * kq
            else:
                self.warn("THCONR missing; using a thermal conductivity of 2.0 W/m/K")
                thcon = np.full(grid.n_cells, 2.0)
        for dirn, key, fp, fm in (("I", "TRANX", "I+", "I-"), ("J", "TRANY", "J+", "J-"), ("K", "TRANZ", "K+", "K-")):
            a, b = grid.neighbour_pairs(dirn)
            t = np.nan_to_num(gp.get(key))[a] * tu
            ok = active[a] & active[b] & (t > 0)
            conn_a.append(g2a[a[ok]])
            conn_b.append(g2a[b[ok]])
            conn_T.append(t[ok])
            if thermal:
                ka = grid.half_trans(fp, thcon)[a]
                kb = grid.half_trans(fm, thcon)[b]
                with np.errstate(divide="ignore", invalid="ignore"):
                    kc = np.where((ka > 0) & (kb > 0), ka * kb / (ka + kb), 0.0)
                conn_k.append(kc[ok])

        # non-neighbour connections (fault juxtapositions, PINCH); as ECLIPSE and OPM, NNCs with a
        # transmissibility below 1e-6 (deck units) are dropped
        nnc_kept = []
        t_min = 1e-6 * tu
        for x, y, tv, dirn in nnc:
            if active[x] and active[y] and tv >= t_min:
                conn_a.append(np.array([g2a[x]]))
                conn_b.append(np.array([g2a[y]]))
                conn_T.append(np.array([tv]))
                nnc_kept.append((x, y, tv, dirn))
                if thermal:
                    conn_k.append(np.array([0.0]))
        self.nnc = nnc_kept

        def region(name):
            arr = gp.get(name)
            return (np.nan_to_num(arr, nan=1).astype(int) - 1)[act_cells]

        model = SimulationModel(
            deck=d, case_name=d.case_name,
            title=" ".join(map(str, d.get("TITLE").data[0])) if d.get("TITLE") and d.get("TITLE").data else d.case_name,
            units=units, start_date=parse_start(d), grid=grid, active=active, global_to_active=g2a,
            active_cells=act_cells, pore_volume=pv_full[act_cells], depth=grid.depth[act_cells],
            conn_a=np.concatenate(conn_a), conn_b=np.concatenate(conn_b), conn_T=np.concatenate(conn_T),
            perm=(kx, ky, kz), ntg=ntg, phases=phases,
            fluid_type="compositional" if compositional else "blackoil",
            rock=[], rocknum=region("PVTNUM"), pvtnum=region("PVTNUM"), satnum=region("SATNUM"),
            eqlnum=region("EQLNUM"),
        )
        model.co2store = co2
        model.steam = steam
        model.nnc = self.nnc                 # [(natural cell a, natural cell b, T in SI, direction)]
        model.faults = self.faults
        # ROCKOPTS: which region array selects the ROCK table, and STORE (reference pressure = initial pressure)
        ro = d.get("ROCKOPTS")
        rr = ro.data[0] if ro is not None and ro.data else []
        rock_region = to_str(rec_get(rr, 2), "PVTNUM").upper()
        if rock_region not in ("PVTNUM", "SATNUM", "ROCKNUM"):
            self.warn(f"ROCKOPTS: unknown table selector {rock_region}; using PVTNUM")
            rock_region = "PVTNUM"
        model.rocknum = region(rock_region)
        model.fipnum = region("FIPNUM")
        model.rock_store = to_str(rec_get(rr, 1), "NOSTORE").upper() == "STORE"
        if to_str(rec_get(rr, 0), "PRESSURE").upper() == "STRESS":
            self.warn("ROCKOPTS: STRESS option not supported; rock compaction uses pressure")
        self._props(model)
        self._satfunc(model, gp)
        if thermal:
            self._thermal(model, gp, np.concatenate(conn_k))
        self._solution(model, gp)
        self._tracers(model)
        self._schedule(model)
        self._summary(model)
        for kw in d.keywords:
            if kw.section in ("RUNSPEC", "PROPS", "SCHEDULE") and kw.name not in HANDLED and kw.name not in (
                    "RUNSPEC", "GRID", "EDIT", "PROPS", "REGIONS", "SOLUTION", "SUMMARY", "SCHEDULE"):
                self._unhandled(kw)
        model.warnings = self.warnings
        return model

    def _multregt(self, records, gp, grid, tran, nnc):
        """Apply MULTREGT records. For each region pair the last record wins; region numbers that are
        defaulted or negative match every region; only connections between different regions change."""
        nx, ny = grid.nx, grid.ny
        arrays = {}
        rules = []           # (r1 or None, r2 or None, mult, dirs, nnc_mode, region array)
        for r in records:
            r1, r2 = to_int(rec_get(r, 0), -1), to_int(rec_get(r, 1), -1)
            mult = to_float(rec_get(r, 2), 1.0)
            dirs = to_str(rec_get(r, 3), "XYZ").upper()
            mode = to_str(rec_get(r, 4), "ALL").upper()
            reg = to_str(rec_get(r, 5), "M").upper()[:1]
            name = {"M": "MULTNUM", "F": "FLUXNUM", "O": "OPERNUM"}.get(reg, "MULTNUM")
            if name not in arrays:
                if not gp.has(name):
                    self.warn(f"MULTREGT uses {name}, which is not defined; all cells are in region 1")
                arrays[name] = np.nan_to_num(gp.get(name, np.ones(grid.n_cells)), nan=1).astype(int)
            rules.append((r1 if r1 > 0 else None, r2 if r2 > 0 else None, mult,
                          {c for c in dirs if c in "XYZ"}, mode, name))
        dmap = {"I": "X", "J": "Y", "K": "Z"}

        def factor(ra, rb, dirn, is_nnc, name):
            """Multiplier per connection (arrays ra, rb) from the last matching rule."""
            out = np.ones(ra.size)
            done = np.zeros(ra.size, bool)
            for r1, r2, mult, dirs, mode, nm in reversed(rules):
                if nm != name or dmap[dirn] not in dirs:
                    continue
                if (mode == "NNC" and not is_nnc) or (mode == "NONNC" and is_nnc):
                    continue
                m1 = np.ones(ra.size, bool) if r1 is None else None
                hit = ra != rb
                fwd = (np.ones(ra.size, bool) if r1 is None else ra == r1) & (np.ones(ra.size, bool) if r2 is None else rb == r2)
                bwd = (np.ones(ra.size, bool) if r1 is None else rb == r1) & (np.ones(ra.size, bool) if r2 is None else ra == r2)
                sel = hit & (fwd | bwd) & ~done
                out[sel] = mult
                done |= sel
            return out

        for name, reg in arrays.items():
            for dirn in ("I", "J", "K"):
                if tran is None:
                    break
                a_, b_ = grid.neighbour_pairs(dirn)
                f_ = factor(reg[a_], reg[b_], dirn, False, name)
                tran[dirn][a_] *= f_
            if nnc:
                xs = np.array([c[0] for c in nnc]); ys = np.array([c[1] for c in nnc])
                ds = np.array([c[3] for c in nnc])
                fac = np.ones(len(nnc))
                for dirn in ("I", "J", "K"):
                    sel = ds == dirn
                    if sel.any():
                        fac[sel] = factor(reg[xs[sel]], reg[ys[sel]], dirn, True, name)
                for n_i in np.nonzero(fac != 1.0)[0]:
                    x, y, tv, dd = nnc[n_i]
                    nnc[n_i] = (x, y, tv * fac[n_i], dd)

    def _unhandled(self, kw):
        if kw.section == "SCHEDULE" and hasattr(ScheduleBuilder, "_kw_" + kw.name.replace("-", "_")):
            return
        if kw.name in HANDLED or kw.name in ("RUNSPEC", "GRID", "EDIT", "PROPS", "REGIONS", "SOLUTION", "SUMMARY",
                                             "SCHEDULE"):
            return
        self.warn(f"Keyword {kw.name} ({kw.section}) is not supported and was ignored")

    # ----------------------------------------------------------------------
    def _tables(self, name, ncol):
        """Numbered tables reshaped to (rows, ncol); defaulted entries are interpolated."""
        kw = self.deck.get(name)
        if kw is None:
            return None
        out = []
        for t in kw.data:
            if t.size % ncol:
                raise ValueError(f"{name}: table size {t.size} not a multiple of {ncol}")
            t = t.reshape(-1, ncol).copy()
            for c in range(ncol):
                col = t[:, c]
                bad = np.isnan(col)
                if bad.any() and (~bad).sum() >= 1:
                    col[bad] = np.interp(np.nonzero(bad)[0], np.nonzero(~bad)[0], col[~bad])
            out.append(t)
        return out

    def _records(self, name, ncol):
        """One record per region, padded to ncol with NaN for defaults."""
        kw = self.deck.get(name)
        if kw is None:
            return None
        out = []
        for t in kw.data:
            row = np.full(ncol, np.nan)
            row[: min(ncol, t.size)] = t[:ncol]
            out.append(row)
        return out

    def _props(self, model):
        u = self.u
        d = self.deck
        P = u.to_si(1.0, "pressure")
        ph = model.phases
        # ---- saturation functions
        swof = self._tables("SWOF", 4)
        sgof = self._tables("SGOF", 4)
        swfn = self._tables("SWFN", 3)
        sgfn = self._tables("SGFN", 3)
        sof3 = self._tables("SOF3", 3)
        sof2 = self._tables("SOF2", 2)
        if model.co2store:
            swof, sgof = None, self._co2_sgof(sgof, swfn, sgfn)
            swfn = sgfn = sof3 = sof2 = None
        nsat = max(len(t) for t in (swof, sgof, swfn, sgfn, sof3, sof2, [None]) if t is not None)
        sats = []
        for r in range(nsat):
            def pick(tabs):
                return None if tabs is None else tabs[min(r, len(tabs) - 1)]
            wo, go = pick(swof), pick(sgof)
            if wo is None and go is None and (pick(swfn) is not None or pick(sgfn) is not None):
                wo, go = family2_to_family1(pick(swfn), pick(sgfn), pick(sof3), pick(sof2))
            if ph["water"] and wo is None:
                self.warn("No water-oil saturation table (SWOF/SWFN); using Corey defaults")
                wo = default_swof()
            if ph["gas"] and go is None:
                self.warn("No gas-oil saturation table (SGOF/SGFN); using Corey defaults")
                go = default_sgof()
            if wo is not None:
                wo = wo.copy()
                wo[:, 3] *= P
            if go is not None:
                go = go.copy()
                go[:, 3] *= P
            if wo is None:
                wo = np.array([[0.0, 0.0, 1.0, 0.0], [1.0, 1.0, 0.0, 0.0]])
            sats.append(SaturationTable(wo, go))
        model.sat = sats
        model.satnum = np.clip(model.satnum, 0, len(sats) - 1)

        # ---- densities
        dens = self._records("DENSITY", 3)
        grav = self._records("GRAVITY", 3)
        ntpvt = 1
        for name in ("PVTO", "PVDO", "PVCDO", "PVDG", "PVTW", "DENSITY"):
            kw = d.get(name)
            if kw is not None:
                ntpvt = max(ntpvt, len(kw.data))
        densities = []
        for r in range(ntpvt):
            if dens is not None:
                row = dens[min(r, len(dens) - 1)]
                defaults = (600.0, 999.014, 1.0) if u.name == "METRIC" else (37.457, 62.366, 0.062428)
                o, w, g = (u.to_si(v if np.isfinite(v) else dv, "density") for v, dv in zip(row, defaults))
            elif grav is not None:
                api, sw, sg = np.nan_to_num(grav[min(r, len(grav) - 1)], nan=1.0)
                o = 141.5 / (api + 131.5) * 999.014
                w = sw * 999.014
                g = sg * 1.2232
            else:
                if not model.co2store:
                    self.warn("DENSITY missing; using defaults (oil 800, water 1000, gas 1 kg/m3)")
                o, w, g = 800.0, 1000.0, 1.0
            densities.append((o, w, g))

        # ---- water
        pvtw = self._records("PVTW", 5)
        waters = []
        for r in range(ntpvt):
            if pvtw is not None:
                row = pvtw[min(r, len(pvtw) - 1)]
                waters.append(ConstCompressibilityFluid(row[0] * P, row[1], u.to_si(row[2], "compressibility"),
                                                        u.to_si(row[3], "viscosity"),
                                                        u.to_si(np.nan_to_num(row[4]), "viscosibility")))
            else:
                if ph["water"]:
                    self.warn("PVTW missing; using default water properties")
                waters.append(ConstCompressibilityFluid(ATM, 1.0, 4.5e-10, 0.5e-3, 0.0))
        # ---- rock
        rock = self._records("ROCK", 2)
        model.rock = []
        for r in range(max(ntpvt, len(rock) if rock else 1)):
            if rock:
                pr, cr = np.nan_to_num(rock[min(r, len(rock) - 1)])
                model.rock.append((pr * P, u.to_si(cr, "compressibility")))
            else:
                model.rock.append((ATM, 0.0))
        model.pvtnum = np.clip(model.pvtnum, 0, ntpvt - 1)
        model.rocknum = np.clip(model.rocknum, 0, len(model.rock) - 1)

        if model.fluid_type == "compositional":
            self._eos(model, densities, waters)
            return

        if model.co2store:
            self._co2_pvt(model)
            return

        # ---- black oil PVT
        pvto = d.get("PVTO")
        pvdo = self._tables("PVDO", 3)
        pvcdo = self._records("PVCDO", 5)
        pvdg = self._tables("PVDG", 3)
        pvtg = d.get("PVTG")
        pvts = []
        rs_u = u.to_si(1.0, "rs")
        bg_u = u.to_si(1.0, "bg")
        mu_u = u.to_si(1.0, "viscosity")
        for r in range(ntpvt):
            if pvto is not None and ph["disgas"]:
                recs = []
                for rec in pvto.data[min(r, len(pvto.data) - 1)]:
                    rec = [v for v in rec if not np.isnan(v)]
                    rows = np.asarray(rec[1:], float).reshape(-1, 3)
                    rows[:, 0] *= P
                    rows[:, 2] *= mu_u
                    recs.append([rec[0] * rs_u] + list(rows.ravel()))
                oil = LiveOil(recs)
            elif pvdo is not None:
                t = pvdo[min(r, len(pvdo) - 1)]
                oil = DeadOil(TabulatedFluid(t[:, 0] * P, t[:, 1], t[:, 2] * mu_u))
            elif pvcdo is not None:
                row = pvcdo[min(r, len(pvcdo) - 1)]
                oil = DeadOil(ConstCompressibilityFluid(row[0] * P, row[1], u.to_si(row[2], "compressibility"),
                                                        row[3] * mu_u, u.to_si(np.nan_to_num(row[4]), "viscosibility")))
            elif pvto is not None:
                self.warn("PVTO given without DISGAS; oil treated as dead oil at the lowest Rs")
                rec = [v for v in pvto.data[0][0] if not np.isnan(v)]
                rows = np.asarray(rec[1:], float).reshape(-1, 3)
                oil = DeadOil(TabulatedFluid(rows[:, 0] * P, rows[:, 1], rows[:, 2] * mu_u))
            else:
                raise ValueError("No oil PVT (PVTO, PVDO or PVCDO) found")
            gas = None
            rv_u = u.to_si(1.0, "rv")
            if ph["gas"]:
                if pvtg is not None and ph["vapoil"]:
                    recs = []
                    for rec in pvtg.data[min(r, len(pvtg.data) - 1)]:
                        rec = [v for v in rec if not np.isnan(v)]
                        rows = np.asarray(rec[1:], float).reshape(-1, 3)
                        rows[:, 0] *= rv_u
                        rows[:, 1] *= bg_u
                        rows[:, 2] *= mu_u
                        recs.append([rec[0] * P] + list(rows.ravel()))
                    gas = WetGas(recs)
                elif pvdg is not None:
                    t = pvdg[min(r, len(pvdg) - 1)]
                    gas = DryGas(TabulatedFluid(t[:, 0] * P, t[:, 1] * bg_u, t[:, 2] * mu_u))
                elif pvtg is not None:
                    self.warn("PVTG given without VAPOIL; gas treated as dry gas (saturated rows)")
                    rows = []
                    for rec in pvtg.data[min(r, len(pvtg.data) - 1)]:
                        rec = [v for v in rec if not np.isnan(v)]
                        rows.append((rec[0], rec[2], rec[3]))
                    rows = np.array(rows)
                    gas = DryGas(TabulatedFluid(rows[:, 0] * P, rows[:, 1] * bg_u, rows[:, 2] * mu_u))
                elif model.steam:
                    gas = SteamGas(densities[r][1])
                else:
                    raise ValueError("GAS phase active but no PVDG/PVTG table")
            o, w, g = densities[r]
            if model.steam:
                g = w            # steam volumes are reported as cold-water equivalent
            pvts.append(BlackOilPVT(waters[r], oil, gas, o, w, g))
        model.pvt = pvts
        model.phases["disgas"] = model.phases["disgas"] and all(p.live for p in pvts)
        if model.phases["vapoil"] and not all(isinstance(p.gas, WetGas) for p in pvts):
            self.warn("VAPOIL needs PVTG wet-gas tables; vaporised oil disabled")
            model.phases["vapoil"] = False

    def _temperature(self, model):
        """Reservoir temperature from RTEMP / TEMPI / RTEMPVD / TEMPVD (K)."""
        d, u = self.deck, self.u
        if d.get("RTEMP"):
            return u.to_si(to_float(d.get("RTEMP").data[0][0]), "temperature")
        if d.get("TEMPI") is not None:
            return u.to_si(float(np.nanmean(d.get("TEMPI").data)), "temperature")
        for name in ("RTEMPVD", "TEMPVD"):
            if d.get(name) is not None:
                return u.to_si(float(np.mean(d.get(name).data[0][1::2])), "temperature")
        self.warn("Reservoir temperature (RTEMP) missing; using 100 C")
        return 373.15

    def _co2_sgof(self, sgof, swfn, sgfn):
        """CO2-brine saturation functions as SGOF-style tables (Sg, krg, kr_brine, Pc)."""
        if sgof is not None:
            return sgof
        sgwfn = self._tables("SGWFN", 4)
        if sgwfn is not None:
            return [t.copy() for t in sgwfn]
        wsf, gsf = self._tables("WSF", 2), self._tables("GSF", 3)
        if wsf is None and swfn is not None:
            wsf = [t[:, :2] for t in swfn]
        if gsf is None and sgfn is not None:
            gsf = sgfn
        if wsf is not None and gsf is not None:
            out = []
            for r in range(max(len(wsf), len(gsf))):
                w, g = wsf[min(r, len(wsf) - 1)], gsf[min(r, len(gsf) - 1)]
                sg = g[:, 0]
                krl = np.interp(1.0 - sg, w[:, 0], w[:, 1])
                out.append(np.column_stack([sg, g[:, 1], krl, g[:, 2]]))
            return out
        self.warn("CO2STORE: no gas-brine saturation functions (SGOF, SGWFN, WSF/GSF); using Corey defaults")
        return None

    def _co2_pvt(self, model):
        from .props.co2brine import CO2BrineSystem
        d = self.deck
        model.temperature = self._temperature(model)
        sal = d.get("SALINITY")
        model.salinity = to_float(sal.data[0][0], 0.0) if sal and sal.data and sal.data[0] else 0.0
        p_max = 1.0e8
        for eq in d.get_all("EQUIL"):
            for rec in eq.data:
                if rec:
                    p_max = max(p_max, 3.0 * self.u.to_si(to_float(rec_get(rec, 1), 0.0), "pressure"))
        sysm = CO2BrineSystem(model.temperature, model.salinity, p_max=p_max, vapwat=model.phases["vapoil"])
        model.co2_system = sysm
        model.pvt = [BlackOilPVT(None, sysm.brine, sysm.gas, sysm.rho_bs, sysm.rho_bs, sysm.rho_gs)]
        model.pvtnum = np.zeros_like(model.pvtnum)

    def _thermal(self, model, gp, conn_k):
        """Energy-equation data: heat capacities, conductivity, viscosity(T), expansion, initial T."""
        d, u = self.deck, self.u
        Tq = lambda v: u.to_si(v, "temperature")
        t_ref = model.temperature if model.co2store else self._temperature(model)
        model.temperature = t_ref
        th = {"t_ref": t_ref, "conn_k": conn_k, "visc": {}}
        # fluid specific heats (J/kg/K) vs temperature
        spec = self._tables("SPECHEAT", 4)
        cpu = u.to_si(1.0, "specific_heat")
        defaults = {"o": 2100.0, "w": 4180.0, "g": 1100.0}
        cp = {}
        for col, ph in ((1, "o"), (2, "w"), (3, "g")):
            if model.steam and ph == "w":
                cp[ph] = steam_props.liquid_cp      # steam runs: IAPWS-IF97 liquid enthalpy
                continue
            if model.steam and ph == "g" and spec is None:
                cp[ph] = lambda T: (np.full_like(np.asarray(T, float), 2.0e3), np.zeros_like(np.asarray(T, float)))
                continue                            # superheated steam
            if spec is not None:
                t = spec[0]
                tt, cc = Tq(t[:, 0]), t[:, col] * cpu
                cp[ph] = (lambda T, tt=tt, cc=cc: _interp(T, tt, cc, "constant"))
            else:
                c0 = defaults[ph]
                cp[ph] = (lambda T, c0=c0: (np.full_like(np.asarray(T, float), c0), np.zeros_like(np.asarray(T, float))))
        if spec is None and model.steam:
            self.warn("SPECHEAT missing; using an oil specific heat of 2.1 kJ/kg/K")
        elif spec is None:
            self.warn("SPECHEAT missing; using specific heats oil 2.1, water 4.18, gas 1.1 kJ/kg/K")
        th["cp"] = cp
        # rock heat capacity per unit rock volume
        if gp.has("HEATCR"):
            heatcr = np.nan_to_num(gp.get("HEATCR")) * u.to_si(1.0, "volumetric_heat_capacity")
        else:
            self.warn("HEATCR missing; using a rock heat capacity of 2.5 MJ/m3/K")
            heatcr = np.full(model.grid.n_cells, 2.5e6)
        rock_vol = np.maximum(model.grid.volume[model.active_cells] - model.pore_volume, 0.0)
        th["rock_heat"] = rock_vol * heatcr[model.active_cells]
        # viscosity versus temperature
        for name, ph in (("OILVISCT", "o"), ("WATVISCT", "w"), ("GASVISCT", "g")):
            kw = d.get(name)
            if kw is not None:
                t = np.asarray(kw.data[0], float)
                t = t[~np.isnan(t)].reshape(-1, 2)
                th["visc"][ph] = TemperatureFunction(Tq(t[:, 0]), t[:, 1], t_ref)
        wd = self._records("WATDENT", 3)
        if wd is not None:
            row = np.nan_to_num(wd[0])
            dtu = u.to_si(1.0, "temperature") - u.to_si(0.0, "temperature")
            th["watdent"] = (Tq(row[0]), row[1] / dtu, row[2] / dtu ** 2)
        elif model.steam:
            th["water_expansion"] = steam_props.liquid_density_ratio     # saturated-liquid density
        # initial temperature
        if gp.has("TEMPI"):
            T0 = Tq(gp.get("TEMPI"))[model.active_cells]
        else:
            tv = self._tables("RTEMPVD", 2) or self._tables("TEMPVD", 2)
            if tv is not None:
                t = tv[0]
                T0 = np.interp(model.depth, t[:, 0] * u.to_si(1.0, "length"), Tq(t[:, 1]))
            else:
                T0 = np.full(model.n_active, t_ref)
        th["T_init"] = T0
        model.thermal = th

    def _eos(self, model, densities, waters):
        d, u = self.deck, self.u
        nc = to_int(d.get("COMPS").data[0][0])

        def arr(name, required=True, default=None):
            kw = d.get(name)
            if kw is None:
                if required:
                    raise ValueError(f"Compositional keyword {name} missing")
                return default
            a = np.asarray(kw.data, float) if not isinstance(kw.data, list) else np.asarray(kw.data)
            return a[:nc] if name != "BIC" else a

        names = d.get("CNAMES").data[:nc] if d.get("CNAMES") else [f"C{i + 1}" for i in range(nc)]
        tc = arr("TCRIT") * u.to_si(1.0, "abs_temperature")
        pc = arr("PCRIT") * u.to_si(1.0, "pressure")
        acf = arr("ACF")
        mw = arr("MW") / 1000.0
        vc = arr("VCRIT", False)
        zc = arr("ZCRIT", False)
        if vc is not None:
            vc = vc * u.to_si(1.0, "molar_volume")
        elif zc is not None:
            vc = zc * 8.314462618 * tc / pc
        bic = np.zeros((nc, nc))
        b = arr("BIC", False)
        if b is not None:
            m = 0
            for i in range(1, nc):
                for j in range(i):
                    if m < b.size:
                        bic[i, j] = bic[j, i] = np.nan_to_num(b[m])
                    m += 1
        eos_kind = "PR"
        if d.get("EOS") and d.get("EOS").data and d.get("EOS").data[0]:
            eos_kind = str(d.get("EOS").data[0][0]).upper()
            if eos_kind not in ("PR", "SRK", "PR3", "RK"):
                self.warn(f"EOS {eos_kind} not supported; using PR")
                eos_kind = "PR"
        model.eos = CubicEOS(tc, pc, acf, mw, bic, vc, "SRK" if eos_kind in ("SRK", "RK") else "PR",
                             arr("OMEGAA", False), arr("OMEGAB", False), arr("SSHIFT", False), list(names))
        if d.get("RTEMP"):
            model.temperature = u.to_si(to_float(d.get("RTEMP").data[0][0]), "temperature")
        elif d.get("TEMPI") is not None:
            model.temperature = u.to_si(float(np.nanmean(d.get("TEMPI").data)), "temperature")
        elif d.get("TEMPVD") is not None:
            model.temperature = u.to_si(float(np.mean(d.get("TEMPVD").data[0][1::2])), "temperature")
        else:
            self.warn("Reservoir temperature (RTEMP) missing; using 100 C")
        if d.get("STCOND"):
            rec = d.get("STCOND").data[0]
            model.std_cond = (u.to_si(to_float(rec_get(rec, 0), 15.56 if u.name == "METRIC" else 60.0), "temperature"),
                              u.to_si(to_float(rec_get(rec, 1), 1.01325 if u.name == "METRIC" else 14.696), "pressure"))
        zi = arr("ZI", False)
        model.zi = None if zi is None else zi / zi.sum()
        model.water_pvt = waters[0]
        model.rho_ws = densities[0][1]
        zmf = self._tables("ZMFVD", nc + 1)
        if zmf is not None:
            model.zmfvd = [t.copy() for t in zmf]
            for t in model.zmfvd:
                t[:, 0] *= u.to_si(1.0, "length")

    def _satfunc(self, model, gp):
        """Per-cell saturation functions: ENDSCALE end points, SATOPTS HYSTER / EHYSTR, SWATINIT."""
        d = self.deck
        ac = model.active_cells
        P = self.u.to_si(1.0, "pressure")
        es = d.get("ENDSCALE")
        so = d.get("SATOPTS")
        sat_opts = {str(v).upper() for v in (so.data[0] if so is not None and so.data else []) if v is not None}
        hyster = "HYSTER" in sat_opts
        if "DIRECT" in sat_opts:
            self.warn("SATOPTS DIRECT: directional saturation tables are not supported; KRNUM is not used")
        es_opts = [to_str(v, "").upper() for v in (es.data[0] if es is not None and es.data else [])]
        if "DIRECT" in es_opts:
            self.warn("ENDSCALE DIRECT: directional end points are not supported; non-directional scaling used")
        if "IRREVERS" in es_opts:
            self.warn("ENDSCALE IRREVERS: irreversible scaling is treated as reversible")
        sc = d.get("SCALECRS")
        scalecrs = sc is not None and sc.data and to_str(rec_get(sc.data[0], 0), "NO").upper().startswith("Y")

        def arr(name):
            a = gp.get(name)
            return None if a is None else np.asarray(a, float)[ac]

        cell_ep = cell_iep = None
        if es is not None:
            cell_ep = {k: arr(k) for k in EP_NAMES}
            cell_iep = {k: arr("I" + k) for k in EP_NAMES}
            for k in ("KRW", "KRO", "KRG", "KRWR", "KRGR", "KRORW", "KRORG", "SWLPC", "SGLPC"):
                if gp.has(k) or gp.has("I" + k):
                    self.warn(f"ENDSCALE: {k} (vertical / capillary end-point scaling) is not supported and was ignored")
        hyst = None
        imbnum = None
        if hyster:
            eh = d.get("EHYSTR")
            rec = eh.data[0] if eh is not None and eh.data else []
            what = to_str(rec_get(rec, 4), "BOTH").upper()
            hyst = {"model": to_int(rec_get(rec, 1), 0), "kr": what in ("BOTH", "KR"),
                    "pc": what in ("BOTH", "PC"), "eps": to_float(rec_get(rec, 0), 0.1) or 0.1}
            if what not in ("BOTH", "KR", "PC"):
                self.warn(f"EHYSTR item 5 {what}: not recognised; both relative permeability and capillary "
                          "pressure hysteresis used")
                hyst["kr"] = hyst["pc"] = True
            if hyst["model"] in (1, 3, 4):
                self.warn(f"EHYSTR model {hyst['model']}: wetting-phase imbibition curves are not modelled; "
                          "the wetting phases follow their drainage curves")
            if hyst["model"] < 0 or hyst["model"] > 4:
                self.warn(f"EHYSTR model {hyst['model']} is not supported; Carlson's model used")
                hyst["model"] = 0
            im = gp.get("IMBNUM")
            imbnum = model.satnum.copy() if im is None else np.clip(
                np.nan_to_num(np.asarray(im, float)[ac], nan=1).astype(int) - 1, 0, len(model.sat) - 1)
        elif d.get("EHYSTR") is not None:
            self.warn("EHYSTR given without SATOPTS HYSTER; hysteresis is off")
        ipcw = arr("IPCW") if es is not None and gp.has("IPCW") else None
        ipcg = arr("IPCG") if es is not None and gp.has("IPCG") else None
        pcw = arr("PCW") if es is not None and gp.has("PCW") else None
        pcg = arr("PCG") if es is not None and gp.has("PCG") else None
        model.satfunc = SatFunctions(model.sat, model.satnum, model.phases["water"], model.phases["gas"],
                                     cell_ep=cell_ep, scalecrs=bool(scalecrs), imbnum=imbnum, cell_iep=cell_iep,
                                     hysteresis=hyst, pcw=None if pcw is None else pcw * P,
                                     pcg=None if pcg is None else pcg * P,
                                     ipcw=None if ipcw is None else ipcw * P,
                                     ipcg=None if ipcg is None else ipcg * P)
        model.swatinit = arr("SWATINIT") if gp.has("SWATINIT") else None
        if model.swatinit is not None and not model.phases["water"]:
            model.swatinit = None

    def _tracers(self, model):
        """Passive tracers (TRACERS / TRACER) and their initial concentrations (TVDPF<name>)."""
        d = self.deck
        L = self.u.to_si(1.0, "length")
        for kw in d.get_all("TRACER"):
            for rec in kw.data:
                if not rec:
                    continue
                name = to_str(rec[0]).upper()
                phase = to_str(rec_get(rec, 1, "WAT")).upper()[:3]
                if phase not in ("WAT", "OIL", "GAS"):
                    self.warn(f"TRACER {name}: phase {phase} not supported; tracer ignored")
                    continue
                if rec_get(rec, 3) is not None or rec_get(rec, 4) is not None:
                    self.warn(f"TRACER {name}: partitioned tracers are not supported; treated as a free tracer")
                model.tracers.append({"name": name, "phase": phase})
        for t in model.tracers:
            tabs = self._tables("TVDPF" + t["name"], 2)
            if tabs:
                t["init"] = [np.column_stack([tb[:, 0] * L, tb[:, 1]]) for tb in tabs]
            if d.get("TVDPS" + t["name"]) is not None:
                self.warn(f"TVDPS{t['name']}: solution-phase tracer concentrations are not supported")
        if model.tracers and d.get("TRACERS") is None:
            self.warn("TRACER given without TRACERS in RUNSPEC")

    def _solution(self, model, gp):
        d, u = self.deck, self.u
        P = u.to_si(1.0, "pressure")
        L = u.to_si(1.0, "length")
        for kw in d.get_all("EQUIL"):
            for rec in kw.data:
                if not rec:
                    continue
                model.equil.append({
                    "datum": to_float(rec_get(rec, 0), 0.0) * L,
                    "p_datum": to_float(rec_get(rec, 1), 0.0) * P,
                    "woc": to_float(rec_get(rec, 2), 1e10) * L if rec_get(rec, 2) is not None else None,
                    "pcow_woc": to_float(rec_get(rec, 3), 0.0) * P,
                    "goc": to_float(rec_get(rec, 4), -1e10) * L if rec_get(rec, 4) is not None else None,
                    "pcgo_goc": to_float(rec_get(rec, 5), 0.0) * P,
                    # item 7: > 0 use the region's RSVD/PBVD table, <= 0 saturated at the GOC; item 8 likewise RVVD
                    "rsvd": to_int(rec_get(rec, 6), 1) > 0 if rec_get(rec, 6) is not None else None,
                    "rvvd": to_int(rec_get(rec, 7), 1) > 0 if rec_get(rec, 7) is not None else None,
                })
                if to_int(rec_get(rec, 8), 0) != 0:
                    self.warn("EQUIL item 9 (fine equilibration) is not supported; cell-centre equilibration used")
        for name, dest, q in (("RSVD", model.rsvd, "rs"), ("PBVD", model.pbvd, "pressure"), ("RVVD", model.rvvd, "rv")):
            tabs = self._tables(name, 2)
            if tabs:
                for t in tabs:
                    t = t.copy()
                    t[:, 0] *= L
                    t[:, 1] = u.to_si(t[:, 1], q)
                    dest.append(t)
        for name, q in (("PRESSURE", "pressure"), ("SWAT", None), ("SGAS", None), ("RS", "rs"), ("RV", "rv"), ("PBUB", "pressure")):
            if gp.has(name):
                v = gp.get(name)[model.active_cells]
                model.explicit_init[name] = u.to_si(v, q) if q else v
        # threshold pressures between equilibration regions
        eo = d.get("EQLOPTS")
        eqlopts = {str(v).upper() for v in (eo.data[0] if eo is not None and eo.data else []) if v is not None}
        model.thpres_irrevers = "IRREVERS" in eqlopts
        for opt in eqlopts - {"THPRES", "IRREVERS"}:
            self.warn(f"EQLOPTS {opt} is not supported and was ignored")
        thp = {}
        for kw in d.get_all("THPRES"):
            for rec in kw.data:
                if not rec:
                    continue
                i, j = to_int(rec_get(rec, 0), 0) - 1, to_int(rec_get(rec, 1), 0) - 1
                v = rec_get(rec, 2)
                thp[(i, j)] = None if v is None else to_float(v) * P
        if thp and "THPRES" not in eqlopts:
            self.warn("THPRES given without EQLOPTS THPRES; threshold pressures are ignored")
            thp = {}
        model.thpres = [(i, j, v) for (i, j), v in thp.items() if i >= 0 and j >= 0]
        if not model.equil and "PRESSURE" not in model.explicit_init:
            raise ValueError("No initial conditions: give EQUIL or PRESSURE/SWAT/SGAS in SOLUTION")

    def _schedule(self, model):
        sb = ScheduleBuilder(self.u, model.start_date, self.warn, model.eos.nc if model.eos else 0)
        for kw in self.deck.keywords:
            if kw.section == "SCHEDULE":
                sb.process(kw)
        if not sb.steps:
            self.warn("No TSTEP/DATES in SCHEDULE; nothing to simulate beyond initialisation")
        if model.co2store:
            # brine lives in the liquid (oil) slot: water controls and water injection map onto it
            for st in sb.steps:
                for w in st.wells.values():
                    if w.inj_type == "WATER":
                        w.inj_type = "OIL"
                    if "WRAT" in w.targets:
                        w.targets["ORAT"] = w.targets.pop("WRAT")
                    if w.control == "WRAT":
                        w.control = "ORAT"
        model.schedule = sb.steps

    # summary mnemonics (after the F/W/G prefix) that the simulator produces
    SUMMARY_SUPPORTED = {
        "F": {"OPR", "WPR", "GPR", "LPR", "WIR", "GIR", "OIR", "OPT", "WPT", "GPT", "WIT", "GIT", "WCT", "GOR",
              "WGR", "PR", "OIP", "GIP", "WIP", "VPR", "VIR", "PPO", "PPW", "PPG", "GIPL", "GIPG", "GIPM",
              "GIPR", "CO2M", "CO2D", "OIPL", "OIPG", "TEMP", "VPT", "VIT", "LPT", "GSR", "GST", "GCR", "GCT",
              "OPRH", "WPRH", "GPRH", "LPRH", "WIRH", "GIRH", "OPTH", "WPTH", "GPTH", "LPTH", "WITH", "GITH",
              "WCTH", "GORH"},
        "W": {"OPR", "WPR", "GPR", "LPR", "WIR", "GIR", "OIR", "OPT", "WPT", "GPT", "WIT", "GIT", "WCT", "GOR",
              "WGR", "GLR", "BHP", "THP", "BP", "BP4", "BP5", "BP9", "VPR", "VIR", "STAT", "MVFP", "LPT",
              "OPRH", "WPRH", "GPRH", "LPRH", "WIRH", "GIRH", "OPTH", "WPTH", "GPTH", "LPTH", "WITH", "GITH",
              "WCTH", "GORH", "BHPH", "THPH", "OPP", "WPP", "GPP", "WIP", "GIP", "PI"},
        "G": {"OPR", "WPR", "GPR", "LPR", "WIR", "GIR", "OPT", "WPT", "GPT", "WIT", "GIT", "WCT", "GOR",
              "VPR", "VIR"},
        "R": {"PR", "OIP", "OIPL", "OIPG", "GIP", "GIPL", "GIPG", "WIP", "OP", "OPR", "WPR", "GPR", "OIR", "WIR",
              "GIR", "OPT", "WPT", "GPT", "OIT", "WIT", "GIT", "OFR", "OFT", "WFR", "WFT", "GFR", "GFT"},
        "B": {"PR", "OSAT", "WSAT", "GSAT", "RS", "RV", "DENO", "DENW", "DENG"},
        "C": {"OFR", "WFR", "GFR", "OPR", "WPR", "GPR", "OIR", "WIR", "GIR", "OPT", "WPT", "GPT", "OIT", "WIT",
              "GIT"},
    }
    TRACER_VECTORS = ("FTPR", "FTPC", "FTIR", "FTPT", "FTIT", "WTPR", "WTPC", "WTIR", "WTPT", "WTIT")
    SUMMARY_CONTROL = {"SUMMARY", "RUNSUM", "SEPARATE", "EXCEL", "RPTONLY", "RPTSMRY", "ALL", "DATE", "TIMESTEP",
                       "ELAPSED", "NEWTON", "MLINEARS", "TCPU", "PERFORMA", "NARROW", "INCLUDE", "ECHO", "NOECHO"}

    def _summary(self, model):
        model.summary_keywords = [k.name for k in self.deck.section("SUMMARY") if k.name != "SUMMARY"]
        tracer_names = {t["name"] for t in model.tracers}
        # connection vectors: the wells they are requested for (None = all)
        model.summary_connections = {}
        for kw in self.deck.section("SUMMARY"):
            if kw.name[:1] == "C" and kw.name[1:] in self.SUMMARY_SUPPORTED["C"]:
                recs = [r for r in (kw.data or []) if r]
                wells = [to_str(r[0]) for r in recs] if recs else None
                prev = model.summary_connections.get(kw.name, [])
                model.summary_connections[kw.name] = None if wells is None or prev is None else prev + wells
        rd = self.deck.get("REGDIMS")
        td = self.deck.get("TABDIMS")
        model.n_fip_regions = max(to_int(rec_get(rd.data[0], 0), 1) if rd is not None and rd.data else 1,
                                  to_int(rec_get(td.data[0], 4), 1) if td is not None and td.data else 1,
                                  int(model.fipnum.max()) + 1 if model.fipnum is not None and model.fipnum.size else 1)
        # block vectors (BPR, BOSAT, ...): the cells requested, as active indices
        model.summary_blocks = {}
        for kw in self.deck.section("SUMMARY"):
            if kw.name[:1] == "B" and kw.name[1:] in self.SUMMARY_SUPPORTED["B"]:
                for r in (kw.data or []):
                    if not r or len(r) < 3:
                        continue
                    i, j, k = (to_int(r[m]) - 1 for m in range(3))
                    nx, ny, nz = model.grid.shape
                    a = model.global_to_active[i + nx * (j + ny * k)] if (0 <= i < nx and 0 <= j < ny and 0 <= k < nz) \
                        else -1
                    if a < 0:
                        self.warn(f"{kw.name}: block ({i + 1},{j + 1},{k + 1}) is inactive or outside the grid")
                        continue
                    model.summary_blocks.setdefault(kw.name, []).append(((i + 1, j + 1, k + 1), int(a)))
        # inter-region flows (ROFR/ROFT, RGFR/RGFT, RWFR/RWFT): the region pairs requested
        model.summary_region_flows = {}
        for kw in self.deck.section("SUMMARY"):
            if kw.name[:1] == "R" and kw.name[2:] in ("FR", "FT") and kw.name[1] in "OWG":
                pairs = [(to_int(r[0]) - 1, to_int(r[1]) - 1) for r in (kw.data or []) if r and len(r) >= 2]
                if pairs:
                    model.summary_region_flows.setdefault(kw.name, []).extend(pairs)
        missing = []
        for name in model.summary_keywords:
            if name in self.SUMMARY_CONTROL:
                continue
            if name.startswith(self.TRACER_VECTORS) and name[4:] in tracer_names:
                continue
            if name[:1] == "R" and name[2:] in ("FR", "FT") and name[1:2] in ("O", "W", "G"):
                continue            # produced for the region pairs listed (none listed: none, as ECLIPSE)
            sup = self.SUMMARY_SUPPORTED.get(name[0], set())
            if name[1:] not in sup:
                missing.append(name)
        if missing:
            self.warn("SUMMARY vectors not produced by this simulator: " + " ".join(missing))
