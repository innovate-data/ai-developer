"""Per-cell saturation functions: end-point scaling, hysteresis and SWATINIT.

The region tables (SWOF/SGOF or the SWFN family) give relative permeabilities and
capillary pressures between the table's own end points.  With ENDSCALE every cell has
its own end points (SWL, SWCR, SWU, SGL, SGCR, SGU, SOWCR, SOGCR; defaulted cells use
the table values) and a cell saturation is mapped onto the table saturation by a
piecewise-linear transform through the end points, as in ECLIPSE:

* two-point scaling (default): krw through (SWCR, SWU), krg through (SGCR, SGU),
  krow through (SOWCR, 1-SWL) and krog through (SOGCR, 1-SWL-SGL), in oil saturation;
* three-point scaling (SCALECRS YES) adds the displacing critical saturation: krw
  through (SWCR, 1-SOWCR, SWU), krg through (SGCR, 1-SOGCR-SWL, SGU), krow through
  (SOWCR, 1-SWCR, 1-SWL) and krog through (SOGCR, 1-SGCR-SWL, 1-SWL-SGL);
* capillary pressures through (SWL, SWU) and (SGL, SGU), vertically scaled by PCW and
  PCG relative to the table maximum.

The three-phase oil relative permeability is the ECLIPSE default model, with the
cell's connate water SWL.

Hysteresis (SATOPTS HYSTER, EHYSTR) affects the non-wetting phases: gas in the gas-oil
system and oil in the oil-water system.  A cell that has seen a higher non-wetting
saturation S_hy follows a scanning curve when the saturation falls: Carlson's model
shifts the imbibition curve (IMBNUM table, ISxxx end points) so that it meets the
drainage curve at S_hy; Killough's model scales the imbibition curve between the
trapped saturation and S_hy.  Wetting phases follow their drainage curves.

SWATINIT sets the initial water saturation: the cell's capillary pressure curve is
scaled vertically (PCW) so that the equilibrium capillary pressure is reached at the
given saturation.
"""
from __future__ import annotations

import numpy as np

from .tables import interp

EPS = 1e-12
EP_NAMES = ("SWL", "SWCR", "SWU", "SGL", "SGCR", "SGU", "SOWCR", "SOGCR")


def table_endpoints(t):
    """End points of one SaturationTable, with ECLIPSE's definitions."""
    wo, go = t.swof, t.sgof
    ep = {}
    if wo is not None:
        sw = wo[:, 0]
        ep["SWL"], ep["SWU"] = float(sw[0]), float(sw[-1])
        ep["SWCR"] = t._critical(wo, 1)
        z = np.nonzero(wo[:, 2] <= 0)[0]                  # krow = 0: largest residual oil
        ep["SOWCR"] = float(1.0 - sw[z[0]]) if z.size else float(1.0 - sw[-1])
        ep["PCW"] = float(np.max(np.abs(wo[:, 3])))
    else:
        ep.update(SWL=0.0, SWU=1.0, SWCR=0.0, SOWCR=0.0, PCW=0.0)
    if go is not None:
        sg = go[:, 0]
        ep["SGL"], ep["SGU"] = float(sg[0]), float(sg[-1])
        ep["SGCR"] = t._critical(go, 1)
        z = np.nonzero(go[:, 2] <= 0)[0]
        so = (1.0 - sg[z[0]] - ep["SWL"]) if z.size else (1.0 - sg[-1] - ep["SWL"])
        ep["SOGCR"] = float(max(so, 0.0))
        ep["PCG"] = float(np.max(np.abs(go[:, 3])))
    else:
        ep.update(SGL=0.0, SGU=1.0 - ep["SWL"], SGCR=0.0, SOGCR=0.0, PCG=0.0)
    return ep


