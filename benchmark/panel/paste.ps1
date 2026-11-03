# Pastes text into an app's chat box and presses Enter: clipboard -> focus the window -> Ctrl+V -> Enter.
# The app must already have a new chat open in the run folder with the cursor in its message box.
param([Parameter(Mandatory)][string]$Proc, [Parameter(Mandatory)][string]$TextFile, [switch]$NoEnter)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
# The Win32 calls are built in memory (Reflection.Emit) rather than with Add-Type, which compiles a DLL into %TEMP%
# and fails when Windows blocks that write ("Access to the path ...Temp\xxxx.dll is denied").
$tb = [AppDomain]::CurrentDomain.DefineDynamicAssembly((New-Object Reflection.AssemblyName 'BenchFocus'), 'Run').DefineDynamicModule('BenchFocus').DefineType('Focus', 'Public, Class')
foreach ($m in @(
    @('ShowWindow', [bool], @([IntPtr], [int])),
    @('SetForegroundWindow', [bool], @([IntPtr])),
    @('GetForegroundWindow', [IntPtr], @()),
    @('keybd_event', [void], @([byte], [byte], [uint32], [UIntPtr])),
    @('IsIconic', [bool], @([IntPtr])))) {
  $tb.DefinePInvokeMethod($m[0], 'user32.dll', 'Public, Static, PinvokeImpl', 'Standard', $m[1], [Type[]]$m[2], 'Winapi', 'Auto').SetImplementationFlags('PreserveSig')
}
$Focus = $tb.CreateType()
$p = Get-Process -Name $Proc -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { Write-Output "NOWINDOW"; exit 2 }
$h = $p.MainWindowHandle
Set-Clipboard -Value ([IO.File]::ReadAllText($TextFile))
if ($Focus::IsIconic($h)) { $Focus::ShowWindow($h, 9) | Out-Null }
# Windows only lets the foreground app hand focus away; a tap of Alt lifts that lock.
$Focus::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); $Focus::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
$Focus::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 400
if ($Focus::GetForegroundWindow() -ne $h) { Write-Output "NOFOCUS"; exit 3 }
[System.Windows.Forms.SendKeys]::SendWait('^v')
Start-Sleep -Milliseconds 300
if (-not $NoEnter) { [System.Windows.Forms.SendKeys]::SendWait('{ENTER}') }
Write-Output "OK"
