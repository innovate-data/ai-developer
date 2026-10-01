# SPE10 Model 1 (Christie & Blunt, 2001)

Model 1 of the Tenth SPE Comparative Solution Project ("Tenth SPE comparative solution project:
a comparison of upscaling techniques", M.A. Christie and M.J. Blunt, SPE Reservoir Evaluation &
Engineering, August 2001), as ECLIPSE decks from the OPM test-data repository
(<https://github.com/OPM/opm-tests>, folder `spe10/`). The files are distributed **unchanged**;
their headers state:

> This reservoir simulation deck is made available under the Open Database License:
> <http://opendatacommons.org/licenses/odbl/1.0/>. Any rights in individual contents of the
> database are licensed under the Database Contents License:
> <http://opendatacommons.org/licenses/dbcl/1.0/>. Copyright (C) 2022 Equinor.
> The permeability data are public domain (SPE comparative solution project data sets).

| Deck | Description |
|---|---|
| `SPE10-MOD01-01.DATA` | three phases (water immobile), Cartesian grid (`DX/DY/DZ/TOPS`) |
| `SPE10-MOD01-02.DATA` | two phases (oil, gas), Cartesian grid |
| `SPE10-MOD01-03.DATA` | three phases, corner-point grid (`include/SPE10-MOD01-GRID.inc`) |
| `SPE10-MOD01-04.DATA` | two phases, corner-point grid |

A 100 × 1 × 20 vertical cross-section (2,500 × 25 × 50 ft) with a heterogeneous permeability field:
gas is injected at 0.2461 Mscf/d (246.1 scf/d) along the left edge and a producer at 95 psia
drains the right edge for 8,000 days in 10-day report steps.

All four decks give the same results in ReSim (two- and three-phase forms agree, and so do the
Cartesian and corner-point grids). Cumulative oil is 29,470 stb at 1,000 days, 33,620 at 2,000,
37,730 at 4,000 and 42,740 at 8,000, on the OPM Flow curve published with the decks
(≈ 30,000 / 33,500 / 37,500 / 42,300 stb) and near the Landmark reference results.

Model 2 (60 × 220 × 85, 1.1 million cells) is not included: its permeability and porosity files
are 76 MB. Get `SPE10-MOD02-01.DATA` / `-02.DATA` and `include/` from the same repository to run it.
