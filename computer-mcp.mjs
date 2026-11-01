// Computer use for a ClaudeOS chat: a small stdio MCP server that takes screenshots of this PC's
// screen and moves the mouse and keyboard, through PowerShell (Windows only). A chat gets it only
// when the user turns "Computer use" on for that chat. Coordinates are in the last screenshot's
// frame, which is scaled down to at most 1280 px wide; they're mapped back to real pixels here.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const MAX_W = 1280;
let frame = { x: 0, y: 0, scale: 1 }; // the last screenshot: virtual-screen origin and real px per image px

// Shared C#: DPI awareness (so pixels are real pixels), cursor, buttons and the wheel.
const NATIVE = `
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class CU {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, int d, UIntPtr e);
}
'@
[void][CU]::SetProcessDPIAware()
`;

function ps(script) {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(NATIVE + script, 'utf16le').toString('base64');
    execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 30000 }, (err, stdout, stderr) => {
        if (err) reject(new Error((stderr || err.message).trim().split('\n').slice(-3).join(' ')));
        else resolve(stdout.trim());
      });
  });
}

async function screenshot(region) {
  const file = path.join(os.tmpdir(), `claudeos-shot-${process.pid}.jpg`);
  const out = await ps(`
$v = [System.Windows.Forms.SystemInformation]::VirtualScreen
$r = ${region ? `New-Object System.Drawing.Rectangle(${region.map(Math.round).join(',')})` : '$v'}
$bmp = New-Object System.Drawing.Bitmap($r.Width, $r.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.X, $r.Y, 0, 0, $bmp.Size)
$s = [Math]::Min(1.0, ${MAX_W} / $r.Width)
$w = [int]($r.Width * $s); $h = [int]($r.Height * $s)
$small = New-Object System.Drawing.Bitmap($bmp, $w, $h)
$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$p = New-Object System.Drawing.Imaging.EncoderParameters(1)
$p.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]80)
$small.Save('${file.replace(/'/g, "''")}', $codec, $p)
"$($r.X) $($r.Y) $($r.Width) $w $h"`);
  const [x, y, realW, w, h] = out.split(/\s+/).map(Number);
  const data = fs.readFileSync(file).toString('base64');
  fs.rmSync(file, { force: true });
  return { x, y, scale: realW / w, w, h, data };
}

// image coordinates → screen pixels
const real = ([x, y]) => [Math.round(frame.x + x * frame.scale), Math.round(frame.y + y * frame.scale)];

// SendKeys syntax: escape its special characters in typed text, and map key names
const sendText = t => String(t).replace(/[+^%~(){}[\]]/g, c => `{${c}}`).replace(/\r?\n/g, '{ENTER}');
const KEYS = { enter: 'ENTER', return: 'ENTER', tab: 'TAB', esc: 'ESC', escape: 'ESC', backspace: 'BACKSPACE', delete: 'DELETE', del: 'DELETE',
  up: 'UP', down: 'DOWN', left: 'LEFT', right: 'RIGHT', home: 'HOME', end: 'END', pageup: 'PGUP', pagedown: 'PGDN', space: ' ', insert: 'INSERT',
  f1: 'F1', f2: 'F2', f3: 'F3', f4: 'F4', f5: 'F5', f6: 'F6', f7: 'F7', f8: 'F8', f9: 'F9', f10: 'F10', f11: 'F11', f12: 'F12' };
const MODS = { ctrl: '^', control: '^', shift: '+', alt: '%' };
function sendKey(combo) {
  return String(combo).trim().split(/\s+/).map(one => {
    const parts = one.toLowerCase().split('+');
    const key = parts.pop();
    const mods = parts.map(m => MODS[m] ?? '').join('');
    const k = KEYS[key] != null ? (KEYS[key] === ' ' ? ' ' : `{${KEYS[key]}}`) : key.length === 1 ? sendText(key) : `{${key.toUpperCase()}}`;
    return mods + k;
  }).join('');
}
const psq = s => `'${String(s).replace(/'/g, "''")}'`;

const BUTTON = { left: [0x2, 0x4], right: [0x8, 0x10], middle: [0x20, 0x40] };
async function click([x, y], { button = 'left', count = 1 } = {}) {
  const [down, up] = BUTTON[button] || BUTTON.left;
  const once = `[CU]::mouse_event(${down},0,0,0,[UIntPtr]::Zero); [CU]::mouse_event(${up},0,0,0,[UIntPtr]::Zero)`;
  await ps(`[void][CU]::SetCursorPos(${x}, ${y}); Start-Sleep -Milliseconds 40; ${Array(count).fill(once).join('; Start-Sleep -Milliseconds 60; ')}`);
}