def _pl(s, X, Y):
    """Piecewise-linear map per row through nodes X -> Y (both (m, K), non-decreasing).

    Returns value and slope; outside the nodes the end segments are extended."""
    val = Y[:, -1].copy()
    der = np.zeros(s.shape)
    for k in range(X.shape[1] - 2, -1, -1):
        x0, x1, y0, y1 = X[:, k], X[:, k + 1], Y[:, k], Y[:, k + 1]
        dx = x1 - x0
        ok = dx > EPS
        slope = np.where(ok, (y1 - y0) / np.where(ok, dx, 1.0), 0.0)
        sel = s < x1
        val = np.where(sel, np.where(ok, y0 + slope * (s - x0), y0), val)
        der = np.where(sel, slope, der)
    return val, der


def _monotone(cols):
    A = np.clip(np.column_stack(cols).astype(float), 0.0, 1.0)
    return np.maximum.accumulate(A, axis=1)


def _inverse_table(s, k):
    """(k, s) points for inverting a non-decreasing curve k(s) from its last zero upwards."""
    z = np.nonzero(k <= k[0])[0][-1]
    s, k = s[z:], k[z:]
    keep = np.r_[True, k[1:] > np.maximum.accumulate(k)[:-1]]
    return k[keep], s[keep]


class _CurveSet:
    """One family of scaled curves (drainage or imbibition): table index and end points per cell."""

    def __init__(self, tables, tabidx, cell_ep, scalecrs):
        self.tables = tables
        self.tabidx = tabidx
        self.groups = [(r, np.nonzero(tabidx == r)[0]) for r in range(len(tables))]
        self.groups = [(r, c) for r, c in self.groups if c.size]
        tep = [table_endpoints(t) for t in tables]
        T = {k: np.array([e[k] for e in tep])[tabidx] for k in tep[0]}
        E = {k: np.where(np.isnan(cell_ep[k]), T[k], cell_ep[k]) if cell_ep.get(k) is not None else T[k].copy()
             for k in EP_NAMES}
        self.T, self.E = T, E
        one, zero = np.ones(tabidx.size), np.zeros(tabidx.size)
        if scalecrs:
            krw = ([zero, E["SWCR"], 1 - E["SOWCR"], E["SWU"], one], [zero, T["SWCR"], 1 - T["SOWCR"], T["SWU"], one])
            krg = ([zero, E["SGCR"], 1 - E["SOGCR"] - E["SWL"], E["SGU"], one],
                   [zero, T["SGCR"], 1 - T["SOGCR"] - T["SWL"], T["SGU"], one])
            krow = ([zero, E["SOWCR"], 1 - E["SWCR"], 1 - E["SWL"], one],
                    [zero, T["SOWCR"], 1 - T["SWCR"], 1 - T["SWL"], one])
            krog = ([zero, E["SOGCR"], 1 - E["SGCR"] - E["SWL"], 1 - E["SWL"] - E["SGL"], one],
                    [zero, T["SOGCR"], 1 - T["SGCR"] - T["SWL"], 1 - T["SWL"] - T["SGL"], one])
        else:
            krw = ([zero, E["SWCR"], E["SWU"], one], [zero, T["SWCR"], T["SWU"], one])
            krg = ([zero, E["SGCR"], E["SGU"], one], [zero, T["SGCR"], T["SGU"], one])
            krow = ([zero, E["SOWCR"], 1 - E["SWL"], one], [zero, T["SOWCR"], 1 - T["SWL"], one])
            krog = ([zero, E["SOGCR"], 1 - E["SWL"] - E["SGL"], one], [zero, T["SOGCR"], 1 - T["SWL"] - T["SGL"], one])
        pcw = ([zero, E["SWL"], E["SWU"], one], [zero, T["SWL"], T["SWU"], one])
        pcg = ([zero, E["SGL"], E["SGU"], one], [zero, T["SGL"], T["SGU"], one])
        self.nodes = {k: (_monotone(x), _monotone(y)) for k, (x, y) in
                      dict(krw=krw, krg=krg, krow=krow, krog=krog, pcw=pcw, pcg=pcg).items()}
        # inverse tables of the non-wetting curves (for hysteresis)
        self.inv = []
        for t in tables:
            inv = {}
            if t.sgof is not None:
                inv["krg"] = _inverse_table(t.sgof[:, 0], t.sgof[:, 1])
            if t.swof is not None:
                inv["krow"] = _inverse_table(1.0 - t.swof[::-1, 0], t.swof[::-1, 2])
            self.inv.append(inv)

    # --------------------------------------------------------------------------------------------
    def _map(self, name, s, cells):
        X, Y = self.nodes[name]
        return _pl(s, X[cells], Y[cells])

    def _lookup(self, tab, col, x, s_t, cells):
        """Table column `col` of 'swof'/'sgof' against its first column at s_t (cells subset)."""
        val = np.zeros(s_t.size)
        der = np.zeros(s_t.size)
        idx = self.tabidx[cells]
        for r, _ in self.groups:
            m = idx == r if len(self.groups) > 1 else slice(None)
            T = getattr(self.tables[r], tab)
            v, d = interp(s_t[m], T[:, 0], T[:, col])
            val[m], der[m] = v, d
        return val, der

    def curve(self, name, s, cells):
        """Value and derivative of a scaled curve: krw(Sw), krg(Sg), krow(So), krog(So), pcw(Sw), pcg(Sg)."""
        s_t, ds = self._map(name, s, cells)
        if name == "krw":
            v, d = self._lookup("swof", 1, None, s_t, cells)
        elif name == "pcw":
            v, d = self._lookup("swof", 3, None, s_t, cells)
        elif name == "krg":
            v, d = self._lookup("sgof", 1, None, s_t, cells)
        elif name == "pcg":
            v, d = self._lookup("sgof", 3, None, s_t, cells)
        elif name == "krow":                       # table in Sw_t = 1 - So_t
            v, d = self._lookup("swof", 2, None, 1.0 - s_t, cells)
            d = -d
        else:                                      # krog: table in Sg_t = 1 - So_t - Swl_t
            v, d = self._lookup("sgof", 2, None, 1.0 - s_t - self.T["SWL"][cells], cells)
            d = -d
        return v, d * ds

    def inverse(self, name, k, cells):
        """Cell saturation at which the scaled non-wetting curve `name` (krg or krow) reaches k."""
        s_t = np.zeros(k.size)
        idx = self.tabidx[cells]
        for r, _ in self.groups:
            m = idx == r
            kk, ss = self.inv[r][name]
            s_t[m] = np.interp(k[m], kk, ss)
        X, Y = self.nodes[name]
        return _pl(s_t, Y[cells], X[cells])[0]

    def pc_inverse(self, name, pc, cells):
        """Cell saturation where the (unit vertically scaled) capillary pressure equals pc."""
        tab, col = ("swof", 3) if name == "pcw" else ("sgof", 3)
        s_t = np.zeros(pc.size)
        idx = self.tabidx[cells]
        for r, _ in self.groups:
            m = idx == r
            T = getattr(self.tables[r], tab)
            s, p = T[:, 0], T[:, col]
            if name == "pcw":                   # decreasing in Sw
                s_t[m] = np.interp(pc[m], p[::-1], s[::-1])
            else:
                s_t[m] = np.interp(pc[m], p, s)
        X, Y = self.nodes[name]
        return _pl(s_t, Y[cells], X[cells])[0]


