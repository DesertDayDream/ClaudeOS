const path = require('node:path');

function externalUrl(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:', 'mailto:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
function appNavigation(value, appUrl) {
  try {
    const url = new URL(value), app = new URL(appUrl);
    return url.origin === app.origin && url.pathname === '/';
  } catch { return false; }
}
function windowBounds(saved, displays) {
  const width = Math.min(2400, Math.max(900, Number(saved?.width) || 1400));
  const height = Math.min(1800, Math.max(640, Number(saved?.height) || 900));
  const { x, y } = saved || {};
  const visible = Number.isFinite(x) && Number.isFinite(y) && displays.some(({ workArea: a }) =>
    x + 80 <= a.x + a.width && x + width - 80 >= a.x && y >= a.y && y + 80 <= a.y + a.height);
  return { width, height, ...(visible ? { x, y } : {}) };
}
function backendSpec({ packaged, resources, root, node, platform }) {
  if (packaged) return { command: path.join(resources, 'backend', platform === 'win32' ? 'ClaudeOS-backend.exe' : 'ClaudeOS-backend'), args: [] };
  return { command: node || 'node', args: [path.join(root, 'server.mjs')] };
}
// A local installer ClaudeOS may run on itself: only a file named like the ones `npm run desktop:finish`
// builds (ClaudeOS-Setup-<version>.exe), given as a full path, that exists.
const INSTALLER = /^ClaudeOS-Setup-\d+\.\d+\.\d+\.exe$/i;
function installerPath(value, fs = require('node:fs')) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) return null;
  const file = path.resolve(value);
  if (!INSTALLER.test(path.basename(file))) return null;
  try { return fs.statSync(file).isFile() ? file : null; } catch { return null; }
}
function installerVersion(file) { return (INSTALLER.test(path.basename(file || '')) && /(\d+\.\d+\.\d+)\.exe$/i.exec(file)[1]) || null; }
module.exports = { externalUrl, appNavigation, windowBounds, backendSpec, installerPath, installerVersion };
