const { app, BrowserWindow, clipboard, ipcMain, Menu, nativeTheme, net, screen, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const remoteMain = require('@electron/remote/main');
const linkPreview = require('./link-preview');
const updater = require('./updater');
const makerworld = require('./makerworld');

remoteMain.initialize();

const MIN_WIDTH = 720;
const MIN_HEIGHT = 520;

let mainWindow = null;

// Remember window size and position

function stateFile() {
    return path.join(app.getPath('userData'), 'window-state.json');
}

function loadWindowState() {
    try {
        return JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    } catch (e) {
        return null;
    }
}

// Saved bounds are used only if they still fit on a connected screen
function validBounds(saved) {
    if (!saved || !saved.bounds) return null;
    const b = saved.bounds;
    if (![b.x, b.y, b.width, b.height].every(Number.isFinite)) return null;
    const area = screen.getDisplayMatching(b).workArea;
    const visible = b.x < area.x + area.width - 100 && b.x + b.width > area.x + 100 &&
                    b.y >= area.y - 10 && b.y < area.y + area.height - 100;
    if (!visible) return null;
    return {
        x: b.x,
        y: b.y,
        width: Math.min(Math.max(b.width, MIN_WIDTH), area.width),
        height: Math.min(Math.max(b.height, MIN_HEIGHT), area.height),
    };
}

// First launch: a large window centered on the main screen, leaving a margin around it
function defaultBounds() {
    const area = screen.getPrimaryDisplay().workArea;
    const width = Math.max(MIN_WIDTH, Math.min(1440, Math.round(area.width * 0.9)));
    const height = Math.max(MIN_HEIGHT, Math.min(960, Math.round(area.height * 0.9)));
    return {
        x: area.x + Math.round((area.width - width) / 2),
        y: area.y + Math.round((area.height - height) / 2),
        width,
        height,
    };
}

function trackWindowState(win) {
    let timer = null;
    const save = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
            if (win.isDestroyed()) return;
            const state = {
                bounds: win.getNormalBounds(), // the size to return to when un-maximized
                maximized: win.isMaximized(),
                fullScreen: win.isFullScreen(),
            };
            try { fs.writeFileSync(stateFile(), JSON.stringify(state)); } catch {}
        }, 400);
    };
    ['resize', 'move', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen'].forEach((ev) => win.on(ev, save));
    win.on('close', save);
}

// Window

function createWindow() {
    const saved = loadWindowState();
    const bounds = validBounds(saved) || defaultBounds();

    mainWindow = new BrowserWindow({
        ...bounds,
        minWidth: MIN_WIDTH,
        minHeight: MIN_HEIGHT,
        show: false,
        frame: false,
        resizable: true,
        fullscreenable: true,
        title: 'Philament',
        backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f172a' : '#ffffff',
        icon: path.join(__dirname, 'assets', 'icon.png'),
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            sandbox: false,
            spellcheck: false,
        },
    });

    remoteMain.enable(mainWindow.webContents);
    trackWindowState(mainWindow);

    // The app only ever shows its own page: links open in the browser, nothing navigates the window
    mainWindow.webContents.on('will-navigate', (event, url) => {
        if (url !== mainWindow.webContents.getURL()) event.preventDefault();
    });
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:\/\//i.test(url)) shell.openExternal(url);
        return { action: 'deny' };
    });

    mainWindow.once('ready-to-show', () => {
        if (saved && saved.maximized) mainWindow.maximize();
        mainWindow.show();
        if (saved && saved.fullScreen) mainWindow.setFullScreen(true);
    });

    mainWindow.loadFile('index.html');

    mainWindow.on('closed', () => {
        linkPreview.closeAll(); // background page windows go with the app window
        mainWindow = null;
    });
}

function sendToWindow(channel) {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.webContents.send(channel);
}

function checkForUpdatesFromMenu() {
    sendToWindow('update-menu-check');
}

function buildMenu() {
    const isMac = process.platform === 'darwin';
    const template = [
        ...(isMac ? [{
            label: app.name,
            submenu: [
                { role: 'about' },
                { label: 'Check for Updates…', click: checkForUpdatesFromMenu },
                { type: 'separator' },
                { label: 'Settings…', accelerator: 'Cmd+,', click: () => sendToWindow('open-settings') },
                { type: 'separator' },
                { role: 'services' },
                { type: 'separator' },
                { role: 'hide' },
                { role: 'hideOthers' },
                { role: 'unhide' },
                { type: 'separator' },
                { role: 'quit' },
            ],
        }] : [{
            label: 'File',
            submenu: [
                { label: 'Settings…', accelerator: 'Ctrl+,', click: () => sendToWindow('open-settings') },
                { label: 'Check for Updates…', click: checkForUpdatesFromMenu },
                { type: 'separator' },
                { role: 'quit' },
            ],
        }]),
        { role: 'editMenu' }, // copy / paste / select all in text fields
        {
            label: 'View',
            submenu: [
                { role: 'togglefullscreen' },
                { type: 'separator' },
                { role: 'resetZoom' },
                { role: 'zoomIn' },
                { role: 'zoomOut' },
            ],
        },
        { role: 'windowMenu' },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (!mainWindow) return;
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
    });

    app.whenReady().then(() => {
        // Saved links: page previews and pictures are fetched here, outside the page, so other sites can be read
        ipcMain.handle('link-preview', (event, url) => linkPreview.fetchPreview(net.fetch, url));
        // Web pages opened in the background to read a saved link get no camera, microphone, location etc.
        const { session } = require('electron');
        session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
            const origin = (details && details.requestingUrl) || '';
            callback(origin.startsWith('file:') && permission === 'clipboard-sanitized-write');
        });
        updater.registerIpc();
        makerworld.registerIpc();
        // Copying text for the window (Electron 44+ removed the clipboard from it)
        ipcMain.handle('copy-text', (event, text) => clipboard.writeText(String(text).slice(0, 10000)));
        ipcMain.handle('link-image', (event, url, pageUrl) => linkPreview.fetchImage(net.fetch, url, pageUrl));
        buildMenu();
        createWindow();
        // Dock icon follows the Mac's light/dark setting while the app is running
        updateDockIcon();
        nativeTheme.on('updated', updateDockIcon);
    });

    function updateDockIcon() {
        if (!app.dock) return;
        const file = nativeTheme.shouldUseDarkColors ? 'icon-dark.png' : 'icon.png';
        try { app.dock.setIcon(path.join(__dirname, 'assets', file)); } catch {}
    }

    app.on('before-quit', () => linkPreview.closeAll());
    app.on('window-all-closed', () => app.quit());

    app.on('activate', () => {
        if (!mainWindow) createWindow();
    });
}
