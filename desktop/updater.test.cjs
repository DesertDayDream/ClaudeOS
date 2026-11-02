const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

test('backend defers installation while agents work, and cancellation prevents restart', async () => {
  const saved = { env: process.env.CLAUDEOS_DESKTOP, send: process.send, connected: process.connected };
  const before = new Set(process.listeners('message'));
  const sent = [];
  process.env.CLAUDEOS_DESKTOP = '1'; process.connected = true;
  process.send = (message, callback) => { sent.push(message); callback?.(); };
  let updater;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeos-updater-'));
  try {
    const { createUpdater } = await import(pathToFileURL(path.join(__dirname, '..', 'update.mjs')).href);
    let busy = true;
    updater = createUpdater({ busy: () => busy, dataDir });
    process.emit('message', { type: 'desktop-update-state', value: { ready: { build: '0.4.0' } } });
    assert.equal(updater.request().waiting, true);
    await new Promise(resolve => setTimeout(resolve, 340));
    assert.equal(sent.some(message => message.type === 'desktop-update-install'), false);
    updater.cancel(); busy = false;
    await new Promise(resolve => setTimeout(resolve, 1010));
    assert.equal(sent.some(message => message.type === 'desktop-update-install'), false);
    updater.request();
    await new Promise(resolve => setTimeout(resolve, 340));
    assert.equal(sent.filter(message => message.type === 'desktop-update-install').length, 1);
  } finally {
    updater?.cancel();
    for (const listener of process.listeners('message')) if (!before.has(listener)) process.removeListener('message', listener);
    if (saved.env === undefined) delete process.env.CLAUDEOS_DESKTOP; else process.env.CLAUDEOS_DESKTOP = saved.env;
    if (saved.send === undefined) delete process.send; else process.send = saved.send;
    if (saved.connected === undefined) delete process.connected; else process.connected = saved.connected;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('a local installer installs once chats are done, and the next start reopens the chat that asked', async () => {
  const saved = { env: process.env.CLAUDEOS_DESKTOP, send: process.send, connected: process.connected };
  const before = new Set(process.listeners('message'));
  const sent = [];
  process.env.CLAUDEOS_DESKTOP = '1'; process.connected = true;
  process.send = (message, callback) => { sent.push(message); callback?.(); };
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeos-install-'));
  const installer = path.join(dataDir, 'ClaudeOS-Setup-0.4.0.exe');
  fs.writeFileSync(installer, 'x'); fs.writeFileSync(path.join(dataDir, 'other.exe'), 'x');
  let updater, again;
  try {
    const { createUpdater } = await import(pathToFileURL(path.join(__dirname, '..', 'update.mjs')).href);
    let busy = true;
    updater = createUpdater({ busy: () => busy, dataDir });
    assert.ok(updater.request({ installer: path.join(dataDir, 'other.exe') }).error);
    assert.ok(updater.request({ installer: 'ClaudeOS-Setup-0.4.0.exe' }).error, 'a relative path is refused');
    const r = updater.request({ installer, chat: 'c1', brain: 'b1' });
    assert.equal(r.waiting, true); assert.equal(r.version, '0.4.0');
    await new Promise(resolve => setTimeout(resolve, 340));
    assert.equal(sent.some(message => message.type === 'desktop-update-install'), false, 'waits while a chat works');
    busy = false;
    await new Promise(resolve => setTimeout(resolve, 600));
    const install = sent.filter(message => message.type === 'desktop-update-install');
    assert.equal(install.length, 1); assert.equal(install[0].value.installer, path.join(dataDir, 'installers', 'ClaudeOS-Setup-0.4.0.exe'), 'installs a kept copy');
    // the restarted backend reads what happened, once
    again = createUpdater({ busy: () => false, dataDir });
    const last = again.status().last;
    assert.equal(last.ok, true); assert.equal(last.chat, 'c1'); assert.equal(last.brain, 'b1'); assert.equal(last.version, '0.4.0'); assert.equal(last.kind, 'install');
    assert.equal(createUpdater({ busy: () => false, dataDir }).status().last, null);
  } finally {
    updater?.cancel(); again?.cancel();
    for (const listener of process.listeners('message')) if (!before.has(listener)) process.removeListener('message', listener);
    if (saved.env === undefined) delete process.env.CLAUDEOS_DESKTOP; else process.env.CLAUDEOS_DESKTOP = saved.env;
    if (saved.send === undefined) delete process.send; else process.send = saved.send;
    if (saved.connected === undefined) delete process.connected; else process.connected = saved.connected;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('only the version before is kept, rollback installs it and swaps the two', async () => {
  const saved = { env: process.env.CLAUDEOS_DESKTOP, send: process.send, connected: process.connected };
  const before = new Set(process.listeners('message'));
  const sent = [];
  process.env.CLAUDEOS_DESKTOP = '1'; process.connected = true;
  process.send = (message, callback) => { sent.push(message); callback?.(); };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeos-rollback-'));
  const dataDir = path.join(root, 'data'), dist = path.join(root, 'dist');
  fs.mkdirSync(dataDir); fs.mkdirSync(dist);
  const made = v => { const f = path.join(dist, `ClaudeOS-Setup-${v}.exe`); fs.writeFileSync(f, v); return f; };
  const kept = () => fs.readdirSync(path.join(dataDir, 'installers')).filter(f => f.endsWith('.exe')).sort();
  const updaters = [];
  try {
    const { createUpdater } = await import(pathToFileURL(path.join(__dirname, '..', 'update.mjs')).href);
    // one start of the backend, running `version`
    const start = version => { const u = createUpdater({ busy: () => false, dataDir }); updaters.push(u); return u; };
    const installs = () => sent.filter(m => m.type === 'desktop-update-install');
    const go = async (u, request) => { const n = installs().length; const r = u.request(request); assert.ok(!r.error, r.error); await new Promise(res => setTimeout(res, 380)); assert.equal(installs().length, n + 1); return installs().at(-1).value.installer; };

    let u = start();
    assert.match(u.request({ rollback: true, kind: 'rollback' }).error, /no earlier version/);
    await go(u, { installer: made('0.4.0') });
    u = start();                                   // 0.4.0 installed: nothing to go back to yet
    assert.deepEqual(kept(), ['ClaudeOS-Setup-0.4.0.exe']);
    await go(u, { installer: made('0.4.1') });
    u = start();                                   // 0.4.1 installed: 0.4.0 can be gone back to
    assert.equal(u.status().previous.version, '0.4.0');
    const back = await go(u, { kind: 'rollback' });
    assert.equal(path.basename(back), 'ClaudeOS-Setup-0.4.0.exe');
    assert.equal(path.dirname(back), path.join(dataDir, 'installers'), 'installs the kept copy');
    u = start();                                   // back on 0.4.0: 0.4.1 is kept for going forward
    assert.equal(u.status().last.kind, 'rollback');
    assert.equal(u.status().previous.version, '0.4.1');
    await go(u, { installer: made('0.4.2') });
    u = start();                                   // 0.4.2 installed: only it and the one before stay
    assert.deepEqual(kept(), ['ClaudeOS-Setup-0.4.0.exe', 'ClaudeOS-Setup-0.4.2.exe']);
    assert.equal(u.status().previous.version, '0.4.0');
    // a failed install keeps what was there and drops its copy
    await go(u, { installer: made('0.4.3') });
    const marker = path.join(dataDir, 'update.json');
    fs.writeFileSync(marker, JSON.stringify({ ...JSON.parse(fs.readFileSync(marker, 'utf8')), status: 'failed' }));
    u = start();
    assert.equal(u.status().last.ok, false);
    assert.deepEqual(kept(), ['ClaudeOS-Setup-0.4.0.exe', 'ClaudeOS-Setup-0.4.2.exe']);
  } finally {
    for (const u of updaters) u.cancel();
    for (const listener of process.listeners('message')) if (!before.has(listener)) process.removeListener('message', listener);
    if (saved.env === undefined) delete process.env.CLAUDEOS_DESKTOP; else process.env.CLAUDEOS_DESKTOP = saved.env;
    if (saved.send === undefined) delete process.send; else process.send = saved.send;
    if (saved.connected === undefined) delete process.connected; else process.connected = saved.connected;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
