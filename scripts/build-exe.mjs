// Builds dist/ClaudeOS.exe: one Windows file with Node, the server, the page, the templates,
// the activity hook and the memory server inside (Node's single executable applications).
// Run with `npm run build:exe` (or `npm run build:exe -- <out.exe>` while ClaudeOS.exe is running,
// since Windows won't overwrite it). Recipients only need Claude Code.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import * as ResEdit from 'resedit';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const WORK = path.join(DIST, 'build');
const EXE = process.argv[2] ? path.resolve(process.argv[2]) : path.join(DIST, 'ClaudeOS.exe');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(path.join(WORK, 'www'), { recursive: true });

// 1. the app, the hook, the approval server and the memory server, as one CommonJS file
await build({
  entryPoints: [path.join(ROOT, 'exe-main.mjs')], outfile: path.join(WORK, 'claudeos.cjs'),
  bundle: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'warning',
  define: { 'import.meta.url': '__claudeosUrl' },
  banner: { js: 'const __claudeosUrl = require("node:url").pathToFileURL(__filename).href;' },
});

// 2. the page: three.js bundled into app.js, so no import map is needed
await build({
  entryPoints: [path.join(ROOT, 'public', 'app.js')], outfile: path.join(WORK, 'www', 'app.js'),
  bundle: true, format: 'esm', target: 'es2022', minify: true, external: ['/events.js', '/markdown.js', '/preview.js'], logLevel: 'warning',
});
// desk.js with xterm.js inside (the Terminal tab), and xterm's stylesheet where the page links it
await build({
  entryPoints: [path.join(ROOT, 'public', 'desk.js')], outfile: path.join(WORK, 'www', 'desk.js'),
  bundle: true, format: 'esm', target: 'es2022', minify: true, external: ['/events.js'], logLevel: 'warning',
});
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8').replace(/<script type="importmap">[\s\S]*?<\/script>\s*/, '');
fs.writeFileSync(path.join(WORK, 'www', 'index.html'), html);
const assets = { 'www/index.html': path.join(WORK, 'www', 'index.html'), 'www/app.js': path.join(WORK, 'www', 'app.js'), 'www/desk.js': path.join(WORK, 'www', 'desk.js'),
  'www/vendor/xterm/xterm/css/xterm.css': path.join(ROOT, 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css') };
for (const f of fs.readdirSync(path.join(ROOT, 'public'))) if ((f.endsWith('.js') && !assets[`www/${f}`]) || f.endsWith('.png')) assets[`www/${f}`] = path.join(ROOT, 'public', f);

// node-pty (the Terminal tab's console): its JS and this platform's native parts, unpacked at run time
const PTY = path.join(ROOT, 'node_modules', 'node-pty');
const nodePty = ['package.json'];
(function walk(dir, rel) {
  for (const e of fs.readdirSync(path.join(PTY, dir), { withFileTypes: true })) {
    const r = `${rel}/${e.name}`;
    if (e.isDirectory()) walk(path.join(dir, e.name), r);
    else if (!/\.(map|pdb)$|\.test\.js$/.test(e.name)) nodePty.push(r);
  }
})('lib', 'lib');
(function walk(dir, rel) {
  for (const e of fs.readdirSync(path.join(PTY, dir), { withFileTypes: true })) {
    const r = `${rel}/${e.name}`;
    if (e.isDirectory()) walk(path.join(dir, e.name), r);
    else if (!/\.pdb$/.test(e.name)) nodePty.push(r);
  }
})(path.join('prebuilds', `${process.platform}-${process.arch}`), `prebuilds/${process.platform}-${process.arch}`);
for (const r of nodePty) assets[`node-pty/${r}`] = path.join(PTY, r);

// 3. brain templates
const templates = [];
(function walk(dir, rel) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '__pycache__') continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) walk(path.join(dir, e.name), r);
    else { templates.push(r); assets[`templates/${r}`] = path.join(dir, e.name); }
  }
})(path.join(ROOT, 'templates'), '');
const hash = crypto.createHash('sha1');
for (const f of Object.values(assets).concat(path.join(WORK, 'claudeos.cjs'))) hash.update(fs.readFileSync(f));
const build_ = hash.digest('hex').slice(0, 10);
fs.writeFileSync(path.join(WORK, 'manifest.json'), JSON.stringify({ build: build_, templates, nodePty }));
assets['manifest.json'] = path.join(WORK, 'manifest.json');

// 4. the blob, injected into a copy of this Node
const config = path.join(WORK, 'sea-config.json');
fs.writeFileSync(config, JSON.stringify({ main: path.join(WORK, 'claudeos.cjs'), output: path.join(WORK, 'sea.blob'),
  disableExperimentalSEAWarning: true, useCodeCache: false, useSnapshot: false, assets }, null, 2));
execFileSync(process.execPath, ['--experimental-sea-config', config], { stdio: 'inherit' });
fs.copyFileSync(process.execPath, EXE);
execFileSync(process.execPath, [path.join(ROOT, 'node_modules', 'postject', 'dist', 'cli.js'), EXE, 'NODE_SEA_BLOB', path.join(WORK, 'sea.blob'),
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2', '--overwrite'], { stdio: 'inherit' });
brand(EXE);

// 5. a windowed app, not a console one: flip the PE subsystem from console (3) to GUI (2)
const exe = fs.readFileSync(EXE);
const pe = exe.readUInt32LE(0x3c);
if (exe.toString('latin1', pe, pe + 4) !== 'PE\0\0') throw new Error('not a PE file');
const subsystem = pe + 4 + 20 + 68;
if (exe.readUInt16LE(subsystem) === 3) exe.writeUInt16LE(2, subsystem);
fs.writeFileSync(EXE, exe);

// Node's icon and "Node.js JavaScript Runtime" name swapped for ClaudeOS's (assets/icon.ico, from
// `npm run icon`), so Explorer, the taskbar, Task Manager and the tray all show ClaudeOS.
function brand(file) {
  const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const exe = ResEdit.NtExecutable.from(fs.readFileSync(file), { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(exe);
  const lang = 1033, icon = ResEdit.Data.IconFile.from(fs.readFileSync(path.join(ROOT, 'assets', 'icon.ico')));
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  for (const g of groups) ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, g.id, g.lang, icon.icons.map(i => i.data));
  if (!groups.length) ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, 1, lang, icon.icons.map(i => i.data));
  const [vi = ResEdit.Resource.VersionInfo.createEmpty()] = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
  const [major, minor, patch] = version.split('.').map(Number);
  vi.setFileVersion(major, minor, patch, 0, lang);
  vi.setProductVersion(major, minor, patch, 0, lang);
  for (const t of vi.getAllLanguagesForStringValues()) vi.removeAllStringValues(t);
  vi.setStringValues({ lang, codepage: 1200 }, {
    ProductName: 'ClaudeOS', FileDescription: 'ClaudeOS', InternalName: 'ClaudeOS', OriginalFilename: 'ClaudeOS.exe',
    CompanyName: 'ClaudeOS', FileVersion: version, ProductVersion: version,
    LegalCopyright: 'Includes Node.js, three.js, xterm.js and node-pty (MIT)',
  });
  vi.outputToResourceEntries(res.entries);
  res.outputResource(exe);
  fs.writeFileSync(file, Buffer.from(exe.generate()));
}

console.log(`Built ${EXE} (${(exe.length / 1048576).toFixed(0)} MB, build ${build_})`);
