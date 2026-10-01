"""Core tests: parser, AD, EOS, grids, analytical and material-balance checks."""
import os
import sys

import numpy as np
import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
EX = os.path.join(ROOT, "examples")

from resim import ad as A  # noqa: E402
from resim.deck.parser import parse_deck, parse_deck_string, tokenize  # noqa: E402
from resim.grid import Grid, cartesian_corners, hex_volume  # noqa: E402
from resim.model import load_model  # noqa: E402
from resim.props.eos import CubicEOS  # noqa: E402
from resim.results import Results  # noqa: E402
from resim.simulator import SimOptions, run_simulation  # noqa: E402

PSI = 6894.757293168


# ----------------------------------------------------------------------------- parser
def test_tokenizer_comments_and_slash():
    toks = tokenize("DIMENS -- comment\n 10 10 3 / trailing comment\n'A B' 3*0.5 2* /")
    texts = [t.text for t in toks]
    assert texts == ["DIMENS", "10", "10", "3", "/", "A B", "3*0.5", "2*", "/"]
    assert toks[5].quoted


def test_parse_repeat_counts_and_records():
    deck = parse_deck_string("""
RUNSPEC
DIMENS
 2 2 1 /
GRID
PORO
 2*0.2 2*0.3 /
SCHEDULE
WELSPECS
 'P1' 'G' 1 1 1* 'OIL' /
 P2 G 2 2 1000 OIL /
/
TSTEP
 3*10 /
""")
    assert np.allclose(deck.get("PORO").data, [0.2, 0.2, 0.3, 0.3])
    recs = deck.get("WELSPECS").data
    assert len(recs) == 2 and recs[0][4] is None and recs[1][0] == "P2"
    assert np.allclose(deck.get("TSTEP").data, [10, 10, 10])


def test_parse_spe1():
    deck = parse_deck(os.path.join(EX, "SPE1_BLACKOIL.DATA"))
    assert deck.get("DIMENS").data[0][:3] == ["10", "10", "3"]
    pvto = deck.get("PVTO").data[0]
    assert len(pvto) == 9 and len(pvto[-1]) == 7   # Rs + 2 rows of (p, Bo, mu)
    assert deck.get("TITLE").data[0][0] == "SPE1"
    assert not deck.warnings


def test_include_box_equals(tmp_path):
    inc = tmp_path / "perm.inc"
    inc.write_text("PERMX\n 8*100 /\n")
    main = tmp_path / "CASE.DATA"
    main.write_text("""RUNSPEC
DIMENS
 2 2 2 /
OIL
WATER
METRIC
GRID
DX
 8*10 /
DY
 8*10 /
DZ
 8*2 /
TOPS
 4*1000 /
INCLUDE
 'perm.inc' /
PORO
 8*0.25 /
BOX
 1 1 1 2 2 2 /
PERMX
 2*500 /
ENDBOX
EQUALS
 PORO 0.1 2 2 1 2 1 1 /
/
MULTIPLY
 PERMX 2 /
/
COPY
 PERMX PERMY /
/
PROPS
PVTW
 100 1 4E-5 0.5 /
PVCDO
 100 1.1 1E-4 2 /
SWOF
 0.2 0 1 0
 1 1 0 0 /
DENSITY
 800 1000 1 /
SOLUTION
EQUIL
 1000 100 2000 /
SCHEDULE
TSTEP
 1 /
""")
    m = load_model(str(main))
    kx = m.perm[0] / 9.869233e-16
    assert np.allclose(kx, [200, 200, 200, 200, 1000, 200, 1000, 200])
    assert np.allclose(m.perm[1], m.perm[0])
    poro = m.pore_volume / m.grid.volume[m.active_cells]
    assert np.isclose(poro[1], 0.1) and np.isclose(poro[0], 0.25)
    # top of layer 2 derived from layer 1
    assert np.isclose(m.depth[4], 1003.0)


# ----------------------------------------------------------------------------- AD
def test_ad_derivatives():
    x, y = A.initialize([np.array([1.0, 2.0, 3.0]), np.array([4.0, 5.0, 6.0])])

    def f(a, b):
        return a * b + a ** 2 / b - 3.0 / a + (a - b).exp() if isinstance(a, A.AD) else \
            a * b + a ** 2 / b - 3.0 / a + np.exp(a - b)

    z = f(x, y)
    v = np.r_[x.val, y.val]
    num = np.zeros((3, 6))
    for k in range(6):
        h = 1e-6
        v2 = v.copy()
        v2[k] += h
        num[:, k] = (f(v2[:3], v2[3:]) - f(v[:3], v[3:])) / h
    assert np.allclose(z.jac.toarray(), num, atol=1e-4)
    w = A.where(np.array([True, False, True]), x, y)
    assert np.allclose(w.val, [1, 5, 3])


