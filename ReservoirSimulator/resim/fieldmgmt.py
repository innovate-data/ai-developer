"""Field management for the black-oil solver (ECLIPSE group control, economics, drilling, networks).

The controls are explicit: before each time step the group targets are turned into well targets
from the wells' current production potentials and the last step's rates; after each converged
step the economic limits are checked.  Supported:

* group production control (``GCONPROD``): targets and limits in ORAT, WRAT, GRAT, LRAT and RESV
  for a group and its subordinate groups, shared between the wells available for group control
  (``WCONPROD 'GRUP'``, or any well whose own targets would exceed its share; ``WGRUPCON``
  unavailable wells keep their own control) in proportion to their guide rates (``WGRUPCON``,
  by default the production potentials).  Limits with procedure ``RATE`` act as further
  targets; ``WELL``, ``CON``, ``+CON`` and ``PLUG`` are workovers on the worst-offending well;
* prioritisation (``GCONPRI``, ``PRIORITY``, ``WELPRI``): wells open in decreasing priority at
  their potential until a limit is reached; the marginal well is cut back and the rest wait;
* drilling queues (``QDRILL`` sequential, ``WDRILPRI`` prioritised): when a group with a
  production target cannot reach it, the next queued well of that group (or a subordinate
  group) is opened;
* group economic limits (``GECON``) with the workovers NONE, CON, +CON, WELL and PLUG, follow-on
  wells (``WECON`` item 9), injector economic limits (``WECONINJ``) and ``WTEST`` re-testing of
  wells closed for economic (E) and group (G) reasons and of closed connections (C);
* sales gas (``GCONSALE``, ``GCONSUMP``): the group's gas injectors re-inject what is left of
  the production after fuel consumption, imports and the sales target; a sales rate above the
  maximum triggers the procedure (WELL, CON, +CON, PLUG, RATE or END);
* the standard production network (``GRUPNET``, ``NETBALAN``): node pressures are computed down
  the group tree from the terminal node with the pipelines' VFP tables and the groups' rates, and
  each producer's THP limit is raised to its group's node pressure.
"""
from __future__ import annotations

import copy

import numpy as np

PHASES = ("ORAT", "WRAT", "GRAT", "LRAT", "RESV")
RATIO_PHASE = {"max_wct": "water", "max_wgr": "water", "max_gor": "gas"}
TOL = 1e-3
NEWTON_TOL = 2e-3       # relative target change that makes a Newton iteration re-share the targets


