const { app, BrowserWindow, session, globalShortcut, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execSync } = require('child_process');

let win;
let chatWin = null;
const CHAT_DEFAULT_WIDTH = 420;
const CHAT_MIN_WIDTH = 360;
const CHAT_MAX_WIDTH = 840;
const CHAT_MIN_HEIGHT = 420;
let chatSyncInProgress = false;
let hubProcess = null;
let mockupProcess = null;
let isQuitting = false; // Flag to prevent chat window from blocking exit
const unreadNotifications = { chat: false, todo: false };
const registeredShortcuts = new Map();
let globalMouseHook = null;
let globalMouseHookStarted = false;
let capturingHotkeyId = null;
let foregroundWatcher = null;
let foregroundBuffer = '';
let photoshopPinned = false;
let photoshopRunning = false;
let foregroundPid = 0;
let foregroundName = '';
let lastExternalWasPhotoshop = false;
let pinChatWasVisible = false;

const MOUSE_BUTTON_NAMES = Object.freeze({
    3: 'MouseMiddle',
    4: 'Mouse4',
    5: 'Mouse5'
});

function shortcutTargetWindow() {
    return win && !win.isDestroyed() ? win : null;
}

function isPhotoshopName(name) { return String(name || '').toLowerCase().includes('photoshop'); }
function canTogglePhotoshopPin() {
    return photoshopRunning && (isPhotoshopName(foregroundName) || foregroundPid === process.pid && lastExternalWasPhotoshop);
}
function sendPhotoshopPinState() {
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
    win.webContents.send('window:photoshop-pin-state', { pinned:photoshopPinned, canPin:canTogglePhotoshopPin(), photoshopRunning });
}
function setPhotoshopPinned(next) {
    photoshopPinned = Boolean(next);
    if (win && !win.isDestroyed()) {
        win.setResizable(!photoshopPinned);
        win.setMovable(!photoshopPinned);
        if (!photoshopPinned && !win.isVisible()) { win.show(); win.focus(); }
    }
    sendPhotoshopPinState();
}
function applyForegroundState(name, pid, running) {
    foregroundName = String(name || ''); foregroundPid = Number(pid) || 0; photoshopRunning = Boolean(running);
    if (isPhotoshopName(foregroundName)) lastExternalWasPhotoshop = true;
    else if (foregroundPid !== process.pid) lastExternalWasPhotoshop = false;
    if (photoshopPinned && !photoshopRunning) {
        setPhotoshopPinned(false);
        return;
    }
    if (photoshopPinned && win && !win.isDestroyed()) {
        const photoshopActive = isPhotoshopName(foregroundName);
        const ownWindowActive = foregroundPid === process.pid && lastExternalWasPhotoshop;
        if (photoshopActive) {
            if (!win.isVisible()) win.showInactive();
            if (pinChatWasVisible && chatWin && !chatWin.isDestroyed() && !chatWin.isVisible()) chatWin.showInactive();
        } else if (!ownWindowActive && win.isVisible()) {
            pinChatWasVisible = Boolean(chatWin && !chatWin.isDestroyed() && chatWin.isVisible());
            if (chatWin && !chatWin.isDestroyed()) chatWin.hide();
            win.hide();
        }
    }
    sendPhotoshopPinState();
}
function startForegroundWatcher() {
    if (process.platform !== 'win32' || foregroundWatcher) return;
    const script = String.raw`
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class CfbForeground {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
'@
$last = ''
while ($true) {
  try {
    [uint32]$foregroundProcessId = 0
    $handle = [CfbForeground]::GetForegroundWindow()
    [void][CfbForeground]::GetWindowThreadProcessId($handle, [ref]$foregroundProcessId)
    $processName = if ($foregroundProcessId) { (Get-Process -Id $foregroundProcessId -ErrorAction Stop).ProcessName } else { '' }
    $photoshopRunning = @(Get-Process -Name Photoshop -ErrorAction SilentlyContinue).Count -gt 0
    $line = $processName + '|' + $foregroundProcessId + '|' + $photoshopRunning
    if ($line -ne $last) { [Console]::Out.WriteLine($line); [Console]::Out.Flush(); $last = $line }
  } catch {}
  Start-Sleep -Milliseconds 250
}`;
    foregroundWatcher = spawn('powershell.exe', ['-NoProfile','-NonInteractive','-WindowStyle','Hidden','-Command',script], { windowsHide:true, stdio:['ignore','pipe','ignore'] });
    foregroundWatcher.stdout.on('data', chunk => {
        foregroundBuffer += chunk.toString();
        while (foregroundBuffer.includes('\n')) {
            const index = foregroundBuffer.indexOf('\n');
            const line = foregroundBuffer.slice(0,index).trim(); foregroundBuffer = foregroundBuffer.slice(index+1);
            const [name,pid,running] = line.split('|');
            applyForegroundState(name,pid,String(running).toLowerCase() === 'true');
        }
    });
    foregroundWatcher.on('exit', () => { foregroundWatcher = null; });
}
function stopForegroundWatcher() {
    if (!foregroundWatcher) return;
    try { foregroundWatcher.kill(); } catch (_) {}
    foregroundWatcher = null;
}

