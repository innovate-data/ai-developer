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
    units = _cell_units(res, cell.keys())
    units.update(_static_units(res, static.keys()))
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


def _cell_units(res, names):
    dens = "kg/m3" if res.meta.get("units") == "METRIC" else "lb/ft3"
    rv = "stb/Mscf" if res.meta.get("units") == "FIELD" else "sm3/sm3"
    table = {"PRESSURE": res.unit_label("FPR"), "RS": res.unit_label("FGOR"), "RSW": res.unit_label("FGOR"),
             "RV": rv, "RVW": rv, "TEMP": "°F" if res.meta.get("units") == "FIELD" else "°C",
             "DENO": dens, "DENG": dens, "DENW": dens}
    return {k: table.get(k, "fraction") for k in names}


def _static_units(res, names):
    lu = "ft" if res.meta.get("units") == "FIELD" else "m"
    table = {"PERMX": "mD", "PERMY": "mD", "PERMZ": "mD", "DEPTH": lu, "DX": lu, "DY": lu, "DZ": lu,
             "PORV": res.unit_label("FOIP").replace("stb", "rb").replace("sm3", "rm3"), "SATNUM": "", "PVTNUM": ""}
    return {k: table.get(k, "fraction") for k in names}


def _summary_rows_json(rows):
    out = []
    for r in rows:
        out.append({k: (None if not np.isfinite(v) else float(f"{v:.6g}")) for k, v in r.items()})
    return out


def run_stream(text, name, options_json, post):
    """Run a deck, streaming results to `post(dict)` as they are produced.

    Messages (all plain JSON-able dicts):
      {"type": "run-header", meta, dims, corners, active, nactive, static, units, wells}
          once, after initialisation (static arrays and grid geometry);
      {"type": "run-report", index, time, date, cell: {name: {lo, hi, q}}, summary: [rows]}
          after every report step; cell arrays are quantised per step to uint16, summary holds the
          rows recorded since the previous report;
      {"type": "run-step", ...}   after every time step attempt (statistics + field values);
      {"type": "log", text}.
    Returns the final JSON reply: {"ok": True, wall, log, summary (complete), units, stopped}.
    A page that loses the worker mid-run (cancel) still holds every streamed report step.
    """
    import time
    from .simulator import SimOptions, run_simulation
    opts = json.loads(options_json or "{}")
    fields = {f.name for f in dataclasses.fields(SimOptions)}
    so = SimOptions(**{k: v for k, v in opts.items() if k in fields})
    state = {"rows": 0, "last_step_post": 0.0}
    t0 = time.time()

    def on_report(res, i, rows):
        act = np.asarray(res.active, bool)
        if i == 0:
            static = {k: _quantise(np.asarray(v)[None, :], act) for k, v in res.static.items()}
            units = _cell_units(res, res.cell_data.keys())
            units.update(_static_units(res, static.keys()))
            units.update({k: res.unit_label(k) for k in rows[0] if k != "TIME"})
            post({"type": "run-header", "meta": res.meta, "dims": [res.nx, res.ny, res.nz],
                  "corners": _b64(np.asarray(res.corners).reshape(-1), "<f4"),
                  "active": _b64(act.astype(np.uint8), "u1"), "nactive": int(act.sum()),
                  "static": static, "units": units, "wells": res.wells})
        cell = {k: _quantise(np.asarray(v[i])[None, :], act) for k, v in res.cell_data.items()}
        post({"type": "run-report", "index": i, "time": float(res.report_times[i]),
              "date": str(res.report_dates[i])[:10], "cell": cell,
              "summary": _summary_rows_json(rows[state["rows"]:])})
        state["rows"] = len(rows)

    def on_step(info):
        # failed steps and at most ~10 updates per second reach the page
        now = time.time()
        if info.get("ok") and now - state["last_step_post"] < 0.1:
            return
        state["last_step_post"] = now
        info = {k: (float(v) if isinstance(v, (float, np.floating)) else v) for k, v in info.items()}
        info["type"] = "run-step"
        post(info)

    res = run_simulation(_write_deck(text, name), so, log=lambda m: post({"type": "log", "text": str(m)}),
                         on_step=on_step, on_report=on_report)
    summ = {k: [None if not np.isfinite(x) else float(f"{x:.6g}") for x in np.asarray(v, float)]
            for k, v in res.summary.items()}
    units = {k: res.unit_label(k) for k in res.summary if k != "TIME"}
    return json.dumps({"ok": True, "wall": round(time.time() - t0, 1), "log": res.log[-400:], "summary": summ,
                       "units": units, "stopped": res.meta.get("stopped"), "meta": res.meta},
                      separators=(",", ":"))


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
    for key in ("top", "datum", "datum_pressure", "woc", "goc", "total_time", "report_step",
                "rtemp", "inj_temp", "salinity"):
        if key in f and f[key] not in ("", None):
            setattr(spec, key, float(f[key]))
    if "thermal" in f:
        spec.thermal = bool(f["thermal"])
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


# ------------------------------------------------------------------ sensitivity variants
_SECTIONS = ("RUNSPEC", "GRID", "EDIT", "PROPS", "REGIONS", "SOLUTION", "SUMMARY", "SCHEDULE")
_PROD_COL = {"ORAT": 4, "WRAT": 5, "GRAT": 6, "LRAT": 7, "RESV": 8, "BHP": 9}   # 1-based WCONPROD items
_INJ_COL = {"RATE": 5, "RESV": 6, "BHP": 7}                                       # 1-based WCONINJE items


