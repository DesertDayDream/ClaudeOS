// Harbor benchmarks inside ClaudeOS: setup (Docker, Harbor, Claude sign-in) and jobs, all from buttons.
// Nobody types in a terminal: ClaudeOS runs every command itself, hidden.
//
// Sign-in is the user's Claude subscription only, never an API key. "Connect" runs `claude setup-token`
// in a hidden terminal; the token it prints is encrypted with Windows' own data protection (DPAPI, this
// Windows user only), never shown, logged or sent anywhere but the environment of the harbor process.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { buildHarborTask } from './task.mjs';
import { trimSearch, SEARCH_NOTES } from '../../memory-mcp.mjs';

// any of these would let a run bill an API account instead of the subscription
const STRIP = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_API_KEY', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENROUTER_API_KEY'];
const TOKEN_RE = /sk-ant-oat01-[A-Za-z0-9_-]{20,}/;
const LIMIT_RE = /usage limit|limit reached|rate[_ ]limit|\b429\b|out of (?:extra )?usage/i;
const AGENTS = {
  'claude-code': { name: 'Claude Code (as in Claude Desktop)', args: () => ['-a', 'claude-code'] },
  claudeos: { name: 'ClaudeOS', args: (bundle, advisor) => ['-a', 'claudeos_agent:ClaudeOS', '--ak', `bundle=${bundle}`, ...(advisor ? ['--ak', `advisor=${advisor}`] : [])] },
};
const win = process.platform === 'win32';
// Terminal-Bench 2.0 (the Harbor registry's industry-standard agent benchmark): every task is checked by its
// own tests in its own container. "Quick 10" is a fixed, varied set that fits a laptop and a 30-minute limit
// per task, so runs compare like with like; "Full" is all 89 tasks (hours, and much of a plan's usage).
export const TB2 = 'terminal-bench@2.0';
export const TB2_QUICK = ['fix-git', 'prove-plus-comm', 'cobol-modernization', 'openssl-selfsigned-cert', 'nginx-request-logging',
  'polyglot-c-py', 'regex-log', 'git-leak-recovery', 'multi-source-data-merger', 'constraints-scheduling'];
export const SUITES = { 'tb2-quick': { name: 'Terminal-Bench 2.0 · Quick 10', tasks: TB2_QUICK }, 'tb2-full': { name: 'Terminal-Bench 2.0 · Full (89 tasks, hours)', tasks: null } };
// the model that advises a ClaudeOS chat on hard steps, as the app decides it (chat.mjs advisorFor)
const advisorOf = o => o.advisor === 'off' ? '' : o.advisor || (o.model === 'sonnet' || o.model === 'haiku' ? 'opus' : '');
const ansi = s => String(s).replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b[=>()][0-9A-Za-z]?/g, '');
const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };

