// Accounts for tools Claude runs on this PC that aren't MCP servers: GitHub's gh CLI (pushing,
// pull requests, CI in the Git tab). Signing in uses GitHub's device flow: gh prints a one-time code,
// the page shows it and opens github.com/login/device, and gh finishes by itself once you approve.
// Nothing here sees or stores the token; gh keeps it in Windows' credential store.
import { execFile, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const run = (cmd, args, timeout = 20000) => new Promise(resolve =>
  execFile(cmd, args, { windowsHide: true, timeout }, (err, out, errOut) =>
    resolve({ ok: !err, missing: err?.code === 'ENOENT', text: String(out || '') + String(errOut || '') })));

// Claude Code and Codex: which account each is signed in to here, with sign-in and sign-out.
// Each CLI runs its own browser sign-in and keeps its own credentials; ClaudeOS only starts it,
// shows the link, and (for Claude) passes on a code the sign-in page shows, if it asks for one.
const plan = p => p ? ' · ' + p[0].toUpperCase() + p.slice(1) : '';

async function claudeAccount() {
  const r = await run('claude', ['auth', 'status']);
  if (r.missing) return { state: 'missing' };
  try {
    const j = JSON.parse(r.text.slice(r.text.indexOf('{'), r.text.lastIndexOf('}') + 1));
    if (!j.loggedIn) return { state: 'signed-out' };
    const who = j.email || j.orgName || (j.authMethod === 'api-key' ? 'an API key' : 'an account');
    return { state: 'signed-in', user: who + plan(j.subscriptionType) };
  } catch { return { state: 'signed-out' }; }
}

function codexAccount() {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  let j;
  try { j = JSON.parse(readFileSync(path.join(home, 'auth.json'), 'utf8')); }
  catch (err) { return { state: err.code === 'ENOENT' ? 'signed-out' : 'signed-out' }; }
  const idt = j.tokens?.id_token;
  if (idt) {
    try {
      const c = JSON.parse(Buffer.from(idt.split('.')[1], 'base64url').toString('utf8'));
      return { state: 'signed-in', user: (c.email || 'a ChatGPT account') + plan(c['https://api.openai.com/auth']?.chatgpt_plan_type) };
    } catch {}
    return { state: 'signed-in', user: 'a ChatGPT account' };
  }
  return j.OPENAI_API_KEY ? { state: 'signed-in', user: 'an OpenAI API key' } : { state: 'signed-out' };
}

// Codex comes from npm as codex.cmd, which needs the shell; the arguments are fixed text.
const AI = {
  claude: { name: 'Claude', cmd: 'claude', login: ['auth', 'login', '--claudeai'], logout: ['auth', 'logout'], shell: false,
    url: /https:\/\/claude\.(?:com|ai)\/\S*oauth\S*/ },
  codex: { name: 'Codex', cmd: 'codex', login: ['login'], logout: ['logout'], shell: process.platform === 'win32',
    url: /https:\/\/auth\.openai\.com\/\S+/ },
};
// stop the CLI and anything it started (a shell's child keeps Codex's localhost port otherwise)
function stop(proc) {
  if (process.platform === 'win32' && proc.pid) execFile('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true }, () => {});
  else proc.kill();
}

export function createAccounts({ broadcast, open }) {
  const aiFlows = {}; // key -> { proc, url, text, timer, cancelled }
  let github = { state: 'checking' };
  let claudeAcct = { state: 'checking' };
  let codexAcct = { state: 'checking' };
  let flow = null; // { proc, code, url, timer }

  async function check() {
    claudeAccount().then(a => { claudeAcct = a; broadcast(); });
    codexAcct = codexAccount();
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
    }, {
      key: 'claude', title: 'Claude', ...claudeAcct, ai: true, flow: aiView('claude'),
      what: 'Claude Code, which runs your chats and employees',
      install: 'https://claude.com/claude-code',
    }, {
      key: 'codex', title: 'Codex', ...codexAcct, ai: true, flow: aiView('codex'),
      what: 'OpenAI Codex, for chats that run on Codex',
      install: 'https://developers.openai.com/codex/cli',
    }];
  }
  function aiView(key) {
    const f = aiFlows[key];
    return f ? { url: f.url, paste: key === 'claude', starting: !f.url } : null;
  }

  async function recheck(key) {
    if (key === 'claude') claudeAcct = await claudeAccount();
    else codexAcct = codexAccount();
  }
  const acctOf = key => key === 'claude' ? claudeAcct : codexAcct;

  function aiLogin(key) {
    const a = AI[key];
    if (acctOf(key).state === 'missing') return { error: `${a.name} isn't installed on this PC.` };
    if (aiFlows[key]) { if (aiFlows[key].url) open(aiFlows[key].url); return { ok: true, already: true }; }
    const proc = spawn(a.cmd, a.login, { windowsHide: true, shell: a.shell, stdio: ['pipe', 'pipe', 'pipe'] });
    const f = aiFlows[key] = { proc, url: '', text: '' };
    // the CLI opens the browser itself; the page shows the link too, in case it didn't
    const read = d => {
      f.text = (f.text + d).slice(-4000);
      const url = f.text.match(a.url)?.[0];
      if (url && !f.url) { f.url = url; broadcast(); }
    };
    proc.stdout.on('data', read);
    proc.stderr.on('data', read);
    f.timer = setTimeout(() => stop(proc), 15 * 60 * 1000);
    const finish = async () => {
      if (aiFlows[key] !== f) return;
      clearTimeout(f.timer);
      delete aiFlows[key];
      await recheck(key);
      const now = acctOf(key);
      broadcast({ key, title: a.name, ok: now.state === 'signed-in', user: now.user, cancelled: f.cancelled,
        text: now.state === 'signed-in' ? '' : f.text.replace(/https?:\/\/\S+/g, '').replace(/^.*prompted >\s*/m, '').trim().split('\n').pop()?.slice(0, 200) });
    };
    proc.on('exit', finish);
    proc.on('error', err => { f.text += err.message; finish(); });
    broadcast();
    return { ok: true };
  }

  // the code Claude's sign-in page shows when it can't hand the sign-in back by itself
  function aiCode(key, code) {
    const f = aiFlows[key];
    code = String(code || '').trim();
    if (!f) return { error: 'No sign-in is running. Press Sign in again.' };
    if (!/^[\w#.~-]{8,400}$/.test(code)) return { error: "That doesn't look like a sign-in code. Copy the whole code from the page." };
    f.proc.stdin.write(code + '\n');
    return { ok: true };
  }

  async function aiLogout(key) {
    const a = AI[key];
    if (aiFlows[key]) { aiFlows[key].cancelled = true; stop(aiFlows[key].proc); }
    const r = await new Promise(resolve => execFile(a.cmd, a.logout, { windowsHide: true, shell: a.shell, timeout: 20000 },
      (err, out, errOut) => resolve({ ok: !err, text: String(out || '') + String(errOut || '') })));
    await recheck(key);
    broadcast();
    return acctOf(key).state !== 'signed-in' ? { ok: true } : { error: r.text.trim().split('\n').pop() || `${a.name} sign-out failed.` };
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

  async function act(key, what, code) {
    if (AI[key]) {
      if (what === 'login') return aiLogin(key);
      if (what === 'code') return aiCode(key, code);
      if (what === 'cancel') { const f = aiFlows[key]; if (f) { f.cancelled = true; stop(f.proc); } return { ok: true }; }
      if (what === 'logout') return aiLogout(key);
      if (what === 'check') { await recheck(key); broadcast(); return { ok: true }; }
      return { error: 'Unknown action.' };
    }
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