function sendShortcutResult(sender, id, success, error = '') {
    if (!sender || sender.isDestroyed()) return;
    sender.send('hotkey:registration-result', { id, success, error });
}

function mouseBindingFromEvent(event, buttonName) {
    const modifiers = [];
    if (event.ctrlKey) modifiers.push('Ctrl');
    if (event.altKey) modifiers.push('Alt');
    if (event.shiftKey) modifiers.push('Shift');
    if (event.metaKey) modifiers.push('Win');
    return [...modifiers, buttonName].join('+');
}

function startGlobalMouseHook() {
    if (globalMouseHookStarted) return true;

    try {
        ({ uIOhook: globalMouseHook } = require('uiohook-napi'));
        globalMouseHook.on('mousedown', event => {
            const buttonName = MOUSE_BUTTON_NAMES[Number(event.button)];
            if (!buttonName) return;

            const binding = mouseBindingFromEvent(event, buttonName);
            const target = shortcutTargetWindow();

            if (capturingHotkeyId) {
                if (target) target.webContents.send('hotkey:mouse-captured', {
                    id: capturingHotkeyId,
                    binding
                });
                return;
            }

            for (const [id, shortcut] of registeredShortcuts) {
                if (shortcut.type === 'mouse' && shortcut.binding === binding) {
                    if (target) target.webContents.send('shortcut-triggered', id);
                    break;
                }
            }
        });
        globalMouseHook.start();
        globalMouseHookStarted = true;
        console.log('[Hotkeys] Global mouse buttons are enabled');
        return true;
    } catch (error) {
        globalMouseHook = null;
        globalMouseHookStarted = false;
        console.error('[Hotkeys] Mouse hook failed:', error.message || error);
        return false;
    }
}

function stopGlobalMouseHook() {
    capturingHotkeyId = null;
    if (!globalMouseHook) return;
    try { globalMouseHook.removeAllListeners('mousedown'); } catch (error) {}
    try { globalMouseHook.stop(); } catch (error) {}
    globalMouseHook = null;
    globalMouseHookStarted = false;
}

function unregisterShortcutById(id) {
    const current = registeredShortcuts.get(id);
    if (!current) return;
    if (current.type === 'keyboard' && current.accelerator) {
        try { globalShortcut.unregister(current.accelerator); } catch (error) {}
    }
    registeredShortcuts.delete(id);
}

function unregisterAllAppShortcuts() {
    try { globalShortcut.unregisterAll(); } catch (error) {}
    registeredShortcuts.clear();
}

// =====================================================================
// PORTABLE DATA — store settings in "ComfyFloatBar" folder next to exe
// Output files go to "download" folder at same level (not hidden inside)
// This makes the distribution folder fully self-contained (copy & run)
// =====================================================================
function setPortableUserData() {
    // Find the app directory (where the exe lives)
    const exeDir = path.dirname(app.getPath('exe'));
    // Check if we're running from a packaged app (not in development)
    const isPackaged = !exeDir.includes('node_modules') && !exeDir.includes('electron');

    if (isPackaged) {
        // Settings & localStorage stored in "ComfyFloatBar" folder next to exe
        const portableDataDir = path.join(exeDir, 'ComfyFloatBar');
        if (!fs.existsSync(portableDataDir)) fs.mkdirSync(portableDataDir, { recursive: true });
        app.setPath('userData', portableDataDir);
        console.log('[Portable] Data directory: ' + portableDataDir);
    } else {
        console.log('[Dev] Data directory: ' + app.getPath('userData'));
    }
}

