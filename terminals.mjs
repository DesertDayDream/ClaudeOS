// The Terminal tab: real console tabs both the user and Claude use, like the terminal in Claude
// Desktop or VS Code. Each tab is a pseudo-console (ConPTY through node-pty) running PowerShell
// (bash elsewhere), so full-screen programs (vim, htop, less, Claude Code itself), colours, Tab
// completion and Ctrl+C all work. The page draws it with xterm.js; here a headless xterm keeps the
// same screen, so a page that opens later (or Claude, through terminal_read) sees what is on it.
// A small prompt hook (VS Code's OSC 633 shell-integration codes) tells us when a command has
// finished, its exit code and the folder the shell is in. Claude starts commands through the chat's
// claudeos MCP tools (terminal_run asks the user first, like Bash); the user types in the tab.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';
import { loadNodePty } from './runtime.mjs';

const MAX_TABS = 12;
const SCROLLBACK = 5000;
const WIN = process.platform === 'win32';
const b64 = s => Buffer.from(s, 'utf8').toString('base64');
// PowerShell 7 when it's installed, else Windows PowerShell; looked up once
let shellExe;
function powershell() {
  if (!shellExe) { try { execFileSync('where', ['pwsh'], { windowsHide: true, stdio: 'ignore' }); shellExe = 'pwsh.exe'; } catch { shellExe = 'powershell.exe'; } }
  return shellExe;
}

// The prompt hook. It wraps the user's own prompt (their profile still loads) and puts two
// invisible codes in front of it: D;<exit code> (the last command is done) and P;Cwd=<folder>.
const PWSH_INIT = `[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding
$global:__claudeosPrompt = $function:prompt
function global:prompt {
  $ok = $?; $c = if ($ok) { 0 } elseif ($global:LASTEXITCODE) { $global:LASTEXITCODE } else { 1 }; $global:LASTEXITCODE = 0
  $e = [char]27; $b = [char]7
  "$e]633;D;$c$b$e]633;P;Cwd=$((Get-Location).ProviderPath)$b" + (& $global:__claudeosPrompt)
}`;
const BASH_INIT = `[ -f ~/.bashrc ] && . ~/.bashrc
__claudeos_prompt() { printf '\\033]633;D;%s\\007\\033]633;P;Cwd=%s\\007' "$?" "$PWD"; }
PROMPT_COMMAND="__claudeos_prompt\${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
`;

