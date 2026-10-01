"""Well control switching between rate targets and BHP limits."""
from __future__ import annotations

import numpy as np

PROD_KEYS = ("ORAT", "WRAT", "GRAT", "LRAT", "RESV")
MAX_SWITCHES = 4


def _value(x):
    return x.val if hasattr(x, "val") else np.asarray(x, float)


def check_controls(solver, rate, bhp):
    """Switch controls of wells violating their constraints. Returns True if any changed.

    `rate` holds per-well surface rates keyed 'o', 'w', 'g', 'resv' (production positive).
    """
    changed = False
    counts = solver.__dict__.setdefault("_switch_count", {})
    names = solver.perf.names
    r = {k: _value(v) for k, v in rate.items()}
    for wi, name in enumerate(names):
        w = solver.wells[name]
        if not w.is_open or counts.get(name, 0) >= MAX_SWITCHES:
            continue
        ctrl = solver.controls[name]
        t = w.targets
        new = None
        if w.kind == "PROD":
            vals = {"ORAT": r.get("o", np.zeros(len(names)))[wi], "WRAT": r.get("w", np.zeros(len(names)))[wi],
                    "GRAT": r.get("g", np.zeros(len(names)))[wi], "RESV": r.get("resv", np.zeros(len(names)))[wi]}
            vals["LRAT"] = vals["ORAT"] + vals["WRAT"]
            if w.history:
                orig = solver.orig_controls.get(name, ctrl)
                keys = (orig,) if orig != "BHP" else ()
            else:
                keys = [k for k in PROD_KEYS if k in t and t[k] is not None]
            thp_b = getattr(solver, "thp_bhp", {}).get(name) if getattr(w, "thp_limit", 0) else None
            if ctrl != "BHP" and bhp[wi] < t.get("BHP", 0.0) * (1 - 1e-9):
                new = "BHP"
            elif ctrl not in ("BHP", "THP") and thp_b is not None and bhp[wi] < thp_b * (1 - 1e-9):
                new = "THP"
            elif ctrl == "BHP" and thp_b is not None and thp_b > t.get("BHP", 0.0) * (1 + 1e-9):
                new = "THP"
            else:
                worst, ratio = None, 1.0 + 1e-6
                for k in keys:
                    if k == ctrl or t.get(k) is None:
                        continue
                    lim = t[k]
                    if lim > 0 and vals[k] / lim > ratio:
                        worst, ratio = k, vals[k] / lim
                new = worst
        else:
            key = {"WATER": "w", "GAS": "g", "OIL": "o"}.get(w.inj_type, "w")
            vals = {"RATE": -r.get(key, np.zeros(len(names)))[wi], "RESV": -r.get("resv", np.zeros(len(names)))[wi]}
            thp_b = getattr(solver, "thp_bhp", {}).get(name) if getattr(w, "thp_limit", 0) else None
            if ctrl != "BHP" and bhp[wi] > t.get("BHP", 1e30) * (1 + 1e-9):
                new = "BHP"
            elif ctrl not in ("BHP", "THP") and thp_b is not None and bhp[wi] > thp_b * (1 + 1e-9):
                new = "THP"
            elif ctrl == "BHP" and thp_b is not None and thp_b < t.get("BHP", 1e30) * (1 - 1e-9):
                new = "THP"
            else:
                worst, ratio = None, 1.0 + 1e-6
                for k in ("RATE", "RESV"):
                    if k == ctrl or t.get(k) is None:
                        continue
                    lim = t[k]
                    if lim > 0 and vals[k] / lim > ratio:
                        worst, ratio = k, vals[k] / lim
                new = worst
        if new and new != ctrl:
            solver.controls[name] = new
            counts[name] = counts.get(name, 0) + 1
            changed = True
    return changed
