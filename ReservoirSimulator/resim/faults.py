"""Corner-point fault geometry: face overlaps across displaced columns, PINCH connections
and fault-name bookkeeping (FAULTS / MULTFLT).

In a corner-point grid two neighbouring columns share a pair of pillars.  Where the
ZCORN depths on the two sides of that pillar pair differ (a fault throw), a cell can
touch several cells of the neighbouring column.  For every such column interface the
overlap of each pair of faces (k on one side, k' on the other) is computed exactly in
the plane spanned by the two pillars: each face is the region between its top and
bottom edges, both straight lines in (t, z) where t runs from one pillar to the other.
The overlap is a convex polygon in (t, z); it is mapped to 3D on the pillars and its
vector area enters the usual two-point transmissibility.
"""
from __future__ import annotations

import numpy as np

# corner numbers of the faces touching the shared pillar pair, as (top A, top B, bottom A, bottom B)
_IFACE = {"low": (1, 3, 5, 7), "high": (0, 2, 4, 6)}      # I+ face of cell i, I- face of cell i+1
_JFACE = {"low": (2, 3, 6, 7), "high": (0, 1, 4, 5)}      # J+ face of cell j, J- face of cell j+1


def _pillar_point(pil, z):
    """Point on pillar lines `pil` (..., 6: xt yt zt xb yb zb) at depth z (...)."""
    xt, yt, zt, xb, yb, zb = (pil[..., m] for m in range(6))
    dz = zb - zt
    with np.errstate(divide="ignore", invalid="ignore"):
        s = np.where(np.abs(dz) > 1e-12, (z - zt) / dz, 0.0)
    return np.stack([xt + s * (xb - xt), yt + s * (yb - yt), z], axis=-1)


def _overlap_area(zl, zr, pa, pb):
    """Vector areas of the overlaps of face pairs.

    zl, zr: (P, 4) depths (top A, top B, bottom A, bottom B) of the two faces;
    pa, pb: (P, 6) pillar lines A and B.  Returns (P, 3) vector areas (zero if no overlap)
    and the overlap thickness integral (P,) used to discard touching-only pairs.
    """
    P = zl.shape[0]
    tl0, tl1, bl0, bl1 = zl.T
    tr0, tr1, br0, br1 = zr.T

    def cross_t(a0, a1, b0, b1):
        d = (a0 - b0) - (a1 - b1)
        with np.errstate(divide="ignore", invalid="ignore"):
            t = np.where(np.abs(d) > 1e-12, (a0 - b0) / d, -1.0)
        return t
    cand = np.stack([np.zeros(P), np.ones(P), cross_t(tl0, tl1, tr0, tr1), cross_t(bl0, bl1, br0, br1),
                     cross_t(bl0, bl1, tr0, tr1), cross_t(br0, br1, tl0, tl1)], axis=1)
    cand = np.where((cand >= 0) & (cand <= 1), cand, np.nan)
    cand = np.sort(cand, axis=1)                         # NaNs last
    cand = np.where(np.isnan(cand), cand[:, [0]], cand)   # pad with t=0 (zero-width pieces)
    cand = np.sort(cand, axis=1)
    lin = lambda a0, a1, t: a0[:, None] + (a1 - a0)[:, None] * t
    upper = np.minimum(lin(bl0, bl1, cand), lin(br0, br1, cand))
    lower = np.maximum(lin(tl0, tl1, cand), lin(tr0, tr1, cand))
    h = np.maximum(upper - lower, 0.0)
    upper = lower + h                                     # collapse where there is no overlap
    # thickness integral (trapezoid; exact for piecewise-linear h)
    thick = np.sum(0.5 * (h[:, 1:] + h[:, :-1]) * np.diff(cand, axis=1), axis=1)
    # polygon: lower boundary forwards, upper boundary backwards, in 3D
    ts = np.concatenate([cand, cand[:, ::-1]], axis=1)
    zs = np.concatenate([lower, upper[:, ::-1]], axis=1)
    A = _pillar_point(pa[:, None, :], zs)
    B = _pillar_point(pb[:, None, :], zs)
    X = A + (B - A) * ts[..., None]
    area = 0.5 * np.sum(np.cross(X, np.roll(X, -1, axis=1)), axis=1)
    return area, thick


