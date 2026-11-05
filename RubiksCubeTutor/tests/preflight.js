/* Cube Clubhouse - Copyright (c) 2026 Ira Learning LLC. All rights reserved. Proprietary software. See LICENSE, or the Licence page inside the app. */
/*
 * preflight.js - the COPPA build guard. The app meets COPPA by collecting nothing
 * (COPPA-REVIEW.md); this refuses any change that would quietly stop that being true.
 *
 *     npm run preflight          (also run by npm test and by ios/release.sh)
 *
 * With comments stripped from the code, it fails on:
 *   - a network request from the page (fetch, XMLHttpRequest, WebSocket, EventSource,
 *     sendBeacon), or from Swift anywhere but UpdateChecker.swift's App Store lookup;
 *   - a box for typing words (only range, number, checkbox, radio and button inputs, and
 *     inputmode="numeric", are allowed; the grown-up gate is a keypad of buttons);
 *   - a link or a way out of the app (http(s), mailto, tel or sms links, window.open,
 *     a jump to another address, UIApplication.open, Safari views), or the App Store
 *     sheet reachable other than through the grown-up gate;
 *   - the camera, the microphone, location, contacts or photos;
 *   - cookies or fingerprinting (device and advertising identifiers, canvas read-back,
 *     the battery, hardware details);
 *   - an analytics, crash-reporting or advertising kit, by its own names;
 *   - a package dependency that has not been reviewed, or a Swift package or pod;
 *   - a missing COPPA Review: js/coppa.js, its page, its route, or the hosted coppa.html.
 *
 * tests/run-tests.js proves each rule catches what it should and passes harmless words.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// Packages that have been reviewed for COPPA. None: the app has no dependencies.
const REVIEWED_PACKAGES = [];

// Strip comments but not strings, so "https://..." in a string is still seen. Good enough
// for this code base; a regex literal holding a quote could confuse it, and would show up
// as a failure here, not as a miss.
function stripComments(text, kind) {
  if (kind === 'html') return text.replace(/<!--[\s\S]*?-->/g, '');
  if (kind === 'plist') return text.replace(/<!--[\s\S]*?-->/g, '');
  if (kind === 'css') return text.replace(/\/\*[\s\S]*?\*\//g, '');     // CSS has no // comments
  return text.replace(/("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
    (m, str) => str || '');
}
const kindOf = (f) => (/\.css$/.test(f) ? 'css' : /\.html$/.test(f) ? 'html' : /\.(plist|xcprivacy)$/.test(f) ? 'plist' : /\.json$/.test(f) ? 'json' : 'code');
const isPage = (f) => /^(index\.html|js\/[^/]+\.js|css\/[^/]+\.css)$/.test(f);
const isSwift = (f) => /\.swift$/.test(f);

// Each rule: which files, what to look for, and what it means.
const RULES = [
  // ---- the network
  { id: 'network', files: isPage, re: /\bfetch\s*\(|\bXMLHttpRequest\b|\bnew\s+WebSocket\b|\bEventSource\b|\bsendBeacon\b|\bimportScripts\b|serviceWorker\.register/,
    why: 'a network request from the page' },
  { id: 'network', files: (f) => isPage(f) && !/\.css$/.test(f), re: /(?:src|href|action)\s*=\s*["']https?:|["']https?:\/\/(?!www\.w3\.org\/2000\/svg["'])/,
    why: 'a web address in the page' },
  { id: 'network', files: (f) => /\.css$/.test(f), re: /url\(\s*["']?(?:https?:)?\/\//, why: 'a stylesheet loading from the web' },
  { id: 'network', files: (f) => isSwift(f) && !/UpdateChecker\.swift$/.test(f), re: /\bURLSession\b|\bNWConnection\b|\bdataTask\b|\bURLRequest\(url:\s*URL\(string:\s*"https?:/,
    why: 'a network request from Swift outside the update check' },
  { id: 'network', files: isSwift, re: /"https?:\/\/(?!itunes\.apple\.com\/lookup")/, why: 'a web address in Swift other than the App Store lookup' },
  // ---- typing
  { id: 'free-text', files: (f) => /\.html$/.test(f) || /\.js$/.test(f), re: /<textarea\b|contenteditable\s*=\s*["']?(?:true|["'])|contentEditable\s*=\s*(?:true|['"]true)|createElement\(\s*['"]textarea|\bprompt\s*\(/i,
    why: 'a box for typing words' },
  { id: 'free-text', files: (f) => /\.html$/.test(f) || /\.js$/.test(f),
    test: (code) => {
      const bad = [];
      for (const m of code.matchAll(/<input\b[^>]*>/gi)) {
        const tag = m[0];
        const type = (/\btype\s*=\s*["']?(\w+)/i.exec(tag) || [, 'text'])[1].toLowerCase();
        if (!['range', 'number', 'checkbox', 'radio', 'button'].includes(type) && !/inputmode\s*=\s*["']numeric["']/i.test(tag)) bad.push(tag);
      }
      for (const m of code.matchAll(/createElement\(\s*['"]input['"]\s*\)|\bel\(\s*['"]input['"]/g)) bad.push(m[0]);
      return bad;
    },
    why: 'an input that takes words (only range, number, checkbox, radio, button or inputmode="numeric")' },
  { id: 'free-text', files: isSwift, re: /\bTextField\s*\(|\bTextEditor\s*\(|\bSecureField\s*\(|\bUITextField\b|\bUITextView\b/, why: 'a box for typing words in Swift' },
  // ---- ways out
  { id: 'links-out', files: (f) => /\.html$/.test(f) || /\.js$/.test(f), re: /href\s*=\s*["'](?:https?:|mailto:|tel:|sms:|\/\/)|\bwindow\.open\s*\(|\blocation\.(?:href\s*=|assign\s*\(|replace\s*\()\s*["'`](?!#)|target\s*=\s*["']_blank/i,
    why: 'a link or a way out of the app' },
  { id: 'links-out', files: isSwift, re: /\bUIApplication\.shared\.open\b|\bopenURL\b|\bSFSafariViewController\b|\bLink\s*\(|\bASWebAuthenticationSession\b/,
    why: 'a way out of the app from Swift' },
  { id: 'links-out', files: isSwift,
    test: (code, f) => {
      const bad = [];
      if (/SKStoreProductViewController|SKOverlay|requestReview/.test(code) && !/UpdateChecker\.swift$/.test(f)) bad.push('the App Store opened outside UpdateChecker');
      if (/UpdateChecker\.swift$/.test(f)) {
        const calls = [...code.matchAll(/\bopenStore\s*\(\s*release\s*\)/g)].length;
        if (calls !== 1 || !/func passGate\(\)[\s\S]*?openStore\(release\)/.test(code) || /\bfunc openStore\b(?![^(]*\(_ release)/.test(code)) bad.push('the App Store sheet is not reached only through passGate');
      }
      if (/CubeClubhouseApp\.swift$/.test(f) && !/GrownUpGate\(onPass:/.test(code)) bad.push('the grown-up gate is missing');
      return bad;
    },
    why: 'the App Store must open only after the grown-up gate' },
  // ---- the senses
  { id: 'sensors', files: isPage, re: /\bgetUserMedia\b|\bmediaDevices\b|\bgeolocation\b|navigator\.contacts\b|\bcapture\s*=\s*["']|\bMediaRecorder\b|webkitSpeechRecognition|\bSpeechRecognition\b/,
    why: 'the camera, microphone, location or contacts' },
  { id: 'sensors', files: isSwift, re: /\bAVCapture\w*|\bAVAudioRecorder\b|\bCLLocationManager\b|\bCNContactStore\b|\bPHPhotoLibrary\b|\bPhotosPicker\b|\bSFSpeechRecognizer\b|\bHKHealthStore\b/,
    why: 'the camera, microphone, location, contacts or photos from Swift' },
  { id: 'sensors', files: (f) => /\.(pbxproj|plist)$/.test(f), re: /NS(?:Camera|Microphone|Location\w*|Contacts|PhotoLibrary\w*|SpeechRecognition|Bluetooth\w*|UserTracking|Health\w*)UsageDescription/,
    why: 'a permission for the camera, microphone, location, contacts, photos or tracking' },
  // ---- identifiers
  { id: 'identifiers', files: isPage, re: /\bdocument\.cookie\b|\btoDataURL\s*\(|\bgetImageData\s*\(|navigator\.(?:plugins|hardwareConcurrency|deviceMemory|getBattery|userAgentData)\b|\bOfflineAudioContext\b|\bRTCPeerConnection\b/,
    why: 'a cookie or a way to fingerprint the device' },
  { id: 'identifiers', files: isSwift, re: /\bidentifierForVendor\b|\badvertisingIdentifier\b|\bASIdentifierManager\b|\bDCDevice\b|\bATTrackingManager\b|\bHTTPCookieStorage\b|\bsetCookie\b/,
    why: 'a device or advertising identifier, tracking or cookies from Swift' },
  // ---- other people's code
  { id: 'sdk', files: (f) => !/\.(json)$/.test(f),
    re: /google-analytics\.com|googletagmanager|\bgtag\s*\(|\bga\s*\(\s*['"](?:create|send)|\bfirebase\b|Firebase\w*|\bmixpanel\b|segment\.(?:io|com)|cdn\.segment|@amplitude|\bamplitude\.(?:getInstance|init|track|logEvent)\b|\bAmplitude\.instance|\bfbq\s*\(|\bFBSDK\w*|connect\.facebook\.net|\bGADMobileAds\b|\bGoogleMobileAds\b|\bAdMob\b|\bAppsFlyer\w*|\bAdjustSDK\b|\bAdjust\.appDidLaunch|\bBranch\.getInstance|\bSentrySDK\b|@sentry\/|\bCrashlytics\b|\bBugsnag\b|\bFlurry\w*|\bimport\s+AdSupport\b|\bimport\s+AppTrackingTransparency\b|\bhotjar\b|\bclarity\.ms\b/,
    why: 'an analytics, crash-reporting or advertising kit' },
];

function checkPackage(text) {
  const bad = [];
  let pkg;
  try { pkg = JSON.parse(text); } catch { return ['package.json does not parse']; }
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies', 'bundledDependencies']) {
    for (const name of Object.keys(pkg[field] || {})) {
      if (!REVIEWED_PACKAGES.includes(name)) bad.push(field + ': ' + name + ' has not been reviewed for COPPA');
    }
  }
  return bad;
}

// files: { 'relative/path': 'contents' }. Returns [{ file, rule, why, found }].
function scan(files) {
  const problems = [];
  const has = (f) => Object.prototype.hasOwnProperty.call(files, f);
  for (const [file, text] of Object.entries(files)) {
    if (file === 'package.json') {
      for (const found of checkPackage(text)) problems.push({ file, rule: 'packages', why: 'an unreviewed dependency', found });
      continue;
    }
    if (/(^|\/)(Podfile|Package\.swift|Cartfile)$/.test(file)) {
      problems.push({ file, rule: 'packages', why: 'a Swift package or pod has not been reviewed', found: file });
      continue;
    }
    const code = stripComments(text, kindOf(file));
    for (const r of RULES) {
      if (!r.files(file)) continue;
      const found = r.test ? r.test(code, file) : (code.match(r.re) ? [code.match(r.re)[0]] : []);
      for (const f of found) problems.push({ file, rule: r.id, why: r.why, found: String(f).slice(0, 80) });
    }
    if (/\.pbxproj$/.test(file) && /XCRemoteSwiftPackageReference|packageProductDependencies = \(\s*[A-F0-9]/.test(code)) {
      problems.push({ file, rule: 'packages', why: 'a Swift package has not been reviewed', found: 'Swift package reference' });
    }
  }
  // the COPPA Review must be there, reachable, and published
  const need = (ok, found) => { if (!ok) problems.push({ file: '(the COPPA Review)', rule: 'coppa-page', why: 'the COPPA Review is missing or unreachable', found }); };
  const html = files['index.html'] || '';
  const app = files['js/app.js'] || '';
  need(has('js/coppa.js') && /checks\s*:\s*\[/.test(files['js/coppa.js']) && /function toHTML/.test(files['js/coppa.js']), 'js/coppa.js with its checks and toHTML');
  need(/<script src="js\/coppa\.js"><\/script>/.test(html), 'index.html loads js/coppa.js');
  need(/<article id="coppa"/.test(html) && /id="coppa-body"/.test(html), 'the COPPA article in index.html');
  need(/data-info="coppa"/.test(html) && /class="foot-links"[\s\S]*?data-info="coppa"/.test(html), 'a COPPA link in the footer');
  need(/INFO_PARTS = \[[^\]]*'coppa'/.test(app) && /COPPA\.toHTML\(/.test(app), 'the coppa route and its drawing in js/app.js');
  need(has('ios/app-store/coppa.html'), 'ios/app-store/coppa.html');
  return problems;
}

// The real files: the page, the iOS app, the project, its plists, and package.json.
function collect(root) {
  const base = root || ROOT;
  const out = {};
  const add = (rel) => { const p = path.join(base, rel); if (fs.existsSync(p)) out[rel] = fs.readFileSync(p, 'utf8'); };
  add('index.html');
  add('package.json');
  add('ios/app-store/coppa.html');
  for (const dir of ['js', 'css']) {
    for (const f of fs.readdirSync(path.join(base, dir))) if (/\.(js|css)$/.test(f)) add(dir + '/' + f);
  }
  for (const f of fs.readdirSync(path.join(base, 'ios', 'CubeClubhouse'))) {
    if (/\.(swift|plist|xcprivacy)$/.test(f)) add('ios/CubeClubhouse/' + f);
  }
  add('ios/CubeClubhouse.xcodeproj/project.pbxproj');
  for (const f of ['Podfile', 'Package.swift', 'Cartfile', 'ios/Podfile', 'ios/Package.swift', 'ios/Cartfile']) add(f);
  return out;
}

module.exports = { scan, collect, stripComments, RULES, REVIEWED_PACKAGES };

if (require.main === module) {
  const files = collect();
  const problems = scan(files);
  if (problems.length) {
    console.error('COPPA preflight FAILED: ' + problems.length + ' problem(s). See COPPA-REVIEW.md.');
    for (const p of problems) console.error('  ' + p.file + ': ' + p.why + '  [' + p.found + ']');
    process.exit(1);
  }
  console.log('COPPA preflight passed: ' + Object.keys(files).length + ' files checked, nothing collects, sends, links out or tracks.');
}
