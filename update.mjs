// ClaudeOS.exe updating itself: a build made beside it (ClaudeOS.new.exe, from
// `npm run build:exe -- dist/ClaudeOS.new.exe`) replaces it once no chat is working. A hidden
// PowerShell waits for this process to end, swaps the files (the running one becomes .old.exe),
// starts the new one in the tray, and puts the old one back if the new one doesn't come up.
// It is started through WMI, so it belongs to no job of ours and outlives this process even where
// child processes may not break away (sandboxes); WMI passes no environment, so the script sets its own.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { IS_EXE, buildId } from './runtime.mjs';

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
function Mark($status) { Set-Content -Path $env:U_MARK -Value (@{ status = $status; from = $env:U_FROM; chat = $env:U_CHAT; brain = $env:U_BRAIN; at = [DateTimeOffset]::Now.ToUnixTimeMilliseconds() } | ConvertTo-Json) }
try {
  Log "waiting for ClaudeOS (pid $env:U_PID) to quit"
  try { Wait-Process -Id ([int]$env:U_PID) -Timeout 60 -ErrorAction Stop } catch { if (Get-Process -Id ([int]$env:U_PID) -ErrorAction SilentlyContinue) { Stop-Process -Id ([int]$env:U_PID) -Force } }
  Start-Sleep -Milliseconds 700
  for ($i = 0; $i -lt 20 -and (Up); $i++) { Start-Sleep -Milliseconds 300 }
  Clear-Old $env:U_OLD
  Move-Retry $env:U_EXE $env:U_OLD
  Move-Retry $env:U_NEW $env:U_EXE
  Log 'swapped; starting the new build'
  Start-App
  # a refused connection takes ~2 s on Windows, so this waits by the clock, not by tries
  $deadline = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $deadline -and -not (Up)) { Start-Sleep -Milliseconds 500 }
  if (Up) { Log 'the new build is running'; exit 0 }
  Log 'the new build did not start: putting the old one back'
  Get-Process | Where-Object { $_.Path -eq $env:U_EXE } | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 700
  $failed = $env:U_EXE -replace '\\.exe$', '.failed.exe'
  Clear-Old $failed
  Move-Retry $env:U_EXE $failed
  Move-Retry $env:U_OLD $env:U_EXE
  Mark 'failed'
  Start-App
} catch {
  Log ("update failed: " + $_)
  if (-not (Test-Path $env:U_EXE) -and (Test-Path $env:U_OLD)) { Move-Item $env:U_OLD $env:U_EXE }
  Mark 'failed'
  if (-not (Up)) { Start-App }
}
`;

export function createUpdater({ dataDir, port, busy, quit }) {
  const exe = process.execPath;
  const base = exe.replace(/\.exe$/i, '');
  const next = `${base}.new.exe`, old = `${base}.old.exe`;
  const marker = path.join(dataDir, 'update.json'), log = path.join(dataDir, 'update.log');
  let pending = null, timer = 0;

  // what happened at the last update (read once, at start)
  let last = null;
  try {
    const m = JSON.parse(fs.readFileSync(marker, 'utf8'));
    fs.rmSync(marker, { force: true });
    if (Date.now() - m.at < 10 * 60e3) last = { ok: m.status !== 'failed', status: m.status, from: m.from, to: buildId(), chat: m.chat, brain: m.brain, at: m.at };
  } catch { /* no update just happened */ }

  function ready() {
    if (!IS_EXE) return null;
    try { const st = fs.statSync(next); return { file: next, size: st.size, built: st.mtimeMs }; } catch { return null; }
  }
  function status() {
    return { canUpdate: IS_EXE, build: buildId(), ready: ready(), pending: !!pending, last };
  }

  // Restart into the new build as soon as nothing is working (now, if nothing is).
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
  function request({ chat = '', brain = '' } = {}) {
    if (!IS_EXE) return { error: 'Only ClaudeOS.exe updates itself. Running from the app folder, just restart `node server.mjs`.' };
    if (!ready()) return { error: `There's no new build yet. Build one beside the app first: npm run build:exe -- "${next}"` };
    if (pending) return { ok: true, waiting: true };
    pending = { chat, brain };
    const go = () => {
      if (busy()) { timer = setTimeout(go, 1000); return; }
      if (!ready()) { pending = null; return; }
      // a virus scanner holds a freshly started exe for up to a minute; stay up until both files can move
      if (!movable(exe) || !movable(next)) { timer = setTimeout(go, 3000); return; }
      fs.writeFileSync(marker, JSON.stringify({ status: 'started', from: buildId(), chat, brain, at: Date.now() }));
      // the new build starts with the settings this one was started with (data folder, port)
      const keep = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(CLAUDEOS_|CLAUDE_CONFIG_DIR$|PORT$|ARTIFACT_PORT$)/.test(k) && k !== 'CLAUDEOS_NO_OPEN'));
      const env = { ...keep, U_PID: String(process.pid), U_EXE: exe, U_NEW: next, U_OLD: old, U_PORT: String(port), U_LOG: log, U_MARK: marker, U_FROM: buildId(), U_CHAT: chat, U_BRAIN: brain };
      const q = v => `'${String(v).replace(/'/g, "''")}'`;
      const script = path.join(dataDir, 'update.ps1');
      fs.writeFileSync(script, '﻿' + Object.entries(env).map(([k, v]) => `$env:${k} = ${q(v)}`).join('\n') + '\n' + SCRIPT);
      const cmd = `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "${script}"`;
      const launch = `$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${q(cmd)}; ProcessStartupInformation = $si }
if ($r.ReturnValue -ne 0) { exit 1 }`;
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(launch, 'utf16le').toString('base64')], { windowsHide: true }, err => {
        if (err) { console.log('Update: could not start the updater:', err.message); pending = null; return; }
        console.log('Updating: quitting so the new build can take over');
        quit();
      });
    };
    timer = setTimeout(go, 300);
    return { ok: true, waiting: busy() };
  }
  function cancel() { clearTimeout(timer); pending = null; return { ok: true }; }

  return { status, request, cancel };
}
