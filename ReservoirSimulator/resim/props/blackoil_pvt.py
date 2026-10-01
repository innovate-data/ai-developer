"""Black-oil PVT models (SI units).

Every fluid returns reciprocal formation volume factors b = 1/B together with
viscosities and their derivatives, which is what the fully implicit solver needs.
Tabulated data are interpolated in b and 1/(B mu), as ECLIPSE does.
"""
from __future__ import annotations

import numpy as np

from .tables import interp


class ConstCompressibilityFluid:
    """PVTW / PVCDO style fluid: B = Bref / (1 + X + X^2/2), X = c (p - pref)."""

    def __init__(self, pref, bref, c, mu_ref, cv=0.0):
        self.pref, self.bref, self.c, self.mu_ref, self.cv = pref, bref, c, mu_ref, cv

    def eval(self, p):
        x = self.c * (p - self.pref)
        b = (1.0 + x + 0.5 * x * x) / self.bref
        db = (1.0 + x) * self.c / self.bref
        y = -(self.c - self.cv) * (p - self.pref)
        bmu = (1.0 + y + 0.5 * y * y) / (self.bref * self.mu_ref)
        dbmu = -(1.0 + y) * (self.c - self.cv) / (self.bref * self.mu_ref)
        mu = b / bmu
        dmu = (db * bmu - b * dbmu) / bmu ** 2
        return b, db, mu, dmu


class TabulatedFluid:
    """PVDO / PVDG: B(p) and mu(p) tables."""

    def __init__(self, p, B, mu):
        order = np.argsort(p)
        self.p = np.asarray(p, float)[order]
        self.b = 1.0 / np.asarray(B, float)[order]
        self.bmu = 1.0 / (np.asarray(B, float)[order] * np.asarray(mu, float)[order])

    def eval(self, p):
        b, db = interp(p, self.p, self.b, "linear")
        bmu, dbmu = interp(p, self.p, self.bmu, "linear")
        b = np.maximum(b, 1e-12)
        bmu = np.maximum(bmu, 1e-20)
        mu = b / bmu
        dmu = (db * bmu - b * dbmu) / bmu ** 2
        return b, db, mu, dmu


