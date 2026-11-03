// Codex as a second engine, using a private App Server with human approvals. The shared brain reaches Codex as the same memory MCP server Claude gets, and the ClaudeOS
// desk tools (terminal, artifacts, team briefs) through approval-mcp.mjs.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { runAppServerTurn } from './codex-app-server.mjs';
import { codexCommand, codexHome } from './agents.mjs';

export const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const FALLBACK_MODELS = [{ id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol', inferred: true }];

// Where Codex is and how to start it: agents.mjs finds it however it was installed.
export { codexCommand } from './agents.mjs';

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
  if (!cmd) return Promise.resolve({ installed: false, signedIn: false, text: 'Codex is not installed. Install it from Apps → Accounts.' });
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

// One private App Server connection per message, with a UI approval channel.
export function codexMcpConfig(server) {
  const transport = server.url ? { url: server.url, ...(server.headers ? { http_headers: server.headers } : {}),
    ...(server.bearer_token_env_var ? { bearer_token_env_var: server.bearer_token_env_var } : {}) }
    : { command: server.command, args: server.args || [], ...(server.env ? { env: server.env } : {}) };
  return { ...transport, ...(server.enabled_tools ? { enabled_tools: server.enabled_tools } : {}), ...(server.disabled_tools ? { disabled_tools: server.disabled_tools } : {}) };
}

export function runCodexTurn(options) {
  const cmd = codexCommand();
  if (!cmd) return { proc: null, done: Promise.resolve({ error: 'Codex is not installed on this PC. Install it from Apps → Accounts (Install), then sign in there.' }), stop() {} };
  const cfg = [];
  for (const [name, server] of Object.entries(options.mcpServers || {})) {
    cfg.push('-c', `mcp_servers.${JSON.stringify(name)}=${toml(codexMcpConfig(server))}`);
  }
  return runAppServerTurn({ ...options, command: cmd.command, args: [...cmd.args, ...cfg], env: cmd.env });
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
