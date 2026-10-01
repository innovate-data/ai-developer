"""Simulation driver: loads a deck, initialises, marches through the
SCHEDULE report steps with adaptive time stepping and collects results."""
from __future__ import annotations

import time
from dataclasses import dataclass
from datetime import timedelta

import numpy as np

from .deck.parser import Deck
from .initialization import initialize_blackoil, initialize_compositional
from .model import SimulationModel, load_model
from .results import Results

DAY = 86400.0


@dataclass
class SimOptions:
    max_dt_days: float = 30.0
    min_dt_days: float = 1e-4
    initial_dt_days: float = 1.0
    newton_tol: float = 1e-3        # CNV tolerance (saturation units)
    max_newton: int = 15
    linear_solver: str = "direct"   # "direct" or "iterative"
    ds_max: float = 0.2             # max saturation change per Newton iteration
    ds_target: float = 0.2          # target saturation change per time step
    dp_target_bar: float = 50.0     # target pressure change per time step
    # compositional (IMPEC) controls
    max_dz_comp: float = 0.05       # max overall mole fraction change per step
    max_cfl: float = 0.8


class SimulationAborted(Exception):
    pass


class SimulationError(Exception):
    pass


def _noop(*_a, **_k):
    return None


def run_simulation(deck_or_path, options: SimOptions | None = None, progress=None, log=None,
                   should_stop=None) -> Results:
    """Run an ECLIPSE deck (path or parsed `Deck` or built `SimulationModel`)."""
    opt = options or SimOptions()
    progress = progress or _noop
    log = log or _noop
    should_stop = should_stop or (lambda: False)
    t_wall = time.time()
    messages = []

    def logm(msg):
        messages.append(msg)
        log(msg)

    if isinstance(deck_or_path, SimulationModel):
        model = deck_or_path
    else:
        if isinstance(deck_or_path, Deck):
            logm(f"Building model from deck {deck_or_path.case_name}")
        else:
            logm(f"Reading deck {deck_or_path}")
        model = load_model(deck_or_path)
    u = model.units
    logm(f"Case {model.case_name}: {model.grid.nx}x{model.grid.ny}x{model.grid.nz} grid, "
         f"{model.n_active} active cells, {model.conn_a.size} connections, {u.name} units, "
         f"{model.fluid_type} fluid")
    for w in model.warnings:
        logm("WARNING: " + w)

    if model.fluid_type == "compositional":
        from .solvers.compositional import CompositionalSolver
        solver = CompositionalSolver(model, opt, logm)
        init = initialize_compositional(model)
    else:
        from .solvers.blackoil import BlackOilSolver
        solver = BlackOilSolver(model, opt, logm)
        init = initialize_blackoil(model)
    solver.set_initial_state(init)
    logm("Initialisation complete")

    res = _new_results(model)
    _record_report(res, model, solver, 0.0)
    fs0 = solver.field_state()
    logm(f"Initial in place: oil {u.from_si(fs0['FOIP'], 'liquid_surface_volume'):.6g} "
         f"{u.label('liquid_surface_volume')}, gas {u.from_si(fs0['FGIP'], 'gas_surface_volume'):.6g} "
         f"{u.label('gas_surface_volume')}, water {u.from_si(fs0['FWIP'], 'liquid_surface_volume'):.6g} "
         f"{u.label('liquid_surface_volume')}")
    summary = _SummaryCollector(model, res)
    summary.record(0.0, solver, None, fs0)

    t_end = model.schedule[-1].end_time if model.schedule else 0.0
    t = 0.0
    dt = opt.initial_dt_days * DAY
    n_steps = n_newton = n_cuts = 0
    for rstep_i, rstep in enumerate(model.schedule):
        if rstep.tuning.get("TSINIT"):
            dt = rstep.tuning["TSINIT"]
        max_dt = rstep.tuning.get("TSMAXZ", opt.max_dt_days * DAY)
        max_dt = min(max_dt, opt.max_dt_days * DAY)
        solver.setup_wells(rstep.wells)
        while t < rstep.end_time - 1e-6:
            if should_stop():
                raise SimulationAborted("Simulation stopped by user")
            remaining = rstep.end_time - t
            dt = min(dt, max_dt)
            if remaining <= dt * 1.0001:
                dt_try = remaining
            elif remaining < 2 * dt:
                dt_try = 0.5 * remaining
            else:
                dt_try = dt
            ok, its, info = solver.step(dt_try)
            n_newton += its
            if not ok:
                n_cuts += 1
                dt = dt_try / 3.0
                logm(f"  t={t / DAY:10.3f} d: step of {dt_try / DAY:.4g} d failed after {its} iterations, "
                     f"cutting to {dt / DAY:.4g} d")
                if dt < opt.min_dt_days * DAY:
                    raise SimulationError(f"Time step below minimum at t={t / DAY:.3f} days; simulation failed")
                continue
            t += dt_try
            n_steps += 1
            fs = solver.field_state()
            summary.record(t, solver, dt_try, fs)
            # next step size
            fac = 2.0
            if "ds" in info:
                fac = min(fac, opt.ds_target / max(info["ds"], 1e-6))
            if "dp" in info:
                fac = min(fac, opt.dp_target_bar * 1e5 / max(info["dp"], 1e-6))
            if "factor" in info:
                fac = min(fac, info["factor"])
            if its > 8:
                fac = min(fac, 1.0)
            fac = max(fac, 0.5)
            if dt_try >= dt * 0.999 or dt_try < dt:
                dt = max(dt_try * fac, opt.min_dt_days * DAY)
            frac = t / t_end if t_end > 0 else 1.0
            wr = solver.well_report()
            fopr = sum(v["oil"] for v in wr.values() if v["kind"] == "PROD")
            progress(frac, f"Day {t / DAY:.1f} / {t_end / DAY:.1f}  dt={dt_try / DAY:.3g} d  newton={its}")
            logm(f"  t={t / DAY:10.3f} d  dt={dt_try / DAY:8.4f} d  it={its:2d}  "
                 f"FPR={u.from_si(fs['FPR'], 'pressure'):9.2f} {u.label('pressure')}  "
                 f"FOPR={u.from_si(fopr, 'liquid_surface_rate'):10.2f} {u.label('liquid_surface_rate')}")
        _record_report(res, model, solver, t)
        logm(f"Report step {rstep_i + 1}/{len(model.schedule)}: {rstep.date:%d %b %Y} (day {t / DAY:.2f})")
    summary.finish()
    wall = time.time() - t_wall
    logm(f"Simulation finished: {n_steps} time steps, {n_newton} Newton iterations, {n_cuts} cuts, "
         f"{wall:.1f} s wall time")
    progress(1.0, "Finished")
    res.log = messages
    return res


