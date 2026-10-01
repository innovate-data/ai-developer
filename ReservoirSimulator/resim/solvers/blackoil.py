"""Fully implicit three-phase black-oil solver (water / oil / gas with dissolved gas).

Primary variables per cell: oil pressure p, water saturation Sw and a
switching variable X = Sg (gas present) or X = Rs (undersaturated oil).
Each well adds its bottom-hole pressure as an unknown together with a control
equation (rate or BHP).  Residuals and Jacobian are assembled with the AD
module and solved with Newton-Raphson using a sparse direct (or ILU-
preconditioned iterative) linear solver.
"""
from __future__ import annotations

import numpy as np
import scipy.sparse as sp

from .. import ad as A
from ..ad import AD, combine, where
from ..wells import build_perforations
from .linear import solve_linear
from .wellcontrol import check_controls

RATE_KEYS_PROD = ("ORAT", "WRAT", "GRAT", "LRAT", "RESV")


class ConvergenceFailure(Exception):
    pass


class BlackOilSolver:
    def __init__(self, model, options, log=print):
        self.m = model
        self.opt = options
        self.log = log
        ph = model.phases
        self.has_w = ph["water"]
        self.has_g = ph["gas"]
        self.disgas = ph["disgas"] and self.has_g
        n = model.n_active
        self.n = n
        nf = model.conn_a.size
        self.C = sp.csr_matrix((np.r_[np.ones(nf), -np.ones(nf)],
                                (np.r_[np.arange(nf), np.arange(nf)], np.r_[model.conn_a, model.conn_b])),
                               shape=(nf, n))
        self.Ct = self.C.T.tocsr()
        self.dz = model.depth[model.conn_b] - model.depth[model.conn_a]
        pref = np.array([r[0] for r in model.rock])[model.rocknum]
        cr = np.array([r[1] for r in model.rock])[model.rocknum]
        self.rock_pref, self.rock_cr = pref, cr
        self.pvt_regions = [np.nonzero(model.pvtnum == r)[0] for r in range(len(model.pvt))]
        self.sat_regions = [np.nonzero(model.satnum == r)[0] for r in range(len(model.sat))]
        self.state = None
        self.bhp = {}
        self.controls = {}
        self.orig_controls = {}
        self.wells = {}
        self.perf = None
        self.last_rates = {}

    # ------------------------------------------------------------------ state
    def set_initial_state(self, init):
        st = {"p": init["p"].astype(float).copy(), "sw": init["sw"].astype(float).copy(),
              "sg": init["sg"].astype(float).copy(), "rs": init["rs"].astype(float).copy()}
        # cells without oil must use Sg as variable (Rs would not appear in any equation)
        no_oil = (1.0 - st["sw"] - st["sg"]) < 1e-6
        st["sat"] = (st["sg"] > 0) | no_oil if self.disgas else np.ones(self.n, bool)
        self.state = st

    # ------------------------------------------------------------------ properties
    def _regional(self, regions, fn, *vals):
        """Evaluate fn(region, *vals[cells]) per region and scatter results."""
        if len(regions) == 1:
            return fn(0, *vals)
        outs = None
        for r, cells in enumerate(regions):
            if cells.size == 0:
                continue
            res = fn(r, *(v[cells] for v in vals))
            if outs is None:
                outs = [np.zeros(self.n) for _ in res]
            for o, v in zip(outs, res):
                o[cells] = v
        return outs

    def rs_sat(self, p):
        return self._regional(self.pvt_regions, lambda r, pp: self.m.pvt[r].oil.rs_sat(pp), p)

    def props(self, p, sw, x, sat):
        """Return dict of AD/array quantities for current primary variables."""
        m = self.m
        out = {}
        pv = p.val if isinstance(p, AD) else p
        # saturations and Rs
        if self.has_g:
            if self.disgas:
                rsat, drsat = self.rs_sat(pv)
                rs_sat_ad = combine(rsat, (drsat, p)) if isinstance(p, AD) else rsat
                sg = where(sat, x, 0.0)
                rs = where(sat, rs_sat_ad, x)
            else:
                sg = x
                rs = np.zeros(self.n)
        else:
            sg = np.zeros(self.n)
            rs = np.zeros(self.n)
        if not self.has_w:
            sw = np.zeros(self.n)
        so = 1.0 - sw - sg
        out.update(sw=sw, sg=sg, so=so, rs=rs)
        swv, sgv, rsv = A.value(sw), A.value(sg), A.value(rs)

        # PVT
        def wfun(r, pp):
            return m.pvt[r].water.eval(pp)

        def ofun(r, pp, rr):
            return m.pvt[r].oil.eval(pp, rr)

        def gfun(r, pp):
            return m.pvt[r].gas.eval(pp)

        if self.has_w:
            b, db, mu, dmu = self._regional(self.pvt_regions, wfun, pv)
            out["bw"], out["muw"] = combine(b, (db, p)), combine(mu, (dmu, p))
        b, dbp, dbr, mu, dmup, dmur = self._regional(self.pvt_regions, ofun, pv, rsv)
        out["bo"] = combine(b, (dbp, p), (dbr, rs))
        out["muo"] = combine(mu, (dmup, p), (dmur, rs))
        if self.has_g:
            b, db, mu, dmu = self._regional(self.pvt_regions, gfun, pv)
            out["bg"], out["mug"] = combine(b, (db, p)), combine(mu, (dmu, p))

        # relative permeability & capillary pressure
        def sfun(r, s_w, s_g):
            t = m.sat[r]
            res = []
            if self.has_w:
                res += list(t.krw(s_w)) + list(t.pcow(s_w))
            else:
                res += [np.zeros_like(s_w)] * 4
            if self.has_g:
                kro, dkw, dkg = t.kro3(s_w, s_g) if self.has_w else (*t.krog(s_g), np.zeros_like(s_g))
                if not self.has_w:
                    kro, dkg, dkw = kro, dkw, np.zeros_like(s_g)
                res += [kro, dkw, dkg] + list(t.krg(s_g)) + list(t.pcgo(s_g))
            else:
                kro, dkro = t.krow(s_w)
                res += [kro, dkro, np.zeros_like(s_w)] + [np.zeros_like(s_w)] * 4
            return res

        (krw, dkrw, pcow, dpcow, kro, dkro_w, dkro_g, krg, dkrg, pcgo, dpcgo) = self._regional(
            self.sat_regions, sfun, swv, sgv)
        out["krw"] = combine(krw, (dkrw, sw)) if isinstance(sw, AD) else krw
        out["pcow"] = combine(pcow, (dpcow, sw)) if isinstance(sw, AD) else pcow
        out["kro"] = combine(kro, (dkro_w, sw), (dkro_g, sg))
        if self.has_g:
            out["krg"] = combine(krg, (dkrg, sg))
            out["pcgo"] = combine(pcgo, (dpcgo, sg))
        # pore volume
        X = self.rock_cr * (pv - self.rock_pref)
        pvv = m.pore_volume * (1.0 + X + 0.5 * X * X)
        dpv = m.pore_volume * (1.0 + X) * self.rock_cr
        out["pv"] = combine(pvv, (dpv, p)) if isinstance(p, AD) else pvv
        return out

    # ------------------------------------------------------------------ wells
    def setup_wells(self, wells):
        """Called at the start of each report step with the active well set."""
        self.wells = wells
        self.perf = build_perforations(self.m, wells, self.log)
        self.Sw = self.perf.sum_matrix()
        nperf = self.perf.cell.size
        self.Pc = sp.csr_matrix((np.ones(nperf), (self.perf.cell, np.arange(nperf))), shape=(self.n, nperf))
        p = self.state["p"]
        for wi, name in enumerate(self.perf.names):
            w = wells[name]
            self.controls[name] = w.control
            self.orig_controls[name] = w.control
            cells = self.perf.cell[self.perf.well == wi]
            if name not in self.bhp:
                pc = p[cells].mean() if cells.size else 1e7
                self.bhp[name] = pc - 1e5 if w.kind == "PROD" else pc + 1e5
            elif cells.size and w.is_open:
                # make sure a (re)opened well starts with a drawdown in the right direction
                if w.kind == "PROD":
                    self.bhp[name] = min(self.bhp[name], p[cells].min() - 1e5)
                else:
                    self.bhp[name] = max(self.bhp[name], p[cells].max() + 1e5)

    def _well_density(self, pr):
        """Explicit mixture density per well for the wellbore hydrostatic head."""
        perf = self.perf
        rho = np.zeros(perf.n_wells)
        if perf.cell.size == 0:
            return rho
        c = perf.cell
        rw = A.value(pr["bw"])[c] * self.m.pvt[0].rho_ws if self.has_w else 0.0
        ro = A.value(pr["bo"])[c] * (self.m.pvt[0].rho_os + A.value(pr["rs"])[c] * self.m.pvt[0].rho_gs)
        rg = A.value(pr["bg"])[c] * self.m.pvt[0].rho_gs if self.has_g else 0.0
        lw = A.value(pr["krw"])[c] / A.value(pr["muw"])[c] if self.has_w else 0.0
        lo = A.value(pr["kro"])[c] / A.value(pr["muo"])[c]
        lg = A.value(pr["krg"])[c] / A.value(pr["mug"])[c] if self.has_g else 0.0
        lt = lw + lo + lg + 1e-30
        mix = (rw * lw + ro * lo + rg * lg) / lt
        for wi, name in enumerate(perf.names):
            sel = perf.well == wi
            if not sel.any():
                continue
            w = self.wells[name]
            if w.kind == "INJ":
                d = {"WATER": rw, "GAS": rg, "OIL": ro}.get(w.inj_type, ro)
                d = d[sel] if isinstance(d, np.ndarray) else d
                rho[wi] = np.mean(d)
            else:
                rho[wi] = np.average(mix[sel], weights=perf.wi[sel] + 1e-30)
        return rho

    def _well_terms(self, p, pr, bhp, rho_w):
        """Perforation surface rates (production positive) and well equations."""
        perf = self.perf
        m = self.m
        g = m.gravity
        c = perf.cell
        nw = perf.n_wells
        open_w = np.array([self.wells[n].is_open for n in perf.names], bool)
        is_inj = np.array([self.wells[n].kind == "INJ" for n in perf.names], bool)
        head = rho_w[perf.well] * g * (perf.depth - perf.ref_depth[perf.well])
        self._head = head
        wi = perf.wi * open_w[perf.well]
        pwb = bhp[perf.well] + head
        dd = p[c] - pwb                                   # >0 : flow into well
        ddv = dd.val
        prod = ~is_inj[perf.well]
        inj = is_inj[perf.well]
        # producers
        mob = {}
        mob["o"] = pr["kro"][c] * pr["bo"][c] / pr["muo"][c]
        if self.has_w:
            mob["w"] = pr["krw"][c] * pr["bw"][c] / pr["muw"][c]
        if self.has_g:
            mob["g"] = pr["krg"][c] * pr["bg"][c] / pr["mug"][c]
        on_p = (prod & (ddv > 0)).astype(float) * wi
        q = {ph: mob[ph] * dd * on_p for ph in mob}
        if self.has_g:
            q["g"] = q["g"] + (pr["rs"][c] if isinstance(pr["rs"], AD) else pr["rs"][c]) * q["o"]
        # injectors: total mobility times injected phase b
        lt = pr["kro"][c] / pr["muo"][c]
        if self.has_w:
            lt = lt + pr["krw"][c] / pr["muw"][c]
        if self.has_g:
            lt = lt + pr["krg"][c] / pr["mug"][c]
        on_i = (inj & (ddv < 0)).astype(float) * wi
        inj_type = np.array([self.wells[n].inj_type for n in perf.names])[perf.well] if c.size else np.array([])
        for ph, key, bkey in (("w", "WATER", "bw"), ("g", "GAS", "bg"), ("o", "OIL", "bo")):
            if ph not in q:
                continue
            sel = on_i * (inj_type == key)
            if sel.any():
                q[ph] = q[ph] + lt * pr[bkey][c] * dd * sel     # dd<0 -> negative production
        # well rates (production positive)
        rate = {ph: A.matmul(self.Sw, q[ph]) for ph in q}
        # reservoir volume rate
        resv = q["o"] / pr["bo"][c]
        if self.has_w:
            resv = resv + q["w"] / pr["bw"][c]
        if self.has_g:
            free_g = q["g"] - (pr["rs"][c] * q["o"] if isinstance(pr["rs"], AD) else pr["rs"][c] * q["o"])
            resv = resv + free_g / pr["bg"][c]
        rate["resv"] = A.matmul(self.Sw, resv)
        # control equations (vectorised over wells)
        zero = bhp * 0.0
        has_perf = np.bincount(perf.well, minlength=nw) > 0 if c.size else np.zeros(nw, bool)
        ctrl = np.array([self.controls[n] for n in perf.names])
        kind = np.array([self.wells[n].kind for n in perf.names])
        itype = np.array([self.wells[n].inj_type for n in perf.names])
        active = open_w & has_perf
        tgt = np.array([self.wells[n].targets.get(self.controls[n], 0.0) or 0.0 for n in perf.names], float)
        tgt_bhp = np.array([self.wells[n].targets.get("BHP", 1e5) for n in perf.names], float)
        # shut wells: pin BHP to the first connection's cell pressure (no flow)
        first = np.zeros(nw)
        for wi_ in np.nonzero(~active)[0]:
            cells = c[perf.well == wi_]
            first[wi_] = p.val[cells[0]] if cells.size else bhp.val[wi_]
        eq = where(~active, bhp - first, zero)
        eq = eq + where(active & (ctrl == "BHP"), bhp - tgt_bhp, zero)
        prod_w = active & (kind == "PROD")
        inj_w = active & (kind == "INJ")
        liq = rate["o"] + rate["w"] if "w" in rate else rate["o"]
        for key, r in (("ORAT", rate["o"]), ("WRAT", rate.get("w", zero)), ("GRAT", rate.get("g", zero)),
                       ("LRAT", liq), ("RESV", rate["resv"])):
            sel = prod_w & (ctrl == key)
            if sel.any():
                eq = eq + where(sel, r - tgt, zero)
        for ph, key in (("w", "WATER"), ("g", "GAS"), ("o", "OIL")):
            sel = inj_w & (ctrl == "RATE") & (itype == key)
            if sel.any() and ph in rate:
                eq = eq + where(sel, -rate[ph] - tgt, zero)
        sel = inj_w & (ctrl == "RESV")
        if sel.any():
            eq = eq + where(sel, -rate["resv"] - tgt, zero)
        return q, rate, eq

    # ------------------------------------------------------------------ assembly
    def assemble(self, vars_, old, dt, rho_w):
        p, sw, x, bhp = vars_
        st = self.state_iter
        pr = self.props(p, sw, x, st["sat"])
        m = self.m
        a, b = m.conn_a, m.conn_b
        T = m.conn_T
        g = m.gravity
        eqs = {}
        phases = [("o", "bo", "muo", "kro")]
        if self.has_w:
            phases.append(("w", "bw", "muw", "krw"))
        if self.has_g:
            phases.append(("g", "bg", "mug", "krg"))
        pvt0 = m.pvt[0]
        dens_s = {"o": pvt0.rho_os, "w": pvt0.rho_ws, "g": pvt0.rho_gs}
        flux = {}
        for ph, bk, mk, kk in phases:
            bb = pr[bk]
            if ph == "o":
                rho = bb * (dens_s["o"] + pr["rs"] * dens_s["g"]) if isinstance(pr["rs"], AD) else bb * (
                    dens_s["o"] + pr["rs"] * dens_s["g"])
                pp = p
            elif ph == "w":
                rho = bb * dens_s["w"]
                pp = p - pr["pcow"]
            else:
                rho = bb * dens_s["g"]
                pp = p + pr["pcgo"]
            mob = pr[kk] * bb / pr[mk]
            rho_f = (rho[a] + rho[b]) * 0.5
            dpot = pp[b] - pp[a] - rho_f * (g * self.dz)
            up = dpot.val <= 0.0                       # flow a -> b
            mob_up = where(up, mob[a], mob[b])
            f = mob_up * dpot * (-T)
            flux[ph] = f
            if ph == "o" and self.has_g:
                rs = pr["rs"]
                rs_up = where(up, rs[a], rs[b]) if isinstance(rs, AD) else np.where(up, rs[a], rs[b])
                flux["dg"] = f * rs_up
        pv = pr["pv"]
        q, rate, weq = self._well_terms(p, pr, bhp, rho_w)
        # accumulation
        acc = {"o": pv * pr["bo"] * pr["so"]}
        if self.has_w:
            acc["w"] = pv * pr["bw"] * pr["sw"]
        if self.has_g:
            acc["g"] = pv * pr["bg"] * pr["sg"] + pv * pr["bo"] * pr["so"] * pr["rs"]
        for ph in acc:
            div = A.matmul(self.Ct, flux[ph])
            if ph == "g":
                div = div + A.matmul(self.Ct, flux["dg"])
            src = A.matmul(self.Pc, q[ph])
            eqs[ph] = (acc[ph] - old[ph]) * (1.0 / dt) + div + src
        return eqs, weq, pr, rate

    def accumulation_values(self, st):
        pr = self.props(st["p"], st["sw"], st["sg"] if not self.disgas else np.where(st["sat"], st["sg"], st["rs"]),
                        st["sat"])
        v = lambda x: A.value(x)
        acc = {"o": v(pr["pv"]) * v(pr["bo"]) * v(pr["so"])}
        if self.has_w:
            acc["w"] = v(pr["pv"]) * v(pr["bw"]) * v(pr["sw"])
        if self.has_g:
            acc["g"] = v(pr["pv"]) * (v(pr["bg"]) * v(pr["sg"]) + v(pr["bo"]) * v(pr["so"]) * v(pr["rs"]))
        return acc, pr

    # ------------------------------------------------------------------ Newton
    def _primary(self, st):
        x = None
        if self.has_g:
            x = np.where(st["sat"], st["sg"], st["rs"]) if self.disgas else st["sg"].copy()
        bhp = np.array([self.bhp[n] for n in self.perf.names]) if self.perf.n_wells else np.zeros(0)
        return st["p"].copy(), st["sw"].copy(), x, bhp

    def step(self, dt):
        """Advance one time step. Returns (converged, iterations, info dict)."""
        st0 = self.state
        old, pr0 = self.accumulation_values(st0)
        rho_w = self._well_density(pr0) if self.perf.cell.size else np.zeros(self.perf.n_wells)
        st = {k: (v.copy() if isinstance(v, np.ndarray) else v) for k, v in st0.items()}
        saved_bhp = dict(self.bhp)
        saved_ctrl = dict(self.controls)
        self.state_iter = st
        self._switch_count = {}
        tol_cnv = self.opt.newton_tol
        nw = self.perf.n_wells
        converged = False
        it = 0
        for it in range(1, self.opt.max_newton + 1):
            p0, sw0, x0, bhp0 = self._primary(st)
            vals = [p0]
            if self.has_w:
                vals.append(sw0)
            if self.has_g:
                vals.append(x0)
            vals.append(bhp0)
            ads = A.initialize(vals)
            p = ads[0]
            k = 1
            sw = ads[k] if self.has_w else st["sw"]
            k += 1 if self.has_w else 0
            x = ads[k] if self.has_g else None
            k += 1 if self.has_g else 0
            bhp = ads[k]
            eqs, weq, pr, rate = self.assemble((p, sw, x, bhp), old, dt, rho_w)
            # well control switching on the current iterate
            if it <= self.opt.max_newton - 3:
                switched = check_controls(self, rate, bhp.val)
                if switched:
                    eqs, weq, pr, rate = self.assemble((p, sw, x, bhp), old, dt, rho_w)
            # convergence check
            pvv = A.value(pr["pv"])
            cnv = 0.0
            mb = 0.0
            for ph, bk in (("o", "bo"), ("w", "bw"), ("g", "bg")):
                if ph in eqs:
                    r = eqs[ph].val
                    bref = A.value(pr[bk])
                    cnv = max(cnv, np.max(np.abs(r) * dt / (pvv * np.maximum(bref, 1e-12)) if r.size else 0))
                    mb = max(mb, abs(np.sum(r)) * dt / np.sum(pvv * bref))
            wres = 0.0
            if nw:
                scale = np.array([self._eq_scale(n) for n in self.perf.names])
                wres = np.max(np.abs(weq.val) / scale)
            if it > 1 and cnv < tol_cnv and mb < 1e-7 and wres < 1e-6:
                converged = True
                break
            order = ["o"] + (["w"] if self.has_w else []) + (["g"] if self.has_g else [])
            R = A.vstack([eqs[ph] for ph in order] + ([weq] if nw else []))
            try:
                dx = solve_linear(R.jac, -R.val, self.opt.linear_solver, self.n, len(order))
            except Exception as exc:  # singular matrix etc.
                self.log(f"    linear solver failure: {exc}")
                break
            if not np.all(np.isfinite(dx)):
                break
            self._update(st, dx)
        info = {"newton": it}
        if not converged:
            self.bhp = saved_bhp
            self.controls = saved_ctrl
            return False, it, info
        # accept
        dp = np.max(np.abs(st["p"] - st0["p"]))
        ds = max(np.max(np.abs(st["sw"] - st0["sw"])), np.max(np.abs(st["sg"] - st0["sg"])))
        info.update(dp=dp, ds=ds)
        self.state = st
        self.last_rates = {k: v.val.copy() for k, v in rate.items()}
        self.last_rates["bhp"] = np.array([self.bhp[n] for n in self.perf.names])
        return True, it, info

    def _eq_scale(self, name):
        w = self.wells[name]
        ctrl = self.controls[name]
        if ctrl == "BHP" or not w.is_open:
            return 1.0e3          # 1 kPa
        tgt = abs(w.targets.get(ctrl, 0.0) or 0.0)
        return max(tgt, 1e-5)

    def _update(self, st, dx):
        n = self.n
        k = 0
        dp = dx[k:k + n]
        k += n
        dsw = np.zeros(n)
        if self.has_w:
            dsw = dx[k:k + n]
            k += n
        dX = np.zeros(n)
        if self.has_g:
            dX = dx[k:k + n]
            k += n
        dbhp = dx[k:]
        p = st["p"]
        # pressure chop
        lim = np.maximum(0.2 * np.abs(p), 2e5)
        dp = np.clip(dp, -lim, lim)
        # saturation chop (per cell)
        sat = st["sat"]
        dsg = np.where(sat, dX, 0.0) if self.disgas else dX
        mx = np.maximum(np.abs(dsw), np.abs(dsg))
        fac = np.where(mx > self.opt.ds_max, self.opt.ds_max / np.maximum(mx, 1e-30), 1.0)
        st["p"] = p + dp
        if self.has_w:
            st["sw"] = np.clip(st["sw"] + fac * dsw, 0.0, 1.0)
        if self.has_g:
            if self.disgas:
                sg_new = st["sg"] + fac * dsg
                rs_new = st["rs"] + np.where(~sat, dX, 0.0)
                rsat = self.rs_sat(st["p"])[0]
                # saturated -> undersaturated when gas disappears (only where oil is present)
                so_new = 1.0 - st["sw"] - np.maximum(sg_new, 0.0)
                to_us = sat & (sg_new < 0.0) & (so_new > 1e-6)
                # undersaturated -> saturated when Rs exceeds Rs_sat
                to_s = (~sat) & (rs_new > rsat)
                sg_new = np.where(to_us | (~sat & ~to_s), 0.0, sg_new)
                rs_new = np.where(sat & ~to_us, rsat, rs_new)
                rs_new = np.where(to_us, rsat * (1 - 1e-6), rs_new)
                rs_new = np.where(to_s, rsat, rs_new)
                new_sat = (sat & ~to_us) | to_s
                st["sat"] = new_sat
                st["sg"] = np.clip(sg_new, 0.0, 1.0)
                st["rs"] = np.maximum(rs_new, 0.0)
            else:
                st["sg"] = np.clip(st["sg"] + fac * dsg, 0.0, 1.0)
        # keep So >= 0
        tot = st["sw"] + st["sg"]
        over = tot > 1.0
        if over.any():
            st["sg"] = np.where(over, np.maximum(1.0 - st["sw"], 0.0), st["sg"])
        # well bhp update with projection so that at least one connection flows
        head = getattr(self, "_head", np.zeros(self.perf.cell.size))
        for wi, name in enumerate(self.perf.names):
            b = self.bhp[name] + float(np.clip(dbhp[wi], -0.2 * abs(self.bhp[name]) - 1e5, 0.2 * abs(self.bhp[name]) + 1e5))
            w = self.wells[name]
            sel = self.perf.well == wi
            if self.controls.get(name) != "BHP" and w.is_open and sel.any():
                pc = st["p"][self.perf.cell[sel]] - head[sel]
                eps = 1e-9 * abs(b) + 1e-6
                if w.kind == "PROD":
                    b = min(b, pc.max() - eps)
                else:
                    b = max(b, pc.min() + eps)
            self.bhp[name] = max(b, 1e3)

    # ------------------------------------------------------------------ reporting
    def well_report(self):
        """Per-well surface rates (production positive) and BHP from the last step."""
        out = {}
        r = self.last_rates
        if self.perf is None:
            return out
        for wi, name in enumerate(self.perf.names):
            w = self.wells[name]
            o = r.get("o", np.zeros(self.perf.n_wells))[wi]
            wa = r.get("w", np.zeros(self.perf.n_wells))[wi]
            gg = r.get("g", np.zeros(self.perf.n_wells))[wi]
            out[name] = {"oil": o, "water": wa, "gas": gg, "bhp": self.bhp[name], "open": w.is_open,
                         "kind": w.kind, "control": self.controls.get(name)}
        return out

    def field_state(self):
        st = self.state
        acc, pr = self.accumulation_values(st)
        pvv = A.value(pr["pv"])
        hc = pvv * (1.0 - st["sw"])
        fpr = float(np.sum(st["p"] * hc) / max(np.sum(hc), 1e-30))
        oip = float(np.sum(pvv * A.value(pr["bo"]) * A.value(pr["so"])))
        gip = float(np.sum(acc["g"])) if self.has_g else 0.0
        wip = float(np.sum(acc["w"])) if self.has_w else 0.0
        return {"FPR": fpr, "FOIP": oip, "FGIP": gip, "FWIP": wip}

    def cell_arrays(self):
        st = self.state
        out = {"PRESSURE": st["p"], "SWAT": st["sw"], "SGAS": st["sg"], "SOIL": 1.0 - st["sw"] - st["sg"]}
        if self.disgas:
            out["RS"] = st["rs"]
        return out
