// The Terminal tab: shell tabs both the user and Claude can run commands in, with live output.
// Each tab keeps one PowerShell (bash elsewhere) running, so `cd`, variables and functions carry
// over from one command to the next, like a real terminal. Each command goes to the shell's stdin as
// one line (encoded, so multi-line scripts work) followed by a marker line that says it's done, its
// exit code and the folder the shell is in now. While a command runs, what you type goes to its stdin,
// so a program that asks a question gets the answer. Full-screen programs (vim, htop) need a real
// console and don't work here. Claude starts commands through the chat's claudeos MCP tools
// (terminal_run asks the user first, like Bash), the user types them in the tab.
import { spawn, execFile, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MAX_CHARS = 200000; // output kept per tab
const MAX_TABS = 12;
const WIN = process.platform === 'win32';
const b64 = s => Buffer.from(s, 'utf8').toString('base64');
// PowerShell 7 when it's installed (shorter errors), else Windows PowerShell; looked up once
let shellExe;
function powershell() {
  if (!shellExe) { try { execFileSync('where', ['pwsh'], { windowsHide: true, stdio: 'ignore' }); shellExe = 'pwsh.exe'; } catch { shellExe = 'powershell.exe'; } }
  return shellExe;
}

export function createTerminals({ broadcast }) {
  const tabs = new Map(); // id -> { id, title, cwd, out, shell, busy, by, started, command, code }

  const view = t => ({ id: t.id, title: t.title, cwd: t.cwd, running: !!t.busy, by: t.by, command: t.command || '', code: t.code ?? null });
  const emit = ev => broadcast('terminal', ev);
  function append(t, text) {
    if (!text) return;
    t.out = (t.out + text).slice(-MAX_CHARS);
    emit({ kind: 'out', id: t.id, text });
  }

  function open({ title = '', cwd, by = 'you' } = {}) {
    if (tabs.size >= MAX_TABS) {
      // the oldest tab with nothing running makes room
      const old = [...tabs.values()].find(t => !t.busy);
      if (!old) return { error: `${MAX_TABS} terminal tabs are running. Stop one first.` };
      close(old.id);
    }
    try { if (!fs.statSync(cwd).isDirectory()) throw 0; } catch { return { error: `No such folder: ${cwd}` }; }
    const t = { id: crypto.randomBytes(3).toString('hex'), title: String(title || path.basename(cwd) || 'Terminal').slice(0, 40), cwd, out: '', shell: null, busy: false, by, started: Date.now() };
    tabs.set(t.id, t);
    emit({ kind: 'tabs', tabs: list() });
    return { ok: true, tab: view(t) };
  }

  // The tab's shell, started in the tab's folder the first time it's needed (and again after `exit`
  // or a Stop that had to end it).
  function shellOf(t) {
    if (t.shell) return t.shell;
    const mark = `__claudeos_${crypto.randomBytes(4).toString('hex')}__`;
    const proc = WIN
      ? spawn(powershell(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'], { cwd: t.cwd, windowsHide: true, env: { ...process.env, FORCE_COLOR: '0' } })
      : spawn('bash', ['--norc', '--noprofile', '-s'], { cwd: t.cwd, env: { ...process.env, FORCE_COLOR: '0' } });
    const sh = { proc, mark, pending: '' };
    t.shell = sh;
    // UTF-8 both ways, so names and output with accents come through; no colour codes (the tab is plain text)
    if (WIN) proc.stdin.write('[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding; if ($PSStyle) { $PSStyle.OutputRendering = \'PlainText\' }\n');
    const done = new RegExp(`\\r?\\n?${mark}(-?\\d+) (.*?)\\r?\\n`);
    proc.stdout.on('data', d => {
      sh.pending += d;
      let m;
      while ((m = sh.pending.match(done))) {
        append(t, sh.pending.slice(0, m.index));
        sh.pending = sh.pending.slice(m.index + m[0].length);
        finished(t, Number(m[1]), m[2]);
      }
      // keep back only what could be the start of a marker; a prompt without a newline shows at once
      let keep = 0;
      const at = sh.pending.indexOf(mark);
      if (at >= 0) keep = sh.pending.length - Math.max(0, at - (sh.pending[at - 1] === '\n' ? (sh.pending[at - 2] === '\r' ? 2 : 1) : 0));
      else for (let n = Math.min(sh.pending.length, mark.length + 2); n > 0; n--) {
        if (mark.startsWith(sh.pending.slice(-n).replace(/^\r?\n?/, ''))) { keep = n; break; }
      }
      append(t, sh.pending.slice(0, sh.pending.length - keep));
      sh.pending = sh.pending.slice(sh.pending.length - keep);
    });
    proc.stderr.on('data', d => append(t, String(d)));
    proc.stdin.on('error', () => { /* it quit; 'close' says so */ });
    const gone = () => {
      if (t.shell !== sh) return;
      t.shell = null;
      append(t, sh.pending);
      if (t.busy) finished(t, -1, t.cwd);
    };
    proc.on('error', err => { append(t, `${err.message}\n`); gone(); });
    proc.on('close', gone);
    return sh;
  }

  function finished(t, code, cwd) {
    t.busy = false;
    t.code = code;
    if (cwd && cwd !== t.cwd) t.cwd = cwd;
    if (code) append(t, `[exited with code ${code}]\n`);
    emit({ kind: 'tabs', tabs: list() });
  }

  // run a command in a tab (a new one when none is given); returns at once, output streams
  function run({ command, tab, title, cwd, by = 'you' }) {
    command = String(command || '').trim();
    if (!command) return { error: 'No command.' };
    let t = tab && tabs.get(tab);
    if (tab && !t) return { error: `No terminal tab ${tab}.` };
    if (!t) { const r = open({ title: title || command.split(/\s+/)[0], cwd, by }); if (r.error) return r; t = tabs.get(r.tab.id); }
    if (t.busy) return { error: `Tab "${t.title}" is still running "${t.command}". Stop it, or use another tab.` };
    const sh = shellOf(t);
    t.busy = true; t.command = command; t.code = null; t.by = by; t.runs = (t.runs || 0) + 1;
    append(t, `${t.out ? '\n' : ''}${WIN ? 'PS ' : ''}${t.cwd}${WIN ? '>' : ' $'} ${command}\n`);
    // dot-sourced, so what the command defines stays in the shell; the marker carries the exit code
    // (a native program's, or 1 when a PowerShell command wrote an error) and the folder
    const line = WIN
      ? `$global:LASTEXITCODE = 0; $Error.Clear(); try { . ([scriptblock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(command)}')))) 2>&1 } catch { $_ }; ` +
        `"${sh.mark}$(if ($LASTEXITCODE) { $LASTEXITCODE } elseif (@($Error | Where-Object { $_.FullyQualifiedErrorId -ne 'NativeCommandError' }).Count) { 1 } else { 0 }) $((Get-Location).ProviderPath)"\n`
      : `eval "$(printf %s '${b64(command)}' | base64 -d)"; printf '\\n${sh.mark}%s %s\\n' "$?" "$PWD"\n`;
    try { sh.proc.stdin.write(line); } catch (err) { append(t, `${err.message}\n`); finished(t, -1, t.cwd); }
    emit({ kind: 'tabs', tabs: list() });
    return { ok: true, tab: view(t) };
  }

  // text typed while a command runs goes to that program's stdin
  function input({ tab, text }) {
    const t = tabs.get(tab);
    if (!t) return { error: `No terminal tab ${tab}.` };
    if (!t.busy || !t.shell) return { error: 'Nothing is running in that tab.' };
    append(t, `${text}\n`);
    try { t.shell.proc.stdin.write(`${text}\n`); } catch (err) { return { error: err.message }; }
    return { ok: true };
  }

  // the last lines of a tab; with wait, holds on until new output arrives or the time is up
  async function read({ tab, lines = 200, wait = 0 }) {
    const t = tabs.get(tab);
    if (!t) return { error: `No terminal tab ${tab}.` };
    if (wait > 0 && t.busy) {
      const before = t.out.length;
      const until = Date.now() + Math.min(Number(wait) || 0, 60000);
      while (Date.now() < until && t.out.length === before && t.busy) await new Promise(r => setTimeout(r, 200));
    }
    const n = Math.max(1, Math.min(2000, Number(lines) || 200));
    return { ok: true, tab: view(t), text: t.out.split('\n').slice(-n).join('\n') };
  }

  // Ctrl+C: end what the command started and keep the shell. A command that started no program (a
  // PowerShell loop) can only be ended with its shell; the next command starts a new one in that folder.
  function stop(id) {
    const t = tabs.get(id);
    if (!t) return { error: `No terminal tab ${id}.` };
    if (!t.busy || !t.shell) return { ok: true };
    const sh = t.shell, runs = t.runs;
    append(t, '^C\n');
    if (!WIN) { execFile('pkill', ['-INT', '-P', String(sh.proc.pid)], () => {}); return { ok: true }; }
    execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      // the shell's own conhost isn't the command
      `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${sh.proc.pid} AND Name<>'conhost.exe'").ProcessId -join ' '`], { windowsHide: true }, (err, out) => {
      const kids = String(out || '').trim().split(/\s+/).filter(p => /^\d+$/.test(p));
      if (kids.length) for (const pid of kids) execFile('taskkill', ['/pid', pid, '/T', '/F'], { windowsHide: true }, () => {});
      // still busy a moment later: the command was PowerShell itself, so the shell goes
      setTimeout(() => {
        if (t.shell !== sh || !t.busy || t.runs !== runs) return;
        execFile('taskkill', ['/pid', String(sh.proc.pid), '/T', '/F'], { windowsHide: true }, () => {});
        append(t, '[the shell was restarted; variables set in it are gone]\n');
      }, kids.length ? 1500 : 0);
    });
    return { ok: true };
  }
  function close(id) {
    const t = tabs.get(id);
    if (!t) return { error: `No terminal tab ${id}.` };
    tabs.delete(id);
    if (t.shell) execFile(WIN ? 'taskkill' : 'kill', WIN ? ['/pid', String(t.shell.proc.pid), '/T', '/F'] : ['-9', String(t.shell.proc.pid)], { windowsHide: true }, () => {});
    emit({ kind: 'tabs', tabs: list() });
    return { ok: true };
  }
  const list = () => [...tabs.values()].map(view);
  function snapshot() { return { tabs: [...tabs.values()].map(t => ({ ...view(t), out: t.out })) }; }
  function stopAll() { for (const id of [...tabs.keys()]) close(id); }

  return { open, run, input, read, stop, close, list, snapshot, stopAll };
}
