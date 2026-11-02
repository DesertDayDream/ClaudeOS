// Build an independent desktop package. The live legacy exe is never overwritten.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'desktop', 'package.json'));
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('This first desktop release packages the Windows x64 backend. Other platforms need their own backend build.');
let builder, electronVersion;
try { builder = require('electron-builder'); electronVersion = require('electron/package.json').version; require.resolve('electron-updater'); }
catch { throw new Error('Run npm run desktop:setup before building the desktop installer.'); }
const stage = path.join(root, 'dist', 'desktop-app');
const backendDir = path.join(root, '.devdata', 'desktop-build');
// These are fixed build directories inside this repo, never a user-supplied path.
for (const dir of [stage, backendDir]) {
  if (!path.resolve(dir).startsWith(root + path.sep)) throw new Error('Build directory escapes the workspace');
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
}
const backend = path.join(backendDir, 'ClaudeOS-backend.exe');
execFileSync(process.execPath, [path.join(root, 'scripts', 'build-exe.mjs'), backend], { cwd: root, stdio: 'inherit' });
await build({ entryPoints: [path.join(root, 'desktop', 'main.cjs')], outfile: path.join(stage, 'main.cjs'),
  bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron', './policy.cjs'], logLevel: 'info' });
fs.copyFileSync(path.join(root, 'desktop', 'policy.cjs'), path.join(stage, 'policy.cjs'));
const meta = JSON.parse(fs.readFileSync(path.join(root, 'desktop', 'package.json'), 'utf8'));
fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({ name: meta.name, version: meta.version, description: meta.description, author: meta.author, main: 'main.cjs' }, null, 2));
await builder.build({ targets: builder.Platform.WINDOWS.createTarget(process.argv.includes('--dir') ? ['dir'] : ['nsis'], builder.Arch.x64),
  publish: 'never', config: {
    appId: 'com.claudeos.desktop', productName: 'ClaudeOS', electronVersion,
    directories: { app: stage, output: path.join(root, 'dist', 'desktop') },
    files: ['main.cjs', 'policy.cjs', 'package.json'], asar: true, npmRebuild: false,
    extraResources: [{ from: backend, to: 'backend/ClaudeOS-backend.exe' }, { from: path.join(root, 'assets', 'icon.ico'), to: 'icon.ico' }],
    win: { icon: path.join(root, 'assets', 'icon.ico'), artifactName: 'ClaudeOS-Setup-${version}.${ext}' },
    nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true,
      createDesktopShortcut: true, createStartMenuShortcut: true, shortcutName: 'ClaudeOS', deleteAppDataOnUninstall: false },
    publish: [{ provider: 'github', owner: 'DesertDayDream', repo: 'ClaudeOS', releaseType: 'release' }],
  },
});
