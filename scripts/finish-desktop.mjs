// Run from a normal Windows terminal: installs dependencies, tests the real
// development shell and packaged app in temporary labs, and builds the installer.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'desktop', 'package.json'));
const npmCli = process.env.npm_execpath;
const output = path.join(root, '.devdata', 'desktop-finish.json');
const report = { started: new Date().toISOString(), steps: [], installed: false, published: false };
const save = () => { fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2)); };

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', windowsHide: true, ...options });
    let timer;
    if (options.timeout) timer = setTimeout(() => { child.kill(); reject(new Error(`Timed out: ${command}`)); }, options.timeout);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`${path.basename(command)} exited ${code ?? signal}`)); });
  });
}
async function step(name, action) {
  console.log(`\n${name}`);
  const result = { name, started: new Date().toISOString() };
  report.steps.push(result); save();
  try { await action(); result.ok = true; }
  catch (error) { result.ok = false; result.error = error.message; throw error; }
  finally { result.finished = new Date().toISOString(); save(); }
}
async function freePort(port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', () => reject(new Error(`Lab port ${port} is already in use. Stop that lab instance and rerun.`)));
    server.listen(port, '127.0.0.1', () => server.close(resolve));
  });
}
async function smoke(command, args, name) {
  await freePort(4800); await freePort(4810);
  const lab = fs.mkdtempSync(path.join(os.tmpdir(), `claudeos-${name}-`));
  const resultFile = path.join(lab, 'smoke.json');
  const data = path.join(lab, 'data'); fs.mkdirSync(data);
  // The existing live app may own Ctrl+Alt+O; the lab deliberately has no global hotkey.
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ hotkey: '', notify: false }));
  report[name] = { lab, resultFile }; save();
  await run(command, args, { timeout: 90000, env: { ...process.env, PORT: '4800', ARTIFACT_PORT: '4810',
    CLAUDEOS_HOME: data, CLAUDE_CONFIG_DIR: path.join(lab, 'claude'), CODEX_HOME: path.join(lab, 'codex'),
    CLAUDEOS_NODE: process.execPath, CLAUDEOS_NO_OPEN: '', CLAUDEOS_DESKTOP_SMOKE: resultFile } });
  if (!fs.existsSync(resultFile)) throw new Error(`Desktop smoke test produced no result. Logs: ${data}`);
  const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  if (!result.ok) throw new Error(`Desktop smoke test failed: ${result.error || JSON.stringify(result)}`);
}
try {
  if (process.platform !== 'win32' || process.arch !== 'x64' || Number(process.versions.node.split('.')[0]) < 24) throw new Error('Use Node 24 or newer on Windows x64.');
  if (!npmCli) throw new Error('Run this command through npm: npm run desktop:finish');
  await step('Install desktop dependencies', () => run(process.execPath, [npmCli, '--prefix', 'desktop', fs.existsSync(path.join(root, 'desktop', 'package-lock.json')) ? 'ci' : 'install']));
  await step('Run shell and security checks', () => run(process.execPath, [npmCli, 'run', 'test:desktop']));
  await step('Run Codex approval protocol checks', () => run(process.execPath, [npmCli, 'run', 'test:codex']));
  await step('Run isolated backend integration check', async () => { await freePort(4800); await freePort(4810); await run(process.execPath, [npmCli, 'run', 'test:desktop-backend']); });
  await step('Test the actual Electron development window and terminal', () => smoke(process.execPath, [require.resolve('electron/cli.js'), path.join(root, 'desktop', 'main.cjs')], 'development'));
  await step('Build Windows installer', () => run(process.execPath, [path.join(root, 'scripts', 'build-desktop.mjs')]));
  await step('Test the packaged app and bundled backend', () => smoke(path.join(root, 'dist', 'desktop', 'win-unpacked', 'ClaudeOS.exe'), [], 'packaged'));
  const { version } = JSON.parse(fs.readFileSync(path.join(root, 'desktop', 'package.json'), 'utf8'));
  report.installer = path.join(root, 'dist', 'desktop', `ClaudeOS-Setup-${version}.exe`);
  if (!fs.existsSync(report.installer)) throw new Error('The expected installer was not created.');
  report.ok = true; report.finished = new Date().toISOString(); save();
  console.log(`\nInstaller built and packaged smoke test passed:\n${report.installer}\n\nQuit the current ClaudeOS from its tray before launching the installed app.\nInstall by opening the installer above. Your brains and chats stay in their existing location.\nReal sign-in and installer-to-installer update checks are still required.\nBuild report: ${output}`);
} catch (error) {
  report.ok = false; report.error = error.message; save();
  console.error(`\nDesktop build stopped: ${error.message}\nReport: ${output}`); process.exitCode = 1;
}
