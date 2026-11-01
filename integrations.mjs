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
