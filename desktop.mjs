// Living on the desktop like Claude Desktop does: the page in its own window, a hotkey that brings
// it back, notifications, and starting when Windows does. Settings live in <data>/settings.json.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { IS_EXE } from './runtime.mjs';
import { IS_DESKTOP, desktopRequest } from './desktop-bridge.mjs';

const DEFAULTS = { appWindow: true, notify: true, hotkey: 'Ctrl+Alt+O' };
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_NAME = process.env.CLAUDEOS_RUN_NAME || 'ClaudeOS'; // tests use another name

export function createDesktop({ dataDir }) {
  const file = path.join(dataDir, 'settings.json');
  let settings = { ...DEFAULTS };
  try { settings = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { /* first run */ }
  const save = () => fs.writeFileSync(file, JSON.stringify(settings, null, 2));

  // Windows starts ClaudeOS.exe at sign-in, in the tray only (no page until you ask for it)
  const runCommand = () => `"${process.execPath}" --background`;
  function loginEntry() {
    return new Promise(resolve => {
      if (process.platform !== 'win32') return resolve(null);
      execFile('reg', ['query', RUN_KEY, '/v', RUN_NAME], { windowsHide: true }, (err, out) => {
        const m = !err && String(out).match(/REG_SZ\s+(.+)/);
        resolve(m ? m[1].trim() : null);
      });
    });
  }
  function setLogin(on) {
    return new Promise(resolve => {
      const args = on ? ['add', RUN_KEY, '/v', RUN_NAME, '/t', 'REG_SZ', '/d', runCommand(), '/f'] : ['delete', RUN_KEY, '/v', RUN_NAME, '/f'];
      execFile('reg', args, { windowsHide: true }, err => resolve(!err || !on));
    });
  }

  async function get() {
    if (IS_DESKTOP) return { ...settings, ...(await desktopRequest('desktop-settings')), desktop: true, appWindow: true, isExe: IS_EXE };
    const entry = await loginEntry();
    return { ...settings, startAtLogin: !!entry, canStartAtLogin: IS_EXE && process.platform === 'win32', isExe: IS_EXE };
  }
  async function set(patch = {}) {
    if (typeof patch.appWindow === 'boolean') settings.appWindow = patch.appWindow;
    if (typeof patch.notify === 'boolean') settings.notify = patch.notify;
    if (typeof patch.hotkey === 'string') {
      const h = patch.hotkey.trim();
      if (h && !parseHotkey(h)) return { error: `"${h}" is not a hotkey ClaudeOS understands. Try Ctrl+Alt+O.` };
      settings.hotkey = h;
    }
    if (typeof patch.startAtLogin === 'boolean') {
      if (IS_DESKTOP) {
        const result = await desktopRequest('desktop-login', { enabled: patch.startAtLogin });
        if (result.error) return result;
      } else {
        if (patch.startAtLogin && !IS_EXE) return { error: 'Start at login works in ClaudeOS.exe.' };
        if (!await setLogin(patch.startAtLogin)) return { error: 'Windows did not accept the startup entry.' };
      }
    }
    save();
    return get();
  }
  // a moved exe fixes its own startup entry, like the brains' hooks
  async function repairLogin() {
    if (IS_DESKTOP) return; // Electron owns its startup entry, never point it at the backend.
    if (!IS_EXE) return;
    const entry = await loginEntry();
    if (entry && entry !== runCommand()) await setLogin(true);
  }

  return { get, set, repairLogin, settings: () => settings };
}

// "Ctrl+Alt+Space" -> RegisterHotKey's modifiers and virtual key, or null
export function parseHotkey(text) {
  const MODS = { ctrl: 2, control: 2, alt: 1, shift: 4, win: 8 };
  let mods = 0, vk = 0;
  for (const raw of String(text).split('+')) {
    const k = raw.trim().toLowerCase();
    if (MODS[k]) { mods |= MODS[k]; continue; }
    if (vk) return null;
    if (/^[a-z0-9]$/.test(k)) vk = k.toUpperCase().charCodeAt(0);
    else if (/^f([1-9]|1[0-2])$/.test(k)) vk = 0x6f + Number(k.slice(1));
    else vk = { space: 0x20, enter: 0x0d, tab: 0x09, backquote: 0xc0, '`': 0xc0 }[k] || 0;
    if (!vk) return null;
  }
  return mods && vk ? { mods, vk } : null;
}

// Finds the ClaudeOS page (its own window or a browser tab in front) and brings it forward.
// The Alt tap lets a background process take the foreground, which Windows otherwise refuses.
export const WIN_CS = `
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
public static class ClaudeOSWin {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  static readonly Regex Title = new Regex(@"(^|\\u00b7 )ClaudeOS( - |$)");
  static readonly Regex Browser = new Regex(@"^(msedge|chrome|brave|firefox|opera|vivaldi)$", RegexOptions.IgnoreCase);
  public static bool Show() {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512);
      GetWindowText(h, sb, 512);
      if (!Title.IsMatch(sb.ToString())) return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      try { if (!Browser.IsMatch(System.Diagnostics.Process.GetProcessById((int)pid).ProcessName)) return true; } catch { return true; }
      found = h; return false;
    }, IntPtr.Zero);
    if (found == IntPtr.Zero) return false;
    if (IsIconic(found)) ShowWindow(found, 9);
    keybd_event(0x12, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 2, UIntPtr.Zero);
    SetForegroundWindow(found);
    return true;
  }
}`;

// The page in a window of its own (Edge or Chrome app mode), else the default browser.
function appBrowser() {
  const pf = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
  for (const base of pf) for (const rel of ['Microsoft\\Edge\\Application\\msedge.exe', 'Google\\Chrome\\Application\\chrome.exe']) {
    const exe = path.join(base, rel);
    if (fs.existsSync(exe)) return exe;
  }
  return null;
}
export function openPage(url, { appWindow = true } = {}) {
  const app = appWindow && process.platform === 'win32' && appBrowser();
  const [cmd, args] = app ? [app, [`--app=${url}`, '--window-size=1400,900']]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]];
  spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: !app }).unref();
}
// Bring the page back if it is open anywhere; open it if not. done() runs once either has happened.
export function showPage(url, opts, done = () => {}) {
  if (process.platform !== 'win32') { openPage(url, opts); return done(); }
  const script = `Add-Type -TypeDefinition @'\n${WIN_CS}\n'@\nif ([ClaudeOSWin]::Show()) { exit 0 } else { exit 1 }`;
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true },
    err => { if (err) openPage(url, opts); done(); });
}
