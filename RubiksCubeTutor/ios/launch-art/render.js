/* Cube Clubhouse - Copyright (c) 2026 Ira Learning LLC. All rights reserved. Proprietary software. See LICENSE, or the Licence page inside the app. */
/*
 * render.js - draws the launch-screen logo (logo.html) into the asset catalog as PNGs at
 * 1x, 2x and 3x, in light and dark, with a transparent background.
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
const W = 300, H = 196;
const EXE = process.env.CHROME || [
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].find((f) => fs.existsSync(f));

(async () => {
  const b = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox', '--allow-file-access-from-files'] });
  // ink and shadow for each appearance; dark mode also gets a faint rim so the cube's
  // black frame does not vanish into the dark background
  for (const [mode, ink, shadow, rim] of [['light', '#2b3040', '0.18', '0px'], ['dark', '#ebe7dc', '0.45', '2px']]) {
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
