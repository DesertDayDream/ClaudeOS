// ClaudeOS.exe updating itself: a build made beside it (ClaudeOS.new.exe, from
// `npm run build:exe -- dist/ClaudeOS.new.exe`) replaces it once no chat is working. A hidden
// PowerShell waits for this process to end, swaps the files (the running one becomes .old.exe),
// starts the new one in the tray, and puts the old one back if the new one doesn't come up.
// It is started through WMI, so it belongs to no job of ours and outlives this process even where
// child processes may not break away (sandboxes); WMI passes no environment, so the script sets its own.
// Rolling back is the same swap the other way: the previous build (.old.exe) comes back, and the
// running one is set aside as .new.exe, so "Restart to update" can bring it back again.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { IS_EXE, buildId } from './runtime.mjs';
import { IS_DESKTOP, desktopEvent } from './desktop-bridge.mjs';

// what happened at the last update or rollback (read once, at start, then forgotten)
function readLast(marker) {
  try {
    const m = JSON.parse(fs.readFileSync(marker, 'utf8'));
    fs.rmSync(marker, { force: true });
    if (Date.now() - m.at < 10 * 60e3) return { ok: m.status !== 'failed', kind: m.kind || 'update', status: m.status, from: m.from, to: buildId(), version: m.version || null, chat: m.chat, brain: m.brain, at: m.at };
  } catch { /* no update just happened */ }
  return null;
}

// The desktop app installs either a release from GitHub (electron-updater) or a local installer that
// `npm run desktop:finish` built (update_app with installer): ClaudeOS waits until no chat is working,
// the shell quits, installs it silently and opens again on the chat that asked.
const INSTALLER = /^ClaudeOS-Setup-(\d+\.\d+\.\d+)\.exe$/i;
function createDesktopUpdater({ busy, dataDir }) {
  const marker = path.join(dataDir, 'update.json');
  let state = { desktop: true, canUpdate: true, build: buildId(), phase: 'idle', ready: null, previous: null, pending: false, last: readLast(marker) };
  let timer;
  process.on('message', message => {
    if (message?.type === 'desktop-update-state') state = { ...state, ...message.value };
  });
  return {
    status: () => state,
    cancel() { clearTimeout(timer); state.pending = false; return { ok: true }; },
    request({ kind, installer, chat = '', brain = '' } = {}) {
      if (kind === 'rollback') return { error: 'To roll back the desktop app, run a previous installer. Your brains and chats are kept separately.' };
      if (state.pending) return { ok: true, waiting: true };
      if (installer) {
        const file = path.resolve(String(installer)), name = INSTALLER.exec(path.basename(file));
        let isFile = false;
        try { isFile = path.isAbsolute(String(installer)) && fs.statSync(file).isFile(); } catch { /* missing */ }
        if (!name || !isFile) return { error: `${installer} is not an installer. Build one with npm run desktop:finish and pass its full path (dist\desktop\ClaudeOS-Setup-<version>.exe).` };
        state.pending = 'update';
        const install = () => {
          if (busy()) { timer = setTimeout(install, 500); return; }
          fs.writeFileSync(marker, JSON.stringify({ status: 'started', kind: 'install', from: buildId(), version: name[1], chat, brain, at: Date.now() }));
          desktopEvent('desktop-update-install', { installer: file });
        };
        timer = setTimeout(install, 300);
        return { ok: true, waiting: busy(), version: name[1] };
      }
      if (!state.ready) { desktopEvent('desktop-update-check'); return { ok: true }; }
      state.pending = 'update';
      const install = () => {
        if (busy()) { timer = setTimeout(install, 1000); return; }
        desktopEvent('desktop-update-install');
      };
      timer = setTimeout(install, 300);
      return { ok: true, waiting: busy() };
    },
  };
}

