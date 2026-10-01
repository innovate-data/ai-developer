"""Interactive pyvista/VTK viewer for saved results, run as a separate process:

    python -m resim.gui.vtk_view results.npz [PROPERTY] [STEP] [--exaggeration 5] [--cmap viridis]

The window shows the active cells as VTK hexahedra (depth pointing down), the
wells as tubes, and a slider to change the report step of dynamic properties.
`build_grid` is importable on its own (no window) for scripting and tests.
"""
from __future__ import annotations

import argparse
import sys

import numpy as np

# Our corner numbering is c = di + 2*dj + 4*dk with k (depth) increasing downward.
# VTK hexahedra list the bottom face counter-clockwise (seen from +z) first, then the top face.
# After flipping z (z = -depth) the deeper face (dk = 1) is the bottom one, so the VTK order
# is 4,5,7,6 followed by 0,1,3,2.  This yields positive cell volumes.
VTK_HEX_ORDER = np.array([4, 5, 7, 6, 0, 1, 3, 2])


def build_grid(results, prop=None, step=0, exaggeration=1.0):
    """pyvista.UnstructuredGrid of the active cells, with `prop` (if given) as cell data."""
    import pyvista as pv

    n = results.nx * results.ny * results.nz
    corners = np.asarray(results.corners, float).reshape(n, 8, 3)
    active = np.asarray(results.active, bool).ravel()
    cells_idx = np.flatnonzero(active)
    pts = corners[cells_idx].reshape(-1, 3).copy()
    pts[:, 2] = -pts[:, 2] * exaggeration
    conn = (np.arange(cells_idx.size)[:, None] * 8 + VTK_HEX_ORDER[None, :])
    cells = np.hstack([np.full((cells_idx.size, 1), 8), conn]).ravel()
    celltypes = np.full(cells_idx.size, pv.CellType.HEXAHEDRON, dtype=np.uint8)
    grid = pv.UnstructuredGrid(cells, celltypes, pts)
    grid.cell_data["I"] = (cells_idx % results.nx + 1).astype(np.int32)
    grid.cell_data["J"] = ((cells_idx // results.nx) % results.ny + 1).astype(np.int32)
    grid.cell_data["K"] = (cells_idx // (results.nx * results.ny) + 1).astype(np.int32)
    if prop:
        grid.cell_data[prop] = np.asarray(results.get_cell_array(prop, step), float).ravel()[cells_idx]
        grid.set_active_scalars(prop)
    return grid, cells_idx


def well_lines(results, exaggeration=1.0):
    """[(name, kind, pyvista.PolyData line)] for the wells (from surface above the model to the deepest completion)."""
    import pyvista as pv

    n = results.nx * results.ny * results.nz
    corners = np.asarray(results.corners, float).reshape(n, 8, 3)
    top = corners[..., 2].min()
    span = max(corners[..., 2].max() - top, 1e-6)
    out = []
    for w in results.wells:
        comps = w.get("completions") or [[w.get("i", 0), w.get("j", 0), 0]]
        idx = [int(c[0]) + results.nx * (int(c[1]) + results.ny * int(c[2])) for c in comps]
        x, y = corners[idx[0]].mean(axis=0)[:2]
        zb = corners[idx][..., 2].max()
        z0 = top - 0.25 * span
        line = pv.Line((x, y, -z0 * exaggeration), (x, y, -zb * exaggeration))
        out.append((str(w.get("name", "")), str(w.get("kind", "")), line))
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description="Interactive VTK view of ReSim results")
    ap.add_argument("results")
    ap.add_argument("property", nargs="?", default=None)
    ap.add_argument("step", nargs="?", type=int, default=0)
    ap.add_argument("--exaggeration", type=float, default=1.0)
    ap.add_argument("--cmap", default="viridis")
    args = ap.parse_args(argv)

    import pyvista as pv

    from ..results import Results

    res = Results.load(args.results)
    prop = args.property or ("PRESSURE" if "PRESSURE" in res.cell_data else
                             (res.cell_property_names() or [None])[0])
    dynamic = prop in res.cell_data
    nsteps = res.n_reports if dynamic else 1
    step = int(np.clip(args.step, 0, max(0, nsteps - 1)))
    grid, cells_idx = build_grid(res, prop, step, args.exaggeration)

    if dynamic:
        allv = np.asarray(res.cell_data[prop], float)[:, cells_idx]
    else:
        allv = np.asarray(res.get_cell_array(prop), float)[cells_idx][None, :]
    finite = allv[np.isfinite(allv)]
    clim = (float(finite.min()), float(finite.max())) if finite.size else (0.0, 1.0)

    title = f"{res.meta.get('case', '')} - {prop}"
    pl = pv.Plotter(title=title)
    pl.add_mesh(grid, scalars=prop, cmap=args.cmap, clim=clim, show_edges=True, edge_color="#333333",
                line_width=0.3, nan_color="lightgray", scalar_bar_args={"title": prop})
    for name, kind, line in well_lines(res, args.exaggeration):
        color = "royalblue" if kind.upper().startswith("INJ") else "black"
        pl.add_mesh(line.tube(radius=0.004 * max(grid.length, 1e-6)), color=color)
        pl.add_point_labels([line.points[0]], [name], font_size=14, text_color=color, shape=None,
                            always_visible=True)
    text = pl.add_text("", position="upper_left", font_size=10)

    def set_step(value):
        s = int(round(value))
        grid.cell_data[prop] = allv[s] if dynamic else allv[0]
        date = str(res.report_dates[s])[:10] if s < len(res.report_dates) else ""
        text.SetText(2, f"{prop}  step {s}  {date}" if dynamic else f"{prop} (static)")
        pl.render()

    set_step(step)
    if dynamic and nsteps > 1:
        pl.add_slider_widget(set_step, [0, nsteps - 1], value=step, title="Report step", fmt="%.0f",
                             pointa=(0.25, 0.92), pointb=(0.75, 0.92))
    pl.show_axes()
    pl.show()
    return 0


if __name__ == "__main__":
    sys.exit(main())
