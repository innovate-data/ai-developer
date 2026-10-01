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
    linear_solver: str = "auto"     # "auto", "direct" or "iterative" (CPR-AMG preconditioned GMRES)
    linear_tol: float = 1e-5        # relative residual reduction of the iterative solver (inexact Newton)
    ds_max: float = 0.2             # max saturation change per Newton iteration
    ds_target: float = 0.2          # target saturation change per time step
    dp_target_bar: float = 50.0     # target pressure change per time step
    # compositional (IMPEC) controls
    max_dz_comp: float = 0.05       # max overall mole fraction change per step
    max_cfl: float = 0.8
    # thermal controls
    thermal_tol: float = 0.01       # energy residual tolerance expressed in kelvin
    dT_max: float = 30.0            # max temperature change per Newton iteration (K)
    dT_target: float = 20.0         # target temperature change per time step (K)
    # run limits: end the run early (keeping the results so far); 0 = no limit
    stop_at_day: float = 0.0        # simulated time at which to stop
    max_wall_s: float = 0.0         # wall-clock budget in seconds


class SimulationAborted(Exception):
    pass


class SimulationError(Exception):
    pass


def _noop(*_a, **_k):
    return None


def run_simulation(deck_or_path, options: SimOptions | None = None, progress=None, log=None,
                   should_stop=None, on_step=None, on_report=None, keep_partial=False) -> Results:
    """Run an ECLIPSE deck (path or parsed `Deck` or built `SimulationModel`).

    on_step(info)              called after every time step attempt with a dict of step statistics
                               and field values (deck units); failed attempts have ``ok=False``.
    on_report(res, i, rows)    called after report step i is stored in `res`; `rows` are the summary
                               rows recorded so far (dicts, deck units).
    keep_partial               if True, a stop request ends the run normally with the results so far
                               (``res.meta["stopped"]`` gives the reason) instead of raising
                               `SimulationAborted`. The `stop_at_day` and `max_wall_s` limits always
                               end the run this way.
    """
    opt = options or SimOptions()
    progress = progress or _noop
    log = log or _noop
    should_stop = should_stop or (lambda: False)
    on_step = on_step or _noop
    on_report = on_report or _noop
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
    if model.schedule:            # wells of the first report step, so that t = 0 well vectors exist
        st0 = model.schedule[0]
        if hasattr(solver, "economic_limits"):
            solver.setup_wells(st0.wells, touched=st0.touched, vfp=st0.vfp)
        else:
            solver.setup_wells(st0.wells)
    summary.record(0.0, solver, None, fs0)
    on_report(res, 0, summary.rows)

    t_end = model.schedule[-1].end_time if model.schedule else 0.0
    t_stop = opt.stop_at_day * DAY if opt.stop_at_day and opt.stop_at_day > 0 else np.inf
    t_end_run = min(t_end, t_stop)
    t = 0.0
    dt = opt.initial_dt_days * DAY
    n_steps = n_newton = n_cuts = 0
    stopped = None
    for rstep_i, rstep in enumerate(model.schedule):
        summary._step_index = rstep_i
        if rstep.tuning.get("TSINIT"):
            dt = rstep.tuning["TSINIT"]
        # a TUNING maximum step in the deck overrides the run option
        max_dt = rstep.tuning.get("TSMAXZ", opt.max_dt_days * DAY)
        solver.t_now = t
        solver.groups = rstep.groups
        if hasattr(solver, "well_tests"):
            for name in solver.well_tests(t, rstep.wells):
                logm(f"  WTEST: well {name} re-opened for testing")
        if hasattr(solver, "economic_limits"):
            solver.setup_wells(rstep.wells, touched=rstep.touched, vfp=rstep.vfp)
        else:
            solver.setup_wells(rstep.wells)
        if hasattr(solver, "set_options"):
            solver.set_options(rstep.options)
        step_end = min(rstep.end_time, t_stop)
        while t < step_end - 1e-6:
            if should_stop():
                if not keep_partial:
                    raise SimulationAborted("Simulation stopped by user")
                stopped = "stopped by user"
            elif opt.max_wall_s and time.time() - t_wall > opt.max_wall_s:
                stopped = f"wall-clock limit of {opt.max_wall_s:g} s reached"
            if stopped:
                break
            remaining = step_end - t
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
                on_step({"ok": False, "t": t / DAY, "dt": dt_try / DAY, "its": its, "steps": n_steps,
                         "cuts": n_cuts, "newton": n_newton, "frac": t / t_end_run if t_end_run > 0 else 1.0,
                         "wall": time.time() - t_wall})
                dt = dt_try / 3.0
                logm(f"  t={t / DAY:10.3f} d: step of {dt_try / DAY:.4g} d failed after {its} iterations, "
                     f"cutting to {dt / DAY:.4g} d")
                if dt < opt.min_dt_days * DAY:
                    raise SimulationError(f"Time step below minimum at t={t / DAY:.3f} days; simulation failed")
                continue
            t += dt_try
            solver.t_now = t
            n_steps += 1
            fs = solver.field_state()
            summary._newton = its
            summary._linears = getattr(solver, "linear_iterations", 0)
            summary.record(t, solver, dt_try, fs)
            if hasattr(solver, "economic_limits"):
                econ_msgs, econ_end = solver.economic_limits()
                for msg_ in econ_msgs:
                    logm(f"  t={t / DAY:10.3f} d  {msg_}")
                if econ_end and stopped is None:
                    stopped = "economic limit with end-of-run requested (WECON)"
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
            frac = t / t_end_run if t_end_run > 0 else 1.0
            wr = solver.well_report()
            fopr = sum(v["oil"] for v in wr.values() if v["kind"] == "PROD")
            progress(frac, f"Day {t / DAY:.1f} / {t_end_run / DAY:.1f}  dt={dt_try / DAY:.3g} d  newton={its}")
            row = summary.rows[-1]
            info_out = {"ok": True, "t": t / DAY, "dt": dt_try / DAY, "its": its, "steps": n_steps, "cuts": n_cuts,
                        "newton": n_newton, "frac": frac, "wall": time.time() - t_wall}
            for k in ("FPR", "FOPR", "FWPR", "FGPR", "FWIR", "FGIR", "FWCT", "FGOR", "FTEMP", "FCO2D"):
                if k in row and np.isfinite(row[k]):
                    info_out[k] = float(row[k])
            on_step(info_out)
            logm(f"  t={t / DAY:10.3f} d  dt={dt_try / DAY:8.4f} d  it={its:2d}  "
                 f"FPR={u.from_si(fs['FPR'], 'pressure'):9.2f} {u.label('pressure')}  "
                 f"FOPR={u.from_si(fopr, 'liquid_surface_rate'):10.2f} {u.label('liquid_surface_rate')}")
        if stopped is None and t < rstep.end_time - 1e-6:
            stopped = f"stop time of day {opt.stop_at_day:g} reached"
        if stopped is not None and t <= res.report_times[-1] * DAY + 1e-6:
            break                                   # nothing new since the last report
        _record_report(res, model, solver, t)
        on_report(res, len(res.report_times) - 1, summary.rows)
        if stopped is not None:
            logm(f"Run ended early at day {t / DAY:.2f}: {stopped}")
            break
        logm(f"Report step {rstep_i + 1}/{len(model.schedule)}: {rstep.date:%d %b %Y} (day {t / DAY:.2f})")
    summary.finish()
    if stopped is not None:
        res.meta["stopped"] = stopped
        res.meta["stopped_day"] = t / DAY
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