const SCRIPT = `
$ErrorActionPreference = 'Stop'
function Log($s) { Add-Content -Path $env:U_LOG -Value ("{0:HH:mm:ss} {1}" -f (Get-Date), $s) }
function Up { $c = New-Object Net.Sockets.TcpClient; try { $c.Connect('127.0.0.1', [int]$env:U_PORT); $true } catch { $false } finally { $c.Close() } }
function Start-App { Start-Process -FilePath $env:U_EXE -ArgumentList '--background' }
# a virus scanner may still hold a fresh exe for a few seconds: try again before giving up
function Move-Retry($from, $to) {
  for ($i = 0; ; $i++) { try { Move-Item -LiteralPath $from -Destination $to -ErrorAction Stop; return } catch { if ($i -ge 180) { throw "moving $from to $($to): $_" }; Start-Sleep -Milliseconds 500 } }
}
# the previous build may still be running as a brain's memory server: then it is set aside instead
function Clear-Old($file) {
  if (-not (Test-Path $file)) { return }
  try { Remove-Item -LiteralPath $file -Force -ErrorAction Stop } catch { Move-Retry $file ($file -replace '\\.exe$', ('-' + (Get-Date -Format 'yyyyMMddHHmmss') + '.exe')) }
}
function Mark($status) { Set-Content -Path $env:U_MARK -Value (@{ status = $status; kind = $env:U_KIND; from = $env:U_FROM; chat = $env:U_CHAT; brain = $env:U_BRAIN; at = [DateTimeOffset]::Now.ToUnixTimeMilliseconds() } | ConvertTo-Json) }
try {
  Log "waiting for ClaudeOS (pid $env:U_PID) to quit"
  try { Wait-Process -Id ([int]$env:U_PID) -Timeout 60 -ErrorAction Stop } catch { if (Get-Process -Id ([int]$env:U_PID) -ErrorAction SilentlyContinue) { Stop-Process -Id ([int]$env:U_PID) -Force } }
  Start-Sleep -Milliseconds 700
  for ($i = 0; $i -lt 20 -and (Up); $i++) { Start-Sleep -Milliseconds 300 }
  Log "$env:U_KIND from build $env:U_FROM"
  Clear-Old $env:U_KEEP
  Move-Retry $env:U_EXE $env:U_KEEP
  Move-Retry $env:U_NEW $env:U_EXE
  Log 'swapped; starting the other build'
  Start-App
  # a refused connection takes ~2 s on Windows, so this waits by the clock, not by tries
  $deadline = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $deadline -and -not (Up)) { Start-Sleep -Milliseconds 500 }
  if (Up) { Log 'the other build is running'; exit 0 }
  Log 'the other build did not start: putting this one back'
  Get-Process | Where-Object { $_.Path -eq $env:U_EXE } | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 700
  Clear-Old $env:U_FAILED
  Move-Retry $env:U_EXE $env:U_FAILED
  Move-Retry $env:U_KEEP $env:U_EXE
  Mark 'failed'
  Start-App
} catch {
  Log ("update failed: " + $_)
  if (-not (Test-Path $env:U_EXE) -and (Test-Path $env:U_KEEP)) { Move-Item $env:U_KEEP $env:U_EXE }
  Mark 'failed'
  if (-not (Up)) { Start-App }
}
`;

