"""Table interpolation helpers returning values and derivatives."""
from __future__ import annotations

import numpy as np


def interp(x, xp, fp, extrapolate="constant"):
    """Piecewise linear interpolation returning (value, dvalue/dx).

    extrapolate: "constant" (flat ends) or "linear" (extend end segments).
    """
    x = np.asarray(x, float)
    xp = np.asarray(xp, float)
    fp = np.asarray(fp, float)
    if xp.size == 1:
        return np.full_like(x, fp[0]), np.zeros_like(x)
    idx = np.clip(np.searchsorted(xp, x, side="right") - 1, 0, xp.size - 2)
    x0, x1 = xp[idx], xp[idx + 1]
    f0, f1 = fp[idx], fp[idx + 1]
    dx = x1 - x0
    slope = np.where(dx > 0, (f1 - f0) / np.where(dx > 0, dx, 1.0), 0.0)
    val = f0 + slope * (x - x0)
    if extrapolate == "constant":
        lo = x < xp[0]
        hi = x > xp[-1]
        val = np.where(lo, fp[0], np.where(hi, fp[-1], val))
        slope = np.where(lo | hi, 0.0, slope)
    return val, slope


def interp_val(x, xp, fp, extrapolate="constant"):
    return interp(x, xp, fp, extrapolate)[0]
