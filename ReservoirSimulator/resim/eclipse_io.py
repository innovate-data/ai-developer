"""Write results in ECLIPSE binary format (unified, unformatted, big-endian):

    CASE.EGRID   corner-point grid (COORD/ZCORN/ACTNUM)
    CASE.INIT    static properties (PORV, PORO, PERMX/Y/Z, NTG, DX/DY/DZ, DEPTH)
    CASE.UNRST   restart arrays per report step (PRESSURE, SWAT, SGAS, RS / ZMF...)
    CASE.SMSPEC  summary specification
    CASE.UNSMRY  summary data (one ministep per simulator time step)

so that results can be opened in ResInsight and other ECLIPSE post-processors.
"""
from __future__ import annotations

import os
from datetime import datetime

import numpy as np

_DTYPES = {"INTE": ">i4", "REAL": ">f4", "DOUB": ">f8", "LOGI": ">i4"}
_BLOCK = {"INTE": 1000, "REAL": 1000, "DOUB": 1000, "LOGI": 1000, "CHAR": 105}


class _Writer:
    def __init__(self, path):
        self.fh = open(path, "wb")

    def _record(self, payload: bytes):
        n = np.array([len(payload)], ">i4").tobytes()
        self.fh.write(n + payload + n)

    def kw(self, name, kind, data=()):
        if kind == "CHAR":
            items = [f"{str(s):<8.8s}".encode("ascii", "replace") for s in data]
        elif kind == "MESS":
            items = []
        else:
            items = np.asarray(data, _DTYPES[kind]).ravel()
        count = len(items)
        self._record(f"{name:<8.8s}".encode() + np.array([count], ">i4").tobytes() + kind.encode())
        if kind == "MESS" or count == 0:
            return
        blk = _BLOCK[kind]
        for s in range(0, count, blk):
            chunk = items[s:s + blk]
            self._record(b"".join(chunk) if kind == "CHAR" else chunk.tobytes())

    def close(self):
        self.fh.close()


def _coord_zcorn(res):
    nx, ny, nz = res.nx, res.ny, res.nz
    c = np.asarray(res.corners, float).reshape((nz, ny, nx, 8, 3))   # natural ordering, i fastest
    coord = np.zeros((ny + 1, nx + 1, 6))
    for j in range(ny + 1):
        for i in range(nx + 1):
            ci, di = (i, 0) if i < nx else (nx - 1, 1)
            cj, dj = (j, 0) if j < ny else (ny - 1, 1)
            top = c[0, cj, ci, di + 2 * dj]
            bot = c[nz - 1, cj, ci, di + 2 * dj + 4]
            coord[j, i, :3] = top
            coord[j, i, 3:] = bot
    z = np.zeros((2 * nz, 2 * ny, 2 * nx))
    for corner in range(8):
        di, dj, dk = corner & 1, (corner >> 1) & 1, (corner >> 2) & 1
        z[dk::2, dj::2, di::2] = c[:, :, :, corner, 2]
    return coord.ravel(), z.ravel()


def _date(res, days):
    from datetime import timedelta
    start = datetime.fromisoformat(res.meta["start_date"])
    return start + timedelta(days=float(days))


def _intehead(res, days):
    ih = np.zeros(411, int)
    d = _date(res, days)
    ih[2] = 2 if res.meta.get("units") == "FIELD" else 1
    ih[8], ih[9], ih[10] = res.nx, res.ny, res.nz
    ih[11] = int(np.count_nonzero(res.active))
    ph = res.meta.get("phases", {})
    ih[14] = (1 if ph.get("oil") else 0) + (2 if ph.get("water") else 0) + (4 if ph.get("gas") else 0)
    ih[64], ih[65], ih[66] = d.day, d.month, d.year
    ih[94] = 300 if res.meta.get("fluid_type") == "compositional" else 100
    ih[206], ih[207], ih[208] = d.hour, d.minute, d.second * 1000000
    return ih


