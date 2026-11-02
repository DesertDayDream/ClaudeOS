const { test } = require('node:test');
const assert = require('node:assert/strict');
const { externalUrl, appNavigation, windowBounds, backendSpec, installerPath, installerVersion } = require('./policy.cjs');

test('OS link opening rejects executable and local-file protocols', () => {
  for (const url of ['file:///C:/Windows/System32/cmd.exe', 'javascript:alert(1)', 'data:text/html,x', 'ms-settings:privacy', 'https://user:password@example.com/', 'not a url']) assert.equal(externalUrl(url), null);
  assert.equal(externalUrl('https://example.com/sign-in'), 'https://example.com/sign-in');
  assert.equal(externalUrl('mailto:hello@example.com'), 'mailto:hello@example.com');
});
test('the privileged window cannot navigate to previews, other ports, or other pages', () => {
  const app = 'http://localhost:4800';
  assert.equal(appNavigation(`${app}/#chat`, app), true);
  for (const url of ['http://localhost:4810/', 'https://example.com/', `${app}/preview.html`, 'file:///C:/app.html', 'http://localhost.evil.test:4800/']) assert.equal(appNavigation(url, app), false);
});
test('a window saved on a removed monitor returns to a visible default position', () => {
  const displays = [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }];
  assert.deepEqual(windowBounds({ x: 4000, y: 4000, width: 1400, height: 900 }, displays), { width: 1400, height: 900 });
  assert.equal(windowBounds({ x: 50, y: 50, width: 1400, height: 900 }, displays).x, 50);
});
test('packaged terminal and MCP helpers run on the bundled Node backend, not Electron', () => {
  const spec = backendSpec({ packaged: true, resources: 'resources', root: 'source', platform: 'win32' });
  assert.match(spec.command, /backend[\\/]ClaudeOS-backend\.exe$/);
  assert.deepEqual(spec.args, []);
});
test('only a ClaudeOS installer given by full path can be run as an update', () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeos-installer-'));
  const good = path.join(dir, 'ClaudeOS-Setup-1.2.3.exe');
  fs.writeFileSync(good, 'x'); fs.writeFileSync(path.join(dir, 'evil.exe'), 'x'); fs.writeFileSync(path.join(dir, 'ClaudeOS-Setup-1.2.3.exe.cmd'), 'x');
  assert.equal(installerPath(good), good);
  assert.equal(installerVersion(good), '1.2.3');
  for (const bad of [path.join(dir, 'evil.exe'), path.join(dir, 'ClaudeOS-Setup-1.2.3.exe.cmd'), path.join(dir, 'ClaudeOS-Setup-9.9.9.exe'), 'ClaudeOS-Setup-1.2.3.exe', dir, null, 42]) assert.equal(installerPath(bad), null);
  fs.rmSync(dir, { recursive: true, force: true });
});
