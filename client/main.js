'use strict';

/**
 * Dunebound - Electron entry point.
 *
 * Launches the game as a borderless, fullscreen desktop application: no
 * window frame, no application menu and no developer tools. The renderer runs
 * fully sandboxed (no Node integration) and talks to the game server over
 * Socket.io like any other client.
 *
 * Command line:
 *   --server=http://host:3000   pre-fill the server address (also DUNEBOUND_SERVER)
 *   --windowed                  start in a borderless window instead of fullscreen
 *   --profile=name              keep a separate local profile (run several players on one PC)
 *   --dev                       allow developer tools (unpackaged builds only)
 */

const path = require('path');
const { app, BrowserWindow, Menu, session, shell } = require('electron');

const argValue = (name) => {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
};

const DEV = !app.isPackaged && process.argv.includes('--dev');
const WINDOWED = process.argv.includes('--windowed');
const SERVER = argValue('server') || process.env.DUNEBOUND_SERVER || '';
const PROFILE = (argValue('profile') || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 32);

// Each named profile gets its own user-data folder (and therefore its own saved player token).
if (PROFILE) app.setPath('userData', path.join(app.getPath('userData'), 'profiles', PROFILE));

// Games need the GPU even on blocklisted drivers, and should not be throttled when unfocused.
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
if (process.platform === 'win32') app.setAppUserModelId('com.dunebound.game');

let mainWindow = null;

function createWindow() {
  Menu.setApplicationMenu(null);

  mainWindow = new BrowserWindow({
    width: 1600,
    height: 900,
    minWidth: 1024,
    minHeight: 600,
    frame: false,
    fullscreen: !WINDOWED,
    fullscreenable: true,
    autoHideMenuBar: true,
    backgroundColor: '#0b0806',
    show: false,
    title: 'Dunebound',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: DEV,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });
  mainWindow.removeMenu();

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  // Keyboard handling that belongs to the desktop shell rather than the game.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = input.key.toLowerCase();
    if (key === 'f11' || (input.alt && key === 'enter')) {
      mainWindow.setFullScreen(!mainWindow.isFullScreen());
      event.preventDefault();
      return;
    }
    const ctrl = input.control || input.meta;
    const devCombo = key === 'f12' || (ctrl && input.shift && ['i', 'j', 'c'].includes(key));
    const reloadCombo = key === 'f5' || (ctrl && key === 'r');
    if (!DEV && (devCombo || reloadCombo)) event.preventDefault();
    if (DEV && key === 'f12') mainWindow.webContents.toggleDevTools();
  });

  // The game never navigates or opens windows; external links go to the system browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());

  const query = SERVER ? { server: SERVER } : undefined;
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'), query ? { query } : undefined);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// No single-instance lock: several game windows on one PC is a handy way to test multiplayer.
app.whenReady().then(() => {
  // Only pointer lock and fullscreen are ever granted to the renderer.
  const allowed = new Set(['pointerLock', 'fullscreen']);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => callback(allowed.has(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (event) => event.preventDefault());
});

app.on('window-all-closed', () => app.quit());