# ----------------------------------------------------------------------------- EOS
def _spe5_eos():
    R = 5.0 / 9.0
    tc = np.array([343.0, 665.7, 913.4, 1111.8, 1270.0, 1380.0]) * R
    pc = np.array([667.8, 616.3, 436.9, 304.0, 200.0, 162.0]) * PSI
    acf = np.array([0.013, 0.1524, 0.3007, 0.4885, 0.65, 0.85])
    mw = np.array([16.04, 44.1, 86.18, 142.29, 206.0, 282.0]) / 1000
    bic = np.zeros((6, 6))
    for i, j, k in [(0, 4, 0.05), (0, 5, 0.05), (1, 4, 0.005), (1, 5, 0.005)]:
        bic[i, j] = bic[j, i] = k
    return CubicEOS(tc, pc, acf, mw, bic), (160 + 459.67) * R


def test_eos_spe5_bubble_point():
    """SPE5 reservoir oil has a published bubble point of ~2302 psia at 160 F."""
    eos, T = _spe5_eos()
    z = np.tile([0.5, 0.03, 0.07, 0.2, 0.15, 0.05], (2, 1))
    fr = eos.flash(z, np.array([2320.0, 2285.0]) * PSI, T)
    assert not fr.two_phase[0] and fr.two_phase[1]


def test_flash_fugacity_equality():
    eos, T = _spe5_eos()
    z = np.array([[0.5, 0.03, 0.07, 0.2, 0.15, 0.05]])
    p = np.array([1500.0 * PSI])
    fr = eos.flash(z, p, T)
    assert fr.two_phase[0] and 0 < fr.V[0] < 1
    lpl, _ = eos.lnphi(fr.x, p, T, "L")
    lpv, _ = eos.lnphi(fr.y, p, T, "V")
    fl = np.log(fr.x) + lpl
    fv = np.log(fr.y) + lpv
    assert np.allclose(fl, fv, atol=1e-7)
    assert np.allclose(z, (1 - fr.V[0]) * fr.x + fr.V[0] * fr.y, atol=1e-10)


# ----------------------------------------------------------------------------- grid
def test_grid_volumes_and_transmissibility():
    nx, ny, nz = 3, 2, 2
    c = cartesian_corners(nx, ny, nz, 10.0, 20.0, 5.0, np.full(nx * ny, 1000.0))
    g = Grid(nx, ny, nz, c)
    assert np.allclose(g.volume, 1000.0)
    assert np.allclose(g.depth[: nx * ny], 1002.5) and np.allclose(g.depth[nx * ny:], 1007.5)
    # half transmissibility in x: k * A / (dx/2) = k * 100 / 5
    assert np.allclose(g.half_trans("I+", np.ones(g.n_cells)), 20.0)
    # a skewed hexahedron keeps its volume (parallelepiped)
    sk = c.copy()
    sk[:, 4:, 0] += 3.0
    assert np.allclose(hex_volume(sk), 1000.0)


# ----------------------------------------------------------------------------- simulations
BL_DECK = """
RUNSPEC
DIMENS
 100 1 1 /
OIL
WATER
METRIC
GRID
DX
 100*1 /
DY
 100*1 /
DZ
 100*1 /
TOPS
 100*1000 /
PORO
 100*0.2 /
PERMX
 100*1000 /
PROPS
PVTW
 100 1.0 1E-8 1.0 0 /
PVCDO
 100 1.0 1E-8 1.0 0 /
DENSITY
 1000 1000 1 /
ROCK
 100 0 /
SWOF
0.0  0.0     1.0    0
0.1  0.01    0.81   0
0.2  0.04    0.64   0
0.3  0.09    0.49   0
0.4  0.16    0.36   0
0.5  0.25    0.25   0
0.6  0.36    0.16   0
0.7  0.49    0.09   0
0.8  0.64    0.04   0
0.9  0.81    0.01   0
1.0  1.0     0.0    0 /
SOLUTION
PRESSURE
 100*100 /
SWAT
 100*0.0 /
SCHEDULE
WELSPECS
 'I' 'G' 1 1 1* 'WATER' /
 'P' 'G' 100 1 1* 'OIL' /
/
COMPDAT
 'I' 1 1 1 1 'OPEN' 1* 1.0E3 /
 'P' 100 1 1 1 'OPEN' 1* 1.0E3 /
/
WCONINJE
 'I' 'WATER' 'OPEN' 'RATE' 0.4 1* 1000 /
/
WCONPROD
 'P' 'OPEN' 'BHP' 5* 100 /
/
TSTEP
 20*1 /
END
"""


