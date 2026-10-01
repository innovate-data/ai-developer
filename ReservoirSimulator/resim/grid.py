"""Grid geometry: block-centred Cartesian and corner-point (COORD/ZCORN) grids.

All arrays follow ECLIPSE natural ordering (I fastest, then J, then K) and are
stored as flat vectors of length ``nx*ny*nz``.  Depth (z) is positive downward.

Cell corners are numbered ``c = di + 2*dj + 4*dk`` (di, dj, dk in {0, 1}).
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

# Faces as cyclic corner lists
FACE_CORNERS = {
    "I-": (0, 2, 6, 4), "I+": (1, 3, 7, 5),
    "J-": (0, 1, 5, 4), "J+": (2, 3, 7, 6),
    "K-": (0, 1, 3, 2), "K+": (4, 5, 7, 6),
}
_TETS = ((0, 1, 3, 7), (0, 1, 5, 7), (0, 2, 3, 7), (0, 2, 6, 7), (0, 4, 5, 7), (0, 4, 6, 7))


def cartesian_corners(nx, ny, nz, dx, dy, dz, tops):
    """Corners (N, 8, 3) of a block-centred grid.

    dx, dy, dz: arrays of length N; tops: length N (or nx*ny for the top layer only).
    """
    n = nx * ny * nz
    dx = np.broadcast_to(np.asarray(dx, float), (n,)).reshape((nx, ny, nz), order="F")
    dy = np.broadcast_to(np.asarray(dy, float), (n,)).reshape((nx, ny, nz), order="F")
    dz = np.broadcast_to(np.asarray(dz, float), (n,)).reshape((nx, ny, nz), order="F")
    tops = np.asarray(tops, float)
    if tops.size == nx * ny:
        t = np.empty((nx, ny, nz))
        t[:, :, 0] = tops.reshape((nx, ny), order="F")
        for k in range(1, nz):
            t[:, :, k] = t[:, :, k - 1] + dz[:, :, k - 1]
    elif tops.size == n:
        t = tops.reshape((nx, ny, nz), order="F")
    else:
        t = np.broadcast_to(tops.ravel()[0], (nx, ny, nz)).copy()
        for k in range(1, nz):
            t[:, :, k] = t[:, :, k - 1] + dz[:, :, k - 1]
    x0 = np.concatenate([np.zeros((1, ny, nz)), np.cumsum(dx, axis=0)[:-1]], axis=0)
    y0 = np.concatenate([np.zeros((nx, 1, nz)), np.cumsum(dy, axis=1)[:, :-1]], axis=1)
    corners = np.empty((nx, ny, nz, 8, 3))
    for c in range(8):
        di, dj, dk = c & 1, (c >> 1) & 1, (c >> 2) & 1
        corners[..., c, 0] = x0 + di * dx
        corners[..., c, 1] = y0 + dj * dy
        corners[..., c, 2] = t + dk * dz
    return corners.transpose(3, 4, 0, 1, 2).reshape(8, 3, n, order="F").transpose(2, 0, 1).copy()


def corner_point_corners(nx, ny, nz, coord, zcorn):
    """Corners (N, 8, 3) from COORD / ZCORN."""
    coord = np.asarray(coord, float).reshape((ny + 1, nx + 1, 6))  # pillars, i fastest
    z = np.asarray(zcorn, float).reshape((2 * nz, 2 * ny, 2 * nx))  # F order reversed
    n = nx * ny * nz
    corners = np.empty((nx, ny, nz, 8, 3))
    ii, jj, kk = np.meshgrid(np.arange(nx), np.arange(ny), np.arange(nz), indexing="ij")
    for c in range(8):
        di, dj, dk = c & 1, (c >> 1) & 1, (c >> 2) & 1
        zc = z[2 * kk + dk, 2 * jj + dj, 2 * ii + di]
        p = coord[jj + dj, ii + di]
        xt, yt, zt, xb, yb, zb = (p[..., m] for m in range(6))
        dzp = zb - zt
        with np.errstate(divide="ignore", invalid="ignore"):
            t = np.where(np.abs(dzp) > 1e-12, (zc - zt) / dzp, 0.0)
        corners[..., c, 0] = xt + t * (xb - xt)
        corners[..., c, 1] = yt + t * (yb - yt)
        corners[..., c, 2] = zc
    return corners.transpose(3, 4, 0, 1, 2).reshape(8, 3, n, order="F").transpose(2, 0, 1).copy()


def hex_volume(corners):
    v = np.zeros(corners.shape[0])
    for a, b, c, d in _TETS:
        pa = corners[:, a]
        v += np.abs(np.einsum("ij,ij->i", corners[:, b] - pa, np.cross(corners[:, c] - pa, corners[:, d] - pa))) / 6.0
    return v


def face_geometry(corners, face):
    idx = FACE_CORNERS[face]
    p = corners[:, idx]
    center = p.mean(axis=1)
    area = 0.5 * np.cross(p[:, 2] - p[:, 0], p[:, 3] - p[:, 1])
    return center, area


@dataclass
class Grid:
    nx: int
    ny: int
    nz: int
    corners: np.ndarray                     # (N, 8, 3)
    actnum: np.ndarray = None               # (N,) int
    is_corner_point: bool = False
    # derived
    volume: np.ndarray = field(init=False, default=None)
    center: np.ndarray = field(init=False, default=None)

    def __post_init__(self):
        n = self.n_cells
        if self.actnum is None:
            self.actnum = np.ones(n, dtype=int)
        self.volume = hex_volume(self.corners)
        self.center = self.corners.mean(axis=1)

    @property
    def n_cells(self):
        return self.nx * self.ny * self.nz

    @property
    def shape(self):
        return (self.nx, self.ny, self.nz)

    @property
    def depth(self):
        return self.center[:, 2]

    def index(self, i, j, k):
        """0-based natural index from 0-based i, j, k."""
        return i + self.nx * (j + self.ny * k)

    def ijk(self, idx):
        idx = np.asarray(idx)
        i = idx % self.nx
        j = (idx // self.nx) % self.ny
        k = idx // (self.nx * self.ny)
        return i, j, k

    def cell_dims(self):
        """Approximate cell sizes (dx, dy, dz) used for well indices (cached)."""
        if getattr(self, "_dims", None) is not None:
            return self._dims
        c = self.corners
        dx = np.linalg.norm(c[:, FACE_CORNERS["I+"], :].mean(1) - c[:, FACE_CORNERS["I-"], :].mean(1), axis=1)
        dy = np.linalg.norm(c[:, FACE_CORNERS["J+"], :].mean(1) - c[:, FACE_CORNERS["J-"], :].mean(1), axis=1)
        dz = c[:, FACE_CORNERS["K+"], 2].mean(1) - c[:, FACE_CORNERS["K-"], 2].mean(1)
        self._dims = (dx, dy, np.abs(dz))
        return self._dims

    def half_trans(self, face, perm):
        """Half transmissibility k*|A.c|/|c|^2 for a given face (SI, m3)."""
        fc, area = face_geometry(self.corners, face)
        cvec = fc - self.center
        num = np.abs(np.einsum("ij,ij->i", area, cvec))
        den = np.einsum("ij,ij->i", cvec, cvec)
        with np.errstate(divide="ignore", invalid="ignore"):
            return np.where(den > 0, perm * num / den, 0.0)

    def neighbour_pairs(self, direction):
        """All (cell, neighbour) natural-index pairs in direction 'I', 'J' or 'K'."""
        nx, ny, nz = self.shape
        idx = np.arange(self.n_cells).reshape((nx, ny, nz), order="F")
        if direction == "I":
            a, b = idx[:-1, :, :], idx[1:, :, :]
        elif direction == "J":
            a, b = idx[:, :-1, :], idx[:, 1:, :]
        else:
            a, b = idx[:, :, :-1], idx[:, :, 1:]
        return a.ravel(order="F"), b.ravel(order="F")