// Set portable path BEFORE creating any windows (so localStorage uses it)
setPortableUserData();

// =====================================================================
// Working folder — "download" directly next to exe (not hidden inside)
// Generations, Upscales, Vectors, Mockups subfolders inside download
// =====================================================================
function getWorkingFolder() {
    const exeDir = path.dirname(app.getPath('exe'));
    const isPackaged = !exeDir.includes('node_modules') && !exeDir.includes('electron');

    // In packaged mode: download folder is directly next to exe
    // In dev mode: use userData/download for testing
    const workingDir = isPackaged
        ? path.join(exeDir, 'download')
        : path.join(app.getPath('userData'), 'download');

    if (!fs.existsSync(workingDir)) fs.mkdirSync(workingDir, { recursive: true });
    ['Generations', 'Upscales', 'Vectors', 'Mockups'].forEach(folderName => {
        const folderPath = path.join(workingDir, folderName);
        if (!fs.existsSync(folderPath)) fs.mkdirSync(folderPath, { recursive: true });
    });
    return workingDir;
}

function getHubFilesFolder() {
    const folder = path.join(getWorkingFolder(), 'HubFiles');
    if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });
    return folder;
}

function getUpscaleInboxFolder() {
    const preferredPath = 'F:\\need_upscale';
    try {
        if (!fs.existsSync(preferredPath)) fs.mkdirSync(preferredPath, { recursive: true });
        return preferredPath;
    } catch (error) {
        const fallbackPath = path.join(getWorkingFolder(), 'need_upscale');
        if (!fs.existsSync(fallbackPath)) fs.mkdirSync(fallbackPath, { recursive: true });
        return fallbackPath;
    }
}

// Путь к файлу сохранения позиции окна
const stateFilePath = path.join(app.getPath('userData'), 'window-state.json');

function getWindowState() {
    try {
        return JSON.parse(fs.readFileSync(stateFilePath, 'utf8'));
    } catch (e) {
        return null;
    }
}

function saveWindowState() {
    if (!win) return;
    const bounds = win.getBounds();
    fs.writeFileSync(stateFilePath, JSON.stringify(bounds));
}

// =====================================================================
// Проверка орфографии и контекстные подсказки
// =====================================================================
function configureSpellChecker() {
    const spellSession = session.defaultSession;
    spellSession.setSpellCheckerEnabled(true);
    try {
        spellSession.setSpellCheckerLanguages(['ru-RU', 'en-US']);
    } catch (error) {
        console.warn('[Spellcheck] Не удалось выбрать словари:', error.message || error);
    }
}

function installSpellcheckContextMenu(targetWindow) {
    targetWindow.webContents.on('context-menu', (event, params) => {
        if (!params.isEditable || !params.misspelledWord) return;
        const suggestions = Array.isArray(params.dictionarySuggestions) ? params.dictionarySuggestions.slice(0, 7) : [];
        const template = suggestions.length
            ? suggestions.map(suggestion => ({ label: suggestion, click: () => targetWindow.webContents.replaceMisspelling(suggestion) }))
            : [{ label: 'Нет вариантов исправления', enabled: false }];
        template.push({ type: 'separator' }, { role: 'cut', label: 'Вырезать' }, { role: 'copy', label: 'Копировать' }, { role: 'paste', label: 'Вставить' });
        Menu.buildFromTemplate(template).popup({ window: targetWindow });
    });
}

