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
from .linear import STATS as LINEAR_STATS, solve_linear
from .wellcontrol import check_controls

T0 = 273.15            # enthalpy reference temperature [K]


SWITCH_BAND = 1e-3      # relative excess over saturation before a missing phase re-appears


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
        self.hyst = None             # hysteresis state (historical maximum non-wetting saturations)
        self.drsdt = self.drvdt = self.vappars = None
        self.rs_cap = self.rv_cap = None    # DRSDT / DRVDT limits for the current step
        self.so_max = None           # historical maximum oil saturation (VAPPARS)
        self.tracers = list(getattr(model, "tracers", []) or [])
        self.tracer_conc = {}        # tracer name -> concentration in its phase, per cell
        self.tracer_rates = {}       # tracer name -> {well: (production rate, injection rate)}
        self._setup_thpres()
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
        sf = getattr(self.m, "satfunc", None)
        self.hyst = sf.init_hysteresis(st["sw"], st["sg"]) if sf is not None and not self.co2 else None
        self.so_max = np.maximum(1.0 - st["sw"] - st["sg"], 0.0)
        for t in self.tracers:
            c = np.zeros(n)
            for r, tab in enumerate(t.get("init") or []):
                cells = self.m.eqlnum == r if len(t["init"]) > 1 else np.ones(n, bool)
                c[cells] = np.interp(self.m.depth[cells], tab[:, 0], tab[:, 1])
            self.tracer_conc[t["name"]] = c
        if self.thp_pairs:
            self._default_thpres(st)
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
        so = 1.0 - sw - sg
        sov = A.value(so)
        if self.disgas:
            v, d = self.rs_sat(pv_)
            v, d, dso = self._limit_ratio(v, d, sov, "rs")
            rs = where(nog, x, combine(v, (d, p), (dso, so)))
        if self.vapoil:
            v, d = self.rv_sat(pv_)
            v, d, dso = self._limit_ratio(v, d, sov, "rv")
            rv = where(noo, x, combine(v, (d, p), (dso, so)))
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

        sf = getattr(m, "satfunc", None)
        if sf is not None and sf.scaled and not self.co2:
            (krw, dkrw, pcow, dpcow, kro, dkro_w, dkro_g, krg, dkrg, pcgo, dpcgo) = sf.evaluate(
                swv, sgv, self.hyst)
        else:
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

    def _flowing(self, name):
        """An open well whose controlling rate target is zero (e.g. WCONHIST with zero observed
        rates) does not flow: it is treated like a shut well in the equations."""
        w = self.wells[name]
        if not w.is_open:
            return False
        ctrl = self.controls.get(name, w.control)
        if ctrl in ("BHP", "THP"):
            return True
        t = w.targets.get(ctrl)
        return t is None or t > 0

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
        open_w = np.array([self._flowing(n) for n in perf.names], bool)
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
        first_cell = np.full(nw, -1)
        for wi_ in np.nonzero(~active)[0]:
            cells = c[perf.well == wi_]
            if cells.size:
                first_cell[wi_] = cells[0]
        has_c = first_cell >= 0
        p_first = p[np.where(has_c, first_cell, 0)]
        eq = where(~active & has_c, bhp - p_first, zero) + where(~active & ~has_c, bhp - bhp.val, zero)
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

    # ------------------------------------------------------------------ tracers
    def _transport_tracers(self, old, dt):
        """Implicit upwind transport of passive tracers with the converged phase fluxes:
        (A^{n+1} c^{n+1} - A^n c^n) / dt + sum_out F c_i - sum_in F c_j + q_prod c_i = q_inj c_inj,
        A being the phase's surface volume in the cell (free phase: pv b S)."""
        from scipy.sparse.linalg import LinearOperator, gmres
        from .amg import GaussSeidel
        m = self.m
        a, b = m.conn_a, m.conn_b
        n = self.n
        key = {"WAT": "w", "OIL": "o", "GAS": "g"}
        cells = self.perf.cell if self.perf is not None else np.zeros(0, int)
        names = self.perf.names if self.perf is not None else []
        by_phase = {}
        for t in self.tracers:
            by_phase.setdefault(key[t["phase"]], []).append(t["name"])
        self.tracer_rates = {}
        for ph, tnames in by_phase.items():
            if ph not in self._flux_last:
                continue
            q = self.last_perf.get(ph, np.zeros(cells.size))           # production positive
            inj_c = {tn: np.array([self.wells[names[w]].tracers.get(tn, 0.0) if self.wells[names[w]].kind == "INJ"
                                   else 0.0 for w in self.perf.well]) for tn in tnames} if cells.size else {}
            active = [tn for tn in tnames if np.any(self.tracer_conc[tn]) or
                      (cells.size and np.any(inj_c[tn] * np.maximum(-q, 0.0) > 0))]
            for tn in tnames:
                self.tracer_rates[tn] = {}
            if not active:
                continue
            f = self._flux_last[ph]
            out_a = f > 0                          # flow a -> b carries c_a
            up = np.where(out_a, a, b)
            dn = np.where(out_a, b, a)
            af = np.abs(f)
            acc_new = np.maximum(self._acc_last[ph], 0.0)
            # free phase only (dissolved / vaporised parts are not carried by the tracer)
            diag = acc_new / dt + np.bincount(up, weights=af, minlength=n)
            qp = np.maximum(q, 0.0)
            if cells.size:
                diag += np.bincount(cells, weights=qp, minlength=n)
            rows = np.concatenate([np.arange(n), dn])
            cols = np.concatenate([np.arange(n), up])
            vals = np.concatenate([diag + 1e-30, -af])
            Amat = sp.csr_matrix((vals, (rows, cols)), shape=(n, n))
            gs = GaussSeidel(Amat)
            M = LinearOperator((n, n), matvec=gs.symmetric)
            acc_old = np.maximum(old[ph], 0.0)
            for tn in active:
                c0 = self.tracer_conc[tn]
                rhs = acc_old * c0 / dt
                if cells.size:
                    rhs = rhs + np.bincount(cells, weights=np.maximum(-q, 0.0) * inj_c[tn], minlength=n)
                try:
                    x, info = gmres(Amat, rhs, x0=c0, M=M, rtol=1e-9, atol=0.0, restart=40, maxiter=50)
                except TypeError:                                     # older SciPy: tol instead of rtol
                    x, info = gmres(Amat, rhs, x0=c0, M=M, tol=1e-9, restart=40, maxiter=50)
                if info != 0:
                    from scipy.sparse.linalg import spsolve
                    x = spsolve(Amat.tocsc(), rhs)
                self.tracer_conc[tn] = np.maximum(x, 0.0)
                if cells.size:
                    prod = np.bincount(self.perf.well, weights=qp * self.tracer_conc[tn][cells],
                                       minlength=len(names))
                    inj = np.bincount(self.perf.well, weights=np.maximum(-q, 0.0) * inj_c[tn], minlength=len(names))
                    self.tracer_rates[tn] = {nm: (float(prod[i]), float(inj[i])) for i, nm in enumerate(names)}

    # ------------------------------------------------------------------ DRSDT / DRVDT / VAPPARS
    def set_options(self, options):
        """Schedule settings in force for the report step."""
        self.drsdt = options.get("DRSDT")
        self.drvdt = options.get("DRVDT")
        self.vappars = options.get("VAPPARS")
        self.wpave = options.get("WPAVE")
        self.wwpave = options.get("WWPAVE")
        self.wpavedep = options.get("WPAVEDEP")
        self.gconinje = options.get("GCONINJE") or {}

    # ------------------------------------------------------------------ history and group targets
    def _first_perf(self):
        first = np.full(self.perf.n_wells, -1)
        if self.perf.cell.size:
            idx = np.arange(self.perf.cell.size)
            first[self.perf.well[::-1]] = idx[::-1]
        return first

    def _history_resv_targets(self):
        """WCONHIST RESV control: the reservoir volume of the observed surface rates, with the
        formation volume factors at the field average pressure (as for the RESV rates)."""
        names = [n for n in self.perf.names if self.wells[n].history and self.wells[n].kind == "PROD"
                 and self.orig_controls.get(n) == "RESV"]
        if not names:
            return
        first = self._first_perf()
        Bf = self._resv_factors(self.perf.cell)
        for n in names:
            wi = self.perf.names.index(n)
            k = first[wi]
            if k < 0:
                continue
            t = self.wells[n].targets
            o, w_, g = t.get("ORAT", 0.0) or 0.0, t.get("WRAT", 0.0) or 0.0, t.get("GRAT", 0.0) or 0.0
            rs, rv = Bf["rs"][k], Bf["rv"][k]
            den = 1.0 - rs * rv
            # as ECLIPSE: the free-phase split may go negative (observed GOR below the saturated Rs)
            resv = (o - rv * g) * Bf["bo"][k] / den
            if self.has_g:
                resv += (g - rs * o) * Bf["bg"][k] / den
            if self.has_w:
                resv += w_ * Bf["bw"][k]
            t["RESV"] = max(resv, 0.0)

    def _subtree(self, group):
        """Wells belonging to `group` or any group below it."""
        parents = getattr(self, "groups", {}) or {}

        def under(g):
            seen = 0
            while g is not None and seen < 100:
                if g == group:
                    return True
                g = parents.get(g, "FIELD" if g != "FIELD" else None)
                seen += 1
            return False
        return [n for n in self.perf.names if under(self.wells[n].group) or group == "FIELD"]

    def _group_injection(self):
        """GCONINJE limits: when the wells' targets exceed the group limit, the targets of the
        group's injectors of that phase are scaled down to it (wells under 'GRUP' control share
        what the individually controlled wells leave)."""
        if not getattr(self, "gconinje", None):
            return
        orig = self.__dict__.setdefault("_inj_targets", {})
        rep = self.well_report() if self.last_rates else {}
        for (group, phase), c in self.gconinje.items():
            mode = c.get("mode", "NONE")
            if mode in ("NONE", "FLD"):
                continue
            wells = [n for n in self._subtree(group) if self.wells[n].kind == "INJ" and self.wells[n].inj_type == phase
                     and self.wells[n].is_open and self.orig_controls.get(n) in ("RATE", "RESV")]
            if not wells:
                continue
            key = {"WATER": "water", "GAS": "gas", "OIL": "oil"}[phase]
            limit = None
            if mode == "RATE" and c.get("RATE") is not None:
                limit = c["RATE"]
            elif mode == "RESV" and c.get("RESV") is not None:
                Bf = self._resv_factors(self.perf.cell)
                b = Bf["bw" if phase == "WATER" else ("bg" if phase == "GAS" else "bo")]
                first = self._first_perf()
                k = first[self.perf.names.index(wells[0])]
                limit = c["RESV"] / max(b[k], 1e-12)
            elif mode in ("REIN", "VREP") and rep:
                members = self._subtree(group)
                prod = [n for n in members if self.wells[n].kind == "PROD"]
                if mode == "REIN":
                    limit = (c.get("REIN") or 0.0) * sum(max(rep[n][key], 0.0) for n in prod if n in rep)
                else:
                    first = self._first_perf()
                    Bf = self._resv_factors(self.perf.cell)
                    void = sum(max(rep[n].get("resv", 0.0), 0.0) for n in prod if n in rep)
                    k = first[self.perf.names.index(wells[0])]
                    b = Bf["bw" if phase == "WATER" else ("bg" if phase == "GAS" else "bo")][k]
                    limit = (c.get("VREP") or 0.0) * void / max(b, 1e-12)
            if limit is None:
                continue
            for n in wells:
                orig.setdefault((id(self.wells[n]), n), self.wells[n].targets.get("RATE", 0.0))
            ind = [n for n in wells if not self.wells[n].group_control]
            grp = [n for n in wells if self.wells[n].group_control]
            tot = sum(orig[(id(self.wells[n]), n)] or 0.0 for n in ind)
            fac = min(1.0, limit / tot) if tot > 0 else 1.0
            for n in ind:
                self.wells[n].targets["RATE"] = (orig[(id(self.wells[n]), n)] or 0.0) * fac
            if grp:
                share = max(limit - tot * fac, 0.0) / len(grp)
                for n in grp:
                    self.wells[n].targets["RATE"] = share
                self._log_once(f"GCONINJE {group}: wells under group control share its target equally")

    def well_tests(self, t_now, wells):
        """WTEST: re-open wells closed by economic limits (reason E) once the interval has passed.
        `wells` is the coming report step's well set (with its WTEST settings)."""
        reopened = []
        times = self.__dict__.setdefault("_econ_time", {})
        counts = self.__dict__.setdefault("_test_count", {})
        for name in list(self.econ_shut):
            times.setdefault(name, t_now)
            w = wells.get(name)
            test = getattr(w, "test", None) if w is not None else None
            if not test or "E" not in test.get("reasons", ""):
                continue
            if test.get("tests") and counts.get(name, 0) >= test["tests"]:
                continue
            if t_now - times[name] >= test["interval"] - 1.0:
                del self.econ_shut[name]
                times.pop(name, None)
                self.econ_conns = {c for c in self.econ_conns if c[0] != name}
                counts[name] = counts.get(name, 0) + 1
                reopened.append(name)
        return reopened

    def _set_caps(self, st0, dt):
        self.rs_cap = self.rv_cap = None
        if self.drsdt is not None and self.disgas:
            rate, mode = self.drsdt
            cap = st0["rs"] + rate * dt
            self.rs_cap = np.where(st0["sg"] > 0, cap, np.inf) if mode == "FREE" else cap
        if self.drvdt is not None and self.vapoil:
            self.rv_cap = st0["rv"] + self.drvdt * dt

    def _limit_ratio(self, v, d, so, which):
        """Saturated Rs or Rv reduced by VAPPARS (So / So_max) ** VAP and capped by DRSDT / DRVDT.
        Returns value, d/dp and d/dSo."""
        dso = np.zeros_like(v)
        if self.vappars is not None and self.so_max is not None:
            a = self.vappars[0] if which == "rv" else self.vappars[1]
            if a > 0:
                som = self.so_max
                has = som > 1e-9
                r = np.clip(np.asarray(so, float) / np.where(has, som, 1.0), 0.0, 1.0)
                f = np.where(has, r ** a, 1.0)
                inner = has & (r > 1e-9) & (r < 1.0)
                df = np.where(inner, a * np.where(inner, r, 1.0) ** (a - 1.0) / np.where(has, som, 1.0), 0.0)
                dso = v * df
                v, d = v * f, d * f
        cap = self.rs_cap if which == "rs" else self.rv_cap
        if cap is not None:
            c = v > cap
            v = np.where(c, cap, v)
            d = np.where(c, 0.0, d)
            dso = np.where(c, 0.0, dso)
        return v, d, dso

    # ------------------------------------------------------------------ THPRES
    def _setup_thpres(self):
        """Threshold pressures between equilibration regions (THPRES): no flow across a region
        boundary until the potential difference exceeds the threshold, which is then subtracted."""
        self.thp_conn = None
        self.thp_pairs = []
        pairs = getattr(self.m, "thpres", None) or []
        if not pairs:
            return
        reg = self.m.eqlnum
        ra, rb = reg[self.m.conn_a], reg[self.m.conn_b]
        cross = np.nonzero(ra != rb)[0]
        irrev = getattr(self.m, "thpres_irrevers", False)
        self.thp_ab = np.zeros(self.m.conn_a.size)      # threshold for flow a -> b
        self.thp_ba = np.zeros(self.m.conn_a.size)
        for i, j, val in pairs:
            ab = cross[(ra[cross] == i) & (rb[cross] == j)]
            ba = cross[(ra[cross] == j) & (rb[cross] == i)]
            self.thp_pairs.append((i, j, val, ab, ba))
            v = 0.0 if val is None else val
            self.thp_ab[ab] = v                         # flow from region i to region j
            self.thp_ba[ba] = v
            if not irrev:
                self.thp_ab[ba] = v
                self.thp_ba[ab] = v
        self.thp_conn = (self.thp_ab > 0) | (self.thp_ba > 0)       # connections with a threshold

    def _default_thpres(self, st):
        """Defaulted thresholds: the largest initial potential difference across the boundary."""
        if all(v is not None for _, _, v, _, _ in self.thp_pairs):
            return
        pr = self.props(st["p"], st["sw"], self._x_of(st), st.get("T"), st["state"])
        m, a, b = self.m, self.m.conn_a, self.m.conn_b
        v = A.value
        dmax = np.zeros(a.size)
        for ph, rk in (("o", "rho_o"), ("w", "rho_w"), ("g", "rho_g")):
            if rk not in pr or (ph == "w" and not self.has_w) or (ph == "g" and not self.has_g):
                continue
            pp = st["p"] if ph == "o" else (st["p"] - v(pr["pcow"]) if ph == "w" else st["p"] + v(pr["pcgo"]))
            rho = v(pr[rk])
            dmax = np.maximum(dmax, np.abs(pp[b] - pp[a] - (rho[a] + rho[b]) * 0.5 * m.gravity * self.dz))
        irrev = getattr(m, "thpres_irrevers", False)
        for i, j, val, ab, ba in self.thp_pairs:
            if val is not None:
                continue
            t = float(max(dmax[ab].max() if ab.size else 0.0, dmax[ba].max() if ba.size else 0.0))
            self.thp_ab[ab] = t
            self.thp_ba[ba] = t
            if not irrev:
                self.thp_ab[ba] = t
                self.thp_ba[ab] = t

    def _threshold(self, dpot):
        """Potential difference reduced by the threshold pressure (flow a -> b when dpot < 0)."""
        dv = dpot.val if isinstance(dpot, AD) else dpot
        t_ab, t_ba = self.thp_ab, self.thp_ba
        neg = dv < -t_ab
        pos = dv > t_ba
        shift = np.where(neg, t_ab, np.where(pos, -t_ba, 0.0))
        keep = np.where(self.thp_conn, neg | pos, True).astype(float)
        return (dpot + shift) * keep

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
            if self.thp_conn is not None:
                dpot = self._threshold(dpot)
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
        if self.tracers:
            self._flux_last = {ph: A.value(f).copy() for ph, (f, _) in flux.items()}
            self._acc_last = {k: A.value(v).copy() for k, v in acc.items()}
        if getattr(m, "summary_region_flows", None):
            self._comp_flux_last = {k: A.value(v).copy() for k, v in comp.items() if k in ("o", "w", "g")}
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
        if self.perf is not None and self.perf.n_wells:
            self._history_resv_targets()
            self._group_injection()
        self._set_caps(st0, dt)
        lin0 = LINEAR_STATS["iterations"]
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
            if getattr(self.opt, "debug_newton", False):
                worst = {}
                for ph, bk in (("o", "bo"), ("w", "bw"), ("g", "bg")):
                    if ph in eqs:
                        r_ = np.abs(eqs[ph].val) * dt / (pvv * np.maximum(A.value(pr[bk]), 1e-12))
                        worst[ph] = (float(r_.max()), int(np.argmax(r_)))
                wworst = ""
                if nw:
                    wv = np.abs(weq.val) / scale
                    wworst = f" well {self.perf.names[int(np.argmax(wv))]} {wv.max():.2e}"
                self.log(f"    it {it}: cnv {cnv:.2e} mb {mb:.2e} wres {wres:.2e} {worst}{wworst} "
                         f"ctrl {dict((n, c) for n, c in self.controls.items() if c != self.orig_controls.get(n))}")
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
        self.linear_iterations = LINEAR_STATS["iterations"] - lin0
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
        if self.hyst is not None:
            self.hyst = self.m.satfunc.update_hysteresis(self.hyst, st["sw"], st["sg"])
        self.so_max = np.maximum(self.so_max, 1.0 - st["sw"] - st["sg"])
        self.last_rates = {k_: v.val.copy() for k_, v in rate.items()}
        self.last_perf = {k_: A.value(v).copy() for k_, v in self._q_last.items()}
        self._rho_w = self._rho_step
        self.last_rates["bhp"] = np.array([self.bhp[n] for n in self.perf.names])
        if self.tracers:
            self._transport_tracers(old, dt)
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
        if ctrl == "BHP" or not self._flowing(name):
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
                so_new = 1.0 - st["sw"] - np.maximum(sg_new, 0.0)
                rs_true = self.rs_sat(st["p"])[0]
                # saturated value limited by DRSDT / VAPPARS; free gas appears only when the
                # thermodynamic saturation is exceeded (by a small band, against flip-flopping)
                rsat = self._limit_ratio(rs_true, np.zeros(n), so_new, "rs")[0]
                rs_new = np.where(nog, st["rs"] + dX, rsat)
                to_us = sat & (sg_new < 0.0) & (so_new > 1e-6)          # gas disappears
                to_s = nog & (rs_new > rs_true * (1.0 + SWITCH_BAND))    # bubble point reached
                new_state[to_us] = 1
                new_state[to_s] = 0
                rs_new = np.where(to_us, rsat * (1 - 1e-6), np.where(to_s, rsat, rs_new))
                sg_new = np.where(to_us | (nog & ~to_s), 0.0, sg_new)
                rs_new = np.where(new_state == 0, rsat, rs_new)
            if self.vapoil:
                so_new = 1.0 - st["sw"] - sg_new
                rv_true = self.rv_sat(st["p"])[0]
                rvsat = self._limit_ratio(rv_true, np.zeros(n), np.maximum(so_new, 0.0), "rv")[0]
                rv_new = np.where(noo, st["rv"] + dX, rvsat)
                to_ug = (state == 0) & (so_new < 0.0) & (sg_new > 1e-6)  # oil disappears
                to_s2 = noo & (rv_new > rv_true * (1.0 + SWITCH_BAND))   # dew point reached
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
            if self.controls.get(name) != "BHP" and self._flowing(name) and sel.any():
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
        """(WBP, WBP4, WBP5, WBP9) of well wi (Pa), following WPAVE / WWPAVE / WPAVEDEP.

        Each connection contributes its block (inner value) and its 4 or 8 horizontal neighbours
        (outer ring); block pressures are referred to the well's datum with the wellbore density
        (WPAVE 'WELL', no correction for a shut well), the reservoir density ('RES') or not at
        all ('NONE').  Inner and outer averages are F2 * connection-factor weighted +
        (1 - F2) * pore-volume weighted; WBP5 and WBP9 are F1 * inner + (1 - F1) * outer.
        Only open connections are used unless the option is 'ALL'."""
        p = self.state["p"]
        name = self.perf.names[wi]
        opt = dict(getattr(self, "wpave", None) or {})
        opt.update((getattr(self, "wwpave", None) or {}).get(name, {}))
        F1, F2 = opt.get("F1", 0.5), opt.get("F2", 1.0)
        F1 = 0.5 if F1 is None or F1 < 0 else F1
        sel = np.nonzero(self.perf.well == wi)[0]
        ctf_all = self.perf.ctf if self.perf.ctf is not None else self.perf.wi
        if opt.get("conns", "OPEN") != "ALL":
            sel = sel[self.perf.wi[sel] > 0] if np.any(self.perf.wi[sel] > 0) else sel
        if sel.size == 0:
            return (0.0,) * 4
        w = self.wells[name]
        zref = (getattr(self, "wpavedep", None) or {}).get(name) or self.perf.ref_depth[wi]
        z = self.m.depth
        mode = opt.get("depth", "WELL")
        if mode == "NONE":
            cp = lambda cells: p[cells]
        elif mode == "RES":
            pr = getattr(self, "_last_pr_vals", None)
            if pr is None:
                cp = lambda cells: p[cells]
            else:
                cp = lambda cells: p[cells] - pr[cells] * self.m.gravity * (z[cells] - zref)
        else:
            rho = self._rho_w[wi] if (self._rho_w is not None and w.is_open) else 0.0
            cp = lambda cells: p[cells] - rho * self.m.gravity * (z[cells] - zref)
        ctf = ctf_all[sel]
        if ctf.sum() <= 0:
            ctf = np.ones(sel.size)
        pv = self.m.pore_volume

        def ring_avg(cells_per_conn):
            """F2-weighted average over (connection, cell) pairs."""
            num_c = den_c = num_v = den_v = 0.0
            for n, cells in enumerate(cells_per_conn):
                if cells.size == 0:
                    continue
                pc_ = cp(cells)
                num_c += ctf[n] * pc_.sum()
                den_c += ctf[n] * cells.size
                num_v += float(np.sum(pv[cells] * pc_))
                den_v += float(np.sum(pv[cells]))
            if den_c <= 0:
                return None
            a_c = num_c / den_c
            a_v = num_v / den_v if den_v > 0 else a_c
            return F2 * a_c + (1.0 - F2) * a_v

        inner = ring_avg([self.perf.cell[[m]] for m in sel])
        o4 = ring_avg([self._nb4[m] for m in sel])
        o8 = ring_avg([self._nb8[m] for m in sel])
        o4 = inner if o4 is None else o4
        o8 = inner if o8 is None else o8
        return inner, o4, F1 * inner + (1.0 - F1) * o4, F1 * inner + (1.0 - F1) * o8

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
            self.__dict__.setdefault("_econ_time", {})[name] = getattr(self, "t_now", 0.0)
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
        self._report_state = (acc, pr)
        return out

    # ------------------------------------------------------------------ region, connection, potential reports
    def region_state(self, regnum, nreg):
        """Per-region quantities (FIPNUM): pressure, fluids in place and well flows.
        Returns {mnemonic: (array over regions, quantity)}."""
        st = self.state
        acc, pr = getattr(self, "_report_state", None) or self.accumulation_values(st)
        v = A.value
        pvv = v(pr["pv"])
        pv0 = self.m.pore_volume
        hc = pv0 * (1.0 - st["sw"])
        bc = lambda w: np.bincount(regnum, weights=w, minlength=nreg)[:nreg]
        hsum, psum = bc(hc), bc(pv0)
        rpr = np.where(hsum > 0, bc(st["p"] * hc) / np.where(hsum > 0, hsum, 1.0),
                       bc(st["p"] * pv0) / np.where(psum > 0, psum, 1.0))
        oil_l = pvv * v(pr["bo"]) * v(pr["so"])
        out = {"RPR": (rpr, "pressure"), "ROIP": (bc(acc["o"]), "liquid_surface_volume"),
               "ROIPL": (bc(oil_l), "liquid_surface_volume"),
               "ROIPG": (bc(acc["o"] - oil_l), "liquid_surface_volume")}
        if self.has_w:
            out["RWIP"] = (bc(acc["w"]), "liquid_surface_volume")
        if self.has_g:
            gas_f = pvv * v(pr["bg"]) * v(pr["sg"])
            out["RGIP"] = (bc(acc["g"]), "gas_surface_volume")
            out["RGIPG"] = (bc(gas_f), "gas_surface_volume")
            out["RGIPL"] = (bc(acc["g"] - gas_f), "gas_surface_volume")
        # oil-phase pressure weighted by the oil pore volume (ROP)
        osum = bc(pv0 * v(pr["so"]))
        out["ROP"] = (np.where(osum > 0, bc(st["p"] * pv0 * v(pr["so"])) / np.where(osum > 0, osum, 1.0), rpr),
                      "pressure")
        # well connection flows in each region (production / injection); zero before the first step
        have = self.perf is not None and self.perf.cell.size and self.last_perf
        rc = regnum[self.perf.cell] if have else None
        for ph, q_, on in (("O", "liquid_surface_rate", True), ("W", "liquid_surface_rate", self.has_w),
                           ("G", "gas_surface_rate", self.has_g)):
            if not on:
                continue
            qq = self.last_perf.get(ph.lower()) if have else None
            if qq is None or qq.size != rc.size:
                out[f"R{ph}PR"] = out[f"R{ph}IR"] = (np.zeros(nreg), q_)
                continue
            out[f"R{ph}PR"] = (np.bincount(rc, weights=np.maximum(qq, 0.0), minlength=nreg)[:nreg], q_)
            out[f"R{ph}IR"] = (np.bincount(rc, weights=np.maximum(-qq, 0.0), minlength=nreg)[:nreg], q_)
        return out

    def region_flows(self, pairs):
        """Component flow rates (surface volumes, a -> b positive) from FIPNUM region r1 to r2 over
        the last converged step: {(component, r1, r2): rate}."""
        out = {}
        fl = getattr(self, "_comp_flux_last", None)
        fip = getattr(self.m, "fipnum", None)
        if fl is None or fip is None:
            return out
        ra, rb = fip[self.m.conn_a], fip[self.m.conn_b]
        for comp, f in fl.items():
            for r1, r2 in pairs:
                out[(comp, r1, r2)] = float(np.sum(f[(ra == r1) & (rb == r2)]) - np.sum(f[(ra == r2) & (rb == r1)]))
        return out

    def connection_rates(self):
        """Per-connection surface flows of the last step: {(well, i, j, k): {'o','w','g'}} (production
        positive)."""
        out = {}
        if self.perf is None or not self.last_perf:
            return out
        ac = self.m.active_cells
        for m_, (w, cell) in enumerate(zip(self.perf.well, self.perf.cell)):
            i, j, k = (int(x) + 1 for x in self.m.grid.ijk(ac[cell]))
            out[(self.perf.names[w], i, j, k)] = {ph: float(q[m_]) for ph, q in self.last_perf.items()
                                                   if ph in ("o", "w", "g")}
        return out

    def well_potentials(self):
        """Production potentials (WOPP, WWPP, WGPP), injection potentials (WWIP, WGIP) and the
        productivity index of the preferred phase (WPI), from the current state: connection
        inflow at the well's BHP limit with the current wellbore head."""
        out = {}
        if self.perf is None or self.perf.cell.size == 0:
            return out
        acc, pr = getattr(self, "_report_state", None) or self.accumulation_values(self.state)
        v = A.value
        c = self.perf.cell
        p = self.state["p"]
        head = getattr(self, "_head", np.zeros(c.size))
        if head.size != c.size:
            head = np.zeros(c.size)
        lam = {"o": v(pr["kro"])[c] / v(pr["muo"])[c] * v(pr["bo"])[c]}
        if self.has_w:
            lam["w"] = v(pr["krw"])[c] / v(pr["muw"])[c] * v(pr["bw"])[c]
        if self.has_g:
            lam["g"] = v(pr["krg"])[c] / v(pr["mug"])[c] * v(pr["bg"])[c]
        lt = v(pr["kro"])[c] / v(pr["muo"])[c] + (v(pr["krw"])[c] / v(pr["muw"])[c] if self.has_w else 0.0) + \
            (v(pr["krg"])[c] / v(pr["mug"])[c] if self.has_g else 0.0)
        rs = v(pr["rs"])[c] if self.disgas else 0.0
        rv = v(pr["rv"])[c] if self.vapoil else 0.0
        wi_all = self.perf.wi
        nw = self.perf.n_wells
        for wi_, name in enumerate(self.perf.names):
            w = self.wells[name]
            sel = self.perf.well == wi_
            if not sel.any():
                continue
            WI = wi_all[sel]
            if w.kind == "PROD":
                lim = w.targets.get("BHP", 1e5) or 1e5
                dd = np.maximum(p[c][sel] - head[sel] - lim, 0.0)
                qo = np.sum(WI * lam["o"][sel] * dd)
                qw = np.sum(WI * lam["w"][sel] * dd) if self.has_w else 0.0
                qg = np.sum(WI * lam["g"][sel] * dd) if self.has_g else 0.0
                oil = qo + (np.sum(WI * lam["g"][sel] * dd * (rv[sel] if np.ndim(rv) else rv)) if self.has_g else 0.0)
                gas = qg + np.sum(WI * lam["o"][sel] * dd * (rs[sel] if np.ndim(rs) else rs))
                d = {"WOPP": (oil, "liquid_surface_rate"), "WWPP": (qw, "liquid_surface_rate"),
                     "WGPP": (gas, "gas_surface_rate"), "WWIP": (0.0, "liquid_surface_rate"),
                     "WGIP": (0.0, "gas_surface_rate")}
                pref = w.phase if w.phase in ("OIL", "WATER", "GAS") else "OIL"
                if w.phase == "LIQ":
                    pi = np.sum(WI * (lam["o"][sel] + (lam["w"][sel] if self.has_w else 0.0)))
                else:
                    pi = np.sum(WI * lam[{"OIL": "o", "WATER": "w", "GAS": "g"}[pref]][sel]) \
                        if {"OIL": "o", "WATER": "w", "GAS": "g"}[pref] in lam else 0.0
                d["WPI"] = (pi if w.is_open else 0.0,
                            "gas_productivity_index" if pref == "GAS" else "productivity_index")
            else:
                lim = w.targets.get("BHP", 1e30) or 1e30
                dd = np.maximum(lim + head[sel] - p[c][sel], 0.0) if lim < 1e29 else np.zeros(sel.sum())
                key = {"WATER": "bw", "GAS": "bg", "OIL": "bo"}.get(w.inj_type, "bw")
                q = np.sum(WI * lt[sel] * v(pr[key])[c][sel] * dd) if key in pr else 0.0
                d = {"WOPP": (0.0, "liquid_surface_rate"), "WWPP": (0.0, "liquid_surface_rate"),
                     "WGPP": (0.0, "gas_surface_rate"),
                     "WWIP": (q if w.inj_type == "WATER" else 0.0, "liquid_surface_rate"),
                     "WGIP": (q if w.inj_type == "GAS" else 0.0, "gas_surface_rate")}
                key_l = {"WATER": "w", "GAS": "g", "OIL": "o"}.get(w.inj_type, "w")
                d["WPI"] = (np.sum(WI * lt[sel] * v(pr[key])[c][sel]) if (w.is_open and key in pr) else 0.0,
                            "gas_productivity_index" if key_l == "g" else "productivity_index")
            if not w.is_open:
                for k_ in ("WOPP", "WWPP", "WGPP", "WWIP", "WGIP"):
                    d[k_] = (0.0, d[k_][1])
            out[name] = d
        del nw
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
