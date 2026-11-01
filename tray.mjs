// The ClaudeOS.exe tray icon: click to open the page, right-click to quit. Windows has no tray
// API in Node, so a hidden PowerShell runs a NotifyIcon; it goes away when ClaudeOS does.
import { spawn } from 'node:child_process';

const SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$icon = New-Object System.Windows.Forms.NotifyIcon
$icon.Icon = [System.Drawing.Icon]::ExtractAssociatedIcon($env:CLAUDEOS_EXE)
$icon.Text = 'ClaudeOS'
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$open = $menu.Items.Add('Open ClaudeOS')
$open.add_Click({ Start-Process $env:CLAUDEOS_URL })
$quit = $menu.Items.Add('Quit ClaudeOS')
$quit.add_Click({ $icon.Visible = $false; [Environment]::Exit(10) })
$icon.ContextMenuStrip = $menu
$icon.add_MouseClick({ if ($_.Button -eq 'Left') { Start-Process $env:CLAUDEOS_URL } })
$icon.Visible = $true
$icon.ShowBalloonTip(4000, 'ClaudeOS is running', 'Click the icon to open it. Right-click to quit.', 'Info')
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2000
$timer.add_Tick({ if (-not (Get-Process -Id $env:CLAUDEOS_PID -ErrorAction SilentlyContinue)) { $icon.Visible = $false; [Environment]::Exit(0) } })
$timer.Start()
[System.Windows.Forms.Application]::Run()
`;

export function startTray({ url, onQuit }) {
  if (process.platform !== 'win32') return;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')], {
    env: { ...process.env, CLAUDEOS_EXE: process.execPath, CLAUDEOS_URL: url, CLAUDEOS_PID: String(process.pid) },
    stdio: 'ignore', windowsHide: true,
  });
  child.on('exit', code => { if (code === 10) onQuit(); });
  child.on('error', () => { /* no tray, the app still runs */ });
}