// =====================================================================
// Создание главного окна
// =====================================================================
function createWindow() {
    const state = getWindowState();

    win = new BrowserWindow({
        width: state ? state.width : 280,
        height: state ? state.height : 650,
        x: state ? state.x : undefined,
        y: state ? state.y : undefined,
        title: "ComfyFloatBar",
        alwaysOnTop: true,
        frame: false,
        icon: path.join(__dirname, 'icon.png'),
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            spellcheck: true
        }
    });

    installSpellcheckContextMenu(win);
    win.loadFile('index.html');
    win.setMenuBarVisibility(false);
    // A hidden launcher may leave the new window without keyboard focus on Windows.
    win.once('ready-to-show', () => {
        if (!win || win.isDestroyed()) return;
        win.show();
        win.focus();
        startForegroundWatcher();
        sendPhotoshopPinState();
    });

    // Жестко держим окно поверх всех
    win.setAlwaysOnTop(true, 'floating');
    win.on('restore', () => win.setAlwaysOnTop(true, 'floating'));
    win.on('focus', () => win.setAlwaysOnTop(true, 'floating'));
    win.on('show', () => win.setAlwaysOnTop(true, 'floating'));

    // Когда главное окно двигается — чат-окно двигается вместе с ним
    win.on('move', () => syncChatWindowPosition());

    // Когда главное окно закрывается — ACTUALLY quit the app
    win.on('close', (e) => {
        if (isQuitting) return; // already quitting, let it proceed
        isQuitting = true;
        saveWindowState();

        // Destroy chat window (bypass its e.preventDefault)
        if (chatWin && !chatWin.isDestroyed()) {
            chatWin.destroy(); // destroy, not close — bypasses preventDefault
            chatWin = null;
        }


        // Force-kill hub process (Windows: kill entire process tree)
        stopHubService();
        stopMockupService();

        // Unregister all shortcuts
        unregisterAllAppShortcuts();
        stopGlobalMouseHook();
        stopForegroundWatcher();

        // Quit app
        win.destroy();
        app.quit();
    });
}

// =====================================================================
// Создание чат-окна (прикреплено слева от главного)
// =====================================================================
function createChatWindow() {
    if (chatWin && !chatWin.isDestroyed()) {
        // Окно уже есть — просто показываем/скрываем
        if (chatWin.isVisible()) {
            chatWin.hide();
            if (win && !win.isDestroyed()) {
                win.webContents.send('chat:closed');
                win.focus();
            }
        } else {
            chatWin.show();
        }
        return;
    }

    const mainBounds = win.getBounds();

    chatWin = new BrowserWindow({
        width: CHAT_DEFAULT_WIDTH,
        height: mainBounds.height,
        x: mainBounds.x - CHAT_DEFAULT_WIDTH,
        y: mainBounds.y,
        title: "Chat",
        alwaysOnTop: true,
        frame: false,
        resizable: true,
        minWidth: CHAT_MIN_WIDTH,
        maxWidth: CHAT_MAX_WIDTH,
        minHeight: CHAT_MIN_HEIGHT,
        icon: path.join(__dirname, 'icon.png'),
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            spellcheck: true
        }
    });

    installSpellcheckContextMenu(chatWin);
    chatWin.loadFile('chat.html');
    chatWin.setMenuBarVisibility(false);
    chatWin.setAlwaysOnTop(true, 'floating');
    chatWin.on('show', scheduleChatWindowPositionSync);

    // Закрытие чат-окно — скрываем, НЕ уничтожаем (только при user click)
    // Но при app quit — destroy() вызывается из main window close handler
    chatWin.on('close', (e) => {
        if (isQuitting) return; // app is quitting, don't prevent — let destroy happen
        e.preventDefault();
        chatWin.hide();
        if (win && !win.isDestroyed()) {
            win.webContents.send('chat:closed');
            win.focus();
        }
    });
}

// Синхронизация позиции чат-окна с главным
function syncChatWindowPosition() {
    if (!chatWin || chatWin.isDestroyed() || !chatWin.isVisible()) return;
    if (!win || win.isDestroyed()) return;
    if (chatSyncInProgress) return;
    const mainBounds = win.getBounds();
    const chatBounds = chatWin.getBounds();
    const width = Math.min(CHAT_MAX_WIDTH, Math.max(CHAT_MIN_WIDTH, chatBounds.width));
    const targetX = mainBounds.x - width;
    const targetY = mainBounds.y;
    if (chatBounds.x === targetX && chatBounds.y === targetY && chatBounds.width === width) return;
    // Reattach the right edge only when bounds actually changed. This prevents a Windows resize event from feeding back into itself.
    chatSyncInProgress = true;
    try {
        chatWin.setBounds({ x: targetX, y: targetY, width, height: chatBounds.height });
    } finally {
        setTimeout(() => { chatSyncInProgress = false; }, 0);
    }
}

