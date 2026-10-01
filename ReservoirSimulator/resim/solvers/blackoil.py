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
        self.econ_shut = {}          # wells closed by WECON -> status (SHUT/STOP), until reopened in the schedule
        self.econ_conns = set()      # (well, i, j, k) connections closed by WECON workovers
        self.thp_bhp = {}            # BHP (at the well datum) corresponding to the THP limit, per well
        self.vfp = {}
        self._rho_w = None
        self.last_perf = {}
        self._bhp_static = {}
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
        if getattr(self.m, "rock_store", False):          # ROCKOPTS STORE: initial pressure is the reference
            self.rock_pref = st["p"].copy()

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
    def _log_once(self, msg):
        seen = self.__dict__.setdefault("_logged", set())
        if msg not in seen:
            seen.add(msg)
            self.log(msg)

    def setup_wells(self, wells, touched=(), vfp=None):
        """Called at the start of each report step with the active well set.

        `touched` names the wells whose status the schedule set in this step: a well closed by
        an economic limit stays closed unless the schedule opens it again."""
        self.vfp = vfp or {}
        for name in list(self.econ_shut):
            if name not in wells:
                continue
            if name in touched:
                del self.econ_shut[name]
                self.econ_conns = {c for c in self.econ_conns if c[0] != name}
            else:
                wells[name].status = self.econ_shut[name]
        for name, i, j, k in self.econ_conns:
            if name in wells:
                for c in wells[name].completions:
                    if (c.i, c.j, c.k) == (i, j, k):
                        c.status = "SHUT"
        self.wells = wells
        self.perf = build_perforations(self.m, wells, self._log_once)
        self.Sw = self.perf.sum_matrix()
        nperf = self.perf.cell.size
        self.Pc = sp.csr_matrix((np.ones(nperf), (self.perf.cell, np.arange(nperf))), shape=(self.n, nperf))
        self._wbp_neighbours()
        p = self.state["p"]
        # perforation pressures referred to the well's BHP datum with the wellbore head, so that the
        # initial BHP gives inflow (producers) or outflow (injectors) in at least one connection
        pot = p[self.perf.cell].copy() if nperf else np.zeros(0)
        if nperf:
            _, pr0 = self.accumulation_values(self.state)
            rho = self._well_density(pr0)
            pot -= rho[self.perf.well] * self.m.gravity * (self.perf.depth - self.perf.ref_depth[self.perf.well])
        for wi, name in enumerate(self.perf.names):
            w = wells[name]
            self.controls[name] = w.control
            self.orig_controls[name] = w.control
            sel = self.perf.well == wi
            cells = self.perf.cell[sel]
            if cells.size:              # zero-flow BHP (reported before the first time step)
                self._bhp_static[name] = pot[sel].max() if w.kind == "PROD" else pot[sel].min()
            if name not in self.bhp:
                if cells.size:
                    self.bhp[name] = pot[sel].max() - 1e5 if w.kind == "PROD" else pot[sel].min() + 1e5
                else:
                    self.bhp[name] = 1e7
            elif cells.size and w.is_open:
                # make sure a (re)opened well starts with a drawdown in the right direction
                if w.kind == "PROD":
                    self.bhp[name] = min(self.bhp[name], pot[sel].max() - 1e5)
                else:
                    self.bhp[name] = max(self.bhp[name], pot[sel].min() + 1e5)

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
        # reservoir-volume rates with the formation volume factors at the field average pressure
        # (as ECLIPSE does for RESV controls and the WVPR/WVIR vectors): split the surface
        # components into free phases with Rs and Rv at that pressure
        Bf = self._resv_factors(c)
        qo_c, qg_c = q["o"], q.get("g", 0.0)
        rs_, rv_ = Bf["rs"], Bf["rv"]
        den = 1.0 - rs_ * rv_
        resv = (qo_c - rv_ * qg_c) * (Bf["bo"] / den)
        if self.has_g:
            resv = resv + (qg_c - rs_ * qo_c) * (Bf["bg"] / den)
        if self.has_w:
            resv = resv + q["w"] * Bf["bw"]
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
        if np.any(ctrl == "THP"):
            # THP control: BHP equal to the VFP-table BHP for the THP limit at the current rates
            # (lagged by one Newton iteration, see _update_thp)
            tgt_thp = np.array([self.thp_bhp.get(n, tgt_bhp[i]) for i, n in enumerate(perf.names)], float)
            eq = eq + where(active & (ctrl == "THP"), bhp - tgt_thp, zero)
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
        self._q_last = q
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
        self._rho_step = rho_w
        hc = self.m.pore_volume * np.maximum(1.0 - st0["sw"], 1e-12)
        self._p_avg = float(np.sum(st0["p"] * hc) / np.sum(hc))
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
            self._update_thp(rate, rho_w)
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
                dx = solve_linear(R.jac, -R.val, self.opt.linear_solver, self.n, len(self.order),
                                  rtol=getattr(self.opt, "linear_tol", 1e-5))
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
        self.last_perf = {k_: A.value(v).copy() for k_, v in self._q_last.items()}
        self._rho_w = self._rho_step
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

    def _resv_factors(self, cells):
        """Formation volume factors (and saturated Rs, Rv) at the field hydrocarbon-weighted average
        pressure of the start of the step, per perforation (its PVT region)."""
        key = (id(self.perf), getattr(self, "_p_avg", None))
        if getattr(self, "_resv_key", None) == key:
            return self._resv_cache
        pavg = getattr(self, "_p_avg", None)
        if pavg is None:
            st = self.state
            hc = self.m.pore_volume * np.maximum(1.0 - st["sw"], 1e-12)
            pavg = float(np.sum(st["p"] * hc) / np.sum(hc))
        n = cells.size
        P = np.full(n, pavg)
        out = {"bo": np.ones(n), "bw": np.ones(n), "bg": np.ones(n), "rs": np.zeros(n), "rv": np.zeros(n)}
        reg = self.m.pvtnum[cells] if n else np.zeros(0, int)
        for r in np.unique(reg):
            sel = reg == r
            pvt = self.m.pvt[r]
            pp = P[sel]
            rs = pvt.oil.rs_sat(pp)[0] if (self.disgas and not self.co2) else np.zeros(sel.sum())
            out["rs"][sel] = rs
            out["bo"][sel] = 1.0 / pvt.oil.eval(pp, rs)[0]
            if self.has_w:
                out["bw"][sel] = 1.0 / pvt.water.eval(pp)[0]
            if self.has_g:
                rv = pvt.gas.rv_sat(pp)[0] if self.vapoil else np.zeros(sel.sum())
                out["rv"][sel] = rv
                out["bg"][sel] = 1.0 / pvt.gas.eval(pp, rv)[0]
        self._resv_key, self._resv_cache = key, out
        return out

    # ------------------------------------------------------------------ VFP / THP
    def _vfp_table(self, w):
        if not w.vfp_table:
            return None
        return self.vfp.get(("PROD" if w.kind == "PROD" else "INJ", w.vfp_table))

    def _surface_rates(self, rate, wi):
        """(oil, water, gas) surface rates of well wi, production positive, in the solver slots."""
        v = lambda k: float(A.value(rate[k])[wi]) if k in rate else 0.0
        o, wa, g = v("o"), v("w"), v("g")
        if self.co2:
            o, wa = 0.0, o
        return o, wa, g

    def _update_thp(self, rate, rho_w):
        """BHP at the well datum that corresponds to each well's THP limit at its current rates."""
        for wi, name in enumerate(self.perf.names):
            w = self.wells[name]
            if not w.thp_limit or not w.is_open:
                continue
            t = self._vfp_table(w)
            if t is None:
                continue
            o, wa, g = self._surface_rates(rate, wi)
            if w.kind == "INJ":
                o, wa, g = -o, -wa, -g
            b = float(t.bhp_from_thp(w.thp_limit, o, wa, g, w.alq)[0])
            self.thp_bhp[name] = b + rho_w[wi] * self.m.gravity * (self.perf.ref_depth[wi] - t.datum)

    def well_thp(self, wi):
        """Tubing-head pressure of well wi from its VFP table and last rates (0 without a table)."""
        name = self.perf.names[wi]
        w = self.wells[name]
        t = self._vfp_table(w)
        if t is None or not w.is_open or self._rho_w is None:
            return 0.0
        o, wa, g = self._surface_rates(self.last_rates, wi)
        if w.kind == "INJ":
            o, wa, g = -o, -wa, -g
        if o + wa + g <= 0:
            return 0.0
        b = self.bhp[name] - self._rho_w[wi] * self.m.gravity * (self.perf.ref_depth[wi] - t.datum)
        return float(t.thp_from_bhp(b, o, wa, g, w.alq)[0])

    # ------------------------------------------------------------------ block-average pressures
    def _wbp_neighbours(self):
        """Active horizontal neighbours (4 and 8) of every perforation cell, for WBP4/5/9."""
        g = self.m.grid
        nx, ny = g.nx, g.ny
        g2a = self.m.global_to_active
        ac = self.m.active_cells
        nb4, nb8 = [], []
        for cell in self.perf.cell:
            i, j, k = (int(x) for x in g.ijk(ac[cell]))
            l4, l8 = [], []
            for di, dj in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)):
                ii, jj = i + di, j + dj
                if 0 <= ii < nx and 0 <= jj < ny:
                    a = g2a[ii + nx * (jj + ny * k)]
                    if a >= 0:
                        l8.append(a)
                        if abs(di) + abs(dj) == 1:
                            l4.append(a)
            nb4.append(np.array(l4, int))
            nb8.append(np.array(l8, int))
        self._nb4, self._nb8 = nb4, nb8

    def well_block_pressures(self, wi):
        """(WBP, WBP4, WBP5, WBP9) of well wi (Pa): connection-factor weighted averages over the
        open connections of the block pressures (WBP), the 4 horizontal neighbours (WBP4) and
        0.5 * block + 0.5 * neighbours (WBP5: 4 neighbours, WBP9: 8), each referred to the
        well's BHP datum with the wellbore density (no correction for a shut well)."""
        p = self.state["p"]
        sel = np.nonzero(self.perf.well == wi)[0]
        if sel.size == 0:
            return (0.0,) * 4
        name = self.perf.names[wi]
        w = self.wells[name]
        rho = self._rho_w[wi] if (self._rho_w is not None and w.is_open) else 0.0
        zref = self.perf.ref_depth[wi]
        z = self.m.depth
        cp = lambda cells: p[cells] - rho * self.m.gravity * (z[cells] - zref)
        wts = self.perf.wi[sel]
        if wts.sum() <= 0:
            wts = np.ones(sel.size)
        pc = cp(self.perf.cell[sel])
        p4 = np.array([cp(self._nb4[m]).mean() if self._nb4[m].size else pc[n] for n, m in enumerate(sel)])
        p8 = np.array([cp(self._nb8[m]).mean() if self._nb8[m].size else pc[n] for n, m in enumerate(sel)])
        avg = lambda v: float(np.sum(v * wts) / np.sum(wts))
        return avg(pc), avg(p4), avg(0.5 * pc + 0.5 * p4), avg(0.5 * pc + 0.5 * p8)

    # ------------------------------------------------------------------ economic limits
    def economic_limits(self):
        """Apply WECON limits after a converged time step. Returns (messages, end_run)."""
        msgs, end_run = [], False
        if self.perf is None:
            return msgs, end_run
        rep = self.well_report()
        for wi, name in enumerate(self.perf.names):
            w = self.wells[name]
            e = w.econ
            if not e or w.kind != "PROD" or not w.is_open:
                continue
            r = rep[name]
            o, wa, g = max(r["oil"], 0.0), max(r["water"], 0.0), max(r["gas"], 0.0)
            liq = o + wa
            if liq + g <= 0:
                continue
            reason, action = None, None
            for key, val in (("min_orat", o), ("min_grat", g), ("min_lrat", liq)):
                if e.get(key) and val < e[key]:
                    reason, action = f"{key.split('_')[1].upper()} below the economic limit", "WELL"
                    break
            if reason is None:
                ratios = {"max_wct": wa / liq if liq > 0 else 0.0, "max_gor": g / o if o > 0 else 0.0,
                          "max_wgr": wa / g if g > 0 else 0.0, "max_glr": g / liq if liq > 0 else 0.0}
                worst = [k for k, v in ratios.items() if e.get(k) and v > e[k]]
                if worst:
                    key = worst[0]
                    reason = f"{key.split('_')[1].upper()} {ratios[key]:.4g} above the limit {e[key]:.4g}"
                    action = e.get("workover", "NONE")
                    if key == "max_wct" and e.get("sec_wct") and ratios[key] > e["sec_wct"]:
                        action = e.get("sec_workover") or "WELL"
            if reason is None or action == "NONE":
                continue
            if action in ("CON", "+CON"):
                sel = np.nonzero((self.perf.well == wi) & (self.perf.wi > 0))[0]
                qo = self.last_perf.get("o", np.zeros(self.perf.cell.size))[sel]
                qw = self.last_perf.get("w", np.zeros(self.perf.cell.size))[sel]
                tot = np.maximum(qo + qw, 1e-30)
                worst_i = sel[int(np.argmax(qw / tot))] if sel.size > 1 else None
                if worst_i is not None:
                    close = [worst_i]
                    if action == "+CON":
                        d0 = self.perf.depth[worst_i]
                        close = [m for m in sel if self.perf.depth[m] >= d0]
                    comps = [c for c in w.completions if c.status == "OPEN" and c.cell >= 0]
                    for m in close:
                        for c in comps:
                            if c.cell == self.perf.cell[m]:
                                c.status = "SHUT"
                                self.econ_conns.add((name, c.i, c.j, c.k))
                        self.perf.wi[m] = 0.0
                    msgs.append(f"WECON: {name} {reason}; closed {len(close)} connection(s)")
                    if e.get("end_run"):
                        end_run = True
                    continue
                action = "WELL"            # last open connection: close the well
            # WELL or PLUG (plugging back is approximated by shutting the well)
            w.status = w.auto_shut if w.auto_shut in ("SHUT", "STOP") else "SHUT"
            self.econ_shut[name] = w.status
            msgs.append(f"WECON: {name} {reason}; well {w.status.lower()}")
            if e.get("end_run"):
                end_run = True
        return msgs, end_run

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
            bhp = self.bhp[name] if r else self._bhp_static.get(name, self.bhp[name])
            out[name] = {"oil": o, "water": wa, "gas": gg, "bhp": bhp, "open": w.is_open,
                         "kind": w.kind, "control": self.controls.get(name)}
        return out

    def well_extras(self):
        """Per-well quantities beyond the surface rates: {well: {mnemonic: (SI value, quantity)}}."""
        out = {}
        if self.perf is None:
            return out
        r = self.last_rates
        nw = self.perf.n_wells
        for wi, name in enumerate(self.perf.names):
            w = self.wells[name]
            open_ = w.is_open
            resv = float(r.get("resv", np.zeros(nw))[wi]) if open_ and r else 0.0
            o, wa, g = self._surface_rates(r, wi) if (open_ and r) else (0.0, 0.0, 0.0)
            prod = w.kind == "PROD"
            wbp = self.well_block_pressures(wi)
            d = {"WBP": (wbp[0], "pressure"), "WBP4": (wbp[1], "pressure"), "WBP5": (wbp[2], "pressure"),
                 "WBP9": (wbp[3], "pressure"),
                 "WTHP": (self.well_thp(wi), "pressure"),
                 "WVPR": (max(resv, 0.0) if prod else 0.0, "reservoir_rate"),
                 "WVIR": (max(-resv, 0.0) if not prod else 0.0, "reservoir_rate"),
                 "WOIR": (max(-o, 0.0) if not prod else 0.0, "liquid_surface_rate"),
                 "WLPR": (max(o, 0.0) + max(wa, 0.0) if prod else 0.0, "liquid_surface_rate"),
                 "WWGR": (wa / g if prod and g > 0 else 0.0, "wgr"),
                 "WGLR": (g / (o + wa) if prod and o + wa > 0 else 0.0, "rs"),
                 "WMVFP": (float(w.vfp_table), None),
                 # before the first step ECLIPSE reports the well type; afterwards open/shut/stopped
                 "WSTAT": (float((1 if prod else 2) if (open_ or not r) else (4 if w.status == "STOP" else 3)), None)}
            out[name] = d
        return out

    def phase_potentials(self, pr):
        """FPPO / FPPW / FPPG: phase pressures referred to the EQUIL datum depth of each cell's
        equilibration region with the phase density, averaged with weights PV0 * S_phase."""
        m = self.m
        st = self.state
        v = A.value
        if not m.equil:
            return {}
        datum = np.array([e["datum"] for e in m.equil])[np.clip(m.eqlnum, 0, len(m.equil) - 1)]
        dz = m.depth - datum
        pv0 = m.pore_volume
        p = st["p"]
        out = {}
        sw = v(pr["sw"]) if self.has_w else np.zeros(self.n)
        sg = v(pr["sg"]) if self.has_g else np.zeros(self.n)
        so = 1.0 - sw - sg
        def avg(val, s):
            wt = pv0 * s
            return float(np.sum(val * wt) / np.sum(wt)) if np.sum(wt) > 0 else 0.0
        out["FPPO"] = avg(p - v(pr["rho_o"]) * m.gravity * dz, so)
        if self.has_w:
            out["FPPW"] = avg(p - v(pr["pcow"]) - v(pr["rho_w"]) * m.gravity * dz, sw)
        if self.has_g:
            out["FPPG"] = avg(p + v(pr["pcgo"]) - v(pr["rho_g"]) * m.gravity * dz, sg)
        return out

    summary_units = {"FGIPL": "gas_surface_volume", "FGIPG": "gas_surface_volume", "FGIPM": "gas_surface_volume",
                     "FGIPR": "gas_surface_volume", "FCO2M": "mass", "FCO2D": None, "FTEMP": "temperature",
                     "FOIPL": "liquid_surface_volume", "FOIPG": "liquid_surface_volume",
                     "FPPO": "pressure", "FPPW": "pressure", "FPPG": "pressure"}

    def field_state(self):
        st = self.state
        acc, pr = self.accumulation_values(st)
        v = A.value
        pvv = v(pr["pv"])
        hc = self.m.pore_volume * (1.0 - st["sw"])          # hydrocarbon pore volume at reference pressure
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
        if not self.co2:
            out.update(self.phase_potentials(pr))
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
        out = {"PRESSURE": st["p"]}
        if self.has_w:
            out["SWAT"] = st["sw"]
        if self.has_g:
            out["SGAS"] = st["sg"]
        out["SOIL"] = so
        if self.disgas:
            out["RS"] = st["rs"]
        if self.vapoil:
            out["RV"] = st["rv"]
        if self.thermal:
            out["TEMP"] = st["T"]
        return out
