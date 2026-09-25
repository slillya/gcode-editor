// Builds the static site into ./public:
//   public/index.html  the whole app in one file (works on any static host)
//   public/admin.html  the report inbox (needs the Worker for its data)
// and build/artifact.html, a page fragment used for claude.ai previews.
// `node scripts/build.mjs --check` fails if ./public is out of date.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const check = process.argv.includes('--check');

const template = read('src/index.html');
const css = read('src/styles.css');
const js = ['src/gcode-core.js', 'src/sample.js', 'src/viewer.js', 'src/app.js'].map(read).join('\n');

for (const [name, code] of [['CSS', css], ['JS', js]]) {
  if (/<\/(script|style)/i.test(code) || code.includes('<!--')) {
    throw new Error(`${name} contains a sequence that would break inline embedding`);
  }
}

const filled = template
  .replace('/*@css*/', () => css.trimEnd())
  .replace('/*@js*/', () => js.trimEnd());
const [, head, body] = filled.split(/<!--@head-->|<!--@body-->/).map((s) => s.trim());

const icon = 'data:image/svg+xml,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 34 34"><rect x="2" y="2" width="30" height="30" rx="4" fill="#13181c"/>' +
  '<path d="M8 9H26" stroke="#ff7a33" stroke-width="2.4" stroke-dasharray="3 2.4"/>' +
  '<path d="M8 15H26V21H8V27H26" fill="none" stroke="#4ea8ff" stroke-width="2.4" stroke-linejoin="round"/></svg>');

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="description" content="Backplot G-code in 3D with rapids, plunges and cuts colour-coded, then speed up slow air moves without changing the toolpath. Runs entirely in your browser.">
<meta name="color-scheme" content="light dark">
<link rel="icon" href="${icon}">
${head}
</head>
<body>
${body}
</body>
</html>
`;

const outputs = {
  'public/index.html': page,
  'public/admin.html': read('src/admin.html'),
};

if (check) {
  const stale = Object.keys(outputs).filter((p) => !existsSync(join(root, p)) || read(p) !== outputs[p]);
  if (stale.length) {
    console.error(`Out of date: ${stale.join(', ')}. Run npm run build.`);
    process.exit(1);
  }
  console.log('public/ is up to date');
} else {
  mkdirSync(join(root, 'public'), { recursive: true });
  mkdirSync(join(root, 'build'), { recursive: true });
  for (const [p, text] of Object.entries(outputs)) writeFileSync(join(root, p), text);
  writeFileSync(join(root, 'build/artifact.html'), `${head}\n${body}\n`);
  console.log(`public/index.html  ${(page.length / 1024).toFixed(1)} KB`);
}