def write_eclipse(res, base_path):
    """Write EGRID/INIT/UNRST/SMSPEC/UNSMRY files; base_path without extension."""
    act = np.asarray(res.active, bool)
    n_act = int(act.sum())
    units_field = res.meta.get("units") == "FIELD"
    files = []

    # ---------------- EGRID
    coord, zcorn = _coord_zcorn(res)
    path = base_path + ".EGRID"
    w = _Writer(path)
    fh = np.zeros(100, int)
    fh[0], fh[1] = 3, 2007
    w.kw("FILEHEAD", "INTE", fh)
    w.kw("GRIDUNIT", "CHAR", ["FEET" if units_field else "METRES", ""])
    gh = np.zeros(100, int)
    gh[0], gh[1], gh[2], gh[3], gh[24] = 1, res.nx, res.ny, res.nz, 0
    w.kw("GRIDHEAD", "INTE", gh)
    w.kw("COORD", "REAL", coord)
    w.kw("ZCORN", "REAL", zcorn)
    w.kw("ACTNUM", "INTE", act.astype(int))
    w.kw("ENDGRID", "INTE", [])
    w.close()
    files.append(path)

    # ---------------- INIT
    path = base_path + ".INIT"
    w = _Writer(path)
    w.kw("INTEHEAD", "INTE", _intehead(res, 0.0))
    w.kw("LOGIHEAD", "LOGI", np.zeros(121, int))
    w.kw("DOUBHEAD", "DOUB", np.zeros(229))
    st = res.static
    w.kw("PORV", "REAL", np.nan_to_num(st.get("PORV", np.zeros(act.size))))
    for name in ("DEPTH", "DX", "DY", "DZ", "PERMX", "PERMY", "PERMZ", "PORO", "NTG", "SATNUM", "PVTNUM"):
        if name in st:
            vals = np.nan_to_num(np.asarray(st[name])[act])
            if name in ("SATNUM", "PVTNUM"):
                w.kw(name, "INTE", np.rint(vals).astype(int))
            else:
                w.kw(name, "REAL", vals)
    w.close()
    files.append(path)

    # ---------------- UNRST
    path = base_path + ".UNRST"
    w = _Writer(path)
    for r, days in enumerate(res.report_times):
        w.kw("SEQNUM", "INTE", [r])
        w.kw("INTEHEAD", "INTE", _intehead(res, days))
        w.kw("LOGIHEAD", "LOGI", np.zeros(121, int))
        dh = np.zeros(229)
        dh[0] = days
        w.kw("DOUBHEAD", "DOUB", dh)
        w.kw("STARTSOL", "MESS")
        for name, arr in res.cell_data.items():
            w.kw(name[:8], "REAL", np.nan_to_num(np.asarray(arr[r])[act]))
        w.kw("ENDSOL", "MESS")
    w.close()
    files.append(path)

    # ---------------- SMSPEC / UNSMRY
    keys = res.summary_keys()
    kw_names, wg_names, nums, units = ["TIME"], [":+:+:+:+"], [0], ["DAYS"]
    for k in keys:
        base, _, well = k.partition(":")
        kw_names.append(base)
        wg_names.append(well if well else ":+:+:+:+")
        nums.append(0)
        units.append(res.unit_label(k).upper()[:8])
    path = base_path + ".SMSPEC"
    w = _Writer(path)
    w.kw("INTEHEAD", "INTE", [2 if units_field else 1, 100])
    w.kw("RESTART", "CHAR", [""] * 9)
    w.kw("DIMENS", "INTE", [len(kw_names), res.nx, res.ny, res.nz, 0, -1])
    w.kw("KEYWORDS", "CHAR", kw_names)
    w.kw("WGNAMES", "CHAR", wg_names)
    w.kw("NUMS", "INTE", nums)
    w.kw("UNITS", "CHAR", units)
    d0 = _date(res, 0.0)
    w.kw("STARTDAT", "INTE", [d0.day, d0.month, d0.year, d0.hour, d0.minute, d0.second * 1000000])
    w.close()
    files.append(path)

    path = base_path + ".UNSMRY"
    w = _Writer(path)
    t = np.asarray(res.summary["TIME"])
    rep_times = np.asarray(res.report_times)
    # a SEQHDR opens each report step; it follows the ministep that reached the previous report time
    w.kw("SEQHDR", "INTE", [0])
    nxt = 0
    for m, tt in enumerate(t):
        w.kw("MINISTEP", "INTE", [m])
        w.kw("PARAMS", "REAL", [tt] + [np.nan_to_num(res.summary[k][m]) for k in keys])
        if nxt < rep_times.size and tt >= rep_times[nxt] - 1e-6:
            nxt += 1
            if m < t.size - 1:
                w.kw("SEQHDR", "INTE", [nxt])
    w.close()
    files.append(path)
    return files
