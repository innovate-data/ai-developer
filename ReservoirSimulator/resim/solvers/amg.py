"""Smoothed-aggregation algebraic multigrid and Gauss-Seidel smoothers using only NumPy/SciPy.

Used for the pressure stage of the CPR preconditioner when pyamg is not installed (for
example in the browser build, where only NumPy and SciPy exist) and for the second CPR
stage.  Gauss-Seidel sweeps are sparse triangular solves, done by SuperLU's compiled
triangular solver (the routine behind scipy.sparse.linalg.spsolve_triangular).
"""
from __future__ import annotations

import numpy as np
import scipy.sparse as sp
import scipy.sparse.linalg as spla

try:                                    # compiled triangular solve (scipy >= 1.4)
    from scipy.sparse.linalg._dsolve import _superlu
    _GSTRS = getattr(_superlu, "gstrs", None)
except Exception:                       # pragma: no cover
    _GSTRS = None


class TriangularSolver:
    """Solve (D + L) x = b (lower) or (D + U) x = b (upper) for a fixed sparse matrix."""

    def __init__(self, A, lower=True):
        A = sp.csr_matrix(A)
        n = A.shape[0]
        d = A.diagonal().copy()
        d[d == 0] = 1.0
        self.n, self.lower = n, lower
        self.inv_d = 1.0 / d
        self.d = d
        if lower:
            # (D + L) = (I + L D^-1) D : unit lower factor, empty upper factor
            T = sp.tril(A, -1, format="csc") @ sp.diags(self.inv_d)
            self.Lf = (sp.eye(n, format="csc") + T).tocsc()
            self.Uf = sp.csc_matrix((n, n))
        else:
            # (D + U) = D (I + D^-1 U) : identity lower factor, upper factor with unit diagonal
            T = sp.diags(self.inv_d) @ sp.triu(A, 1, format="csc")
            self.Lf = sp.eye(n, format="csc")
            self.Uf = (sp.eye(n, format="csc") + T).tocsc()
        for M in (self.Lf, self.Uf):
            M.sort_indices()
            M.data = M.data.astype(float)
        self._A = A

    def solve(self, b):
        b = np.asarray(b, float)
        if _GSTRS is not None:
            rhs = b.copy() if self.lower else b * self.inv_d
            x, info = _GSTRS("N", self.n, self.Lf.nnz, self.Lf.data, self.Lf.indices, self.Lf.indptr,
                             self.n, self.Uf.nnz, self.Uf.data, self.Uf.indices, self.Uf.indptr, rhs)
            if info == 0:
                return x * self.inv_d if self.lower else x
        part = sp.tril(self._A, 0, format="csr") if self.lower else sp.triu(self._A, 0, format="csr")
        return spla.spsolve_triangular(part, b, lower=self.lower)


class GaussSeidel:
    """Gauss-Seidel smoother: forward, backward or symmetric sweeps."""

    def __init__(self, A):
        self.A = sp.csr_matrix(A)
        self.fw = TriangularSolver(self.A, lower=True)
        self.bw = TriangularSolver(self.A, lower=False)

    def forward(self, b, x=None):
        if x is None:
            return self.fw.solve(b)
        return x + self.fw.solve(b - self.A @ x)

    def backward(self, b, x=None):
        if x is None:
            return self.bw.solve(b)
        return x + self.bw.solve(b - self.A @ x)

    def symmetric(self, b, x=None):
        return self.backward(b, self.forward(b, x))


def _strength(A, theta):
    """Symmetric strength of connection |a_ij| >= theta * sqrt(|a_ii a_jj|), without the diagonal."""
    A = sp.csr_matrix(A)
    d = np.sqrt(np.abs(A.diagonal()))
    d[d == 0] = 1.0
    C = sp.csr_matrix(abs(A))
    rows = np.repeat(np.arange(A.shape[0]), np.diff(C.indptr))
    keep = (C.data >= theta * d[rows] * d[C.indices]) & (rows != C.indices)
    S = sp.csr_matrix((np.ones(keep.sum()), (rows[keep], C.indices[keep])), shape=A.shape)
    return (S + S.T).tocsr()


