# SPE9 (Killough, 1995)

The Ninth SPE Comparative Solution Project ("Ninth SPE comparative solution project: a
reexamination of black-oil simulation", J.E. Killough, SPE 29110, 1995) as the corner-point ECLIPSE
deck `SPE9_CP.DATA` from the OPM test-data repository (<https://github.com/OPM/opm-tests>, folder
`spe9/`), distributed **unchanged** with its include files `SPE9.GRDECL` and `PERMVALUES.DATA`.
License, from the file headers: Open Database License
(<http://opendatacommons.org/licenses/odbl/1.0/>), contents under the Database Contents License
(<http://opendatacommons.org/licenses/dbcl/1.0/>), Copyright (C) 2015 Statoil.

24 × 25 × 15 corner-point grid (9,000 cells), three-phase live oil (`DISGAS`), one water injector
(5,000 stb/d, BHP ≤ 4,000 psia) and 25 producers at 1,500 stb/d oil (BHP ≥ 1,000 psia), cut to
100 stb/d between days 300 and 360, for 900 days.

Against the ECLIPSE results published with the deck (93 report dates), ReSim's field oil and gas
rates differ by at most 0.5 % and 0.7 % (0.13 % and 0.29 % on average), water rate and GOR by
at most 1.3 % and 1.5 %; well BHPs typically by 0.1 psi (median per-well maximum 12 psi after
day 0); the block vectors BPR (1,1,1) within 7 psi, BGSAT (1,13,1) within 3e-4 and BWSAT (10,25,15)
within 1e-5. No producer goes below its 1,000 psia limit. The full run takes about 7 minutes.