const point = { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2, description: '[x, y] in the last screenshot\'s pixels.' };
const TOOLS = [
  { name: 'screenshot', description: 'Take a screenshot of the whole screen (all monitors). Take one before acting, and again after, to see what happened. Coordinates for the other tools are in this image\'s pixels.', inputSchema: { type: 'object', properties: {} } },
  { name: 'zoom', description: 'A closer screenshot of one region, for small text or icons. The region is [x0, y0, x1, y1] in the last full screenshot\'s pixels. Coordinates afterwards are still in the full screenshot\'s frame.', inputSchema: { type: 'object', required: ['region'], properties: { region: { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4 } } } },
  { name: 'click', description: 'Click at a point.', inputSchema: { type: 'object', required: ['coordinate'], properties: { coordinate: point, button: { type: 'string', enum: ['left', 'right', 'middle'] }, double: { type: 'boolean' } } } },
  { name: 'move', description: 'Move the mouse to a point (hover).', inputSchema: { type: 'object', required: ['coordinate'], properties: { coordinate: point } } },
  { name: 'drag', description: 'Drag with the left button from one point to another.', inputSchema: { type: 'object', required: ['from', 'to'], properties: { from: point, to: point } } },
  { name: 'type', description: 'Type text into whatever has focus.', inputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } } },
  { name: 'key', description: 'Press keys, e.g. "enter", "ctrl+s", "alt+tab", "ctrl+shift+esc". Several separated by spaces are pressed one after another.', inputSchema: { type: 'object', required: ['keys'], properties: { keys: { type: 'string' } } } },
  { name: 'scroll', description: 'Scroll the mouse wheel at a point.', inputSchema: { type: 'object', required: ['coordinate', 'direction'], properties: { coordinate: point, direction: { type: 'string', enum: ['up', 'down'] }, amount: { type: 'number', description: 'Wheel notches, default 3.' } } } },
];

const image = shot => ({ type: 'image', data: shot.data, mimeType: 'image/jpeg' });
async function call(name, a = {}) {
  if (name === 'screenshot') {
    const shot = await screenshot();
    frame = { x: shot.x, y: shot.y, scale: shot.scale };
    return [image(shot), { type: 'text', text: `Screenshot ${shot.w}x${shot.h}. Use these pixels for coordinates.` }];
  }
  if (name === 'zoom') {
    const [x0, y0] = real(a.region.slice(0, 2)), [x1, y1] = real(a.region.slice(2));
    const shot = await screenshot([Math.min(x0, x1), Math.min(y0, y1), Math.max(8, Math.abs(x1 - x0)), Math.max(8, Math.abs(y1 - y0))]);
    return [image(shot), { type: 'text', text: 'Zoomed view. Coordinates are still in the full screenshot\'s frame.' }];
  }
  if (name === 'click') { await click(real(a.coordinate), { button: a.button, count: a.double ? 2 : 1 }); return `Clicked ${a.coordinate.join(', ')}.`; }
  if (name === 'move') { const [x, y] = real(a.coordinate); await ps(`[void][CU]::SetCursorPos(${x}, ${y})`); return 'Moved.'; }
  if (name === 'drag') {
    const [x0, y0] = real(a.from), [x1, y1] = real(a.to);
    const steps = Array.from({ length: 10 }, (_, i) => `[void][CU]::SetCursorPos(${Math.round(x0 + (x1 - x0) * (i + 1) / 10)}, ${Math.round(y0 + (y1 - y0) * (i + 1) / 10)}); Start-Sleep -Milliseconds 20`).join('; ');
    await ps(`[void][CU]::SetCursorPos(${x0}, ${y0}); [CU]::mouse_event(2,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 60; ${steps}; [CU]::mouse_event(4,0,0,0,[UIntPtr]::Zero)`);
    return 'Dragged.';
  }
  if (name === 'type') { await ps(`[System.Windows.Forms.SendKeys]::SendWait(${psq(sendText(a.text))})`); return 'Typed.'; }
  if (name === 'key') { await ps(`[System.Windows.Forms.SendKeys]::SendWait(${psq(sendKey(a.keys))})`); return `Pressed ${a.keys}.`; }
  if (name === 'scroll') {
    const [x, y] = real(a.coordinate);
    const delta = (a.direction === 'up' ? 120 : -120) * Math.max(1, Math.min(30, Math.round(a.amount || 3)));
    await ps(`[void][CU]::SetCursorPos(${x}, ${y}); [CU]::mouse_event(0x800,0,0,${delta},[UIntPtr]::Zero)`);
    return 'Scrolled.';
  }
  throw new Error(`Unknown tool ${name}`);
}

const send = msg => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
readline.createInterface({ input: process.stdin }).on('line', async line => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  if (id === undefined) return;
  if (method === 'initialize') return send({ id, result: { protocolVersion: params?.protocolVersion || '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'claudeos-computer', version: '1.0.0' } } });
  if (method === 'ping') return send({ id, result: {} });
  if (method === 'tools/list') return send({ id, result: { tools: process.platform === 'win32' ? TOOLS : [] } });
  if (method === 'tools/call') {
    try {
      const r = await call(params?.name, params?.arguments || {});
      return send({ id, result: { content: typeof r === 'string' ? [{ type: 'text', text: r }] : r } });
    } catch (err) {
      return send({ id, result: { content: [{ type: 'text', text: err.message }], isError: true } });
    }
  }
  send({ id, error: { code: -32601, message: `Unknown method ${method}` } });
});
