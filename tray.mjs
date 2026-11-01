// The ClaudeOS.exe tray icon: click (or the global hotkey) to bring the page back, right-click to
// quit, and balloons for answers while no page is open. Windows has no tray API in Node, so a
// hidden PowerShell runs a NotifyIcon; it goes away when ClaudeOS does.
// It talks over stdio: it prints "show" / "hotkey ok|failed"; it reads "notify <base64 json>".
import { spawn } from 'node:child_process';
import { WIN_CS, parseHotkey } from './desktop.mjs';

const HOTKEY_CS = `
using System;
using System.Windows.Forms;
using System.Runtime.InteropServices;
public class ClaudeOSHotkey : NativeWindow {
  [DllImport("user32.dll")] static extern bool RegisterHotKey(IntPtr h, int id, uint mods, uint vk);
  public event EventHandler Pressed;
  public bool Ok;
  public ClaudeOSHotkey(uint mods, uint vk) {
    CreateHandle(new CreateParams());
    // a tray that is just closing may still hold it for a moment
    for (int i = 0; i < 8 && !(Ok = RegisterHotKey(Handle, 1, mods | 0x4000, vk)); i++) System.Threading.Thread.Sleep(400);
  }
  protected override void WndProc(ref Message m) { if (m.Msg == 0x0312 && Pressed != null) Pressed(this, EventArgs.Empty); base.WndProc(ref m); }
}`;

const SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -TypeDefinition @'
${WIN_CS}
'@
Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @'
${HOTKEY_CS}
'@
function Say($s) { [Console]::Out.WriteLine($s); [Console]::Out.Flush() }
function ShowPage { if ($env:CLAUDEOS_TRAY_DEBUG) { Say 'pressed' }; if (-not [ClaudeOSWin]::Show()) { Say 'show' } }
$icon = New-Object System.Windows.Forms.NotifyIcon
$icon.Icon = [System.Drawing.Icon]::ExtractAssociatedIcon($env:CLAUDEOS_EXE)
$icon.Text = 'ClaudeOS'
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$open = $menu.Items.Add('Open ClaudeOS')
$open.add_Click({ ShowPage })
$quit = $menu.Items.Add('Quit ClaudeOS')
$quit.add_Click({ $icon.Visible = $false; [Environment]::Exit(10) })
$icon.ContextMenuStrip = $menu
$icon.add_MouseClick({ if ($_.Button -eq 'Left') { ShowPage } })
$icon.add_BalloonTipClicked({ ShowPage })
$icon.Visible = $true
if ($env:CLAUDEOS_HOTKEY_VK) {
  $hk = New-Object ClaudeOSHotkey ([uint32]$env:CLAUDEOS_HOTKEY_MODS), ([uint32]$env:CLAUDEOS_HOTKEY_VK)
  $hk.add_Pressed({ ShowPage })
  if ($hk.Ok) { Say 'hotkey ok' } else { Say 'hotkey failed' }
}
if ($env:CLAUDEOS_GREET) { $icon.ShowBalloonTip(4000, 'ClaudeOS is running', $env:CLAUDEOS_GREET, 'Info') }
# Console.In's ReadLineAsync blocks on .NET Framework; a reader over the raw stream does not
$stdin = New-Object IO.StreamReader ([Console]::OpenStandardInput()), ([Text.Encoding]::UTF8)
$script:line = $stdin.ReadLineAsync()
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 250
$script:ticks = 0
$timer.add_Tick({
  while ($script:line.IsCompleted) {
    $text = $script:line.Result
    if ($text -eq $null) { $icon.Visible = $false; [Environment]::Exit(0) }
    if ($text.StartsWith('notify ')) {
      $n = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($text.Substring(7))) | ConvertFrom-Json
      $icon.ShowBalloonTip(6000, $n.title, $n.body, 'None')
    }
    $script:line = $stdin.ReadLineAsync()
  }
  $script:ticks++
  if ($script:ticks % 8 -eq 0 -and -not (Get-Process -Id $env:CLAUDEOS_PID -ErrorAction SilentlyContinue)) { $icon.Visible = $false; [Environment]::Exit(0) }
})
$timer.Start()
[System.Windows.Forms.Application]::Run()
`;

// onShow: no page window was found, open one. onHotkey(ok): whether Windows gave us the hotkey.
export function startTray({ hotkey, greet, onShow, onQuit, onHotkey }) {
  if (process.platform !== 'win32') return null;
  const hk = hotkey ? parseHotkey(hotkey) : null;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')], {
    env: { ...process.env, CLAUDEOS_EXE: process.execPath, CLAUDEOS_PID: String(process.pid), CLAUDEOS_GREET: greet || '',
      CLAUDEOS_HOTKEY_MODS: hk ? String(hk.mods) : '', CLAUDEOS_HOTKEY_VK: hk ? String(hk.vk) : '' },
    stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
  });
  let buf = '';
  child.stdout.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const msg = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (process.env.CLAUDEOS_TRAY_DEBUG) console.log('tray:', msg);
      if (msg === 'show') onShow?.();
      else if (msg.startsWith('hotkey ')) onHotkey?.(msg === 'hotkey ok');
    }
  });
  child.stdin.on('error', () => { /* the tray is gone */ });
  child.on('exit', code => { if (code === 10) onQuit(); });
  child.on('error', () => { /* no tray, the app still runs */ });
  return {
    notify(title, body) {
      if (child.exitCode !== null) return false;
      child.stdin.write('notify ' + Buffer.from(JSON.stringify({ title: String(title).slice(0, 63), body: String(body).slice(0, 255) || ' ' })).toString('base64') + '\n');
      return true;
    },
    stop() { child.kill(); },
  };
}
