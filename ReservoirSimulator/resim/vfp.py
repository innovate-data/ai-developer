"""Vertical flow performance tables (VFPPROD, VFPINJ).

A table gives the bottom-hole pressure, at the table's datum depth, as a function of
the flow rate (FLO), the tubing-head pressure (THP) and, for producers, the water
fraction (WFR), gas fraction (GFR) and artificial lift quantity (ALQ).  Values are
interpolated linearly in every dimension and extrapolated linearly outside the
tabulated range, as ECLIPSE does.  All quantities are stored in SI units.
"""
from __future__ import annotations

import numpy as np

from .deck.parser import rec_get, to_float, to_int, to_str


def _interp_weights(axis, x):
    """Index i and weight w with value = (1-w) f[i] + w f[i+1] (linear extrapolation outside)."""
    axis = np.asarray(axis, float)
    x = np.asarray(x, float)
    if axis.size == 1:
        return np.zeros(x.shape, int), np.zeros(x.shape)
    i = np.clip(np.searchsorted(axis, x, side="right") - 1, 0, axis.size - 2)
    w = (x - axis[i]) / (axis[i + 1] - axis[i])
    return i, w


class VFPTable:
    """One VFPPROD or VFPINJ table."""

    def __init__(self, kind, number, datum, flo_type, wfr_type, gfr_type, flo, thp, wfr, gfr, alq, bhp):
        self.kind = kind                      # "PROD" or "INJ"
        self.number = number
        self.datum = datum
        self.flo_type, self.wfr_type, self.gfr_type = flo_type, wfr_type, gfr_type
        self.flo, self.thp, self.wfr, self.gfr, self.alq = (np.asarray(a, float) for a in (flo, thp, wfr, gfr, alq))
        self.bhp = np.asarray(bhp, float)      # (nthp, nwfr, ngfr, nalq, nflo)

    # ---------------------------------------------------------------- rates -> table variables
    def variables(self, oil, water, gas):
        """FLO, WFR, GFR from surface rates (production positive; injection given as positive)."""
        oil, water, gas = (np.abs(np.asarray(v, float)) for v in (oil, water, gas))
        liq = oil + water
        with np.errstate(divide="ignore", invalid="ignore"):
            if self.kind == "INJ":
                flo = {"WAT": water, "GAS": gas, "OIL": oil}.get(self.flo_type, water)
                return flo, np.zeros_like(flo), np.zeros_like(flo)
            flo = {"OIL": oil, "LIQ": liq, "GAS": gas, "WG": water + gas, "TM": liq + gas}.get(self.flo_type, oil)
            wfr = {"WOR": np.where(oil > 0, water / oil, 0.0), "WCT": np.where(liq > 0, water / liq, 0.0),
                   "WGR": np.where(gas > 0, water / gas, 0.0), "WWR": np.where(oil + gas > 0, water / (oil + gas), 0.0),
                   "WTF": np.where(liq > 0, water / liq, 0.0)}.get(self.wfr_type, np.zeros_like(flo))
            gfr = {"GOR": np.where(oil > 0, gas / oil, 0.0), "GLR": np.where(liq > 0, gas / liq, 0.0),
                   "OGR": np.where(gas > 0, oil / gas, 0.0)}.get(self.gfr_type, np.zeros_like(flo))
        return flo, wfr, gfr

    # ---------------------------------------------------------------- interpolation
    def _bhp_at_thp_nodes(self, flo, wfr, gfr, alq):
        """BHP at every THP node: array (n, nthp)."""
        flo, wfr, gfr, alq = (np.atleast_1d(np.asarray(v, float)) for v in (flo, wfr, gfr, alq))
        n = max(flo.size, wfr.size, gfr.size, alq.size)
        flo, wfr, gfr, alq = (np.broadcast_to(v, (n,)) for v in (flo, wfr, gfr, alq))
        out = np.zeros((n, self.thp.size))
        dims = [(self.wfr, wfr), (self.gfr, gfr), (self.alq, alq), (self.flo, flo)]
        idx_w = [_interp_weights(ax, x) for ax, x in dims]
        for corner in range(16):
            bits = [(corner >> d) & 1 for d in range(4)]
            weight = np.ones(n)
            index = []
            for (ax, _), (i, w), b in zip(dims, idx_w, bits):
                if ax.size == 1:
                    if b:
                        weight = weight * 0.0
                    index.append(np.zeros(n, int))
                    continue
                weight = weight * (w if b else (1.0 - w))
                index.append(i + b)
            if not np.any(weight):
                continue
            out += weight[:, None] * self.bhp[:, index[0], index[1], index[2], index[3]].T
        return out

    def bhp_from_thp(self, thp, oil, water, gas, alq=0.0):
        """BHP at the table datum for given THP and surface rates."""
        flo, wfr, gfr = self.variables(oil, water, gas)
        nodes = self._bhp_at_thp_nodes(flo, wfr, gfr, alq)
        i, w = _interp_weights(self.thp, np.broadcast_to(np.asarray(thp, float), (nodes.shape[0],)))
        if self.thp.size == 1:
            return nodes[:, 0]
        r = np.arange(nodes.shape[0])
        return (1.0 - w) * nodes[r, i] + w * nodes[r, i + 1]

    def thp_from_bhp(self, bhp, oil, water, gas, alq=0.0):
        """Invert the table: THP giving the BHP (at the table datum) for the given rates."""
        flo, wfr, gfr = self.variables(oil, water, gas)
        nodes = self._bhp_at_thp_nodes(flo, wfr, gfr, alq)            # increasing in THP
        bhp = np.broadcast_to(np.asarray(bhp, float), (nodes.shape[0],))
        out = np.zeros(nodes.shape[0])
        for r in range(nodes.shape[0]):
            b = nodes[r]
            if self.thp.size == 1:
                out[r] = self.thp[0]
                continue
            # segment containing bhp (extrapolate on the end segments)
            k = int(np.clip(np.searchsorted(b, bhp[r]) - 1, 0, b.size - 2))
            db = b[k + 1] - b[k]
            out[r] = self.thp[k] + (bhp[r] - b[k]) * (self.thp[k + 1] - self.thp[k]) / db if abs(db) > 0 else self.thp[k]
        return out


