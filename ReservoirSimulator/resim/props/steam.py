"""Water/steam properties for steam injection (THERMAL runs with a steam phase).

Saturation pressure and temperature use the IAPWS-IF97 region-4 equations.  The
saturated-liquid enthalpy, latent heat, saturated-vapour density and viscosity and the
saturated-liquid density are interpolated in a table computed with IAPWS-IF97 (10 C spacing
to 370 C, just below the critical point).  Steam off saturation (superheated) is a
real gas whose second virial coefficient matches the saturated-vapour density:
Z = 1 + (Z_sat(T) - 1) * p / p_sat(T).

All functions take SI units (Pa, K) and return (value, derivative) pairs.
"""
from __future__ import annotations

import numpy as np

T0 = 273.15
T_CRIT = 647.096
M_W = 0.018015268          # kg/mol
R = 8.314462618

_N = (0.11670521452767e4, -0.72421316703206e6, -0.17073846940092e2, 0.12020824702470e5,
      -0.32325550322333e7, 0.14915108613530e2, -0.48232657361591e4, 0.40511340542057e6,
      -0.23855557567849, 0.65017534844798e3)

# T (C), p_sat (Pa), h_liquid (kJ/kg), latent heat (kJ/kg), vapour density (kg/m3),
# vapour viscosity (uPa s), liquid density (kg/m3) on the saturation line (IAPWS-IF97)
_SAT = np.array([
    (0.01, 6.116570e+02, 0.00, 2500.89, 0.0049, 9.216, 999.79),
    (10.0, 1.228184e+03, 42.02, 2477.21, 0.0094, 9.238, 999.65),
    (20.0, 2.339215e+03, 83.92, 2453.55, 0.0173, 9.544, 998.16),
    (30.0, 4.246688e+03, 125.75, 2429.84, 0.0304, 9.860, 995.61),
    (40.0, 7.384427e+03, 167.54, 2406.00, 0.0512, 10.185, 992.18),
    (50.0, 1.235127e+04, 209.34, 2381.97, 0.0831, 10.516, 988.01),
    (60.0, 1.994580e+04, 251.15, 2357.69, 0.1304, 10.854, 983.18),
    (70.0, 3.120064e+04, 293.02, 2333.08, 0.1984, 11.195, 977.75),
    (80.0, 4.741472e+04, 334.95, 2308.07, 0.2937, 11.539, 971.78),
    (90.0, 7.018236e+04, 376.97, 2282.56, 0.4239, 11.885, 965.30),
    (100.0, 1.014180e+05, 419.10, 2256.47, 0.5981, 12.232, 958.35),
    (110.0, 1.433760e+05, 461.36, 2229.70, 0.8269, 12.580, 950.95),
    (120.0, 1.986654e+05, 503.78, 2202.15, 1.1220, 12.927, 943.11),
    (130.0, 2.702596e+05, 546.39, 2173.70, 1.4968, 13.273, 934.83),
    (140.0, 3.615010e+05, 589.20, 2144.24, 1.9665, 13.618, 926.13),
    (150.0, 4.761014e+05, 632.25, 2113.67, 2.5478, 13.961, 917.01),
    (160.0, 6.181392e+05, 675.57, 2081.86, 3.2593, 14.304, 907.45),
    (170.0, 7.920532e+05, 719.21, 2048.69, 4.1217, 14.645, 897.45),
    (180.0, 1.002635e+06, 763.19, 2014.03, 5.1583, 14.985, 887.01),
    (190.0, 1.255018e+06, 807.57, 1977.74, 6.3948, 15.325, 876.08),
    (200.0, 1.554672e+06, 852.39, 1939.67, 7.8603, 15.666, 864.67),
    (210.0, 1.907391e+06, 897.73, 1899.62, 9.5875, 16.009, 852.73),
    (220.0, 2.319288e+06, 943.64, 1857.41, 11.6143, 16.354, 840.23),
    (230.0, 2.796792e+06, 990.21, 1812.80, 13.9840, 16.705, 827.12),
    (240.0, 3.346652e+06, 1037.52, 1765.54, 16.7476, 17.062, 813.36),
    (250.0, 3.975939e+06, 1085.69, 1715.33, 19.9654, 17.429, 798.89),
    (260.0, 4.692071e+06, 1134.83, 1661.82, 23.7105, 17.810, 783.62),
    (270.0, 5.502839e+06, 1185.09, 1604.60, 28.0722, 18.208, 767.46),
    (280.0, 6.416459e+06, 1236.67, 1543.15, 33.1631, 18.630, 750.27),
    (290.0, 7.441643e+06, 1289.80, 1476.84, 39.1285, 19.083, 731.91),
    (300.0, 8.587708e+06, 1344.77, 1404.80, 46.1615, 19.580, 712.14),
    (310.0, 9.864746e+06, 1402.00, 1325.92, 54.5290, 20.135, 690.67),
    (320.0, 1.128386e+07, 1462.05, 1238.62, 64.6165, 20.773, 667.08),
    (330.0, 1.285752e+07, 1525.74, 1140.51, 77.0179, 21.531, 640.78),
    (340.0, 1.460018e+07, 1594.45, 1027.62, 92.7314, 22.476, 610.68),
    (350.0, 1.652916e+07, 1670.86, 892.73, 113.6243, 23.740, 574.69),
    (355.0, 1.757021e+07, 1713.71, 812.74, 127.1292, 24.573, 553.16),
    (360.0, 1.866637e+07, 1761.49, 719.50, 143.9886, 25.640, 527.84),
    (365.0, 1.982217e+07, 1817.59, 604.41, 166.5459, 27.120, 496.13),
    (370.0, 2.104337e+07, 1892.64, 440.86, 202.1756, 29.596, 450.03),
])
_T = _SAT[:, 0] + T0
_ZSAT = _SAT[:, 1] * M_W / (R * _T * _SAT[:, 4])
T_MAX = _T[-1]
P_MAX = _SAT[-1, 1]