def _bl_analytic(x, t_pv):
    """Buckley-Leverett solution for Corey n=2, equal viscosities, Swc=Sor=0."""
    sw = np.linspace(1e-4, 1.0, 20000)
    fw = sw ** 2 / (sw ** 2 + (1 - sw) ** 2)
    dfw = np.gradient(fw, sw)
    # shock: tangent from (0,0)
    tang = fw / sw
    i_s = np.argmin(np.abs(dfw - tang)[sw > 0.3]) + np.nonzero(sw > 0.3)[0][0]
    s_shock = sw[i_s]
    xs = dfw * t_pv
    prof = np.zeros_like(x)
    upper = sw >= s_shock
    for k, xx in enumerate(x):
        if xx <= xs[i_s]:
            # largest saturation whose characteristic reached xx
            cand = sw[upper][xs[upper] >= xx]
            prof[k] = cand.max() if cand.size else 1.0
    return prof


def test_buckley_leverett_against_analytic(tmp_path):
    deck = tmp_path / "BL.DATA"
    deck.write_text(BL_DECK)
    res = run_simulation(str(deck), SimOptions(max_dt_days=0.25, initial_dt_days=0.05))
    sw = res.cell_data["SWAT"][-1]
    t_pv = 0.4 * 20 / (100 * 0.2)             # injected pore volumes
    x = (np.arange(100) + 0.5) / 100.0
    ref = _bl_analytic(x, t_pv)
    err = np.mean(np.abs(sw - ref))
    front_num = x[np.nonzero(sw > 0.3)[0].max()]
    front_ref = x[np.nonzero(ref > 0.3)[0].max()]
    assert err < 0.04, err
    assert abs(front_num - front_ref) < 0.05


def _mb(res, phase):
    s = res.summary
    if phase == "oil":
        return (s["FOIP"][0] - s["FOIP"][-1] - s["FOPT"][-1]) / max(s["FOPT"][-1], 1)
    if phase == "gas":
        return (s["FGIP"][0] + s["FGIT"][-1] - s["FGPT"][-1] - s["FGIP"][-1]) / max(s["FGIT"][-1], 1)
    return (s["FWIP"][0] + s["FWIT"][-1] - s["FWPT"][-1] - s["FWIP"][-1]) / max(s["FWIT"][-1] + s["FWPT"][-1], 1)


def test_spe1_material_balance_and_controls():
    m = load_model(os.path.join(EX, "SPE1_BLACKOIL.DATA"))
    m.schedule = m.schedule[:8]
    res = run_simulation(m)
    s = res.summary
    assert np.allclose(s["FOPR"][1:], 20000.0, rtol=1e-4)
    assert np.allclose(s["FGIR"][1:], 100000.0, rtol=1e-4)
    assert abs(_mb(res, "oil")) < 1e-5 and abs(_mb(res, "gas")) < 1e-5
    assert 4790 < s["FPR"][0] < 4810 and s["FPR"][-1] > s["FPR"][0]


def test_waterflood_example_runs():
    m = load_model(os.path.join(EX, "WATERFLOOD_DEADOIL.DATA"))
    m.schedule = m.schedule[:6]
    res = run_simulation(m)
    assert abs(_mb(res, "oil")) < 1e-5 and abs(_mb(res, "water")) < 1e-5
    assert res.summary["FWIR"][-1] == pytest.approx(600.0, rel=1e-3)


def test_compositional_short_run():
    m = load_model(os.path.join(EX, "SPE5_COMPOSITIONAL.DATA"))
    m.schedule = m.schedule[:1]
    res = run_simulation(m)
    s = res.summary
    assert np.allclose(s["FOPR"][1:], 12000.0, rtol=1e-3)
    assert s["FPR"][-1] < s["FPR"][0]
    z = sum(res.cell_data[k][-1] for k in res.cell_data if k.startswith("ZMF_"))
    assert np.allclose(z[res.active], 1.0, atol=1e-8)


def test_results_roundtrip(tmp_path):
    m = load_model(os.path.join(EX, "SPE1_BLACKOIL.DATA"))
    m.schedule = m.schedule[:2]
    res = run_simulation(m)
    path = tmp_path / "r.npz"
    res.save(path)
    r2 = Results.load(path)
    assert r2.nx == 10 and r2.meta["units"] == "FIELD"
    assert np.allclose(r2.cell_data["PRESSURE"], res.cell_data["PRESSURE"])
    assert set(r2.summary) == set(res.summary)
    csv = tmp_path / "s.csv"
    r2.summary_to_csv(csv)
    assert csv.read_text().startswith("TIME,")