class LiveOil:
    """PVTO live oil. `records` is a list of [Rs, p, Bo, mu, (p, Bo, mu)...] in SI."""

    def __init__(self, records):
        nodes = []
        for rec in records:
            vals = np.asarray([v for v in rec if not np.isnan(v)], float)
            rs = vals[0]
            rows = vals[1:].reshape(-1, 3)
            nodes.append((rs, rows))
        nodes.sort(key=lambda t: t[0])
        self.rs_n = np.array([n[0] for n in nodes])
        self.pb_n = np.array([n[1][0, 0] for n in nodes])
        self.b_n = np.array([1.0 / n[1][0, 1] for n in nodes])
        self.bmu_n = np.array([1.0 / (n[1][0, 1] * n[1][0, 2]) for n in nodes])
        # undersaturated branches as ratios relative to the saturated point
        curves = [None] * len(nodes)
        for m, (_, rows) in enumerate(nodes):
            if rows.shape[0] > 1:
                dp = rows[:, 0] - rows[0, 0]
                curves[m] = (dp, (1.0 / rows[:, 1]) * rows[0, 1],
                             (1.0 / (rows[:, 1] * rows[:, 2])) * (rows[0, 1] * rows[0, 2]))
        # nodes without data copy the branch of the next node that has one
        last = None
        for m in range(len(nodes) - 1, -1, -1):
            if curves[m] is None:
                curves[m] = last
            else:
                last = curves[m]
        first = next((c for c in curves if c is not None), None)
        if first is None:
            # no undersaturated data at all: assume slight compressibility
            first = (np.array([0.0, 1.0e7]), np.array([1.0, 1.01]), np.array([1.0, 1.0]))
        self.curves = [c if c is not None else first for c in curves]

    def rs_sat(self, p):
        return interp(p, self.pb_n, self.rs_n, "linear")

    def _eval(self, p, rs):
        pb = interp(rs, self.rs_n, self.pb_n, "linear")[0]
        bsat = interp(rs, self.rs_n, self.b_n, "linear")[0]
        bmusat = interp(rs, self.rs_n, self.bmu_n, "linear")[0]
        dp = p - pb
        nn = self.rs_n.size
        if nn == 1:
            j = np.zeros(rs.shape, int)
            w = np.zeros(rs.shape)
        else:
            j = np.clip(np.searchsorted(self.rs_n, rs, side="right") - 1, 0, nn - 2)
            w = np.clip((rs - self.rs_n[j]) / (self.rs_n[j + 1] - self.rs_n[j]), 0.0, 1.0)
        rb = np.zeros_like(p)
        rbmu = np.zeros_like(p)
        for m in range(nn):
            sel_lo = j == m
            sel_hi = (j + 1 == m) if nn > 1 else np.zeros_like(sel_lo)
            if not (sel_lo.any() or sel_hi.any()):
                continue
            dpc, crb, crbmu = self.curves[m]
            vb = interp(dp, dpc, crb, "linear")[0]
            vm = interp(dp, dpc, crbmu, "linear")[0]
            rb += np.where(sel_lo, (1 - w) * vb, 0.0) + np.where(sel_hi, w * vb, 0.0)
            rbmu += np.where(sel_lo, (1 - w) * vm, 0.0) + np.where(sel_hi, w * vm, 0.0)
        b = np.maximum(bsat * rb, 1e-12)
        bmu = np.maximum(bmusat * rbmu, 1e-20)
        return b, b / bmu

    def eval(self, p, rs):
        p = np.asarray(p, float)
        rs = np.asarray(rs, float)
        hp = 1.0e-3 * np.maximum(np.abs(p), 1.0e5) * 1e-3
        hr = 1.0e-6 * np.maximum(np.abs(rs), 1.0)
        b, mu = self._eval(p, rs)
        b1, mu1 = self._eval(p + hp, rs)
        b0, mu0 = self._eval(p - hp, rs)
        b3, mu3 = self._eval(p, rs + hr)
        b2, mu2 = self._eval(p, np.maximum(rs - hr, 0.0))
        hr2 = rs + hr - np.maximum(rs - hr, 0.0)
        return (b, (b1 - b0) / (2 * hp), (b3 - b2) / hr2,
                mu, (mu1 - mu0) / (2 * hp), (mu3 - mu2) / hr2)


class DeadOil:
    """Wraps a dead oil model to expose the live-oil interface (Rs = 0)."""

    def __init__(self, fluid):
        self.fluid = fluid

    def rs_sat(self, p):
        return np.zeros_like(p), np.zeros_like(p)

    def eval(self, p, rs):
        b, db, mu, dmu = self.fluid.eval(p)
        z = np.zeros_like(p)
        return b, db, z, mu, dmu, z


class BlackOilPVT:
    """PVT for one PVTNUM region."""

    def __init__(self, water=None, oil=None, gas=None, rho_o=800.0, rho_w=1000.0, rho_g=1.0):
        self.water = water
        self.oil = oil
        self.gas = gas
        self.rho_os, self.rho_ws, self.rho_gs = rho_o, rho_w, rho_g

    @property
    def live(self):
        return isinstance(self.oil, LiveOil)


class DryGas:
    """Dry gas (PVDG) exposed through the wet-gas interface (Rv = 0)."""

    def __init__(self, fluid):
        self.fluid = fluid

    def rv_sat(self, p):
        return np.zeros_like(p), np.zeros_like(p)

    def eval(self, p, rv=None):
        b, db, mu, dmu = self.fluid.eval(p)
        z = np.zeros_like(p)
        return b, db, z, mu, dmu, z