function run(cmd, args, { timeout = 60e3, env, input } = {}) {
  return new Promise(resolve => {
    const p = execFile(cmd, args, { windowsHide: true, timeout, env: env || process.env, maxBuffer: 16 << 20 },
      (err, out, errOut) => resolve({ ok: !err, code: err?.code ?? 0, missing: err?.code === 'ENOENT', out: String(out || '') + String(errOut || '') }));
    if (input != null) { p.stdin.end(input); }
  });
}
function killTree(p) {
  if (!p?.pid) return;
  if (win) execFile('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true }, () => {});
  else try { p.kill('SIGTERM'); } catch { /* gone */ }
}

// ---------- the token, kept with Windows data protection ----------
const PS = ['-NoProfile', '-NonInteractive', '-Command'];
export const protect = text => run('powershell.exe', [...PS,
  'Add-Type -AssemblyName System.Security; $s=[Console]::In.ReadToEnd(); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($s),$null,"CurrentUser"))'], { input: text });
export const unprotect = b64 => run('powershell.exe', [...PS,
  'Add-Type -AssemblyName System.Security; $s=[Console]::In.ReadToEnd().Trim(); [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($s),$null,"CurrentUser"))'], { input: b64 });

export function createHarbor({ kit, home, loadPty, harness, loadTask, gradeWeb, onChange = () => {}, log = () => {} }) {
  const tools = path.join(home, 'tools'), bin = path.join(tools, 'bin'), jobsRoot = path.join(home, 'jobs');
  const tokenFile = path.join(home, 'claude-token.dpapi'), jobsFile = path.join(home, 'jobs.json');
  fs.mkdirSync(jobsRoot, { recursive: true });
  const uvEnv = { UV_TOOL_DIR: path.join(tools, 'uv-tools'), UV_TOOL_BIN_DIR: bin, UV_PYTHON_INSTALL_DIR: path.join(tools, 'python'), UV_CACHE_DIR: path.join(tools, 'uv-cache') };
  const harborExe = path.join(bin, win ? 'harbor.exe' : 'harbor');
  const actions = {}; // row -> { busy, text, error }
  let signin = null; // the Connect flow: { proc, url, buf, error }
  let jobs = [];
  try { jobs = JSON.parse(fs.readFileSync(jobsFile, 'utf8')); } catch { /* none yet */ }
  for (const j of jobs) if (j.status === 'running') { j.status = 'stopped'; j.note = 'ClaudeOS closed while it ran.'; }
  let current = null; // { job, proc, stopped }
  const saveJobs = () => { fs.writeFileSync(jobsFile + '.tmp', JSON.stringify(jobs.slice(-30), null, 1)); fs.renameSync(jobsFile + '.tmp', jobsFile); };
  const changed = () => { try { onChange(); } catch { /* the page polls too */ } };

  // ---------- setup checklist ----------
  const dockerDesktop = () => [process.env.ProgramFiles, process.env['ProgramW6432']].filter(Boolean)
    .map(p => path.join(p, 'Docker', 'Docker', 'Docker Desktop.exe')).find(p => fs.existsSync(p));
  async function dockerState() {
    const v = await run('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 15e3 });
    if (v.ok && v.out.trim()) return { state: 'ready', text: `Docker ${v.out.trim().split('\n')[0]} is running` };
    if (v.missing && !dockerDesktop()) return { state: 'missing', text: 'Docker Desktop is not installed' };
    return { state: 'stopped', text: 'Docker Desktop is installed but not running' };
  }
  async function harborState() {
    if (!fs.existsSync(harborExe)) return { state: 'missing', text: 'Harbor is not installed' };
    const v = await run(harborExe, ['--version'], { timeout: 30e3, env: { ...process.env, PYTHONUTF8: '1' } });
    return v.ok ? { state: 'ready', text: `Harbor ${v.out.trim().split('\n').pop()}` } : { state: 'broken', text: 'Harbor does not start; press Reinstall' };
  }
  function claudeState() {
    if (signin) return { state: 'signing-in', text: signin.url ? 'Sign in in your browser, then paste the code the page shows' : 'Starting the Claude sign-in…', url: signin.url || '' };
    return fs.existsSync(tokenFile) ? { state: 'ready', text: 'Connected to your Claude subscription (no API key)' } : { state: 'missing', text: 'Not connected' };
  }
  async function status() {
    const [docker, harbor] = await Promise.all([dockerState(), harborState()]);
    const claude = claudeState();
    const rows = { docker, harbor, claude };
    for (const [k, a] of Object.entries(actions)) if (rows[k]) rows[k] = { ...rows[k], busy: !!a.busy, action: a.text || '', error: a.error || '' };
    return { rows, ready: docker.state === 'ready' && harbor.state === 'ready' && claude.state === 'ready',
      running: current ? current.job.id : null, agents: Object.fromEntries(Object.entries(AGENTS).map(([k, a]) => [k, a.name])) };
  }
  function act(row, label, fn) {
    if (actions[row]?.busy) return { error: 'Already working on it.' };
    actions[row] = { busy: true, text: label };
    changed();
    Promise.resolve().then(fn).then(r => { actions[row] = { busy: false, text: r?.text || '', error: r?.error || '' }; },
      err => { actions[row] = { busy: false, error: err.message || String(err) }; log('harbor setup', row, err.stack || err); })
      .finally(changed);
    return { ok: true };
  }

  const dockerInstall = () => act('docker', 'Installing Docker Desktop (Windows will ask for permission)…', async () => {
    const r = await run('winget', ['install', '-e', '--id', 'Docker.DockerDesktop', '--silent', '--accept-package-agreements', '--accept-source-agreements'], { timeout: 45 * 60e3 });
    if (r.missing) return { error: 'Windows Package Manager (winget) is not available. Install Docker Desktop from docker.com, then press Start.' };
    if (!r.ok && !dockerDesktop()) return { error: 'Docker Desktop did not install: ' + ansi(r.out).trim().split('\n').pop().slice(0, 200) };
    return { text: 'Installed. Press Start (Windows may ask you to restart first).' };
  });
  const dockerStart = () => act('docker', 'Starting Docker Desktop…', async () => {
    const exe = dockerDesktop();
    if (!exe) return { error: 'Docker Desktop is not installed.' };
    spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
    for (let i = 0; i < 60; i++) {
      await new Promise(ok => setTimeout(ok, 5000));
      if ((await dockerState()).state === 'ready') return { text: '' };
    }
    return { error: 'Docker Desktop did not finish starting. If it shows a window asking for something, answer it, then press Start again.' };
  });
  async function findUv() {
    const own = path.join(tools, win ? 'uv.exe' : 'uv');
    if (fs.existsSync(own)) return own;
    if ((await run('uv', ['--version'])).ok) return 'uv';
    // ClaudeOS's own copy of uv, from its official release (it brings its own Python too)
    fs.mkdirSync(tools, { recursive: true });
    const zip = path.join(tools, 'uv.zip');
    const url = 'https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip';
    const r = await run('powershell.exe', [...PS, `$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -UseBasicParsing -Uri '${url}' -OutFile '${zip}'; Expand-Archive -Force -Path '${zip}' -DestinationPath '${tools}'; Remove-Item '${zip}'`], { timeout: 10 * 60e3 });
    if (!r.ok || !fs.existsSync(own)) throw new Error('Could not download uv: ' + r.out.trim().split('\n').pop());
    return own;
  }
  const harborInstall = () => act('harbor', 'Installing Harbor…', async () => {
    const uv = await findUv();
    const r = await run(uv, ['tool', 'install', '--upgrade', 'harbor'], { timeout: 20 * 60e3, env: { ...process.env, ...uvEnv } });
    if (!fs.existsSync(harborExe)) return { error: 'Harbor did not install: ' + ansi(r.out).trim().split('\n').pop().slice(0, 300) };
    return { text: '' };
  });

  async function claudeConnect() {
    if (signin) return { ok: true, already: true };
    if (!loadPty) return { error: 'This ClaudeOS build has no terminal support.' };
    const pty = await loadPty();
    const env = { ...process.env };
    for (const k of STRIP) delete env[k];
    const proc = pty.spawn(win ? 'claude.exe' : 'claude', ['setup-token'], { cols: 400, rows: 50, env });
    const f = signin = { proc, url: '', buf: '' };
    const timer = setTimeout(() => finish('The sign-in timed out. Press Connect to try again.'), 15 * 60e3);
    async function finish(error) {
      if (signin !== f) return;
      clearTimeout(timer);
      try { proc.kill(); } catch { /* gone */ }
      signin = null;
      if (error) actions.claude = { busy: false, error };
      changed();
    }
    proc.onData(async d => {
      f.buf = (f.buf + d).slice(-20000);
      const token = f.buf.match(TOKEN_RE)?.[0];
      if (token) {
        f.buf = '';
        const r = await protect(token);
        if (!r.ok || !r.out.trim()) return finish('Could not store the sign-in safely.');
        fs.mkdirSync(home, { recursive: true });
        fs.writeFileSync(tokenFile, r.out.trim());
        actions.claude = { busy: false, text: '' };
        return finish('');
      }
      // the sign-in link: from the terminal hyperlink if there is one, else the text
      const osc = f.buf.match(/\x1b\]8;[^;]*;(https:\/\/[^\x07\x1b]*oauth[^\x07\x1b]*)/)?.[1];
      const url = osc || ansi(f.buf).replace(/\r?\n/g, '').match(/https:\/\/claude\.(?:com|ai)\/[^\s"']*oauth[^\s"']*/)?.[0];
      if (url && !f.url) { f.url = url; changed(); }
    });
    proc.onExit(() => finish(fs.existsSync(tokenFile) ? '' : 'The sign-in ended without connecting. Press Connect to try again.'));
    actions.claude = { busy: false };
    changed();
    return { ok: true };
  }
  function claudeCode(code) {
    code = String(code || '').trim();
    if (!signin) return { error: 'No sign-in is running. Press Connect again.' };
    if (!/^[\w#.~-]{8,400}$/.test(code)) return { error: "That doesn't look like a sign-in code. Copy the whole code from the page." };
    signin.proc.write(code + '\r');
    return { ok: true };
  }
  function claudeCancel() { if (signin) { try { signin.proc.kill(); } catch { /* gone */ } signin = null; changed(); } return { ok: true }; }
  function claudeDisconnect() { fs.rmSync(tokenFile, { force: true }); actions.claude = {}; changed(); return { ok: true }; }

  // ---------- the ClaudeOS bundle: what a ClaudeOS chat gets on top of Claude Code ----------
  function writeBundle(dir) {
    const h = harness();
    if (h.error) throw new Error(h.error);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(dir, 'brain'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'foundations.md'), h.foundations);
    fs.writeFileSync(path.join(dir, 'runtime.md'), h.context.split(h.brainDir).join('/claudeos/brain'));
    for (const f of ['CLAUDE.md', 'AGENTS.md']) if (fs.existsSync(path.join(h.brainDir, f))) fs.copyFileSync(path.join(h.brainDir, f), path.join(dir, 'brain', f));
    const skills = path.join(h.brainDir, '.claude', 'skills');
    if (fs.existsSync(skills)) fs.cpSync(skills, path.join(dir, 'brain', '.claude', 'skills'), { recursive: true, filter: s => !/node_modules/.test(s) });
    if (h.memoryFile && fs.existsSync(h.memoryFile)) {
      fs.copyFileSync(h.memoryFile, path.join(dir, 'memory.jsonl'));
      // ClaudeOS's own memory server (the official one with its lean search), as a ClaudeOS chat gets it
      fs.writeFileSync(path.join(dir, 'memory-mcp.mjs'), `import { KnowledgeGraphManager, main } from '@modelcontextprotocol/server-memory/dist/index.js';
const trimSearch = ${trimSearch.toString()};
const original = KnowledgeGraphManager.prototype.searchNodes;
KnowledgeGraphManager.prototype.searchNodes = async function (query) { return trimSearch(await original.call(this, query), query, ${SEARCH_NOTES}); };
main();
`);
      fs.writeFileSync(path.join(dir, 'mcp.json'), JSON.stringify({ mcpServers: { memory: { command: 'node', args: ['/claudeos/memory-mcp.mjs'], env: { MEMORY_FILE_PATH: '/claudeos/memory.jsonl' } } } }));
    }
    return { options: h.options || {}, brainName: h.brainName || '' };
  }

  // ---------- jobs ----------
  function trialResult(jobDir) {
    const sub = fs.existsSync(jobDir) ? fs.readdirSync(jobDir, { withFileTypes: true }).filter(d => d.isDirectory()) : [];
    for (const d of sub) {
      const f = path.join(jobDir, d.name, 'result.json');
      if (fs.existsSync(f)) return { dir: path.join(jobDir, d.name), r: JSON.parse(fs.readFileSync(f, 'utf8')) };
    }
    return null;
  }
  const secs = t => t?.started_at && t?.finished_at ? (Date.parse(t.finished_at) - Date.parse(t.started_at)) / 1000 : null;

  // one attempt: one contestant on one task
  async function runOne(job, agent, n, env, item, bundle) {
    const name = `${job.id}-${agent}-${item.name}-${n}`;
    const args = ['run', ...item.source, ...AGENTS[agent].args(bundle, agent === 'claudeos' ? job.advisor : ''), '-k', '1', '-n', '1', '-o', path.join(jobsRoot, job.id), '--job-name', name, '-y', '-q'];
    if (job.model) args.push('-m', `anthropic/${job.model}`);
    if (job.effort) args.push('--ak', `reasoning_effort=${job.effort}`);
    const task = item.task;
    const trial = { agent, n, task: item.name, status: 'running', started: Date.now() };
    job.trials.push(trial); saveJobs(); changed();
    const out = await new Promise(resolve => {
      const p = spawn(harborExe, args, { windowsHide: true, env, cwd: home });
      current.proc = p;
      let text = '';
      p.stdout.on('data', d => { text = (text + d).slice(-20000); });
      p.stderr.on('data', d => { text = (text + d).slice(-20000); });
      p.on('close', code => resolve({ code, text }));
      p.on('error', err => resolve({ code: -1, text: err.message }));
    });
    current.proc = null;
    if (current.stopped) { trial.status = 'stopped'; return trial; }
    const found = trialResult(path.join(jobsRoot, job.id, name));
    if (!found) { trial.status = 'error'; trial.note = ansi(out.text).trim().split('\n').slice(-3).join(' ').slice(0, 300); return trial; }
    const { r, dir } = found, a = r.agent_result || {};
    let agentLog = '';
    try { agentLog = fs.readFileSync(path.join(dir, 'agent', 'claude-code.txt'), 'utf8').slice(-20000); } catch { /* no log */ }
    Object.assign(trial, {
      dir, reward: r.verifier_result?.rewards?.reward ?? null,
      seconds: secs(r.agent_execution), input: a.n_input_tokens ?? null, cached: a.n_cache_tokens ?? null, output: a.n_output_tokens ?? null,
      cost: a.cost_usd ?? null, error: r.exception_info ? `${r.exception_info.exception_type}: ${String(r.exception_info.exception_message || '').slice(0, 200)}` : '',
    });
    if (LIMIT_RE.test(trial.error) || (LIMIT_RE.test(agentLog) && /"is_error":\s*true/.test(agentLog))) { trial.status = 'limit'; return trial; }
    // the full behaviour tests, in a real browser on this PC, on the files the agent left
    const site = path.join(dir, 'artifacts', 'app');
    // a Terminal-Bench task is solved when its own tests pass (reward 1)
    if (!task) { trial.solved = trial.reward === 1; trial.score = trial.reward == null ? null : Math.round(trial.reward * 100); }
    else if (gradeWeb && task.checks.behaviour) {
      try {
        const g = await gradeWeb(site, task, path.join(dir, 'shots'));
        const gates = g.gates.every(x => x.ok);
        trial.gates = g.gates.filter(x => !x.ok).map(x => x.id);
        trial.behaviour = g.F; trial.robust = g.R;
        const wb = task.checks.behaviour.weight || 65, wr = task.checks.robust?.weight || 10;
        trial.score = gates ? Math.round((wb * g.F + wr * g.R) / (wb + wr) * 100) : 0;
        trial.solved = gates && g.F === 1;
      } catch (e) { trial.gradeError = e.message.slice(0, 200); }
    }
    trial.status = trial.error ? 'error' : 'done';
    return trial;
  }

  function summarize(job) {
    const by = {};
    for (const agent of job.contestants) {
      const t = job.trials.filter(x => x.agent === agent && x.status === 'done');
      const nums = k => t.map(x => x[k]).filter(v => typeof v === 'number');
      by[agent] = { name: AGENTS[agent].name, runs: t.length, solved: t.filter(x => x.solved).length,
        score: median(nums('score')), seconds: median(nums('seconds')), input: median(nums('input')), cached: median(nums('cached')),
        output: median(nums('output')), cost: median(nums('cost')), costPerSolved: t.some(x => x.solved) ? nums('cost').reduce((s, v) => s + v, 0) / t.filter(x => x.solved).length : null };
    }
    // bootstrap: how often ClaudeOS comes out cheaper / better when the runs are resampled
    const [a, b] = ['claudeos', 'claude-code'].map(k => job.trials.filter(x => x.agent === k && x.status === 'done'));
    let cheaper = null, better = null;
    if (a.length >= 2 && b.length >= 2) {
      const pick = arr => arr[crypto.randomInt(arr.length)];
      const resample = (arr, k) => median(arr.map(() => pick(arr)[k]).filter(v => typeof v === 'number'));
      let c = 0, q = 0, N = 2000;
      for (let i = 0; i < N; i++) {
        if (resample(a, 'cost') < resample(b, 'cost')) c++;
        if (resample(a, 'score') > resample(b, 'score')) q++;
      }
      cheaper = c / N; better = q / N;
    }
    job.summary = { by, cheaper, better };
  }

  function runJob({ task: taskId, trials = 3, contestants = ['claudeos', 'claude-code'] }) {
    if (current) return { error: 'A benchmark is already running.' };
    taskId = String(taskId || '');
    const suite = SUITES[taskId], task = suite ? null : loadTask(taskId);
    if (!suite && !task) return { error: 'Unknown task.' };
    trials = Math.max(1, Math.min(10, Number(trials) || 3));
    contestants = [...new Set(contestants)].filter(c => AGENTS[c]);
    if (!contestants.length) return { error: 'Pick at least one contestant.' };
    const job = { id: new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + '-' + crypto.randomBytes(2).toString('hex'),
      task: suite ? suite.name : task.id, suite: suite ? taskId : null, trials: [], perAgent: trials, contestants, started: Date.now(), status: 'running', note: '' };
    current = { job, proc: null, stopped: false };
    jobs.push(job); saveJobs(); changed();
    (async () => {
      const s = await status();
      if (!s.ready) throw new Error('Finish the setup checklist first.');
      const enc = fs.readFileSync(tokenFile, 'utf8');
      const tok = (await unprotect(enc)).out.trim();
      if (!TOKEN_RE.test(tok)) throw new Error('The Claude connection could not be read. Press Disconnect, then Connect again.');
      const env = { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: tok, CLAUDE_FORCE_OAUTH: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8',
        PYTHONPATH: path.join(kit, 'harbor') + (process.env.PYTHONPATH ? path.delimiter + process.env.PYTHONPATH : '') };
      for (const k of STRIP) delete env[k];
      const work = path.join(jobsRoot, job.id);
      // the tasks: an AI Bench task built for Harbor, or Terminal-Bench tasks from the Harbor registry
      const items = task
        ? [{ name: task.id, task, source: ['-p', buildHarborTask(task, path.join(work, 'tasks'), kit)] }]
        : (suite.tasks || await registryTasks()).map(name => ({ name, task: null, source: ['-d', TB2, '-i', name] }));
      const bundle = path.join(work, 'claudeos-bundle');
      const b = writeBundle(bundle);
      // the same model and effort as the brain's ClaudeOS chats, for every contestant; ClaudeOS also gets its advisor
      job.model = b.options.model || ''; job.effort = b.options.effort || ''; job.advisor = advisorOf(b.options); job.brain = b.brainName;
      job.tasks = items.map(i => i.name);
      saveJobs(); changed();
      for (let n = 1; n <= trials && !current.stopped; n++) {
        for (const [i, item] of items.entries()) {
          // alternate who goes first, so neither side always gets the warmer cache or quieter servers
          const order = (n + i) % 2 ? contestants : [...contestants].reverse();
          for (const agent of order) {
            if (current.stopped) break;
            const t = await runOne(job, agent, n, env, item, bundle);
            summarize(job); saveJobs(); changed();
            if (t.status === 'limit') { job.note = 'Stopped: your Claude usage limit was reached. Run the rest after it resets.'; current.stopped = true; }
          }
          if (current.stopped) break;
        }
      }
    })().then(() => { job.status = current.stopped ? (job.note ? 'paused' : 'stopped') : 'done'; },
      err => { job.status = 'failed'; job.note = err.message; log('harbor job', err.stack || err); })
      .finally(() => { job.ended = Date.now(); summarize(job); current = null; saveJobs(); changed(); });
    return { ok: true, id: job.id };
  }
  // every task in Terminal-Bench 2.0, as the registry lists it
  async function registryTasks() {
    const dir = path.join(home, 'registry', 'tb2');
    if (!fs.existsSync(dir)) {
      const r = await run(harborExe, ['download', TB2, '-o', dir], { timeout: 20 * 60e3, env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } });
      if (!r.ok) throw new Error('Could not download Terminal-Bench 2.0: ' + ansi(r.out).trim().split('\n').pop().slice(0, 200));
    }
    const names = [];
    (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (fs.existsSync(path.join(p, 'task.toml'))) names.push(e.name); else walk(p); } } })(dir);
    if (!names.length) throw new Error('Terminal-Bench 2.0 has no tasks in ' + dir);
    return names.sort();
  }
  function stopJob() {
    if (!current) return { ok: true };
    current.stopped = true;
    killTree(current.proc);
    return { ok: true };
  }
  const listJobs = () => jobs.slice(-30).reverse();

  return { status, dockerInstall, dockerStart, harborInstall, claudeConnect, claudeCode, claudeCancel, claudeDisconnect, runJob, stopJob, listJobs,
    busy: () => !!current, _test: { summarize, writeBundle, trialResult } };
}