# --------------------------------------------------------------------------- results
def _new_results(model) -> Results:
    u = model.units
    g = model.grid
    L = u.to_si(1.0, "length")
    res = Results()
    res.meta = {"case": model.case_name, "title": model.title, "units": u.name, "fluid_type": model.fluid_type,
                "phases": model.phases, "start_date": model.start_date.isoformat(),
                "component_names": list(model.eos.names) if model.eos else []}
    res.nx, res.ny, res.nz = g.nx, g.ny, g.nz
    res.corners = (g.corners / L).astype(np.float32)
    res.active = model.active.copy()
    dx, dy, dz = g.cell_dims()
    perm_u = u.to_si(1.0, "perm")
    deck = model.deck
    poro = None
    for kw in deck.keywords:
        if kw.name == "PORO" and isinstance(kw.data, np.ndarray) and kw.data.size == g.n_cells:
            poro = kw.data
    pv_full = model.to_full(model.pore_volume)
    with np.errstate(divide="ignore", invalid="ignore"):
        poro_eff = np.where(g.volume > 0, pv_full / (g.volume * np.maximum(model.ntg, 1e-12)), np.nan)
    res.static = {
        "PORO": np.where(model.active, poro_eff if poro is None else poro, np.nan),
        "PERMX": np.where(model.active, model.perm[0] / perm_u, np.nan),
        "PERMY": np.where(model.active, model.perm[1] / perm_u, np.nan),
        "PERMZ": np.where(model.active, model.perm[2] / perm_u, np.nan),
        "NTG": np.where(model.active, model.ntg, np.nan),
        "DEPTH": g.depth / L,
        "PORV": u.from_si(pv_full, "reservoir_volume"),
        "DX": dx / L, "DY": dy / L, "DZ": dz / L,
        "SATNUM": model.to_full(model.satnum + 1.0),
        "PVTNUM": model.to_full(model.pvtnum + 1.0),
    }
    names = {}
    for st in model.schedule:
        for name, w in st.wells.items():
            names[name] = w
    res.wells = [{"name": n, "kind": w.kind, "i": int(w.i), "j": int(w.j),
                  "completions": [[int(c.i), int(c.j), int(c.k)] for c in w.completions]}
                 for n, w in names.items()]
    return res


_CELL_UNITS = {"PRESSURE": "pressure", "RS": "rs", "DENO": "density", "DENG": "density", "DENW": "density"}