function scheduleChatWindowPositionSync() {
    setTimeout(syncChatWindowPosition, 0);
}


// =====================================================================
// IPC handlers
// =====================================================================

ipcMain.on('window:minimize', () => { if (win) win.minimize(); });
ipcMain.on('window:maximize', () => { if (win) { win.isMaximized() ? win.unmaximize() : win.maximize(); } });
ipcMain.on('window:close', () => { if (win) win.close(); });
ipcMain.handle('window:toggle-photoshop-pin', () => {
    if (photoshopPinned) {
        if (!canTogglePhotoshopPin()) return { ok:false, error:'Открепление доступно, когда активно окно Photoshop.' };
        setPhotoshopPinned(false); return { ok:true, pinned:false };
    }
    if (!canTogglePhotoshopPin()) return { ok:false, error:'Сначала сделайте Photoshop активным окном.' };
    setPhotoshopPinned(true); return { ok:true, pinned:true };
});
ipcMain.handle('window:get-photoshop-state', () => ({
    photoshopRunning,
    foregroundName,
    foregroundPid
}));
ipcMain.on('chat:toggle', () => createChatWindow());
ipcMain.on('chat:set-text-scale', (event, value) => {
    const scale = Math.min(1.4, Math.max(1, Number(value) || 1));
    try { event.sender.setZoomFactor(scale); } catch (error) {}
});

function refreshNotificationAttention() {
    const hasUnread = unreadNotifications.chat || unreadNotifications.todo;
    if (win && !win.isDestroyed()) {
        win.webContents.send(hasUnread ? 'chat:new-message' : 'chat:clear-notif');
        win.flashFrame(hasUnread);
    }
}

ipcMain.on('chat:notification', (event, data) => {
    const kind = data && data.kind === 'todo' ? 'todo' : 'chat';
    unreadNotifications[kind] = true;
    refreshNotificationAttention();
});
ipcMain.on('chat:send-nickname', (event, nickname) => {
    if (chatWin && !chatWin.isDestroyed()) chatWin.webContents.send('chat:set-nickname', nickname);
    if (win && !win.isDestroyed()) win.webContents.send('main:set-nickname', nickname);
});
ipcMain.on('chat:clear-notification', (event, data) => {
    if (!data || !data.kind) {
        unreadNotifications.chat = false;
        unreadNotifications.todo = false;
    } else if (data.kind === 'todo') {
        unreadNotifications.todo = false;
    } else {
        unreadNotifications.chat = false;
    }
    refreshNotificationAttention();
});
ipcMain.on('chat:update-hub-ip', (event, newHubIP) => {
    if (chatWin && !chatWin.isDestroyed()) chatWin.webContents.send('chat:update-hub-ip', newHubIP);
});
ipcMain.on('generation-history:changed', () => {
    if (chatWin && !chatWin.isDestroyed()) chatWin.webContents.send('generation-history:changed');
});

// Return the auto-determined working folder to renderer
ipcMain.handle('get-working-folder', () => getWorkingFolder());
ipcMain.handle('get-hub-files-folder', () => getHubFilesFolder());
ipcMain.handle('get-upscale-inbox-folder', () => getUpscaleInboxFolder());
ipcMain.handle('get-user-data-path', () => app.getPath('userData'));
ipcMain.handle('open-external-link', async (event, rawUrl) => {
    try {
        const url = new URL(String(rawUrl || ''));
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
        await shell.openExternal(url.href);
        return true;
    } catch (error) {
        return false;
    }
});

ipcMain.on('hotkey:capture-start', (event, payload = {}) => {
    capturingHotkeyId = typeof payload.id === 'string' ? payload.id : null;
});

ipcMain.on('hotkey:capture-stop', (event, payload = {}) => {
    if (!payload.id || capturingHotkeyId === payload.id) capturingHotkeyId = null;
});

