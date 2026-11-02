// Claude Code plugins, browsed and installed from the page: the plugins of every marketplace you have
// added (Anthropic's official one, and any GitHub repo or folder you add), what is installed, and
// install / uninstall / enable / disable. Everything goes through `claude plugin … --json`.
import { execFile } from 'node:child_process';

const TTL = 10 * 60e3;
let cache = null, loading = null; // { at, plugins, marketplaces, error }

function claude(args, timeout = 180000) {
  return new Promise(resolve => {
    execFile('claude', args, { windowsHide: true, timeout, maxBuffer: 256 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(stdout || ''), err: String(stderr || ''), failed: err && typeof err.code !== 'number' ? err.message : '' });
    });
  });
}
// the last JSON line a --json command printed
// (lists come pretty-printed over many lines; results are one line after any human text)
function lastJson(out) {
  const ok = v => v && typeof v === 'object';
  try { const v = JSON.parse(out); if (ok(v)) return v; } catch { /* several lines */ }
  for (const line of out.trim().split('\n').reverse()) { try { const v = JSON.parse(line); if (ok(v)) return v; } catch { /* not this one */ } }
  return null;
}

async function load() {
  const [all, mk] = await Promise.all([claude(['plugin', 'list', '--available', '--json']), claude(['plugin', 'marketplace', 'list', '--json'])]);
  const j = lastJson(all.out) || {};
  if (!j.available && !j.installed) return { at: Date.now(), plugins: [], marketplaces: [], error: (all.err || all.failed || 'Claude Code did not list its plugins.').trim().split('\n').pop() };
  const installed = new Map((j.installed || []).map(p => [p.id, p]));
  const plugins = (j.available || []).map(p => ({ id: p.pluginId, name: p.name, description: p.description || '', marketplace: p.marketplaceName, installs: p.installCount || 0 }));
  // installed ones from a marketplace that no longer lists them still show
  for (const [id, p] of installed) if (!plugins.some(x => x.id === id)) plugins.push({ id, name: id.split('@')[0], description: '', marketplace: id.split('@')[1] || '', installs: 0 });
  for (const p of plugins) {
    const i = installed.get(p.id);
    if (i) Object.assign(p, { installed: true, enabled: !!i.enabled, version: i.version, scope: i.scope, mcp: Object.keys(i.mcpServers || {}) });
  }
  const marketplaces = (lastJson(mk.out) || []).map(m => ({ name: m.name, source: m.repo || m.url || m.path || m.source, kind: m.source }));
  return { at: Date.now(), plugins, marketplaces, error: '' };
}

export function createPlugins({ broadcast = () => {} } = {}) {
  async function view({ fresh = false } = {}) {
    if (fresh || !cache || Date.now() - cache.at > TTL) {
      loading ||= load().finally(() => { loading = null; });
      cache = await loading;
    }
    return cache;
  }
  const changed = async () => { cache = null; broadcast('plugins', {}); };
  const bad = id => !/^[\w.-]+(@[\w.-]+)?$/.test(String(id || ''));

  // install: a marketplace may run a command to fetch the plugin; that's shown to you first, and only
  // the exact command you saw (its sha256) is accepted
  async function install({ id, scope = 'user', accept = '' }) {
    if (bad(id)) return { error: 'Unknown plugin.' };
    if (!['user', 'project', 'local'].includes(scope)) return { error: 'Unknown scope.' };
    const args = ['plugin', 'install', id, '-s', scope, '--json', ...(accept && /^[a-f0-9]{64}$/i.test(accept) ? ['--accept-command', accept] : [])];
    const r = await claude(args, 600000);
    const j = lastJson(r.out) || {};
    if (j.shownCommand && r.code) return { confirm: { command: j.shownCommand.command || j.shownCommand.text || JSON.stringify(j.shownCommand), sha256: j.shownCommand.sha256, message: j.message || '' } };
    if (r.code) return { error: j.message || (r.err || r.failed).trim().split('\n').pop() || 'The install failed.' };
    await changed();
    return { ok: true, message: j.message || `Installed ${id}.` };
  }
  async function simple(cmd, id) {
    if (bad(id)) return { error: 'Unknown plugin.' };
    const r = await claude(['plugin', cmd, id, '--json']);
    const j = lastJson(r.out) || {};
    if (r.code) return { error: j.message || (r.err || r.failed).trim().split('\n').pop() || `${cmd} failed.` };
    await changed();
    return { ok: true, message: j.message || '' };
  }
  async function marketplace({ act, source, name }) {
    if (act === 'add') {
      source = String(source || '').trim();
      if (!source || /[\s"'`;&|<>]/.test(source)) return { error: 'Give a GitHub repo (owner/repo), a git or https URL, or a folder path, with no spaces.' };
      const r = await claude(['plugin', 'marketplace', 'add', source], 300000);
      if (r.code) return { error: (r.err || r.out || r.failed).trim().split('\n').pop() };
    } else if (act === 'remove' || act === 'update') {
      if (bad(name)) return { error: 'Unknown marketplace.' };
      const r = await claude(['plugin', 'marketplace', act, name], 300000);
      if (r.code) return { error: (r.err || r.out || r.failed).trim().split('\n').pop() };
    } else return { error: 'Unknown action.' };
    await changed();
    return { ok: true };
  }
  return {
    view, install, marketplace,
    uninstall: ({ id }) => simple('uninstall', id), enable: ({ id }) => simple('enable', id), disable: ({ id }) => simple('disable', id),
  };
}