def _kw_of(line):
    tok = line.split("--")[0].strip()
    return tok if tok and tok.replace("_", "").isalnum() and tok[0].isalpha() and tok.upper() == tok \
        and len(tok) <= 8 and "/" not in tok else None


def _expand_items(body):
    """Split a record body into items, expanding n* repeat counts."""
    out = []
    for tok in body.replace(",", " ").split():
        if "*" in tok and not tok.startswith(("'", '"')):
            n, _, v = tok.partition("*")
            out.extend([v or "1*"] * int(n or 1))
        else:
            out.append(tok)
    return out


def _set_well_item(line, item, value):
    code, sep, comment = line.partition("--")
    body, slash, rest = code.partition("/")
    items = _expand_items(body)
    while len(items) < item:
        items.append("1*")
    items[item - 1] = f"{value:g}"
    return "  " + " ".join(items) + " /" + rest.rstrip() + ((" --" + comment) if sep else "")


def make_variant(text, spec_json):
    """Return a modified deck for one sensitivity case, as JSON {ok, deck, changes} or {ok: False, error}.

    spec: {"kind": "multiply", "array": "PERMX", "value": 1.5}
              -> MULTIPLY record appended to the end of the GRID section (or the EDIT section for
                 PORV and TRAN*), so it acts on the array however it was defined;
          {"kind": "well", "well": "PROD", "target": "rate" | "bhp", "value": 1500}
              -> the rate target of the well's active control (or its BHP item) in every WCONPROD /
                 WCONINJE record for that well; '*' matches all wells;
          {"kind": "replace", "find": "@RATE@", "value": 1500}
              -> every occurrence of the token.
    """
    sp = json.loads(spec_json)
    kind = sp.get("kind")
    value = float(sp["value"])
    lines = text.split("\n")
    try:
        if kind == "multiply":
            arr = str(sp["array"]).upper()
            edit_arrays = arr == "PORV" or arr.startswith("TRAN")
            target_sec = "EDIT" if edit_arrays else "GRID"
            sec, insert_at, have_edit = None, None, False
            for i, ln in enumerate(lines):
                k = _kw_of(ln)
                if k in _SECTIONS:
                    if sec == target_sec and insert_at is None:
                        insert_at = i
                    if k == "EDIT":
                        have_edit = True
                    sec = k
            block = ["MULTIPLY", f"  {arr} {value:g} /", "/", ""]
            if insert_at is None and edit_arrays and not have_edit:
                # no EDIT section: create one before PROPS
                for i, ln in enumerate(lines):
                    if _kw_of(ln) == "PROPS":
                        insert_at = i
                        block = ["EDIT", ""] + block
                        break
            if insert_at is None:
                return json.dumps({"ok": False, "error": f"no {target_sec} section to add MULTIPLY {arr} to"})
            lines[insert_at:insert_at] = ["-- sensitivity variant"] + block
            return json.dumps({"ok": True, "deck": "\n".join(lines), "changes": 1})
        if kind == "well":
            well = str(sp["well"]).strip("'\"").upper()
            target = sp.get("target", "rate")
            changes, kw = 0, None
            for i, ln in enumerate(lines):
                k = _kw_of(ln)
                if k:
                    kw = k
                    continue
                code = ln.split("--")[0].strip()
                if kw not in ("WCONPROD", "WCONINJE") or not code:
                    continue
                if code.startswith("/"):
                    kw = None
                    continue
                items = _expand_items(code.partition("/")[0])
                if not items:
                    continue
                name = items[0].strip("'\"").upper()
                if not (well == "*" or name == well or (well.endswith("*") and name.startswith(well[:-1]))):
                    continue
                if kw == "WCONPROD":
                    ctrl = items[2].strip("'\"").upper() if len(items) > 2 else "ORAT"
                    col = _PROD_COL["BHP"] if target == "bhp" else _PROD_COL.get(ctrl)
                else:
                    ctrl = items[3].strip("'\"").upper() if len(items) > 3 else "RATE"
                    col = _INJ_COL["BHP"] if target == "bhp" else _INJ_COL.get(ctrl)
                if col is None or col == (_PROD_COL["BHP"] if kw == "WCONPROD" else _INJ_COL["BHP"]) and target == "rate":
                    continue                    # BHP-controlled well has no rate target to change
                lines[i] = _set_well_item(ln, col, value)
                changes += 1
            if not changes:
                return json.dumps({"ok": False, "error": f"no rate-controlled WCONPROD/WCONINJE record for well {well}"
                                   if target == "rate" else f"no WCONPROD/WCONINJE record for well {well}"})
            return json.dumps({"ok": True, "deck": "\n".join(lines), "changes": changes})
        if kind == "replace":
            find = str(sp["find"])
            n = text.count(find)
            if not find or not n:
                return json.dumps({"ok": False, "error": f"text {find!r} not found in the deck"})
            return json.dumps({"ok": True, "deck": text.replace(find, f"{value:g}"), "changes": n})
        return json.dumps({"ok": False, "error": f"unknown variant kind {kind!r}"})
    except Exception as exc:  # noqa: BLE001
        return json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"})
