// Integrations: add, sign in to and remove Claude Code's MCP servers from the page.
// Everything goes through the `claude mcp` commands (no shell, arguments passed as a list), so the
// result is exactly what typing them would do. "This brain" = local scope (only in the brain's folder),
// "All projects" = user scope.
import { execFile, spawn } from 'node:child_process';

// Apps with an official MCP address (from the Claude Code docs) and how they connect. `connector`
// apps come from claude.ai: you turn them on there, then they show up here by themselves.
export const CATALOG = [
  { key: 'gmail', how: 'connector' },
  { key: 'googledrive', how: 'connector' },
  { key: 'googlecalendar', how: 'connector' },
  { key: 'canva', how: 'connector' },
  { key: 'slack', how: 'connector' },
  { key: 'notion', how: 'http', name: 'notion', url: 'https://mcp.notion.com/mcp' },
  { key: 'linear', how: 'http', name: 'linear', url: 'https://mcp.linear.app/mcp' },
  { key: 'asana', how: 'sse', name: 'asana', url: 'https://mcp.asana.com/sse' },
  { key: 'hubspot', how: 'http', name: 'hubspot', url: 'https://mcp.hubspot.com/anthropic' },
  { key: 'stripe', how: 'http', name: 'stripe', url: 'https://mcp.stripe.com' },
  { key: 'sentry', how: 'http', name: 'sentry', url: 'https://mcp.sentry.dev/mcp' },
  { key: 'blender', how: 'stdio', name: 'blender', command: ['uvx', 'blender-mcp'],
    note: 'Needs uv (docs.astral.sh/uv) and the Blender MCP add-on (github.com/ahujasid/blender-mcp) running inside Blender.' },
];
export const CONNECTORS_URL = 'https://claude.ai/settings/connectors';

const NAME = /^[A-Za-z0-9_-]{1,40}$/;

function claude(args, cwd, timeout = 60000) {
  return new Promise(resolve => {
    execFile('claude', args, { cwd, windowsHide: true, timeout, maxBuffer: 1 << 20 }, (err, out, errOut) =>
      resolve({ ok: !err, text: String(out || '') + String(errOut || '') }));
  });
}

