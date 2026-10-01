# SPE3 (Kenyon & Behie, 1987)

The Third SPE Comparative Solution Project, gas cycling of a retrograde condensate reservoir
("Third SPE comparative solution project: gas cycling of retrograde condensate reservoirs",
D.E. Kenyon and G.A. Behie, JPT, August 1987), as the black-oil ECLIPSE decks `SPE3CASE1.DATA`
and `SPE3CASE2.DATA` from the OPM test-data repository (<https://github.com/OPM/opm-tests>,
folder `spe3/`), distributed **unchanged**. License, from the file headers: Open Database
License (<http://opendatacommons.org/licenses/odbl/1.0/>), contents under the Database Contents
License (<http://opendatacommons.org/licenses/dbcl/1.0/>), Copyright (C) 2015 Statoil.

9 × 9 × 4 grid, gas condensate with vaporised oil (`VAPOIL`, `DISGAS`, `PVTG` with one
undersaturated branch, dew point 3,427.6 psia), initial pressure 3,550 psia at the gas-water
contact. A producer at 6,200 Mscf/d (BHP ≥ 500 psia) and a dry-gas injector (4,700 Mscf/d in
case 1, 5,700 in case 2) cycle gas for 9 years, then the field is blown down for 6 years.

Against the ECLIPSE results published with the decks ReSim's well BHPs differ by 1.0-1.3 psi on
average (at most 3.9 and 5.1 psi), cumulative oil by 0.03 % and 0.1 %, the oil rate by at most
0.3 % and 1.5 %, the water rate by at most 1.3 % and 2 %, and the block Rs by at most 0.001.
Each case runs in about 45 seconds.

Two things this case exercises: water in the gas zone is in equilibrium with gas
(Pcow(Sw) + Pcgo(1 - Sw) = pg - pw), and PVTG nodes without undersaturated data take the
branch of the next node, shifted in Rv (dry injected gas would otherwise get the wet gas's Bg).
