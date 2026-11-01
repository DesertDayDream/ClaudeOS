// Open a file Claude linked in the chat ("src/app.ts:42") in the user's editor: VS Code (or Cursor)
// at that line when it's installed, otherwise the file's own app. Programs and scripts are never run
// from a click; Explorer shows them selected instead.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const RUNNABLE = new Set(['.exe', '.com', '.bat', '.cmd', '.ps1', '.psm1', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.msi', '.msp', '.lnk', '.scr', '.hta', '.jar', '.cpl', '.reg', '.url', '.appref-ms', '.application', '.pif']);
let editor; // Code.exe / Cursor.exe beside the `code` / `cursor` command on PATH, once looked up

function findEditor() {
  if (editor !== undefined) return Promise.resolve(editor);
  const look = name => new Promise(resolve => execFile('where', [name], { windowsHide: true }, (err, out) => {
    const cmd = !err && String(out).split(/\r?\n/).find(l => /\.cmd$/i.test(l.trim()));
    // ...\Microsoft VS Code\bin\code.cmd → ...\Microsoft VS Code\Code.exe
    const exe = cmd && fs.readdirSync(path.dirname(path.dirname(cmd.trim()))).find(f => /^(code|cursor)\.exe$/i.test(f));
    resolve(exe ? path.join(path.dirname(path.dirname(cmd.trim())), exe) : null);
  }));
  return look('code').then(e => e || look('cursor')).then(e => (editor = e));
}

// target: "file", "file:line" or "file:line:col", absolute or relative to base (the chat's folder)
export async function openFile(target, base) {
  let file = String(target || '').trim().replace(/^file:\/\/\/?/i, '');
  try { file = decodeURIComponent(file); } catch { /* as is */ }
  const at = file.match(/^(.*?)(?::(\d+))?(?::(\d+))?$/);
  file = at[1];
  const line = at[2] ? Number(at[2]) : 0, col = at[3] ? Number(at[3]) : 0;
  if (!file) return { error: 'No file.' };
  const abs = path.resolve(base, file);
  let st;
  try { st = fs.statSync(abs); } catch { return { error: `There's no ${abs}.` }; }
  if (process.platform !== 'win32') {
    spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [abs], { detached: true, stdio: 'ignore' }).unref();
    return { ok: true, file: abs };
  }
  const ed = await findEditor();
  if (ed && st.isFile()) {
    spawn(ed, ['-g', `${abs}${line ? `:${line}${col ? `:${col}` : ''}` : ''}`], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
    return { ok: true, file: abs, editor: path.basename(ed, '.exe') };
  }
  if (st.isDirectory()) { spawn('explorer.exe', [abs], { detached: true, stdio: 'ignore' }).unref(); return { ok: true, file: abs }; }
  if (RUNNABLE.has(path.extname(abs).toLowerCase())) {
    spawn('explorer.exe', [`/select,${abs}`], { detached: true, stdio: 'ignore' }).unref();
    return { ok: true, file: abs, shown: true };
  }
  // the file's own app, through the shell (the path is one argument, never parsed by cmd)
  spawn('rundll32.exe', ['shell32.dll,ShellExec_RunDLL', abs], { detached: true, stdio: 'ignore' }).unref();
  return { ok: true, file: abs };
}
