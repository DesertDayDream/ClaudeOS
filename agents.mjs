// Finding the AI agents ClaudeOS runs on (Claude Code, Codex) on any PC, however they were installed,
// and installing them with their makers' own installers.
//
// ClaudeOS starts from the Start menu with the PATH Windows had when the user signed in, so an agent
// installed after that (or by our own Install button) isn't on it. refreshPath() reads the current PATH
// from the registry and adds the folders the official installers use, so every later `spawn('claude')`
// in this process (chats, employees, plugins, sign-in) finds it without restarting ClaudeOS.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WIN = process.platform === 'win32';
const home = os.homedir();
const LOCAL = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
const ROAMING = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
export const codexHome = () => process.env.CODEX_HOME || path.join(home, '.codex');

// Where the official installers put each agent, besides what PATH says.
const knownDirs = () => [
  path.join(home, '.local', 'bin'),                              // Claude Code's native installer
  path.join(LOCAL, 'Programs', 'OpenAI', 'Codex', 'bin'),        // Codex's standalone installer
  path.join(ROAMING, 'npm'),                                     // npm -g (both)
  path.join(LOCAL, 'Microsoft', 'WinGet', 'Links'),              // winget
  ...claudeNpmBinDirs(),
];

// An npm install of Claude Code puts a claude.cmd shim on PATH, which can't be started without a shell;
// the real claude.exe sits inside the package. Its folder goes on PATH so spawn('claude') finds the exe.
function claudeNpmBinDirs() {
  const root = path.join(ROAMING, 'npm', 'node_modules', '@anthropic-ai');
  const dirs = [];
  for (const pkg of ['claude-code', 'claude-code-win32-x64', 'claude-code-win32-arm64']) {
    for (const sub of ['bin', '']) {
      const dir = path.join(root, pkg, sub);
      if (fs.existsSync(path.join(dir, 'claude.exe'))) dirs.push(dir);
    }
    const nested = path.join(root, 'claude-code', 'node_modules', '@anthropic-ai', pkg);
    if (fs.existsSync(path.join(nested, 'claude.exe'))) dirs.push(nested);
  }
  return dirs;
}

