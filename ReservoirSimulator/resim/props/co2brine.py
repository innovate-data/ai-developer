"""CO2-brine fluid system for carbon storage (CO2STORE).

The brine plays the role of the black-oil liquid phase and CO2 that of the gas
phase:

* CO2 dissolves in brine (Rs, "RSW") with the Spycher & Pruess (2005) mutual
  solubility model, corrected for salinity with a Setschenow-type activity
  coefficient  ln(gamma) = 2*lambda*m + xi*m^2  (lambda = 0.11, xi = -0.0028 kg/mol).
* Water evaporates into the CO2-rich phase (Rv, "RVW") from the same model,
  scaled by the water mole fraction of the brine (Raoult).
* CO2 density from Peng-Robinson with a Peneloux volume shift s = 0.14 fitted to
  NIST densities between 30-70 C and 100-250 bar (RMS error ~3 %)
  (pure CO2: Tc = 304.13 K, pc = 73.773 bar, omega = 0.22394); viscosity from
  Lohrenz-Bray-Clark (about 10 % below NIST in the supercritical range).
* Brine density and viscosity from Batzle & Wang (1992); the volume of
  dissolved CO2 uses the apparent molar volume of Garcia (2001).

Properties are evaluated at the (isothermal) reservoir temperature and
tabulated on a pressure grid, then served through the same interface as the
black-oil `LiveOil` / `WetGas` models.
"""
from __future__ import annotations

import numpy as np

from .eos import CubicEOS
from .tables import interp

R_BAR = 83.1447          # bar cm3 / (mol K)
M_CO2 = 0.04401          # kg/mol
M_H2O = 0.018015         # kg/mol
M_NACL = 0.05844         # kg/mol
T_STD = 288.71           # K (60 F)
P_STD = 101325.0         # Pa
SALT_LAMBDA = 0.11
SALT_XI = -0.0028


def co2_eos():
    return CubicEOS([304.13], [73.773e5], [0.22394], [M_CO2], vc=[94.07e-6], shift=[0.14], names=["CO2"])


def co2_h2o_eos():
    bic = np.array([[0.0, 0.19], [0.19, 0.0]])
    return CubicEOS([304.13, 647.10], [73.773e5, 220.64e5], [0.22394, 0.3443], [M_CO2, M_H2O], bic,
                    vc=[94.07e-6, 55.95e-6], names=["CO2", "H2O"])


def brine_density(T, p, S):
    """Batzle & Wang (1992) brine density [kg/m3]; T [K], p [Pa], S salt mass fraction."""
    t = T - 273.15
    P = np.asarray(p, float) * 1e-6
    rw = 1 + 1e-6 * (-80 * t - 3.3 * t ** 2 + 0.00175 * t ** 3 + 489 * P - 2 * t * P + 0.016 * t ** 2 * P
                     - 1.3e-5 * t ** 3 * P - 0.333 * P ** 2 - 0.002 * t * P ** 2)
    rb = rw + S * (0.668 + 0.44 * S + 1e-6 * (300 * P - 2400 * P * S
                                              + t * (80 + 3 * t - 3300 * S - 13 * P + 47 * P * S)))
    return rb * 1000.0


def brine_viscosity(T, S):
    """Batzle & Wang (1992) brine viscosity [Pa.s]."""
    t = T - 273.15
    mu = 0.1 + 0.333 * S + (1.65 + 91.9 * S ** 3) * np.exp(-(0.42 * (S ** 0.8 - 0.17) ** 2 + 0.045) * t ** 0.8)
    return mu * 1e-3


def co2_apparent_molar_volume(T):
    """Garcia (2001) apparent molar volume of dissolved CO2 [m3/mol]."""
    t = T - 273.15
    return (37.51 - 9.585e-2 * t + 8.740e-4 * t ** 2 - 5.044e-7 * t ** 3) * 1e-6


def spycher_pruess(T, p, molality=0.0):
    """Mutual solubilities (x_CO2 in brine, y_H2O in CO2) after Spycher & Pruess (2005).

    T [K], p [Pa] (array). Returns (m_CO2 [mol/kg water], y_H2O)."""
    t = T - 273.15
    P = np.maximum(np.asarray(p, float) * 1e-5, 1.0)       # bar
    k_h2o = 10 ** (-2.209 + 3.097e-2 * t - 1.098e-4 * t ** 2 + 2.048e-7 * t ** 3)
    k_co2 = 10 ** (1.189 + 1.304e-2 * t - 5.446e-5 * t ** 2)
    v_h2o, v_co2 = 18.1, 32.6
    eos = co2_h2o_eos()
    y = np.column_stack([np.full(P.size, 1.0 - 1e-4), np.full(P.size, 1e-4)])
    lnphi, _ = eos.lnphi(y, P * 1e5, T, "V")
    phi_co2, phi_h2o = np.exp(lnphi[:, 0]), np.exp(lnphi[:, 1])
    A = k_h2o / (phi_h2o * P) * np.exp((P - 1) * v_h2o / (R_BAR * T))
    B = phi_co2 * P / (55.508 * k_co2) * np.exp(-(P - 1) * v_co2 / (R_BAR * T))
    y_h2o = np.clip((1 - B) / (1 / A - B), 0.0, 0.5)
    x_co2 = np.clip(B * (1 - y_h2o), 0.0, 0.2)
    m_co2 = 55.508 * x_co2 / (1 - x_co2)
    m = float(molality)
    gamma = np.exp(2 * SALT_LAMBDA * m + SALT_XI * m * m)
    m_co2 = m_co2 / gamma
    y_h2o = y_h2o * 55.508 / (55.508 + 2 * m)
    return m_co2, y_h2o


