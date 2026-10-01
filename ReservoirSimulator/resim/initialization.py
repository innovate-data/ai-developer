"""Initial conditions: hydrostatic equilibration (EQUIL) or enumeration
(PRESSURE/SWAT/SGAS/RS) for black-oil and compositional models."""
from __future__ import annotations

import numpy as np

from .props.tables import interp_val


def _integrate(z0, p0, zs, rho_fn, g):
    """Integrate dp/dz = rho(p, z) g from (z0, p0) over sorted depths zs."""
    p = np.empty_like(zs)
    i0 = np.searchsorted(zs, z0)
    # downward
    zc, pc = z0, p0
    for i in range(i0, zs.size):
        dz = zs[i] - zc
        for _ in range(max(1, int(abs(dz) / 2.0) + 1)):
            h = dz / max(1, int(abs(dz) / 2.0) + 1)
            k1 = rho_fn(pc, zc) * g
            k2 = rho_fn(pc + h * k1, zc + h) * g
            pc += 0.5 * h * (k1 + k2)
            zc += h
        p[i] = pc
    zc, pc = z0, p0
    for i in range(i0 - 1, -1, -1):
        dz = zs[i] - zc
        nsub = max(1, int(abs(dz) / 2.0) + 1)
        h = dz / nsub
        for _ in range(nsub):
            k1 = rho_fn(pc, zc) * g
            k2 = rho_fn(pc + h * k1, zc + h) * g
            pc += 0.5 * h * (k1 + k2)
            zc += h
        p[i] = pc
    return p


def _invert_pc(table_s, table_pc, pc, below_contact, s_hi, s_lo, increasing):
    """Saturation from capillary pressure; sharp contact if the table is flat."""
    if np.ptp(table_pc) < 1e-6:
        return np.where(below_contact, s_hi, s_lo)
    if increasing:      # pc grows with saturation (gas)
        return np.clip(np.interp(pc, table_pc, table_s), table_s[0], table_s[-1])
    return np.clip(np.interp(pc, table_pc[::-1], table_s[::-1]), table_s[0], table_s[-1])


def initialize_blackoil(model):
    na = model.n_active
    ph = model.phases
    p = np.zeros(na)
    sw = np.zeros(na)
    sg = np.zeros(na)
    rs = np.zeros(na)
    ex = model.explicit_init
    if model.equil:
        g = model.gravity
        for r, eq in enumerate(model.equil):
            cells = np.nonzero(model.eqlnum == r)[0] if len(model.equil) > 1 else np.arange(na)
            if cells.size == 0:
                continue
            pvt = model.pvt[int(np.bincount(model.pvtnum[cells]).argmax())]
            depth = model.depth[cells]
            woc = eq["woc"] if eq["woc"] is not None and ph["water"] else depth.max() + 1e4
            goc = eq["goc"] if eq["goc"] is not None and ph["gas"] else depth.min() - 1e4
            zmin = min(depth.min(), eq["datum"], woc, goc) - 1.0
            zmax = max(depth.max(), eq["datum"], woc, goc) + 1.0
            zs = np.unique(np.concatenate([np.linspace(zmin, zmax, 400), [eq["datum"], woc, goc]]))

            rsvd = model.rsvd[min(r, len(model.rsvd) - 1)] if model.rsvd else None
            pbvd = model.pbvd[min(r, len(model.pbvd) - 1)] if model.pbvd else None
            rs_cap = [np.inf]

            def rs_at(pp, zz):
                if not ph["disgas"]:
                    return 0.0
                rsat = float(pvt.oil.rs_sat(np.array([pp]))[0][0])
                if rsvd is not None:
                    return min(float(np.interp(zz, rsvd[:, 0], rsvd[:, 1])), rsat)
                if pbvd is not None:
                    pb = float(np.interp(zz, pbvd[:, 0], pbvd[:, 1]))
                    return min(float(pvt.oil.rs_sat(np.array([pb]))[0][0]), rsat)
                return min(rsat, rs_cap[0])

            def rho_o(pp, zz):
                r_ = rs_at(pp, zz)
                b = pvt.oil.eval(np.array([pp]), np.array([r_]))[0][0]
                return (pvt.rho_os + r_ * pvt.rho_gs) * b

            def rho_w(pp, zz):
                return pvt.rho_ws * pvt.water.eval(np.array([pp]))[0][0]

            def rho_g(pp, zz):
                return pvt.rho_gs * pvt.gas.eval(np.array([pp]))[0][0] if pvt.gas else 1.0

            # datum phase
            datum, p0 = eq["datum"], eq["p_datum"]
            for _ in range(2):
                if datum < goc and ph["gas"]:
                    pg_ = _integrate(datum, p0, zs, rho_g, g)
                    po_goc = np.interp(goc, zs, pg_) - eq["pcgo_goc"]
                    po = _integrate(goc, po_goc, zs, rho_o, g)
                elif datum > woc and ph["water"]:
                    pw_ = _integrate(datum, p0, zs, rho_w, g)
                    po_woc = np.interp(woc, zs, pw_) + eq["pcow_woc"]
                    po = _integrate(woc, po_woc, zs, rho_o, g)
                else:
                    po = _integrate(datum, p0, zs, rho_o, g)
                if rsvd is None and pbvd is None and ph["disgas"]:
                    # oil saturated at the gas-oil contact
                    rs_cap[0] = float(pvt.oil.rs_sat(np.array([np.interp(goc, zs, po)]))[0][0])
                else:
                    break
            pw = _integrate(woc, np.interp(woc, zs, po) - eq["pcow_woc"], zs, rho_w, g) if ph["water"] else po
            pgz = _integrate(goc, np.interp(goc, zs, po) + eq["pcgo_goc"], zs, rho_g, g) if ph["gas"] else po

            po_c = np.interp(depth, zs, po)
            pw_c = np.interp(depth, zs, pw)
            pg_c = np.interp(depth, zs, pgz)
            for c_local, cell in enumerate(cells):
                st = model.sat[model.satnum[cell]]
                s_w = s_g = 0.0
                if ph["water"]:
                    s_w = float(_invert_pc(st.swof[:, 0], st.swof[:, 3], po_c[c_local] - pw_c[c_local],
                                           depth[c_local] > woc, 1.0, st.swof[0, 0], False))
                if ph["gas"]:
                    s_g = float(_invert_pc(st.sgof[:, 0], st.sgof[:, 3], pg_c[c_local] - po_c[c_local],
                                           depth[c_local] < goc, st.sgof[-1, 0], 0.0, True))
                    s_g = min(s_g, 1.0 - s_w)
                pcell = po_c[c_local]
                if ph["water"] and depth[c_local] > woc and np.ptp(st.swof[:, 3]) < 1e-6:
                    pcell = pw_c[c_local]
                elif ph["gas"] and depth[c_local] < goc and np.ptp(st.sgof[:, 3]) < 1e-6:
                    pcell = pg_c[c_local]
                p[cell], sw[cell], sg[cell] = pcell, s_w, s_g
            if ph["disgas"]:
                rsat = pvt.oil.rs_sat(p[cells])[0]
                rs[cells] = np.array([rs_at(pp, zz) for pp, zz in zip(p[cells], depth)])
                rs[cells] = np.where(sg[cells] > 0, rsat, np.minimum(rs[cells], rsat))
    if "PRESSURE" in ex:
        p = ex["PRESSURE"].copy()
    if "SWAT" in ex:
        sw = ex["SWAT"].copy()
    if "SGAS" in ex:
        sg = ex["SGAS"].copy()
    if ph["disgas"]:
        if "RS" in ex:
            rs = ex["RS"].copy()
        elif "PBUB" in ex:
            rs = np.zeros(na)
            for r, pvt in enumerate(model.pvt):
                m = model.pvtnum == r
                rs[m] = pvt.oil.rs_sat(ex["PBUB"][m])[0]
        elif not model.equil:
            rs = np.zeros(na)
            for r, pvt in enumerate(model.pvt):
                m = model.pvtnum == r
                rs[m] = pvt.oil.rs_sat(p[m])[0]
    if not ph["water"]:
        sw[:] = 0.0
    if not ph["gas"]:
        sg[:] = 0.0
    return {"p": p, "sw": sw, "sg": sg, "rs": rs}


