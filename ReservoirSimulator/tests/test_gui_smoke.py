"""Headless smoke tests for the PyQt5 GUI (resim.gui).

Run with:  QT_QPA_PLATFORM=offscreen python -m pytest tests/test_gui_smoke.py
"""
import os

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ.setdefault("MPLBACKEND", "Agg")

import numpy as np  # noqa: E402
import pytest  # noqa: E402

pytest.importorskip("PyQt5")
pytest.importorskip("matplotlib")

from PyQt5.QtCore import QSettings  # noqa: E402
from PyQt5.QtWidgets import QApplication  # noqa: E402

from resim.deck.parser import parse_deck_string  # noqa: E402
from resim.grid import cartesian_corners  # noqa: E402
from resim.results import Results  # noqa: E402


def make_synthetic_results(nx=10, ny=10, nz=3, nsteps=5, seed=0):
    """A synthetic Results object (no simulator needed)."""
    rng = np.random.default_rng(seed)
    n = nx * ny * nz
    dz = np.repeat([20.0, 30.0, 50.0][:nz] + [40.0] * max(0, nz - 3), nx * ny)
    tops = np.full(nx * ny, 8325.0)
    corners = cartesian_corners(nx, ny, nz, np.full(n, 1000.0), np.full(n, 1000.0), dz, tops)
    active = np.ones(n, bool)
    active[0] = False
    depth = corners[:, :, 2].mean(axis=1)
    times = np.linspace(0, 365.0 * (nsteps - 1) / 4, nsteps)
    dates = [str(np.datetime64("2015-01-01") + int(t)) for t in times]
    p = np.array([4800 - 10 * s + 0.4 * (depth - 8400) + rng.normal(0, 5, n) for s in range(nsteps)])
    sw = np.clip(np.array([0.12 + 0.05 * s * rng.random(n) for s in range(nsteps)]), 0, 1)
    sg = np.clip(np.array([0.02 * s * rng.random(n) for s in range(nsteps)]), 0, 1)
    for a in (p, sw, sg):
        a[:, ~active] = np.nan
    t = np.linspace(0, times[-1], 40)
    r = Results(
        meta={"case": "SYNTH", "title": "synthetic", "units": "FIELD", "fluid_type": "blackoil",
              "phases": ["oil", "water", "gas"], "start_date": "2015-01-01", "component_names": []},
        nx=nx, ny=ny, nz=nz, corners=corners.astype(np.float32), active=active,
        static={"PORO": np.full(n, 0.3, np.float32), "PERMX": np.repeat([500., 50., 200.][:nz] +
                                                                       [100.] * max(0, nz - 3), nx * ny),
                "DEPTH": depth.astype(np.float32)},
        report_times=times, report_dates=dates,
        cell_data={"PRESSURE": p.astype(np.float32), "SWAT": sw.astype(np.float32),
                   "SGAS": sg.astype(np.float32), "SOIL": (1 - sw - sg).astype(np.float32)},
        summary={"TIME": t, "FOPR": 20000 * np.exp(-t / 500), "FGOR": 1.27 + t / 300,
                 "FPR": 4800 - t, "FOPT": np.cumsum(20000 * np.exp(-t / 500)) * (t[1] - t[0]),
                 "WBHP:PROD": 3000 - t, "WBHP:INJ": 5000 + t * 0.5, "WOPR:PROD": 20000 * np.exp(-t / 500),
                 "WGIR:INJ": np.full_like(t, 100000.0)},
        wells=[{"name": "INJ", "kind": "INJ", "i": 0, "j": 0, "completions": [[0, 0, 0]]},
               {"name": "PROD", "kind": "PROD", "i": nx - 1, "j": ny - 1, "completions": [[nx - 1, ny - 1, nz - 1]]}],
        log=["synthetic"])
    return r


@pytest.fixture(scope="module")
def app():
    return QApplication.instance() or QApplication([])


@pytest.fixture
def window(app, tmp_path):
    from resim.gui.main_window import MainWindow
    settings = QSettings(str(tmp_path / "settings.ini"), QSettings.IniFormat)
    w = MainWindow(settings=settings)
    yield w
    w.editor.editor.document().setModified(False)
    w.close()


def test_main_window_and_viewer(window, tmp_path):
    res = make_synthetic_results()
    path = tmp_path / "SYNTH.resim.npz"
    res.save(path)
    assert window.open_results(str(path))
    v = window.viewer
    assert v.prop.count() >= 4
    for prop in ("PRESSURE", "SWAT", "PORO", "DEPTH"):
        v.prop.setCurrentText(prop)
        v.step.setValue(v.step.maximum())
    v.range_mode.setCurrentIndex(1)
    v.range_mode.setCurrentIndex(2)
    v.cmap.setCurrentText("turbo")
    v.set_filter("I", 2, 6)
    v.set_filter("K", 2, 3)
    v.exag.setValue(20)
    assert v._face_cells.size > 0
    v.reset_filter()
    v.mode.setCurrentIndex(1)
    for d in range(3):
        v.slice_dir.setCurrentIndex(d)
        v.slice_index.setValue(2)
        v.step.setValue(1)
    v.mode.setCurrentIndex(0)
    window.viewer.canvas.draw()


def test_exterior_faces():
    from resim.gui.viewer3d import GridGeometry
    res = make_synthetic_results(4, 3, 2)
    g = GridGeometry(res.nx, res.ny, res.nz, res.corners)
    cells, verts = g.exterior_faces(np.ones(g.n, bool))
    # surface faces of a 4x3x2 box: 2*(4*3 + 4*2 + 3*2) = 52
    assert cells.size == 52 and verts.shape == (52, 4, 3)
    cells, polys, _ = g.slice_polygons("I", 1)
    assert cells.size == 3 * 2 and polys.shape == (6, 4, 2)