ipcMain.on('register-shortcut', (event, payload = {}) => {
    const id = typeof payload.id === 'string' ? payload.id : '';
    const binding = typeof payload.binding === 'string' ? payload.binding : '';
    const accelerator = typeof payload.accelerator === 'string' ? payload.accelerator : '';
    if (!id || !binding) {
        sendShortcutResult(event.sender, id, false, 'Некорректный бинд.');
        return;
    }

    const type = /(?:^|\+)Mouse(?:Middle|4|5)$/.test(binding) ? 'mouse' : 'keyboard';
    const conflict = [...registeredShortcuts.entries()].find(([otherId, shortcut]) => (
        otherId !== id && shortcut.binding.toLowerCase() === binding.toLowerCase()
    ));
    if (conflict) {
        sendShortcutResult(event.sender, id, false, 'Этот бинд уже назначен другому действию.');
        return;
    }

    const current = registeredShortcuts.get(id);
    if (current && current.type === type && current.binding === binding &&
        (type === 'mouse' || current.accelerator === accelerator)) {
        sendShortcutResult(event.sender, id, true);
        return;
    }

    if (type === 'mouse') {
        if (!startGlobalMouseHook()) {
            sendShortcutResult(event.sender, id, false, 'Глобальные кнопки мыши недоступны.');
            return;
        }
        unregisterShortcutById(id);
        registeredShortcuts.set(id, { type, binding });
        sendShortcutResult(event.sender, id, true);
        return;
    }

    if (!accelerator) {
        sendShortcutResult(event.sender, id, false, 'Клавиша не поддерживается системой.');
        return;
    }

    let registered = false;
    try {
        registered = globalShortcut.register(accelerator, () => {
            const target = shortcutTargetWindow();
            if (target) target.webContents.send('shortcut-triggered', id);
        });
    } catch (error) {
        sendShortcutResult(event.sender, id, false, error.message || 'Не удалось зарегистрировать бинд.');
        return;
    }

    if (!registered) {
        sendShortcutResult(event.sender, id, false, 'Бинд занят Windows или другой программой.');
        return;
    }

    unregisterShortcutById(id);
    registeredShortcuts.set(id, { type, binding, accelerator });
    sendShortcutResult(event.sender, id, true);
});

ipcMain.on('unregister-shortcut', (event, payload = {}) => {
    const id = typeof payload === 'string' ? payload : payload.id;
    if (registeredShortcuts.has(id)) {
        unregisterShortcutById(id);
        return;
    }

    // Compatibility with renderer data saved by older versions.
    if (typeof payload === 'string') {
        const legacyEntry = [...registeredShortcuts.entries()].find(([, shortcut]) => shortcut.accelerator === payload);
        if (legacyEntry) unregisterShortcutById(legacyEntry[0]);
    }
});


// =====================================================================
// MOCKUP SERVER — hidden child process, starts with the application
// =====================================================================
function startMockupService() {
    if (mockupProcess) return;

    let scriptPath = path.join(__dirname, 'mockup_server.py');
    if (!fs.existsSync(scriptPath)) scriptPath = path.join(process.resourcesPath, 'mockup_server.py');
    if (!fs.existsSync(scriptPath)) {
        console.log('[Mockup] mockup_server.py not found — mockup library is disabled');
        return;
    }

    console.log('[Mockup] Starting hidden server...');
    mockupProcess = spawn('python', [scriptPath], {
        cwd: path.dirname(scriptPath),
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
        env: { ...process.env }
    });
    mockupProcess.stdout.on('data', data => {
        const message = data.toString().trim();
        if (message) console.log('[Mockup] ' + message);
    });
    mockupProcess.stderr.on('data', data => {
        const message = data.toString().trim();
        if (message) console.log('[Mockup:err] ' + message);
    });
    mockupProcess.on('close', code => {
        console.log('[Mockup] Exited with code ' + code);
        mockupProcess = null;
    });
    mockupProcess.on('error', error => {
        console.log('[Mockup] Failed: ' + error.message);
        mockupProcess = null;
    });
}

function stopMockupService() {
    if (!mockupProcess) return;
    console.log('[Mockup] Stopping...');
    try {
        if (process.platform === 'win32') {
            execSync('taskkill /pid ' + mockupProcess.pid + ' /T /F', { timeout: 5000 });
        } else {
            mockupProcess.kill('SIGKILL');
        }
    } catch (error) {
        try { mockupProcess.kill(); } catch (ignore) {}
    }
    mockupProcess = null;
}

