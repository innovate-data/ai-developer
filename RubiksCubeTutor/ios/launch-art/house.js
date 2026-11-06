/* Cube Clubhouse - Copyright (c) 2026 Ira Learning LLC. All rights reserved. Proprietary software. See LICENSE, or the Licence page inside the app. */
/*
 * house.js - the Cube Clubhouse mark: a little house built from rounded tiles, on a 5 x 5
 * grid. A stepped roof in warm colours, a body in cool ones, and a doorway left open.
 * One definition, drawn as SVG for the app icon, the favicon and the header, and as
 * 25 grid cells for the launch screen and the loading page.
 *
 *     node ios/launch-art/house.js     prints the SVGs, for pasting where they are used
 */
const ROWS = ['..R..', '.ROR.', 'ROYOR', 'BGWGB', 'BG.GB'];
const COLOURS = { R: '#d3202b', O: '#ff7a00', Y: '#ffd500', B: '#0055d4', W: '#ffffff', G: '#00a651' };

// The tiles as SVG rects in a size x size box. A white tile gets a hairline so it shows on white.
function tiles(size, opts) {
  const o = Object.assign({ gap: 0.028, radius: 0.2, shade: true }, opts || {});
  const n = 5, gap = size * o.gap, t = (size - gap * (n - 1)) / n, r = t * o.radius;
  let out = '';
  ROWS.forEach((row, y) => [...row].forEach((c, x) => {
    if (c === '.') return;
    const X = (x * (t + gap)).toFixed(2), Y = (y * (t + gap)).toFixed(2), T = t.toFixed(2), R = r.toFixed(2);
    out += `<rect x="${X}" y="${Y}" width="${T}" height="${T}" rx="${R}" fill="${COLOURS[c]}"${c === 'W' ? ' stroke="#00000022" stroke-width="' + (t * 0.03).toFixed(2) + '"' : ''}/>`;
    if (o.shade) out += `<rect x="${X}" y="${(y * (t + gap) + t * 0.84).toFixed(2)}" width="${T}" height="${(t * 0.16).toFixed(2)}" rx="${(t * 0.08).toFixed(2)}" fill="#00000020"/>`;
  }));
  return out;
}

// The app icon: the house on the purple ground, 1024 x 1024.
function icon() {
  const S = 1024, m = 640, off = (S - m) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">`
    + '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7470fb"/><stop offset="1" stop-color="#3a2fae"/></linearGradient>'
    + '<filter id="s" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="18" stdDeviation="22" flood-color="#14102e" flood-opacity="0.35"/></filter></defs>'
    + `<rect width="${S}" height="${S}" fill="url(#g)"/><g transform="translate(${off} ${off + 10})" filter="url(#s)">${tiles(m)}</g></svg>`;
}

// The small mark (favicon, header): tiles only, no ground, no shading.
function mark(size) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}">${tiles(size, { gap: 0.04, radius: 0.22, shade: false })}</svg>`;
}

// The favicon: the mark on a rounded purple ground.
function favicon() {
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#5a52e6"/>'
    + `<g transform="translate(4 4)">${tiles(24, { gap: 0.04, radius: 0.22, shade: false })}</g></svg>`;
}

// 25 cells for the CSS grid: <i class="P-R"> for a tile, <i class="P-e"> for an empty cell.
function cells(prefix) {
  return ROWS.join('').split('').map((c) => '<i class="' + prefix + (c === '.' ? 'e' : c) + '"></i>').join('');
}

module.exports = { ROWS, COLOURS, tiles, icon, mark, favicon, cells };
if (require.main === module) {
  console.log('icon:\n' + icon() + '\n\nmark:\n' + mark(30) + '\n\nfavicon:\n' + favicon() + '\n\ncells:\n' + cells('lf-'));
}