def parse_vfp(kind, data, units):
    """Build a VFPTable from parsed VFPPROD / VFPINJ records (deck units -> SI)."""
    hdr = data[0]
    number = to_int(rec_get(hdr, 0), 1)
    datum = to_float(rec_get(hdr, 1), 0.0) * units.to_si(1.0, "length")
    p = units.to_si(1.0, "pressure")
    num = lambda rec: np.array([to_float(v) for v in rec], float)
    if kind == "PROD":
        flo_type = to_str(rec_get(hdr, 2), "OIL").upper()
        wfr_type = to_str(rec_get(hdr, 3), "WCT").upper()
        gfr_type = to_str(rec_get(hdr, 4), "GOR").upper()
        flo, thp, wfr, gfr, alq = (num(r) for r in data[1:6])
        rows = data[6:]
    else:
        flo_type = to_str(rec_get(hdr, 2), "WAT").upper()
        wfr_type = gfr_type = None
        flo, thp = num(data[1]), num(data[2])
        wfr = gfr = alq = np.zeros(1)
        rows = data[3:]
    # unit conversions
    flo_q = "gas_surface_rate" if flo_type in ("GAS", "WG", "TM") else "liquid_surface_rate"
    flo = flo * units.to_si(1.0, flo_q)
    thp = thp * p
    if kind == "PROD":
        wq = {"WOR": None, "WCT": None, "WTF": None, "WWR": None, "WGR": "wgr"}.get(wfr_type)
        if wq:
            wfr = wfr * units.to_si(1.0, wq)
        gq = {"GOR": "rs", "GLR": "rs", "OGR": "rv"}.get(gfr_type)
        if gq:
            gfr = gfr * units.to_si(1.0, gq)
    nt, nw, ng, na, nf = thp.size, wfr.size, gfr.size, alq.size, flo.size
    bhp = np.full((nt, nw, ng, na, nf), np.nan)
    for rec in rows:
        if not rec:
            continue
        if kind == "PROD":
            it, iw, ig, ia = (to_int(rec[m]) - 1 for m in range(4))
            vals = [to_float(v) for v in rec[4:4 + nf]]
        else:
            it, iw, ig, ia = to_int(rec[0]) - 1, 0, 0, 0
            vals = [to_float(v) for v in rec[1:1 + nf]]
        bhp[it, iw, ig, ia, :len(vals)] = np.array(vals, float) * p
    if np.isnan(bhp).any():
        raise ValueError(f"VFP{kind} table {number}: missing BHP values")
    return VFPTable(kind, number, datum, flo_type, wfr_type, gfr_type, flo, thp, wfr, gfr, alq, bhp)