def test_iterative_solver_matches_direct():
    m = load_model(os.path.join(EX, "SPE1_BLACKOIL.DATA"))
    m.schedule = m.schedule[:4]
    r_d = run_simulation(m, SimOptions(linear_solver="direct"))
    m = load_model(os.path.join(EX, "SPE1_BLACKOIL.DATA"))
    m.schedule = m.schedule[:4]
    r_i = run_simulation(m, SimOptions(linear_solver="iterative"))
    assert np.allclose(r_d.cell_data["PRESSURE"][-1], r_i.cell_data["PRESSURE"][-1], rtol=1e-5)
    assert np.allclose(r_d.cell_data["SGAS"][-1], r_i.cell_data["SGAS"][-1], atol=1e-5)


def test_eclipse_output_readable(tmp_path):
    resdata = pytest.importorskip("resdata")  # noqa: F841
    from resdata.grid import Grid as RGrid
    from resdata.resfile import ResdataFile
    from resdata.summary import Summary
    from resim.eclipse_io import write_eclipse
    m = load_model(os.path.join(EX, "CORNERPOINT_DOME.DATA"))
    m.schedule = m.schedule[:2]
    res = run_simulation(m)
    base = str(tmp_path / "DOME")
    write_eclipse(res, base)
    g = RGrid(base + ".EGRID")
    assert (g.get_nx(), g.get_ny(), g.get_nz()) == (20, 20, 5)
    vol = np.array([g.cell_volume(global_index=i) for i in range(0, g.get_global_size(), 97)])
    ref = m.grid.volume[::97] / 0.3048 ** 3
    assert np.allclose(vol, ref, rtol=1e-4)
    s = Summary(base)
    assert np.allclose(s.numpy_vector("FOPR")[1:], res.summary["FOPR"][1:], rtol=1e-5)
    rst = ResdataFile(base + ".UNRST")
    assert rst.num_named_kw("PRESSURE") == res.n_reports


# ----------------------------------------------------------------------------- vaporised oil
def test_gas_condensate_vapoil():
    m = load_model(os.path.join(EX, "GASCOND_VAPOIL.DATA"))
    m.schedule = m.schedule[:6]
    res = run_simulation(m)
    s = res.summary
    cgr0 = s["FOPR"][1] / s["FGPR"][1]                    # stb/Mscf
    assert cgr0 == pytest.approx(0.12, rel=1e-3)          # gas produced at its dew-point Rv
    assert s["FOPR"][-1] / s["FGPR"][-1] < 0.11           # condensate drops out below the dew point
    assert np.nanmax(res.cell_data["SOIL"][-1]) > 0.05
    assert abs(_mb(res, "oil")) < 1e-5
    gas_mb = (s["FGIP"][0] - s["FGPT"][-1] - s["FGIP"][-1]) / s["FGPT"][-1]
    assert abs(gas_mb) < 1e-5


# ----------------------------------------------------------------------------- thermal
THERMAL_BOX = """
RUNSPEC
DIMENS
 6 1 1 /
OIL
WATER
THERMAL
METRIC
GRID
DX
 6*2 /
DY
 6*10 /
DZ
 6*5 /
TOPS
 6*1000 /
PORO
 6*0.25 /
PERMX
 6*100 /
HEATCR
 6*2400 /
THCONR
 6*250 /
PROPS
PVTW
 100 1.0 4.5E-5 0.5 0 /
PVCDO
 100 1.1 1E-4 5 0 /
DENSITY
 850 1000 1 /
ROCK
 100 5E-5 /
SPECHEAT
 0   2.0 4.2 1.0
 300 2.2 4.4 1.1 /
OILVISCT
 20 20
 100 2 /
SWOF
 0.2 0 1 0
 1 1 0 0 /
SOLUTION
PRESSURE
 6*100 /
SWAT
 6*0.3 /
TEMPI
 150 120 90 60 40 20 /
RTEMP
 60 /
SCHEDULE
TSTEP
 10*100 /
END
"""


