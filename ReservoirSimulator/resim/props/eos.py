"""Vectorised cubic equation of state (Peng-Robinson / SRK) with
Michelsen stability analysis, two-phase flash and Lohrenz-Bray-Clark viscosity.

All inputs are SI: T [K], p [Pa], critical volumes [m3/mol], molar masses [kg/mol].
Arrays are vectorised over cells: compositions have shape (n, nc).
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from ..units import ATM, R_GAS


@dataclass
class FlashResult:
    V: np.ndarray        # vapour mole fraction (0 liquid, 1 vapour)
    x: np.ndarray        # liquid composition (n, nc)
    y: np.ndarray        # vapour composition (n, nc)
    Zl: np.ndarray
    Zv: np.ndarray
    K: np.ndarray        # equilibrium ratios (NaN when single phase)
    two_phase: np.ndarray


class CubicEOS:
    def __init__(self, tc, pc, acf, mw, bic=None, vc=None, kind="PR", omegaa=None, omegab=None, shift=None,
                 names=None):
        self.tc = np.asarray(tc, float)
        self.pc = np.asarray(pc, float)
        self.acf = np.asarray(acf, float)
        self.mw = np.asarray(mw, float)             # kg/mol
        self.nc = self.tc.size
        self.names = names or [f"C{i + 1}" for i in range(self.nc)]
        self.kind = kind.upper()
        if self.kind in ("SRK", "RK"):
            self.u, self.w = 1.0, 0.0
            oa, ob = 0.42748, 0.08664
            m = 0.480 + 1.574 * self.acf - 0.176 * self.acf ** 2
        else:
            self.u, self.w = 2.0, -1.0
            oa, ob = 0.457235529, 0.077796074
            m = np.where(self.acf <= 0.49, 0.37464 + 1.54226 * self.acf - 0.26992 * self.acf ** 2,
                         0.379642 + 1.48503 * self.acf - 0.164423 * self.acf ** 2 + 0.016666 * self.acf ** 3)
        self.m = m
        self.oa = np.full(self.nc, oa) if omegaa is None else np.asarray(omegaa, float)
        self.ob = np.full(self.nc, ob) if omegab is None else np.asarray(omegab, float)
        self.bic = np.zeros((self.nc, self.nc)) if bic is None else np.asarray(bic, float)
        self.shift = np.zeros(self.nc) if shift is None else np.asarray(shift, float)
        if vc is None:
            zc = 0.2905 - 0.085 * self.acf
            vc = zc * R_GAS * self.tc / self.pc
        self.vc = np.asarray(vc, float)
        self.sq = np.sqrt(self.u ** 2 - 4 * self.w)
        self._T = None

    # ------------------------------------------------------------ parameters
    def _params(self, T):
        if self._T is not None and np.isscalar(T) and self._T == T:
            return self._ai, self._bi, self._aij
        tr = T / self.tc
        alpha = (1.0 + self.m * (1.0 - np.sqrt(tr))) ** 2
        ai = self.oa * R_GAS ** 2 * self.tc ** 2 / self.pc * alpha
        bi = self.ob * R_GAS * self.tc / self.pc
        aij = np.sqrt(np.outer(ai, ai)) * (1.0 - self.bic)
        if np.isscalar(T):
            self._T, self._ai, self._bi, self._aij = T, ai, bi, aij
        return ai, bi, aij

    def _mix(self, x, p, T):
        ai, bi, aij = self._params(T)
        sa = x @ aij                     # (n, nc)  sum_j x_j a_ij
        a = np.einsum("ij,ij->i", x, sa)
        b = x @ bi
        RT = R_GAS * T
        A = a * p / RT ** 2
        B = b * p / RT
        return A, B, a, b, sa, bi

    def _roots(self, A, B):
        u, w = self.u, self.w
        c2 = -(1.0 + B - u * B)
        c1 = A + w * B ** 2 - u * B - u * B ** 2
        c0 = -(A * B + w * B ** 2 + w * B ** 3)
        n = A.size
        comp = np.zeros((n, 3, 3))
        comp[:, 0, 0] = -c2
        comp[:, 0, 1] = -c1
        comp[:, 0, 2] = -c0
        comp[:, 1, 0] = 1.0
        comp[:, 2, 1] = 1.0
        ev = np.linalg.eigvals(comp) if n else np.zeros((0, 3), complex)
        real = np.abs(ev.imag) < 1e-8 * np.maximum(1.0, np.abs(ev.real))
        r = np.where(real & (ev.real > B[:, None]), ev.real, np.nan)
        # polish with Newton
        for _ in range(2):
            f = ((r + c2[:, None]) * r + c1[:, None]) * r + c0[:, None]
            df = (3 * r + 2 * c2[:, None]) * r + c1[:, None]
            r = r - np.where(np.abs(df) > 1e-14, f / np.where(np.abs(df) > 1e-14, df, 1.0), 0.0)
        zmin = np.nanmin(np.where(np.isnan(r), np.inf, r), axis=1)
        zmax = np.nanmax(np.where(np.isnan(r), -np.inf, r), axis=1)
        bad = ~np.isfinite(zmin)
        if bad.any():   # fall back to largest real part
            zmin[bad] = zmax[bad] = np.maximum(ev.real[bad].max(axis=1), B[bad] * 1.0001)
        return zmin, zmax

    def _lnphi_from_z(self, Z, A, B, a, b, sa, bi):
        u_p = (self.u + self.sq) / 2.0
        u_m = (self.u - self.sq) / 2.0
        bb = bi[None, :] / b[:, None]
        term = np.log((Z + u_p * B) / (Z + u_m * B))
        return (bb * (Z - 1.0)[:, None] - np.log(np.maximum(Z - B, 1e-300))[:, None]
                - (A / (B * self.sq))[:, None] * (2.0 * sa / a[:, None] - bb) * term[:, None])

    def lnphi(self, x, p, T, phase="auto"):
        """ln fugacity coefficients and Z. phase: 'L', 'V' or 'auto' (min Gibbs)."""
        A, B, a, b, sa, bi = self._mix(x, p, T)
        zl, zv = self._roots(A, B)
        if phase == "L":
            Z = zl
        elif phase == "V":
            Z = zv
        else:
            lp_l = self._lnphi_from_z(zl, A, B, a, b, sa, bi)
            lp_v = self._lnphi_from_z(zv, A, B, a, b, sa, bi)
            gl = np.einsum("ij,ij->i", x, lp_l)
            gv = np.einsum("ij,ij->i", x, lp_v)
            use_v = gv < gl
            Z = np.where(use_v, zv, zl)
            return np.where(use_v[:, None], lp_v, lp_l), Z
        return self._lnphi_from_z(Z, A, B, a, b, sa, bi), Z

    # ------------------------------------------------------------ densities
    def molar_volume(self, x, Z, p, T):
        """Molar volume [m3/mol] including Peneloux volume shift."""
        _, bi, _ = self._params(T)
        return Z * R_GAS * T / p - x @ (self.shift * bi)

    def mass_density(self, x, Z, p, T):
        return (x @ self.mw) / self.molar_volume(x, Z, p, T)

    # ------------------------------------------------------------ flash
    def wilson_k(self, p, T):
        p = np.atleast_1d(p)
        return (self.pc[None, :] / p[:, None]) * np.exp(5.373 * (1.0 + self.acf) * (1.0 - self.tc / T))[None, :] \
            if np.isscalar(T) else (self.pc[None, :] / p[:, None]) * np.exp(
                5.373 * (1.0 + self.acf)[None, :] * (1.0 - self.tc[None, :] / np.asarray(T)[:, None]))

    @staticmethod
    def rachford_rice(z, K, iters=60):
        """Negative-flash Rachford-Rice solve for vapour fraction V."""
        Km1 = K - 1.0
        kmax = K.max(axis=1)
        kmin = K.min(axis=1)
        lo = np.where(kmax > 1.0, 1.0 / (1.0 - kmax), -1e10) + 1e-12
        hi = np.where(kmin < 1.0, 1.0 / (1.0 - kmin), 1e10) - 1e-12
        V = np.clip(0.5 * np.ones(z.shape[0]), lo, hi)
        V = np.where((lo < 0.5) & (hi > 0.5), 0.5, 0.5 * (lo + hi))
        for _ in range(iters):
            den = 1.0 + V[:, None] * Km1
            f = np.sum(z * Km1 / den, axis=1)
            df = -np.sum(z * Km1 ** 2 / den ** 2, axis=1)
            # f is decreasing in V: f>0 -> root to the right
            lo = np.where(f > 0, V, lo)
            hi = np.where(f < 0, V, hi)
            Vn = V - f / np.where(df != 0, df, -1.0)
            out = (Vn <= lo) | (Vn >= hi) | ~np.isfinite(Vn)
            Vn = np.where(out, 0.5 * (lo + hi), Vn)
            if np.all(np.abs(Vn - V) < 1e-13):
                V = Vn
                break
            V = Vn
        return V

    def stability(self, z, p, T, iters=200):
        """Michelsen tangent-plane stability test. Returns (unstable, K_estimate)."""
        n = z.shape[0]
        lnz = np.log(np.maximum(z, 1e-300))
        lpz, _ = self.lnphi(z, p, T, "auto")
        d = lnz + lpz
        kw = self.wilson_k(p, T)
        unstable = np.zeros(n, bool)
        kest = np.full(z.shape, np.nan)
        best = np.zeros(n)
        for trial in ("V", "L"):
            lnY = lnz + (np.log(kw) if trial == "V" else -np.log(kw))
            active = np.ones(n, bool)
            for _ in range(iters):
                idx = np.nonzero(active)[0]
                if idx.size == 0:
                    break
                Y = np.exp(lnY[idx])
                y = Y / Y.sum(axis=1, keepdims=True)
                lpy, _ = self.lnphi(y, p[idx], T if np.isscalar(T) else T[idx], "auto")
                lnY_new = d[idx] - lpy
                delta = np.max(np.abs(lnY_new - lnY[idx]), axis=1)
                lnY[idx] = lnY_new
                trivial = np.sum((lnY_new - lnz[idx]) ** 2, axis=1) < 1e-8
                done = (delta < 1e-10) | trivial
                active[idx[done]] = False
            Ysum = np.exp(lnY).sum(axis=1)
            trivial = np.sum((lnY - lnz) ** 2, axis=1) < 1e-6
            uns = (Ysum > 1.0 + 1e-7) & ~trivial
            better = uns & (Ysum > best)
            y = np.exp(lnY) / Ysum[:, None]
            with np.errstate(divide="ignore", invalid="ignore"):
                k = y / z if trial == "V" else z / y
            kest[better] = k[better]
            best = np.where(better, Ysum, best)
            unstable |= uns
        return unstable, kest

    def _two_phase(self, z, p, T, K, iters=400, tol=1e-10):
        n = z.shape[0]
        V = np.zeros(n)
        x = z.copy()
        y = z.copy()
        zl = np.zeros(n)
        zv = np.zeros(n)
        lnK = np.log(K)
        active = np.ones(n, bool)
        for it in range(iters):
            idx = np.nonzero(active)[0]
            if idx.size == 0:
                break
            Ki = np.exp(lnK[idx])
            Vi = self.rachford_rice(z[idx], Ki)
            xi = z[idx] / (1.0 + Vi[:, None] * (Ki - 1.0))
            xi = np.maximum(xi, 1e-300)
            yi = Ki * xi
            xi /= xi.sum(axis=1, keepdims=True)
            yi /= yi.sum(axis=1, keepdims=True)
            Ti = T if np.isscalar(T) else T[idx]
            lpl, zli = self.lnphi(xi, p[idx], Ti, "L")
            lpv, zvi = self.lnphi(yi, p[idx], Ti, "V")
            lnK_new = lpl - lpv
            err = np.max(np.abs(lnK_new - lnK[idx]), axis=1)
            lnK[idx] = lnK_new
            V[idx], x[idx], y[idx], zl[idx], zv[idx] = Vi, xi, yi, zli, zvi
            trivial = np.max(np.abs(lnK_new), axis=1) < 1e-4
            done = (err < tol) | trivial
            active[idx[done]] = False
        return V, x, y, zl, zv, np.exp(lnK)

    def flash(self, z, p, T, K0=None, stability_check=None, no_stability=False):
        """Isothermal flash of overall compositions z at pressures p.

        K0: previous equilibrium ratios (NaN rows = previously single phase).
        stability_check: boolean mask of cells needing a stability test
            (default: cells without a valid K0).
        no_stability: never run stability tests; cells without K0 are single phase
            (used for small perturbations of an already flashed state).
        """
        z = np.maximum(np.asarray(z, float), 1e-14)
        z = z / z.sum(axis=1, keepdims=True)
        p = np.asarray(p, float)
        n = z.shape[0]
        K = np.full(z.shape, np.nan) if K0 is None else np.array(K0, float)
        has_k = np.all(np.isfinite(K) & (K > 0), axis=1)
        check = ~has_k if stability_check is None else (stability_check | ~has_k)
        if no_stability:
            check = np.zeros(n, bool)
        cand = has_k & ~check
        if check.any():
            idx = np.nonzero(check)[0]
            uns, kest = self.stability(z[idx], p[idx], T if np.isscalar(T) else T[idx])
            K[idx[uns]] = kest[uns]
            cand[idx[uns]] = True
        V = np.zeros(n)
        x = z.copy()
        y = z.copy()
        zl = np.zeros(n)
        zv = np.zeros(n)
        two = np.zeros(n, bool)
        Kout = np.full(z.shape, np.nan)
        if cand.any():
            idx = np.nonzero(cand)[0]
            Tc = T if np.isscalar(T) else T[idx]
            Vi, xi, yi, zli, zvi, Ki = self._two_phase(z[idx], p[idx], Tc, K[idx])
            ok = (Vi > 0.0) & (Vi < 1.0) & (np.max(np.abs(np.log(Ki)), axis=1) > 1e-4)
            # cells that were warm-started but ended outside (0,1): re-test stability
            ii = idx[ok]
            V[ii], x[ii], y[ii], zl[ii], zv[ii], Kout[ii] = Vi[ok], xi[ok], yi[ok], zli[ok], zvi[ok], Ki[ok]
            two[ii] = True
            redo = idx[~ok & ~check[idx]]
            if redo.size and not no_stability:
                uns, kest = self.stability(z[redo], p[redo], T if np.isscalar(T) else T[redo])
                if uns.any():
                    r2 = redo[uns]
                    Vi, xi, yi, zli, zvi, Ki = self._two_phase(z[r2], p[r2], T if np.isscalar(T) else T[r2], kest[uns])
                    ok2 = (Vi > 0) & (Vi < 1)
                    r3 = r2[ok2]
                    V[r3], x[r3], y[r3], zl[r3], zv[r3], Kout[r3] = Vi[ok2], xi[ok2], yi[ok2], zli[ok2], zvi[ok2], Ki[ok2]
                    two[r3] = True
        single = ~two
        if single.any():
            idx = np.nonzero(single)[0]
            Ts = T if np.isscalar(T) else T[idx]
            _, Z = self.lnphi(z[idx], p[idx], Ts, "auto")
            vap = self.is_vapour_like(z[idx], Ts)
            V[idx] = np.where(vap, 1.0, 0.0)
            zl[idx] = Z
            zv[idx] = Z
        return FlashResult(V, x, y, zl, zv, Kout, two)

    def is_vapour_like(self, z, T):
        """Li's pseudo-critical temperature criterion for single-phase labelling."""
        w = z * self.vc[None, :]
        tpc = (w @ self.tc) / w.sum(axis=1)
        return np.asarray(T) > tpc

    # ------------------------------------------------------------ viscosity
    def lbc_viscosity(self, x, molar_density, T):
        """Lohrenz-Bray-Clark viscosity [Pa.s]. molar_density in mol/m3."""
        tc, pc_atm, mw_g = self.tc, self.pc / ATM, self.mw * 1000.0
        tr = T / tc
        xi_i = tc ** (1.0 / 6.0) / (np.sqrt(mw_g) * pc_atm ** (2.0 / 3.0))
        mu_i = np.where(tr <= 1.5, 34.0e-5 * tr ** 0.94, 17.78e-5 * np.maximum(4.58 * tr - 1.67, 1e-12) ** 0.625) / xi_i
        sq = np.sqrt(mw_g)
        mu0 = (x @ (mu_i * sq)) / (x @ sq)
        tpc = x @ tc
        ppc = x @ pc_atm
        mwm = x @ mw_g
        xi_m = tpc ** (1.0 / 6.0) / (np.sqrt(mwm) * ppc ** (2.0 / 3.0))
        vcm = x @ (self.vc * 1.0e6)          # cm3/mol
        rr = molar_density * 1.0e-6 * vcm     # reduced density
        poly = 0.1023 + 0.023364 * rr + 0.058533 * rr ** 2 - 0.040758 * rr ** 3 + 0.0093324 * rr ** 4
        mu = mu0 + (poly ** 4 - 1.0e-4) / xi_m   # cP
        return mu * 1.0e-3
