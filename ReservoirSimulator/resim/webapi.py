"""JSON bridge used by the browser (Pyodide) build of the ReSim GUI.

Every function takes and returns plain JSON strings so that it can be called
from JavaScript in a Web Worker.  Result payloads pack the 3D arrays as
base64 (float32 corners, uint16-quantised cell data) to keep them small.
"""
from __future__ import annotations

import base64
import dataclasses
import json
import os
import traceback

import numpy as np

WORK = "/work"


def _b64(a, dtype):
    return base64.b64encode(np.ascontiguousarray(a, dtype=dtype).tobytes()).decode()


def _quantise(arr2d, active):
    d = np.asarray(arr2d, float)[:, active]
    fin = np.isfinite(d)
    if not fin.any():
        lo, hi = 0.0, 1.0
    else:
        lo, hi = float(d[fin].min()), float(d[fin].max())
    if hi - lo < 1e-12:
        hi = lo + 1.0
    q = np.where(fin, np.round((np.nan_to_num(d, nan=lo) - lo) / (hi - lo) * 65534), 65535).astype(np.uint16)
    return {"lo": lo, "hi": hi, "q": _b64(q, "<u2")}


def results_payload(res, wall=None):
    """Compact JSON-able dict of a `Results` object."""
    act = np.asarray(res.active, bool)
    cell = {k: _quantise(v, act) for k, v in res.cell_data.items()}
    static = {k: _quantise(np.asarray(v)[None, :], act) for k, v in res.static.items()}
    units = {}
    dens = "kg/m3" if res.meta.get("units") == "METRIC" else "lb/ft3"
    for k in cell:
        units[k] = {"PRESSURE": res.unit_label("FPR"), "RS": res.unit_label("FGOR"), "RSW": res.unit_label("FGOR"),
                    "RV": "stb/Mscf" if res.meta.get("units") == "FIELD" else "sm3/sm3",
                    "RVW": "stb/Mscf" if res.meta.get("units") == "FIELD" else "sm3/sm3",
                    "TEMP": "°F" if res.meta.get("units") == "FIELD" else "°C",
                    "DENO": dens, "DENG": dens, "DENW": dens}.get(k, "fraction")
    lu = "ft" if res.meta.get("units") == "FIELD" else "m"
    for k in static:
        units[k] = {"PERMX": "mD", "PERMY": "mD", "PERMZ": "mD", "DEPTH": lu, "DX": lu, "DY": lu, "DZ": lu,
                    "PORV": res.unit_label("FOIP").replace("stb", "rb").replace("sm3", "rm3"),
                    "SATNUM": "", "PVTNUM": ""}.get(k, "fraction")
    summ = {}
    for k, v in res.summary.items():
        summ[k] = [None if not np.isfinite(x) else float(f"{x:.6g}") for x in np.asarray(v, float)]
        if k != "TIME":
            units[k] = res.unit_label(k)
    return {
        "meta": res.meta, "dims": [res.nx, res.ny, res.nz],
        "corners": _b64(np.asarray(res.corners).reshape(-1), "<f4"),
        "active": _b64(act.astype(np.uint8), "u1"), "nactive": int(act.sum()),
        "report_times": [float(t) for t in res.report_times],
        "report_dates": [str(d)[:10] for d in res.report_dates],
        "cell": cell, "static": static, "summary": summ, "units": units,
        "wells": res.wells, "log": res.log[-400:], "wall": wall,
    }


def _write_deck(text, name):
    os.makedirs(WORK, exist_ok=True)
    name = "".join(ch for ch in (name or "CASE") if ch.isalnum() or ch in "_-") or "CASE"
    path = os.path.join(WORK, name + ".DATA")
    with open(path, "w") as fh:
        fh.write(text)
    return path


def validate(text, name="CASE"):
    """Parse the deck and build the model; return a summary and the warnings."""
    from .model import load_model
    try:
        m = load_model(_write_deck(text, name))
    except Exception as exc:  # noqa: BLE001
        return json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}",
                           "trace": traceback.format_exc(limit=3)})
    return json.dumps({
        "ok": True,
        "summary": f"{m.grid.nx}×{m.grid.ny}×{m.grid.nz} grid, {m.n_active} active cells, "
                   f"{m.fluid_type}, {m.units.name} units, {len(m.schedule)} report steps, "
                   f"wells: {', '.join(sorted({n for s in m.schedule for n in s.wells})) or 'none'}",
        "warnings": m.warnings,
    })


def run(text, name, options_json, progress=None, log=None):
    """Run a deck and return the results payload as JSON."""
    import time
    from .simulator import SimOptions, run_simulation
    opts = json.loads(options_json or "{}")
    fields = {f.name for f in dataclasses.fields(SimOptions)}
    so = SimOptions(**{k: v for k, v in opts.items() if k in fields})
    t = time.time()
    res = run_simulation(_write_deck(text, name), so, progress=progress, log=log)
    return json.dumps(results_payload(res, round(time.time() - t, 1)), separators=(",", ":"))


# ------------------------------------------------------------------ model builder
def spec_to_json(spec):
    d = dataclasses.asdict(spec)
    d["start"] = spec.start.isoformat()
    d["bic"] = None if spec.bic is None else np.asarray(spec.bic).tolist()
    d["stcond"] = list(spec.stcond)
    return d


def default_spec_json(fluid, units):
    from .gui.deckgen import default_spec
    return json.dumps(spec_to_json(default_spec(fluid, units)))


def build_deck(form_json):
    """Generate deck text from the web form: defaults for the fluid/units, overridden by the form."""
    import datetime as dt
    from .gui.deckgen import WellSpec, default_spec, generate_deck
    f = json.loads(form_json)
    spec = default_spec(f.get("fluid", "blackoil"), f.get("units", "FIELD"))
    for key in ("case_name", "title", "dx", "dy", "dz", "poro", "permx", "permy", "permz"):
        if key in f:
            setattr(spec, key, str(f[key]))
    for key in ("nx", "ny", "nz"):
        if key in f:
            setattr(spec, key, int(f[key]))
    for key in ("top", "datum", "datum_pressure", "woc", "goc", "total_time", "report_step"):
        if key in f:
            setattr(spec, key, float(f[key]))
    if f.get("start"):
        spec.start = dt.date.fromisoformat(f["start"])
    if "wells" in f:
        spec.wells = [WellSpec(str(w["name"]), w["kind"], int(w["i"]), int(w["j"]), int(w["k1"]), int(w["k2"]),
                               w["control"], float(w["rate"]), float(w["bhp"]), w.get("phase", "WATER"))
                      for w in f["wells"]]
    try:
        return json.dumps({"ok": True, "deck": generate_deck(spec)})
    except Exception as exc:  # noqa: BLE001
        return json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"})