def test_thermal_closed_box_conserves_energy(tmp_path):
    from resim.initialization import initialize_blackoil
    from resim.solvers.blackoil import BlackOilSolver
    deck = tmp_path / "TBOX.DATA"
    deck.write_text(THERMAL_BOX)
    m = load_model(str(deck))
    s = BlackOilSolver(m, SimOptions(), lambda *_: None)
    s.set_initial_state(initialize_blackoil(m))
    s.setup_wells({})
    e0 = s.accumulation_values(s.state)[0]["e"].sum()
    spread0 = np.ptp(s.state["T"])
    for _ in range(20):
        ok, _, _ = s.step(200 * 86400.0)                   # conduction time scale L^2/alpha ~ 4 years
        assert ok
    e1 = s.accumulation_values(s.state)[0]["e"].sum()
    assert abs(e1 - e0) / e0 < 1e-6                       # no wells: energy is conserved
    assert np.ptp(s.state["T"]) < 0.5 * spread0            # conduction evens out the temperature
    assert np.all(np.diff(s.state["T"]) <= 1e-9)           # and stays monotone from hot to cold


def test_thermal_hot_water_injection():
    m = load_model(os.path.join(EX, "THERMAL_HOTWATER.DATA"))
    m.schedule = m.schedule[:8]
    res = run_simulation(m)
    T = res.cell_data["TEMP"][-1]
    assert 170.0 < np.nanmax(T) <= 180.0 + 1e-3          # injector cell approaches the injection temperature
    assert np.nanmin(T) == pytest.approx(40.0, abs=0.5)   # far field still at reservoir temperature
    assert res.summary["FTEMP"][-1] > res.summary["FTEMP"][0] + 1.0
    assert abs(_mb(res, "oil")) < 1e-5 and abs(_mb(res, "water")) < 1e-5


# ----------------------------------------------------------------------------- CO2 storage
def test_co2_brine_properties():
    from resim.props.co2brine import CO2BrineSystem, spycher_pruess
    s = CO2BrineSystem(323.15, 0.0)
    i = np.argmin(abs(s.p - 150e5))
    assert s.rho_co2[i] == pytest.approx(700.8, rel=0.03)          # NIST, 50 C / 150 bar
    m, y = spycher_pruess(323.15, np.array([100e5, 200e5, 400e5]))
    assert np.allclose(m, [1.07, 1.24, 1.42], rtol=0.06)              # Duan & Sun (2003), pure water
    m_salt, _ = spycher_pruess(323.15, np.array([100e5]), 1.0)
    assert m_salt[0] < 0.85 * m[0]                                   # salting-out


def test_co2_storage_balance_and_trapping():
    m = load_model(os.path.join(EX, "CO2_STORAGE.DATA"))
    m.schedule = m.schedule[:3]
    res = run_simulation(m)
    s = res.summary
    mb = (s["FGIP"][-1] - s["FGIP"][0] - s["FGIT"][-1]) / s["FGIT"][-1]
    assert abs(mb) < 2e-5
    assert s["FCO2M"][-1] == pytest.approx(3.0 * 0.1e6, rel=0.02)    # ~0.1 Mt per year
    assert 0.05 < s["FGIPL"][-1] / s["FGIP"][-1] < 0.6               # part of the CO2 dissolved
    assert abs(s["FGIPL"][-1] + s["FGIPG"][-1] - s["FGIP"][-1]) < 1e-6 * s["FGIP"][-1]
    assert {"SWAT", "SGAS", "RSW", "DENG"} <= set(res.cell_data)


def test_run_limits_and_streaming(tmp_path, monkeypatch):
    """stop_at_day ends the run early with partial results; run_stream's report messages add up
    to the final summary."""
    import json
    from resim import webapi
    monkeypatch.setattr(webapi, "WORK", str(tmp_path))
    text = open(os.path.join(EX, "WATERFLOOD_DEADOIL.DATA")).read()
    msgs = []
    out = json.loads(webapi.run_stream(text, "WF", json.dumps({"stop_at_day": 75}), msgs.append))
    assert out["ok"] and "day 75" in out["stopped"]
    assert msgs[0]["type"] == "log" and any(m["type"] == "run-header" for m in msgs)
    reps = [m for m in msgs if m["type"] == "run-report"]
    assert [r["index"] for r in reps] == list(range(len(reps)))
    assert reps[-1]["time"] == pytest.approx(75.0)
    assert sum(len(r["summary"]) for r in reps) == len(out["summary"]["TIME"])
    assert out["summary"]["TIME"][-1] == pytest.approx(75.0)
    steps = [m for m in msgs if m["type"] == "run-step"]
    assert steps and all(isinstance(s["t"], float) for s in steps)
    json.dumps(msgs)                                  # everything must be JSON-able for postMessage


