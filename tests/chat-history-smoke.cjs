const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-chat-history-'));
const workingFolder = path.join(temporary, 'download');
const generationsFolder = path.join(workingFolder, 'Generations');
fs.mkdirSync(generationsFolder, { recursive: true });
fs.writeFileSync(path.join(generationsFolder, 'history-sample.png'), Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64'
));
const patternFolder = path.join(generationsFolder,'Patterns','test-run');
fs.mkdirSync(patternFolder,{recursive:true});
const patternPath = path.join(patternFolder,'element_001_x4.png');
fs.copyFileSync(path.join(generationsFolder,'history-sample.png'),patternPath);
fs.writeFileSync(path.join(patternFolder,'pattern.json'),JSON.stringify({assets:[{name:'Цветок',kind:'element',upscaledPath:patternPath}]}));

app.setPath('userData', path.join(temporary, 'profile'));
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
    const win = new BrowserWindow({
        show: false,
        width: 440,
        height: 800,
        webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false, offscreen: true }
    });
    win.webContents.on('console-message', event => console.error('[renderer]', event.message));
    try {
        const html = fs.readFileSync(path.join(root, 'chat.html'), 'utf8').replace('<script src="chat_renderer.js"></script>', '');
        const htmlPath = path.join(temporary, 'chat.html');
        fs.writeFileSync(htmlPath, html);
        await win.loadFile(htmlPath);
        await win.webContents.executeJavaScript(`
            window.__errors = [];
            window.addEventListener('error', event => __errors.push(event.message));
            window.addEventListener('unhandledrejection', event => __errors.push(String(event.reason)));
            const actualRequire = require;
            const root = ${JSON.stringify(root)};
            const workingFolder = ${JSON.stringify(workingFolder)};
            const listeners = {};
            window.__ipcRendererMock = {
                send: () => {},
                on: (channel, listener) => { listeners[channel] = listener; },
                invoke: async channel => channel === 'get-working-folder' ? workingFolder : ''
            };
            const fakeSocket = { connected:false, on:() => fakeSocket, emit:() => {}, connect:() => {} };
            window.require = name => {
                if (name === 'electron') return { ipcRenderer: window.__ipcRendererMock };
                if (name === 'socket.io-client') return { io: () => fakeSocket };
                return actualRequire(name.startsWith('./') ? root + '/' + name.slice(2) : name);
            };
            localStorage.clear();
            localStorage.setItem('nickname', 'UI test');
            localStorage.setItem('chatActiveView', 'activity');
        `);
        await win.webContents.executeJavaScript(fs.readFileSync(path.join(root, 'chat_renderer.js'), 'utf8'));
        await new Promise(resolve => setTimeout(resolve, 100));
        const result = await win.webContents.executeJavaScript(`(() => {
            const drawer = document.querySelector('.generation-history-drawer');
            const card = document.querySelector('.generation-history-card');
            if (!drawer || !card) throw new Error('Generated image is missing from existing History tab');
            if (document.querySelectorAll('.generation-history-card').length !== 2) throw new Error('Final pattern assets are missing from the existing History tab');
            card.click();
            if (document.getElementById('imageViewer').classList.contains('hidden')) throw new Error('Fullscreen preview did not open');
            if (__errors.length) throw new Error(__errors.join('; '));
            return { cards: document.querySelectorAll('.generation-history-card').length, preview: true };
        })()`);
        console.log('Chat history smoke passed:', JSON.stringify(result));
        await win.close();
        app.quit();
    } catch (error) {
        console.error(error);
        app.exit(1);
    }
});