_CELL_UNITS = {"PRESSURE": "pressure", "RS": "rs", "RV": "rv", "RSW": "rs", "RVW": "rv", "TEMP": "temperature",
               "DENO": "density", "DENG": "density", "DENW": "density"}


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
            row[f"WBHP:{name}"] = u.from_si(w["bhp"], "pressure") if w["open"] else 0.0     # 0 when shut, as ECLIPSE
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
        # further well vectors (block pressures, THP, voidage, status ...) and their field totals
        ex = solver.well_extras() if hasattr(solver, "well_extras") else {}
        ftot = {"VPR": 0.0, "VIR": 0.0, "OIR": 0.0}
        for name, d in ex.items():
            for key, (val, q) in d.items():
                row[f"{key}:{name}"] = u.from_si(val, q) if q else val
            for k in ftot:
                ftot[k] += d["W" + k][0]
        if ex:
            row["FVPR"] = u.from_si(ftot["VPR"], "reservoir_rate")
            row["FVIR"] = u.from_si(ftot["VIR"], "reservoir_rate")
            row["FOIR"] = u.from_si(ftot["OIR"], "liquid_surface_rate")
            row["FWGR"] = u.from_si(tot["WPR"] / tot["GPR"], "wgr") if tot["GPR"] > 0 else 0.0
        step = self.m.schedule[min(len(self.m.schedule) - 1, getattr(self, "_step_index", 0))] \
            if self.m.schedule else None
        if hasattr(solver, "well_potentials") and self._want(("WOPP", "WWPP", "WGPP", "WWIP", "WGIP", "WPI")):
            for name, d in solver.well_potentials().items():
                for key, (val, q) in d.items():
                    row[f"{key}:{name}"] = u.from_si(val, q)
        self._history(row, step, wr, dt)
        self._groups(row, wr)
        self._tracers(row, solver, wr, dt)
        self._regions(row, solver, dt)
        self._connections(row, solver, dt)
        self._region_flows(row, solver, dt)
        self._blocks(row, solver)
        # cumulative voidage / liquid, gas sales (production - injection - consumption, no fuel here)
        for k, q in (("VPR", "reservoir_volume"), ("VIR", "reservoir_volume")):
            if "F" + k in row:
                ck = "F" + k[:2] + "T"
                if dt is not None:
                    self.cum[ck] = self.cum.get(ck, 0.0) + u.to_si(row["F" + k], "reservoir_rate") * dt
                row[ck] = u.from_si(self.cum.get(ck, 0.0), q)
        row["FLPT"] = row["FOPT"] + row["FWPT"]
        for name in wr:
            if f"WOPT:{name}" in row:
                row[f"WLPT:{name}"] = row[f"WOPT:{name}"] + row[f"WWPT:{name}"]
        row["FGCR"] = row["FGCT"] = 0.0
        row["FGSR"] = row["FGPR"] - row["FGIR"]
        row["FGST"] = row["FGPT"] - row["FGIT"]
        row["NEWTON"] = float(getattr(self, "_newton", 0))
        row["MLINEARS"] = float(getattr(self, "_linears", 0))
        row["FLPR"] = row["FOPR"] + row["FWPR"]
        liq = tot["OPR"] + tot["WPR"]
        row["FWCT"] = tot["WPR"] / liq if liq > 0 else 0.0
        row["FGOR"] = u.from_si(tot["GPR"] / tot["OPR"], "rs") if tot["OPR"] > 0 else 0.0
        row["FPR"] = u.from_si(fs["FPR"], "pressure")
        row["FOIP"] = u.from_si(fs["FOIP"], "liquid_surface_volume")
        row["FGIP"] = u.from_si(fs["FGIP"], "gas_surface_volume")
        row["FWIP"] = u.from_si(fs["FWIP"], "liquid_surface_volume")
        extra_units = getattr(solver, "summary_units", {})
        for key, val in fs.items():
            if key not in row:
                q = extra_units.get(key)
                row[key] = u.from_si(val, q) if q else val
        self.rows.append(row)

    def _want(self, names):
        req = set(getattr(self.m, "summary_keywords", []) or [])
        return not req or any(n in req for n in names)

    def _history(self, row, step, wr, dt):
        """Observed (WCONHIST / WCONINJH) rates, pressures and their totals: W..H, G..H, F..H."""
        if step is None:
            return
        u = self.m.units
        tot = {k: 0.0 for k in ("OPR", "WPR", "GPR", "WIR", "GIR")}
        any_hist = False
        for name in wr:
            w = step.wells.get(name)
            ob = getattr(w, "observed", None) if w is not None else None
            open_ = w is not None and w.status == "OPEN"
            vals = {k: 0.0 for k in tot}
            if ob is not None and open_:
                any_hist = True
                if w.kind == "PROD":
                    vals.update(OPR=ob.get("ORAT") or 0.0, WPR=ob.get("WRAT") or 0.0, GPR=ob.get("GRAT") or 0.0)
                else:
                    key = "GIR" if w.inj_type == "GAS" else "WIR"
                    vals[key] = ob.get("RATE") or 0.0
            elif w is not None and open_ and w.kind == "INJ" and not w.history:
                # injectors on WCONINJE: the history rate is the target rate (as ECLIPSE reports)
                key = "GIR" if w.inj_type == "GAS" else ("WIR" if w.inj_type == "WATER" else None)
                if key and w.control == "RATE":
                    vals[key] = w.targets.get("RATE") or 0.0
            q = {"OPR": "liquid_surface_rate", "WPR": "liquid_surface_rate", "GPR": "gas_surface_rate",
                 "WIR": "liquid_surface_rate", "GIR": "gas_surface_rate"}
            for k, v in vals.items():
                tot[k] += v
                row[f"W{k}H:{name}"] = u.from_si(v, q[k])
                ck = f"W{k[:2]}TH:{name}"
                if dt is not None:
                    self.cum[ck] = self.cum.get(ck, 0.0) + v * dt
                row[ck] = u.from_si(self.cum.get(ck, 0.0), "gas_surface_volume" if k[0] == "G" else
                                    "liquid_surface_volume")
            liq = vals["OPR"] + vals["WPR"]
            row[f"WLPRH:{name}"] = u.from_si(liq, "liquid_surface_rate")
            row[f"WLPTH:{name}"] = row[f"WOPTH:{name}"] + row[f"WWPTH:{name}"]
            row[f"WWCTH:{name}"] = vals["WPR"] / liq if liq > 0 else 0.0
            row[f"WGORH:{name}"] = u.from_si(vals["GPR"] / vals["OPR"], "rs") if vals["OPR"] > 0 else 0.0
            row[f"WBHPH:{name}"] = u.from_si(ob.get("BHP") or 0.0, "pressure") if ob is not None and open_ else 0.0
            row[f"WTHPH:{name}"] = u.from_si(ob.get("THP") or 0.0, "pressure") if ob is not None and open_ else 0.0
        if not any_hist and not self.rows:
            pass
        for k, q in (("OPR", "liquid_surface_rate"), ("WPR", "liquid_surface_rate"), ("GPR", "gas_surface_rate"),
                     ("WIR", "liquid_surface_rate"), ("GIR", "gas_surface_rate")):
            row[f"F{k}H"] = u.from_si(tot[k], q)
            ck = f"F{k[:2]}TH"
            if dt is not None:
                self.cum[ck] = self.cum.get(ck, 0.0) + tot[k] * dt
            row[ck] = u.from_si(self.cum.get(ck, 0.0), "gas_surface_volume" if k[0] == "G" else "liquid_surface_volume")
        liq = tot["OPR"] + tot["WPR"]
        row["FLPRH"] = u.from_si(liq, "liquid_surface_rate")
        row["FLPTH"] = row["FOPTH"] + row["FWPTH"]
        row["FWCTH"] = tot["WPR"] / liq if liq > 0 else 0.0
        row["FGORH"] = u.from_si(tot["GPR"] / tot["OPR"], "rs") if tot["OPR"] > 0 else 0.0

    def _tracers(self, row, solver, wr, dt):
        """Tracer rates, totals and concentrations: FTPR / FTPT / FTIR / FTIT / FTPC and W.. ."""
        tr = getattr(solver, "tracers", None)
        if not tr:
            return
        rates = getattr(solver, "tracer_rates", {}) or {}
        phase_rate = {"WAT": ("WPR", "WWPR"), "OIL": ("OPR", "WOPR"), "GAS": ("GPR", "WGPR")}
        u = self.m.units
        for t in tr:
            nm, ph = t["name"], t["phase"]
            q = "gas_surface_rate" if ph == "GAS" else "liquid_surface_rate"
            per = rates.get(nm, {})
            fp = fi = 0.0
            for name in wr:
                p_, i_ = per.get(name, (0.0, 0.0)) if wr[name]["open"] else (0.0, 0.0)
                fp += p_
                fi += i_
                row[f"WTPR{nm}:{name}"] = u.from_si(p_, q)
                row[f"WTIR{nm}:{name}"] = u.from_si(i_, q)
                for k, v in (("WTPT", p_), ("WTIT", i_)):
                    ck = f"{k}{nm}:{name}"
                    if dt is not None:
                        self.cum[ck] = self.cum.get(ck, 0.0) + v * dt
                    row[ck] = u.from_si(self.cum.get(ck, 0.0), "gas_surface_volume" if ph == "GAS" else
                                        "liquid_surface_volume")
                prate = row.get(f"{phase_rate[ph][1]}:{name}", 0.0)
                row[f"WTPC{nm}:{name}"] = row[f"WTPR{nm}:{name}"] / prate if prate > 0 else 0.0
            row[f"FTPR{nm}"] = u.from_si(fp, q)
            row[f"FTIR{nm}"] = u.from_si(fi, q)
            for k, v in (("FTPT", fp), ("FTIT", fi)):
                ck = f"{k}{nm}"
                if dt is not None:
                    self.cum[ck] = self.cum.get(ck, 0.0) + v * dt
                row[ck] = u.from_si(self.cum.get(ck, 0.0), "gas_surface_volume" if ph == "GAS" else
                                    "liquid_surface_volume")
            fr = row.get("F" + phase_rate[ph][0], 0.0)
            row[f"FTPC{nm}"] = row[f"FTPR{nm}"] / fr if fr > 0 else 0.0

    def _regions(self, row, solver, dt):
        """FIPNUM region vectors (RPR, ROIP, RWIP, RGIP and their liquid/vapour splits, ROP, region
        well rates R?PR / R?IR and totals R?PT / R?IT)."""
        fip = getattr(self.m, "fipnum", None)
        if fip is None or not hasattr(solver, "region_state"):
            return
        req = set(getattr(self.m, "summary_keywords", []) or [])
        if req and not any(k.startswith("R") and k not in ("RUNSUM", "RPTONLY", "RPTSMRY") for k in req):
            return
        u = self.m.units
        nreg = int(fip.max()) + 1 if fip.size else 0
        nreg = max(nreg, int(getattr(self.m, "n_fip_regions", 0) or 0))
        rs = solver.region_state(fip, nreg)
        for key, (arr, q) in rs.items():
            for r in range(nreg):
                row[f"{key}:{r + 1}"] = u.from_si(float(arr[r]), q)
        for key in ("OPR", "WPR", "GPR", "OIR", "WIR", "GIR"):
            if f"R{key}" not in rs:
                continue
            arr = rs[f"R{key}"][0]
            ck = f"R{key[:2]}T"
            for r in range(nreg):
                c = f"{ck}:{r + 1}"
                if dt is not None:
                    self.cum[c] = self.cum.get(c, 0.0) + float(arr[r]) * dt
                row[c] = u.from_si(self.cum.get(c, 0.0), "gas_surface_volume" if key[0] == "G" else
                                   "liquid_surface_volume")
        for r in range(nreg):
            if f"ROPT:{r + 1}" in row:
                row[f"ROP:{r + 1}"] = row[f"ROPT:{r + 1}"]

    def _blocks(self, row, solver):
        """Block vectors requested in SUMMARY: BPR, BOSAT, BWSAT, BGSAT, BRS, BRV, BDENO/W/G."""
        spec = getattr(self.m, "summary_blocks", None)
        if not spec:
            return
        u = self.m.units
        st = solver.state
        so = 1.0 - st["sw"] - st.get("sg", 0.0)
        dens = None
        for vec, cells in spec.items():
            key = vec[1:]
            for (i, j, k), a in cells:
                if key == "PR":
                    v = u.from_si(st["p"][a], "pressure")
                elif key == "OSAT":
                    v = so[a]
                elif key == "WSAT":
                    v = st["sw"][a]
                elif key == "GSAT":
                    v = st["sg"][a] if "sg" in st else 0.0
                elif key in ("RS", "RV"):
                    v = u.from_si(st[key.lower()][a], key.lower()) if key.lower() in st else 0.0
                else:
                    if dens is None:
                        _, pr = solver.accumulation_values(st)
                        dens = {ph: np.asarray(getattr(pr.get(f"rho_{ph}"), "val", pr.get(f"rho_{ph}")))
                                for ph in "owg" if f"rho_{ph}" in pr}
                    d = dens.get(key[-1].lower())
                    v = u.from_si(float(d[a]), "density") if d is not None else 0.0
                row[f"{vec}:{i},{j},{k}"] = float(v)

    def _region_flows(self, row, solver, dt):
        """Inter-region flow rates and totals (R?FR / R?FT for the region pairs listed in SUMMARY)."""
        spec = getattr(self.m, "summary_region_flows", None)
        if not spec or not hasattr(solver, "region_flows"):
            return
        u = self.m.units
        pairs = sorted({p for v in spec.values() for p in v})
        flows = solver.region_flows(pairs) if dt is not None else {}
        for vec, plist in spec.items():
            comp = vec[1].lower()
            rq = "gas_surface_rate" if comp == "g" else "liquid_surface_rate"
            vq = "gas_surface_volume" if comp == "g" else "liquid_surface_volume"
            for r1, r2 in plist:
                rate = flows.get((comp, r1, r2), 0.0)
                tag = f"{vec}:{r1 + 1}-{r2 + 1}"
                if vec.endswith("FR"):
                    row[tag] = u.from_si(rate, rq)
                else:
                    if dt is not None:
                        self.cum[tag] = self.cum.get(tag, 0.0) + rate * dt
                    row[tag] = u.from_si(self.cum.get(tag, 0.0), vq)

    def _connections(self, row, solver, dt):
        """Connection vectors requested in SUMMARY (C?FR, C?PR, C?IR and totals)."""
        spec = getattr(self.m, "summary_connections", None)
        if not spec or not hasattr(solver, "connection_rates"):
            return
        u = self.m.units
        conns = solver.connection_rates()
        qn = {"O": ("o", "liquid_surface_rate", "liquid_surface_volume"),
              "W": ("w", "liquid_surface_rate", "liquid_surface_volume"),
              "G": ("g", "gas_surface_rate", "gas_surface_volume")}
        for vec, wells in spec.items():
            ph, kind = vec[1], vec[2:]
            if ph not in qn:
                continue
            key, qr, qv = qn[ph]
            for (wname, i, j, k), q in conns.items():
                if wells is not None and not any(wname.upper() == str(w_).upper() or
                                                 __import__("fnmatch").fnmatchcase(wname.upper(), str(w_).upper())
                                                 for w_ in wells):
                    continue
                v = q.get(key, 0.0)
                tag = f"{vec}:{wname}:{i},{j},{k}"
                if kind == "FR":
                    row[tag] = u.from_si(v, qr)
                elif kind == "PR":
                    row[tag] = u.from_si(max(v, 0.0), qr)
                elif kind == "IR":
                    row[tag] = u.from_si(max(-v, 0.0), qr)
                elif kind in ("PT", "IT", "FT"):
                    rate = max(v, 0.0) if kind == "PT" else (max(-v, 0.0) if kind == "IT" else v)
                    if dt is not None:
                        self.cum[tag] = self.cum.get(tag, 0.0) + rate * dt
                    row[tag] = u.from_si(self.cum.get(tag, 0.0), qv)

    def _groups(self, row, wr):
        """Group vectors (GOPR, GWIR, ...) summed over the wells below each group of GRUPTREE."""
        if not self.m.schedule:
            return
        step = self.m.schedule[min(len(self.m.schedule) - 1, getattr(self, "_step_index", 0))]
        tree = getattr(step, "groups", None) or {}
        groups = [g for g in tree if g and g != "FIELD"]
        if not groups:
            return
        u = self.m.units
        def ancestors(g):
            seen = []
            while g and g != "FIELD" and g not in seen:
                seen.append(g)
                g = tree.get(g, "FIELD")
            return seen
        members = {g: [] for g in groups}
        for name in wr:
            w = step.wells.get(name)
            if w is not None:
                for g in ancestors(w.group):
                    if g in members:
                        members[g].append(name)
        rates = ("OPR", "WPR", "GPR", "WIR", "GIR")
        for g, names in members.items():
            for k in rates + ("OPT", "WPT", "GPT", "WIT", "GIT", "VPR", "VIR"):
                row[f"G{k}:{g}"] = sum(row.get(f"W{k}:{n}", 0.0) for n in names)
            o, wa, gg = row[f"GOPR:{g}"], row[f"GWPR:{g}"], row[f"GGPR:{g}"]
            row[f"GLPR:{g}"] = o + wa
            row[f"GWCT:{g}"] = wa / (o + wa) if o + wa > 0 else 0.0
            row[f"GGOR:{g}"] = gg / o if o > 0 else 0.0           # already in deck units

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