class CO2BrineSystem:
    """Tabulated CO2-brine properties at temperature T [K] and salinity [mol NaCl / kg water]."""

    def __init__(self, T, molality=0.0, p_max=1.0e8, vapwat=True, npts=400):
        self.T = float(T)
        self.m = float(molality)
        self.S = self.m * M_NACL / (1.0 + self.m * M_NACL)        # mass fraction
        self.vapwat = vapwat
        eos = co2_eos()
        # surface conditions
        z1 = np.ones((1, 1))
        _, zs = eos.lnphi(z1, np.array([P_STD]), T_STD, "auto")
        self.v_std = float(eos.molar_volume(z1, zs, np.array([P_STD]), T_STD)[0])     # m3/mol
        self.rho_gs = M_CO2 / self.v_std
        self.rho_bs = float(brine_density(T_STD, P_STD, self.S))
        # pressure grid
        self.p = np.concatenate([np.linspace(1.0e5, 1.0e7, 100), np.linspace(1.0e7, p_max, npts)[1:]])
        zz = np.ones((self.p.size, 1))
        _, Z = eos.lnphi(zz, self.p, self.T, "auto")
        vm = eos.molar_volume(zz, Z, self.p, self.T)
        self.rho_co2 = M_CO2 / vm
        self.bg = self.v_std / vm                                   # sm3 per rm3
        self.mug = eos.lbc_viscosity(zz, 1.0 / vm, self.T)
        m_co2, y_h2o = spycher_pruess(self.T, self.p, self.m)
        vs_per_kgw = (1.0 + self.m * M_NACL) / self.rho_bs          # surface brine volume per kg water
        self.rs = m_co2 * self.v_std / vs_per_kgw                   # sm3 CO2 / sm3 brine
        if vapwat:
            # moles of water per mole of CO2 -> surface brine volume per surface CO2 volume
            self.rv = (y_h2o / (1 - y_h2o)) * (M_H2O / self.rho_bs) / self.v_std
        else:
            self.rv = np.zeros_like(self.p)
        self.v_phi = co2_apparent_molar_volume(self.T)
        self.mu_b = float(brine_viscosity(self.T, self.S))
        self.brine = _Brine(self)
        self.gas = _CO2Gas(self)

    def dissolved_mole_fraction(self, rs):
        """Mole fraction of CO2 in brine for a dissolved ratio Rs (sm3/sm3)."""
        n_co2 = rs / self.v_std
        n_w = self.rho_bs * (1.0 / (1.0 + self.m * M_NACL)) / M_H2O
        return n_co2 / (n_co2 + n_w + 2 * self.m * n_w * M_H2O)


class _Brine:
    """Brine with dissolved CO2 (LiveOil interface)."""

    def __init__(self, sysm):
        self.s = sysm

    def rs_sat(self, p):
        return interp(p, self.s.p, self.s.rs, "linear")

    def _B0(self, p):
        return self.s.rho_bs / brine_density(self.s.T, p, self.s.S)

    def eval(self, p, rs):
        p = np.asarray(p, float)
        rs = np.asarray(rs, float)
        h = 1.0e-6 * np.maximum(np.abs(p), 1e5)
        B0 = self._B0(p)
        dB0 = (self._B0(p + h) - self._B0(p - h)) / (2 * h)
        c = self.s.v_phi / self.s.v_std
        B = B0 + rs * c
        b = 1.0 / B
        db_dp = -dB0 / B ** 2
        db_drs = -c / B ** 2
        mu = np.full_like(p, self.s.mu_b)
        z = np.zeros_like(p)
        return b, db_dp, db_drs, mu, z, z


class _CO2Gas:
    """CO2-rich phase with vaporised water (WetGas interface)."""

    def __init__(self, sysm):
        self.s = sysm

    def rv_sat(self, p):
        v, d = interp(p, self.s.p, self.s.rv, "linear")
        return np.maximum(v, 0.0), d

    def eval(self, p, rv=None):
        p = np.asarray(p, float)
        b, db = interp(p, self.s.p, self.s.bg, "linear")
        mu, dmu = interp(p, self.s.p, self.s.mug, "linear")
        z = np.zeros_like(p)
        return np.maximum(b, 1e-12), db, z, mu, dmu, z