def test_sensitivity_variants(tmp_path, monkeypatch):
    import json
    from resim import webapi
    monkeypatch.setattr(webapi, "WORK", str(tmp_path))
    spe1 = open(os.path.join(EX, "SPE1_BLACKOIL.DATA")).read()
    wf = open(os.path.join(EX, "WATERFLOOD_DEADOIL.DATA")).read()

    def variant(text, **spec):
        return json.loads(webapi.make_variant(text, json.dumps(spec)))

    r = variant(spe1, kind="multiply", array="PERMX", value=2)
    m0 = load_model(webapi._write_deck(spe1, "A"))
    m1 = load_model(webapi._write_deck(r["deck"], "B"))
    assert r["ok"] and np.allclose(m1.perm[0], 2 * m0.perm[0]) and np.allclose(m1.perm[2], m0.perm[2])
    r = variant(wf, kind="multiply", array="PORV", value=1.1)
    m0 = load_model(webapi._write_deck(wf, "A"))
    m1 = load_model(webapi._write_deck(r["deck"], "B"))
    assert r["ok"] and np.allclose(m1.pore_volume, 1.1 * m0.pore_volume)
    r = variant(spe1, kind="well", well="PROD", target="rate", value=15000)
    assert r["ok"] and r["changes"] == 1 and "'ORAT' 15000 1* 1* 1* 1* 1000 /" in r["deck"]
    r = variant(spe1, kind="well", well="PROD", target="bhp", value=1500)
    assert r["ok"] and "'ORAT' 20000 1* 1* 1* 1* 1500 /" in r["deck"]
    r = variant(wf, kind="well", well="*", target="rate", value=777)
    assert r["ok"] and r["changes"] == 2
    assert not variant(spe1, kind="well", well="NOPE", target="rate", value=1)["ok"]
    assert not variant(spe1, kind="replace", find="@X@", value=1)["ok"]
    r = variant(spe1.replace("20000", "@Q@"), kind="replace", find="@Q@", value=12345)
    assert r["ok"] and "12345" in r["deck"]


def _faulted_deck(throw=2.0, extra_grid="", nz=3):
    """2x1xnz corner-point grid with vertical pillars; the column at i=2 is shifted down by `throw`."""
    coord = []
    for j in range(2):
        for i in range(3):
            x, y = 10.0 * i, 10.0 * j
            coord += [x, y, 0.0, x, y, 100.0]
    z = []
    for k in range(nz):
        for top in (True, False):
            depth = 1000.0 + 4.0 * k + (0.0 if top else 4.0)
            for j in range(1):
                for jj in range(2):
                    for i in range(2):
                        for ii in range(2):
                            z.append(depth + (throw if i == 1 else 0.0))
    return f"""RUNSPEC
DIMENS
 2 1 {nz} /
OIL
WATER
METRIC
START
 1 JAN 2000 /
GRID
COORD
 {' '.join(map(str, coord))} /
ZCORN
 {' '.join(map(str, z))} /
PORO
 {2 * nz}*0.2 /
PERMX
 {2 * nz}*100 /
PERMY
 {2 * nz}*100 /
PERMZ
 {2 * nz}*10 /
{extra_grid}
PROPS
PVTW
 100 1.0 4e-5 0.5 0 /
PVDO
 50 1.0 1.0
 300 0.98 1.0 /
DENSITY
 800 1000 1 /
SWOF
 0.2 0 1 0
 1 1 0 0 /
ROCK
 100 5e-5 /
SOLUTION
EQUIL
 1000 100 2000 0 /
SCHEDULE
TSTEP
 1 /
"""


def test_fault_overlaps_and_nnc():
    from resim.deck.parser import parse_deck_string
    from resim.model import load_model as build_model
    m = build_model(parse_deck_string(_faulted_deck(throw=2.0)))
    tu = m.units.to_si(1.0, "transmissibility")
    # half-cell throw: each cell touches two cells across the fault (same layer and the one above)
    pairs = {(int(m.active_cells[a]), int(m.active_cells[b])) for a, b in zip(m.conn_a, m.conn_b)}
    assert (0, 1) in pairs and (2, 3) in pairs and (2, 1) in pairs and (4, 3) in pairs
    T = {(int(m.active_cells[a]), int(m.active_cells[b])): t / tu for a, b, t in zip(m.conn_a, m.conn_b, m.conn_T)}
    # overlap 2 m x 10 m for both, so equal transmissibilities: k A / (d/2 + d/2) = 100 mD * 20 m2 / 10 m
    assert T[(2, 3)] == pytest.approx(T[(2, 1)], rel=1e-9)
    assert T[(2, 3)] == pytest.approx(0.008527 * 100 * 20 / 10, rel=1e-3)
    # no throw: plain neighbour connections with the full 4 m face
    m0 = build_model(parse_deck_string(_faulted_deck(throw=0.0)))
    T0 = {(int(m0.active_cells[a]), int(m0.active_cells[b])): t / tu for a, b, t in zip(m0.conn_a, m0.conn_b, m0.conn_T)}
    assert T0[(2, 3)] == pytest.approx(2 * T[(2, 3)], rel=1e-9) and (2, 1) not in T0


