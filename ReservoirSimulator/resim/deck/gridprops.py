"""Processing of GRID / EDIT / REGIONS / SOLUTION array keywords including
BOX, EQUALS, MULTIPLY, ADD, COPY, MINVALUE, MAXVALUE operators."""
from __future__ import annotations

import numpy as np

from .parser import rec_get, to_float, to_int

INT_ARRAYS = {"ACTNUM", "SATNUM", "PVTNUM", "EQLNUM", "FIPNUM", "ROCKNUM", "IMBNUM", "MULTNUM", "FLUXNUM", "OPERNUM"}

DEFAULTS = {
    "NTG": 1.0, "ACTNUM": 1, "MULTX": 1.0, "MULTY": 1.0, "MULTZ": 1.0, "MULTPV": 1.0,
    "SATNUM": 1, "PVTNUM": 1, "EQLNUM": 1, "FIPNUM": 1, "ROCKNUM": 1,
}

# arrays handled by the property processor
OPERABLE = {
    "DX", "DY", "DZ", "TOPS", "PERMX", "PERMY", "PERMZ", "PORO", "NTG", "ACTNUM", "MULTX", "MULTY",
    "MULTZ", "MULTPV", "PORV", "SATNUM", "PVTNUM", "EQLNUM", "FIPNUM", "ROCKNUM", "IMBNUM",
    "PRESSURE", "SWAT", "SGAS", "RS", "RV", "PBUB", "TRANX", "TRANY", "TRANZ", "SWATINIT",
    "TEMPI", "ZMF", "SWL", "SWCR", "SWU", "SGL", "SGCR", "SGU", "DEPTH", "MULTNUM", "FLUXNUM",
}


class GridProperties:
    def __init__(self, nx, ny, nz, warn):
        self.nx, self.ny, self.nz = nx, ny, nz
        self.n = nx * ny * nz
        self.arrays: dict = {}
        self.box = None
        self.warn = warn

    # ------------------------------------------------------------------ helpers
    def full_box(self):
        return (0, self.nx - 1, 0, self.ny - 1, 0, self.nz - 1)

    def current_box(self):
        return self.box or self.full_box()

    def box_indices(self, box):
        i1, i2, j1, j2, k1, k2 = box
        ii, jj, kk = np.meshgrid(np.arange(i1, i2 + 1), np.arange(j1, j2 + 1), np.arange(k1, k2 + 1), indexing="ij")
        return (ii + self.nx * (jj + self.ny * kk)).ravel(order="F")

    def _parse_box(self, rec, start):
        cur = self.current_box()
        vals = []
        for m in range(6):
            v = rec_get(rec, start + m)
            vals.append(cur[m] if v is None else to_int(v) - 1)
        return tuple(vals)

    def get(self, name, default=None):
        if name in self.arrays:
            return self.arrays[name]
        if default is not None:
            return default
        if name in DEFAULTS:
            return np.full(self.n, DEFAULTS[name], dtype=int if name in INT_ARRAYS else float)
        return None

    def has(self, name):
        return name in self.arrays

    def _ensure(self, name):
        if name not in self.arrays:
            if name in DEFAULTS:
                self.arrays[name] = np.full(self.n, DEFAULTS[name], dtype=float)
            else:
                self.arrays[name] = np.full(self.n, np.nan)
        return self.arrays[name]

    # ------------------------------------------------------------------ keywords
    def process(self, kw):
        name, data = kw.name, kw.data
        if name == "BOX":
            rec = data[0]
            self.box = tuple(to_int(rec_get(rec, m)) - 1 for m in range(6))
            return True
        if name == "ENDBOX":
            self.box = None
            return True
        if name in ("DXV", "DYV", "DZV"):
            v = np.asarray(data, float)
            if name == "DXV":
                self.arrays["DX"] = np.tile(v, self.ny * self.nz)
            elif name == "DYV":
                self.arrays["DY"] = np.tile(np.repeat(v, self.nx), self.nz)
            else:
                self.arrays["DZ"] = np.repeat(v, self.nx * self.ny)
            return True
        if name in ("EQUALS", "MULTIPLY", "ADD", "MINVALUE", "MAXVALUE"):
            for rec in data:
                if not rec:
                    continue
                target = str(rec[0]).upper()
                value = to_float(rec_get(rec, 1), 0.0)
                idx = self.box_indices(self._parse_box(rec, 2))
                arr = self._ensure(target)
                if name == "EQUALS":
                    arr[idx] = value
                elif name == "MULTIPLY":
                    arr[idx] *= value
                elif name == "ADD":
                    arr[idx] += value
                elif name == "MINVALUE":
                    arr[idx] = np.maximum(arr[idx], value)
                else:
                    arr[idx] = np.minimum(arr[idx], value)
            return True
        if name == "COPY":
            for rec in data:
                if not rec:
                    continue
                src, dst = str(rec[0]).upper(), str(rec[1]).upper()
                idx = self.box_indices(self._parse_box(rec, 2))
                s = self.get(src)
                if s is None:
                    self.warn(f"COPY: source array {src} not defined")
                    continue
                self._ensure(dst)[idx] = s[idx]
            return True
        if name in OPERABLE and isinstance(data, np.ndarray):
            vals = np.asarray(data, float)
            if self.box is not None:
                idx = self.box_indices(self.box)
                if vals.size != idx.size:
                    self.warn(f"{name}: {vals.size} values given for BOX of {idx.size} cells")
                    vals = np.resize(vals, idx.size)
                self._ensure(name)[idx] = vals
            elif name == "TOPS" and vals.size == self.nx * self.ny:
                arr = self._ensure("TOPS")
                arr[: vals.size] = vals
            elif vals.size == self.n:
                self.arrays[name] = vals.copy()
            else:
                self.warn(f"{name}: expected {self.n} values, got {vals.size}")
                self.arrays[name] = np.resize(vals, self.n) if vals.size else np.full(self.n, np.nan)
            return True
        return False
