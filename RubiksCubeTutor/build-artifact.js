/*
 * build-artifact.js - generate the single-page version published as a Claude Artifact.
 *
 * The artifact host wraps the page in its own <!doctype>/<html>/<head>/<body>, so the
 * published file must contain only the page's own <title>, <style> and content. The
 * stylesheet is inlined; the scripts stay separate files published alongside the page.
 *
 * Usage: node build-artifact.js   ->  dist/artifact.html
 */
const fs = require('fs');
const path = require('path');

const root = __dirname;
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'css', 'style.css'), 'utf8');

const bodyMatch = html.match(/<body>([\s\S]*)<\/body>/);
if (!bodyMatch) throw new Error('index.html: no <body> found');

// Drop the <script src> tags from the copied body; they are re-emitted below so the
// order stays explicit and a new file cannot be forgotten silently.
const SCRIPTS = ['js/cube.js', 'js/solver.js', 'js/view.js', 'js/lessons.js', 'js/app.js'];
const inHtml = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
if (inHtml.join(',') !== SCRIPTS.join(',')) {
  throw new Error('index.html scripts changed (' + inHtml.join(', ') + '); update SCRIPTS in build-artifact.js');
}
for (const f of SCRIPTS) {
  if (!fs.existsSync(path.join(root, f))) throw new Error('missing script ' + f);
}

const body = bodyMatch[1].replace(/\s*<script src="[^"]+"><\/script>/g, '').trim();
const out = [
  '<title>Cube Buddy</title>',
  '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
  '<link href="https://fonts.googleapis.com/css2?family=Fredoka:wght@400;500;600;700&display=swap" rel="stylesheet">',
  '<style>',
  css.trim(),
  '</style>',
  '',
  body,
  '',
  ...SCRIPTS.map((f) => '<script src="' + f + '"></script>'),
  '',
].join('\n');

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist', 'artifact.html'), out);
console.log('dist/artifact.html written,', (out.length / 1024).toFixed(1), 'KB');
console.log('publish alongside:', SCRIPTS.join(', '));