def standard_aggregation(S):
    """Greedy aggregation (as in pyamg 'standard'): returns aggregate index per node."""
    n = S.shape[0]
    indptr, indices = S.indptr.tolist(), S.indices.tolist()
    agg = [-1] * n
    nagg = 0
    # pass 1: a node and all its strong neighbours, if none is aggregated yet
    for i in range(n):
        if agg[i] >= 0:
            continue
        nb = indices[indptr[i]:indptr[i + 1]]
        if all(agg[j] < 0 for j in nb):
            agg[i] = nagg
            for j in nb:
                agg[j] = nagg
            nagg += 1
    # pass 2: attach remaining nodes to a neighbouring aggregate
    for i in range(n):
        if agg[i] >= 0:
            continue
        for j in indices[indptr[i]:indptr[i + 1]]:
            if agg[j] >= 0:
                agg[i] = -2 - agg[j]          # mark: joins aggregate agg[j] (resolved below)
                break
    for i in range(n):
        if agg[i] <= -2:
            agg[i] = -2 - agg[i]
    # pass 3: what is left forms new aggregates with its unaggregated neighbours
    for i in range(n):
        if agg[i] >= 0:
            continue
        agg[i] = nagg
        for j in indices[indptr[i]:indptr[i + 1]]:
            if agg[j] < 0:
                agg[j] = nagg
        nagg += 1
    return np.array(agg, int), nagg


class AggregationAMG:
    """Smoothed-aggregation AMG V-cycle (Gauss-Seidel smoothing, direct coarsest solve).

    The tentative (piecewise-constant) prolongator is smoothed by one damped Jacobi step,
    P = (I - w D^-1 A) P0 with w = 4/3 / rho and rho bounded by Gershgorin's theorem.  For the
    nonsymmetric pressure matrices of CPR the restriction is smoothed with A^T
    (Petrov-Galerkin, R = P0^T (I - w A D^-1)); the Galerkin choice R = P^T can give
    divergent cycles there.  `cache` (a dict) keeps the aggregates between calls for matrices
    with the same size and sparsity, so the (Python) aggregation runs once per model.
    """

    def __init__(self, A, max_coarse=400, theta=0.08, max_levels=12, cache=None, symmetric=False,
                 petrov_galerkin=True):
        self.symmetric = symmetric
        self.levels = []
        A = sp.csr_matrix(A)
        lvl = 0
        while A.shape[0] > max_coarse and lvl < max_levels:
            key = ("agg", lvl, A.shape[0])
            if cache is not None and key in cache:
                agg, nagg = cache[key]
            else:
                agg, nagg = standard_aggregation(_strength(A, theta))
                if cache is not None:
                    cache[key] = (agg, nagg)
            if nagg >= A.shape[0] or nagg == 0:
                break
            n = A.shape[0]
            P0 = sp.csr_matrix((np.ones(n), (np.arange(n), agg)), shape=(n, nagg))
            d = A.diagonal().copy()
            d[d == 0] = 1.0
            Dinv = sp.diags(1.0 / d)
            DinvA = (Dinv @ A).tocsr()
            rho = max(float(abs(DinvA).sum(axis=1).max()), 1e-12)        # Gershgorin bound
            w = 4.0 / 3.0 / rho
            P = (P0 - w * (DinvA @ P0)).tocsr()
            if petrov_galerkin:
                R = (P0 - w * ((Dinv @ A.T) @ P0)).T.tocsr()
            else:
                R = P.T.tocsr()
            self.levels.append({"A": A, "P": P, "R": R, "smoother": GaussSeidel(A)})
            A = (R @ A @ P).tocsr()
            lvl += 1
        self.coarse_A = A
        try:
            self.coarse = spla.splu(A.tocsc())
        except RuntimeError:                       # singular coarse matrix (e.g. no wells)
            self.coarse = spla.splu((A + sp.eye(A.shape[0]) * 1e-12 * abs(A).max()).tocsc())

    @staticmethod
    def _spectral_radius(M, iters=12):
        rng = np.random.default_rng(0)
        x = rng.random(M.shape[0])
        lam = 1.0
        for _ in range(iters):
            y = M @ x
            nrm = np.linalg.norm(y)
            if nrm == 0:
                return 1.0
            lam = nrm / np.linalg.norm(x)
            x = y / nrm
        return max(lam, 1e-12)

    def _cycle(self, lvl, b):
        if lvl == len(self.levels):
            return self.coarse.solve(b)
        L = self.levels[lvl]
        sm = L["smoother"]
        x = sm.symmetric(b) if self.symmetric else sm.forward(b)
        r = b - L["A"] @ x
        x = x + L["P"] @ self._cycle(lvl + 1, L["R"] @ r)
        return sm.symmetric(b, x) if self.symmetric else sm.backward(b, x)

    def solve(self, b):
        return self._cycle(0, np.asarray(b, float))
