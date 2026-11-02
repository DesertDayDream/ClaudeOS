// Codex (OpenAI's coding agent) as a second engine for a chat. Each message runs `codex exec --json`
// (or `codex exec resume <thread>` after the first), streams its events back as the chat's reply, and
// quits. The shared brain reaches Codex as the same memory MCP server Claude gets, and the ClaudeOS
// desk tools (terminal, artifacts, team briefs) through approval-mcp.mjs.
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ClaudeOS's permission modes, as Codex sandboxes (Codex exec never stops to ask)
const SANDBOX = { plan: 'read-only', bypassPermissions: 'danger-full-access' };
export const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const FALLBACK_MODELS = [{ id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol' }];

const npmRoot = () => path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'npm', 'node_modules', '@openai', 'codex');
const codexHome = () => process.env.CODEX_HOME || path.join(os.homedir(), '.codex');

// How to start Codex: its own codex.exe from the npm install (no Node needed), else node + its launcher.
export function codexCommand() {
  const root = npmRoot();
  const exe = path.join(root, 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
  if (fs.existsSync(exe)) return { command: exe, args: [], env: { CODEX_MANAGED_PACKAGE_ROOT: root, CODEX_MANAGED_BY_NPM: '1' } };
  const js = path.join(root, 'bin', 'codex.js');
  if (fs.existsSync(js)) return { command: 'node', args: [js], env: {} };
  return null;
}

// The models the user's Codex offers, from its own cache (what its model picker shows).
export function codexModels() {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(codexHome(), 'models_cache.json'), 'utf8'));
    const list = (d.models || d).filter(m => m.slug && m.visibility !== 'hide')
      .map(m => ({ id: m.slug, name: m.display_name || m.slug, efforts: (m.supported_reasoning_levels || []).map(e => e.effort).filter(Boolean),
        ...(m.context_window ? { window: m.context_window } : {}) }));
    if (list.length) return list;
  } catch { /* no cache yet */ }
  return FALLBACK_MODELS;
}

// Signed in? `codex login status` says "Logged in using …" or "Not logged in".
export function codexStatus() {
  const cmd = codexCommand();
  if (!cmd) return Promise.resolve({ installed: false, signedIn: false, text: 'Codex CLI is not installed (npm install -g @openai/codex).' });
  return new Promise(resolve => execFile(cmd.command, [...cmd.args, 'login', 'status'], { env: { ...process.env, ...cmd.env }, windowsHide: true, timeout: 20000 },
    (err, stdout, stderr) => {
      const text = `${stdout || ''}${stderr || ''}`.trim().split('\n').pop() || '';
      resolve({ installed: true, signedIn: /logged in/i.test(text) && !/not logged in/i.test(text), text });
    }));
}