def fault_overlaps(grid, pillars, direction, tol=1e-6):
    """Face overlaps across faulted column interfaces in direction 'I' or 'J'.

    Returns (faulted, a, b, area): `faulted` is a boolean array over the natural cell index
    marking cells whose logical +direction neighbour connection is replaced; (a, b, area) are
    the overlapping cell pairs (natural indices, a on the low side) and their vector areas.
    """
    nx, ny, nz = grid.shape
    C = grid.corners
    cidx = np.arange(grid.n_cells).reshape((nx, ny, nz), order="F")
    faces = _IFACE if direction == "I" else _JFACE
    if direction == "I":
        lo, hi = cidx[:-1, :, :], cidx[1:, :, :]
        pa_ij = lambda i, j: (i + 1, j)
        pb_ij = lambda i, j: (i + 1, j + 1)
    else:
        lo, hi = cidx[:, :-1, :], cidx[:, 1:, :]
        pa_ij = lambda i, j: (i, j + 1)
        pb_ij = lambda i, j: (i + 1, j + 1)
    zl = C[lo][..., list(faces["low"]), 2]                # (ni, nj, nz, 4)
    zr = C[hi][..., list(faces["high"]), 2]
    scale = max(1.0, float(np.nanmax(np.abs(C[..., 2]))))
    mism = np.any(np.abs(zl - zr) > tol * scale, axis=(2, 3))    # (ni, nj) faulted columns
    faulted = np.zeros(grid.n_cells, bool)
    out_a, out_b, out_A = [], [], []
    for ci, cj in zip(*np.nonzero(mism)):
        faulted[lo[ci, cj, :]] = True
        kk, kp = np.meshgrid(np.arange(nz), np.arange(nz), indexing="ij")
        kk, kp = kk.ravel(), kp.ravel()
        zL = zl[ci, cj][kk]
        zR = zr[ci, cj][kp]
        # quick reject: depth ranges that do not overlap
        ok = (np.minimum(zL[:, 2:].max(1), zR[:, 2:].max(1)) > np.maximum(zL[:, :2].min(1), zR[:, :2].min(1)))
        if not ok.any():
            continue
        kk, kp, zL, zR = kk[ok], kp[ok], zL[ok], zR[ok]
        pa = np.broadcast_to(pillars[pa_ij(ci, cj)], (kk.size, 6))
        pb = np.broadcast_to(pillars[pb_ij(ci, cj)], (kk.size, 6))
        area, thick = _overlap_area(zL, zR, pa, pb)
        keep = thick > 1e-9 * scale
        out_a.append(lo[ci, cj, kk[keep]])
        out_b.append(hi[ci, cj, kp[keep]])
        out_A.append(area[keep])
    if out_a:
        return faulted, np.concatenate(out_a), np.concatenate(out_b), np.concatenate(out_A)
    return faulted, np.zeros(0, int), np.zeros(0, int), np.zeros((0, 3))


def half_trans_area(grid, cells, face, area, perm):
    """Half transmissibilities perm * |A.d| / |d|^2 of `cells` through vector area `area`,
    with d from the cell centre to the centre of the cell's full face (ECLIPSE NEWTRAN)."""
    from .grid import FACE_CORNERS
    fc = grid.corners[cells][:, list(FACE_CORNERS[face])].mean(axis=1)
    d = fc - grid.center[cells]
    num = np.abs(np.einsum("ij,ij->i", area, d))
    den = np.einsum("ij,ij->i", d, d)
    with np.errstate(divide="ignore", invalid="ignore"):
        return np.where(den > 0, perm[cells] * num / den, 0.0)


def pinch_connections(grid, active, bridgeable, thickness, max_gap=1e20):
    """Vertical PINCH connections between active cells separated by inactive cells.

    A pair (upper, lower) in one column is connected when every cell between them is
    inactive and `bridgeable` (thinner than the PINCH threshold, or - with the GAP option -
    removed by MINPV), and their total thickness does not exceed `max_gap`.
    Returns arrays (upper cell, lower cell) of natural indices.
    """
    nx, ny, nz = grid.shape
    idx = np.arange(grid.n_cells).reshape((nx, ny, nz), order="F")
    act = active.reshape((nx, ny, nz), order="F")
    brd = bridgeable.reshape((nx, ny, nz), order="F")
    th = thickness.reshape((nx, ny, nz), order="F")
    ups, downs = [], []
    for k in range(nz - 2):
        start = act[:, :, k] & ~act[:, :, k + 1] & brd[:, :, k + 1]
        for i, j in zip(*np.nonzero(start)):
            tot = 0.0
            for k2 in range(k + 1, nz):
                if act[i, j, k2]:
                    if tot <= max_gap:
                        ups.append(idx[i, j, k])
                        downs.append(idx[i, j, k2])
                    break
                if not brd[i, j, k2]:
                    break
                tot += th[i, j, k2]
    return np.array(ups, int), np.array(downs, int)