// Splits a command line into words, keeping "quoted parts" together.
function words(line) {
  return [...String(line).matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(m => m[1] ?? m[2] ?? m[3]);
}

export async function addIntegration(brain, { key, name, target, extra, scope }) {
  scope = scope === 'user' ? 'user' : 'local';
  const pick = key && CATALOG.find(c => c.key === key);
  let args;
  if (pick) {
    if (pick.how === 'connector') return { error: 'Turn this one on at claude.ai, then press Refresh.' };
    name = pick.name;
    args = pick.how === 'stdio' ? ['mcp', 'add', '-s', scope, name, '--', ...pick.command]
      : ['mcp', 'add', '--transport', pick.how, '-s', scope, name, pick.url];
  } else {
    name = String(name || '').trim();
    target = String(target || '').trim();
    if (!NAME.test(name)) return { error: 'Give it a short name: letters, numbers, - and _ only.' };
    if (!target) return { error: 'Paste the app’s MCP address (https://…) or the command that starts it.' };
    const lines = String(extra || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (/^https?:\/\//i.test(target)) {
      if (/\s/.test(target)) return { error: 'An address can’t have spaces in it.' };
      const bad = lines.find(l => !/^[\w-]+:\s*\S/.test(l));
      if (bad) return { error: `"${bad}" isn't a header. Write it as Name: value, like Authorization: Bearer …` };
      // --header and -e take several values, so they go after the name and address
      args = ['mcp', 'add', '--transport', /\/sse\/?$/i.test(target) ? 'sse' : 'http', '-s', scope, name, target,
        ...lines.flatMap(l => ['--header', l])];
    } else {
      const bad = lines.find(l => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(l));
      if (bad) return { error: `"${bad}" isn't a setting. Write it as NAME=value, like API_KEY=abc123` };
      args = ['mcp', 'add', '-s', scope, name, ...lines.flatMap(l => ['-e', l]), '--', ...words(target)];
    }
  }
  const r = await claude(args, brain.path);
  if (!r.ok) return { error: r.text.trim().split('\n').pop() || 'Claude Code couldn’t add it.' };
  return { ok: true, name };
}

export async function removeIntegration(brain, server) {
  if (/^claude\.ai /.test(server)) return { error: 'This one comes from claude.ai. Turn it off there.' };
  if (/^plugin:/.test(server)) return { error: 'This one comes with a plugin. Disable the plugin to remove it.' };
  // try the scopes ClaudeOS adds to first; a .mcp.json server is the project's to remove
  for (const scope of ['local', 'user', 'project']) {
    const r = await claude(['mcp', 'remove', '-s', scope, server], brain.path);
    if (r.ok) return { ok: true, scope };
  }
  return { error: `Couldn't remove ${server}. It may be set up somewhere ClaudeOS can't change.` };
}

// Opens the app's sign-in page in the browser and waits (up to 5 minutes) for it to finish.
const signingIn = new Map();
export function loginIntegration(brain, server, onDone) {
  if (signingIn.has(server)) return { ok: true, already: true };
  const proc = spawn('claude', ['mcp', 'login', server], { cwd: brain.path, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let text = '';
  proc.stdout.on('data', d => { text += d; });
  proc.stderr.on('data', d => { text += d; });
  const timer = setTimeout(() => proc.kill(), 5 * 60 * 1000);
  signingIn.set(server, proc);
  const finish = code => { clearTimeout(timer); signingIn.delete(server); onDone({ ok: code === 0, text: text.trim().slice(-300) }); };
  proc.on('exit', finish);
  proc.on('error', () => finish(1));
  return { ok: true };
}
export const isSigningIn = server => signingIn.has(server);

// ---------- API keys ----------
// Some apps sign in with a key instead of a browser: their config says `Bearer ${FAL_KEY}` and
// Claude Code fills it in from the environment. These find the ${NAME}s an integration needs and
// save a pasted key as a Windows user variable (and in ClaudeOS's own environment, which every chat
// inherits from its next message). The key is never written to a log or sent back to the page.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// where to get a key, for the ones we know
export const KEY_HELP = {
  FAL_KEY: 'https://fal.ai/dashboard/keys',
  OPENAI_API_KEY: 'https://platform.openai.com/api-keys',
  ANTHROPIC_API_KEY: 'https://console.anthropic.com/settings/keys',
  GITHUB_TOKEN: 'https://github.com/settings/tokens',
  GITHUB_PERSONAL_ACCESS_TOKEN: 'https://github.com/settings/tokens',
  ELEVENLABS_API_KEY: 'https://elevenlabs.io/app/settings/api-keys',
  REPLICATE_API_TOKEN: 'https://replicate.com/account/api-tokens',
  BRAVE_API_KEY: 'https://api-dashboard.search.brave.com/app/keys',
};
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const norm = p => String(p || '').replace(/[\\]/g, '/').replace(/\/+$/, '').toLowerCase();

// the config Claude Code uses for one server: a plugin's, the brain's .mcp.json, or ~/.claude.json
function serverConfig(brainPath, server) {
  const home = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const plugin = server.match(/^plugin:([^:]+):(.+)$/);
  if (plugin) {
    const installed = readJson(path.join(home, 'plugins', 'installed_plugins.json'))?.plugins || {};
    for (const [id, installs] of Object.entries(installed)) {
      if (id.split('@')[0] !== plugin[1]) continue;
      for (const { installPath } of installs || []) {
        const fromFile = readJson(path.join(installPath, '.mcp.json'));
        const manifest = readJson(path.join(installPath, '.claude-plugin', 'plugin.json'))?.mcpServers;
        for (const c of [fromFile?.mcpServers || fromFile, typeof manifest === 'object' ? manifest : null, typeof manifest === 'string' ? readJson(path.join(installPath, manifest))?.mcpServers : null]) {
          if (c?.[plugin[2]]) return c[plugin[2]];
        }
      }
    }
    return null;
  }
  const project = readJson(path.join(brainPath, '.mcp.json'))?.mcpServers?.[server];
  const user = readJson(path.join(os.homedir(), '.claude.json'));
  const local = Object.entries(user?.projects || {}).find(([p]) => norm(p) === norm(brainPath))?.[1]?.mcpServers?.[server];
  return local || project || user?.mcpServers?.[server] || null;
}

// the ${NAME}s a server needs that have no default (${NAME:-default} works without one)
export function keysFor(brainPath, server) {
  if (/^claude\.ai /.test(server)) return [];
  const cfg = serverConfig(brainPath, server);
  if (!cfg) return [];
  const names = new Set();
  for (const m of JSON.stringify(cfg).matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(:-[^}]*)?\}/g)) if (!m[2]) names.add(m[1]);
  // a stdio server given an empty -e KEY= needs that key too
  for (const [k, v] of Object.entries(cfg.env || {})) if (v === '' && /key|token|secret/i.test(k)) names.add(k);
  return [...names];
}

const KEY_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const PROTECTED = /^(PATH|PATHEXT|COMSPEC|SYSTEMROOT|WINDIR|TEMP|TMP|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|PSMODULEPATH|NODE_OPTIONS|CLAUDEOS_.*|CLAUDE_CONFIG_DIR)$/i;

// Saves (or with value null, removes) a key. `allowed` is the names the integrations need: nothing else can be set.
export function saveKey(name, value, allowed) {
  name = String(name || '');
  if (!KEY_NAME.test(name) || PROTECTED.test(name) || !allowed.includes(name)) return Promise.resolve({ error: 'No integration here needs that key.' });
  if (value != null) {
    value = String(value).trim();
    if (!value) return Promise.resolve({ error: 'Paste the key first.' });
    if (/[\r\n]/.test(value) || value.length > 8192) return Promise.resolve({ error: 'That doesn’t look like a key (it has line breaks or is very long).' });
  }
  // the value goes through stdin, never on a command line other programs can read
  const script = value == null
    ? `[Environment]::SetEnvironmentVariable($env:K_NAME, $null, 'User')`
    : `$v = [Console]::In.ReadToEnd(); [Environment]::SetEnvironmentVariable($env:K_NAME, $v, 'User')`;
  return new Promise(resolve => {
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, env: { ...process.env, K_NAME: name }, stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    ps.stderr.on('data', d => { err += d; });
    ps.on('error', e => resolve({ error: e.message }));
    ps.on('exit', code => {
      if (code !== 0) return resolve({ error: `Windows didn't save it: ${err.trim().split('\n').pop() || code}` });
      if (value == null) delete process.env[name]; else process.env[name] = value;
      resolve({ ok: true });
    });
    ps.stdin.end(value ?? '');
  });
}
