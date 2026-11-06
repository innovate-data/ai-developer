/* Cube Clubhouse - Copyright (c) 2026 Ira Learning LLC. All rights reserved. Proprietary software. See LICENSE, or the Licence page inside the app. */
/*
 * render.js - draws the launch-screen logo (logo.html) into the asset catalog as PNGs at
 * 1x, 2x and 3x, in light and dark, with a transparent background; and the app icon
 * (house.js) as a 1024 x 1024 PNG with no alpha channel, as the App Store requires.
 *
 * The launch screen itself is Info.plist's UILaunchScreen: the LaunchBackground colour
 * with this image centred on it. Run this after changing logo.html:
 *
 *     npm i --no-save playwright-core
 *     npm run build:launch
 */
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const OUT = path.join(HERE, '..', 'CubeClubhouse', 'Assets.xcassets', 'LaunchLogo.imageset');
const ICON = path.join(HERE, '..', 'CubeClubhouse', 'Assets.xcassets', 'AppIcon.appiconset', 'AppIcon.png');
const House = require('./house.js');
const zlib = require('zlib');

// Re-encode a PNG without its alpha channel (colour type 2). Chromium's screenshots are
// RGBA even when every pixel is opaque, and App Store Connect rejects an icon with alpha.
function dropAlpha(png) {
  let at = 8, w = 0, h = 0, type = 0;
  const idat = [];
  while (at < png.length) {
    const len = png.readUInt32BE(at), kind = png.toString('latin1', at + 4, at + 8), data = png.subarray(at + 8, at + 8 + len);
    if (kind === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); type = data[9]; if (data[8] !== 8 || data[12] !== 0) throw new Error('unexpected PNG'); }
    if (kind === 'IDAT') idat.push(data);
    at += 12 + len;
  }
  if (type === 2) return png;
  if (type !== 6) throw new Error('unexpected PNG colour type ' + type);
  const raw = zlib.inflateSync(Buffer.concat(idat)), bpp = 4, stride = w * bpp;
  const out = Buffer.alloc(h * (1 + w * 3));
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let x = 0; x < stride; x++) {                 // undo the row filter
      const a = x >= bpp ? line[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const pred = f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : f === 4 ? (pa <= pb && pa <= pc ? a : pb <= pc ? b : c) : 0;
      line[x] = (line[x] + pred) & 255;
    }
    out[y * (1 + w * 3)] = 0;
    for (let x = 0; x < w; x++) line.copy(out, y * (1 + w * 3) + 1 + x * 3, x * 4, x * 4 + 3);
    prev = line;
  }
  const chunk = (kind, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(kind, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(body) >>> 0 : crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([png.subarray(0, 8), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(out, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
const W = 300, H = 196;
const EXE = process.env.CHROME || [
  '/opt/pw-browsers/chromium',
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].find((f) => fs.existsSync(f));

(async () => {
  const b = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox', '--allow-file-access-from-files'] });
  // the app icon: the house of tiles on its purple ground
  {
    const p = await b.newPage({ viewport: { width: 1024, height: 1024 } });
    await p.setContent('<body style="margin:0">' + House.icon() + '</body>');
    fs.writeFileSync(ICON, dropAlpha(await p.screenshot({ clip: { x: 0, y: 0, width: 1024, height: 1024 } })));
    console.log('wrote AppIcon.png');
    await p.close();
  }
  // ink and shadow for each appearance
  for (const [mode, ink, shadow, rim] of [['light', '#2b3040', '0.18', '0px'], ['dark', '#ebe7dc', '0.45', '0px']]) {
    for (const scale of [1, 2, 3]) {
      const p = await b.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: scale });
      await p.goto('file://' + path.join(HERE, 'logo.html'));
      await p.evaluate(([i, s, r]) => {
        const st = document.documentElement.style;
        st.setProperty('--ink', i); st.setProperty('--sh', s); st.setProperty('--rim', r);
      }, [ink, shadow, rim]);
      await p.evaluate(() => document.fonts.ready);
      if (!(await p.evaluate(() => document.fonts.check('700 33px Fredoka')))) throw new Error('the Fredoka font did not load');
      // nothing may touch the edge of the image, or iOS would show it cut off
      const box = await p.evaluate(() => {
        const r = [...document.querySelectorAll('.face, .word')].map((e) => e.getBoundingClientRect());
        return { top: Math.min(...r.map((x) => x.top)), bottom: Math.max(...r.map((x) => x.bottom)),
                 left: Math.min(...r.map((x) => x.left)), right: Math.max(...r.map((x) => x.right)) };
      });
      if (box.top < 4 || box.bottom > H - 4 || box.left < 4 || box.right > W - 4) throw new Error('the logo touches the edge: ' + JSON.stringify(box));
      const name = 'LaunchLogo' + (mode === 'dark' ? '-dark' : '') + (scale > 1 ? '@' + scale + 'x' : '') + '.png';
      await p.screenshot({ path: path.join(OUT, name), omitBackground: true, clip: { x: 0, y: 0, width: W, height: H } });
      console.log('wrote', name);
      await p.close();
    }
  }
  await b.close();
})().catch((e) => { console.error(e); process.exit(1); });