// =====================================================================
// HUB SERVICE — auto-start as child process
// =====================================================================
function startHubService() {
    if (hubProcess) return;

    let hubPath = path.join(__dirname, 'mini-services', 'hub-service');
    if (!fs.existsSync(path.join(hubPath, 'index.js')) && !fs.existsSync(path.join(hubPath, 'index.ts'))) {
        hubPath = path.join(process.resourcesPath, 'mini-services', 'hub-service');
    }

    const indexJS = path.join(hubPath, 'index.js');
    const indexTS = path.join(hubPath, 'index.ts');
    let command, args;

    // Prefer the ready JavaScript entry in both development and packaged builds.
    // Starting TypeScript through npx creates a detached process chain on Windows,
    // so an old Hub can survive an application restart and keep stale handlers.
    if (fs.existsSync(indexJS)) {
        command = 'node';
        args = [indexJS];
    } else if (!app.isPackaged && fs.existsSync(indexTS)) {
        command = process.platform === 'win32' ? 'npx.cmd' : 'npx';
        args = ['tsx', 'index.ts'];
    } else {
        console.log('[Hub] hub-service not found — chat features disabled');
        return;
    }

    launchHub(command, args, hubPath);
}

function launchHub(command, args, cwd) {
    console.log(`[Hub] Starting: ${command} ${args.join(' ')}`);

    const needsShell = process.platform === 'win32' && /\.cmd$/i.test(command);

    hubProcess = spawn(command, args, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        // Only .cmd launchers need a shell. A direct node process remains our
        // child and can be stopped reliably together with the application.
        shell: needsShell,
        windowsHide: true,
        env: { ...process.env, CFB_HUB_FILES_DIR: getHubFilesFolder() }
    });

    hubProcess.stdout.on('data', (data) => {
        const msg = data.toString().trim();
        if (msg) console.log(`[Hub] ${msg}`);
    });
    hubProcess.stderr.on('data', (data) => {
        const msg = data.toString().trim();
        if (msg) console.log(`[Hub:err] ${msg}`);
    });
    hubProcess.on('close', (code) => {
        console.log(`[Hub] Exited with code ${code}`);
        hubProcess = null;
    });
    hubProcess.on('error', (err) => {
        console.log(`[Hub] Failed: ${err.message}`);
        hubProcess = null;
    });
}

function stopHubService() {
    if (!hubProcess) return;
    console.log('[Hub] Stopping...');

    try {
        // On Windows: kill the entire process tree (hub + any child node processes)
        if (process.platform === 'win32') {
            execSync(`taskkill /pid ${hubProcess.pid} /T /F`, { timeout: 5000 });
        } else {
            hubProcess.kill('SIGKILL');
        }
    } catch (e) {
        // taskkill might fail if process already dead — that's OK
        try { hubProcess.kill(); } catch(e2) {}
    }
    hubProcess = null;
}

// =====================================================================
// App lifecycle
// =====================================================================
app.whenReady().then(() => {
    configureSpellChecker();
    session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
        const isComfyUI = details.url.includes(':8188') && details.url.startsWith('http://');
        if (isComfyUI) {
            const targetOrigin = details.url.split('/').slice(0, 3).join('/');
            details.requestHeaders['Origin'] = targetOrigin;
            details.requestHeaders['Referer'] = targetOrigin + '/';
            // Requests originate from a local file:// Electron page, so Chromium
            // marks them as cross-site. Current ComfyUI rejects such state-changing
            // requests with 403 before /upload/image or /prompt can run.
            details.requestHeaders['Sec-Fetch-Site'] = 'same-origin';
        }
        callback({ requestHeaders: details.requestHeaders });
    });

    getUpscaleInboxFolder();
    getHubFilesFolder();
    startHubService();
    startMockupService();
    createWindow();
    startGlobalMouseHook();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

// Force quit on all windows closed (no hanging)
app.on('window-all-closed', () => {
    unregisterAllAppShortcuts();
    stopGlobalMouseHook();
    stopHubService();
    stopMockupService();
    app.quit();
});

// Extra safety: force quit after 3s if app hasn't quit yet
app.on('before-quit', () => {
    isQuitting = true;
    unregisterAllAppShortcuts();
    stopGlobalMouseHook();
    stopHubService();
    stopMockupService();
});