def _record_report(res: Results, model, solver, t):
    u = model.units
    arrays = solver.cell_arrays()
    for name, vals in arrays.items():
        q = _CELL_UNITS.get(name)
        v = u.from_si(vals, q) if q else vals
        full = model.to_full(v).astype(np.float32)
        if name not in res.cell_data:
            res.cell_data[name] = []
        res.cell_data[name].append(full)
    res.report_times = list(res.report_times) + [t / DAY]
    res.report_dates = list(res.report_dates) + [(model.start_date + timedelta(seconds=t)).isoformat()]
    for name in res.cell_data:
        if isinstance(res.cell_data[name], list) and len(res.cell_data[name]) == len(res.report_times):
            continue


class _SummaryCollector:
    def __init__(self, model, res):
        self.m = model
        self.res = res
        self.rows = []
        self.cum = {}

    def record(self, t, solver, dt, fs):
        u = self.m.units
        wr = solver.well_report()
        row = {"TIME": t / DAY}
        tot = {k: 0.0 for k in ("OPR", "WPR", "GPR", "WIR", "GIR")}
        for name, w in wr.items():
            o, wa, g = w["oil"], w["water"], w["gas"]
            if not w["open"]:
                o = wa = g = 0.0
            if w["kind"] == "PROD":
                vals = {"OPR": max(o, 0), "WPR": max(wa, 0), "GPR": max(g, 0), "WIR": 0.0, "GIR": 0.0}
            else:
                vals = {"OPR": 0.0, "WPR": 0.0, "GPR": 0.0, "WIR": max(-wa, 0), "GIR": max(-g, 0)}
            for k, v in vals.items():
                tot[k] += v
                ck = f"W{k[0]}{k[1]}T:{name}"
                if dt is not None:
                    self.cum[ck] = self.cum.get(ck, 0.0) + v * dt
                else:
                    self.cum.setdefault(ck, 0.0)
            rate_q = {"OPR": "liquid_surface_rate", "WPR": "liquid_surface_rate", "GPR": "gas_surface_rate",
                      "WIR": "liquid_surface_rate", "GIR": "gas_surface_rate"}
            for k, v in vals.items():
                row[f"W{k}:{name}"] = u.from_si(v, rate_q[k])
            row[f"WBHP:{name}"] = u.from_si(w["bhp"], "pressure")
            liq = vals["OPR"] + vals["WPR"]
            row[f"WWCT:{name}"] = vals["WPR"] / liq if liq > 0 else 0.0
            row[f"WGOR:{name}"] = u.from_si(vals["GPR"] / vals["OPR"], "rs") if vals["OPR"] > 0 else 0.0
            for k, q in (("OPT", "liquid_surface_volume"), ("WPT", "liquid_surface_volume"),
                         ("GPT", "gas_surface_volume"), ("WIT", "liquid_surface_volume"),
                         ("GIT", "gas_surface_volume")):
                row[f"W{k}:{name}"] = u.from_si(self.cum.get(f"W{k}:{name}", 0.0), q)
        for k, q in (("OPR", "liquid_surface_rate"), ("WPR", "liquid_surface_rate"), ("GPR", "gas_surface_rate"),
                     ("WIR", "liquid_surface_rate"), ("GIR", "gas_surface_rate")):
            row["F" + k] = u.from_si(tot[k], q)
            ck = "F" + k[:2] + "T"
            if dt is not None:
                self.cum[ck] = self.cum.get(ck, 0.0) + tot[k] * dt
            row[ck] = u.from_si(self.cum.get(ck, 0.0),
                                "gas_surface_volume" if k[0] == "G" or k == "GIR" else "liquid_surface_volume")
        row["FLPR"] = row["FOPR"] + row["FWPR"]
        liq = tot["OPR"] + tot["WPR"]
        row["FWCT"] = tot["WPR"] / liq if liq > 0 else 0.0
        row["FGOR"] = u.from_si(tot["GPR"] / tot["OPR"], "rs") if tot["OPR"] > 0 else 0.0
        row["FPR"] = u.from_si(fs["FPR"], "pressure")
        row["FOIP"] = u.from_si(fs["FOIP"], "liquid_surface_volume")
        row["FGIP"] = u.from_si(fs["FGIP"], "gas_surface_volume")
        row["FWIP"] = u.from_si(fs["FWIP"], "liquid_surface_volume")
        self.rows.append(row)

    def finish(self):
        keys = []
        for r in self.rows:
            for k in r:
                if k not in keys:
                    keys.append(k)
        for k in keys:
            self.res.summary[k] = np.array([r.get(k, np.nan) for r in self.rows], float)
        for k, v in self.res.cell_data.items():
            self.res.cell_data[k] = np.asarray(v, np.float32)