class FieldManager:
    def __init__(self, solver):
        self.s = solver
        self.opt = {}
        self.drilled = []            # wells opened from a drilling queue (in order)
        self.group_shut = {}         # wells closed by group limits (GECON, GCONPROD/GCONSALE workovers)
        self.opened = set()          # follow-on wells opened by WECON
        self.shut_time = {}          # time a well or connection was closed (for WTEST)
        self.modified = {}           # wells whose targets were changed for the current step
        self.node_pressure = {}      # GRUPNET node pressure per group
        self.sales_cap = {}          # GCONSALE 'RATE': group gas production limits
        self._prio = (None, None)    # (time computed, {well: priority})
        self._net_time = None
        self._pot_step = None        # production potentials at the start of the step
        self._alloc_args = None
        self.messages = []

    # ------------------------------------------------------------------ schedule
    @property
    def active(self):
        o = self.opt
        return bool(o.get("GCONPROD") or o.get("GCONPRI") or o.get("QDRILL") or o.get("WDRILPRI")
                    or o.get("GECON") or o.get("GCONSALE") or o.get("GRUPNET")
                    or any(w.group_control for w in getattr(self.s, "wells", {}).values()))

    def set_options(self, options):
        self.opt = options or {}

    def queue(self):
        """Queued wells not yet drilled: prioritised queue first (highest priority), then QDRILL."""
        pri = self.opt.get("WDRILPRI") or {}
        names = sorted(pri, key=lambda n: -pri[n]["priority"])
        names += [n for n in self.opt.get("QDRILL", []) if n not in pri]
        return [n for n in names if n not in self.drilled]

    def on_setup(self, wells, touched):
        """Apply field-management state to a report step's well set (before the perforations are
        built): queued wells stay closed until drilled, drilled and follow-on wells stay open and
        wells closed by group limits stay closed, unless the schedule sets them in this step."""
        for name in self.queue():               # closed until drilled, whatever the schedule says
            if name in wells:
                wells[name].status = "SHUT"
        for name in list(self.drilled) + sorted(self.opened):
            if name in wells and name not in touched and wells[name].status != "OPEN":
                wells[name].status = "OPEN"
        for name in list(self.group_shut):
            if name not in wells:
                continue
            if name in touched:
                del self.group_shut[name]
                self.shut_time.pop(("G", name), None)
            else:
                wells[name].status = self.group_shut[name]
        self.modified = {}

    # ------------------------------------------------------------------ helpers
    def _log(self, msg):
        self.messages.append(msg)
        self.s.log(f"  t={getattr(self.s, 't_now', 0.0) / 86400.0:10.3f} d  {msg}")

    def _tree(self):
        return getattr(self.s, "groups", {}) or {}

    def _ancestors(self, group):
        tree, out = self._tree(), []
        g = group
        while g is not None and g not in out and len(out) < 100:
            out.append(g)
            g = tree.get(g, "FIELD") if g != "FIELD" else None
        return out

    def _depth(self, group):
        return len(self._ancestors(group))

    def _members(self, group, kind="PROD"):
        s = self.s
        return [n for n in s.perf.names if s.wells[n].kind == kind and
                (group == "FIELD" or group in self._ancestors(s.wells[n].group))]

    def _open_wells(self, group, kind="PROD"):
        return [n for n in self._members(group, kind) if self.s.wells[n].is_open]

    def _rates(self, current=None):
        """Surface rates per well (production positive) and reservoir volume rate: the last
        step's, or `current` (the rates of a Newton iterate, keyed 'o', 'w', 'g', 'resv')."""
        if current is not None:
            nw = self.s.perf.n_wells
            v = {k: np.asarray(getattr(current.get(k), "val", current.get(k, np.zeros(nw))), float)
                 for k in ("o", "w", "g", "resv")}
            v = {k: (a if a.shape == (nw,) else np.zeros(nw)) for k, a in v.items()}
            return {n: {"ORAT": v["o"][i], "WRAT": v["w"][i], "GRAT": v["g"][i], "LRAT": v["o"][i] + v["w"][i],
                        "RESV": v["resv"][i]} for i, n in enumerate(self.s.perf.names)}
        rep = self.s.well_report() if self.s.last_rates else {}
        out = {}
        resv = self.s.last_rates.get("resv") if self.s.last_rates else None
        for i, n in enumerate(self.s.perf.names):
            r = rep.get(n)
            if r is None:
                continue
            out[n] = {"ORAT": r["oil"], "WRAT": r["water"], "GRAT": r["gas"], "LRAT": r["oil"] + r["water"],
                      "RESV": float(resv[i]) if resv is not None else 0.0}
        return out

    def newton_update(self, rate):
        """Within the first NUPCOL Newton iterations: share the group production targets again
        with the iterate's phase ratios and re-set the sales-gas re-injection limits from its
        rates. Returns True when a well target changed."""
        s = self.s
        if s.perf is None or not s.perf.n_wells or not self.active:
            return False
        keys = PHASES + ("RATE",)
        before = {n: ({k: s.wells[n].targets.get(k) for k in keys}, s.controls.get(n)) for n in s.perf.names}
        snap = {n: (copy.deepcopy(s.wells[n].targets), s.wells[n].control, s.controls.get(n),
                    s.orig_controls.get(n), s.wells[n].thp_limit) for n in s.perf.names}
        if self._alloc_args is not None:
            ctrls = {n: (s.controls.get(n), s.orig_controls.get(n)) for n in s.perf.names}
            self._restore()
            self._allocate(*self._alloc_args, drill=False, current=rate)
            if self.opt.get("GRUPNET"):
                self._network()
            for n, (c, o) in ctrls.items():   # only the targets change; the controls switch by themselves
                s.controls[n], s.orig_controls[n] = c, o
        if self.opt.get("GCONSALE"):
            self._sales_gas(self._rates(rate))
            s._group_injection()
        changed = False
        for n, (tb, cb) in before.items():
            w = s.wells[n]
            ctrl_a = s.controls.get(n)
            ta = {k: w.targets.get(k) for k in keys}
            key_b = cb if cb in keys else None
            key_a = ctrl_a if ctrl_a in keys else None
            stop_b = key_b is not None and not tb.get(key_b)
            stop_a = key_a is not None and not ta.get(key_a)
            if stop_a != stop_b:            # never start or stop a well inside the Newton loop
                t, c, ctrl, orig, thp = snap[n]
                w.targets, w.control, w.thp_limit = t, c, thp
                s.controls[n], s.orig_controls[n] = ctrl, orig
                continue
            if ctrl_a != cb or any(abs((ta[k] or 0.0) - (tb[k] or 0.0)) > NEWTON_TOL * max(abs(tb[k] or 0.0), 1e-9)
                                   for k in keys):
                changed = True
        if not changed:                     # small corrections are not worth more Newton iterations
            for n, (t, c, ctrl, orig, thp) in snap.items():
                w = s.wells[n]
                w.targets, w.control, w.thp_limit = t, c, thp
                s.controls[n], s.orig_controls[n] = ctrl, orig
        return changed

    def _potentials(self):
        """Production potential vectors (ORAT, WRAT, GRAT, LRAT, RESV) of the open producers."""
        s = self.s
        pot = s.well_potentials()
        first = s._first_perf()
        Bf = s._resv_factors(s.perf.cell) if s.perf.cell.size else None
        out = {}
        for wi, n in enumerate(s.perf.names):
            d = pot.get(n)
            if d is None or s.wells[n].kind != "PROD":
                continue
            o, w, g = d["WOPP"][0], d["WWPP"][0], d["WGPP"][0]
            resv = 0.0
            k = first[wi]
            if Bf is not None and k >= 0:
                rs, rv = Bf["rs"][k], Bf["rv"][k]
                den = 1.0 - rs * rv
                resv = max(o - rv * g, 0.0) * Bf["bo"][k] / den + max(g - rs * o, 0.0) * Bf["bg"][k] / den \
                    + w * Bf["bw"][k]
            out[n] = {"ORAT": o, "WRAT": w, "GRAT": g, "LRAT": o + w, "RESV": resv}
        return out

    def _set_target(self, name, phase, value, control=True):
        """Give well `name` the rate target `value` in `phase` for this step (restored afterwards)."""
        s = self.s
        w = s.wells[name]
        if name not in self.modified:
            self.modified[name] = (copy.deepcopy(w.targets), w.control, s.controls.get(name),
                                   s.orig_controls.get(name), w.thp_limit)
        w.targets[phase] = value
        # a well at a pressure limit switches to the rate target by itself when it exceeds it
        if control and s.controls.get(name) not in ("BHP", "THP"):
            s.controls[name] = phase
            s.orig_controls[name] = phase

    def _restore(self):
        s = self.s
        for name, (targets, control, ctrl, orig, thp) in self.modified.items():
            w = s.wells[name]
            w.targets = targets
            w.control = control
            w.thp_limit = thp
            if s.controls.get(name) in PHASES or s.controls.get(name) == ctrl:
                s.controls[name] = ctrl
            s.orig_controls[name] = orig
        self.modified = {}

    def _open_well(self, name, why):
        s = self.s
        w = s.wells[name]
        w.status = "OPEN"
        wi = s.perf.names.index(name)
        sel = (s.perf.well == wi) & (s.perf.wi > 0)
        if sel.any():
            p = s.state["p"][s.perf.cell[sel]]
            s.bhp[name] = min(s.bhp.get(name, p.max()), p.max() - 1e5) if w.kind == "PROD" else \
                max(s.bhp.get(name, p.min()), p.min() + 1e5)
        s.controls[name] = w.control
        s.orig_controls[name] = w.control
        self._log(f"{why}: well {name} opened")

    def _shut_well(self, name, why, reason="G"):
        s = self.s
        w = s.wells[name]
        w.status = w.auto_shut if w.auto_shut in ("SHUT", "STOP") else "SHUT"
        if reason == "G":
            self.group_shut[name] = w.status
        else:
            s.econ_shut[name] = w.status
        self.shut_time[(reason, name)] = getattr(s, "t_now", 0.0)
        self._log(f"{why}: well {name} {w.status.lower()}")

    # ------------------------------------------------------------------ worst offenders
    def _ratio(self, r, which):
        o, w, g = max(r["ORAT"], 0.0), max(r["WRAT"], 0.0), max(r["GRAT"], 0.0)
        if which == "water":
            return w / (o + w) if o + w > 0 else 0.0
        return g / o if o > 0 else (np.inf if g > 0 else 0.0)

    def worst_well(self, names, rates, which):
        cand = [n for n in names if n in rates and rates[n]["ORAT"] + rates[n]["WRAT"] + rates[n]["GRAT"] > 0]
        if not cand:
            return None
        return max(cand, key=lambda n: self._ratio(rates[n], which))

    def close_worst_connections(self, name, which, plug):
        """Close the connection of well `name` with the highest water cut (or GOR); with `plug`
        also the connections below it (water) or above it (gas).  Returns the number closed, 0
        when only one connection is left (the caller then closes the well)."""
        s = self.s
        wi = s.perf.names.index(name)
        sel = np.nonzero((s.perf.well == wi) & (s.perf.wi > 0))[0]
        if sel.size <= 1:
            return 0
        n = s.perf.cell.size
        qo = np.maximum(s.last_perf.get("o", np.zeros(n))[sel], 0.0)
        qw = np.maximum(s.last_perf.get("w", np.zeros(n))[sel], 0.0)
        qg = np.maximum(s.last_perf.get("g", np.zeros(n))[sel], 0.0)
        bad = qw / np.maximum(qo + qw, 1e-30) if which == "water" else qg / np.maximum(qo, 1e-30)
        worst = sel[int(np.argmax(bad))]
        close = [worst]
        if plug:
            d0 = s.perf.depth[worst]
            close = [m for m in sel if (s.perf.depth[m] >= d0 if which == "water" else s.perf.depth[m] <= d0)]
            if len(close) == sel.size:            # never plug the whole well back
                close = [worst]
        w = s.wells[name]
        for m in close:
            for c in w.completions:
                if c.status == "OPEN" and c.cell == s.perf.cell[m]:
                    c.status = "SHUT"
                    s.econ_conns.add((name, c.i, c.j, c.k))
            s.perf.wi[m] = 0.0
        self.shut_time[("C", name)] = getattr(s, "t_now", 0.0)
        return len(close)

    def workover(self, names, rates, which, action, why, reason="G"):
        """Apply a workover (CON, +CON, PLUG, WELL) to the worst offender among `names`."""
        if action in ("NONE", "", None):
            return
        name = self.worst_well(names, rates, which)
        if name is None:
            return
        if action in ("CON", "+CON", "PLUG"):
            k = self.close_worst_connections(name, which, plug=action != "CON")
            if k:
                self._log(f"{why}: {name}: closed {k} connection(s)")
                return
        self._shut_well(name, why, reason)

    # ------------------------------------------------------------------ before each time step
    def before_step(self):
        """Turn group targets into well targets (and open queued wells) for the coming step."""
        self._restore()
        s = self.s
        if s.perf is None or not s.perf.n_wells:
            return
        opt = self.opt
        groups_p = {g: c for g, c in (opt.get("GCONPROD") or {}).items()}
        groups_pri = opt.get("GCONPRI") or {}
        needs_alloc = groups_p or groups_pri or self.sales_cap or any(
            s.wells[n].group_control for n in s.perf.names)
        self._pot_step = None
        self._alloc_args = (groups_p, groups_pri) if needs_alloc else None
        if needs_alloc:
            if self._allocate(groups_p, groups_pri):     # a well was drilled: share again with it
                self._restore()
                self._pot_step = None
                self._allocate(groups_p, groups_pri, drill=False)
        if opt.get("GRUPNET"):
            self._network()
        self._sales_gas()

    def _constraints(self, group, c):
        """(phase, rate) targets enforced by sharing for a GCONPROD group."""
        out = []
        if c["mode"] in PHASES and c.get(c["mode"]) is not None:
            out.append((c["mode"], c[c["mode"]]))
        for k in PHASES:
            if k != c["mode"] and c.get(k) is not None and c["proc"].get(k) == "RATE":
                out.append((k, c[k]))
        return out

    def _allocate(self, groups_p, groups_pri, drill=True, current=None):
        s = self.s
        if self._pot_step is None:
            self._pot_step = self._potentials()
        pot = {n: dict(v) for n, v in self._pot_step.items()}
        # phase ratios from the last rates, or the Newton iterate's (potentials at the BHP limit
        # have other GORs and water cuts than the well at its actual rate), size from potentials
        last = self._rates(current)
        for n, pv in pot.items():
            r = last.get(n)
            if r is None or min(r["ORAT"], r["WRAT"], r["GRAT"]) < 0 or r["LRAT"] + r["GRAT"] <= 0:
                continue
            liq = r["ORAT"] + r["WRAT"]
            # phases that matter: a liquid phase above 0.1 % of the liquid, and gas
            sig = [k for k in ("ORAT", "WRAT") if r[k] > 1e-3 * liq] + (["GRAT"] if r["GRAT"] > 0 else [])
            if not sig:
                continue
            m = min(pv[k] / r[k] for k in sig)
            if np.isfinite(m) and m > 0:
                pot[n] = {k: m * r[k] for k in PHASES}
        prods = [n for n in s.perf.names if n in pot and s.wells[n].is_open and s._flowing(n)]
        if not prods:
            return False
        # each well's capacity is f * potential; f starts at the limit from its own rate targets
        f, bind = {}, {}
        for n in prods:
            t = s.wells[n].targets
            fr = 1.0
            for k in PHASES:
                if t.get(k) is not None and pot[n][k] > 0:
                    fr = min(fr, t[k] / pot[n][k])
            f[n] = max(fr, 0.0)
        f0 = dict(f)
        constrained = {n: set() for n in prods}     # phases limited by the groups above each well

        def available(n, group):
            """Is well n available for control by `group` (no intermediate group withholds it)?"""
            w = s.wells[n]
            if w.guide is not None and not w.guide.get("available", True):
                return False
            for g in self._ancestors(w.group):
                if g == group:
                    return True
                c = groups_p.get(g)
                if c is not None and not c.get("available", True) and c["mode"] not in ("NONE", "FLD"):
                    return False
            return True

        raw = self._pot_step                 # guide rates are fixed for the step (start-of-step potentials)

        def guide(n, phase):
            w = s.wells[n]
            if w.guide is not None and w.guide.get("rate") is not None:
                gp = w.guide.get("phase") or phase
                conv = raw[n][phase] / raw[n][gp] if raw[n].get(gp, 0) > 0 else 1.0
                return w.guide["rate"] * (w.guide.get("scale") or 1.0) * conv
            return raw[n][phase]

        def share(group, phase, target):
            members = [n for n in prods if group == "FIELD" or group in self._ancestors(s.wells[n].group)]
            if not members:
                return False
            avail = [n for n in members if available(n, group)]
            for n in avail:
                constrained[n].add(phase)
            fixed = sum(f[n] * pot[n][phase] for n in members if n not in avail)
            cap = {n: f[n] * pot[n][phase] for n in avail}
            room = target - fixed
            if sum(cap.values()) <= room * (1 + 1e-9):
                return sum(cap.values()) + fixed < target * (1 - TOL)       # cannot meet the target
            room = max(room, 0.0)
            alloc, free = {}, [n for n in avail if cap[n] > 0]
            while free:                                    # water filling in proportion to guide rates
                gsum = sum(guide(n, phase) for n in free)
                if gsum <= 0:
                    for n in free:
                        alloc[n] = room / len(free)
                    break
                sat = [n for n in free if room * guide(n, phase) / gsum >= cap[n]]
                if not sat:
                    for n in free:
                        alloc[n] = room * guide(n, phase) / gsum
                    break
                for n in sat:
                    alloc[n] = cap[n]
                    room -= cap[n]
                free = [n for n in free if n not in sat]
            for n in avail:
                a = alloc.get(n, 0.0)
                if pot[n][phase] > 0 and a < cap[n] * (1 - 1e-9):
                    f[n] = a / pot[n][phase]
                    bind[n] = phase
            return False

        unmet = set()
        order = sorted(set(groups_p) | set(groups_pri) | set(self.sales_cap), key=lambda g: -self._depth(g))
        for g in order:
            c = groups_p.get(g)
            if c is not None:
                for phase, target in self._constraints(g, c):
                    if share(g, phase, target) and c["mode"] == phase:
                        unmet.add(g)
            if g in self.sales_cap:
                share(g, "GRAT", self.sales_cap[g])
            if g in groups_pri:
                for n in prods:
                    if g == "FIELD" or g in self._ancestors(s.wells[n].group):
                        constrained[n].update(k for k, p in groups_pri[g]["proc"].items() if p in ("PRI", ""))
                if self._prioritise(g, groups_pri[g], prods, pot, f, bind):
                    unmet.add(g)
        # wells limited by their groups get targets in every phase their groups constrain, so
        # that they stay within all of them whatever their GOR and water cut turn out to be;
        # wells with 'GRUP' control outside any controlled group produce at their own limits
        for n in prods:
            if n in bind and f[n] < f0[n] * (1 - 1e-9):
                ph = bind[n]
                for k in constrained[n] - {ph}:
                    if pot[n][k] > 0:
                        self._set_target(n, k, min(f[n] * pot[n][k], s.wells[n].targets.get(k, np.inf)),
                                         control=False)
                self._set_target(n, ph, f[n] * pot[n][ph])
        if not drill or not unmet:
            return False
        return self._drill(min(unmet, key=self._depth)) is not None       # one well per step

    def _priorities(self, prods, pot):
        t_now = getattr(self.s, "t_now", 0.0)
        pr = self.opt.get("PRIORITY") or {"interval": 0.0, "coef": [0, 1, 0, 0, 1, 0, 0, 0]}
        t0, cached = self._prio
        if cached is not None and t0 is not None and t_now - t0 < pr["interval"] and set(cached) >= set(prods):
            return cached
        a, b, c, d, e, f_, g, h = pr["coef"]
        out = {}
        for n in prods:
            w = self.s.wells[n]
            if w.priority is not None:
                out[n] = w.priority
                continue
            qo, qw, qg = pot[n]["ORAT"], pot[n]["WRAT"], pot[n]["GRAT"]
            den = e + f_ * qo + g * qw + h * qg
            out[n] = (a + b * qo + c * qw + d * qg) / den if den > 0 else 0.0
        self._prio = (t_now, out)
        return out

    def _prioritise(self, group, c, prods, pot, f, bind):
        """GCONPRI: open wells in decreasing priority until a 'PRI' limit is reached."""
        s = self.s
        limits = {k: v for k, v in c["limits"].items() if c["proc"].get(k, "NONE") in ("PRI", "")}
        if not limits:
            return False
        members = [n for n in prods if group == "FIELD" or group in self._ancestors(s.wells[n].group)]
        prio = self._priorities(members, pot)
        cum = {k: 0.0 for k in limits}
        on = self.__dict__.setdefault("_pri_on", {})
        # wells producing at the last allocation keep their place against near-equal priorities
        order = sorted(members, key=lambda n: -prio.get(n, 0.0) * (1.01 if on.get(n) else 1.0))
        total = {k: sum(f[n] * pot[n][k] for n in members) for k in limits}
        cut = False
        for n in order:
            if cut:
                f[n] = 0.0
                bind[n] = next(iter(limits))
                continue
            sc = 1.0
            for k, lim in limits.items():
                q = f[n] * pot[n][k]
                if q > 0 and cum[k] + q > lim:
                    sc = min(sc, max(lim - cum[k], 0.0) / q)
            if sc < 1.0:
                k_bind = min(limits, key=lambda k: (max(limits[k] - cum[k], 0.0) / (f[n] * pot[n][k]))
                             if f[n] * pot[n][k] > 0 else np.inf)
                f[n] *= sc
                bind[n] = k_bind
                cut = True
            for k in limits:
                cum[k] += f[n] * pot[n][k]
        for n in order:
            on[n] = f[n] > 0
        return all(total[k] < lim * (1 - TOL) for k, lim in limits.items())

    def _drill(self, group):
        """Open the next queued well of `group` (or of a group below it)."""
        s = self.s
        for name in self.queue():
            w = s.wells.get(name)
            if w is None or name not in s.perf.names or w.kind != "PROD":
                continue
            if group != "FIELD" and group not in self._ancestors(w.group):
                continue
            self.drilled.append(name)
            self._open_well(name, f"Drilling queue (group {group} below its target)")
            return name
        return None

    # ------------------------------------------------------------------ network
    def _network(self):
        s = self.s
        net = self.opt.get("GRUPNET") or {}
        bal = self.opt.get("NETBALAN") or {}
        t_now = getattr(s, "t_now", 0.0)
        if self._net_time is not None and bal.get("interval", 0.0) > 0 and \
                t_now - self._net_time < bal["interval"] - 1.0 and self.node_pressure:
            pass                                       # keep the node pressures of the last balance
        else:
            rates = self._rates()
            tree = self._tree()
            p = {}
            for g in sorted(net, key=self._depth):
                c = net[g]
                parent = tree.get(g, "FIELD") if g != "FIELD" else None
                if parent in p:
                    t = s.vfp.get(("PROD", c["vfp"])) if c["vfp"] not in (0, 9999) else None
                    if t is None:
                        p[g] = p[parent]
                    else:
                        q = {k: sum(max(rates[n][k], 0.0) for n in self._open_wells(g) if n in rates)
                             for k in ("ORAT", "WRAT", "GRAT")}
                        p[g] = float(t.bhp_from_thp(p[parent], q["ORAT"], q["WRAT"], q["GRAT"], c["alq"])[0])
                elif c.get("pressure"):
                    p[g] = c["pressure"]                        # terminal node
            self.node_pressure = p
            self._net_time = t_now
        # each producer's THP limit is at least its group's node pressure
        for n in s.perf.names:
            w = s.wells[n]
            if w.kind != "PROD" or not w.is_open:
                continue
            node = next((self.node_pressure[g] for g in self._ancestors(w.group) if g in self.node_pressure), None)
            if node is None:
                continue
            if s._vfp_table(w) is not None:
                if node > (w.thp_limit or 0.0):
                    self._set_target(n, "THP", node, control=False)
                    w.thp_limit = node
            elif node > w.targets.get("BHP", 0.0):
                s._log_once(f"GRUPNET: well {n} has no VFP table; its group's node pressure is used "
                            f"as a BHP limit")
                self._set_target(n, "BHP", node, control=False)

    # ------------------------------------------------------------------ sales gas
    def gas_balance(self, group):
        """(consumption, import) rates of a group and the groups below it (GCONSUMP)."""
        cons = self.opt.get("GCONSUMP") or {}
        c = i = 0.0
        for g, v in cons.items():
            if group == "FIELD" or group in self._ancestors(g):
                c += v.get("consumption") or 0.0
                i += v.get("import") or 0.0
        return c, i

    def _sales_gas(self, rates=None):
        """GCONSALE: limit the group's gas injection to production - consumption + import - sales."""
        s = self.s
        sales = self.opt.get("GCONSALE") or {}
        base = dict(self.opt.get("GCONINJE") or {})
        if sales:
            rates = self._rates() if rates is None else rates
            for g, c in sales.items():
                prod = sum(max(rates[n]["GRAT"], 0.0) for n in self._open_wells(g) if n in rates)
                cons, imp = self.gas_balance(g)
                limit = max(prod - cons + imp - (c.get("target") or 0.0), 0.0)
                old = base.get((g, "GAS"))
                if old is not None and old.get("mode") == "RATE" and old.get("RATE") is not None:
                    limit = min(limit, old["RATE"])
                base[(g, "GAS")] = {"mode": "RATE", "RATE": limit, "RESV": None, "REIN": None, "VREP": None,
                                    "control_group": None}
        s.gconinje = base

    # ------------------------------------------------------------------ after each time step
    def after_step(self):
        """Group economic limits, group-limit workovers and sales-gas checks. Returns end_run."""
        s = self.s
        end_run = False
        if s.perf is None or not s.perf.n_wells:
            return False
        rates = self._rates()
        if not rates:
            return False
        for g, e in (self.opt.get("GECON") or {}).items():
            names = [n for n in self._open_wells(g) if n in rates]
            if not names:
                continue
            o = sum(max(rates[n]["ORAT"], 0.0) for n in names)
            w = sum(max(rates[n]["WRAT"], 0.0) for n in names)
            gg = sum(max(rates[n]["GRAT"], 0.0) for n in names)
            why = None
            if e.get("min_orat") and o < e["min_orat"]:
                why = "oil rate below the economic limit"
            elif e.get("min_grat") and gg < e["min_grat"]:
                why = "gas rate below the economic limit"
            if why:
                for n in names:
                    self._shut_well(n, f"GECON {g}: {why}")
                end_run = end_run or e.get("end_run", False)
                continue
            ratios = {"max_wct": w / (o + w) if o + w > 0 else 0.0, "max_gor": gg / o if o > 0 else 0.0,
                      "max_wgr": w / gg if gg > 0 else 0.0}
            u = self.s.m.units
            q = {"max_wct": None, "max_gor": "rs", "max_wgr": "wgr"}
            for k, v in ratios.items():
                if e.get(k) and v > e[k]:
                    fmt = (lambda x: f"{u.from_si(x, q[k]):.4g}") if q[k] else (lambda x: f"{x:.4g}")
                    self.workover(names, rates, RATIO_PHASE[k], e.get("workover", "NONE"),
                                  f"GECON {g}: {k[4:].upper()} {fmt(v)} above {fmt(e[k])}")
                    end_run = end_run or e.get("end_run", False)
                    break
        # GCONPROD limits with a workover procedure
        for g, c in (self.opt.get("GCONPROD") or {}).items():
            names = [n for n in self._open_wells(g) if n in rates]
            for k, which in (("WRAT", "water"), ("GRAT", "gas"), ("LRAT", "water")):
                proc = c["proc"].get(k)
                if c.get(k) is None or k == c["mode"] or proc not in ("WELL", "CON", "+CON", "PLUG"):
                    continue
                q = sum(max(rates[n][k], 0.0) for n in names)
                if q > c[k] * (1 + TOL):
                    self.workover(names, rates, which, proc, f"GCONPROD {g}: {k} above the group limit")
        # sales gas above its maximum
        for g, c in (self.opt.get("GCONSALE") or {}).items():
            names = [n for n in self._open_wells(g) if n in rates]
            prod = sum(max(rates[n]["GRAT"], 0.0) for n in names)
            inj = sum(max(-rates[n]["GRAT"], 0.0) for n in self._open_wells(g, "INJ") if n in rates)
            cons, imp = self.gas_balance(g)
            sales = prod - inj - cons + imp
            if c.get("max") is not None and sales > c["max"] * (1 + TOL):
                proc = c.get("proc", "NONE")
                why = f"GCONSALE {g}: sales gas above its maximum"
                if proc == "RATE":
                    self.sales_cap[g] = max(inj + cons - imp + c["max"], 0.0)
                elif proc == "END":
                    self._log(why + "; run ended")
                    end_run = True
                elif proc in ("WELL", "CON", "+CON", "PLUG"):
                    self.workover(names, rates, "gas", proc, why)
            elif g in self.sales_cap and c.get("max") is not None and sales < c["max"] * (1 - 10 * TOL):
                self.sales_cap[g] *= 1.0 + 0.5 * (c["max"] - sales) / max(c["max"], 1e-30)
            if c.get("min") is not None and sales < c["min"] * (1 - TOL):
                self.s._log_once(f"GCONSALE {g}: sales gas below its minimum (injection already at zero)")
        return end_run

    def follow_on(self, name):
        """WECON item 9: open the follow-on well of a well closed by its economic limits."""
        e = self.s.wells[name].econ or {}
        nxt = e.get("followon")
        if not nxt:
            return
        w = self.s.wells.get(nxt)
        if w is None or nxt not in self.s.perf.names:
            self.s._log_once(f"WECON {name}: follow-on well {nxt} is not defined")
            return
        if not w.is_open:
            self.opened.add(nxt)
            self._open_well(nxt, f"WECON follow-on of {name}")

    # ------------------------------------------------------------------ WTEST
    def well_tests(self, t_now, wells):
        """Re-open wells closed by group limits (reason G) and connections closed by economic
        workovers (reason C) once the WTEST interval has passed."""
        s = self.s
        out = []
        counts = s.__dict__.setdefault("_test_count", {})
        for (reason, name), t0 in list(self.shut_time.items()):
            w = wells.get(name)
            test = getattr(w, "test", None) if w is not None else None
            if not test or reason not in test.get("reasons", "") or reason not in ("G", "C"):
                continue
            if test.get("tests") and counts.get((reason, name), 0) >= test["tests"]:
                continue
            if t_now - t0 < test["interval"] - 1.0:
                continue
            if reason == "G" and name in self.group_shut:
                del self.group_shut[name]
                out.append(name)
            elif reason == "C" and any(c[0] == name for c in s.econ_conns):
                s.econ_conns = {c for c in s.econ_conns if c[0] != name}
                out.append(f"{name} (connections)")
            del self.shut_time[(reason, name)]
            counts[(reason, name)] = counts.get((reason, name), 0) + 1
        return out