def test_multflt_and_pinch():
    from resim.deck.parser import parse_deck_string
    from resim.model import load_model as build_model
    faults = "FAULTS\n 'F1' 1 1 1 1 1 3 'X' /\n/\nMULTFLT\n 'F1' 0.1 /\n/\n"
    m = build_model(parse_deck_string(_faulted_deck(throw=2.0, extra_grid=faults)))
    m0 = build_model(parse_deck_string(_faulted_deck(throw=2.0)))
    T = {(int(m.active_cells[a]), int(m.active_cells[b])): t for a, b, t in zip(m.conn_a, m.conn_b, m.conn_T)}
    T0 = {(int(m0.active_cells[a]), int(m0.active_cells[b])): t for a, b, t in zip(m0.conn_a, m0.conn_b, m0.conn_T)}
    for key in ((0, 1), (2, 3), (2, 1)):               # logical and NNC connections across the fault
        assert T[key] == pytest.approx(0.1 * T0[key])
    assert T[(0, 2)] == pytest.approx(T0[(0, 2)])      # vertical connections untouched
    # PINCH: a thin middle layer made inactive is bridged; a thick one is not
    thin = "MINPV\n 1e-3 /\nPINCH\n 0.5 /\nMULTPV\n 2*1 2*1e-9 2*1 /\n"
    mp = build_model(parse_deck_string(_faulted_deck(throw=0.0, extra_grid=thin)))
    pairs = {(int(mp.active_cells[a]), int(mp.active_cells[b])) for a, b in zip(mp.conn_a, mp.conn_b)}
    assert (0, 4) in pairs and (1, 5) in pairs and mp.n_active == 4
    nogap = "MINPV\n 1e-3 /\nPINCH\n 0.5 NOGAP /\nMULTPV\n 2*1 2*1e-9 2*1 /\n"
    mn = build_model(parse_deck_string(_faulted_deck(throw=0.0, extra_grid=nogap)))
    pairs = {(int(mn.active_cells[a]), int(mn.active_cells[b])) for a, b in zip(mn.conn_a, mn.conn_b)}
    assert (0, 4) not in pairs                          # 4 m cells are thicker than the 0.5 m threshold


def _vfp_text():
    return """VFPPROD
  1 1500.0 'OIL' 'WCT' 'GOR' /
  50 100 200 /
  10 90 170 /
  0.1 0.8 /
  0 /
  0 /
  1 1 1 1  20 25 35 /
  1 2 1 1  30 36 48 /
  2 1 1 1  95 100 110 /
  2 2 1 1  110 117 130 /
  3 1 1 1  175 181 192 /
  3 2 1 1  190 198 212 /
/
"""


def test_vfp_table_interpolation_and_inverse():
    from resim.deck.parser import parse_deck_string
    from resim.units import get_units
    from resim.vfp import parse_vfp
    d = parse_deck_string("RUNSPEC\nMETRIC\nSCHEDULE\n" + _vfp_text())
    t = parse_vfp("PROD", d.get("VFPPROD").data, get_units("METRIC"))
    day = 86400.0
    # on a node
    assert t.bhp_from_thp(90e5, 100 / day, 100 / 9 / day, 0)[0] == pytest.approx(100e5)
    # midway in THP and rate at WCT 0.1
    b = t.bhp_from_thp(50e5, 75 / day, 75 / 9 / day, 0)[0]
    assert b == pytest.approx(0.25 * (20 + 25 + 95 + 100) * 1e5)
    # the inverse returns the THP
    for thp in (15e5, 60e5, 150e5, 200e5):            # 200 bar: extrapolated
        for q in (60, 150, 250):
            bb = t.bhp_from_thp(thp, q / day, 0.3 * q / 0.7 / day, 0)
            assert t.thp_from_bhp(bb, q / day, 0.3 * q / 0.7 / day, 0)[0] == pytest.approx(thp, rel=1e-9)


