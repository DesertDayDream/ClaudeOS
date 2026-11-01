// The Terminal tab: shell tabs both the user and Claude can run commands in, with live output.
// Each command runs as its own PowerShell (bash elsewhere) in the tab's folder; a tab keeps its
// output and remembers whether something is still running, so a dev server or a watcher can be
// left going, read later and stopped. Claude starts commands through the chat's claudeos MCP tools
// (terminal_run asks the user first, like Bash), the user types them in the tab.
import { spawn, execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MAX_CHARS = 200000; // output kept per tab
const MAX_TABS = 12;

export function createTerminals({ broadcast }) {
  const tabs = new Map(); // id -> { id, title, cwd, out, proc, by, started }

  const view = t => ({ id: t.id, title: t.title, cwd: t.cwd, running: !!t.proc, by: t.by, command: t.command || '', code: t.code ?? null });
  const emit = ev => broadcast('terminal', ev);
  function append(t, text) {
    t.out = (t.out + text).slice(-MAX_CHARS);
    emit({ kind: 'out', id: t.id, text });
  }

  function open({ title = '', cwd, by = 'you' } = {}) {
    if (tabs.size >= MAX_TABS) {
      // the oldest tab with nothing running makes room
      const old = [...tabs.values()].find(t => !t.proc);
      if (!old) return { error: `${MAX_TABS} terminal tabs are running. Stop one first.` };
      close(old.id);
    }
    try { if (!fs.statSync(cwd).isDirectory()) throw 0; } catch { return { error: `No such folder: ${cwd}` }; }
    const t = { id: crypto.randomBytes(3).toString('hex'), title: String(title || path.basename(cwd) || 'Terminal').slice(0, 40), cwd, out: '', proc: null, by, started: Date.now() };
    tabs.set(t.id, t);
    emit({ kind: 'tabs', tabs: list() });
    return { ok: true, tab: view(t) };
  }

  // run a command in a tab (a new one when none is given); returns at once, output streams
  function run({ command, tab, title, cwd, by = 'you' }) {
    command = String(command || '').trim();
    if (!command) return { error: 'No command.' };
    let t = tab && tabs.get(tab);
    if (tab && !t) return { error: `No terminal tab ${tab}.` };
    if (!t) { const r = open({ title: title || command.split(/\s+/)[0], cwd, by }); if (r.error) return r; t = tabs.get(r.tab.id); }
    if (t.proc) return { error: `Tab "${t.title}" is still running "${t.command}". Stop it, or use another tab.` };
    const win = process.platform === 'win32';
    const proc = spawn(win ? 'powershell.exe' : 'bash', win ? ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command] : ['-lc', command],
      { cwd: t.cwd, windowsHide: true, env: { ...process.env, FORCE_COLOR: '0' } });
    t.proc = proc; t.command = command; t.code = null; t.by = by;
    append(t, `${t.out ? '\n' : ''}PS ${t.cwd}> ${command}\n`);
    proc.stdout.on('data', d => append(t, String(d)));
    proc.stderr.on('data', d => append(t, String(d)));
    proc.stdin.end();
    const done = code => {
      if (t.proc !== proc) return;
      t.proc = null; t.code = code;
      if (code) append(t, `[exited with code ${code}]\n`);
      emit({ kind: 'tabs', tabs: list() });
    };
    proc.on('error', err => { append(t, `${err.message}\n`); done(-1); });
    proc.on('close', code => done(code ?? 0));
    emit({ kind: 'tabs', tabs: list() });
    return { ok: true, tab: view(t) };
  }

  // the last lines of a tab; with wait, holds on until new output arrives or the time is up
  async function read({ tab, lines = 200, wait = 0 }) {
    const t = tabs.get(tab);
    if (!t) return { error: `No terminal tab ${tab}.` };
    if (wait > 0 && t.proc) {
      const before = t.out.length;
      const until = Date.now() + Math.min(Number(wait) || 0, 60000);
      while (Date.now() < until && t.out.length === before && t.proc) await new Promise(r => setTimeout(r, 200));
    }
    const n = Math.max(1, Math.min(2000, Number(lines) || 200));
    return { ok: true, tab: view(t), text: t.out.split('\n').slice(-n).join('\n') };
  }

  function stop(id) {
    const t = tabs.get(id);
    if (!t) return { error: `No terminal tab ${id}.` };
    if (t.proc) {
      if (process.platform === 'win32') execFile('taskkill', ['/pid', String(t.proc.pid), '/T', '/F'], () => {});
      else t.proc.kill('SIGINT');
      append(t, '^C\n');
    }
    return { ok: true };
  }
  function close(id) {
    const t = tabs.get(id);
    if (!t) return { error: `No terminal tab ${id}.` };
    stop(id);
    tabs.delete(id);
    emit({ kind: 'tabs', tabs: list() });
    return { ok: true };
  }
  const list = () => [...tabs.values()].map(view);
  function snapshot() { return { tabs: [...tabs.values()].map(t => ({ ...view(t), out: t.out })) }; }
  function stopAll() { for (const t of tabs.values()) stop(t.id); }

  return { open, run, read, stop, close, list, snapshot, stopAll };
}
