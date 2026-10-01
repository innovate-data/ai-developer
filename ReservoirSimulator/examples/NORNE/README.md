# Norne field (Equinor / NTNU benchmark)

ECLIPSE input deck `NORNE_ATW2013.DATA` of the **Norne** full-field model prepared for the
SPE Applied Technology Workshop 2013, as published in the OPM test-data repository
(<https://github.com/OPM/opm-tests>, folder `norne/`; original data from the Norne benchmark
of NTNU's IO Center, <http://www.ipt.ntnu.no/~norne>).

The files in this folder (the main deck and the 57 files it includes) are
distributed **unchanged**. Their license, stated in every file header:

> This reservoir simulation deck is made available under the Open Database License:
> <http://opendatacommons.org/licenses/odbl/1.0/>. Any rights in individual contents of the
> database are licensed under the Database Contents License:
> <http://opendatacommons.org/licenses/dbcl/1.0/>.
>
> Copyright (C) 2015 Statoil

Statoil is now Equinor. When you use the data, acknowledge Equinor (operator of Norne) and
its license partners, the Norwegian University of Science and Technology (NTNU) and the
Open Porous Media initiative. The OPM version contains two documented modifications to the
original deck: MULTREGT names FLUXNUM explicitly, and the SWOF/SGOF tables list the critical
saturations explicitly (for three-point end-point scaling).

## The model

| | |
|---|---|
| Grid | 46 × 112 × 22 corner-point (`COORD`/`ZCORN`), 44,431 active cells, 61 named faults with `MULTFLT`, `MULTREGT` between `FLUXNUM` regions, `MULTZ` barriers, `PINCH`, `MINPV` |
| Fluids | three-phase live oil with vaporised oil (`DISGAS`, `VAPOIL`; `PVTO`, `PVTG`, `PVTW`), `METRIC` units, 2 PVT regions |
| Rock | `SWOF`/`SGOF`, `ENDSCALE NODIR REVERS` with three-point scaling (`SCALECRS`), per-cell end points (`SWL`, `SWCR`, `SGU`, ...), `SATOPTS HYSTER` with `EHYSTR` (Carlson), imbibition end points (`ISWL`, `ISGCR`, ...), `IMBNUM` |
| Initialisation | 5 `EQUIL` regions with `RSVD`, `SWATINIT` capillary-pressure scaling, threshold pressures between regions (`EQLOPTS THPRES`, `THPRES`) |
| Wells | 36 wells: history-matched producers (`WCONHIST` with `RESV` and `ORAT` control), water and gas injectors (`WCONINJE`), `GCONINJE` field water-injection limit, `WTEST`, `WELOPEN`, 35 `VFPPROD`/`VFPINJ` tables |
| Other | 7 water tracers (`TRACERS`, `TRACER`, `TVDPF*`, `WTRACER`), `DRSDT`, `VAPPARS`, `WPAVE` |
| Schedule | 6 Nov 1997 – 1 Dec 2006, 247 report dates (`BC0407_HIST01122006.SCH`), `TUNING` 1/10 days |

Run it with `python -m resim run examples/NORNE/NORNE_ATW2013.DATA` or open it from
*File → New from example* in the desktop GUI. The validation of ReSim against the ECLIPSE
2014.2 and OPM Flow results published with the deck is described in the main README.
