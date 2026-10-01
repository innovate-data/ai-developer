"""Saturation functions (SWOF/SGOF or SWFN/SGFN/SOF3 families) and the
ECLIPSE default three-phase oil relative permeability model."""
from __future__ import annotations

import numpy as np

from .tables import interp


class SaturationTable:
    """One saturation region. Capillary pressures in Pa."""

    def __init__(self, swof=None, sgof=None):
        # swof: (n,4) Sw krw krow pcow ; sgof: (n,4) Sg krg krog pcgo
        self.swof = None if swof is None else np.asarray(swof, float)
        self.sgof = None if sgof is None else np.asarray(sgof, float)
        self.swco = float(self.swof[0, 0]) if self.swof is not None else 0.0
        self.swcr = self._critical(self.swof, 1) if self.swof is not None else 0.0
        self.sgcr = self._critical(self.sgof, 1) if self.sgof is not None else 0.0

    @staticmethod
    def _critical(tab, col):
        nz = np.nonzero(tab[:, col] > 0)[0]
        return float(tab[max(nz[0] - 1, 0), 0]) if nz.size else float(tab[-1, 0])

    # water-oil
    def krw(self, sw):
        return interp(sw, self.swof[:, 0], self.swof[:, 1])

    def krow(self, sw):
        return interp(sw, self.swof[:, 0], self.swof[:, 2])

    def pcow(self, sw):
        return interp(sw, self.swof[:, 0], self.swof[:, 3])

    # gas-oil
    def krg(self, sg):
        return interp(sg, self.sgof[:, 0], self.sgof[:, 1])

    def krog(self, sg):
        return interp(sg, self.sgof[:, 0], self.sgof[:, 2])

    def pcgo(self, sg):
        return interp(sg, self.sgof[:, 0], self.sgof[:, 3])

    def kro3(self, sw, sg):
        """ECLIPSE default 3-phase model.

        kro = (Sg*krog + (Sw-Swco)*krow) / (Sg + Sw - Swco), with both two-phase
        curves looked up at the three-phase oil saturation So = 1 - Sw - Sg
        (krow at Sw' = 1 - So, krog at Sg' = 1 - So - Swco).
        Returns (kro, dkro/dsw, dkro/dsg)."""
        swco = self.swco
        krow, dkrow = self.krow(sw + sg)
        krog, dkrog = self.krog(sw + sg - swco)
        swd = np.maximum(sw - swco, 0.0)
        dswd = (sw - swco > 0).astype(float)
        den = sg + swd
        safe = den > 1e-12
        d = np.where(safe, den, 1.0)
        num = sg * krog + swd * krow
        kro = np.where(safe, num / d, krow)
        dnum_dsw = sg * dkrog + dswd * krow + swd * dkrow
        dnum_dsg = krog + sg * dkrog + swd * dkrow
        dkro_dsw = np.where(safe, (dnum_dsw * d - num * dswd) / d ** 2, dkrow)
        dkro_dsg = np.where(safe, (dnum_dsg * d - num) / d ** 2, dkrow)
        return kro, dkro_dsw, dkro_dsg


def family2_to_family1(swfn, sgfn, sof3=None, sof2=None):
    """Convert SWFN/SGFN/SOF3 (or SOF2) tables to SWOF/SGOF equivalents."""
    swof = sgof = None
    if swfn is not None:
        sw = swfn[:, 0]
        swco = sw[0]
        if sof3 is not None:
            krow = interp(1.0 - sw, sof3[:, 0], sof3[:, 1])[0]
        elif sof2 is not None:
            krow = interp(1.0 - sw, sof2[:, 0], sof2[:, 1])[0]
        else:
            krow = np.clip(1.0 - (sw - swco) / max(1 - swco, 1e-9), 0, 1) ** 2
        swof = np.column_stack([sw, swfn[:, 1], krow, swfn[:, 2]])
    else:
        swco = 0.0
    if sgfn is not None:
        sg = sgfn[:, 0]
        if sof3 is not None:
            krog = interp(1.0 - sg - swco, sof3[:, 0], sof3[:, 2])[0]
        elif sof2 is not None:
            krog = interp(1.0 - sg - swco, sof2[:, 0], sof2[:, 1])[0]
        else:
            krog = np.clip(1.0 - sg / max(1 - swco, 1e-9), 0, 1) ** 2
        sgof = np.column_stack([sg, sgfn[:, 1], krog, sgfn[:, 2]])
    return swof, sgof


def default_swof():
    sw = np.linspace(0.0, 1.0, 11)
    return np.column_stack([sw, sw ** 2, (1 - sw) ** 2, np.zeros_like(sw)])


def default_sgof():
    sg = np.linspace(0.0, 1.0, 11)
    return np.column_stack([sg, sg ** 2, (1 - sg) ** 2, np.zeros_like(sg)])
