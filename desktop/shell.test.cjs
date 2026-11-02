const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

async function boot(packaged = false) {
  const backend = new EventEmitter();
  backend.connected = true; backend.stdout = new EventEmitter(); backend.stderr = new EventEmitter();
  const messages = [], opened = [], notifications = [], shortcuts = new Map();
  backend.send = (message, callback) => { messages.push(message); callback?.(); if (message.type === 'desktop-quit') setImmediate(() => backend.emit('exit', 0, null)); };
  backend.kill = () => backend.emit('exit', 1, null);
  const app = new EventEmitter();
  let login = false, loginQuery, window, spawnOptions, requestPermission, checkPermission;
  Object.assign(app, { isPackaged: packaged, setPath() {}, setAppUserModelId() {}, setName() {}, requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(), getLoginItemSettings: query => { loginQuery = query; return { openAtLogin: login }; }, setLoginItemSettings: value => { login = value.openAtLogin; },
    quit() { const event = { preventDefault() { this.prevented = true; } }; app.emit('before-quit', event); if (!event.prevented) app.emit('quit'); } });
  class Window extends EventEmitter {
    constructor(options) { super(); this.options = options; this.visible = false; this.focused = false; this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = handler => { this.openHandler = handler; };
      window = this;
    }
    loadURL(url) { this.url = url; return Promise.resolve(); }
    isDestroyed() { return false; } isMinimized() { return false; } isMaximized() { return false; }
    isVisible() { return this.visible; } isFocused() { return this.focused; }
    getNormalBounds() { return { width: 1400, height: 900, x: 0, y: 0 }; }
    show() { this.visible = true; } focus() { this.focused = true; } hide() { this.visible = false; this.focused = false; }
    close() { const event = { preventDefault() { this.prevented = true; } }; this.emit('close', event); return event; }
  }
  class NativeNotification extends EventEmitter {
    static isSupported() { return true; }
    constructor(value) { super(); this.value = value; notifications.push(this); } show() {}
  }
  class NativeTray extends EventEmitter { setToolTip() {} setContextMenu() {} }
  const autoUpdater = new EventEmitter(); autoUpdater.checkForUpdates = () => Promise.resolve();
  autoUpdater.quitAndInstall = () => { autoUpdater.installed = true; };
  const electron = { app, BrowserWindow: Window, Tray: NativeTray, Notification: NativeNotification,
    Menu: { buildFromTemplate: value => value, setApplicationMenu() {} },
    globalShortcut: { unregisterAll: () => shortcuts.clear(), register: (key, handler) => { shortcuts.set(key, handler); return true; } },
    shell: { openExternal: url => { opened.push(url); return Promise.resolve(); } },
    dialog: { showErrorBox: (_title, message) => { throw new Error(message); }, showMessageBox: () => Promise.resolve({ response: 1 }) },
    screen: { getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }] },
    session: { defaultSession: { setPermissionRequestHandler: handler => { requestPermission = handler; }, setPermissionCheckHandler: handler => { checkPermission = handler; } } },
  };
  const fakeFs = { mkdirSync() {}, statSync() { throw new Error('absent'); }, appendFileSync() {}, writeFileSync() {}, readFileSync() { throw new Error('absent'); } };
  const context = {
    require(name) { if (name === 'electron') return electron; if (name === 'electron-updater') return { autoUpdater };
      if (name === 'node:fs') return fakeFs;
      if (name === 'node:child_process') return { spawn(_cmd, _args, options) { spawnOptions = options; return backend; } };
      return require(name);
    },
    __dirname, process: { env: { CLAUDEOS_HOME: 'lab', PORT: '4800' }, argv: [], platform: 'win32', execPath: 'ClaudeOS.exe', resourcesPath: 'resources' },
    setTimeout, clearTimeout, console, URL,
  };
  vm.runInNewContext(source, context, { filename: 'desktop/main.cjs' });
  await tick();
  backend.emit('message', { type: 'desktop-ready', value: { url: 'http://localhost:4800', settings: { hotkey: 'Ctrl+Alt+O', notify: true } } });
  await tick();
  return { app, backend, window, spawnOptions, messages, opened, notifications, shortcuts, autoUpdater, loginQuery: () => loginQuery,
    requestPermission: (...args) => requestPermission(...args), checkPermission: (...args) => checkPermission(...args),
    async stop() { app.quit(); await tick(); await tick(); } };
}