def _table(T, col):
    """Piecewise-linear interpolation in the saturation table with its derivative."""
    T = np.asarray(T, float)
    y = _SAT[:, col] if np.ndim(col) == 0 else col
    i = np.clip(np.searchsorted(_T, T) - 1, 0, _T.size - 2)
    s = (y[i + 1] - y[i]) / (_T[i + 1] - _T[i])
    inside = (T >= _T[0]) & (T <= _T[-1])
    v = np.where(T < _T[0], y[0], np.where(T > _T[-1], y[-1], y[i] + s * (T - _T[i])))
    return v, np.where(inside, s, 0.0)


def psat(T):
    """Saturation pressure (Pa) and dp/dT at temperature T (K), IAPWS-IF97 eq. 30."""
    n = _N
    T = np.clip(np.asarray(T, float), 273.16, T_CRIT - 0.5)

    def p_of(T):
        th = T + n[8] / (T - n[9])
        A = th * th + n[0] * th + n[1]
        B = n[2] * th * th + n[3] * th + n[4]
        C = n[5] * th * th + n[6] * th + n[7]
        return (2.0 * C / (-B + np.sqrt(B * B - 4.0 * A * C))) ** 4 * 1e6

    h = 1e-3
    return p_of(T), (p_of(T + h) - p_of(T - h)) / (2 * h)


def tsat(p):
    """Saturation temperature (K) and dT/dp at pressure p (Pa), IAPWS-IF97 eq. 31."""
    n = _N
    p = np.clip(np.asarray(p, float), 611.213, 2.2e7)
    beta = (p * 1e-6) ** 0.25
    E = beta * beta + n[2] * beta + n[5]
    F = n[0] * beta * beta + n[3] * beta + n[6]
    G = n[1] * beta * beta + n[4] * beta + n[7]
    D = 2.0 * G / (-F - np.sqrt(F * F - 4.0 * E * G))
    T = 0.5 * (n[9] + D - np.sqrt((n[9] + D) ** 2 - 4.0 * (n[8] + n[9] * D)))
    return T, 1.0 / psat(T)[1]


def latent_heat(T):
    """Latent heat of vaporisation (J/kg) and its temperature derivative."""
    v, d = _table(T, 3)
    return v * 1e3, d * 1e3


def liquid_cp(T):
    """Effective specific heat c(T) = h_liquid(T) / (T - 273.15) of saturated water, so that
    c(T) * (T - 273.15) is the IAPWS-IF97 liquid enthalpy (J/kg/K, with dc/dT)."""
    h, dh = _table(T, 2)
    dT = np.maximum(np.asarray(T, float) - T0, 1.0)
    h = np.maximum(h, 4.18 * dT)                      # below 1 C
    return h * 1e3 / dT, (dh * 1e3 - h * 1e3 / dT) / dT


def liquid_density_ratio(T, t_ref):
    """rho_liquid(T) / rho_liquid(t_ref) of saturated water (thermal expansion) with derivative."""
    v, d = _table(T, 6)
    r = _table(t_ref, 6)[0]
    return v / r, d / r


def vapour_viscosity(T):
    """Steam viscosity (Pa s) and its temperature derivative."""
    v, d = _table(T, 5)
    return v * 1e-6, d * 1e-6


def vapour_density(p, T):
    """Steam density (kg/m3) with derivatives d/dp and d/dT (real gas, see module docstring)."""
    p = np.asarray(p, float)
    T = np.asarray(T, float)
    zs, dzs = _table(T, _ZSAT)
    ps, dps = psat(T)
    r = p / ps
    cap = r < 1.0                       # steam below its condensation pressure (absent otherwise)
    rr = np.where(cap, r, 1.0)
    Z = 1.0 + (zs - 1.0) * rr
    dZdp = np.where(cap, (zs - 1.0) / ps, 0.0)
    dZdT = dzs * rr + np.where(cap, -(zs - 1.0) * r / ps * dps, 0.0)
    rho = p * M_W / (Z * R * T)
    return rho, rho * (1.0 / np.maximum(p, 1.0) - dZdp / Z), rho * (-1.0 / T - dZdT / Z)


class SteamGas:
    """Steam as the gas phase of the black-oil PVT interface, on the saturation line
    (b = rho_steam / rho_water_surface, Rv = 0).  The thermal solver replaces these values
    with the ones at the cell temperature; the saturated ones serve initialisation and
    reservoir-volume conversions."""

    def __init__(self, rho_ws):
        self.rho_ws = rho_ws

    def rv_sat(self, p):
        return np.zeros_like(p), np.zeros_like(p)

    def eval(self, p, rv=None):
        p = np.asarray(p, float)
        T, dT = tsat(p)
        rho, dp, dt = vapour_density(p, T)
        mu, dmu = vapour_viscosity(T)
        z = np.zeros_like(p)
        return rho / self.rho_ws, (dp + dt * dT) / self.rho_ws, z, mu, dmu * dT, z