class SatFunctions:
    """Saturation functions for every active cell (see the module docstring)."""

    def __init__(self, tables, satnum, has_water, has_gas, cell_ep=None, scalecrs=False, imbnum=None,
                 cell_iep=None, hysteresis=None, pcw=None, pcg=None):
        self.tables = tables
        self.satnum = satnum
        self.n = satnum.size
        self.has_w, self.has_g = has_water, has_gas
        self.endscale = cell_ep is not None
        self.D = _CurveSet(tables, satnum, cell_ep or {}, scalecrs)
        self.hyst = hysteresis                     # None or {"model": int}
        self.I = _CurveSet(tables, imbnum if imbnum is not None else satnum, cell_iep or {}, scalecrs) \
            if hysteresis else None
        T = self.D.T
        self.pcw_max_t = T["PCW"]
        self.pcg_max_t = T["PCG"]
        self.pcw = np.where(np.isnan(pcw), T["PCW"], pcw) if pcw is not None else T["PCW"].copy()
        self.pcg = np.where(np.isnan(pcg), T["PCG"], pcg) if pcg is not None else T["PCG"].copy()
        self.pc_flat_w = np.array([t.swof is None or np.ptp(t.swof[:, 3]) < 1e-6 for t in tables])[satnum]
        self.pc_flat_g = np.array([t.sgof is None or np.ptp(t.sgof[:, 3]) < 1e-6 for t in tables])[satnum]
        self.swatinit_applied = False

    @property
    def scaled(self):
        return self.endscale or self.hyst is not None

    def _fac(self, which, cells):
        pmax, p = (self.pcw_max_t, self.pcw) if which == "w" else (self.pcg_max_t, self.pcg)
        return np.where(pmax[cells] > 0, p[cells] / np.where(pmax[cells] > 0, pmax[cells], 1.0), 1.0)

    @property
    def swl(self):
        return self.D.E["SWL"]

    # ---------------------------------------------------------------- capillary pressure (initialisation)
    def pcow(self, sw, cells):
        v, d = self.D.curve("pcw", sw, cells)
        f = self._fac("w", cells)
        return v * f, d * f

    def pcgo(self, sg, cells):
        v, d = self.D.curve("pcg", sg, cells)
        f = self._fac("g", cells)
        return v * f, d * f

    def sw_from_pcow(self, pc, cells):
        f = self._fac("w", cells)
        return self.D.pc_inverse("pcw", pc / np.where(f > 0, f, 1.0), cells)

    def sg_from_pcgo(self, pc, cells):
        f = self._fac("g", cells)
        return self.D.pc_inverse("pcg", pc / np.where(f > 0, f, 1.0), cells)

    def apply_swatinit(self, cells, swat, pc_req):
        """Initial Sw from SWATINIT, scaling PCW so that Pcow(SWATINIT) = pc_req (ECLIPSE rules).

        Cells below the free-water level (pc_req <= 0) are water filled; cells where the
        table capillary pressure at SWATINIT is zero keep the table PCW and get Sw from it."""
        E = self.D.E
        sw = np.maximum(swat, E["SWL"][cells])
        pc_t = self.pcow(sw, cells)[0] / np.maximum(self._fac("w", cells), EPS)   # unit-scaled Pc
        scale = (pc_req > 0) & (pc_t > 0) & (swat < E["SWU"][cells])
        new = self.pcw[cells].copy()
        with np.errstate(divide="ignore", invalid="ignore"):
            new[scale] = self.pcw_max_t[cells][scale] * pc_req[scale] / pc_t[scale]
        self.pcw[cells] = new
        out = np.where(scale, sw, np.nan)
        rest = ~scale
        if rest.any():
            out[rest] = np.where(pc_req[rest] <= 0, E["SWU"][cells][rest],
                                 self.sw_from_pcow(pc_req[rest], cells[rest]))
        self.swatinit_applied = True
        return out

    # ---------------------------------------------------------------- hysteresis state
    def init_hysteresis(self, sw, sg):
        if not self.hyst:
            return None
        return {"sg_max": np.asarray(sg, float).copy(), "so_max": 1.0 - np.asarray(sw, float) - np.asarray(sg, float)}

    def update_hysteresis(self, hs, sw, sg):
        if hs is None:
            return None
        return {"sg_max": np.maximum(hs["sg_max"], sg), "so_max": np.maximum(hs["so_max"], 1.0 - sw - sg)}

    def _nonwetting(self, name, s, s_hy, cells):
        """Hysteretic non-wetting relative permeability (krg in Sg or krow in So)."""
        vd, dd = self.D.curve(name, s, cells)
        if s_hy is None:
            return vd, dd
        s_hy = s_hy[cells]
        scan = s < s_hy - 1e-10
        if not scan.any():
            return vd, dd
        k_hy = self.D.curve(name, s_hy, cells)[0]
        model = self.hyst.get("model", 0)
        if model in (0, 1):                                # Carlson: shifted imbibition curve
            s_i = self.I.inverse(name, k_hy, cells)
            vi, di = self.I.curve(name, s - (s_hy - s_i), cells)
        else:                                              # Killough
            crit = "SGCR" if name == "krg" else "SOWCR"
            Ed, Ei = self.D.E, self.I.E
            sd, si = Ed[crit][cells], Ei[crit][cells]
            smax = Ed["SGU"][cells] if name == "krg" else 1.0 - Ed["SWL"][cells]
            with np.errstate(divide="ignore", invalid="ignore"):
                C = np.where(si - sd > EPS, 1.0 / (si - sd), 1e12) - np.where(smax - sd > EPS, 1.0 / (smax - sd), 0.0)
                ds = np.maximum(s_hy - sd, 0.0)
                strap = sd + ds / (1.0 + np.maximum(C, 0.0) * ds)
                span = np.where(s_hy - strap > EPS, s_hy - strap, 1.0)
                star = si + (s - strap) * (smax - si) / span
                kmax = self.D.curve(name, smax, cells)[0]
                ratio = np.where(kmax > EPS, k_hy / np.where(kmax > EPS, kmax, 1.0), 0.0)
            vi, di = self.I.curve(name, star, cells)
            vi, di = vi * ratio, di * ratio * (smax - si) / span
        return np.where(scan, vi, vd), np.where(scan, di, dd)

    # ---------------------------------------------------------------- solver evaluation
    def evaluate(self, sw, sg, hs=None, cells=None):
        """(krw, dkrw, pcow, dpcow, kro, dkro/dsw, dkro/dsg, krg, dkrg, pcgo, dpcgo) per cell."""
        if cells is None:
            cells = np.arange(self.n)
        sw = np.asarray(sw, float)
        sg = np.asarray(sg, float)
        z = np.zeros(sw.size)
        so = 1.0 - sw - sg
        krw = dkrw = pcow = dpcow = z
        krg = dkrg = pcgo = dpcgo = z
        if self.has_w:
            krw, dkrw = self.D.curve("krw", sw, cells)
            pcow, dpcow = self.pcow(sw, cells)
            krow, dkrow = self._nonwetting("krow", so, hs and hs["so_max"], cells)
        if self.has_g:
            krg, dkrg = self._nonwetting("krg", sg, hs and hs["sg_max"], cells)
            pcgo, dpcgo = self.pcgo(sg, cells)
            krog, dkrog = self.D.curve("krog", so, cells)
        if self.has_w and self.has_g:
            swco = self.D.E["SWL"][cells]
            swd = np.maximum(sw - swco, 0.0)
            dswd = (sw - swco > 0).astype(float)
            den = sg + swd
            safe = den > 1e-12
            d = np.where(safe, den, 1.0)
            num = sg * krog + swd * krow
            kro = np.where(safe, num / d, krow)
            dnum_w = -sg * dkrog + dswd * krow - swd * dkrow
            dnum_g = krog - sg * dkrog - swd * dkrow
            dkro_w = np.where(safe, (dnum_w * d - num * dswd) / d ** 2, -dkrow)
            dkro_g = np.where(safe, (dnum_g * d - num) / d ** 2, -dkrow)
        elif self.has_w:
            kro, dkro_w, dkro_g = krow, -dkrow, z
        else:
            kro, dkro_w, dkro_g = krog, z, -dkrog
        return krw, dkrw, pcow, dpcow, kro, dkro_w, dkro_g, krg, dkrg, pcgo, dpcgo
