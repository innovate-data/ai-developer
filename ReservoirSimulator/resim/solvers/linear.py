"""Sparse linear solvers for the Newton systems.

methods
-------
direct     SuperLU sparse LU
iterative  GMRES with a two-stage CPR preconditioner (alias: "cpr"):
           stage 1 solves a decoupled pressure system with algebraic multigrid
           (pyamg if installed, otherwise incomplete LU), stage 2 applies ILU to
           the full system in cell-interleaved ordering.
auto       direct for small systems, CPR-GMRES for large ones
"""
from __future__ import annotations

import numpy as np
import scipy.sparse as sp
import scipy.sparse.linalg as spla

AUTO_THRESHOLD = 15000   # unknowns


def solve_linear(J, b, method="auto", n_cells=None, n_vars=None):
    method = (method or "auto").lower()
    N = J.shape[0]
    use_cpr = method in ("iterative", "cpr") or (method == "auto" and N > AUTO_THRESHOLD)
    if use_cpr and n_cells and n_vars:
        try:
            x = cpr_gmres(J, b, n_cells, n_vars)
            if x is not None:
                return x
        except Exception:   # fall back to the direct solver on any failure
            pass
    return spla.spsolve(sp.csc_matrix(J), b)


def _block_scaling(J, n, nv):
    """Left scaling: inverse of each cell's diagonal (nv x nv) block for the reservoir
    rows (true-IMPES decoupling) and max-abs scaling for the well rows."""
    N = J.shape[0]
    nr = n * nv
    blocks = np.zeros((n, nv, nv))
    for i in range(nv):
        for j in range(nv):
            blocks[:, i, j] = J[i * n:(i + 1) * n, j * n:(j + 1) * n].diagonal()
    inv = np.zeros_like(blocks)
    det = np.linalg.det(blocks)
    scale = np.abs(blocks).max(axis=(1, 2)) ** nv
    ok = np.abs(det) > 1e-14 * np.maximum(scale, 1e-300)
    inv[ok] = np.linalg.inv(blocks[ok])
    bad = np.nonzero(~ok)[0]
    if bad.size:      # fall back to row scaling for (near) singular blocks
        rmax = np.maximum(np.abs(blocks[bad]).max(axis=2), 1e-300)
        inv[bad] = np.einsum("ij,jk->ijk", 1.0 / rmax, np.eye(nv))
    rows, cols, vals = [], [], []
    for i in range(nv):
        for j in range(nv):
            rows.append(np.arange(n) + i * n)
            cols.append(np.arange(n) + j * n)
            vals.append(inv[:, i, j])
    if N > nr:
        wr = np.arange(nr, N)
        wmax = np.asarray(abs(J[nr:]).max(axis=1).todense()).ravel()
        rows.append(wr)
        cols.append(wr)
        vals.append(1.0 / np.maximum(wmax, 1e-300))
    return sp.csr_matrix((np.concatenate(vals), (np.concatenate(rows), np.concatenate(cols))), shape=(N, N))


def cpr_gmres(J, b, n, nv, rtol=1e-8, maxiter=200):
    J = sp.csr_matrix(J)
    N = J.shape[0]
    nr = n * nv
    D = _block_scaling(J, n, nv)
    Js = (D @ J).tocsr()
    bs = D @ b
    Ap = Js[:n, :n].tocsr()          # decoupled pressure equations
    try:
        import pyamg
        ml = pyamg.smoothed_aggregation_solver(Ap, max_coarse=500)

        def stage1(r):
            return ml.solve(r, tol=1e-3, maxiter=1)
    except ImportError:
        ilu_p = spla.spilu(Ap.tocsc(), drop_tol=1e-4, fill_factor=10)
        stage1 = ilu_p.solve
    perm = np.r_[np.arange(nr).reshape(nv, n).T.ravel(), np.arange(nr, N)]
    iperm = np.argsort(perm)
    Jp = Js[perm][:, perm].tocsc()
    ilu = None
    for spec, tol, fill in (("MMD_AT_PLUS_A", 1e-4, 5), ("COLAMD", 1e-5, 8)):
        try:
            ilu = spla.spilu(Jp, drop_tol=tol, fill_factor=fill, permc_spec=spec, diag_pivot_thresh=0.0)
            break
        except RuntimeError:
            continue
    if ilu is None:
        return None

    def prec(r):
        x = np.zeros_like(r)
        x[:n] = stage1(r[:n])
        r2 = r - Js @ x
        return x + ilu.solve(r2[perm])[iperm]

    x, ok = gmres(lambda v: Js @ v, bs, prec, rtol=rtol, restart=40, maxiter=maxiter)
    if not ok or not np.all(np.isfinite(x)):
        return None
    return x


def gmres(matvec, b, prec, rtol=1e-7, restart=40, maxiter=200):
    """Restarted right-preconditioned GMRES (modified Gram-Schmidt, Givens rotations).

    Returns (x, converged)."""
    n = b.size
    x = np.zeros(n)
    bnorm = np.linalg.norm(b)
    if bnorm == 0.0:
        return x, True
    total = 0
    r = b.copy()
    while total < maxiter:
        beta = np.linalg.norm(r)
        if beta <= rtol * bnorm:
            return x, True
        V = np.zeros((restart + 1, n))
        Z = np.zeros((restart, n))
        H = np.zeros((restart + 1, restart))
        cs = np.zeros(restart)
        sn = np.zeros(restart)
        g = np.zeros(restart + 1)
        g[0] = beta
        V[0] = r / beta
        k_used = 0
        for k in range(restart):
            Z[k] = prec(V[k])
            w = matvec(Z[k])
            for i in range(k + 1):
                H[i, k] = np.dot(w, V[i])
                w -= H[i, k] * V[i]
            H[k + 1, k] = np.linalg.norm(w)
            if H[k + 1, k] > 1e-300:
                V[k + 1] = w / H[k + 1, k]
            for i in range(k):
                t = cs[i] * H[i, k] + sn[i] * H[i + 1, k]
                H[i + 1, k] = -sn[i] * H[i, k] + cs[i] * H[i + 1, k]
                H[i, k] = t
            denom = np.hypot(H[k, k], H[k + 1, k])
            cs[k], sn[k] = (1.0, 0.0) if denom == 0 else (H[k, k] / denom, H[k + 1, k] / denom)
            H[k, k] = cs[k] * H[k, k] + sn[k] * H[k + 1, k]
            H[k + 1, k] = 0.0
            g[k + 1] = -sn[k] * g[k]
            g[k] = cs[k] * g[k]
            k_used = k + 1
            total += 1
            if abs(g[k + 1]) <= rtol * bnorm or total >= maxiter:
                break
        y = np.linalg.solve(np.triu(H[:k_used, :k_used]) + np.eye(k_used) * 1e-300, g[:k_used])
        x += Z[:k_used].T @ y
        r = b - matvec(x)
        if np.linalg.norm(r) <= rtol * bnorm:
            return x, True
    return x, np.linalg.norm(r) <= 10 * rtol * bnorm
