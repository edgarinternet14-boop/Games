'use strict';

// Electron entry point: one borderless, fullscreen game window with no menu
// bar, no URL bar and no developer tools in packaged builds.

const { app, BrowserWindow, Menu, session } = require('electron');
const path = require('node:path');

const isDev = !app.isPackaged;
// `npm start -- --devtools` opens DevTools while developing; packaged builds never can.
const allowDevTools = isDev && process.argv.includes('--devtools');

// Prefer the discrete GPU on dual-GPU laptops, and don't silently drop to
// software rendering on drivers Chromium has blocklisted.
app.commandLine.appendSwitch('force_high_performance_gpu');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
// The game starts its audio from the "click to enter" gesture; this just
// avoids a muted context if the click is consumed by pointer lock first.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// No application menu means no menu accelerators either (Ctrl+R reload,
// Ctrl+Shift+I DevTools, zoom shortcuts...).
Menu.setApplicationMenu(null);

let win = null;

function createWindow() {
  win = new BrowserWindow({
    title: 'Ultimate 3D FPS',
    fullscreen: true,
    frame: false,
    autoHideMenuBar: true,
    backgroundColor: '#05070a',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: allowDevTools,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });
  win.removeMenu();
  win.webContents.setVisualZoomLevelLimits(1, 1);

  win.once('ready-to-show', () => {
    win.show();
    win.focus();
  });

  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    // F11 or Alt+Enter toggles between fullscreen and a borderless window.
    if (input.key === 'F11' || (input.alt && input.key === 'Enter')) {
      win.setFullScreen(!win.isFullScreen());
      event.preventDefault();
    }
    if (allowDevTools && input.key === 'F12') {
      win.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  if (isDev) {
    // Mirror renderer logs into the terminal while developing.
    win.webContents.on('console-message', (event, ...legacy) => {
      const message = event.message ?? legacy[1];
      const level = event.level ?? legacy[0];
      console.log(`[renderer:${level}] ${message}`);
    });
  }

  win.webContents.on('render-process-gone', (_event, details) => {
    console.error(`Renderer process gone: ${details.reason}`);
    if (details.reason !== 'clean-exit' && !win.isDestroyed()) win.reload();
  });

  win.on('closed', () => {
    win = null;
  });

  win.loadFile(path.join(__dirname, 'src', 'index.html'));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.on('web-contents-created', (_event, contents) => {
    // The game is a single local page: no popups, no navigation, no webviews.
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event) => event.preventDefault());
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });

  app.whenReady().then(() => {
    // The only permissions the game ever needs.
    const allowed = new Set(['pointerLock', 'fullscreen']);
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => callback(allowed.has(permission)));
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));
    createWindow();
  });

  app.on('window-all-closed', () => app.quit());
}
