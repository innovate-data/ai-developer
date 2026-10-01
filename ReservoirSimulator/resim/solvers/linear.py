"""Sparse linear solvers for the Newton systems."""
from __future__ import annotations

import numpy as np
import scipy.sparse as sp
import scipy.sparse.linalg as spla


def solve_linear(J, b, method="direct"):
    J = sp.csc_matrix(J)
    if method == "iterative" and J.shape[0] > 2000:
        try:
            ilu = spla.spilu(J, drop_tol=1e-5, fill_factor=20)
            M = spla.LinearOperator(J.shape, ilu.solve)
            x, info = spla.gmres(J, b, M=M, rtol=1e-8, restart=60, maxiter=200)
            if info == 0 and np.all(np.isfinite(x)):
                return x
        except Exception:
            pass
    return spla.spsolve(J, b)
