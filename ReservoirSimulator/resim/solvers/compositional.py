"""Compositional solver: IMPEC (implicit pressure, explicit composition)
with a cubic EOS (Peng-Robinson / SRK), overall-composition formulation.

Unknowns per cell: pressure p, moles of every hydrocarbon component N_i and the
water content (surface volume) W.  Each step:

1. flash the cells at (p^n, z^n) -> phase compositions, densities, viscosities
2. compute partial molar volumes dVt/dN_i and dVt/dp by perturbed flashes
3. solve the volume-balance pressure equation  Vt(p, N) = PV(p)  linearised in
   p^{n+1} together with the well equations (BHP unknown per well)
4. update moles explicitly with upstream-weighted component fluxes

Water is an immiscible phase described by PVTW.  Time steps are limited by a
throughput (CFL) criterion and by the maximum change of overall composition.
"""
from __future__ import annotations

import numpy as np
import scipy.sparse as sp

from ..wells import build_perforations
from .linear import solve_linear

KEY_W = "WATER"


class CompositionalSolver:
    def __init__(self, model, options, log=print):
        self.m = model
        self.opt = options
        self.log = log
        self.eos = model.eos
        self.nc = model.eos.nc
        self.n = model.n_active
        self.T = model.temperature
        self.has_w = model.phases["water"]
        self.dz = model.depth[model.conn_b] - model.depth[model.conn_a]
        self.rock_pref = np.array([r[0] for r in model.rock])[model.rocknum]
        self.rock_cr = np.array([r[1] for r in model.rock])[model.rocknum]
        self.sat_regions = [np.nonzero(model.satnum == r)[0] for r in range(len(model.sat))]
        self.state = None
        self.bhp = {}
        self.controls = {}
        self.wells = {}
        self.perf = None
        self.last = {}
        self.cfl = 0.0
        self._stc_cache = {}

    # ------------------------------------------------------------------ helpers
    def pore_volume(self, p):
        X = self.rock_cr * (p - self.rock_pref)
        pv = self.m.pore_volume * (1.0 + X + 0.5 * X * X)
        return pv, self.m.pore_volume * (1.0 + X) * self.rock_cr

    def water(self, p):
        return self.m.water_pvt.eval(p)

    def flash(self, p, N, K0=None, no_stability=False, check=None):
        Nt = N.sum(axis=1)
        z = N / np.maximum(Nt, 1e-300)[:, None]
        fr = self.eos.flash(z, p, self.T, K0, stability_check=check, no_stability=no_stability)
        return fr, z, Nt

    def hc_volume(self, p, N, fr, z, Nt):
        eos, T = self.eos, self.T
        vl = eos.molar_volume(np.where(fr.two_phase[:, None], fr.x, z), fr.Zl, p, T)
        vv = eos.molar_volume(np.where(fr.two_phase[:, None], fr.y, z), fr.Zv, p, T)
        V = fr.V
        return Nt * ((1.0 - V) * vl + V * vv), vl, vv

    def _phase_state(self, p, N, W, K0=None, check=None):
        fr, z, Nt = self.flash(p, N, K0, check=check)
        Vhc, vl, vv = self.hc_volume(p, N, fr, z, Nt)
        bw, dbw, muw, _ = self.water(p)
        Vw = W / bw
        Vt = Vhc + Vw
        two = fr.two_phase
        x = np.where(two[:, None], fr.x, z)
        y = np.where(two[:, None], fr.y, z)
        so = Nt * (1 - fr.V) * vl / Vt
        sg = Nt * fr.V * vv / Vt
        sw = Vw / Vt
        eos, T = self.eos, self.T
        xi_o, xi_g = 1.0 / vl, 1.0 / vv
        rho_o = (x @ eos.mw) * xi_o
        rho_g = (y @ eos.mw) * xi_g
        mu_o = eos.lbc_viscosity(x, xi_o, T)
        mu_g = eos.lbc_viscosity(y, xi_g, T)
        return dict(fr=fr, z=z, Nt=Nt, Vhc=Vhc, Vt=Vt, Vw=Vw, vl=vl, vv=vv, x=x, y=y, so=so, sg=sg, sw=sw,
                    xi_o=xi_o, xi_g=xi_g, rho_o=rho_o, rho_g=rho_g, mu_o=mu_o, mu_g=mu_g, bw=bw, dbw=dbw,
                    muw=muw, rho_w=self.m.rho_ws * bw)

    def _relperm(self, sw, sg):
        krw = np.zeros(self.n)
        kro = np.zeros(self.n)
        krg = np.zeros(self.n)
        pcow = np.zeros(self.n)
        for r, cells in enumerate(self.sat_regions):
            if cells.size == 0:
                continue
            t = self.m.sat[r]
            s_w, s_g = sw[cells], sg[cells]
            if self.has_w:
                krw[cells] = t.krw(s_w)[0]
                pcow[cells] = t.pcow(s_w)[0]
                kro[cells] = t.kro3(s_w, s_g)[0]
            else:
                kro[cells] = t.krog(s_g)[0]
            krg[cells] = t.krg(s_g)[0]
        return krw, kro, krg, pcow

    # ------------------------------------------------------------------ state
    def set_initial_state(self, init):
        p = init["p"].astype(float)
        z = init["z"]
        sw = init["sw"] if self.has_w else np.zeros(self.n)
        fr = self.eos.flash(z, p, self.T)
        Vhc_per_mol, _, _ = self.hc_volume(p, z, fr, z, np.ones(self.n))
        pv, _ = self.pore_volume(p)
        Nt = pv * (1.0 - sw) / Vhc_per_mol
        bw = self.water(p)[0]
        self.state = {"p": p, "N": z * Nt[:, None], "W": pv * sw * bw, "K": fr.K}
        self.ps = self._phase_state(p, self.state["N"], self.state["W"], fr.K)
        nsat = int((~fr.two_phase).sum())
        self.log(f"Compositional init: {self.nc} components, T={self.T - 273.15:.1f} C, "
                 f"{int(fr.two_phase.sum())} two-phase / {nsat} single-phase cells")

    # ------------------------------------------------------------------ wells
    def setup_wells(self, wells):
        self.wells = wells
        self.perf = build_perforations(self.m, wells, self.log)
        p = self.state["p"]
        for wi, name in enumerate(self.perf.names):
            w = wells[name]
            self.controls[name] = w.control
            if name not in self.bhp:
                cells = self.perf.cell[self.perf.well == wi]
                pc = p[cells].mean() if cells.size else 1e7
                self.bhp[name] = pc - 1e5 if w.kind == "PROD" else pc + 1e5

    def _inj_composition(self, w):
        if w.inj_composition is not None and w.inj_composition.size == self.nc:
            return w.inj_composition
        z = np.zeros(self.nc)
        z[int(np.argmin(self.eos.mw))] = 1.0
        return z

    def _stc_flash(self, z):
        """Surface oil / gas volume per mole of a stream (single-stage separator at STCOND)."""
        T, p = self.m.std_cond
        z = np.atleast_2d(z)
        pp = np.full(z.shape[0], p)
        fr = self.eos.flash(np.maximum(z, 1e-12), pp, T)
        two = fr.two_phase
        x = np.where(two[:, None], fr.x, z)
        y = np.where(two[:, None], fr.y, z)
        vl = self.eos.molar_volume(x, fr.Zl, pp, T)
        vv = self.eos.molar_volume(y, fr.Zv, pp, T)
        return (1 - fr.V) * vl, fr.V * vv

    # ------------------------------------------------------------------ step
    def step(self, dt):
        st = self.state
        ps = self.ps
        n, nc = self.n, self.nc
        m = self.m
        p0, N0, W0 = st["p"], st["N"], st["W"]
        a, b, T = m.conn_a, m.conn_b, m.conn_T
        g = m.gravity
        # --- explicit properties
        krw, kro, krg, pcow = self._relperm(ps["sw"], ps["sg"])
        lam_o, lam_g = kro / ps["mu_o"], krg / ps["mu_g"]
        lam_w = krw / ps["muw"] if self.has_w else np.zeros(n)
        # --- derivatives of total fluid volume
        pv, dpv = self.pore_volume(p0)
        dp_pert = np.maximum(1e-6 * p0, 10.0)
        fr_p, z_p, Nt_p = self.flash(p0 + dp_pert, N0, ps["fr"].K, no_stability=True)
        Vhc_p = self.hc_volume(p0 + dp_pert, N0, fr_p, z_p, Nt_p)[0]
        bw_p = self.water(p0 + dp_pert)[0]
        dVt_dp = (Vhc_p - ps["Vhc"]) / dp_pert + (W0 / bw_p - ps["Vw"]) / dp_pert
        vbar = np.zeros((n, nc))
        for i in range(nc):
            dN = np.maximum(1e-6 * ps["Nt"], 1e-10)
            N1 = N0.copy()
            N1[:, i] += dN
            fr1, z1, Nt1 = self.flash(p0, N1, ps["fr"].K, no_stability=True)
            vbar[:, i] = (self.hc_volume(p0, N1, fr1, z1, Nt1)[0] - ps["Vhc"]) / dN
        vbar_w = 1.0 / ps["bw"]
        # --- face quantities (explicit upwinding with p^n potentials)
        def face_rho(rho, s):
            sa, sb = s[a], s[b]
            tot = sa + sb
            return np.where(tot > 1e-12, (sa * rho[a] + sb * rho[b]) / np.where(tot > 1e-12, tot, 1.0),
                            0.5 * (rho[a] + rho[b]))

        phases = [("o", lam_o, ps["rho_o"], ps["so"], ps["xi_o"][:, None] * ps["x"], 0.0),
                  ("g", lam_g, ps["rho_g"], ps["sg"], ps["xi_g"][:, None] * ps["y"], 0.0)]
        if self.has_w:
            phases.append(("w", lam_w, ps["rho_w"], ps["sw"], None, -pcow))
        diag_acc = dVt_dp - dpv

        def build_faces(p_up):
            """Pressure-equation face terms with upwinding from potentials at p_up."""
            rows, cols, vals = [], [], []
            rhs = np.zeros(n)
            face_data = []
            for ph, lam, rho, s, comp, pc_shift in phases:
                pcs = pc_shift if isinstance(pc_shift, np.ndarray) else np.zeros(n)
                G = (pcs[b] - pcs[a]) - face_rho(rho, s) * g * self.dz      # explicit part of potential diff
                up_a = (p_up[b] - p_up[a]) + G <= 0.0
                Tl = T * np.where(up_a, lam[a], lam[b])
                if ph == "w":
                    cmol = None
                    wa = vbar_w[a] * np.where(up_a, ps["bw"][a], ps["bw"][b])
                    wb = vbar_w[b] * np.where(up_a, ps["bw"][a], ps["bw"][b])
                else:
                    cmol = np.where(up_a[:, None], comp[a], comp[b])            # (nf, nc) molar concentrations
                    wa = np.einsum("ij,ij->i", vbar[a], cmol)
                    wb = np.einsum("ij,ij->i", vbar[b], cmol)
                # volumetric flux a->b = -Tl (p_b - p_a + G); row a gains dt*wa*Tl*(p_b - p_a + G)
                rows += [a, a, b, b]
                cols += [b, a, b, a]
                vals += [dt * wa * Tl, -dt * wa * Tl, -dt * wb * Tl, dt * wb * Tl]
                np.add.at(rhs, a, -dt * wa * Tl * G)
                np.add.at(rhs, b, dt * wb * Tl * G)
                face_data.append((ph, Tl, G, cmol, up_a))
            return rows, cols, vals, rhs, face_data

        # --- wells
        perf = self.perf
        nw = perf.n_wells
        npf = perf.cell.size
        open_w = np.array([self.wells[nm].is_open for nm in perf.names], bool) if nw else np.zeros(0, bool)
        c = perf.cell
        head = np.zeros(npf)
        rho_mix_well = np.zeros(nw)
        for wi_, nm in enumerate(perf.names):
            sel = perf.well == wi_
            if sel.any():
                cc = c[sel]
                lt = lam_o[cc] + lam_g[cc] + lam_w[cc] + 1e-30
                if self.wells[nm].kind == "INJ":
                    rho_mix_well[wi_] = np.mean(ps["rho_w"][cc] if self.wells[nm].inj_type == KEY_W else ps["rho_g"][cc])
                else:
                    rho_mix_well[wi_] = np.mean((lam_o[cc] * ps["rho_o"][cc] + lam_g[cc] * ps["rho_g"][cc]
                                                 + lam_w[cc] * ps["rho_w"][cc]) / lt)
        if npf:
            head = rho_mix_well[perf.well] * g * (perf.depth - perf.ref_depth[perf.well])
        # per-perforation molar mobility vectors (component rates per unit drawdown)
        mob_comp = np.zeros((npf, nc))
        mob_w = np.zeros(npf)
        is_inj = np.zeros(npf, bool)
        for k in range(npf):
            wnm = perf.names[perf.well[k]]
            w = self.wells[wnm]
            cc = c[k]
            wi = perf.wi[k] if open_w[perf.well[k]] else 0.0
            if w.kind == "INJ":
                is_inj[k] = True
                lt = lam_o[cc] + lam_g[cc] + lam_w[cc]
                if w.inj_type == KEY_W:
                    mob_w[k] = wi * lt * ps["bw"][cc]
                else:
                    zi = self._inj_composition(w)
                    fr_i = self.eos.flash(zi[None, :] + 1e-12, np.array([p0[cc]]), self.T)
                    vm = self.eos.molar_volume(zi[None, :], fr_i.Zv if fr_i.V[0] > 0.5 else fr_i.Zl,
                                               np.array([p0[cc]]), self.T)[0]
                    mob_comp[k] = wi * lt / vm * zi
            else:
                mob_comp[k] = wi * (lam_o[cc] * ps["xi_o"][cc] * ps["x"][cc] + lam_g[cc] * ps["xi_g"][cc] * ps["y"][cc])
                mob_w[k] = wi * lam_w[cc] * ps["bw"][cc]
        # surface conversion per perforation stream
        so_per_mol = np.zeros(npf)
        sg_per_mol = np.zeros(npf)
        if npf:
            tot = mob_comp.sum(axis=1)
            has = tot > 0
            if has.any():
                so_per_mol[has], sg_per_mol[has] = self._stc_flash(mob_comp[has] / tot[has, None])
        # reservoir volume per unit drawdown
        resv_coef = np.zeros(npf)
        for k in range(npf):
            cc = c[k]
            wi = perf.wi[k] if open_w[perf.well[k]] else 0.0
            resv_coef[k] = wi * (lam_o[cc] + lam_g[cc] + lam_w[cc])

        p_up = p0
        for outer in range(5):
            rows, cols, vals, rhs, face_data = build_faces(p_up)
            active_perf = np.ones(npf, bool)
            result = None
            for attempt in range(6):
                sol = self._solve_pressure(dt, n, nw, rows, cols, vals, rhs, diag_acc, pv, ps, p0, vbar, vbar_w, c, head,
                                           mob_comp, mob_w, so_per_mol, sg_per_mol, resv_coef, is_inj, open_w,
                                           active_perf)
                if sol is None:
                    return False, attempt + 1, {}
                p1, bhp1 = sol
                # crossflow check
                pwb = bhp1[perf.well] + head if npf else np.zeros(0)
                dd = p1[c] - pwb
                bad = active_perf & ((~is_inj & (dd < 0)) | (is_inj & (dd > 0)))
                changed = False
                if bad.any() and attempt < 3:
                    active_perf &= ~bad
                    changed = True
                # control switching
                switched = self._check_controls(p1, bhp1, c, head, mob_comp, mob_w, so_per_mol, sg_per_mol,
                                                resv_coef, active_perf, is_inj)
                if not (changed or switched):
                    result = (p1, bhp1)
                    break
                result = (p1, bhp1)
            # re-solve if any phase flux reversed direction relative to the upwinding used
            p1 = result[0]
            reversed_ = False
            for ph, Tl, G, cmol, up_a in face_data:
                q = -Tl * (p1[b] - p1[a] + G)
                bad = (Tl > 0) & (up_a != ((p1[b] - p1[a]) + G <= 0.0)) & (np.abs(q) > 1e-12)
                if bad.any():
                    reversed_ = True
            if not reversed_:
                break
            p_up = p1
        p1, bhp1 = result
        if np.any(~np.isfinite(p1)) or np.any(p1 <= 0):
            return False, 1, {}
        # --- explicit transport
        dN = np.zeros((n, nc))
        dW = np.zeros(n)
        outflow = np.zeros(n)
        for ph, Tl, G, cmol, up_a in face_data:
            q = -Tl * (p1[b] - p1[a] + G)          # reservoir volume rate a->b
            q = np.where((q >= 0.0) == up_a, q, 0.0)   # never transport against the upwind direction
            vol_out_a = np.maximum(q, 0.0)
            vol_out_b = np.maximum(-q, 0.0)
            np.add.at(outflow, a, vol_out_a)
            np.add.at(outflow, b, vol_out_b)
            if ph == "w":
                bw_up = np.where(up_a, ps["bw"][a], ps["bw"][b])
                np.add.at(dW, a, -q * bw_up)
                np.add.at(dW, b, q * bw_up)
            else:
                fl = q[:, None] * cmol
                np.add.at(dN, a, -fl)
                np.add.at(dN, b, fl)
        wrates = {}
        if npf:
            pwb = bhp1[perf.well] + head
            dd = (p1[c] - pwb) * active_perf
            qc = mob_comp * dd[:, None]           # moles/s out of reservoir (negative = injection)
            qw = mob_w * dd
            np.add.at(dN, c, -qc)
            np.add.at(dW, c, -qw)
            np.add.at(outflow, c, np.maximum(resv_coef * dd, 0.0))
            for wi_, nm in enumerate(perf.names):
                sel = perf.well == wi_
                w = self.wells[nm]
                mol = qc[sel].sum(axis=0)
                if w.kind == "INJ":
                    zi = self._inj_composition(w)
                    if w.inj_type == KEY_W:
                        wrates[nm] = {"oil": 0.0, "gas": 0.0, "water": float(qw[sel].sum())}
                    else:
                        so_s, sg_s = self._stc_cached(zi)
                        tot = float(mol.sum())
                        wrates[nm] = {"oil": tot * so_s, "gas": tot * sg_s, "water": 0.0}
                else:
                    oil = float(np.sum(so_per_mol[sel] * qc[sel].sum(axis=1)))
                    gas = float(np.sum(sg_per_mol[sel] * qc[sel].sum(axis=1)))
                    wrates[nm] = {"oil": oil, "gas": gas, "water": float(qw[sel].sum()), "moles": mol}
        N1 = N0 + dt * dN
        W1 = W0 + dt * dW
        # step acceptance: no significant negative moles, composition change limited
        Nt0 = N0.sum(axis=1)
        neg = N1 < -1e-8 * Nt0[:, None]
        cfl = np.max(outflow * dt / pv) if n else 0.0
        if neg.any() or cfl > 2.0:
            if neg.any():
                i, j = np.argwhere(neg)[0]
                self.log(f"    rejected: negative moles of {self.eos.names[j]} in cell {i} "
                         f"({N1[i, j] / Nt0[i]:.2e} of cell total), CFL={cfl:.2f}")
            else:
                self.log(f"    rejected: CFL={cfl:.2f}")
            return False, 1, {}
        N1 = np.maximum(N1, 1e-12 * np.maximum(Nt0, 1e-6)[:, None])
        W1 = np.maximum(W1, 0.0)
        z1 = N1 / N1.sum(axis=1, keepdims=True)
        dzmax = float(np.max(np.abs(z1 - ps["z"])))
        # new phase state (stability test on single-phase cells)
        try:
            ps1 = self._phase_state(p1, N1, W1, ps["fr"].K)
        except Exception as exc:   # pragma: no cover - EOS failure
            self.log(f"    flash failure: {exc}")
            return False, 1, {}
        ds = float(max(np.max(np.abs(ps1["sw"] - ps["sw"])), np.max(np.abs(ps1["sg"] - ps["sg"]))))
        dpmax = float(np.max(np.abs(p1 - p0)))
        self.state = {"p": p1, "N": N1, "W": W1, "K": ps1["fr"].K}
        self.ps = ps1
        for i, nm in enumerate(perf.names):
            self.bhp[nm] = float(bhp1[i])
        self.last = wrates
        self.cfl = cfl
        fac = min(self.opt.max_cfl / max(cfl, 1e-9), self.opt.max_dz_comp / max(dzmax, 1e-9),
                  self.opt.ds_target / max(ds, 1e-9) * 0.5)
        return True, 1, {"dp": dpmax, "ds": ds, "factor": max(fac, 0.25)}

    def _stc_cached(self, zi):
        key = tuple(np.round(zi, 10))
        if key not in self._stc_cache:
            so, sg = self._stc_flash(zi[None, :])
            self._stc_cache[key] = (float(so[0]), float(sg[0]))
        return self._stc_cache[key]

    def _solve_pressure(self, dt, n, nw, rows, cols, vals, rhs, diag_acc, pv, ps, p0, vbar, vbar_w, c, head,
                        mob_comp, mob_w, so_per_mol, sg_per_mol, resv_coef, is_inj, open_w, active_perf):
        perf = self.perf
        r = list(np.concatenate(rows)) if rows else []
        cl = list(np.concatenate(cols)) if cols else []
        v = list(np.concatenate(vals)) if vals else []
        r = np.asarray(r, int)
        cl = np.asarray(cl, int)
        v = np.asarray(v, float)
        b = rhs.copy() + (pv - ps["Vt"]) + diag_acc * p0
        # volume-weighted well coefficients: row c: -dt * w_c * (p_c - bhp - head)
        npf = c.size
        extra_r, extra_c, extra_v = [], [], []
        if npf:
            wvol = np.einsum("ij,ij->i", vbar[c], mob_comp) + vbar_w[c] * mob_w
            wvol = wvol * active_perf
            extra_r += [c, c]
            extra_c += [c, n + perf.well]
            extra_v += [-dt * wvol, dt * wvol]
            b = b.copy()
            np.add.at(b, c, -dt * wvol * head)
        # well equations
        wr, wc, wv = [], [], []
        wb = np.zeros(nw)
        for wi_, nm in enumerate(perf.names):
            w = self.wells[nm]
            sel = np.nonzero((perf.well == wi_) & active_perf)[0]
            row = n + wi_
            ctrl = self.controls[nm]
            if not open_w[wi_] or sel.size == 0:
                wr.append(row)
                wc.append(row)
                wv.append(1.0)
                wb[wi_] = self.bhp.get(nm, p0[c[perf.well == wi_]][0] if np.any(perf.well == wi_) else 1e7)
                continue
            if ctrl == "BHP":
                wr.append(row)
                wc.append(row)
                wv.append(1.0)
                wb[wi_] = w.targets.get("BHP", 1e5)
                continue
            # rate = sum_k coef_k * (p_c - bhp - head_k)   (production positive)
            if w.kind == "INJ":
                if w.inj_type == KEY_W:
                    coef = mob_w[sel]
                    target = -w.targets.get(ctrl, 0.0)
                    if ctrl == "RESV":
                        coef = resv_coef[sel]
                else:
                    zi = self._inj_composition(w)
                    so_s, sg_s = self._stc_cached(zi)
                    if ctrl == "RESV":
                        coef = resv_coef[sel]
                    else:
                        coef = mob_comp[sel].sum(axis=1) * (sg_s + so_s)
                    target = -w.targets.get(ctrl, 0.0)
            else:
                tot = mob_comp[sel].sum(axis=1)
                if ctrl == "ORAT":
                    coef = tot * so_per_mol[sel]
                elif ctrl == "GRAT":
                    coef = tot * sg_per_mol[sel]
                elif ctrl == "WRAT":
                    coef = mob_w[sel]
                elif ctrl == "LRAT":
                    coef = tot * so_per_mol[sel] + mob_w[sel]
                else:
                    coef = resv_coef[sel]
                target = w.targets.get(ctrl, 0.0)
            if np.sum(np.abs(coef)) <= 0:
                wr.append(row)
                wc.append(row)
                wv.append(1.0)
                wb[wi_] = w.targets.get("BHP", 1e5)
                self.controls[nm] = "BHP"
                continue
            sc = 1.0 / max(np.sum(np.abs(coef)), 1e-30)
            for k_local, k in enumerate(sel):
                wr.append(row)
                wc.append(c[k])
                wv.append(coef[k_local] * sc)
            wr.append(row)
            wc.append(row)
            wv.append(-np.sum(coef) * sc)
            wb[wi_] = (target + np.sum(coef * head[sel])) * sc
        N = n + nw
        allr = np.concatenate([r, np.arange(n)] + [np.asarray(x, int) for x in extra_r] + [np.asarray(wr, int)])
        allc = np.concatenate([cl, np.arange(n)] + [np.asarray(x, int) for x in extra_c] + [np.asarray(wc, int)])
        allv = np.concatenate([v, diag_acc] + [np.asarray(x, float) for x in extra_v] + [np.asarray(wv, float)])
        A = sp.csr_matrix((allv, (allr, allc)), shape=(N, N))
        rhs_all = np.concatenate([b, wb])
        try:
            x = solve_linear(A, rhs_all, self.opt.linear_solver)
        except Exception as exc:
            self.log(f"    pressure solve failed: {exc}")
            return None
        if not np.all(np.isfinite(x)):
            return None
        return x[:n], x[n:]

    def _check_controls(self, p1, bhp1, c, head, mob_comp, mob_w, so_per_mol, sg_per_mol, resv_coef, active_perf,
                        is_inj):
        perf = self.perf
        switched = False
        counts = self.__dict__.setdefault("_sw", {})
        for wi_, nm in enumerate(perf.names):
            w = self.wells[nm]
            if not w.is_open or counts.get(nm, 0) > 3:
                continue
            sel = np.nonzero((perf.well == wi_) & active_perf)[0]
            if sel.size == 0:
                continue
            dd = p1[c[sel]] - bhp1[wi_] - head[sel]
            tot = mob_comp[sel].sum(axis=1)
            ctrl = self.controls[nm]
            t = w.targets
            new = None
            if w.kind == "PROD":
                rates = {"ORAT": np.sum(tot * so_per_mol[sel] * dd), "GRAT": np.sum(tot * sg_per_mol[sel] * dd),
                         "WRAT": np.sum(mob_w[sel] * dd), "RESV": np.sum(resv_coef[sel] * dd)}
                rates["LRAT"] = rates["ORAT"] + rates["WRAT"]
                if ctrl != "BHP" and bhp1[wi_] < t.get("BHP", 0.0) * (1 - 1e-9):
                    new = "BHP"
                else:
                    worst, ratio = None, 1.0 + 1e-6
                    for k in ("ORAT", "WRAT", "GRAT", "LRAT", "RESV"):
                        if k != ctrl and t.get(k) and rates[k] / t[k] > ratio:
                            worst, ratio = k, rates[k] / t[k]
                    new = worst
            else:
                if w.inj_type == KEY_W:
                    rate = -np.sum(mob_w[sel] * dd)
                else:
                    so_s, sg_s = self._stc_cached(self._inj_composition(w))
                    rate = -np.sum(tot * (so_s + sg_s) * dd)
                if ctrl != "BHP" and bhp1[wi_] > t.get("BHP", 1e30) * (1 + 1e-9):
                    new = "BHP"
                elif ctrl == "BHP" and t.get("RATE") and rate > t["RATE"] * (1 + 1e-6):
                    new = "RATE"
            if new and new != ctrl:
                self.controls[nm] = new
                counts[nm] = counts.get(nm, 0) + 1
                switched = True
        return switched

    # ------------------------------------------------------------------ reporting
    def well_report(self):
        out = {}
        if self.perf is None:
            return out
        for nm in self.perf.names:
            w = self.wells[nm]
            r = self.last.get(nm, {"oil": 0.0, "gas": 0.0, "water": 0.0})
            out[nm] = {"oil": r["oil"], "water": r["water"], "gas": r["gas"], "bhp": self.bhp.get(nm, np.nan),
                       "open": w.is_open, "kind": w.kind, "control": self.controls.get(nm)}
        return out

    def field_state(self):
        st, ps = self.state, self.ps
        pv, _ = self.pore_volume(st["p"])
        hc = pv * (1.0 - ps["sw"])
        fpr = float(np.sum(st["p"] * hc) / max(np.sum(hc), 1e-30))
        so_m, sg_m = self._stc_flash(ps["z"])
        oip = float(np.sum(ps["Nt"] * so_m))
        gip = float(np.sum(ps["Nt"] * sg_m))
        return {"FPR": fpr, "FOIP": oip, "FGIP": gip, "FWIP": float(np.sum(st["W"]))}

    def cell_arrays(self):
        ps = self.ps
        out = {"PRESSURE": self.state["p"], "SWAT": ps["sw"], "SGAS": ps["sg"], "SOIL": ps["so"],
               "DENO": np.where(ps["so"] > 0, ps["rho_o"], np.nan), "DENG": np.where(ps["sg"] > 0, ps["rho_g"], np.nan)}
        for i, name in enumerate(self.eos.names):
            out[f"ZMF_{name}"] = ps["z"][:, i]
        return out
