"""Minimal vectorised forward-mode automatic differentiation with sparse Jacobians.

An `AD` object holds a value vector and a sparse Jacobian with respect to the
global vector of primary unknowns.  It is used to assemble the fully implicit
residual equations and their Jacobian in one pass (as in MRST/OPM).
"""
from __future__ import annotations

import numpy as np
import scipy.sparse as sp


def _diag(d):
    return sp.diags(np.asarray(d, float), 0, format="csr")


def _rowscale(jac, d):
    """diag(d) @ jac for a CSR matrix without building the diagonal matrix."""
    d = np.asarray(d, float)
    if d.ndim == 0:
        return jac * float(d)
    data = jac.data * np.repeat(d, np.diff(jac.indptr))
    try:
        return jac._with_data(data, copy=True)
    except AttributeError:  # pragma: no cover - older scipy
        return sp.csr_matrix((data, jac.indices.copy(), jac.indptr.copy()), shape=jac.shape)


class AD:
    __slots__ = ("val", "jac")
    __array_priority__ = 100
    __array_ufunc__ = None      # make numpy defer to AD's reflected operators

    def __init__(self, val, jac):
        self.val = np.asarray(val, float)
        self.jac = jac if sp.isspmatrix_csr(jac) else sp.csr_matrix(jac)

    # ------------------------------------------------------------ basics
    def __len__(self):
        return self.val.size

    @property
    def n_vars(self):
        return self.jac.shape[1]

    def __repr__(self):  # pragma: no cover
        return f"AD(n={self.val.size}, vars={self.n_vars})"

    def __getitem__(self, idx):
        return AD(self.val[idx], self.jac[idx])

    def scale(self, d):
        return AD(self.val * d, _rowscale(self.jac, d))

    # ------------------------------------------------------------ arithmetic
    def __neg__(self):
        return AD(-self.val, -self.jac)

    def __add__(self, other):
        if isinstance(other, AD):
            return AD(self.val + other.val, self.jac + other.jac)
        return AD(self.val + other, self.jac)

    __radd__ = __add__

    def __sub__(self, other):
        if isinstance(other, AD):
            return AD(self.val - other.val, self.jac - other.jac)
        return AD(self.val - other, self.jac)

    def __rsub__(self, other):
        return AD(other - self.val, -self.jac)

    def __mul__(self, other):
        if isinstance(other, AD):
            return AD(self.val * other.val, _rowscale(self.jac, other.val) + _rowscale(other.jac, self.val))
        other = np.asarray(other, float)
        if other.ndim == 0:
            return AD(self.val * other, self.jac * float(other))
        return AD(self.val * other, _rowscale(self.jac, other))

    __rmul__ = __mul__

    def __truediv__(self, other):
        if isinstance(other, AD):
            inv = 1.0 / other.val
            return AD(self.val * inv, _rowscale(self.jac, inv) - _rowscale(other.jac, self.val * inv * inv))
        return self * (1.0 / np.asarray(other, float))

    def __rtruediv__(self, other):
        inv = 1.0 / self.val
        return AD(other * inv, _rowscale(self.jac, -np.asarray(other, float) * inv * inv))

    def __pow__(self, e):
        return AD(self.val ** e, _rowscale(self.jac, e * self.val ** (e - 1)))

    def exp(self):
        e = np.exp(self.val)
        return AD(e, _rowscale(self.jac, e))

    def chain(self, value, deriv):
        """Apply f with f(self)=value and df/dx=deriv."""
        return AD(value, _rowscale(self.jac, deriv))


def value(x):
    return x.val if isinstance(x, AD) else np.asarray(x, float)


def combine(value_, *pairs):
    """Build an AD from a value and (derivative, AD-argument) pairs (chain rule)."""
    jac = None
    for d, arg in pairs:
        if isinstance(arg, AD):
            term = _rowscale(arg.jac, d)
            jac = term if jac is None else jac + term
    if jac is None:
        return np.asarray(value_, float)
    return AD(value_, jac)


def where(cond, a, b):
    """Elementwise select between AD/array values."""
    cond = np.asarray(cond, bool)
    va, vb = value(a), value(b)
    val = np.where(cond, va, vb)
    if not isinstance(a, AD) and not isinstance(b, AD):
        return val
    jac = None
    if isinstance(a, AD):
        jac = _rowscale(a.jac, cond.astype(float))
    if isinstance(b, AD):
        t = _rowscale(b.jac, (~cond).astype(float))
        jac = t if jac is None else jac + t
    return AD(val, jac)


def matmul(S, x):
    """Sparse/dense matrix times AD vector."""
    if isinstance(x, AD):
        return AD(S @ x.val, sp.csr_matrix(S @ x.jac))
    return S @ x


def initialize(values):
    """Create AD variables for a list of value vectors (one global unknown vector)."""
    sizes = [np.asarray(v).size for v in values]
    total = sum(sizes)
    out = []
    offset = 0
    for v, n in zip(values, sizes):
        jac = sp.csr_matrix((np.ones(n), (np.arange(n), offset + np.arange(n))), shape=(n, total))
        out.append(AD(np.asarray(v, float).copy(), jac))
        offset += n
    return out


def vstack(items):
    vals = np.concatenate([i.val for i in items])
    jac = sp.vstack([i.jac for i in items], format="csr")
    return AD(vals, jac)
