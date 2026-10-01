"""Well connection geometry: Peaceman well indices and perforation tables."""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass
class PerforationSet:
    """Flattened perforations of all wells for vectorised well equations."""
    names: list
    cell: np.ndarray          # active cell index per perforation
    well: np.ndarray          # well index per perforation
    wi: np.ndarray            # well index (m3), 0 for shut connections
    depth: np.ndarray         # perforation depth
    ref_depth: np.ndarray     # per well
    n_wells: int

    def sum_matrix(self):
        import scipy.sparse as sp
        n = self.cell.size
        return sp.csr_matrix((np.ones(n), (self.well, np.arange(n))), shape=(self.n_wells, n))


def peaceman_wi(model, comp):
    """Connection transmissibility factor (SI) for one completion."""
    g = model.grid
    idx = g.index(comp.i, comp.j, comp.k)
    if comp.cf is not None:
        return comp.cf
    kx, ky, kz = (k[idx] for k in model.perm)
    dxs, dys, dzs = g.cell_dims()
    dx, dy, dz = dxs[idx], dys[idx], dzs[idx]
    ntg = model.ntg[idx]
    if comp.direction == "X":
        k1, k2, d1, d2, h = ky, kz, dy, dz, dx
    elif comp.direction == "Y":
        k1, k2, d1, d2, h = kx, kz, dx, dz, dy
    else:
        k1, k2, d1, d2, h = kx, ky, dx, dy, dz * ntg
    if k1 <= 0 or k2 <= 0:
        return 0.0
    r21 = k2 / k1
    r0 = comp.r0 or 0.28 * np.sqrt(np.sqrt(r21) * d1 ** 2 + np.sqrt(1 / r21) * d2 ** 2) / (r21 ** 0.25 + r21 ** -0.25)
    kh = comp.kh if comp.kh is not None else np.sqrt(k1 * k2) * h
    rw = 0.5 * comp.diameter
    denom = np.log(r0 / rw) + comp.skin
    if denom <= 0:
        denom = 1e-3
    return 2.0 * np.pi * kh / denom


def build_perforations(model, wells: dict, warn=None) -> PerforationSet:
    names = list(wells.keys())
    cells, widx, wis, depths, refs = [], [], [], [], []
    for w_i, name in enumerate(names):
        w = wells[name]
        first_depth = None
        for c in w.completions:
            if not (0 <= c.i < model.grid.nx and 0 <= c.j < model.grid.ny and 0 <= c.k < model.grid.nz):
                if warn:
                    warn(f"Well {name}: connection ({c.i + 1},{c.j + 1},{c.k + 1}) outside grid")
                continue
            gidx = model.grid.index(c.i, c.j, c.k)
            a = model.global_to_active[gidx]
            if a < 0:
                if warn:
                    warn(f"Well {name}: connection ({c.i + 1},{c.j + 1},{c.k + 1}) in inactive cell ignored")
                continue
            if c.wi == 0.0:
                c.wi = peaceman_wi(model, c)
            c.cell = a
            cells.append(a)
            widx.append(w_i)
            wis.append(c.wi if c.status == "OPEN" else 0.0)
            depths.append(model.depth[a])
            if first_depth is None:
                first_depth = model.depth[a]
        ref = w.ref_depth if w.ref_depth is not None else (first_depth if first_depth is not None else 0.0)
        refs.append(ref)
    return PerforationSet(names, np.array(cells, int), np.array(widx, int), np.array(wis, float),
                          np.array(depths, float), np.array(refs, float), len(names))
