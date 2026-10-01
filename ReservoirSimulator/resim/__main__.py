"""Command line interface.

    python -m resim run CASE.DATA [--out DIR] [--max-dt 30] [--solver direct|iterative]
    python -m resim check CASE.DATA          # parse + build the model, list warnings
    python -m resim gui [CASE.DATA | CASE.resim.npz]
"""
from __future__ import annotations

import argparse
import os
import sys


def _cmd_run(args):
    from .simulator import SimOptions, run_simulation
    opts = SimOptions(max_dt_days=args.max_dt, initial_dt_days=args.initial_dt, linear_solver=args.solver,
                      newton_tol=args.tol)
    last = [-1]

    def progress(frac, msg):
        pct = int(frac * 100)
        if pct != last[0] and not args.verbose:
            last[0] = pct
            sys.stdout.write(f"\r[{'#' * (pct // 4):25s}] {pct:3d}%  {msg[:60]:60s}")
            sys.stdout.flush()

    def log(msg):
        if args.verbose or not msg.startswith("  t="):
            if not args.verbose:
                sys.stdout.write("\r" + " " * 100 + "\r")
            print(msg)

    res = run_simulation(args.deck, opts, progress=progress, log=log)
    print()
    out_dir = args.out or os.path.dirname(os.path.abspath(args.deck))
    os.makedirs(out_dir, exist_ok=True)
    case = os.path.splitext(os.path.basename(args.deck))[0]
    npz = os.path.join(out_dir, case + ".resim.npz")
    csv = os.path.join(out_dir, case + "_summary.csv")
    res.save(npz)
    res.summary_to_csv(csv)
    print(f"Results written to {npz}\nSummary written to {csv}")
    if not args.no_eclipse:
        from .eclipse_io import write_eclipse
        files = write_eclipse(res, os.path.join(out_dir, case))
        print("ECLIPSE format output: " + ", ".join(os.path.basename(f) for f in files))
    return 0


def _cmd_check(args):
    from .model import load_model
    m = load_model(args.deck)
    print(f"{m.case_name}: {m.grid.nx}x{m.grid.ny}x{m.grid.nz}, {m.n_active} active cells, "
          f"{m.fluid_type}, phases={[k for k, v in m.phases.items() if v]}, units={m.units.name}")
    print(f"{len(m.schedule)} report steps, wells: {sorted({n for s in m.schedule for n in s.wells})}")
    for w in m.warnings:
        print("WARNING:", w)
    return 0


def _cmd_gui(args):
    from .gui import main
    return main([sys.argv[0]] + ([args.file] if args.file else []))


def main(argv=None):
    ap = argparse.ArgumentParser(prog="resim", description="ReSim - ECLIPSE-deck reservoir simulator")
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run", help="run a deck")
    r.add_argument("deck")
    r.add_argument("--out", help="output directory (default: next to the deck)")
    r.add_argument("--max-dt", type=float, default=30.0, help="maximum time step [days]")
    r.add_argument("--initial-dt", type=float, default=1.0, help="initial time step [days]")
    r.add_argument("--solver", choices=["auto", "direct", "iterative"], default="auto")
    r.add_argument("--tol", type=float, default=1e-3, help="Newton CNV tolerance")
    r.add_argument("-v", "--verbose", action="store_true", help="print every time step")
    r.add_argument("--no-eclipse", action="store_true",
                   help="do not write ECLIPSE binary output (EGRID/INIT/UNRST/SMSPEC/UNSMRY)")
    r.set_defaults(func=_cmd_run)
    c = sub.add_parser("check", help="parse a deck and report what will be simulated")
    c.add_argument("deck")
    c.set_defaults(func=_cmd_check)
    g = sub.add_parser("gui", help="start the graphical interface")
    g.add_argument("file", nargs="?")
    g.set_defaults(func=_cmd_gui)
    args = ap.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