class WetGas:
    """PVTG wet gas with vaporised oil Rv.

    `records` is a list of [p_g, Rv_sat, Bg, mu_g, (Rv, Bg, mu_g)...] in SI.
    For each pressure node the properties are interpolated along its Rv branch,
    then linearly in pressure between the two bracketing nodes (in b = 1/Bg and
    1/(Bg mu_g))."""

    def __init__(self, records):
        nodes = []
        for rec in records:
            vals = np.asarray([v for v in rec if not np.isnan(v)], float)
            pg = vals[0]
            rows = vals[1:].reshape(-1, 3)
            order = np.argsort(rows[:, 0])
            rows = rows[order]
            nodes.append((pg, float(vals[1]), rows))
        nodes.sort(key=lambda t: t[0])
        self.p_n = np.array([n[0] for n in nodes])
        self.rvs_n = np.array([n[1] for n in nodes])
        self.branches = [(r[:, 0], 1.0 / r[:, 1], 1.0 / (r[:, 1] * r[:, 2])) for _, _, r in nodes]

    def rv_sat(self, p):
        v, d = interp(p, self.p_n, self.rvs_n, "linear")
        neg = v < 0
        return np.where(neg, 0.0, v), np.where(neg, 0.0, d)

    def _eval(self, p, rv):
        nn = self.p_n.size
        if nn == 1:
            rvb, bb, bm = self.branches[0]
            return np.maximum(interp(rv, rvb, bb, "linear")[0], 1e-12), interp(rv, rvb, bm, "linear")[0]
        j = np.clip(np.searchsorted(self.p_n, p, side="right") - 1, 0, nn - 2)
        w = (p - self.p_n[j]) / (self.p_n[j + 1] - self.p_n[j])
        w = np.clip(w, -1.0, 2.0)
        b = np.zeros_like(p)
        bmu = np.zeros_like(p)
        for m in range(nn):
            lo = j == m
            hi = j + 1 == m
            if not (lo.any() or hi.any()):
                continue
            rvb, bb, bm = self.branches[m]
            vb = interp(rv, rvb, bb, "linear")[0] if rvb.size > 1 else np.full_like(p, bb[0])
            vm = interp(rv, rvb, bm, "linear")[0] if rvb.size > 1 else np.full_like(p, bm[0])
            b += np.where(lo, (1 - w) * vb, 0.0) + np.where(hi, w * vb, 0.0)
            bmu += np.where(lo, (1 - w) * vm, 0.0) + np.where(hi, w * vm, 0.0)
        b = np.maximum(b, 1e-12)
        bmu = np.maximum(bmu, 1e-20)
        return b, b / bmu

    def eval(self, p, rv):
        p = np.asarray(p, float)
        rv = np.asarray(rv, float)
        hp = 1.0e-6 * np.maximum(np.abs(p), 1.0e5)
        hr = 1.0e-6 * np.maximum(np.abs(self.rvs_n).max(), 1e-12) + 0.0 * rv
        b, mu = self._eval(p, rv)
        b1, mu1 = self._eval(p + hp, rv)
        b0, mu0 = self._eval(p - hp, rv)
        b3, mu3 = self._eval(p, rv + hr)
        b2, mu2 = self._eval(p, rv - hr)
        return (b, (b1 - b0) / (2 * hp), (b3 - b2) / (2 * hr),
                mu, (mu1 - mu0) / (2 * hp), (mu3 - mu2) / (2 * hr))


class TemperatureFunction:
    """Viscosity multiplier mu(T)/mu(T_ref) from an OILVISCT/WATVISCT/GASVISCT table."""

    def __init__(self, temps, values, t_ref):
        order = np.argsort(temps)
        self.t = np.asarray(temps, float)[order]
        self.v = np.asarray(values, float)[order]
        self.ref = float(np.interp(t_ref, self.t, self.v))

    def eval(self, T):
        # interpolate log(mu) for the strongly non-linear viscosity-temperature relation
        lv = np.log(np.maximum(self.v, 1e-30))
        val, d = interp(T, self.t, lv, "constant")
        f = np.exp(val) / self.ref
        return f, f * d
