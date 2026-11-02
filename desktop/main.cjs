const { app, BrowserWindow, Menu, Tray, Notification, globalShortcut, shell, dialog, screen, session } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { externalUrl, appNavigation, windowBounds, backendSpec } = require('./policy.cjs');

const dataDir = path.resolve(process.env.CLAUDEOS_HOME || path.join(os.homedir(), '.claudeos'));
fs.mkdirSync(dataDir, { recursive: true });
app.setPath('userData', path.join(dataDir, 'desktop'));
app.setAppUserModelId('com.claudeos.desktop');
app.setName('ClaudeOS');
const logFile = path.join(dataDir, 'desktop.log');
try {
  if (fs.statSync(logFile).size > 5 * 1024 * 1024) {
    fs.rmSync(`${logFile}.previous`, { force: true });
    fs.renameSync(logFile, `${logFile}.previous`);
  }
} catch {}
function log(message) { try { fs.appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`); } catch {} }
let win, tray, backend, readyTimer, stopping = false, stopped = false, fatalShown = false, appUrl;
let settings = { hotkey: 'Ctrl+Alt+O', notify: true }, hotkeyOk = false;
let updater, updateState = { phase: 'idle', ready: null, pending: false };
const boundsFile = path.join(dataDir, 'desktop-window.json');
const icon = app.isPackaged ? path.join(process.resourcesPath, 'icon.ico') : path.join(__dirname, '..', 'assets', 'icon.ico');
const smokeFile = process.env.CLAUDEOS_DESKTOP_SMOKE;

function send(type, value = {}, id) {
  if (backend?.connected) backend.send({ type, value, ...(id == null ? {} : { id }) }, error => { if (error) log(`IPC: ${error.message}`); });
}
function showWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
}
function openExternal(url) {
  const safe = externalUrl(url);
  if (safe) shell.openExternal(safe).catch(error => log(`Opening external link failed: ${error.message}`));
}
function fatal(message) {
  log(message);
  if (fatalShown || stopping) return;
  fatalShown = true;
  if (smokeFile) fs.writeFileSync(smokeFile, JSON.stringify({ ok: false, error: message }));
  else dialog.showErrorBox('ClaudeOS could not start', `${message}\n\nDetails: ${logFile}`);
  app.quit();
}
function configure(next) {
  settings = { ...settings, ...next };
  globalShortcut.unregisterAll();
  const accelerator = String(settings.hotkey || '').replace(/\bCtrl\b/g, 'Control').replace(/\bWin\b/g, 'Super');
  try { hotkeyOk = !!accelerator && globalShortcut.register(accelerator, showWindow); } catch { hotkeyOk = false; }
}
function desktopSettings() {
  return { desktop: true, appWindow: true, tray: !!tray, hotkeyOk,
    startAtLogin: app.isPackaged && app.getLoginItemSettings({ path: process.execPath, args: ['--background'] }).openAtLogin,
    canStartAtLogin: app.isPackaged && ['win32', 'darwin'].includes(process.platform) };
}
function saveWindow() {
  if (!win || win.isDestroyed()) return;
  try { fs.writeFileSync(boundsFile, JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() })); } catch (error) { log(`Saving window: ${error.message}`); }
}
function createWindow() {
  let saved;
  try { saved = JSON.parse(fs.readFileSync(boundsFile, 'utf8')); } catch {}
  win = new BrowserWindow({ ...windowBounds(saved, screen.getAllDisplays()), minWidth: 900, minHeight: 640,
    title: 'ClaudeOS', icon, show: false, backgroundColor: '#101019', autoHideMenuBar: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
      allowRunningInsecureContent: false, webviewTag: false, navigateOnDragDrop: false, spellcheck: true } });
  win.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (event, url) => {
    if (appNavigation(url, appUrl)) return;
    event.preventDefault(); openExternal(url);
  });
  win.webContents.on('will-redirect', (event, url, _inPlace, isMainFrame) => { if (isMainFrame !== false && !appNavigation(url, appUrl)) event.preventDefault(); });
  win.webContents.on('will-attach-webview', event => event.preventDefault());
  win.webContents.on('render-process-gone', (_event, details) => {
    log(`Window renderer stopped: ${details.reason}`);
    if (!stopping && details.reason !== 'clean-exit') {
      dialog.showMessageBox({ type: 'error', message: 'The ClaudeOS window stopped responding.', detail: 'Agent sessions are still running. Reload the window to reconnect.', buttons: ['Reload', 'Quit'], defaultId: 0 })
        .then(({ response }) => response === 0 ? win?.reload() : app.quit());
    }
  });
  win.on('close', event => { saveWindow(); if (!stopping) { event.preventDefault(); win.hide(); } });
  win.once('ready-to-show', () => {
    if (saved?.maximized) win.maximize();
    if (!process.argv.includes('--background') && !process.env.CLAUDEOS_NO_OPEN) showWindow();
  });
  win.loadURL(appUrl).catch(error => fatal(error.message));
  if (smokeFile) win.webContents.once('did-finish-load', () => runSmoke().catch(error => {
    fs.writeFileSync(smokeFile, JSON.stringify({ ok: false, error: error.stack })); app.quit();
  }));
}
function pushUpdate(patch) { updateState = { ...updateState, ...patch }; send('desktop-update-state', updateState); }
function configureUpdates() {
  if (!app.isPackaged) { pushUpdate({ phase: 'development', canUpdate: false }); return; }
  const { autoUpdater } = require('electron-updater');
  updater = autoUpdater;
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.logger = { info: log, warn: log, error: log, debug() {} };
  updater.on('checking-for-update', () => pushUpdate({ phase: 'checking', error: null }));
  updater.on('update-not-available', () => pushUpdate({ phase: 'current', error: null }));
  updater.on('error', error => pushUpdate({ phase: 'error', error: error.message, pending: false }));
  updater.on('update-available', async info => {
    pushUpdate({ phase: 'available', version: info.version });
    const { response } = await dialog.showMessageBox({ type: 'info', message: `ClaudeOS ${info.version} is available.`, buttons: ['Download', 'Later'], defaultId: 0, cancelId: 1 });
    if (response === 0) { pushUpdate({ phase: 'downloading' }); updater.downloadUpdate().catch(error => pushUpdate({ phase: 'error', error: error.message })); }
  });
  updater.on('download-progress', progress => pushUpdate({ phase: 'downloading', percent: Math.round(progress.percent) }));
  updater.on('update-downloaded', info => pushUpdate({ phase: 'downloaded', ready: { build: info.version, built: Date.now() }, error: null }));
}
function checkUpdates() {
  if (!updater || ['checking', 'downloading'].includes(updateState.phase)) return;
  updater.checkForUpdates().catch(error => pushUpdate({ phase: 'error', error: error.message }));
}
function createTray() {
  tray = new Tray(icon);
  tray.setToolTip('ClaudeOS');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open ClaudeOS', click: showWindow },
    { label: 'Check for updates…', click: () => { showWindow(); checkUpdates(); } },
    { type: 'separator' }, { label: 'Quit ClaudeOS', click: () => app.quit() },
  ]));
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
}
function notify(value) {
  if (!settings.notify || !Notification.isSupported() || (win?.isVisible() && win.isFocused())) return;
  const notification = new Notification({ title: String(value.title || 'ClaudeOS'), body: String(value.body || ''), icon });
  notification.on('click', showWindow);
  notification.show();
}
async function onMessage(message) {
  if (!message || typeof message.type !== 'string') return;
  const value = message.value || {};
  const reply = result => send('desktop-reply', result, message.id);
  try {
    switch (message.type) {
      case 'desktop-ready':
        if (appUrl) return;
        clearTimeout(readyTimer);
        // Accept only the loopback URL we instructed this child to bind.
        if (value.url !== `http://localhost:${Number(process.env.PORT || 4747)}`) return fatal('The backend returned an unexpected address.');
        appUrl = value.url; configure(value.settings); createTray(); createWindow(); configureUpdates(); break;
      case 'desktop-error': fatal(value.message || 'Backend startup failed.'); break;
      case 'desktop-show': showWindow(); break;
      case 'desktop-configure': configure(value); break;
      case 'desktop-notify': notify(value); break;
      case 'desktop-settings': reply(desktopSettings()); break;
      case 'desktop-login':
        if (!app.isPackaged || !['win32', 'darwin'].includes(process.platform)) return reply({ error: 'Start at login is available in the installed desktop app.' });
        app.setLoginItemSettings({ openAtLogin: !!value.enabled, name: 'ClaudeOS', path: process.execPath, args: ['--background'] });
        reply({ ok: true }); break;
      case 'desktop-update-check': checkUpdates(); break;
      case 'desktop-update-install':
        if (!updater || !updateState.ready) return pushUpdate({ pending: false });
        // The backend has waited for all agent turns before requesting installation.
        await stopBackend(); updater.quitAndInstall(false, true); break;
    }
  } catch (error) {
    log(error.stack);
    if (message.type === 'desktop-ready') fatal(`Desktop initialization failed: ${error.message}`);
    else if (message.id != null) reply({ error: error.message });
  }
}
function startBackend() {
  const spec = backendSpec({ packaged: app.isPackaged, resources: process.resourcesPath,
    root: path.join(__dirname, '..'), node: process.env.CLAUDEOS_NODE, platform: process.platform });
  backend = spawn(spec.command, spec.args, { cwd: app.isPackaged ? path.dirname(spec.command) : path.join(__dirname, '..'),
    env: { ...process.env, CLAUDEOS_DESKTOP: '1', CLAUDEOS_HOME: dataDir, CLAUDEOS_NO_OPEN: '1' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  backend.stdout.on('data', data => log(`Backend: ${data.toString().trim()}`));
  backend.stderr.on('data', data => log(`Backend: ${data.toString().trim()}`));
  backend.on('message', onMessage);
  backend.on('error', error => fatal(`Could not launch the backend: ${error.message}`));
  backend.on('exit', (code, signal) => {
    clearTimeout(readyTimer); stopped = true;
    if (!stopping) fatal(`The backend stopped (code ${code}, signal ${signal}).`);
  });
  readyTimer = setTimeout(() => fatal('The backend did not become ready within 45 seconds.'), 45000);
}
let stopPromise;
function stopBackend() {
  if (stopPromise) return stopPromise;
  stopping = true; clearTimeout(readyTimer); saveWindow();
  globalShortcut.unregisterAll();
  stopPromise = new Promise(resolve => {
    if (!backend || stopped) return resolve();
    let timer;
    const done = () => { clearTimeout(timer); resolve(); };
    backend.once('exit', done);
    timer = setTimeout(() => {
      log('Backend shutdown timed out; terminating the owned process.');
      backend.kill(); done();
    }, 8000);
    send('desktop-quit');
  });
  return stopPromise;
}
async function runSmoke() {
  const prefs = win.webContents.getLastWebPreferences();
  if (prefs.nodeIntegration || !prefs.contextIsolation || !prefs.sandbox) throw new Error('Unsafe renderer preferences');
  const result = await win.webContents.executeJavaScript(`(async () => {
    const token = window.CLAUDEOS_TOKEN;
    const api = async (url, body) => (await fetch(url, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', 'x-claudeos-token': token }, body: body === undefined ? undefined : JSON.stringify(body) })).json();
    const settings = await api('/api/settings');
    const update = await api('/api/update');
    const terminal = await api('/api/terminal/run', { command: 'echo CLAUDEOS_DESKTOP_SMOKE_OK' });
    let consoleVerified = false;
    for (let i = 0; i < 100 && terminal.tab?.id; i++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      const output = await api('/api/terminals');
      const tab = output.tabs?.find(tab => tab.id === terminal.tab.id);
      if (tab && !tab.running && tab.code === 0 && tab.screen.includes('CLAUDEOS_DESKTOP_SMOKE_OK')) { consoleVerified = true; break; }
    }
    return { tokenPresent: !!token, nodeUnavailable: typeof require === 'undefined' && typeof process === 'undefined', settings, update, terminal, consoleVerified };
  })()`);
  if (!result.tokenPresent || !result.nodeUnavailable || !result.settings.desktop || result.terminal.error || !result.consoleVerified) throw new Error(JSON.stringify(result));
  win.close();
  const closeToTray = !win.isDestroyed() && !win.isVisible();
  showWindow();
  fs.writeFileSync(smokeFile, JSON.stringify({ ok: closeToTray, closeToTray, rendererSandboxed: true, ...result }, null, 2));
  app.quit();
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showWindow);
  app.on('activate', showWindow);
  app.on('window-all-closed', () => {});
  app.on('before-quit', event => {
    if (stopped || !backend) { stopping = true; return; }
    event.preventDefault(); stopBackend().then(() => { stopped = true; app.quit(); });
  });
  app.whenReady().then(() => {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'ClaudeOS', submenu: [{ label: 'Check for updates…', click: checkUpdates }, { type: 'separator' }, { role: 'quit' }] },
      { role: 'editMenu' }, { label: 'View', submenu: [{ role: 'reload' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
    ]));
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
      callback(contents === win?.webContents && details.isMainFrame === true && appNavigation(details.requestingUrl, appUrl) && permission === 'media');
    });
    session.defaultSession.setPermissionCheckHandler((contents, permission, origin, details) =>
      contents === win?.webContents && details.isMainFrame === true && origin === new URL(appUrl).origin && permission === 'media');
    startBackend();
  }).catch(error => fatal(error.stack || error.message));
}
