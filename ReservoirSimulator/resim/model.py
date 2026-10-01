"""Build a `SimulationModel` (SI units, active cells only) from a parsed deck."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional

import numpy as np

from .deck.gridprops import GridProperties
from .deck.parser import Deck, parse_deck, rec_get, to_float, to_int, to_str
from .grid import Grid, cartesian_corners, corner_point_corners
from .props.blackoil_pvt import BlackOilPVT, ConstCompressibilityFluid, DeadOil, LiveOil, TabulatedFluid
from .props.eos import CubicEOS
from .props.relperm import SaturationTable, default_sgof, default_swof, family2_to_family1
from .schedule import ScheduleBuilder, parse_start
from .units import ATM, GRAVITY, get_units

HANDLED = {
    # RUNSPEC
    "TITLE", "DIMENS", "INIT", "OIL", "WATER", "GAS", "DISGAS", "FIELD", "METRIC", "START", "TABDIMS", "WELLDIMS",
    "EQLDIMS", "REGDIMS", "COMPS", "EOS", "NCOMPS", "UNIFOUT", "UNIFIN", "FMTOUT", "NOSIM", "ECHO", "NOECHO",
    "FULLIMP", "IMPES", "NSTACK", "AQUDIMS", "VFPPDIMS", "VFPIDIMS", "FAULTDIM", "MESSAGES", "RUNSUM",
    "RPTRUNSP", "GRIDOPTS", "ROCKCOMP", "ISGAS", "NUPCOL", "UDQDIMS", "UDADIMS", "SMRYDIMS", "LIVEOIL",
    # GRID/EDIT
    "COORD", "ZCORN", "MINPV", "MINPORV", "RPTGRID", "INIT", "GRIDFILE", "NEWTRAN", "OLDTRAN", "MAPAXES",
    "MAPUNITS", "GRIDUNIT", "COORDSYS", "PINCH", "NOGGF",
    # PROPS
    "SWOF", "SGOF", "SWFN", "SGFN", "SOF3", "SOF2", "PVTW", "PVDO", "PVCDO", "PVTO", "PVDG", "PVTG", "DENSITY",
    "GRAVITY", "ROCK", "RPTPROPS", "CNAMES", "TCRIT", "PCRIT", "VCRIT", "ZCRIT", "ACF", "MW", "BIC", "OMEGAA",
    "OMEGAB", "SSHIFT", "STCOND", "RTEMP", "TEMPI", "ZI", "PARACHOR", "VCRITVIS", "ZCRITVIS", "LBCCOEF",
    "PRCORR", "TREF", "DREF",
    # SOLUTION
    "EQUIL", "RSVD", "PBVD", "RPTSOL", "RPTRST", "ZMFVD", "TEMPVD",
    # SCHEDULE
    "RPTSCHED", "TUNING", "WELSPECS", "COMPDAT", "WCONPROD", "WCONINJE", "WCONHIST", "WCONINJH", "WELOPEN",
    "WELTARG", "WELLSTRE", "WINJGAS", "TSTEP", "DATES", "WECON", "RPTSMRY",
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
        phases = {"water": "WATER" in d, "oil": "OIL" in d or compositional,
                  "gas": "GAS" in d or compositional, "disgas": "DISGAS" in d, "vapoil": "VAPOIL" in d}
        if phases["vapoil"]:
            self.warn("VAPOIL (vaporised oil) is not supported; gas is treated as dry gas")
        if not phases["oil"]:
            raise ValueError("Models without an oil phase are not supported")

        # ---------------- grid & properties
        gp = GridProperties(nx, ny, nz, self.warn)
        coord = zcorn = None
        minpv = 1e-6
        for kw in d.keywords:
            if kw.section not in ("GRID",):
                continue
            if kw.name == "COORD":
                coord = kw.data
            elif kw.name == "ZCORN":
                zcorn = kw.data
            elif kw.name in ("MINPV", "MINPORV"):
                minpv = units.to_si(to_float(kw.data[0][0], 1e-6), "volume")
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
        for dirn, face_p, face_m, perm, mult in (("I", "I+", "I-", kx * ntg, "MULTX"),
                                                 ("J", "J+", "J-", ky * ntg, "MULTY"),
                                                 ("K", "K+", "K-", kz, "MULTZ")):
            a, b = grid.neighbour_pairs(dirn)
            ta = grid.half_trans(face_p, perm)[a]
            tb = grid.half_trans(face_m, perm)[b]
            with np.errstate(divide="ignore", invalid="ignore"):
                t = np.where((ta > 0) & (tb > 0), ta * tb / (ta + tb), 0.0)
            full = np.zeros(grid.n_cells)
            full[a] = t * np.nan_to_num(gp.get(mult), nan=1.0)[a]
            tran[dirn] = full
        gp.arrays["TRANX"] = tran["I"] / tu
        gp.arrays["TRANY"] = tran["J"] / tu
        gp.arrays["TRANZ"] = tran["K"] / tu
        # pore volume
        pv_full = grid.volume * poro * ntg * np.nan_to_num(gp.get("MULTPV"), nan=1.0)
        gp.arrays["PORV"] = pv_full / units.to_si(1.0, "volume")

        for kw in d.keywords:
            if kw.section in ("EDIT", "REGIONS", "SOLUTION"):
                if kw.section == "SOLUTION" and kw.name in ("EQUIL", "RSVD", "PBVD", "ZMFVD", "TEMPVD"):
                    continue
                if not gp.process(kw):
                    if kw.section != "SOLUTION":
                        self._unhandled(kw)
        pv_full = np.nan_to_num(gp.get("PORV")) * units.to_si(1.0, "volume")
        active = (grid.actnum > 0) & (pv_full > minpv)
        g2a = np.full(grid.n_cells, -1, int)
        act_cells = np.nonzero(active)[0]
        g2a[act_cells] = np.arange(act_cells.size)

        conn_a, conn_b, conn_T = [], [], []
        for dirn, key in (("I", "TRANX"), ("J", "TRANY"), ("K", "TRANZ")):
            a, b = grid.neighbour_pairs(dirn)
            t = np.nan_to_num(gp.get(key))[a] * tu
            ok = active[a] & active[b] & (t > 0)
            conn_a.append(g2a[a[ok]])
            conn_b.append(g2a[b[ok]])
            conn_T.append(t[ok])

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
        self._props(model)
        self._solution(model, gp)
        self._schedule(model)
        self._summary(model)
        for kw in d.keywords:
            if kw.section in ("RUNSPEC", "PROPS", "SCHEDULE") and kw.name not in HANDLED and kw.name not in (
                    "RUNSPEC", "GRID", "EDIT", "PROPS", "REGIONS", "SOLUTION", "SUMMARY", "SCHEDULE"):
                self._unhandled(kw)
        model.warnings = self.warnings
        return model

    def _unhandled(self, kw):
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
            if ph["gas"]:
                if pvdg is not None:
                    t = pvdg[min(r, len(pvdg) - 1)]
                    gas = TabulatedFluid(t[:, 0] * P, t[:, 1] * bg_u, t[:, 2] * mu_u)
                elif pvtg is not None:
                    self.warn("PVTG wet gas treated as dry gas (saturated Rv rows only)")
                    rows = []
                    for rec in pvtg.data[min(r, len(pvtg.data) - 1)]:
                        rec = [v for v in rec if not np.isnan(v)]
                        rows.append((rec[0], rec[2], rec[3]))
                    rows = np.array(rows)
                    gas = TabulatedFluid(rows[:, 0] * P, rows[:, 1] * bg_u, rows[:, 2] * mu_u)
                else:
                    raise ValueError("GAS phase active but no PVDG/PVTG table")
            o, w, g = densities[r]
            pvts.append(BlackOilPVT(waters[r], oil, gas, o, w, g))
        model.pvt = pvts
        model.phases["disgas"] = model.phases["disgas"] and all(p.live for p in pvts)

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
                })
        for name, dest, q in (("RSVD", model.rsvd, "rs"), ("PBVD", model.pbvd, "pressure")):
            tabs = self._tables(name, 2)
            if tabs:
                for t in tabs:
                    t = t.copy()
                    t[:, 0] *= L
                    t[:, 1] = u.to_si(t[:, 1], q)
                    dest.append(t)
        for name, q in (("PRESSURE", "pressure"), ("SWAT", None), ("SGAS", None), ("RS", "rs"), ("PBUB", "pressure")):
            if gp.has(name):
                v = gp.get(name)[model.active_cells]
                model.explicit_init[name] = u.to_si(v, q) if q else v
        if not model.equil and "PRESSURE" not in model.explicit_init:
            raise ValueError("No initial conditions: give EQUIL or PRESSURE/SWAT/SGAS in SOLUTION")

    def _schedule(self, model):
        sb = ScheduleBuilder(self.u, model.start_date, self.warn, model.eos.nc if model.eos else 0)
        for kw in self.deck.keywords:
            if kw.section == "SCHEDULE":
                sb.process(kw)
        if not sb.steps:
            self.warn("No TSTEP/DATES in SCHEDULE; nothing to simulate beyond initialisation")
        model.schedule = sb.steps

    def _summary(self, model):
        model.summary_keywords = [k.name for k in self.deck.section("SUMMARY") if k.name != "SUMMARY"]
