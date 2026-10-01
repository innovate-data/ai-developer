# Brugge field (TNO benchmark)

ECLIPSE input deck for ensemble member FY-SF-KM-1-1 of the **Brugge** benchmark model,
prepared by TNO for the SPE Applied Technology Workshop on closed-loop reservoir management
(Brugge, Belgium, June 2008). Source: <https://github.com/TNO/Brugge>
(`BRUGGE60K_FY-SF-KM-1-1_JAN2017.tar.gz`).

The files in this folder are distributed **unchanged**, with their TNO headers, as the deck's
header permits. © 2009-2016 TNO, The Hague, the Netherlands. All rights reserved. The data
set is provided "as is" and for non-commercial use; see the repository above for the full
terms. Please acknowledge TNO when you use it:

* Peters, E., Arts, R.J., Brouwer, G.K., Geel, C.R., Cullick, S., Lorentzen, R.J., Chen, Y.,
  Dunlop, K.N.B., Vossepoel, F.C., Xu, R., Sarma, P., Alhutali, A.H., Reynolds, A.C. (2010).
  Results of the Brugge benchmark study for flooding optimisation and history matching.
  *SPE Res Eval & Eng* 13(3): 391-405. doi:10.2118/119094-PA.
* Peters, E., Chen, Y., Leeuwenburgh, O., Oliver, D.S. (2013). Extended Brugge benchmark case
  for history matching and water flooding optimization. *Computers & Geosciences* 50: 16-24.

## The model

| | |
|---|---|
| Grid | 139 × 48 × 9 corner-point (`SPECGRID`/`COORD`/`ZCORN`), 43,474 active cells, one internal fault (152 non-neighbour connections) |
| Fluids | dead oil and water (`OIL WATER`, `PVDO`, `PVTW`), `METRIC` units |
| Rock | 7 `SWOF` tables with capillary pressure (`SATNUM`), `ROCK` with `ROCKOPTS ... ROCKNUM` |
| Wells | 20 producers (`LRAT` 317.98 sm3/d, BHP ≥ 50 bar, `VFPPROD` table 1 for THP) and 10 water injectors (`RATE` 635.95 sm3/d, BHP ≤ 180 bar), started one per month; `WECON` shuts producers above 90 % water cut |
| Schedule | 1 Jan 2000 – 1 Jan 2010 (37 report dates), `TUNING` 5/30 days |

Run it with `python -m resim run examples/BRUGGE/BRUGGE60K_FY-SF-KM-1-1.DATA` or open it from
*File → New from example* in the desktop GUI. The validation of ReSim against the ECLIPSE
results that TNO distributes with the deck is described in the main README.
