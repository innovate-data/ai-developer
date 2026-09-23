/* Cube Clubhouse - Copyright (c) 2026 Ira Learning LLC. All rights reserved. Proprietary software. See LICENSE, or the Licence page inside the app. */
/*
 * timer.js - the arithmetic of the speed timer, kept apart from the page so it can be
 * tested on its own.
 *
 * A solve is { ms, pen }: ms is the time on the clock in whole milliseconds, cut to
 * hundredths as a competition timer does, and pen is 0, 2 (two seconds added) or 'DNF'
 * (did not finish). Solves are kept oldest first.
 *
 * Averages follow the World Cube Association rules speedcubers know: an average of 5
 * drops the best and the worst time and takes the mean of the middle three; an average
 * of 12 drops one of each and takes the mean of the middle ten. A DNF counts as the worst
 * time, so one DNF is simply dropped, and two make the whole average a DNF. Averages are
 * rounded to the nearest hundredth.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.RC = root.RC || {}; root.RC.Timer = api; }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DNF = 'DNF';
  // Random-move scrambles long enough to mix each size well: the unofficial standard
  // lengths that timers such as csTimer use for these puzzles.
  const SCRAMBLE_LENGTH = { 2: 11, 3: 25, 4: 40, 5: 60, 6: 80 };
  // Competition inspection: 15 seconds to look. Starting between 15 and 17 adds two
  // seconds; later than that is a DNF.
  const INSPECTION_MS = 15000;
  const INSPECTION_DNF_MS = 17000;

  // A clock reading, cut to hundredths as a competition timer shows it.
  function clockTime(ms) { return Math.max(0, Math.floor(ms / 10) * 10); }

  // What a solve counts for: its time plus any penalty, or Infinity for a DNF.
  function value(s) {
    if (!s || s.pen === DNF) return Infinity;
    return s.ms + (s.pen === 2 ? 2000 : 0);
  }

  // The average of the last n solves, or null when there are fewer than n.
  function average(solves, n) {
    if (!solves || solves.length < n) return null;
    return trimmedMean(solves.slice(-n));
  }
  function trimmedMean(window) {
    const n = window.length;
    const trim = Math.max(1, Math.ceil(n * 0.05));
    const middle = window.map(value).sort((a, b) => a - b).slice(trim, n - trim);
    if (middle.some((v) => v === Infinity)) return Infinity;
    const mean = middle.reduce((a, b) => a + b, 0) / middle.length;
    return Math.round(mean / 10) * 10;
  }

  // The best single time, or null when every solve is a DNF (or there are none).
  function best(solves) {
    let out = Infinity;
    for (const s of solves || []) out = Math.min(out, value(s));
    return out === Infinity ? null : out;
  }

  // The best average of n in a row anywhere in the history: null with fewer than n
  // solves, Infinity when every stretch of n is a DNF average.
  function bestAverage(solves, n) {
    if (!solves || solves.length < n) return null;
    let out = Infinity;
    for (let i = n; i <= solves.length; i++) out = Math.min(out, trimmedMean(solves.slice(i - n, i)));
    return out;
  }

  function stats(solves) {
    return {
      count: (solves || []).length,
      best: best(solves),
      ao5: average(solves, 5),
      ao12: average(solves, 12),
      bestAo5: bestAverage(solves, 5),
      bestAo12: bestAverage(solves, 12),
    };
  }

  // 9.87, 59.99, 1:02.35. Null prints as a dash, Infinity as DNF.
  function format(v) {
    if (v === null || v === undefined) return '–';
    if (v === Infinity) return DNF;
    const cs = Math.floor(v / 10);
    const s = Math.floor(cs / 100);
    const m = Math.floor(s / 60);
    const hund = String(cs % 100).padStart(2, '0');
    return m ? m + ':' + String(s % 60).padStart(2, '0') + '.' + hund : s + '.' + hund;
  }

  // A solve as the list shows it: "12.34", "14.34 (+2)" or "DNF (12.34)".
  function formatSolve(s) {
    if (s.pen === DNF) return DNF + ' (' + format(s.ms) + ')';
    if (s.pen === 2) return format(value(s)) + ' (+2)';
    return format(s.ms);
  }

  // Round tick marks for the progress chart's time axis: whole seconds at a friendly
  // step (1, 2, 5, 10, 15, 30 s, then minutes), covering lo..hi with a little room.
  // Returns { ticks, lo, hi } in milliseconds, with lo and hi on tick marks.
  const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600].map((s) => s * 1000);
  function niceTicks(lo, hi, most) {
    most = most || 5;
    if (!(hi >= lo)) return { ticks: [], lo: 0, hi: 0 };
    if (hi - lo < 1000) { lo -= 500; hi += 500; }          // one time, or all alike
    let step = STEPS[STEPS.length - 1];
    for (const s of STEPS) {
      if (Math.floor(hi / s) - Math.ceil(Math.max(0, lo) / s) + 1 <= most - 1) { step = s; break; }
    }
    const from = Math.max(0, Math.floor(lo / step) * step);
    const to = Math.ceil(hi / step) * step;
    const ticks = [];
    for (let t = from; t <= to + 1e-6; t += step) ticks.push(t);
    return { ticks, lo: from, hi: to };
  }
  // An axis label: whole seconds, or m:ss from a minute up.
  function formatTick(ms) {
    const s = Math.round(ms / 1000);
    return s >= 60 ? Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') : String(s);
  }

  // The penalty earned by starting the solve this long after inspection began.
  function inspectionPenalty(ms) {
    if (ms <= INSPECTION_MS) return 0;
    if (ms <= INSPECTION_DNF_MS) return 2;
    return DNF;
  }

  return {
    DNF, SCRAMBLE_LENGTH, INSPECTION_MS, INSPECTION_DNF_MS,
    clockTime, value, average, best, bestAverage, stats, format, formatSolve, inspectionPenalty,
    niceTicks, formatTick,
  };
});