test('shell starts a private backend and exposes no Node API in its window', async () => {
  const h = await boot();
  try {
    assert.equal(h.spawnOptions.env.CLAUDEOS_DESKTOP, '1');
    assert.equal(h.spawnOptions.stdio[3], 'ipc');
    assert.equal(h.window.options.webPreferences.nodeIntegration, false);
    assert.equal(h.window.options.webPreferences.sandbox, true);
    assert.equal(h.window.options.webPreferences.contextIsolation, true);
    assert.equal(h.window.options.webPreferences.preload, undefined);
    assert.equal(h.window.openHandler({ url: 'file:///C:/Windows/cmd.exe' }).action, 'deny');
    assert.equal(h.opened.length, 0);
    h.window.openHandler({ url: 'https://example.com/' });
    assert.equal(h.opened[0], 'https://example.com/');
  } finally { await h.stop(); }
});
test('closing keeps sessions alive and a second launch restores the same window', async () => {
  const h = await boot();
  try {
    h.window.show(); h.window.close(); assert.equal(h.window.visible, false);
    assert.equal(h.messages.some(message => message.type === 'desktop-quit'), false);
    h.app.emit('second-instance'); assert.equal(h.window.visible, true);
    h.backend.emit('message', { type: 'desktop-configure', value: { hotkey: 'Ctrl+Shift+K' } });
    assert.equal(h.shortcuts.has('Control+Shift+K'), true);
    assert.equal(h.shortcuts.has('Control+Alt+O'), false);
  } finally { await h.stop(); }
  assert.equal(h.messages.some(message => message.type === 'desktop-quit'), true);
});
test('only the application main frame may request microphone access', async () => {
  const h = await boot();
  try {
    let permitted;
    h.requestPermission(h.window.webContents, 'media', value => { permitted = value; }, { isMainFrame: true, requestingUrl: 'http://localhost:4800/' });
    assert.equal(permitted, true);
    h.requestPermission(h.window.webContents, 'media', value => { permitted = value; }, { isMainFrame: false, requestingUrl: 'http://localhost:4810/' });
    assert.equal(permitted, false);
    assert.equal(h.checkPermission(h.window.webContents, 'geolocation', 'http://localhost:4800', { isMainFrame: true }), false);
  } finally { await h.stop(); }
});
test('native notifications are suppressed while the app is focused', async () => {
  const h = await boot();
  try {
    h.window.show(); h.window.focus();
    h.backend.emit('message', { type: 'desktop-notify', value: { title: 'Done', body: 'Finished' } });
    assert.equal(h.notifications.length, 0);
    h.window.hide();
    h.backend.emit('message', { type: 'desktop-notify', value: { title: 'Done', body: 'Finished' } });
    assert.equal(h.notifications.length, 1);
    h.notifications[0].emit('click'); assert.equal(h.window.visible, true);
  } finally { await h.stop(); }
});
test('desktop installation waits for backend shutdown before launching the installer', async () => {
  const h = await boot(true);
  try {
    h.autoUpdater.emit('update-downloaded', { version: '0.4.0' });
    assert.equal(h.messages.at(-1).value.ready.build, '0.4.0');
    h.backend.emit('message', { type: 'desktop-update-install' });
    assert.equal(h.autoUpdater.installed, undefined);
    await tick(); await tick();
    assert.equal(h.autoUpdater.installed, true);
  } finally { await h.stop(); }
});

test('start-at-login checks the same background command that it registers', async () => {
  const h = await boot(true);
  try {
    h.backend.emit('message', { type: 'desktop-login', id: 41, value: { enabled: true } });
    h.backend.emit('message', { type: 'desktop-settings', id: 42 });
    assert.equal(h.messages.at(-1).value.startAtLogin, true);
    assert.equal(h.loginQuery().path, 'ClaudeOS.exe');
    assert.equal(h.loginQuery().args[0], '--background');
  } finally { await h.stop(); }
});