def test_wecon_shuts_well_and_summary_vectors(tmp_path):
    """A water-cut limit shuts a producer for good; WSTAT, WTHP, WBP*, WVPR and FPPO are reported."""
    text = open(os.path.join(EX, "WATERFLOOD_DEADOIL.DATA")).read()
    text = text.replace("WCONPROD\n   'P*'  'OPEN' 'LRAT' 3* 150 1* 120 /\n/",
                        "WCONPROD\n   'P*'  'OPEN' 'LRAT' 3* 150 1* 120 1* 1 /\n/\n" + _vfp_text() +
                        "\nWECON\n  'P1' 1* 1* 0.3 2* 'WELL' /\n/\nGRUPTREE\n 'G' 'FIELD' /\n/\n")
    text = text.replace("SUMMARY", "SUMMARY\nWBP9\n/\nWTHP\n/\nFPPO\nWSTAT\n/\n", 1)
    from resim.simulator import run_simulation
    path = tmp_path / "WF.DATA"
    path.write_text(text)
    res = run_simulation(str(path))
    S = res.summary
    st = S["WSTAT:P1"]
    shut_at = np.argmax(st == 3)
    assert shut_at > 0 and np.all(st[shut_at:] == 3)
    assert S["WWCT:P1"][shut_at - 1] > 0.3 and np.all(S["WOPR:P1"][shut_at + 1:] == 0)
    assert np.all(S["WSTAT:P2"][1:] == 1) and np.all(S["WSTAT:I1"][1:] == 2)
    assert np.all(S["WMVFP:P2"] == 1) and np.all(S["WMVFP:I1"] == 0)
    # THP below BHP and positive while producing; zero for the injector without a table
    assert np.all((S["WTHP:P2"][1:] > 0) & (S["WTHP:P2"][1:] < S["WBHP:P2"][1:])) and np.all(S["WTHP:I1"] == 0)
    for k in ("WBP", "WBP4", "WBP5", "WBP9"):
        assert np.all(S[f"{k}:P2"][1:] > S["WBHP:P2"][1:])
    assert np.allclose(S["WBP5:P2"], 0.5 * (S["WBP:P2"] + S["WBP4:P2"]))
    assert np.all(S["FVPR"][1:] > 0) and "FPPO" in S and "GOPR:G" in S
    assert np.allclose(S["GOPR:G"], S["FOPR"]) and np.allclose(S["FVIR"][1:], S["WVIR:I1"][1:])
    assert not [w for w in res.log if "not produced" in w or "not supported" in w]


BRUGGE = os.path.join(EX, "BRUGGE", "BRUGGE60K_FY-SF-KM-1-1.DATA")


def test_brugge_grid_matches_eclipse():
    """Brugge (TNO): active cells, connections (incl. the 152 fault NNCs), pore volume and the
    initial fluids in place equal ECLIPSE's (values from the ECLIPSE run distributed by TNO)."""
    from resim.initialization import initialize_blackoil
    from resim.simulator import SimOptions
    from resim.solvers.blackoil import BlackOilSolver
    m = load_model(BRUGGE)
    assert not m.warnings or all("inactive" in w for w in m.warnings), m.warnings
    assert m.n_active == 43474 and m.conn_a.size == 122543 and len(m.nnc) == 152
    assert m.pore_volume.sum() == pytest.approx(853894713.0, rel=1e-7)
    assert np.all(np.isfinite(m.conn_T)) and np.all(m.conn_T > 0)
    s = BlackOilSolver(m, SimOptions(), lambda x: None)
    s.set_initial_state(initialize_blackoil(m))
    fs = s.field_state()
    assert fs["FOIP"] == pytest.approx(122256868.0, rel=1e-4)
    assert fs["FWIP"] == pytest.approx(732261424.0, rel=2e-4)
    assert fs["FPR"] / 1e5 == pytest.approx(162.358, abs=0.01)
    assert fs["FPPW"] / 1e5 == pytest.approx(169.999, abs=0.01)
    st = m.schedule[0]
    assert ("PROD", 1) in st.vfp and st.groups.get("GROUP 1") == "FIELD"
    assert st.wells["BR-P-5"].econ["max_wct"] == pytest.approx(0.9)


def test_brugge_first_months_match_eclipse():
    from resim.simulator import SimOptions, run_simulation
    r = run_simulation(BRUGGE, SimOptions(stop_at_day=60))
    S = r.summary
    ref = {"FOPR": 500.364, "FWPR": 8.791, "FPR": 161.913, "WBHP:BR-P-5": 122.229, "WBP:BR-P-5": 150.195,
           "WBP9:BR-P-5": 152.988, "WTHP:BR-P-5": 112.201, "FPPO": 169.324, "FPPW": 169.788, "FVPR": 509.685}
    for k, v in ref.items():
        assert S[k][-1] == pytest.approx(v, rel=4e-3), k
    assert S["WSTAT:BR-P-5"][-1] == 1 and S["WSTAT:BR-P-9"][-1] == 3 and S["WMVFP:BR-P-5"][-1] == 1