export function createTerminals({ broadcast, data }) {
  const tabs = new Map(); // id -> tab (see open)
  let pty = null;
  const nodePty = () => (pty ||= loadNodePty(data));

  const view = t => ({ id: t.id, title: t.title, cwd: t.cwd, running: !!t.busy, by: t.by, command: t.command || '', code: t.code ?? null, alive: !!t.proc });
  const emit = ev => broadcast('terminal', ev);
  const tabsChanged = () => emit({ kind: 'tabs', tabs: list() });

  // What the console printed: into the headless screen, and to the pages (a few ms batched, so a
  // full-screen redraw is one event, not hundreds). seq lets a page that loaded a snapshot skip what's in it.
  function output(t, text) {
    t.screen.write(text);
    t.changes++;
    t.queued += text;
    t.flush ||= setTimeout(() => {
      t.flush = null;
      t.seq++;
      emit({ kind: 'out', id: t.id, seq: t.seq, data: t.queued });
      t.queued = '';
    }, 6);
  }

  function open({ title = '', cwd, by = 'you', cols = 100, rows = 30 } = {}) {
    if (tabs.size >= MAX_TABS) {
      // the oldest tab with nothing running makes room
      const old = [...tabs.values()].find(t => !t.busy);
      if (!old) return { error: `${MAX_TABS} terminal tabs are running. Stop one first.` };
      close(old.id);
    }
    try { if (!fs.statSync(cwd).isDirectory()) throw 0; } catch { return { error: `No such folder: ${cwd}` }; }
    const screen = new headless.Terminal({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true });
    const ser = new serialize.SerializeAddon();
    screen.loadAddon(ser);
    const t = {
      id: crypto.randomBytes(3).toString('hex'), title: String(title || path.basename(cwd) || 'Terminal').slice(0, 40), cwd, by, started: Date.now(),
      screen, ser, cols, rows, proc: null, ready: false, waiting: [], busy: false, command: '', code: null, runs: 0,
      seq: 0, changes: 0, queued: '', flush: null,
    };
    screen.parser.registerOscHandler(633, d => { marker(t, d); return true; });
    tabs.set(t.id, t);
    const r = start(t);
    if (r.error) { tabs.delete(t.id); return r; }
    tabsChanged();
    return { ok: true, tab: view(t) };
  }

  // The tab's shell, in the tab's folder (again after `exit`: the next key or command starts a new one).
  function start(t) {
    let proc;
    try {
      const opts = { name: 'xterm-256color', cols: t.cols, rows: t.rows, cwd: t.cwd, env: { ...process.env, TERM_PROGRAM: 'ClaudeOS', COLORTERM: 'truecolor' } };
      if (WIN) {
        proc = nodePty().spawn(powershell(), ['-NoLogo', '-NoExit', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(PWSH_INIT, 'utf16le').toString('base64')],
          { ...opts, useConpty: true, useConptyDll: true });
      } else {
        const rc = path.join(os.tmpdir(), 'claudeos-bashrc');
        fs.writeFileSync(rc, BASH_INIT);
        proc = nodePty().spawn('bash', ['--rcfile', rc, '-i'], opts);
      }
    } catch (err) { return { error: `Couldn't start a console: ${err.message}` }; }
    t.proc = proc; t.ready = false;
    proc.onData(d => { if (t.proc === proc) output(t, d); });
    proc.onExit(() => {
      if (t.proc !== proc) return;
      t.proc = null; t.ready = false;
      if (t.busy) finished(t, -1);
      if (tabs.has(t.id)) { output(t, '\r\n\x1b[2m[The shell ended. Press a key to start a new one.]\x1b[0m\r\n'); tabsChanged(); }
    });
    return { ok: true };
  }

  // the prompt hook's codes: D = the last command is done (a prompt is up), P = the folder
  function marker(t, d) {
    const [kind, ...rest] = d.split(';');
    const arg = rest.join(';');
    if (kind === 'P' && arg.startsWith('Cwd=')) {
      const cwd = arg.slice(4);
      if (cwd && cwd !== t.cwd) { t.cwd = cwd; tabsChanged(); }
    } else if (kind === 'D') {
      // the shell's first prompt: now it takes the command sent while it started
      if (!t.ready) { t.ready = true; for (const line of t.waiting.splice(0)) t.proc?.write(line); return; }
      if (t.busy) finished(t, Number(arg) || 0);
    }
  }

  function finished(t, code) {
    t.busy = false;
    t.code = code;
    tabsChanged();
  }

  // Run a command in a tab (a new one when none is given), as if typed at its prompt; returns at
  // once, output streams. A multi-line script goes in encoded, so it runs as one command.
  function run({ command, tab, title, cwd, by = 'you' }) {
    command = String(command || '').trim();
    if (!command) return { error: 'No command.' };
    let t = tab && tabs.get(tab);
    if (tab && !t) return { error: `No terminal tab ${tab}.` };
    if (!t) { const r = open({ title: title || command.split(/\s+/)[0], cwd, by }); if (r.error) return r; t = tabs.get(r.tab.id); }
    if (t.busy) return { error: `Tab "${t.title}" is still running "${t.command}". Stop it, or use another tab.` };
    if (!t.proc) { const r = start(t); if (r.error) return r; }
    const multi = command.includes('\n');
    const line = !multi ? command
      : WIN ? `. ([scriptblock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(command)}'))))`
      : `eval "$(printf %s '${b64(command)}' | base64 -d)"`;
    t.busy = true; t.command = command; t.code = null; t.by = by; t.runs++;
    if (t.ready) t.proc.write(`${line}\r`); else t.waiting.push(`${line}\r`);
    tabsChanged();
    return { ok: true, tab: view(t) };
  }

  // Keys from the page, as the terminal sends them (escape codes and all). Enter at a prompt starts
  // a command, so the tab shows it running until the next prompt.
  function input({ tab, data }) {
    const t = tabs.get(tab);
    if (!t) return { error: `No terminal tab ${tab}.` };
    if (!t.proc) { const r = start(t); return r.error ? r : { ok: true }; }
    if (!t.busy && t.ready && /\r/.test(data)) {
      const typed = currentLine(t);
      if (typed) { t.busy = true; t.command = typed; t.code = null; t.by = 'you'; t.runs++; tabsChanged(); }
    }
    try { t.proc.write(data); } catch (err) { return { error: err.message }; }
    return { ok: true };
  }
  // what's typed after the prompt on the cursor's line ("PS C:\x> git status" -> "git status")
  function currentLine(t) {
    const b = t.screen.buffer.active;
    const text = b.getLine(b.baseY + b.cursorY)?.translateToString(true) || '';
    return text.replace(/^.*?(?:PS [^>]*>|[$#>]) ?/, '').trim().slice(0, 200);
  }

  function resize({ tab, cols, rows }) {
    const t = tabs.get(tab);
    if (!t) return { error: `No terminal tab ${tab}.` };
    cols = Math.max(20, Math.min(500, Number(cols) || 0)); rows = Math.max(5, Math.min(200, Number(rows) || 0));
    if (cols === t.cols && rows === t.rows) return { ok: true };
    t.cols = cols; t.rows = rows;
    t.screen.resize(cols, rows);
    try { t.proc?.resize(cols, rows); } catch { /* it just quit */ }
    return { ok: true };
  }

  // The tab as plain text, the last lines; with wait, holds on until new output arrives, the command
  // finishes or the time is up.
  async function read({ tab, lines = 200, wait = 0 }) {
    const t = tabs.get(tab);
    if (!t) return { error: `No terminal tab ${tab}.` };
    if (wait > 0 && t.busy) {
      const before = t.changes;
      const until = Date.now() + Math.min(Number(wait) || 0, 60000);
      while (Date.now() < until && t.changes === before && t.busy) await new Promise(r => setTimeout(r, 200));
      await new Promise(r => setTimeout(r, 150)); // let the rest of a burst land
    }
    const n = Math.max(1, Math.min(2000, Number(lines) || 200));
    return { ok: true, tab: view(t), text: text(t).split('\n').slice(-n).join('\n') };
  }
  function text(t) {
    const b = t.screen.buffer.active, out = [];
    for (let i = 0; i < b.length; i++) {
      const l = b.getLine(i);
      if (l?.isWrapped && out.length) out[out.length - 1] += l.translateToString(true);
      else out.push(l?.translateToString(true) ?? '');
    }
    while (out.length && !out.at(-1).trim()) out.pop();
    return out.join('\n');
  }

  // Ctrl+C, as if pressed in the tab. Something that ignores it (or a hung shell) is ended with
  // its whole process tree a moment later, and the next key or command starts a new shell.
  function stop(id) {
    const t = tabs.get(id);
    if (!t) return { error: `No terminal tab ${id}.` };
    if (!t.busy || !t.proc) return { ok: true };
    const proc = t.proc, runs = t.runs;
    try { proc.write('\x03'); } catch { /* gone */ }
    setTimeout(() => {
      if (t.proc !== proc || !t.busy || t.runs !== runs) return;
      kill(proc);
    }, 2500);
    return { ok: true };
  }
  function kill(proc) {
    const pid = proc.pid;
    if (WIN) execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => { try { proc.kill(); } catch { /* gone */ } });
    else try { proc.kill('SIGKILL'); } catch { /* gone */ }
  }
  function close(id) {
    const t = tabs.get(id);
    if (!t) return { error: `No terminal tab ${id}.` };
    tabs.delete(id);
    clearTimeout(t.flush);
    if (t.proc) kill(t.proc);
    t.proc = null;
    t.screen.dispose();
    tabsChanged();
    return { ok: true };
  }
  const list = () => [...tabs.values()].map(view);
  // each tab's screen (colours, scrollback, an open vim) for a page that just loaded
  // (what's batched goes out first, and the headless screen catches up, so seq marks exactly what's in it)
  async function snapshot() {
    const all = [...tabs.values()];
    for (const t of all) if (t.flush) { clearTimeout(t.flush); t.flush = null; t.seq++; emit({ kind: 'out', id: t.id, seq: t.seq, data: t.queued }); t.queued = ''; }
    await Promise.all(all.map(t => new Promise(r => t.screen.write('', r))));
    return { tabs: all.filter(t => tabs.has(t.id)).map(t => ({ ...view(t), cols: t.cols, rows: t.rows, seq: t.seq, screen: t.ser.serialize({ scrollback: 2000 }) })) };
  }
  function stopAll() { for (const id of [...tabs.keys()]) close(id); }

  return { open, run, input, resize, read, stop, close, list, snapshot, stopAll };
}
