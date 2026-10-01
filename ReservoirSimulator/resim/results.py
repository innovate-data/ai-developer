"""Simulation results container with NPZ persistence and CSV export.

All stored quantities are in the deck's unit system (FIELD or METRIC).

Layout
------
meta        dict: case, title, units, fluid_type, phases, start_date (ISO), component_names
nx, ny, nz  grid dimensions
corners     (N, 8, 3) float32 cell corner coordinates (x, y, depth) in deck length units;
            corner c = di + 2*dj + 4*dk
active      (N,) bool active-cell mask
static      dict name -> (N,) float32 arrays: PORO, PERMX, PERMY, PERMZ, NTG, DEPTH, PORV, DX, DY, DZ
report_times (nr,) float days since start (index 0 = initial state)
report_dates list[str] ISO dates
cell_data   dict name -> (nr, N) float32 dynamic arrays (NaN for inactive cells):
            PRESSURE, SWAT, SGAS, SOIL, RS (black oil); ZMF_<comp>, XMF/YMF..., DENO, DENG (compositional)
summary     dict key -> (nt,) float64 time series; 'TIME' (days) is always present.
            Field keys: FOPR FWPR FGPR FLPR FWIR FGIR FOPT FWPT FGPT FWIT FGIT FPR FWCT FGOR FOIP FGIP FWIP
            Well keys:  'WOPR:NAME' 'WWPR:NAME' 'WGPR:NAME' 'WWIR:NAME' 'WGIR:NAME' 'WBHP:NAME'
                        'WWCT:NAME' 'WGOR:NAME' 'WOPT:NAME' 'WWPT:NAME' 'WGPT:NAME' 'WWIT:NAME' 'WGIT:NAME'
wells       list of dicts: name, kind ('PROD'/'INJ'), i, j (0-based head), completions [(i,j,k), ...]
log         list[str] run log messages
"""
from __future__ import annotations

import csv
import json
from dataclasses import dataclass, field

import numpy as np

SUMMARY_UNITS = {
    "OPR": "liquid_surface_rate", "WPR": "liquid_surface_rate", "LPR": "liquid_surface_rate",
    "GPR": "gas_surface_rate", "WIR": "liquid_surface_rate", "GIR": "gas_surface_rate",
    "OPT": "liquid_surface_volume", "WPT": "liquid_surface_volume", "GPT": "gas_surface_volume",
    "WIT": "liquid_surface_volume", "GIT": "gas_surface_volume", "BHP": "pressure", "PR": "pressure",
    "OIP": "liquid_surface_volume", "GIP": "gas_surface_volume", "WIP": "liquid_surface_volume",
    "GOR": "rs", "GIPL": "gas_surface_volume", "GIPG": "gas_surface_volume", "GIPM": "gas_surface_volume",
    "GIPR": "gas_surface_volume", "CO2M": "mass", "OIPL": "liquid_surface_volume", "OIPG": "liquid_surface_volume",
    "TEMP": "temperature",
}


@dataclass
class Results:
    meta: dict = field(default_factory=dict)
    nx: int = 0
    ny: int = 0
    nz: int = 0
    corners: np.ndarray = None
    active: np.ndarray = None
    static: dict = field(default_factory=dict)
    report_times: list = field(default_factory=list)
    report_dates: list = field(default_factory=list)
    cell_data: dict = field(default_factory=dict)
    summary: dict = field(default_factory=dict)
    wells: list = field(default_factory=list)
    log: list = field(default_factory=list)

    # ------------------------------------------------------------------ helpers
    @property
    def n_reports(self):
        return len(self.report_times)

    def summary_keys(self):
        return [k for k in self.summary if k != "TIME"]

    def unit_label(self, key):
        """Unit string for a summary key (e.g. 'WOPR:PROD' -> 'stb/d')."""
        from .units import get_units
        u = get_units(self.meta.get("units", "METRIC"))
        base = key.split(":")[0]
        if base.endswith("WCT") or base == "FCO2D":
            return "fraction"
        for suffix, q in SUMMARY_UNITS.items():
            if base[1:] == suffix:
                return u.label(q)
        return ""

    def cell_property_names(self):
        return list(self.cell_data.keys()) + [k for k in self.static.keys()]

    def get_cell_array(self, name, report_index=0):
        if name in self.cell_data:
            return np.asarray(self.cell_data[name][report_index])
        return np.asarray(self.static[name])

    # ------------------------------------------------------------------ IO
    def save(self, path):
        arrays = {
            "corners": np.asarray(self.corners, np.float32),
            "active": np.asarray(self.active, bool),
            "report_times": np.asarray(self.report_times, float),
        }
        for k, v in self.static.items():
            arrays["static__" + k] = np.asarray(v, np.float32)
        for k, v in self.cell_data.items():
            arrays["cell__" + k] = np.asarray(v, np.float32)
        for k, v in self.summary.items():
            arrays["summary__" + k] = np.asarray(v, float)
        header = {"meta": self.meta, "dims": [self.nx, self.ny, self.nz], "report_dates": list(self.report_dates),
                  "wells": self.wells, "log": self.log[-5000:]}
        arrays["header"] = np.frombuffer(json.dumps(header).encode(), dtype=np.uint8)
        np.savez_compressed(path, **arrays)

    @classmethod
    def load(cls, path):
        data = np.load(path, allow_pickle=False)
        header = json.loads(bytes(data["header"]).decode())
        r = cls()
        r.meta = header["meta"]
        r.nx, r.ny, r.nz = header["dims"]
        r.report_dates = header["report_dates"]
        r.wells = header["wells"]
        r.log = header.get("log", [])
        r.corners = data["corners"]
        r.active = data["active"]
        r.report_times = data["report_times"]
        for key in data.files:
            if key.startswith("static__"):
                r.static[key[8:]] = data[key]
            elif key.startswith("cell__"):
                r.cell_data[key[6:]] = data[key]
            elif key.startswith("summary__"):
                r.summary[key[9:]] = data[key]
        return r

    def summary_to_csv(self, path, keys=None):
        keys = keys or self.summary_keys()
        with open(path, "w", newline="") as fh:
            w = csv.writer(fh)
            w.writerow(["TIME"] + keys)
            w.writerow(["days"] + [self.unit_label(k) for k in keys])
            for i, t in enumerate(self.summary["TIME"]):
                w.writerow([f"{t:.6g}"] + [f"{self.summary[k][i]:.8g}" for k in keys])