export function createUpdater({ dataDir, port, busy, quit }) {
  if (IS_DESKTOP) return createDesktopUpdater({ busy, dataDir });
  const exe = process.execPath;
  const base = exe.replace(/\.exe$/i, '');
  const next = `${base}.new.exe`, old = `${base}.old.exe`;
  const marker = path.join(dataDir, 'update.json'), log = path.join(dataDir, 'update.log');
  // which build each set-aside file is (a file doesn't say until it runs), by file name
  const buildsFile = path.join(dataDir, 'builds.json');
  const builds = () => { try { return JSON.parse(fs.readFileSync(buildsFile, 'utf8')); } catch { return {}; } };
  let pending = null, timer = 0;

  const last = readLast(marker);

  const info = file => {
    if (!IS_EXE) return null;
    try {
      const st = fs.statSync(file), b = builds()[path.basename(file).toLowerCase()];
      // only while it is still the same file (a fresh build may have replaced it since)
      return { file, size: st.size, built: st.mtimeMs, build: b?.size === st.size && b?.mtime === st.mtimeMs ? b.build : null };
    } catch { return null; }
  };
  const ready = () => info(next);
  const previous = () => info(old);
  function status() {
    return { canUpdate: IS_EXE, build: buildId(), ready: ready(), previous: previous(), pending: pending ? pending.kind : false, last };
  }

  // can this file be renamed right now? (renaming a running exe is allowed unless something holds it)
  function movable(file) {
    const probe = `${file}.probe`;
    try { fs.renameSync(file, probe); } catch { return false; }
    // putting it back must not fail half way: try for a few seconds
    for (let i = 0; i < 50; i++) {
      try { fs.renameSync(probe, file); return true; } catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); }
    }
    console.log(`Update: could not rename ${probe} back`);
    return false;
  }

  // Restart into another build as soon as nothing is working (now, if nothing is).
  // update: .new.exe comes in, the running one becomes .old.exe (a broken new one ends up .failed.exe).
  // rollback: .old.exe comes back, the running one becomes .new.exe (a broken old one stays .old.exe).
  function request({ chat = '', brain = '', kind = 'update' } = {}) {
    const back = kind === 'rollback';
    if (!IS_EXE) return { error: back ? 'Only ClaudeOS.exe can roll back. Running from the app folder, check out an earlier commit instead.' : 'Only ClaudeOS.exe updates itself. Running from the app folder, just restart `node server.mjs`.' };
    if (pending) return pending.kind === kind ? { ok: true, waiting: true } : { error: `Already restarting for ${pending.kind === 'rollback' ? 'a rollback' : 'an update'}. Cancel that first.` };
    if (back && !previous()) return { error: `There's no previous build to go back to (${old} is missing).` };
    if (back && ready()) return { error: 'A new build is waiting beside the app. Install it with Restart to update (then roll back if it misbehaves), or delete ClaudeOS.new.exe first.' };
    if (!back && !ready()) return { error: `There's no new build yet. Build one beside the app first: npm run build:exe -- "${next}"` };
    const incoming = back ? old : next, keepAs = back ? next : old, failedAs = back ? old : `${base}.failed.exe`;
    pending = { chat, brain, kind };
    const go = () => {
      if (busy()) { timer = setTimeout(go, 1000); return; }
      if (!fs.existsSync(incoming)) { pending = null; return; }
      // a virus scanner holds a freshly started exe for up to a minute; stay up until both files can move
      if (!movable(exe) || !movable(incoming)) { timer = setTimeout(go, 3000); return; }
      { const st = fs.statSync(exe); fs.writeFileSync(buildsFile, JSON.stringify({ ...builds(), [path.basename(keepAs).toLowerCase()]: { build: buildId(), size: st.size, mtime: st.mtimeMs } })); }
      fs.writeFileSync(marker, JSON.stringify({ status: 'started', kind, from: buildId(), chat, brain, at: Date.now() }));
      // the other build starts with the settings this one was started with (data folder, port)
      const keep = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(CLAUDEOS_|CLAUDE_CONFIG_DIR$|PORT$|ARTIFACT_PORT$)/.test(k) && k !== 'CLAUDEOS_NO_OPEN'));
      const env = { ...keep, U_PID: String(process.pid), U_KIND: kind, U_EXE: exe, U_NEW: incoming, U_KEEP: keepAs, U_FAILED: failedAs, U_PORT: String(port), U_LOG: log, U_MARK: marker, U_FROM: buildId(), U_CHAT: chat, U_BRAIN: brain };
      const q = v => `'${String(v).replace(/'/g, "''")}'`;
      const script = path.join(dataDir, 'update.ps1');
      fs.writeFileSync(script, '﻿' + Object.entries(env).map(([k, v]) => `$env:${k} = ${q(v)}`).join('\n') + '\n' + SCRIPT);
      const cmd = `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "${script}"`;
      const launch = `$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${q(cmd)}; ProcessStartupInformation = $si }
if ($r.ReturnValue -ne 0) { exit 1 }`;
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(launch, 'utf16le').toString('base64')], { windowsHide: true }, err => {
        if (err) { console.log('Update: could not start the updater:', err.message); pending = null; return; }
        console.log(back ? 'Rolling back: quitting so the previous build can take over' : 'Updating: quitting so the new build can take over');
        quit();
      });
    };
    timer = setTimeout(go, 300);
    return { ok: true, waiting: busy() };
  }
  function cancel() { clearTimeout(timer); pending = null; return { ok: true }; }

  return { status, request, cancel };
}