def initialize_compositional(model):
    """Hydrostatic pressure with EOS densities; composition from ZMFVD or ZI."""
    eos = model.eos
    na = model.n_active
    T = model.temperature
    depth = model.depth

    def comp_at(zz):
        if model.zmfvd:
            t = model.zmfvd[0]
            zc = np.array([np.interp(zz, t[:, 0], t[:, 1 + i]) for i in range(eos.nc)])
        elif model.zi is not None:
            zc = model.zi.copy()
        else:
            raise ValueError("Compositional model needs ZI or ZMFVD for the initial composition")
        return zc / zc.sum()

    ex = model.explicit_init
    if model.equil:
        eq = model.equil[0]
        woc = eq["woc"] if eq["woc"] is not None and model.phases["water"] else depth.max() + 1e4
        zs = np.unique(np.concatenate([np.linspace(min(depth.min(), eq["datum"], woc) - 1,
                                                   max(depth.max(), eq["datum"], woc) + 1, 200),
                                       [eq["datum"], woc]]))

        def rho_hc(pp, zz):
            zc = comp_at(zz)[None, :]
            fr = eos.flash(zc, np.array([pp]), T)
            if fr.two_phase[0]:
                return float(eos.mass_density(fr.x, fr.Zl, np.array([pp]), T)[0])
            return float(eos.mass_density(zc, fr.Zl, np.array([pp]), T)[0])

        wat = model.water_pvt

        def rho_w(pp, zz):
            return model.rho_ws * wat.eval(np.array([pp]))[0][0]

        g = model.gravity
        if eq["datum"] > woc:
            pw_ = _integrate(eq["datum"], eq["p_datum"], zs, rho_w, g)
            po = _integrate(woc, np.interp(woc, zs, pw_) + eq["pcow_woc"], zs, rho_hc, g)
        else:
            po = _integrate(eq["datum"], eq["p_datum"], zs, rho_hc, g)
        pw = _integrate(woc, np.interp(woc, zs, po) - eq["pcow_woc"], zs, rho_w, g)
        p = np.interp(depth, zs, po)
        sw = np.zeros(na)
        if model.phases["water"]:
            for c in range(na):
                st = model.sat[model.satnum[c]]
                sw[c] = _invert_pc(st.swof[:, 0], st.swof[:, 3], p[c] - np.interp(depth[c], zs, pw),
                                   depth[c] > woc, 1.0, st.swof[0, 0], False)
                if depth[c] > woc and np.ptp(st.swof[:, 3]) < 1e-6:
                    p[c] = np.interp(depth[c], zs, pw)
    else:
        p = ex["PRESSURE"].copy()
        sw = ex.get("SWAT", np.zeros(na)).copy()
    if "PRESSURE" in ex:
        p = ex["PRESSURE"].copy()
    if "SWAT" in ex:
        sw = ex["SWAT"].copy()
    z = np.array([comp_at(d) for d in depth])
    return {"p": p, "sw": sw, "z": z}