// A TOML value for a -c override (JSON strings are valid TOML basic strings)
const toml = v => Array.isArray(v) ? `[${v.map(toml).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}=${toml(x)}`).join(',')}}`
  : typeof v === 'string' ? JSON.stringify(v) : String(v);

// The pwsh/bash wrapper Codex puts around each shell command, taken off for the chat's tool line.
export function shortCommand(cmd) {
  let s = String(cmd || '');
  const m = s.match(/^"?[^"]*?(?:pwsh|powershell|bash|cmd)(?:\.exe)?"?\s+(?:-NoProfile\s+)?(?:-Command|-lc|-c|\/c)\s+([\s\S]*)$/i);
  if (m) s = m[1].replace(/^(['"])([\s\S]*)\1$/, '$2');
  return s.replace(/\s+/g, ' ').trim();
}

// One Codex turn. opts: { cwd, thread, prompt, images, model, effort, mode, mcpServers, addDirs, onEvent, onThread }
// Resolves with { error } (null when it went fine) once Codex exits. Returns { proc, done }.
export function runCodexTurn({ cwd, thread, prompt, images = [], model, effort, mode, mcpServers = {}, addDirs = [], onEvent = () => {}, onThread = () => {} }) {
  const cmd = codexCommand();
  if (!cmd) return { proc: null, done: Promise.resolve({ error: 'Codex is not installed. Install it with: npm install -g @openai/codex, then sign in with: codex login' }) };
  const cfg = ['-c', `sandbox_mode=${toml(SANDBOX[mode] || 'workspace-write')}`];
  if (effort) cfg.push('-c', `model_reasoning_effort=${toml(effort)}`);
  for (const [name, server] of Object.entries(mcpServers)) {
    cfg.push('-c', `mcp_servers.${name}=${toml({ command: server.command, args: server.args || [], ...(server.env ? { env: server.env } : {}), ...(server.enabled_tools ? { enabled_tools: server.enabled_tools } : {}), ...(server.disabled_tools ? { disabled_tools: server.disabled_tools } : {}) })}`);
  }
  const common = ['--json', '--skip-git-repo-check', ...cfg, ...(model ? ['-m', model] : []), ...images.flatMap(f => ['--image', f])];
  // the prompt goes on stdin ("-"), so its length and quotes never meet the command line
  const args = thread
    ? [...cmd.args, 'exec', ...addDirs.flatMap(d => ['--add-dir', d]), 'resume', ...common, '--', thread, '-']
    : [...cmd.args, 'exec', ...addDirs.flatMap(d => ['--add-dir', d]), ...common, '--', '-'];
  let proc;
  try {
    proc = spawn(cmd.command, args, { cwd, env: { ...process.env, ...cmd.env }, windowsHide: true });
  } catch (err) {
    return { proc: null, done: Promise.resolve({ error: `Could not start Codex: ${err.message}` }) };
  }
  const done = new Promise(resolve => {
    let buf = '', stderr = '', failed = null;
    // whole characters only: a chunk can end in the middle of one
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', d => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('{')) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === 'thread.started' && ev.thread_id) onThread(ev.thread_id);
        if (ev.type === 'turn.failed') failed = ev.error?.message || 'Codex stopped with an error.';
        if (ev.type === 'error' && ev.message && !/reconnecting/i.test(ev.message)) failed = ev.message;
        try { onEvent(ev); } catch { /* a malformed event */ }
      }
    });
    proc.stderr.on('data', d => { stderr = (stderr + d).slice(-4000); });
    proc.stdin.on('error', () => { /* it quit; 'close' says why */ });
    proc.on('error', err => resolve({ error: `Could not start Codex: ${err.message}` }));
    proc.on('close', code => {
      const last = stderr.split('\n').map(s => s.trim()).filter(s => s && !/^Reading (additional )?(input|prompt) from stdin/i.test(s)).pop();
      resolve({ error: failed || (code ? last || `Codex exited with code ${code}` : null) });
    });
  });
  proc.stdin.end(prompt);
  return { proc, done };
}

// Codex's plan usage (5-hour and weekly windows). `codex exec --json` doesn't report it, but every
// Codex session (ours and the Codex app's) logs it to ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
// with each token_count event. Read the newest one; null when there is none to read.
export function codexLimits() {
  const root = path.join(codexHome(), 'sessions');
  const subdirs = d => { try { return fs.readdirSync(d, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort().reverse(); } catch { return []; } };
  const files = [];
  outer: for (const y of subdirs(root)) for (const m of subdirs(path.join(root, y))) for (const d of subdirs(path.join(root, y, m))) {
    const dir = path.join(root, y, m, d);
    try {
      for (const f of fs.readdirSync(dir)) if (f.endsWith('.jsonl')) { const p = path.join(dir, f); files.push({ p, t: fs.statSync(p).mtimeMs }); }
    } catch { /* skip */ }
    if (files.length >= 30) break outer;
  }
  files.sort((a, b) => b.t - a.t);
  for (const { p } of files.slice(0, 15)) {
    let text;
    try {
      const fd = fs.openSync(p, 'r');
      try {
        const size = fs.fstatSync(fd).size, len = Math.min(size, 512 * 1024);
        const buf = Buffer.alloc(len); fs.readSync(fd, buf, 0, len, size - len); text = buf.toString('utf8');
      } finally { fs.closeSync(fd); }
    } catch { continue; }
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"rate_limits"')) continue;
      let ev; try { ev = JSON.parse(lines[i]); } catch { continue; }
      const rl = ev?.payload?.rate_limits;
      if (!rl || (!rl.primary && !rl.secondary)) continue;
      return { primary: rl.primary || null, secondary: rl.secondary || null, plan: rl.plan_type || null,
        reached: rl.rate_limit_reached_type || null, at: Date.parse(ev.timestamp) || Date.now() };
    }
  }
  return null;
}
