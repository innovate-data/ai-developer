"""Fully implicit black-oil solver: water / oil / gas with dissolved gas (Rs),
vaporised oil (Rv), optional energy equation (THERMAL) and the CO2-brine
storage mode (CO2STORE, brine in the liquid slot, CO2 in the gas slot).

Primary variables per cell: oil pressure p, water saturation Sw, a switching
variable X and, for thermal runs, temperature T.  X depends on the cell's
phase state:

    state 0  oil and gas present     X = Sg   (Rs = Rs_sat(p), Rv = Rv_sat(p))
    state 1  undersaturated oil      X = Rs   (Sg = 0)
    state 2  undersaturated gas      X = Rv   (So = 0, Sg = 1 - Sw)

Each well adds its bottom-hole pressure with a control equation (rate or
BHP).  Residuals and Jacobian come from the AD module; Newton-Raphson with a
sparse direct or CPR-preconditioned GMRES linear solver.
"""
from __future__ import annotations

import numpy as np
import scipy.sparse as sp

from .. import ad as A
from ..ad import AD, combine, where
from ..wells import build_perforations
from .linear import solve_linear
from .wellcontrol import check_controls

T0 = 273.15            # enthalpy reference temperature [K]


class BlackOilSolver:
    def __init__(self, model, options, log=print):
        self.m = model
        self.opt = options
        self.log = log
        ph = model.phases
        self.has_w = ph["water"]
        self.has_g = ph["gas"]
        self.disgas = ph["disgas"] and self.has_g
        self.vapoil = ph.get("vapoil", False) and self.has_g
        self.thermal = bool(getattr(model, "thermal", None))
        self.co2 = bool(getattr(model, "co2store", False))
        n = model.n_active
        self.n = n
        nf = model.conn_a.size
        self.C = sp.csr_matrix((np.r_[np.ones(nf), -np.ones(nf)],
                                (np.r_[np.arange(nf), np.arange(nf)], np.r_[model.conn_a, model.conn_b])),
                               shape=(nf, n))
        self.Ct = self.C.T.tocsr()
        self.dz = model.depth[model.conn_b] - model.depth[model.conn_a]
        self.rock_pref = np.array([r[0] for r in model.rock])[model.rocknum]
        self.rock_cr = np.array([r[1] for r in model.rock])[model.rocknum]
        self.pvt_regions = [np.nonzero(model.pvtnum == r)[0] for r in range(len(model.pvt))]
        self.sat_regions = [np.nonzero(model.satnum == r)[0] for r in range(len(model.sat))]
        pvt0 = model.pvt[0]
        self.rho_s = {"o": pvt0.rho_os, "w": pvt0.rho_ws, "g": pvt0.rho_gs}
        self.state = None
        self.bhp = {}
        self.controls = {}
        self.orig_controls = {}
        self.wells = {}
        self.perf = None
        self.last_rates = {}
        self.order = ["o"] + (["w"] if self.has_w else []) + (["g"] if self.has_g else []) + \
                     (["e"] if self.thermal else [])

    # ------------------------------------------------------------------ state
    def set_initial_state(self, init):
        n = self.n
        st = {"p": init["p"].astype(float).copy(), "sw": init["sw"].astype(float).copy(),
              "sg": init["sg"].astype(float).copy(), "rs": init["rs"].astype(float).copy(),
              "rv": init.get("rv", np.zeros(n)).astype(float).copy()}
        if self.thermal:
            st["T"] = init["T"].astype(float).copy()
        so = 1.0 - st["sw"] - st["sg"]
        state = np.zeros(n, np.int8)
        if self.disgas:
            state[(st["sg"] <= 0) & (so > 1e-6)] = 1
        if self.vapoil:
            rvs = self.rv_sat(st["p"])[0]
            state[(so <= 1e-6) & (st["sg"] > 1e-6) & (st["rv"] < rvs * (1 - 1e-9))] = 2
            st["rv"] = np.where(state == 2, st["rv"], rvs)
        if self.disgas:
            st["rs"] = np.where(state == 1, st["rs"], self.rs_sat(st["p"])[0])
        st["state"] = state
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

    def rv_sat(self, p):
        return self._regional(self.pvt_regions, lambda r, pp: self.m.pvt[r].gas.rv_sat(pp), p)

    def props(self, p, sw, x, T, state):
        """Dict of AD/array quantities for the current primary variables."""
        m = self.m
        out = {}
        pv_ = p.val if isinstance(p, AD) else p
        sat, nog, noo = state == 0, state == 1, state == 2
        if not self.has_w:
            sw = np.zeros(self.n)
        if self.has_g:
            if self.vapoil:
                sg = where(sat, x, where(noo, 1.0 - sw, 0.0))
            elif self.disgas:
                sg = where(sat, x, 0.0)
            else:
                sg = x
        else:
            sg = np.zeros(self.n)
        rs = np.zeros(self.n)
        rv = np.zeros(self.n)
        if self.disgas:
            v, d = self.rs_sat(pv_)
            rs = where(nog, x, combine(v, (d, p)))
        if self.vapoil:
            v, d = self.rv_sat(pv_)
            rv = where(noo, x, combine(v, (d, p)))
        so = 1.0 - sw - sg
        out.update(sw=sw, sg=sg, so=so, rs=rs, rv=rv)
        swv, sgv, rsv, rvv = A.value(sw), A.value(sg), A.value(rs), A.value(rv)

        # ---- PVT
        if self.has_w:
            b, db, mu, dmu = self._regional(self.pvt_regions, lambda r, pp: m.pvt[r].water.eval(pp), pv_)
            out["bw"], out["muw"] = combine(b, (db, p)), combine(mu, (dmu, p))
        b, dbp, dbr, mu, dmup, dmur = self._regional(self.pvt_regions, lambda r, pp, rr: m.pvt[r].oil.eval(pp, rr),
                                                     pv_, rsv)
        out["bo"] = combine(b, (dbp, p), (dbr, rs))
        out["muo"] = combine(mu, (dmup, p), (dmur, rs))
        if self.has_g:
            b, dbp, dbr, mu, dmup, dmur = self._regional(
                self.pvt_regions, lambda r, pp, rr: m.pvt[r].gas.eval(pp, rr), pv_, rvv)
            out["bg"] = combine(b, (dbp, p), (dbr, rv))
            out["mug"] = combine(mu, (dmup, p), (dmur, rv))
        if self.thermal:
            self._thermal_pvt(out, T)

        # ---- relative permeability & capillary pressure
        def sfun(r, s_w, s_g):
            t = m.sat[r]
            z = np.zeros_like(s_w)
            res = []
            if self.has_w:
                res += list(t.krw(s_w)) + list(t.pcow(s_w))
            else:
                res += [z] * 4
            if self.has_g:
                if self.has_w:
                    kro, dkw, dkg = t.kro3(s_w, s_g)
                else:
                    kro, dkg = t.krog(s_g)
                    dkw = z
                res += [kro, dkw, dkg] + list(t.krg(s_g)) + list(t.pcgo(s_g))
            else:
                kro, dkro = t.krow(s_w)
                res += [kro, dkro, z] + [z] * 4
            return res

        (krw, dkrw, pcow, dpcow, kro, dkro_w, dkro_g, krg, dkrg, pcgo, dpcgo) = self._regional(
            self.sat_regions, sfun, swv, sgv)
        out["krw"] = combine(krw, (dkrw, sw))
        out["pcow"] = combine(pcow, (dpcow, sw))
        out["kro"] = combine(kro, (dkro_w, sw), (dkro_g, sg))
        if self.has_g:
            out["krg"] = combine(krg, (dkrg, sg))
            out["pcgo"] = combine(pcgo, (dpcgo, sg))
        # ---- pore volume
        X = self.rock_cr * (pv_ - self.rock_pref)
        pvv = m.pore_volume * (1.0 + X + 0.5 * X * X)
        dpv = m.pore_volume * (1.0 + X) * self.rock_cr
        out["pv"] = combine(pvv, (dpv, p))
        # ---- reservoir mass densities (kg/m3) and surface mass per surface phase volume
        rs_, rho_ = self.rho_s, {}
        out["mo"] = rs_["o"] + rs * rs_["g"]                  # oil phase: oil + dissolved gas
        out["rho_o"] = out["bo"] * out["mo"]
        if self.has_w:
            out["mw"] = rs_["w"]
            out["rho_w"] = out["bw"] * rs_["w"]
        if self.has_g:
            out["mg"] = rs_["g"] + rv * rs_["o"]               # gas phase: gas + vaporised oil
            out["rho_g"] = out["bg"] * out["mg"]
        return out

    def _thermal_pvt(self, out, T):
        """Temperature effects: viscosity multipliers, water and gas thermal expansion, enthalpies."""
        th = self.m.thermal
        Tv = A.value(T)
        for ph, key in (("o", "muo"), ("w", "muw"), ("g", "mug")):
            fn = th["visc"].get(ph)
            if fn is not None and key in out:
                f, df = fn.eval(Tv)
                out[key] = out[key] * combine(f, (df, T))
        if self.has_w and th.get("watdent"):
            tref, c1, c2 = th["watdent"]
            dT = T - tref
            out["bw"] = out["bw"] / (1.0 + dT * c1 + dT * dT * c2)
        if self.has_g:
            out["bg"] = out["bg"] * (th["t_ref"] / T)            # ideal-gas thermal expansion
        cp = th["cp"]
        for ph in ("o", "w", "g"):
            c, dc = cp[ph](Tv)
            out["h" + ph] = combine(c * (Tv - T0), (c + dc * (Tv - T0), T))
        out["T"] = T

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
        v = A.value
        rw = v(pr["rho_w"])[c] if self.has_w else 0.0
        ro = v(pr["rho_o"])[c]
        rg = v(pr["rho_g"])[c] if self.has_g else 0.0
        lw = v(pr["krw"])[c] / v(pr["muw"])[c] if self.has_w else 0.0
        lo = v(pr["kro"])[c] / v(pr["muo"])[c]
        lg = v(pr["krg"])[c] / v(pr["mug"])[c] if self.has_g else 0.0
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
        """Connection rates (production positive) per component, energy and well equations."""
        perf = self.perf
        m = self.m
        c = perf.cell
        nw = perf.n_wells
        open_w = np.array([self.wells[n].is_open for n in perf.names], bool)
        is_inj = np.array([self.wells[n].kind == "INJ" for n in perf.names], bool)
        head = rho_w[perf.well] * m.gravity * (perf.depth - perf.ref_depth[perf.well])
        self._head = head
        wi = perf.wi * open_w[perf.well]
        dd = p[c] - (bhp[perf.well] + head)                 # >0 : flow into the well
        ddv = dd.val
        prod = ~is_inj[perf.well]
        inj = is_inj[perf.well]
        # phase flows of producers (surface volumes of each phase)
        on_p = (prod & (ddv > 0)).astype(float) * wi
        qph = {"o": pr["kro"][c] * pr["bo"][c] / pr["muo"][c] * dd * on_p}
        if self.has_w:
            qph["w"] = pr["krw"][c] * pr["bw"][c] / pr["muw"][c] * dd * on_p
        if self.has_g:
            qph["g"] = pr["krg"][c] * pr["bg"][c] / pr["mug"][c] * dd * on_p
        # component flows
        q = {"o": qph["o"]}
        if self.has_w:
            q["w"] = qph["w"]
        if self.has_g:
            q["g"] = qph["g"] + pr["rs"][c] * qph["o"] if self.disgas else qph["g"]
            if self.vapoil:
                q["o"] = q["o"] + pr["rv"][c] * qph["g"]
        # injectors: total mobility times injected-phase b
        lt = pr["kro"][c] / pr["muo"][c]
        if self.has_w:
            lt = lt + pr["krw"][c] / pr["muw"][c]
        if self.has_g:
            lt = lt + pr["krg"][c] / pr["mug"][c]
        on_i = (inj & (ddv < 0)).astype(float) * wi
        inj_type = np.array([self.wells[n].inj_type for n in perf.names])[perf.well] if c.size else np.array([])
        qinj = {}
        for ph, key, bkey in (("w", "WATER", "bw"), ("g", "GAS", "bg"), ("o", "OIL", "bo")):
            if ph not in q:
                continue
            sel = on_i * (inj_type == key)
            if sel.any():
                qi = lt * pr[bkey][c] * dd * sel            # dd < 0 -> negative production
                q[ph] = q[ph] + qi
                qinj[ph] = qi
        rate = {ph: A.matmul(self.Sw, q[ph]) for ph in q}
        resv = qph["o"] / pr["bo"][c]
        if self.has_w:
            resv = resv + qph["w"] / pr["bw"][c]
        if self.has_g:
            resv = resv + qph["g"] / pr["bg"][c]
        for ph, qi in qinj.items():
            resv = resv + qi / pr[{"o": "bo", "w": "bw", "g": "bg"}[ph]][c]
        rate["resv"] = A.matmul(self.Sw, resv)
        # energy: producers carry the cell enthalpy, injectors the injection enthalpy
        if self.thermal:
            e = qph["o"] * pr["mo"][c] * pr["ho"][c]
            if self.has_w:
                e = e + qph["w"] * pr["mw"] * pr["hw"][c]
            if self.has_g:
                e = e + qph["g"] * pr["mg"][c] * pr["hg"][c]
            if qinj:
                t_inj = np.array([self.wells[n].inj_temp or self.m.thermal["t_ref"] for n in perf.names])[perf.well]
                cp = self.m.thermal["cp"]
                for ph, qi in qinj.items():
                    hinj = cp[ph](t_inj)[0] * (t_inj - T0)
                    e = e + qi * self.rho_s[ph] * hinj
            q["e"] = e
        # control equations (vectorised over wells)
        zero = bhp * 0.0
        has_perf = np.bincount(perf.well, minlength=nw) > 0 if c.size else np.zeros(nw, bool)
        ctrl = np.array([self.controls[n] for n in perf.names])
        kind = np.array([self.wells[n].kind for n in perf.names])
        itype = np.array([self.wells[n].inj_type for n in perf.names])
        active = open_w & has_perf
        tgt = np.array([self.wells[n].targets.get(self.controls[n], 0.0) or 0.0 for n in perf.names], float)
        tgt_bhp = np.array([self.wells[n].targets.get("BHP", 1e5) for n in perf.names], float)
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
    def accumulations(self, pr):
        acc = {"o": pr["pv"] * pr["bo"] * pr["so"]}
        if self.vapoil:
            acc["o"] = acc["o"] + pr["pv"] * pr["bg"] * pr["sg"] * pr["rv"]
        if self.has_w:
            acc["w"] = pr["pv"] * pr["bw"] * pr["sw"]
        if self.has_g:
            acc["g"] = pr["pv"] * pr["bg"] * pr["sg"]
            if self.disgas:
                acc["g"] = acc["g"] + pr["pv"] * pr["bo"] * pr["so"] * pr["rs"]
        if self.thermal:
            th = self.m.thermal
            e = pr["pv"] * pr["rho_o"] * pr["so"] * pr["ho"]
            if self.has_w:
                e = e + pr["pv"] * pr["rho_w"] * pr["sw"] * pr["hw"]
            if self.has_g:
                e = e + pr["pv"] * pr["rho_g"] * pr["sg"] * pr["hg"]
            acc["e"] = e + th["rock_heat"] * (pr["T"] - T0)
        return acc

    def assemble(self, vars_, old, dt, rho_w):
        p, sw, x, T, bhp = vars_
        st = self.state_iter
        pr = self.props(p, sw, x, T, st["state"])
        m = self.m
        a, b = m.conn_a, m.conn_b
        Tr = m.conn_T
        g = m.gravity
        phases = [("o", "bo", "muo", "kro", "rho_o")]
        if self.has_w:
            phases.append(("w", "bw", "muw", "krw", "rho_w"))
        if self.has_g:
            phases.append(("g", "bg", "mug", "krg", "rho_g"))
        flux = {}
        comp = {}
        for ph, bk, mk, kk, rk in phases:
            rho = pr[rk]
            pp = p if ph == "o" else (p - pr["pcow"] if ph == "w" else p + pr["pcgo"])
            mob = pr[kk] * pr[bk] / pr[mk]
            dpot = pp[b] - pp[a] - (rho[a] + rho[b]) * (0.5 * g * self.dz)
            up = dpot.val <= 0.0                       # flow a -> b
            f = where(up, mob[a], mob[b]) * dpot * (-Tr)
            flux[ph] = (f, up)
        fo, upo = flux["o"]
        comp["o"] = fo
        if self.has_w:
            comp["w"] = flux["w"][0]
        if self.has_g:
            fg, upg = flux["g"]
            comp["g"] = fg
            if self.disgas:
                rs = pr["rs"]
                comp["g"] = comp["g"] + fo * where(upo, rs[a], rs[b])
            if self.vapoil:
                rv = pr["rv"]
                comp["o"] = comp["o"] + fg * where(upg, rv[a], rv[b])
        if self.thermal:
            ef = None
            for ph in flux:
                f, up = flux[ph]
                mass = pr["m" + ph]
                h = pr["h" + ph]
                mh = mass * h if isinstance(mass, AD) or isinstance(h, AD) else mass * h
                term = f * where(up, mh[a], mh[b])
                ef = term if ef is None else ef + term
            Tt = pr["T"]
            comp["e"] = ef - (Tt[b] - Tt[a]) * m.thermal["conn_k"]       # conduction a->b
        q, rate, weq = self._well_terms(p, pr, bhp, rho_w)
        acc = self.accumulations(pr)
        eqs = {}
        for key in acc:
            eqs[key] = (acc[key] - old[key]) * (1.0 / dt) + A.matmul(self.Ct, comp[key]) + A.matmul(self.Pc, q[key])
        return eqs, weq, pr, rate

    def accumulation_values(self, st):
        x = self._x_of(st)
        pr = self.props(st["p"], st["sw"], x, st.get("T"), st["state"])
        acc = {k: A.value(v) for k, v in self.accumulations(pr).items()}
        return acc, pr

    # ------------------------------------------------------------------ Newton
    def _x_of(self, st):
        if not self.has_g:
            return None
        s = st["state"]
        return np.where(s == 0, st["sg"], np.where(s == 1, st["rs"], st["rv"]))

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
        rate = {}
        for it in range(1, self.opt.max_newton + 1):
            vals = [st["p"]]
            if self.has_w:
                vals.append(st["sw"])
            if self.has_g:
                vals.append(self._x_of(st))
            if self.thermal:
                vals.append(st["T"])
            vals.append(np.array([self.bhp[n] for n in self.perf.names]) if nw else np.zeros(0))
            ads = A.initialize(vals)
            k = 0
            p = ads[k]; k += 1
            sw = ads[k] if self.has_w else st["sw"]; k += 1 if self.has_w else 0
            x = ads[k] if self.has_g else None; k += 1 if self.has_g else 0
            T = ads[k] if self.thermal else None; k += 1 if self.thermal else 0
            bhp = ads[k]
            args = (p, sw, x, T, bhp)
            eqs, weq, pr, rate = self.assemble(args, old, dt, rho_w)
            if it <= self.opt.max_newton - 3 and check_controls(self, rate, bhp.val):
                eqs, weq, pr, rate = self.assemble(args, old, dt, rho_w)
            # convergence check
            pvv = A.value(pr["pv"])
            cnv = mb = 0.0
            for ph, bk in (("o", "bo"), ("w", "bw"), ("g", "bg")):
                if ph in eqs:
                    r = eqs[ph].val
                    bref = np.maximum(A.value(pr[bk]), 1e-12)
                    cnv = max(cnv, np.max(np.abs(r) * dt / (pvv * bref)) if r.size else 0.0)
                    mb = max(mb, abs(np.sum(r)) * dt / np.sum(pvv * bref))
                    # also relative to the amount of the component actually in place, so that a
                    # small inventory (e.g. injected CO2 in a large aquifer) is balanced accurately
                    inplace = max(abs(float(np.sum(old[ph]))), 1e-6 * float(np.sum(pvv * bref)))
                    mb = max(mb, 0.1 * abs(np.sum(r)) * dt / inplace)      # i.e. 1e-6 of the inventory
            econv = True
            if self.thermal:
                heat_cap = self._heat_capacity(pr)
                re = eqs["e"].val
                econv = (np.max(np.abs(re) * dt / heat_cap) < self.opt.thermal_tol and
                         abs(np.sum(re)) * dt / np.sum(heat_cap) < 1e-6)
            wres = 0.0
            if nw:
                scale = np.array([self._eq_scale(n) for n in self.perf.names])
                wres = np.max(np.abs(weq.val) / scale)
            if it > 1 and cnv < tol_cnv and mb < 1e-7 and wres < 1e-6 and econv:
                converged = True
                break
            R = A.vstack([eqs[k_] for k_ in self.order] + ([weq] if nw else []))
            try:
                dx = solve_linear(R.jac, -R.val, self.opt.linear_solver, self.n, len(self.order))
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
        info.update(dp=np.max(np.abs(st["p"] - st0["p"])),
                    ds=max(np.max(np.abs(st["sw"] - st0["sw"])), np.max(np.abs(st["sg"] - st0["sg"]))))
        if self.thermal:
            dT = np.max(np.abs(st["T"] - st0["T"]))
            info["factor"] = min(2.0, self.opt.dT_target / max(dT, 1e-9))
        self.state = st
        self.last_rates = {k_: v.val.copy() for k_, v in rate.items()}
        self.last_rates["bhp"] = np.array([self.bhp[n] for n in self.perf.names])
        return True, it, info

    def _heat_capacity(self, pr):
        v = A.value
        th = self.m.thermal
        Tv = v(pr["T"])
        c = th["rock_heat"] + v(pr["pv"]) * v(pr["rho_o"]) * v(pr["so"]) * th["cp"]["o"](Tv)[0]
        if self.has_w:
            c = c + v(pr["pv"]) * v(pr["rho_w"]) * v(pr["sw"]) * th["cp"]["w"](Tv)[0]
        if self.has_g:
            c = c + v(pr["pv"]) * v(pr["rho_g"]) * v(pr["sg"]) * th["cp"]["g"](Tv)[0]
        return c

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
        dp = dx[k:k + n]; k += n
        dsw = np.zeros(n)
        if self.has_w:
            dsw = dx[k:k + n]; k += n
        dX = np.zeros(n)
        if self.has_g:
            dX = dx[k:k + n]; k += n
        if self.thermal:
            dT = dx[k:k + n]; k += n
            st["T"] = st["T"] + np.clip(dT, -self.opt.dT_max, self.opt.dT_max)
        dbhp = dx[k:]
        p = st["p"]
        lim = np.maximum(0.2 * np.abs(p), 2e5)
        st["p"] = p + np.clip(dp, -lim, lim)
        state = st["state"]
        sat, nog, noo = state == 0, state == 1, state == 2
        dsg = np.where(sat, dX, 0.0)
        mx = np.maximum(np.abs(dsw), np.abs(dsg))
        fac = np.where(mx > self.opt.ds_max, self.opt.ds_max / np.maximum(mx, 1e-30), 1.0)
        if self.has_w:
            st["sw"] = np.clip(st["sw"] + fac * dsw, 0.0, 1.0)
        if self.has_g:
            new_state = state.copy()
            sg_new = np.where(sat, st["sg"] + fac * dsg, st["sg"])
            sg_new = np.where(noo, 1.0 - st["sw"], sg_new)
            rs_new, rv_new = st["rs"].copy(), st["rv"].copy()
            if self.disgas:
                rsat = self.rs_sat(st["p"])[0]
                rs_new = np.where(nog, st["rs"] + dX, rsat)
                so_new = 1.0 - st["sw"] - np.maximum(sg_new, 0.0)
                to_us = sat & (sg_new < 0.0) & (so_new > 1e-6)          # gas disappears
                to_s = nog & (rs_new > rsat)                             # bubble point reached
                new_state[to_us] = 1
                new_state[to_s] = 0
                rs_new = np.where(to_us, rsat * (1 - 1e-6), np.where(to_s, rsat, rs_new))
                sg_new = np.where(to_us | (nog & ~to_s), 0.0, sg_new)
                rs_new = np.where(new_state == 0, rsat, rs_new)
            if self.vapoil:
                rvsat = self.rv_sat(st["p"])[0]
                rv_new = np.where(noo, st["rv"] + dX, rvsat)
                so_new = 1.0 - st["sw"] - sg_new
                to_ug = (state == 0) & (so_new < 0.0) & (sg_new > 1e-6)  # oil disappears
                to_s2 = noo & (rv_new > rvsat)                           # dew point reached
                new_state[to_ug] = 2
                new_state[to_s2] = 0
                rv_new = np.where(to_ug, rvsat * (1 - 1e-6), np.where(to_s2, rvsat, rv_new))
                sg_new = np.where(to_ug | to_s2 | (new_state == 2), 1.0 - st["sw"], sg_new)
                rv_new = np.where(new_state == 0, rvsat, rv_new)
            st["state"] = new_state
            st["sg"] = np.clip(sg_new, 0.0, 1.0)
            st["rs"] = np.maximum(rs_new, 0.0)
            st["rv"] = np.maximum(rv_new, 0.0)
        over = st["sw"] + st["sg"] > 1.0
        if over.any():
            st["sg"] = np.where(over, np.maximum(1.0 - st["sw"], 0.0), st["sg"])
        head = getattr(self, "_head", np.zeros(self.perf.cell.size))
        for wi, name in enumerate(self.perf.names):
            b = self.bhp[name] + float(np.clip(dbhp[wi], -0.2 * abs(self.bhp[name]) - 1e5, 0.2 * abs(self.bhp[name]) + 1e5))
            w = self.wells[name]
            sel = self.perf.well == wi
            if self.controls.get(name) != "BHP" and w.is_open and sel.any():
                pc = st["p"][self.perf.cell[sel]] - head[sel]
                eps = 1e-9 * abs(b) + 1e-6
                b = min(b, pc.max() - eps) if w.kind == "PROD" else max(b, pc.min() + eps)
            self.bhp[name] = max(b, 1e3)

    # ------------------------------------------------------------------ reporting
    def well_report(self):
        """Per-well surface rates (production positive) and BHP from the last step."""
        out = {}
        r = self.last_rates
        if self.perf is None:
            return out
        nw = self.perf.n_wells
        for wi, name in enumerate(self.perf.names):
            w = self.wells[name]
            o = r.get("o", np.zeros(nw))[wi]
            wa = r.get("w", np.zeros(nw))[wi]
            gg = r.get("g", np.zeros(nw))[wi]
            if self.co2:                      # brine is carried in the liquid (oil) slot
                o, wa = 0.0, o
            out[name] = {"oil": o, "water": wa, "gas": gg, "bhp": self.bhp[name], "open": w.is_open,
                         "kind": w.kind, "control": self.controls.get(name)}
        return out

    summary_units = {"FGIPL": "gas_surface_volume", "FGIPG": "gas_surface_volume", "FGIPM": "gas_surface_volume",
                     "FGIPR": "gas_surface_volume", "FCO2M": "mass", "FCO2D": None, "FTEMP": "temperature",
                     "FOIPL": "liquid_surface_volume", "FOIPG": "liquid_surface_volume"}

    def field_state(self):
        st = self.state
        acc, pr = self.accumulation_values(st)
        v = A.value
        pvv = v(pr["pv"])
        hc = pvv * (1.0 - st["sw"])
        out = {"FPR": float(np.sum(st["p"] * hc) / max(np.sum(hc), 1e-30)),
               "FOIP": float(np.sum(acc["o"])),
               "FGIP": float(np.sum(acc["g"])) if self.has_g else 0.0,
               "FWIP": float(np.sum(acc["w"])) if self.has_w else 0.0}
        if self.vapoil:
            out["FOIPL"] = float(np.sum(pvv * v(pr["bo"]) * v(pr["so"])))
            out["FOIPG"] = out["FOIP"] - out["FOIPL"]
        if self.co2:
            # brine reported as water; CO2 inventory split by phase and mobility
            out["FWIP"], out["FOIP"] = out["FOIP"], 0.0
            out.pop("FOIPL", None); out.pop("FOIPG", None)
            gas_phase = pvv * v(pr["bg"]) * v(pr["sg"])
            sgcr = np.array([t.sgcr for t in self.m.sat])[self.m.satnum]
            trapped = pvv * v(pr["bg"]) * np.minimum(v(pr["sg"]), sgcr)
            out["FGIPG"] = float(np.sum(gas_phase))
            out["FGIPL"] = out["FGIP"] - out["FGIPG"]
            out["FGIPR"] = float(np.sum(trapped))
            out["FGIPM"] = out["FGIPG"] - out["FGIPR"]
            out["FCO2M"] = out["FGIP"] * self.rho_s["g"]
            out["FCO2D"] = out["FGIPL"] / out["FGIP"] if out["FGIP"] > 0 else 0.0
        if self.thermal:
            out["FTEMP"] = float(np.sum(st["T"] * pvv) / np.sum(pvv))
        return out

    def cell_arrays(self):
        st = self.state
        so = 1.0 - st["sw"] - st["sg"]
        if self.co2:
            out = {"PRESSURE": st["p"], "SWAT": so, "SGAS": st["sg"], "RSW": st["rs"]}
            if self.vapoil:
                out["RVW"] = st["rv"]
            _, pr = self.accumulation_values(st)
            out["DENG"] = A.value(pr["rho_g"])
            out["DENW"] = A.value(pr["rho_o"])
            return out
        out = {"PRESSURE": st["p"], "SWAT": st["sw"], "SGAS": st["sg"], "SOIL": so}
        if self.disgas:
            out["RS"] = st["rs"]
        if self.vapoil:
            out["RV"] = st["rv"]
        if self.thermal:
            out["TEMP"] = st["T"]
        return out