const expand = s => s.replace(/%([^%]+)%/g, (m, name) => process.env[name] ?? m);
function registryPath(key) {
  try {
    const out = execFileSync('reg', ['query', key, '/v', 'Path'], { windowsHide: true, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    const m = out.match(/^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/mi);
    return m ? expand(m[1].trim()).split(';') : [];
  } catch { return []; }
}

// Store app aliases (WindowsApps) can't be started from a restricted token, so they never count.
const usable = dir => dir && !/\\Microsoft\\WindowsApps\\?$/i.test(dir);
const pathKey = () => Object.keys(process.env).find(k => k.toLowerCase() === 'path') || 'PATH';

export function refreshPath() {
  if (!WIN) return;
  const key = pathKey();
  const have = String(process.env[key] || '').split(';').filter(Boolean);
  const seen = new Set(have.map(d => d.toLowerCase().replace(/\\+$/, '')));
  // CLAUDEOS_IGNORE_REGISTRY_PATH: lab runs that pretend to be a new PC (an empty profile in %TEMP%)
  const registry = process.env.CLAUDEOS_IGNORE_REGISTRY_PATH ? [] : [...registryPath('HKCU\\Environment'),
    ...registryPath('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment')];
  const add = [...registry, ...knownDirs()]
    .filter(d => d && !seen.has(d.toLowerCase().replace(/\\+$/, '')) && fs.existsSync(d));
  for (const d of add) seen.add(d.toLowerCase().replace(/\\+$/, ''));
  if (add.length) process.env[key] = [...have, ...add].join(';');
}

// The full path of an .exe on PATH, or null.
export function findExe(name) {
  const file = WIN ? `${name}.exe` : name;
  for (const dir of String(process.env[pathKey()] || '').split(path.delimiter)) {
    if (!usable(dir)) continue;
    const p = path.join(dir, file);
    try { if (fs.statSync(p).isFile()) return p; } catch { /* next */ }
  }
  return null;
}

// Codex's App Server reaches PowerShell through PATH; take the Store aliases off its copy only.
export function codexEnvironment() {
  if (!WIN) return {};
  const key = pathKey();
  const entries = String(process.env[key] || '').split(';');
  const filtered = entries.filter(entry => !/\\Microsoft\\WindowsApps(?:\\|$)/i.test(entry));
  return filtered.length === entries.length ? {} : { [key]: filtered.join(';') };
}

// How to start Codex, from however it was installed: npm's bundled codex.exe, the standalone installer,
// winget or anything else on PATH, else node + npm's launcher. null = not installed.
export function codexCommand() {
  const npmRoot = path.join(ROAMING, 'npm', 'node_modules', '@openai', 'codex');
  for (const arch of [['x64', 'x86_64'], ['arm64', 'aarch64']]) {
    const exe = path.join(npmRoot, 'node_modules', '@openai', `codex-win32-${arch[0]}`, 'vendor', `${arch[1]}-pc-windows-msvc`, 'bin', 'codex.exe');
    if (fs.existsSync(exe)) return { command: exe, args: [], env: { ...codexEnvironment(), CODEX_MANAGED_PACKAGE_ROOT: npmRoot, CODEX_MANAGED_BY_NPM: '1' } };
  }
  const standalone = path.join(codexHome(), 'packages', 'standalone', 'current');
  const exe = findExe('codex') || [path.join(standalone, 'bin', 'codex.exe'), path.join(standalone, 'codex.exe')].find(p => fs.existsSync(p));
  if (exe) return { command: exe, args: [], env: codexEnvironment() };
  const js = path.join(npmRoot, 'bin', 'codex.js');
  if (fs.existsSync(js) && findExe('node')) return { command: 'node', args: [js], env: codexEnvironment() };
  return null;
}

export const claudeInstalled = () => !!findExe('claude');
export const codexInstalled = () => !!codexCommand();

// Which engine a chat runs on when nobody picked one: Claude, unless only Codex is on this PC.
export const defaultEngine = () => !claudeInstalled() && codexInstalled() ? 'codex' : 'claude';

// The makers' own Windows installers: one PowerShell line each, no admin rights, no Node needed.
export const INSTALLERS = {
  claude: { name: 'Claude Code', command: 'irm https://claude.ai/install.ps1 | iex' },
  codex: { name: 'Codex', command: 'irm https://chatgpt.com/codex/install.ps1 | iex' },
};

// Windows PowerShell 5.1 runs the installers. A PowerShell 7 module path (ClaudeOS started from pwsh)
// keeps it from loading its own Invoke-WebRequest, so it gets none and uses its defaults.
function installerEnv() {
  const env = { ...process.env, CODEX_NON_INTERACTIVE: '1' };
  for (const k of Object.keys(env)) if (k.toLowerCase() === 'psmodulepath') delete env[k];
  return env;
}

// Runs an installer, passing its output to onOutput; resolves { ok, text } once it's done and PATH is fresh.
export function runInstaller(key, onOutput = () => {}) {
  const inst = INSTALLERS[key];
  if (!inst) return { error: 'Unknown agent.' };
  if (!WIN) return { error: 'Installing from ClaudeOS works on Windows only.' };
  const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    `$ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; ${inst.command}`],
  { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: installerEnv() });
  let text = '';
  const read = d => { text = (text + d).slice(-8000); onOutput(String(d)); };
  proc.stdout.on('data', read);
  proc.stderr.on('data', read);
  const timer = setTimeout(() => { try { execFileSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {} }, 10 * 60 * 1000);
  const done = new Promise(resolve => {
    const finish = code => {
      clearTimeout(timer);
      refreshPath();
      const found = key === 'claude' ? claudeInstalled() : codexInstalled();
      resolve({ ok: found, code, text });
    };
    proc.on('exit', finish);
    proc.on('error', err => { text += err.message; finish(-1); });
  });
  return { proc, done };
}