def test_plots(window, tmp_path):
    res = make_synthetic_results()
    window.load_results(res, "")
    p = window.plots
    p.select_keys(["FOPR", "FGOR", "WBHP:PROD"])
    assert set(p.selected_keys()) == {"FOPR", "FGOR", "WBHP:PROD"}
    p.xaxis.setCurrentIndex(1)
    p.load_comparison(make_synthetic_results(seed=2), "other")
    p.filter.setText("BHP")
    assert p.export_png(str(tmp_path / "plot.png"))
    assert p.export_csv(str(tmp_path / "plot.csv"))
    p.clear_comparison()
    assert p.export_csv(str(tmp_path / "plot2.csv"))


@pytest.mark.parametrize("fluid", ["deadoil", "blackoil", "compositional"])
@pytest.mark.parametrize("units", ["FIELD", "METRIC"])
def test_model_builder_generates_valid_decks(window, fluid, units):
    b = window.builder
    b.fluid.setCurrentIndex(b.fluid.findData(fluid))
    b.units.setCurrentText(units)
    text = b.generate_text()
    deck = parse_deck_string(text)
    names = {k.name for k in deck.keywords}
    assert {"DIMENS", "EQUIL", "WCONPROD", "TSTEP", "SWOF"} <= names
    if fluid == "compositional":
        assert {"COMPS", "TCRIT", "BIC", "WELLSTRE", "WINJGAS"} <= names
    from resim.model import load_model
    model = load_model(deck)
    assert model.n_active > 0
    # generated text goes to the editor
    b._on_generate()
    assert "DIMENS" in window.editor.text()
    window.editor.validate()


def test_deck_editor_outline(window):
    from resim.gui.main_window import EXAMPLES_DIR
    ex = sorted(EXAMPLES_DIR.glob("*.DATA"))
    if not ex:
        pytest.skip("no examples")
    window.new_from_example(str(ex[0]))
    tree = window.editor.outline
    sections = [tree.topLevelItem(i).text(0) for i in range(tree.topLevelItemCount())]
    assert "RUNSPEC" in sections and "SCHEDULE" in sections
    assert window.editor.validate()


def test_run_panel_with_fake_runner(window, tmp_path):
    deck = tmp_path / "FAKE.DATA"
    deck.write_text("RUNSPEC\nEND\n")
    window.editor.open_file(str(deck))

    def fake_runner(path, options, progress, log, should_stop):
        for i in range(3):
            progress((i + 1) / 3, f"step {i}")
            log(f"log {i}")
        return make_synthetic_results()

    window.run_panel.runner = fake_runner
    assert window.run_panel.start(interactive=False)
    app = QApplication.instance()
    import time
    t0 = time.time()
    while window.run_panel.is_running() and time.time() - t0 < 20:
        app.processEvents()
        time.sleep(0.01)
    app.processEvents()
    assert (tmp_path / "FAKE.resim.npz").is_file()
    assert (tmp_path / "FAKE_summary.csv").is_file()
    assert window.viewer.results is not None


def test_run_panel_stop(window, tmp_path):
    import time
    deck = tmp_path / "SLOW.DATA"
    deck.write_text("RUNSPEC\nEND\n")
    window.editor.open_file(str(deck))

    class SimulationAborted(Exception):   # the worker recognises the simulator's exception by name
        pass

    def slow_runner(path, options, progress, log, should_stop):
        for i in range(2000):
            if should_stop():
                raise SimulationAborted("stopped")
            progress(i / 2000, "working")
            time.sleep(0.005)
        return make_synthetic_results()

    rp = window.run_panel
    rp.runner = slow_runner
    assert rp.start(interactive=False)
    app = QApplication.instance()
    t0 = time.time()
    while time.time() - t0 < 0.3:
        app.processEvents()
        time.sleep(0.01)
    rp.stop()
    while rp.is_running() and time.time() - t0 < 20:
        app.processEvents()
        time.sleep(0.01)
    assert not rp.is_running()
    assert "stopped" in rp.progress_msg.text().lower()
    assert not (tmp_path / "SLOW.resim.npz").exists()


def test_viewer_switches_between_grid_sizes(window, tmp_path):
    """Loading results with a different grid must rebuild the cached face geometry."""
    big = make_synthetic_results(nx=10, ny=10, nz=3)
    small = make_synthetic_results(nx=4, ny=3, nz=2)
    for i, res in enumerate((big, small, big)):
        path = tmp_path / f"R{i}.resim.npz"
        res.save(path)
        assert window.open_results(str(path))
        assert window.viewer._face_cells.max() < res.nx * res.ny * res.nz


@pytest.mark.parametrize("units", ["FIELD", "METRIC"])
def test_model_builder_co2_and_thermal(window, units):
    from resim.model import load_model
    b = window.builder
    b.units.setCurrentText(units)
    b.fluid.setCurrentIndex(b.fluid.findData("co2store"))
    deck = parse_deck_string(b.generate_text())
    names = {k.name for k in deck.keywords}
    assert {"CO2STORE", "SGWFN", "SALINITY", "RTEMP", "WCONINJE"} <= names
    model = load_model(deck)
    assert model.co2store and model.phases["gas"]
    # thermal black-oil deck
    b.fluid.setCurrentIndex(b.fluid.findData("blackoil"))
    b.thermal.setChecked(True)
    deck = parse_deck_string(b.generate_text())
    names = {k.name for k in deck.keywords}
    assert {"THERMAL", "HEATCR", "THCONR", "SPECHEAT", "OILVISCT", "WTEMP"} <= names
    assert load_model(deck).thermal is not None
