const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

test('backend defers installation while agents work, and cancellation prevents restart', async () => {
  const saved = { env: process.env.CLAUDEOS_DESKTOP, send: process.send, connected: process.connected };
  const before = new Set(process.listeners('message'));
  const sent = [];
  process.env.CLAUDEOS_DESKTOP = '1'; process.connected = true;
  process.send = (message, callback) => { sent.push(message); callback?.(); };
  let updater;
  try {
    const { createUpdater } = await import(pathToFileURL(path.join(__dirname, '..', 'update.mjs')).href);
    let busy = true;
    updater = createUpdater({ busy: () => busy });
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
  }
});
