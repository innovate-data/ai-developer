"""Unit systems used by ECLIPSE decks.

The simulator works internally in SI units:
    pressure  Pa          length   m          time       s
    volume    m3          perm     m2         viscosity  Pa.s
    density   kg/m3       temp     K          rates      m3/s (surface or reservoir)
    Rs        sm3/sm3     Bo, Bw   rm3/sm3    Bg         rm3/sm3

`UnitSystem` converts deck quantities to SI (``to_si``) and back (``from_si``).
"""
from __future__ import annotations

from dataclasses import dataclass, field

DAY = 86400.0
STB = 0.158987294928          # m3
MSCF = 28.316846592           # m3 (1000 scf)
FT = 0.3048
PSI = 6894.757293168
BAR = 1.0e5
ATM = 101325.0
MD = 9.869233e-16             # m2
CP = 1.0e-3                   # Pa.s
LB_FT3 = 16.01846337396       # kg/m3
R_GAS = 8.314462618           # J/(mol K)
GRAVITY = 9.80665             # m/s2


@dataclass
class UnitSystem:
    name: str
    factors: dict = field(default_factory=dict)
    temp_offset: float = 0.0     # T_K = (T + offset) * temp_scale
    temp_scale: float = 1.0
    abs_temp_scale: float = 1.0  # for absolute temperatures used by EOS (R or K)

    def to_si(self, value, quantity: str):
        if quantity == "temperature":
            return (value + self.temp_offset) * self.temp_scale
        return value * self.factors[quantity]

    def from_si(self, value, quantity: str):
        if quantity == "temperature":
            return value / self.temp_scale - self.temp_offset
        return value / self.factors[quantity]

    def label(self, quantity: str) -> str:
        return LABELS[self.name].get(quantity, "")


FIELD = UnitSystem(
    "FIELD",
    {
        "pressure": PSI,
        "length": FT,
        "area": FT * FT,
        "volume": FT ** 3,
        "perm": MD,
        "viscosity": CP,
        "time": DAY,
        "liquid_surface_volume": STB,
        "gas_surface_volume": MSCF,
        "reservoir_volume": STB,
        "liquid_surface_rate": STB / DAY,
        "gas_surface_rate": MSCF / DAY,
        "reservoir_rate": STB / DAY,
        "rs": MSCF / STB,
        "rv": STB / MSCF,
        "wgr": STB / MSCF,
        "bo": 1.0,
        "bg": STB / MSCF,
        "density": LB_FT3,
        "compressibility": 1.0 / PSI,
        "viscosibility": 1.0 / PSI,
        "transmissibility": CP * STB / DAY / PSI,
        "productivity_index": STB / DAY / PSI,
        "gas_productivity_index": MSCF / DAY / PSI,
        "pressure_gradient": PSI / FT,
        "molar_volume": FT ** 3 / 453.59237,   # ft3/lb-mol -> m3/mol
        "abs_temperature": 5.0 / 9.0,          # Rankine -> K
        "molar_rate": 453.59237 / DAY,          # lb-mol/day -> mol/s
        "specific_heat": 4186.8,                 # Btu/lb/R -> J/kg/K
        "specific_enthalpy": 2326.0,             # Btu/lb -> J/kg
        "volumetric_heat_capacity": 67066.1,     # Btu/ft3/R -> J/m3/K
        "thermal_conductivity": 1055.056 / (FT * DAY * 5.0 / 9.0),   # Btu/ft/day/R -> W/m/K
        "mass": 1000.0,                          # tonnes
    },
    temp_offset=459.67,
    temp_scale=5.0 / 9.0,
)

METRIC = UnitSystem(
    "METRIC",
    {
        "pressure": BAR,
        "length": 1.0,
        "area": 1.0,
        "volume": 1.0,
        "perm": MD,
        "viscosity": CP,
        "time": DAY,
        "liquid_surface_volume": 1.0,
        "gas_surface_volume": 1.0,
        "reservoir_volume": 1.0,
        "liquid_surface_rate": 1.0 / DAY,
        "gas_surface_rate": 1.0 / DAY,
        "reservoir_rate": 1.0 / DAY,
        "rs": 1.0,
        "rv": 1.0,
        "wgr": 1.0,
        "bo": 1.0,
        "bg": 1.0,
        "density": 1.0,
        "compressibility": 1.0 / BAR,
        "viscosibility": 1.0 / BAR,
        "transmissibility": CP / DAY / BAR,
        "productivity_index": 1.0 / DAY / BAR,
        "gas_productivity_index": 1.0 / DAY / BAR,
        "pressure_gradient": BAR,
        "molar_volume": 1.0e-3,                 # m3/kg-mol -> m3/mol
        "abs_temperature": 1.0,                  # K
        "molar_rate": 1000.0 / DAY,              # kg-mol/day -> mol/s
        "specific_heat": 1000.0,                 # kJ/kg/K -> J/kg/K
        "specific_enthalpy": 1000.0,             # kJ/kg -> J/kg
        "volumetric_heat_capacity": 1000.0,      # kJ/m3/K -> J/m3/K
        "thermal_conductivity": 1000.0 / DAY,    # kJ/m/day/K -> W/m/K
        "mass": 1000.0,                          # tonnes
    },
    temp_offset=273.15,
    temp_scale=1.0,
)

LABELS = {
    "FIELD": {
        "pressure": "psia", "length": "ft", "liquid_surface_rate": "stb/d",
        "gas_surface_rate": "Mscf/d", "reservoir_rate": "rb/d",
        "liquid_surface_volume": "stb", "gas_surface_volume": "Mscf",
        "rs": "Mscf/stb", "density": "lb/ft3", "viscosity": "cP",
        "time": "days", "temperature": "F", "perm": "mD", "volume": "ft3",
        "reservoir_volume": "rb", "mass": "t", "rv": "stb/Mscf", "wgr": "stb/Mscf",
        "productivity_index": "stb/d/psi", "gas_productivity_index": "Mscf/d/psi",
    },
    "METRIC": {
        "pressure": "bar", "length": "m", "liquid_surface_rate": "sm3/d",
        "gas_surface_rate": "sm3/d", "reservoir_rate": "rm3/d",
        "liquid_surface_volume": "sm3", "gas_surface_volume": "sm3",
        "rs": "sm3/sm3", "density": "kg/m3", "viscosity": "cP",
        "time": "days", "temperature": "C", "perm": "mD", "volume": "m3",
        "reservoir_volume": "rm3", "mass": "t", "rv": "sm3/sm3", "wgr": "sm3/sm3",
        "productivity_index": "sm3/d/bar", "gas_productivity_index": "sm3/d/bar",
    },
}


def get_units(name: str) -> UnitSystem:
    name = (name or "METRIC").upper()
    if name == "FIELD":
        return FIELD
    if name == "METRIC":
        return METRIC
    raise ValueError(f"Unsupported unit system {name!r} (FIELD and METRIC are supported)")
