// Accounts for tools Claude runs on this PC that aren't MCP servers: GitHub's gh CLI (pushing,
// pull requests, CI in the Git tab). Signing in uses GitHub's device flow: gh prints a one-time code,
// the page shows it and opens github.com/login/device, and gh finishes by itself once you approve.
// Nothing here sees or stores the token; gh keeps it in Windows' credential store.
import { execFile, spawn } from 'node:child_process';

const run = (cmd, args, timeout = 20000) => new Promise(resolve =>
  execFile(cmd, args, { windowsHide: true, timeout }, (err, out, errOut) =>
    resolve({ ok: !err, missing: err?.code === 'ENOENT', text: String(out || '') + String(errOut || '') })));

export function createAccounts({ broadcast, open }) {
  let github = { state: 'checking' };
  let flow = null; // { proc, code, url, timer }

  async function check() {
    const r = await run('gh', ['auth', 'status', '--hostname', 'github.com']);
    const user = r.text.match(/Logged in to github\.com (?:account|as) ([\w-]+)/)?.[1];
    github = r.missing ? { state: 'missing' }
      : user && r.ok ? { state: 'signed-in', user }
      : user ? { state: 'expired', user } // gh knows the account but its token no longer works
      : { state: 'signed-out' };
    broadcast();
  }

  function view() {
    return [{
      key: 'github', title: 'GitHub', ...github,
      flow: flow?.code ? { code: flow.code, url: flow.url } : flow ? { starting: true } : null,
      what: 'Pushing to GitHub, pull requests and CI in the Git tab',
      install: 'https://cli.github.com',
    }];
  }

  function login() {
    if (github.state === 'missing') return { error: 'The GitHub CLI (gh) is not installed. Get it from cli.github.com, then press Refresh.' };
    if (flow) { if (flow.url) open(flow.url); return { ok: true, already: true }; }
    const proc = spawn('gh', ['auth', 'login', '--web', '--git-protocol', 'https', '--hostname', 'github.com', '--skip-ssh-key'],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    flow = { proc, code: '', url: '', text: '' };
    const f = flow;
    const read = d => {
      f.text = (f.text + d).slice(-4000);
      const code = f.text.match(/one-time code: ([A-Z0-9]{4}-[A-Z0-9]{4})/)?.[1];
      const url = f.text.match(/https:\/\/github\.com\/login\/device\S*/)?.[0];
      if (code && url && !f.code) { f.code = code; f.url = url; open(url); broadcast(); }
      // older gh asks for Enter before opening the browser; we open it ourselves
      if (/Press Enter/i.test(String(d))) proc.stdin.write('\n');
    };
    proc.stdout.on('data', read);
    proc.stderr.on('data', read);
    // GitHub's codes last 15 minutes
    f.timer = setTimeout(() => proc.kill(), 15 * 60 * 1000);
    const finish = async code => {
      if (flow !== f) return;
      clearTimeout(f.timer);
      flow = null;
      // let git push use the same sign-in
      if (code === 0) await run('gh', ['auth', 'setup-git', '--hostname', 'github.com']);
      await check();
      broadcast({ key: 'github', ok: code === 0 && github.state === 'signed-in', user: github.user, cancelled: f.cancelled,
        text: code === 0 ? '' : f.text.replace(/[A-Z0-9]{4}-[A-Z0-9]{4}/g, '').trim().split('\n').pop()?.slice(0, 200) });
    };
    proc.on('exit', finish);
    proc.on('error', err => { f.text += err.message; finish(1); });
    broadcast();
    return { ok: true };
  }

  function cancel() {
    if (!flow) return { ok: true };
    flow.cancelled = true;
    flow.proc.kill();
    return { ok: true };
  }

  async function logout() {
    const r = await run('gh', ['auth', 'logout', '--hostname', 'github.com', ...(github.user ? ['--user', github.user] : [])]);
    await check();
    return r.ok || github.state === 'signed-out' ? { ok: true } : { error: r.text.trim().split('\n').pop() || 'GitHub sign-out failed.' };
  }

  async function act(key, what) {
    if (key !== 'github') return { error: 'Unknown account.' };
    if (what === 'login') return login();
    if (what === 'cancel') return cancel();
    if (what === 'logout') return logout();
    if (what === 'check') { await check(); return { ok: true }; }
    return { error: 'Unknown action.' };
  }

  check();
  return { view, act, check };
}
