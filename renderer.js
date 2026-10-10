const { ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const psBridge = require('./ps_bridge');
const patternPipeline = require('./pattern_pipeline');
const comfyBridge = require('./comfy_bridge');
const workflows = require('./workflows');
const qwen = require('./qwen_workflows');
const krea2 = require('./krea2_config');
const krea2Loras = require('./krea2_loras');
const editWorkflows = require('./edit_workflows');
const modelLabel = model => model === 'qwen21' ? 'Qwen' : model === 'krea2' ? 'Krea 2' : 'Turbo';
const selectedImageModel = select => ['qwen21', 'krea2', 'turbo'].includes(select?.value) ? select.value : 'turbo';
// Socket.io — optional, app works without hub connection
let io = null;
try { const module = require('socket.io-client'); io = module.io; } catch(e) { console.log("socket.io-client not available — hub features disabled"); }

const statusBar = document.getElementById("statusBar");
function setStatusBar(message) { if(statusBar) statusBar.textContent = message; }
setStatusBar("ComfyFloatBar загружен");

// =====================================================================
// АВТООЧИСТКА временных мокапов при запуске
// =====================================================================
try {
    const tempDir = os.tmpdir();
    const files = fs.readdirSync(tempDir);
    files.forEach(file => {
        if (file.includes(' - ') && file.endsWith('.psd') && !file.startsWith('comfy_') && !file.startsWith('ps_')) {
            fs.unlinkSync(path.join(tempDir, file));
        }
        if (file.startsWith('[ComfyMockup] ') && file.endsWith('.psd')) {
            fs.unlinkSync(path.join(tempDir, file));
        }
        if (/__Mockup_\d+__(?:AI|LIB)(?:_.*)?\.(?:psd|png)$/i.test(file)) {
            fs.unlinkSync(path.join(tempDir, file));
        }
    });
} catch (e) { console.error("Очистка Temp не удалась:", e); }

// =====================================================================
// 0. SETUP WIZARD — First-time setup (nickname only, no skip, no folder)
// =====================================================================
const setupOverlay = document.getElementById('setupOverlay');
const setupNickname = document.getElementById('setupNickname');
const setupStartBtn = document.getElementById('setupStartBtn');

// Show wizard on first launch (no nickname saved yet) — MUST enter nickname
if (!localStorage.getItem('nickname')) {
    setupOverlay.classList.remove('hidden');
}

// Enable "Start" button when nickname is entered
setupNickname.addEventListener('input', () => {
    setupStartBtn.classList.toggle('disabled', setupNickname.value.trim().length === 0);
});

// "Start" button — save nickname, connect to chat, close wizard
setupStartBtn.addEventListener('click', () => {
    const nick = setupNickname.value.trim();
    if (!nick) return;
    localStorage.setItem('nickname', nick);
    setupOverlay.classList.add('hidden');
    // Send nickname to hub
    if (hubSocket && hubSocket.connected) hubSocket.emit('user:join', nick);
    // Send nickname to chat window (via IPC relay)
    ipcRenderer.send('chat:send-nickname', nick);
    // Auto-open chat window so notifications work immediately
    ipcRenderer.send('chat:toggle');
    setStatusBar("✓ " + nick + ", добро пожаловать!");
    setTimeout(() => setStatusBar("ComfyFloatBar загружен"), 3000);
});

// Enter key in nickname field
setupNickname.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && setupNickname.value.trim().length > 0) setupStartBtn.click();
});

// =====================================================================
// 0b. AUTO-DETERMINE WORKING FOLDER — no user selection needed
// Results saved in download/ folder directly next to exe (portable)
// =====================================================================
let workingFolder = localStorage.getItem('workingFolder') || '';
if (!workingFolder) {
    // Ask main process for the auto-determined folder
    ipcRenderer.invoke('get-working-folder').then(folder => {
        if (folder) {
            workingFolder = folder;
            localStorage.setItem('workingFolder', folder);
        }
    });
}

// =====================================================================
// 1. TITLE BAR — Window Controls + Chat Icon
// =====================================================================
document.getElementById('btnMinimize').addEventListener('click', () => ipcRenderer.send('window:minimize'));
document.getElementById('btnMaximize').addEventListener('click', () => ipcRenderer.send('window:maximize'));
document.getElementById('btnClose').addEventListener('click', () => ipcRenderer.send('window:close'));
const photoshopPinButton = document.getElementById('btnPhotoshopPin');
let photoshopIsRunning = false;
photoshopPinButton.addEventListener('click', async () => {
    const result = await ipcRenderer.invoke('window:toggle-photoshop-pin');
    if (!result?.ok) setStatusBar(result?.error || 'Сначала сделайте Photoshop активным окном.');
});
ipcRenderer.on('window:photoshop-pin-state', (event, state = {}) => {
    photoshopIsRunning = state.photoshopRunning === true;
    const pinned = state.pinned === true;
    document.body.classList.toggle('photoshop-pinned', pinned);
    photoshopPinButton.classList.toggle('active', pinned);
    photoshopPinButton.disabled = pinned ? false : state.canPin !== true;
    photoshopPinButton.title = pinned ? 'Открепить от Photoshop' : state.canPin ? 'Закрепить за Photoshop' : 'Сделайте Photoshop активным окном';
    document.getElementById('btnMaximize').disabled = pinned;
});

async function isPhotoshopCurrentlyRunning() {
    try {
        const state = await ipcRenderer.invoke('window:get-photoshop-state');
        if (state && typeof state === 'object' && typeof state.photoshopRunning === 'boolean') {
            photoshopIsRunning = state.photoshopRunning;
        }
    } catch (error) {
        console.warn('Не удалось обновить состояние Photoshop:', error.message || error);
    }
    return photoshopIsRunning;
}

// Chat icon — opens/toggles the separate chat window (attached to left)
// Also clears notification dot when chat is opened
document.getElementById('chatIconBtn').addEventListener('click', () => {
    ipcRenderer.send('chat:toggle');
});

// Notification dot: received from chat window via IPC relay
ipcRenderer.on('chat:new-message', () => {
    document.getElementById('notifDot').classList.add('visible');
    document.getElementById('chatIconBtn').classList.add('attention');
});
ipcRenderer.on('chat:clear-notif', () => {
    document.getElementById('notifDot').classList.remove('visible');
    document.getElementById('chatIconBtn').classList.remove('attention');
});
ipcRenderer.on('chat:closed', () => {
    // Chat window was closed/hidden — nothing special needed on main window
});

ipcRenderer.on('main:set-nickname', (event, nickname) => {
    const nextNickname = String(nickname || '').trim();
    if (!nextNickname) return;
    localStorage.setItem('nickname', nextNickname);
    if (hubSocket && hubSocket.connected) hubSocket.emit('user:join', nextNickname);
});

// =====================================================================
// Auto-port: if IP entered without port, add default port automatically
// =====================================================================
const DEFAULT_PORTS = { serverIP: 8188, mockupIP: 8080, hubIP: 3003 };

function ensurePort(fieldId) {
    const field = document.getElementById(fieldId);
    if (!field) return;
    const val = field.value.trim();
    if (!val) return;
    if (!val.includes(':')) {
        field.value = val + ':' + DEFAULT_PORTS[fieldId];
    }
}

Object.keys(DEFAULT_PORTS).forEach(id => {
    const field = document.getElementById(id);
    if (field) field.addEventListener('blur', () => ensurePort(id));
});

// =====================================================================
// 2. SOCKET.IO HUB CONNECTION (main window — for task status only)
// =====================================================================
let hubSocket = null;
let hubSupportsTopaz = false;
let isHubConnected = false;
let localTaskStartedAt = 0;
let localComfyStartedAt = 0;
let localTaskType = '';
let hubTaskActive = false;
let hubTask = null;
let hubActiveUsers = [];
let hubSupportsSharedPictureSeries = false;

function connectToHub() {
    if (!io) {
        isHubConnected = false;
        updateConnectionStatus();
        console.log("Hub connection disabled (socket.io-client not installed)");
        return;
    }
    const hubIP = document.getElementById('hubIP').value || '127.0.0.1:3003';
    if (hubSocket) { hubSocket.disconnect(); hubSocket = null; }
    hubSupportsSharedPictureSeries = false;

    hubSocket = io(`http://${hubIP}`, { reconnection: true, reconnectionDelay: 2000, reconnectionDelayMax: 10000 });

    hubSocket.on('connect', () => {
        isHubConnected = true;
        updateConnectionStatus();
        // Send nickname if we have one (chat window manages nickname)
        const nick = localStorage.getItem('nickname') || '';
        if (nick) hubSocket.emit('user:join', nick);
        hubSocket.emit('topaz:list', {}, answer => { if (answer?.ok) topazPanel?.render(answer.result); });
        // Register our service IPs with the hub (admin's machine sends ComfyUI/Mockup IPs)
        const comfyVal = document.getElementById('serverIP').value;
        const mockupVal = document.getElementById('mockupIP').value;
        if (comfyVal || mockupVal) {
            hubSocket.emit('service:register', { comfyIP: comfyVal, mockupIP: mockupVal });
        }
    });

    hubSocket.on('topaz:state', state => topazPanel?.render(state));
    hubSocket.on('disconnect', () => {
        isHubConnected = false;
        hubSupportsSharedPictureSeries = false;
        updateConnectionStatus();
    });

    hubSocket.on('hub:capabilities', data => {
        hubSupportsSharedPictureSeries = Boolean(data && data.pictureSeriesCounter);
        hubSupportsTopaz = Boolean(data && data.topazQueue);
    });

    hubSocket.on('users:update', (data) => {
        hubActiveUsers = Array.isArray(data && data.list) ? data.list : [];
        document.getElementById('userCountText').textContent = data.count;
        refreshUpscaleRecipients();
        hubSocket.emit('topaz:list', {}, answer => { if (answer?.ok) topazPanel?.render(answer.result); });
        updateConnectionStatus();
    });

    hubSocket.on('picture-series:state', data => {
        hubSupportsSharedPictureSeries = true;
        const received = Math.floor(Number(data && data.lastNumber));
        if (!Number.isSafeInteger(received) || received < THREE_RESULT_SERIES_INITIAL_NUMBER) return;
        const stored = Number.parseInt(localStorage.getItem(THREE_RESULT_SERIES_COUNTER_KEY) || '', 10);
        if (!Number.isSafeInteger(stored) || received > stored) {
            localStorage.setItem(THREE_RESULT_SERIES_COUNTER_KEY, String(received));
        }
    });

    hubSocket.on('upscale:incoming', receiveUpscaleFile);

    hubSocket.on('task:status', (task) => {
        hubTask = task || null;
        hubTaskActive = Boolean(hubTask);
        refreshTaskInfoText();
        updateConnectionStatus();
    });

    // Hub sends admin's service IPs — auto-fill fields for colleagues
    hubSocket.on('hub:service-ips', (data) => {
        console.log("Received service IPs from hub:", data);
        if (data.comfyIP) {
            document.getElementById('serverIP').value = data.comfyIP;
            console.log("✓ ComfyUI IP auto-filled from hub:", data.comfyIP);
        }
        if (data.mockupIP) {
            document.getElementById('mockupIP').value = data.mockupIP;
            console.log("✓ Mockup IP auto-filled from hub:", data.mockupIP);
        }
        // Restart health check with new IP
        startComfyHealthCheck();
        setStatusBar("✓ ComfyUI & Mockup IP обновлены");
        setTimeout(() => setStatusBar("ComfyFloatBar загружен"), 3000); // auto-clear after 3s
    });

    hubSocket.on('connect_error', () => {
        isHubConnected = false;
        updateConnectionStatus();
    });
}

// =====================================================================
// ComfyUI Health Check — periodic ping to determine connection status
// =====================================================================
let isComfyConnected = false;
let comfyCheckInterval = null;

async function checkComfyConnection() {
    const ip = document.getElementById('serverIP').value || '127.0.0.1:8188';
    try {
        const res = await fetch(`http://${ip}/system_stats`, { signal: AbortSignal.timeout(5000) });
        if (res.ok) {
            isComfyConnected = true;
        } else {
            isComfyConnected = false;
        }
    } catch (e) {
        isComfyConnected = false;
    }
    updateConnectionStatus();
}

function startComfyHealthCheck() {
    if (comfyCheckInterval) clearInterval(comfyCheckInterval);
    checkComfyConnection(); // immediate first check
    comfyCheckInterval = setInterval(checkComfyConnection, 10000); // every 10s
}

function updateConnectionStatus() {
    const indicator = document.getElementById('statusIndicator');
    const taskInfo = document.getElementById('taskInfoText');
    const lastModel = document.getElementById('lastModelText');
    const onlineIndicator = document.getElementById('onlineIndicator');
    const onlineCount = document.getElementById('onlineCount');

    // ComfyUI indicator — just the dot/hourglass, no text label
    if (hubTaskActive || isTaskRunning) {
        indicator.className = 'status-indicator working';
        indicator.textContent = '⏳';
        // While a task is active, leave only the orange task status beside the hourglass.
        if (lastModel) lastModel.classList.add('hidden');
    } else if (isComfyConnected) {
        indicator.className = 'status-indicator connected';
        indicator.textContent = ''; // green dot is enough
        if (lastModel) lastModel.classList.remove('hidden');
    } else {
        indicator.className = 'status-indicator disconnected';
        indicator.textContent = ''; // red dot is enough
        if (lastModel) lastModel.classList.remove('hidden');
    }

    // Online indicator — person bust + count, green when hub connected
    if (isHubConnected) {
        const count = document.getElementById('userCountText')?.textContent || '0';
        if (onlineCount) onlineCount.textContent = count;
        if (onlineIndicator) onlineIndicator.classList.add('connected');
    } else {
        if (onlineCount) onlineCount.textContent = '0';
        if (onlineIndicator) onlineIndicator.classList.remove('connected');
    }
}

function setLastLoadedModel(modelName) {
    const name = String(modelName || '').trim() || '—';
    const label = document.getElementById('lastModelText');
    if (label) {
        label.textContent = 'Модель: ' + name;
        label.title = 'Последняя использованная модель: ' + name;
    }
    if (name !== '—') localStorage.setItem('lastLoadedModel', name);
}

function rememberWorkflowModel(workflow, fallbackName) {
    const nodes = Object.values(workflow || {}).filter(node => node && node.inputs);
    let value = '';
    for (const key of ['unet_name', 'ckpt_name']) {
        for (const node of nodes) {
            if (typeof node.inputs[key] === 'string' && node.inputs[key].trim()) {
                value = node.inputs[key].trim();
                break;
            }
        }
        if (value) break;
    }
    if (!value) {
        for (const node of nodes) {
            if (typeof node.inputs.model_name === 'string' && node.inputs.model_name.trim()) {
                value = node.inputs.model_name.trim();
                break;
            }
        }
    }
    const normalized = value.toLowerCase();
    if (normalized.includes('qwen_image_2.1')) return setLastLoadedModel('Qwen');
    if (normalized.includes('seedvr2')) return setLastLoadedModel('SeedVR2');
    if (normalized.includes('klein') || normalized.includes('flux-2')) return setLastLoadedModel('Flux 2 Klein 9B');
    if (normalized.includes('krea2')) return setLastLoadedModel('Krea 2');
    if (normalized.includes('z_image') || normalized.includes('z-image') || normalized.includes('turbo')) return setLastLoadedModel('Turbo');
    if (normalized.includes('biref')) return setLastLoadedModel('BiRefNet');
    if (normalized.includes('flux')) return setLastLoadedModel('Flux Fill');
    setLastLoadedModel(fallbackName || (value ? path.basename(value).replace(/\.(safetensors|ckpt|gguf)$/i, '') : 'ComfyUI'));
}

setLastLoadedModel((localStorage.getItem('lastLoadedModel') || '—').replace(/^Qwen.*$/i, 'Qwen'));

function getExpandPixels(id) {
    const field = document.getElementById(id);
    const entered = Number(field && field.value);
    const value = Number.isFinite(entered) ? Math.max(0, Math.round(entered)) : 0;
    if (field && Number(field.value) !== value) field.value = String(value);
    return value;
}
['expandLeft', 'expandTop', 'expandRight', 'expandBottom'].forEach(id => {
    const field = document.getElementById(id);
    if (field) field.addEventListener('input', () => getExpandPixels(id));
});

// Task type translation for display
function translateTaskType(type) {
    const map = {
        'enh_auto': 'Улучшение',
        'enh_custom': 'Улучшение',
        'enh_inpaint': 'Изменить объект',
        'enh_image': 'Улучшить картинку',
        'enh_image_auto': 'Авто-улучшение документа',
        'enh_combine': 'Совместить картинки',
        'rmbg': 'RemoveBG',
        'gen_normal': 'Генерация',
        'gen_pattern': 'Паттерн',
        'gen_krea2': 'Krea 2',
        'gen_turbo': 'Turbo',
        'gen_qwen21': 'Qwen',
        'img2img': 'Img2Img',
        'img2img_krea2': 'Krea 2 Img2Img',
        'img2img_turbo': 'Turbo Img2Img',
        'img2img_qwen21': 'Qwen Img2Img',
        'gen_variations_turbo': 'Turbo — 3 вариации',
        'gen_variations_krea2': 'Krea 2 — 3 вариации',
        'gen_triptych_turbo': 'Turbo — триптих',
        'gen_triptych_krea2': 'Krea 2 — триптих',
        'mockup_ai': 'AI Мокап',
        'uxui_web': 'UX/UI — веб-сайт',
        'uxui_app': 'UX/UI — приложение',
        'uxui_game': 'UX/UI — игра',
        'uxui_icon': 'UX/UI — иконки',
        'aplus_basic': 'A+ Content — Basic',
        'aplus_premium': 'A+ Content — Premium',
        'aplus_single': 'A+ Content — модуль',
        'mockup_library': 'Мокап',
        'expand': 'Расширение',
        'vector': 'Вектор',
        'seedvr2_upscale': 'SeedVR2 Upscale',
        'seedvr2_batch_upscale': 'SeedVR2 — все видимые слои'
    };
    return map[type] || type || 'Задача';
}

function formatTaskElapsed(milliseconds) {
    const seconds = Math.max(0, Math.floor(milliseconds / 1000));
    const minutes = Math.floor(seconds / 60);
    const restSeconds = seconds % 60;
    return minutes ? minutes + ' мин ' + restSeconds + ' с' : restSeconds + ' с';
}

function refreshTaskInfoText() {
    const taskInfo = document.getElementById('taskInfoText');
    if (!taskInfo) return;
    if (!hubTask || !hubTask.startedAt) {
        taskInfo.textContent = '';
        taskInfo.classList.add('hidden');
        return;
    }
    taskInfo.textContent = String(hubTask.nickname || 'Участник') + ': ' +
        translateTaskType(hubTask.taskType) + ' (' + formatTaskElapsed(Date.now() - Number(hubTask.startedAt)) + ')';
    taskInfo.classList.remove('hidden');
}

setInterval(() => {
    if (hubTask) refreshTaskInfoText();
}, 1000);

// =====================================================================
// 3. UI BLOCKING (when task is running)
// =====================================================================
let isTaskRunning = false;
const cancelBtn = document.getElementById('cancelBtn');
let activePatternController = null;
let activePatternPromptId = null;
let lastVariationGenerationInfo = null;
let lastEnhanceAutoInfo = null;
let lastUXUIInfo = null;
let lastAPlusInfo = null;
let lastRemoveBackgroundInfo = null;

const actionBtnIds = ['btn_enhance_load', 'btn_enhance_clear_mask', 'btn_enhance_apply', 'btn_enhance_image_from_selection', 'btn_enhance_image_apply', 'btn_enhance_image_auto', 'btn_enhance_combine_first_from_selection', 'btn_enhance_combine_second_from_selection', 'btn_enhance_combine_apply', 'btn_rmbg', 'btn_gen', 'btn_img2img', 'btn_generate_variations', 'btn_variation_from_selection', 'btn_expand', 'btn_upscale', 'btn_upscale_from_selection', 'btn_ai_upscale', 'btn_ai_upscale_from_layer', 'btn_ai_upscale_all_visible', 'btn_ai_upscale_from_selection', 'btn_vector', 'btn_vector_from_selection', 'btn_gen_mockup', 'btn_img2img_from_selection', 'btn_uxui_generate', 'btn_uxui_from_photoshop', 'btn_aplus_generate', 'btn_aplus_from_photoshop'];

function lockUI(taskType) {
    document.querySelectorAll('.qwen-step-slider, #qwenPrecision, #qwenDetailLoraEnabled, #qwenDetailLoraStrength, #krea2Model, #krea2LoraEnabled, #krea2Lora, #krea2LoraStrength').forEach(field => { field.disabled = true; });
    document.getElementById('btn_free_models').disabled = true;
    ['enhanceModel', 'enhanceColorEnabled', 'enhanceColorMethod', 'slider_enh_color'].forEach(id => { document.getElementById(id).disabled = true; });
    localComfyStartedAt = 0;
    isTaskRunning = true;
    actionBtnIds.forEach(id => {
        const btn = document.getElementById(id);
        if (btn) btn.classList.add('disabled');
    });
    cancelBtn.classList.add('visible');
    if (hubSocket && hubSocket.connected) hubSocket.emit('task:start', { taskType });
    updateConnectionStatus();
}

function markComfyProcessingStarted() {
    localComfyStartedAt = Date.now();
}

function getActivityFieldValue(id) {
    const field = document.getElementById(id);
    return field && typeof field.value !== 'undefined' ? String(field.value).trim() : '';
}

function addActivityMetadata(metadata, label, value) {
    if (value !== undefined && value !== null && String(value).trim() !== '') {
        metadata[label] = String(value).trim();
    }
}

function collectActivityMetadata() {
    const metadata = {
        'Код операции': localTaskType,
        'Действие': translateTaskType(localTaskType),
        'Статус': 'Успешно'
    };

    if (['gen_krea2', 'gen_turbo', 'gen_qwen21'].includes(localTaskType)) {
        addActivityMetadata(metadata, 'Режим', 'Text to Image');
        addActivityMetadata(metadata, 'Модель', modelLabel(localTaskType.replace('gen_', '')));
        addActivityMetadata(metadata, 'Промт', getActivityFieldValue('promptInput'));
        addActivityMetadata(metadata, 'Формат', getKreaAspectRatio().label);
        addActivityMetadata(metadata, 'Мегапиксели', getActivityFieldValue('slider_krea_megapixels') + ' MP');
        addActivityMetadata(metadata, 'Seed', getActivityFieldValue('kreaSeed'));
        addActivityMetadata(metadata, 'Prompt Enhance', document.getElementById('kreaPromptEnhance')?.checked ? 'Да' : 'Нет');
        addActivityMetadata(metadata, 'Бесшовный паттерн', document.getElementById('genSeamlessPattern')?.checked ? 'Да' : 'Нет');
    } else if (['img2img_krea2', 'img2img_turbo', 'img2img_qwen21'].includes(localTaskType)) {
        addActivityMetadata(metadata, 'Режим', 'Image to Image');
        addActivityMetadata(metadata, 'Модель', modelLabel(localTaskType.replace('img2img_', '')));
        addActivityMetadata(metadata, 'Промт', getActivityFieldValue('img2imgPrompt'));
        addActivityMetadata(metadata, 'Формат', getImg2ImgAspectRatio().label);
        addActivityMetadata(metadata, 'Мегапиксели', getActivityFieldValue('slider_img2img_megapixels') + ' MP');
        addActivityMetadata(metadata, 'Seed', getActivityFieldValue('img2imgSeed'));
        addActivityMetadata(metadata, 'Prompt Enhance', document.getElementById('img2imgPromptEnhance')?.checked ? 'Да' : 'Нет');
        addActivityMetadata(metadata, 'Бесшовный паттерн', document.getElementById('img2imgSeamlessPattern')?.checked ? 'Да' : 'Нет');
        if (typeof img2imgSelectedImagePath !== 'undefined' && img2imgSelectedImagePath) {
            addActivityMetadata(metadata, 'Исходный файл', path.basename(img2imgSelectedImagePath));
        }
        if (lastImg2ImgInputInfo) {
            addActivityMetadata(metadata, 'Исходный размер', lastImg2ImgInputInfo.originalWidth + ' × ' + lastImg2ImgInputInfo.originalHeight + ' px');
            addActivityMetadata(metadata, 'Размер для ComfyUI', lastImg2ImgInputInfo.width + ' × ' + lastImg2ImgInputInfo.height + ' px' + (lastImg2ImgInputInfo.reduced ? ' (до 1 MP)' : ' (уменьшение не требуется)'));
        }
    } else if (localTaskType && /^gen_(variations|triptych)_(turbo|krea2)$/.test(localTaskType)) {
        const isTriptych = localTaskType.includes('triptych');
        addActivityMetadata(metadata, 'Режим', isTriptych ? 'Триптих → 3 картины' : '1 → 3 вариации');
        addActivityMetadata(metadata, 'Модель', localTaskType.endsWith('krea2') ? 'Krea 2' : 'Turbo');
        addActivityMetadata(metadata, 'Дополнительный prompt', getActivityFieldValue('variationPrompt') || '—');
        addActivityMetadata(metadata, 'Формат', getVariationAspectRatio().label);
        addActivityMetadata(metadata, 'Мегапиксели результата', getActivityFieldValue('slider_variation_megapixels') + ' MP');
        addActivityMetadata(metadata, 'Базовый seed', getActivityFieldValue('variationSeed'));
        if (!isTriptych) addActivityMetadata(metadata, 'Сходство с оригиналом', getActivityFieldValue('slider_variation_similarity') + '%');
        addActivityMetadata(metadata, 'Исходный файл', variationSelectedSourceName || (variationSelectedImagePath ? path.basename(variationSelectedImagePath) : '—'));
        addActivityMetadata(metadata, 'Вход ComfyUI', lastVariationGenerationInfo ? lastVariationGenerationInfo.inputSize : 'до 1 MP');
        addActivityMetadata(metadata, 'Количество результатов', lastVariationGenerationInfo ? lastVariationGenerationInfo.resultCount : 3);
        addActivityMetadata(metadata, 'Серия файлов', lastVariationGenerationInfo ? lastVariationGenerationInfo.seriesName : null);
        addActivityMetadata(metadata, 'Нумерация серии', lastVariationGenerationInfo ? lastVariationGenerationInfo.seriesNumberMode : '—');
        addActivityMetadata(metadata, 'Файлы', lastVariationGenerationInfo ? lastVariationGenerationInfo.resultFiles.join(', ') : null);
        addActivityMetadata(metadata, 'Итоговые размеры', lastVariationGenerationInfo ? lastVariationGenerationInfo.resultSizes.join(', ') : '—');
    } else if (localTaskType === 'enh_inpaint' || localTaskType === 'enh_object') {
        addActivityMetadata(metadata, 'Промт', getActivityFieldValue('enhancePrompt'));
        addActivityMetadata(metadata, 'Источник', 'Выделение Photoshop + маска');
        addActivityMetadata(metadata, 'Модель', 'Qwen');
    } else if (localTaskType === 'enh_image_auto') {
        const selectedPreset = document.getElementById('enhanceImagePromptPreset');
        addActivityMetadata(metadata, 'Промт', getActivityFieldValue('enhanceImagePrompt'));
        addActivityMetadata(metadata, 'Пресет', selectedPreset && selectedPreset.selectedOptions.length ? selectedPreset.selectedOptions[0].textContent : 'Свой prompt');
        addActivityMetadata(metadata, 'Источник', lastEnhanceAutoInfo ? lastEnhanceAutoInfo.documentName : 'Активный документ Photoshop');
        addActivityMetadata(metadata, 'Размер документа', lastEnhanceAutoInfo ? lastEnhanceAutoInfo.documentWidth + ' × ' + lastEnhanceAutoInfo.documentHeight + ' px' : '—');
        addActivityMetadata(metadata, 'Размер тайла', lastEnhanceAutoInfo ? lastEnhanceAutoInfo.tileSize + ' px' : '—');
        addActivityMetadata(metadata, 'Нахлёст', lastEnhanceAutoInfo ? lastEnhanceAutoInfo.overlap + ' px' : '—');
        addActivityMetadata(metadata, 'Фейд маски', getEnhanceEdgeFadePercent() + '%');
        addActivityMetadata(metadata, 'Тайлов', lastEnhanceAutoInfo ? lastEnhanceAutoInfo.completed + ' / ' + lastEnhanceAutoInfo.total : '—');
        addActivityMetadata(metadata, 'Модель', 'Qwen 9B');
    } else if (localTaskType === 'enh_image') {
        addActivityMetadata(metadata, 'Промт', getActivityFieldValue('enhanceImagePrompt'));
        addActivityMetadata(metadata, 'Источник', enhanceImageSlot && enhanceImageSlot.sourceName ? enhanceImageSlot.sourceName : 'Изображение');
        addActivityMetadata(metadata, 'Модель', 'Qwen 9B');
    } else if (localTaskType === 'enh_combine') {
        addActivityMetadata(metadata, 'Промт', getActivityFieldValue('enhanceCombinePrompt'));
        addActivityMetadata(metadata, 'Первая картинка', enhanceCombineFirstSlot && enhanceCombineFirstSlot.sourceName ? enhanceCombineFirstSlot.sourceName : '—');
        addActivityMetadata(metadata, 'Вторая картинка', enhanceCombineSecondSlot && enhanceCombineSecondSlot.sourceName ? enhanceCombineSecondSlot.sourceName : '—');
        addActivityMetadata(metadata, 'Модель', 'Qwen 9B');
    } else if (localTaskType && /^aplus_(basic|premium|single)$/.test(localTaskType)) {
        const info = lastAPlusInfo || {};
        addActivityMetadata(metadata, 'Стандарт', info.standardLabel || '—');
        addActivityMetadata(metadata, 'Режим', info.modeLabel || '—');
        addActivityMetadata(metadata, 'Модель', modelLabel(info.model));
        addActivityMetadata(metadata, 'Товар', info.productName || '—');
        addActivityMetadata(metadata, 'Категория', info.category || '—');
        addActivityMetadata(metadata, 'Аудитория', info.audience || '—');
        addActivityMetadata(metadata, 'Преимущества', info.benefits || '—');
        addActivityMetadata(metadata, 'Материалы и факты', info.facts || '—');
        addActivityMetadata(metadata, 'Барьеры покупателя', info.objections || '—');
        addActivityMetadata(metadata, 'Стиль бренда', info.brandDirection || '—');
        addActivityMetadata(metadata, 'Язык copy-плана', info.languageLabel || '—');
        addActivityMetadata(metadata, 'Референс', info.referenceName || '—');
        addActivityMetadata(metadata, 'Вход ComfyUI', info.inputSize || 'до 1 MP');
        addActivityMetadata(metadata, 'Размер модуля', info.width && info.height ? info.width + ' × ' + info.height + ' px' : '—');
        addActivityMetadata(metadata, 'Количество модулей', info.completed + ' / ' + info.total);
        addActivityMetadata(metadata, 'Prompt Enhance', 'Да (Amazon A+ art director)');
        addActivityMetadata(metadata, 'Папка комплекта', info.packageFolder || '—');
        addActivityMetadata(metadata, 'Файлы', info.files && info.files.length ? info.files.join(', ') : '—');    } else if (localTaskType && /^uxui_(web|app|game|icon)$/.test(localTaskType)) {
        const info = lastUXUIInfo || {};
        addActivityMetadata(metadata, 'Раздел', info.modeLabel || (localTaskType === 'uxui_web' ? 'Веб-сайт' : localTaskType === 'uxui_app' ? 'Приложение' : localTaskType === 'uxui_game' ? 'Игра' : 'Иконки'));
        addActivityMetadata(metadata, 'Режим', info.referenceName ? 'Image to Image' : 'Text to Image');
        addActivityMetadata(metadata, 'Модель', modelLabel(info.model));
        addActivityMetadata(metadata, 'Задача пользователя', info.userPrompt || 'Автоматический концепт');
        addActivityMetadata(metadata, 'Тип интерфейса', info.productLabel || '—');
        addActivityMetadata(metadata, 'Платформа / экран', info.platformLabel || '—');
        addActivityMetadata(metadata, 'Визуальный стиль', info.styleLabel || '—');
        addActivityMetadata(metadata, 'Тема', info.themeLabel || '—');
        addActivityMetadata(metadata, 'Формат результата', info.outputLabel || '—');
        addActivityMetadata(metadata, 'Плотность', info.densityLabel || '—');
        addActivityMetadata(metadata, 'Язык интерфейса', info.languageLabel || '—');
        addActivityMetadata(metadata, 'Соотношение сторон', info.aspectLabel || '—');
        addActivityMetadata(metadata, 'Мегапиксели', info.megapixels ? info.megapixels + ' MP' : '—');
        addActivityMetadata(metadata, 'Seed', info.seed || '—');
        addActivityMetadata(metadata, 'Prompt Enhance', 'Да (UX/UI art director)');
        addActivityMetadata(metadata, 'Референс', info.referenceName || 'Без референса');
        addActivityMetadata(metadata, 'Вход ComfyUI', info.inputSize || '—');
        addActivityMetadata(metadata, 'Итоговый размер', info.resultSize || '—');
        addActivityMetadata(metadata, 'Файл результата', info.outputName ? info.outputName + '.png' : '—');
        if (localTaskType === 'uxui_icon') {
            addActivityMetadata(metadata, 'Стиль иконки', info.iconStyleLabel || '—');
            addActivityMetadata(metadata, 'Количество иконок', info.iconCount || 1);
            addActivityMetadata(metadata, 'Форма', info.iconShapeLabel || '—');
            addActivityMetadata(metadata, 'Фон', info.iconBackgroundLabel || '—');
            addActivityMetadata(metadata, 'Сохранённые PNG', info.outputFiles && info.outputFiles.length ? info.outputFiles.join(', ') : '—');
        }
    } else if (localTaskType === 'mockup_ai') {
        const mockupInfo = lastMockupAiInfo;
        const isArtworkMockup = mockupInfo ? mockupInfo.mockupKind === 'artwork' : getMockupAiKind() === 'artwork';
        const labels = mockupInfo && mockupInfo.optionLabels ? mockupInfo.optionLabels : {};
        addActivityMetadata(metadata, 'Модель', mockupInfo ? (mockupInfo.model === 'krea2' ? 'Krea 2' : 'Turbo') : (mockupAiModelSelect && mockupAiModelSelect.value === 'krea2' ? 'Krea 2' : 'Turbo'));
        addActivityMetadata(metadata, 'Тип AI-мокапа', isArtworkMockup ? 'Картины' : 'Обои');
        addActivityMetadata(metadata, 'Формат', mockupInfo ? mockupInfo.aspectRatioLabel : getMockupAiAspectRatio().label);
        addActivityMetadata(metadata, 'Мегапиксели', (mockupInfo ? mockupInfo.megapixels : getActivityFieldValue('slider_mockup_ai_megapixels')) + ' MP');
        addActivityMetadata(metadata, 'Seed', mockupInfo ? mockupInfo.seed : getActivityFieldValue('mockupAiSeed'));
        addActivityMetadata(metadata, 'Prompt Enhance', isArtworkMockup ? 'Да (анализ картины)' : 'Да (палитра дизайна)');
        addActivityMetadata(metadata, 'Авто-промт', mockupInfo ? mockupInfo.prompt : getMockupAutoPrompt());
        addActivityMetadata(metadata, 'Дополнительный prompt', mockupInfo ? mockupInfo.additionalPrompt : getMockupAdditionalPrompt());
        addActivityMetadata(metadata, 'Файл результата', lastMockupOutputStem ? lastMockupOutputStem + '.png' : '—');
        if (isArtworkMockup) {
            addActivityMetadata(metadata, 'Количество картин', mockupInfo && mockupInfo.artCount === 3 ? '3' : '1');
            addActivityMetadata(metadata, 'Помещение', labels.room || getMockupChoiceLabel('mockupArtRoom'));
            addActivityMetadata(metadata, 'Стиль интерьера', labels.interiorStyle || getMockupChoiceLabel('mockupArtInteriorStyle'));
            addActivityMetadata(metadata, 'Размещение', labels.placement || getMockupChoiceLabel(getMockupArtworkPlacementId()));
            addActivityMetadata(metadata, 'Рама', labels.frame || getMockupChoiceLabel('mockupArtFrame'));
            addActivityMetadata(metadata, 'Паспарту', labels.mat || getMockupChoiceLabel('mockupArtMat'));
            addActivityMetadata(metadata, 'Пропорции', labels.orientation || getMockupChoiceLabel('mockupArtOrientation'));
            addActivityMetadata(metadata, 'Камера', labels.camera || getMockupChoiceLabel('mockupArtCamera'));
            addActivityMetadata(metadata, 'Освещение', labels.lighting || getMockupChoiceLabel('mockupArtLighting'));
        } else {
            addActivityMetadata(metadata, 'Режим стены', 'Белая стена, палитра из дизайна');
            addActivityMetadata(metadata, 'Тип комнаты', labels.room || getMockupChoiceLabel('mockupRoom'));
            addActivityMetadata(metadata, 'Стиль интерьера', labels.interiorStyle || getMockupChoiceLabel('mockupInteriorStyle'));
            addActivityMetadata(metadata, 'Композиция мокапа', labels.composition || getMockupChoiceLabel('mockupComposition'));
            addActivityMetadata(metadata, 'Ракурс стены', labels.wallAngle || getMockupChoiceLabel('mockupWallAngle'));
        }
    } else if (localTaskType === 'mockup_library') {
        addActivityMetadata(metadata, 'Исходный дизайн', lastDesignName || '—');
        addActivityMetadata(metadata, 'Шаблон Library PSD', lastMockupTemplateName || '—');
        addActivityMetadata(metadata, 'Документ Photoshop', lastMockupDocName || '—');
        addActivityMetadata(metadata, 'Будущий PNG', lastMockupOutputStem ? lastMockupOutputStem + '.png' : '—');
    } else if (localTaskType === 'rmbg') {
        const rmbgOptions = getRemoveBackgroundOptions();
        addActivityMetadata(metadata, 'Модель удаления фона', getRemoveBackgroundModelName(rmbgOptions));
        addActivityMetadata(metadata, 'Источник', 'Выделенная область Photoshop');
        addActivityMetadata(metadata, 'Режим края', rmbgOptions.presetLabel);
        addActivityMetadata(metadata, 'Очистка края', rmbgOptions.cleanup + '%');
        addActivityMetadata(metadata, 'Сохранение деталей', rmbgOptions.detail + '%');
        addActivityMetadata(metadata, 'Расширение края', rmbgOptions.edgeExpand + ' px');
        addActivityMetadata(metadata, 'Цветной ореол', rmbgOptions.decontaminate ? 'Удалять' : 'Не обрабатывать');
        if (lastRemoveBackgroundInfo) {
            addActivityMetadata(metadata, 'Размер входа', lastRemoveBackgroundInfo.width + '×' + lastRemoveBackgroundInfo.height + ' px');
            addActivityMetadata(metadata, 'Обработка маски', lastRemoveBackgroundInfo.fallback
                ? 'Базовая резервная модель'
                : (lastRemoveBackgroundInfo.tiled ? 'Двухуровневая тайловая' : 'Один проход'));
        }
    } else if (localTaskType === 'expand') {
        addActivityMetadata(metadata, 'Промт', getActivityFieldValue('expandPrompt'));
        addActivityMetadata(metadata, 'Слева', getActivityFieldValue('expandLeft') + ' px');
        addActivityMetadata(metadata, 'Сверху', getActivityFieldValue('expandTop') + ' px');
        addActivityMetadata(metadata, 'Справа', getActivityFieldValue('expandRight') + ' px');
        addActivityMetadata(metadata, 'Снизу', getActivityFieldValue('expandBottom') + ' px');
    } else if (localTaskType === 'seedvr2_upscale' || localTaskType === 'seedvr2_batch_upscale') {
        addActivityMetadata(metadata, 'Модель', 'SeedVR2');
        if (localTaskType === 'seedvr2_batch_upscale') {
            addActivityMetadata(metadata, 'Режим', 'Автоматически — все видимые слои');
            addActivityMetadata(metadata, 'Увеличение', '×' + (lastSeedvr2BatchInfo ? lastSeedvr2BatchInfo.factor : 4));
            addActivityMetadata(metadata, 'Найдено слоёв', lastSeedvr2BatchInfo ? lastSeedvr2BatchInfo.total : '—');
            addActivityMetadata(metadata, 'Успешно обработано', lastSeedvr2BatchInfo ? lastSeedvr2BatchInfo.completed : '—');
            addActivityMetadata(metadata, 'Пропущено / ошибки', lastSeedvr2BatchInfo ? lastSeedvr2BatchInfo.failed.length : '—');
            addActivityMetadata(metadata, 'Обработанные слои', lastSeedvr2BatchInfo && lastSeedvr2BatchInfo.results.length
                ? lastSeedvr2BatchInfo.results.map(item => item.name + ' → ' + item.size).join('; ')
                : '—');
            addActivityMetadata(metadata, 'Ошибки слоёв', lastSeedvr2BatchInfo && lastSeedvr2BatchInfo.failed.length
                ? lastSeedvr2BatchInfo.failed.join('; ')
                : '—');
        } else {
            addActivityMetadata(metadata, 'Увеличение', '×' + (lastSeedvr2UpscaleInfo ? lastSeedvr2UpscaleInfo.factor : 4));
            addActivityMetadata(metadata, 'Источник', lastSeedvr2UpscaleInfo ? lastSeedvr2UpscaleInfo.sourceName : 'Изображение');
            addActivityMetadata(metadata, 'Исходный размер', lastSeedvr2UpscaleInfo ? lastSeedvr2UpscaleInfo.originalWidth + ' × ' + lastSeedvr2UpscaleInfo.originalHeight + ' px' : '—');
            addActivityMetadata(metadata, 'Размер для ComfyUI', lastSeedvr2UpscaleInfo ? lastSeedvr2UpscaleInfo.width + ' × ' + lastSeedvr2UpscaleInfo.height + ' px (1 MP)' : '1 MP');
            addActivityMetadata(metadata, 'Итоговый размер', lastSeedvr2UpscaleInfo && lastSeedvr2UpscaleInfo.resultWidth
                ? lastSeedvr2UpscaleInfo.resultWidth + ' × ' + lastSeedvr2UpscaleInfo.resultHeight + ' px'
                : '—');
        }    } else if (localTaskType === 'vector') {
        const vectorSettings = getVectorizerSettings();
        addActivityMetadata(metadata, 'Выходной формат', 'SVG');
        addActivityMetadata(metadata, 'Источник', vectorSelectedImagePath ? (vectorSelectedImageName || 'Загруженное изображение') : 'Активный слой Photoshop');
        addActivityMetadata(metadata, 'Режим Vectorizer', vectorSettings.mode === 'stable' ? 'Stable' : 'Quantized');
        addActivityMetadata(metadata, 'Цветов палитры', vectorSettings.colors);
        addActivityMetadata(metadata, 'Ограничение источника', 'до ' + vectorSettings.maxMegapixels + ' MP');
    }
    return metadata;
}

function recordCompletedActivity() {
    const completedSuccessfully = statusBar && String(statusBar.textContent || '').indexOf('✓') === 0;
    if (completedSuccessfully && localTaskType && hubSocket && hubSocket.connected) {
        const completedAt = Date.now();
        const comfyStartedAt = localComfyStartedAt || localTaskStartedAt;
        if (comfyStartedAt) {
            hubSocket.emit('activity:add', {
                action: translateTaskType(localTaskType),
                taskType: localTaskType,
                durationMs: Math.max(0, completedAt - comfyStartedAt),
                totalDurationMs: Math.max(0, completedAt - localTaskStartedAt),
                startedAt: localTaskStartedAt,
                comfyStartedAt,
                completedAt,
                metadata: collectActivityMetadata()
            });
        }
    }
    localTaskStartedAt = 0;
    localComfyStartedAt = 0;
    localTaskType = '';
}

function unlockUI() {
    recordCompletedActivity();
    isTaskRunning = false;
    document.querySelectorAll('.qwen-step-slider, #qwenPrecision, #qwenDetailLoraEnabled, #qwenDetailLoraStrength, #krea2Model, #krea2LoraEnabled, #krea2Lora, #krea2LoraStrength').forEach(field => { field.disabled = false; });
    document.getElementById('btn_free_models').disabled = false;
    ['enhanceModel', 'enhanceColorEnabled', 'enhanceColorMethod', 'slider_enh_color'].forEach(id => { document.getElementById(id).disabled = false; });
    actionBtnIds.forEach(id => {
        const btn = document.getElementById(id);
        if (btn) btn.classList.remove('disabled');
    });
    // These actions need an existing painted mask; keep their availability accurate after any task.
    if (typeof enhanceHasMask !== 'undefined' && !enhanceHasMask) {
        const clearMask = document.getElementById('btn_enhance_clear_mask');
        const applyEnhance = document.getElementById('btn_enhance_apply');
        if (clearMask) clearMask.classList.add('disabled');
        if (applyEnhance) applyEnhance.classList.add('disabled');
    }
    cancelBtn.classList.remove('visible');
    if (hubSocket && hubSocket.connected) hubSocket.emit('task:complete');
    updateConnectionStatus();
}

cancelBtn.addEventListener('click', async () => {
    try {
        const ip = document.getElementById('serverIP').value || '127.0.0.1:8188';
        setStatusBar("Отмена...");
        if (activePatternController) activePatternController.abort();
        comfyBridge.abortPolling();
        if (activePatternPromptId) {
            await fetch(`http://${ip}/queue`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({delete:[activePatternPromptId]})});
        }
        await comfyBridge.interruptComfy(ip);
        if (hubSocket && hubSocket.connected) hubSocket.emit('task:cancel');
        if (activePatternController) return; // Release the lock after the pipeline stops advancing.
        unlockUI();
        setStatusBar("✓ Отменено.");
    } catch (error) {
        setStatusBar("Ошибка отмены: " + (error.message || error));
        if (activePatternController) return;
        unlockUI();
    }
});

document.getElementById('btn_free_models').addEventListener('click', async () => {
    if (isTaskRunning) return;
    // Own the local task lock until the request completes; do not cancel a server job.
    lockUI('free_models');
    cancelBtn.classList.remove('visible');
    try {
        setStatusBar('⏳ Запрос на освобождение памяти ComfyUI...');
        await comfyBridge.freeMemory(document.getElementById('serverIP').value || '127.0.0.1:8188');
        localStorage.removeItem('lastLoadedModel');
        setLastLoadedModel('—');
        setStatusBar('✓ Запрос на выгрузку моделей и очистку кэша принят ComfyUI.');
    } catch (error) {
        setStatusBar('Ошибка: ' + (error.message || error));
    } finally { unlockUI(); }
});

// =====================================================================
// 4. TASK TIMER — Update elapsed time every second
// =====================================================================


// =====================================================================
// 5. Аккордеон
// =====================================================================
function toggleSection(headerElement) {
    const targetId = headerElement.getAttribute('data-target');
    const content = document.getElementById(targetId);
    const arrow = headerElement.querySelector('.arrow');
    if (headerElement.classList.contains('tool-header')) {
        document.querySelectorAll('.tool-header').forEach(h => {
            if (h !== headerElement && !document.getElementById(h.getAttribute('data-target')).classList.contains('hidden')) {
                document.getElementById(h.getAttribute('data-target')).classList.add('hidden');
                h.querySelector('.arrow').textContent = '▲';
                h.classList.remove('is-open');
            }
        });
    }
    if (content.classList.contains('hidden')) {
        content.classList.remove('hidden'); arrow.textContent = '▼'; headerElement.classList.toggle('is-open', headerElement.classList.contains('tool-header'));
    }
    else { content.classList.add('hidden'); arrow.textContent = '▲'; headerElement.classList.remove('is-open'); }
    queueMicrotask(refreshStickyAction);
}
document.querySelectorAll('.tool-header, .sub-tool-header').forEach(header => header.addEventListener('click', () => toggleSection(header)));
document.querySelectorAll('.tool-header').forEach(header => { document.getElementById(header.getAttribute('data-target')).classList.add('hidden'); header.querySelector('.arrow').textContent = '▲'; header.classList.remove('is-open'); });

const stickyActionRow = document.getElementById('stickyActionRow');
const stickyActionBtn = document.getElementById('stickyActionBtn');
let stickyActionSource = null;
const stickyActions = {
    sec_enh: ['btn_enhance_image_apply','btn_enhance_apply','btn_enhance_combine_apply'],
    sec_rmbg: ['btn_rmbg'],
    sec_gen: ['btn_gen','btn_img2img','btn_generate_variations'],
    sec_uxui: ['btn_uxui_generate'], sec_aplus: ['btn_aplus_generate'],
    sec_expand: ['btn_expand'], sec_upscale: ['btn_upscale','btn_ai_upscale'],
    sec_vector: ['btn_vector'], sec_mock: ['btn_gen_mockup']
};
Object.values(stickyActions).flat().forEach(id => document.getElementById(id)?.classList.add('sticky-action-source'));
function elementIsVisible(element) {
    return Boolean(element && !element.closest('.hidden') && element.getClientRects().length);
}
function refreshStickyAction() {
    const active = Array.from(document.querySelectorAll('.tool-content')).find(content => !content.classList.contains('hidden'));
    const ids = active ? stickyActions[active.id] || [] : [];
    stickyActionSource = ids.map(id => document.getElementById(id)).find(elementIsVisible) || null;
    stickyActionRow.classList.toggle('hidden', !stickyActionSource);
    if (!stickyActionSource) return;
    const label = stickyActionSource.textContent.trim();
    const disabled = stickyActionSource.disabled || stickyActionSource.classList.contains('disabled');
    const className = 'full-btn ' + (stickyActionSource.classList.contains('cta') ? 'cta' : '');
    if (stickyActionBtn.textContent !== label) stickyActionBtn.textContent = label;
    if (stickyActionBtn.disabled !== disabled) stickyActionBtn.disabled = disabled;
    if (stickyActionBtn.className !== className) stickyActionBtn.className = className;
}
stickyActionBtn.addEventListener('click', () => {
    refreshStickyAction();
    if (stickyActionSource && !stickyActionBtn.disabled) stickyActionSource.click();
});
document.addEventListener('change', () => queueMicrotask(refreshStickyAction));
document.addEventListener('click', () => queueMicrotask(refreshStickyAction));
new MutationObserver(refreshStickyAction).observe(document.body, { subtree:true, attributes:true, attributeFilter:['class','disabled'] });
refreshStickyAction();

// =====================================================================
// 6. Ползунки
// =====================================================================
const KREA_ASPECT_RATIOS = [
    { value: '1:1 (Square)', label: '1:1', ratio: 1 },
    { value: '2:3 (Portrait Photo)', label: '2:3', ratio: 2 / 3 },
    { value: '3:2 (Photo)', label: '3:2', ratio: 3 / 2 },
    { value: '3:4 (Portrait Standard)', label: '3:4', ratio: 3 / 4 },
    { value: '4:3 (Standard)', label: '4:3', ratio: 4 / 3 },
    { value: '9:16 (Portrait Widescreen)', label: '9:16', ratio: 9 / 16 },
    { value: '16:9 (Widescreen)', label: '16:9', ratio: 16 / 9 },
    { value: '21:9 (Ultrawide)', label: '21:9', ratio: 21 / 9 }
];

function getKreaAspectRatio() {
    const index = Math.round(Number(getUiVal('slider_krea_aspect')));
    return KREA_ASPECT_RATIOS[index] || KREA_ASPECT_RATIOS[6];
}

function updateKreaResolutionHint() {
    const hint = document.getElementById('kreaResolutionHint');
    if (!hint) return;
    const aspect = getKreaAspectRatio();
    const megapixels = Number(getUiVal('slider_krea_megapixels')) || 3;
    const totalPixels = megapixels * 1000000;
    const width = Math.round(Math.sqrt(totalPixels * aspect.ratio) / 8) * 8;
    const height = Math.round(Math.sqrt(totalPixels / aspect.ratio) / 8) * 8;
    hint.textContent = `≈ ${width} × ${height} px`;
}

function getImg2ImgAspectRatio() {
    const index = Math.round(Number(getUiVal('slider_img2img_aspect')));
    return KREA_ASPECT_RATIOS[index] || KREA_ASPECT_RATIOS[6];
}

function updateImg2ImgResolutionHint() {
    const hint = document.getElementById('img2imgResolutionHint');
    if (!hint) return;
    const aspect = getImg2ImgAspectRatio();
    const megapixels = Number(getUiVal('slider_img2img_megapixels')) || 3;
    const totalPixels = megapixels * 1000000;
    const width = Math.round(Math.sqrt(totalPixels * aspect.ratio) / 8) * 8;
    const height = Math.round(Math.sqrt(totalPixels / aspect.ratio) / 8) * 8;
    hint.textContent = `≈ ${width} × ${height} px`;
}

function getVariationAspectRatio() {
    const index = Math.round(Number(getUiVal('slider_variation_aspect')));
    return KREA_ASPECT_RATIOS[index] || KREA_ASPECT_RATIOS[1];
}

function updateVariationResolutionHint() {
    const hint = document.getElementById('variationResolutionHint');
    if (!hint) return;
    const aspect = getVariationAspectRatio();
    const megapixels = Number(getUiVal('slider_variation_megapixels')) || 1;
    const totalPixels = megapixels * 1000000;
    const width = Math.round(Math.sqrt(totalPixels * aspect.ratio) / 8) * 8;
    const height = Math.round(Math.sqrt(totalPixels / aspect.ratio) / 8) * 8;
    hint.textContent = '≈ ' + width + ' × ' + height + ' px на каждую картину';
}

function getMockupAiAspectRatio() {
    const index = Math.round(Number(getUiVal('slider_mockup_ai_aspect')));
    return KREA_ASPECT_RATIOS[index] || KREA_ASPECT_RATIOS[6];
}

function updateMockupAiResolutionHint() {
    const hint = document.getElementById('mockupAiResolutionHint');
    if (!hint) return;
    const aspect = getMockupAiAspectRatio();
    const megapixels = Number(getUiVal('slider_mockup_ai_megapixels')) || 3;
    const totalPixels = megapixels * 1000000;
    const width = Math.round(Math.sqrt(totalPixels * aspect.ratio) / 8) * 8;
    const height = Math.round(Math.sqrt(totalPixels / aspect.ratio) / 8) * 8;
    hint.textContent = '≈ ' + width + ' × ' + height + ' px';
}

function getUXUISelectedMode() {
    const selected = document.querySelector('input[name="uxuiMode"]:checked');
    return selected && ['web', 'app', 'game', 'icon'].includes(selected.value) ? selected.value : 'web';
}

function getUXUIAspectRatio() {
    const mode = getUXUISelectedMode();
    if (mode === 'icon') return KREA_ASPECT_RATIOS[0];
    const output = getActivityFieldValue('uxuiOutput') || 'single';
    if (output !== 'single') return KREA_ASPECT_RATIOS[6];
    if (mode === 'web') return getActivityFieldValue('uxuiWebViewport') === 'mobile' ? KREA_ASPECT_RATIOS[5] : KREA_ASPECT_RATIOS[6];
    if (mode === 'app') {
        const platform = getActivityFieldValue('uxuiAppPlatform');
        if (platform === 'desktop') return KREA_ASPECT_RATIOS[6];
        if (platform === 'tablet') return KREA_ASPECT_RATIOS[4];
        return KREA_ASPECT_RATIOS[5];
    }
    const platform = getActivityFieldValue('uxuiGamePlatform');
    if (platform === 'mobile') return KREA_ASPECT_RATIOS[5];
    if (platform === 'tablet') return KREA_ASPECT_RATIOS[4];
    return KREA_ASPECT_RATIOS[6];
}

function updateUXUIFormatHint() {
    const hint = document.getElementById('uxuiFormatValue');
    if (!hint) return;
    const aspect = getUXUIAspectRatio();
    const megapixels = Number(getActivityFieldValue('slider_uxui_megapixels')) || 2;
    const totalPixels = megapixels * 1000000;
    const width = Math.round(Math.sqrt(totalPixels * aspect.ratio) / 8) * 8;
    const height = Math.round(Math.sqrt(totalPixels / aspect.ratio) / 8) * 8;
    hint.textContent = aspect.label + ' · ≈ ' + width + ' × ' + height + ' px';
}
function setupSlider(sliderId, labelId, formatFn) {
    const slider = document.getElementById(sliderId), label = document.getElementById(labelId);
    if (!slider || !label) return;
    const update = () => label.textContent = formatFn(parseFloat(slider.value));
    slider.addEventListener('input', update); update();
}
const RMBG_PRESET_LABELS = Object.freeze({
    clean: 'Универсальный — чистый край',
    detail: 'Тонкие детали / ветки',
    graphic: 'Графика / жёсткий контур',
    soft: 'Волосы / мех / мягкий край',
    raw: 'Исходная маска BiRefNet'
});

function clampRemoveBackgroundSetting(value, minimum, maximum, fallback) {
    const parsed = Math.round(Number(value));
    return Math.max(minimum, Math.min(maximum, Number.isFinite(parsed) ? parsed : fallback));
}

async function verifyTransparentPng(buffer) {
    const image = new Image();
    await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = () => reject(new Error('Qwen вернул нечитаемый PNG.'));
        image.src = 'data:image/png;base64,' + Buffer.from(buffer).toString('base64');
    });
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 1024 / Math.max(image.naturalWidth, image.naturalHeight));
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let transparent = false;
    let visible = false;
    for (let index = 3; index < pixels.length; index += 4) {
        transparent ||= pixels[index] < 250;
        visible ||= pixels[index] > 5;
        if (transparent && visible) return;
    }
    throw new Error('Qwen не вернул пригодный прозрачный результат. Уточните промпт и повторите генерацию.');
}

function getRemoveBackgroundOptions() {
    const presetField = document.getElementById('rmbgEdgePreset');
    const preset = presetField && RMBG_PRESET_LABELS[presetField.value] ? presetField.value : 'clean';
    const decontaminateField = document.getElementById('rmbgDecontaminate');
    return {
        model: document.getElementById('rmbgModel')?.value || 'birefnet',
        prompt: document.getElementById('rmbgQwenPrompt')?.value.trim() || qwen.REMOVE_BACKGROUND_PROMPT,
        preset,
        presetLabel: RMBG_PRESET_LABELS[preset],
        cleanup: clampRemoveBackgroundSetting(getUiVal('slider_rmbg_cleanup'), 0, 100, 65),
        detail: clampRemoveBackgroundSetting(getUiVal('slider_rmbg_detail'), 0, 100, 65),
        edgeExpand: clampRemoveBackgroundSetting(getUiVal('slider_rmbg_edge_shift'), 0, 3, 0),
        decontaminate: Boolean(decontaminateField && decontaminateField.checked)
    };
}

function initializeRemoveBackgroundControls() {
    const modelField = document.getElementById('rmbgModel');
    const promptField = document.getElementById('rmbgQwenPrompt');
    if (modelField && promptField) {
        modelField.value = localStorage.getItem('rmbgModel') === 'qwen21' ? 'qwen21' : 'birefnet';
        promptField.value = localStorage.getItem('rmbgQwenPrompt') || qwen.REMOVE_BACKGROUND_PROMPT;
        const update = () => {
            document.getElementById('rmbgBiRefSettings').classList.toggle('hidden', modelField.value === 'qwen21');
            document.getElementById('rmbgQwenSettings').classList.toggle('hidden', modelField.value !== 'qwen21');
            localStorage.setItem('rmbgModel', modelField.value);
        };
        modelField.addEventListener('change', update);
        promptField.addEventListener('input', () => localStorage.setItem('rmbgQwenPrompt', promptField.value));
        update();
    }
    const presetField = document.getElementById('rmbgEdgePreset');
    const decontaminateField = document.getElementById('rmbgDecontaminate');
    const savedPreset = localStorage.getItem('rmbgEdgePreset');
    if (presetField) {
        presetField.value = RMBG_PRESET_LABELS[savedPreset] ? savedPreset : 'clean';
        presetField.addEventListener('change', () => localStorage.setItem('rmbgEdgePreset', presetField.value));
    }
    if (decontaminateField) {
        decontaminateField.checked = localStorage.getItem('rmbgDecontaminate') !== 'false';
        decontaminateField.addEventListener('change', () => localStorage.setItem('rmbgDecontaminate', String(decontaminateField.checked)));
    }
}

setupSlider('slider_rmbg_cleanup', 'val_rmbg_cleanup', v => Math.round(v) + '%');
setupSlider('slider_rmbg_detail', 'val_rmbg_detail', v => Math.round(v) + '%');
setupSlider('slider_rmbg_edge_shift', 'val_rmbg_edge_shift', v => Math.max(0, Math.round(v)) + ' px');
initializeRemoveBackgroundControls();
function getEditModel(id = 'enhanceModel') {
    return document.getElementById(id)?.value === 'flux' ? 'flux' : 'qwen21';
}
function getEditModelLabel(id = 'enhanceModel') {
    return getEditModel(id) === 'flux' ? 'FLUX' : 'Qwen';
}
function getColorMatchOptions() {
    return { enabled: document.getElementById('enhanceColorEnabled').checked,
        strength: Number(document.getElementById('slider_enh_color').value) / 100,
        method: document.getElementById('enhanceColorMethod').value };
}
['enhanceModel', 'enhanceColorMethod'].forEach(id => {
    const field = document.getElementById(id);
    const saved = localStorage.getItem(id);
    if (Array.from(field.options).some(option => option.value === saved)) field.value = saved;
    const update = () => {
        localStorage.setItem(id, field.value);
        document.querySelectorAll('.enhance-model-label').forEach(label => { label.textContent = getEditModelLabel(); });
    };
    field.addEventListener('change', update);
    update();
});
const enhanceColorEnabled = document.getElementById('enhanceColorEnabled');
enhanceColorEnabled.checked = localStorage.getItem('enhanceColorEnabled') !== 'false';
enhanceColorEnabled.addEventListener('change', () => localStorage.setItem('enhanceColorEnabled', String(enhanceColorEnabled.checked)));
setupSlider('slider_enh_color', 'val_enh_color', value => Math.round(value) + '%');
const qwenPrecision = document.getElementById('qwenPrecision');
qwenPrecision.value = localStorage.getItem('qwenPrecision') === 'bf16' ? 'bf16' : 'int8';
qwenPrecision.addEventListener('change', () => localStorage.setItem('qwenPrecision', qwenPrecision.value));
const qwenDetailLoraEnabled = document.getElementById('qwenDetailLoraEnabled');
const qwenDetailLoraStrength = document.getElementById('qwenDetailLoraStrength');
qwenDetailLoraEnabled.checked = localStorage.getItem('qwenDetailLoraEnabled') !== 'false';
qwenDetailLoraStrength.value = localStorage.getItem('qwenDetailLoraStrength') || '1';
function updateQwenDetailLoraSettings() {
    document.getElementById('qwenDetailLoraControls').classList.toggle('hidden', !qwenDetailLoraEnabled.checked);
    document.getElementById('qwenDetailLoraStrengthValue').textContent = Number(qwenDetailLoraStrength.value).toFixed(2);
    localStorage.setItem('qwenDetailLoraEnabled', String(qwenDetailLoraEnabled.checked));
    localStorage.setItem('qwenDetailLoraStrength', qwenDetailLoraStrength.value);
}
qwenDetailLoraEnabled.addEventListener('change', updateQwenDetailLoraSettings);
qwenDetailLoraStrength.addEventListener('input', updateQwenDetailLoraSettings);
updateQwenDetailLoraSettings();
const krea2Model = document.getElementById('krea2Model');
krea2Model.value = krea2.normalizeVariant(localStorage.getItem('krea2Model'));
krea2Model.addEventListener('change', () => localStorage.setItem('krea2Model', krea2Model.value));
const krea2LoraEnabled = document.getElementById('krea2LoraEnabled');
const krea2LoraSelect = document.getElementById('krea2Lora');
const krea2LoraStrength = document.getElementById('krea2LoraStrength');
for (const lora of krea2Loras.LORAS) {
    const option = document.createElement('option'); option.value = lora.id; option.textContent = lora.label;
    krea2LoraSelect.appendChild(option);
}
krea2LoraEnabled.checked = localStorage.getItem('krea2LoraEnabled') === 'true';
krea2LoraSelect.value = krea2Loras.find(localStorage.getItem('krea2Lora')).id;
krea2LoraStrength.value = localStorage.getItem('krea2LoraStrength') || String(krea2Loras.find(krea2LoraSelect.value).strength);
function updateKrea2LoraPanel(resetStrength = false) {
    const lora = krea2Loras.find(krea2LoraSelect.value);
    if (resetStrength) krea2LoraStrength.value = String(lora.strength);
    document.getElementById('krea2LoraControls').classList.toggle('hidden', !krea2LoraEnabled.checked);
    document.getElementById('krea2LoraStrengthValue').textContent = Number(krea2LoraStrength.value).toFixed(2);
    const triggerText = lora.trigger ? `Промпт добавится автоматически: ${lora.trigger}.` : 'Дополнительная trigger phrase не требуется.';
    const compatibilityText = lora.baseModel === 'Krea 2' ? '' : ` Внимание: эта LoRA обучена для ${lora.baseModel} и не запускается с Krea 2.`;
    document.getElementById('krea2LoraTrigger').textContent = `${triggerText} ${lora.strengthNote || ''}${compatibilityText}`.trim();
    const previews = document.getElementById('krea2LoraPreviews'); previews.replaceChildren();
    for (const src of lora.previews) {
        const image = document.createElement('img'); image.src = src; image.alt = `Пример ${lora.label}`; image.loading = 'lazy';
        image.addEventListener('click', () => {
            document.getElementById('krea2PreviewImage').src = src;
            document.getElementById('krea2PreviewImage').alt = image.alt;
            document.getElementById('krea2PreviewCaption').textContent = lora.label;
            document.getElementById('krea2PreviewOverlay').classList.remove('hidden');
        });
        previews.appendChild(image);
    }
    const source = lora.civitai ? `Примеры и настройки: Civitai, модель ${lora.civitai}${lora.versionId ? `, версия ${lora.versionId}` : ''}.` : (lora.note || 'Официальные примеры Krea.');
    document.getElementById('krea2LoraSource').textContent = lora.previews.length ? source : `${source} Примеры не подменялись изображениями другой LoRA.`;
    localStorage.setItem('krea2LoraEnabled', String(krea2LoraEnabled.checked));
    localStorage.setItem('krea2Lora', lora.id);
    localStorage.setItem('krea2LoraStrength', krea2LoraStrength.value);
}
krea2LoraEnabled.addEventListener('change', () => updateKrea2LoraPanel());
krea2LoraSelect.addEventListener('change', () => updateKrea2LoraPanel(true));
krea2LoraStrength.addEventListener('input', () => updateKrea2LoraPanel());
updateKrea2LoraPanel();
function closeKrea2Preview() {
    document.getElementById('krea2PreviewOverlay').classList.add('hidden');
    document.getElementById('krea2PreviewImage').removeAttribute('src');
}
document.getElementById('krea2PreviewClose').addEventListener('click', closeKrea2Preview);
document.getElementById('krea2PreviewOverlay').addEventListener('click', event => { if (event.target === event.currentTarget) closeKrea2Preview(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !document.getElementById('krea2PreviewOverlay').classList.contains('hidden')) closeKrea2Preview(); });
function getKrea2LoraOptions() {
    return { enabled:krea2LoraEnabled.checked, id:krea2LoraSelect.value, strength:Number(krea2LoraStrength.value) };
}
document.querySelectorAll('.qwen-step-slider').forEach(field => setupSlider(field.id, 'val_' + field.id, value => Math.round(value)));
function updateQwenStepVisibility() {
    document.querySelectorAll('.qwen-steps').forEach(row => {
        if (row.dataset.qwenFixed === 'true') { row.classList.remove('hidden'); return; }
        const model = document.getElementById(row.dataset.qwenModel)?.value;
        const removal = row.dataset.qwenModel === 'mockupAiModel' && document.getElementById('mockupRemoveWall').checked && getMockupAiKind() === 'wallpaper';
        row.classList.toggle('hidden', model !== 'qwen21' && !removal);
    });
}
// Settings for inactive models remain saved but are hidden.
document.addEventListener('change', updateQwenStepVisibility);
window.addEventListener('DOMContentLoaded', updateQwenStepVisibility);
function getQwenRunOptions() {
    let suffix = 'Enhance';
    if (localTaskType === 'expand') suffix = 'Expand';
    else if (localTaskType === 'rmbg') suffix = 'RemoveBg';
    else if (localTaskType === 'gen_qwen21') suffix = 'Generate';
    else if (localTaskType === 'img2img_qwen21') suffix = 'Img2Img';
    else if (localTaskType === 'mockup_ai') suffix = 'Mockup';
    return {
        precision: qwenPrecision.value,
        steps: Number(document.getElementById('qwenSteps' + suffix).value),
        detailEnhancerEnabled: qwenDetailLoraEnabled.checked,
        detailEnhancerStrength: Number(qwenDetailLoraStrength.value)
    };
}
async function sendWorkflow(ip, workflow) {
    if (hubSupportsTopaz && hubSocket?.connected) {
        const state = await topazRequest('topaz:busy');
        if (state.busy) throw new Error('ПК-обработчик занят Topaz. Дождитесь завершения апскейла.');
    }
    const configured = qwen.configure(workflow, getQwenRunOptions());
    krea2.configure(configured, krea2Model.value);
    krea2Loras.configure(configured, getKrea2LoraOptions());
    return comfyBridge.sendPrompt(ip, configured);
}
setupSlider('slider_enh_denoise', 'val_enh_denoise', v => (v / 100).toFixed(2));
setupSlider('slider_enh_steps', 'val_enh_steps', v => Math.round(v));
setupSlider('slider_enh_lora', 'val_enh_lora', v => ["None", "Detail", "Repair"][v] || "None");
setupSlider('slider_gen_batch', 'val_gen_batch', v => [1, 2, 4][v] || 1);
setupSlider('slider_gen_steps', 'val_gen_steps', v => Math.round(v));
setupSlider('slider_gen_cfg', 'val_gen_cfg', v => (v / 10).toFixed(1));
setupSlider('slider_gen_lora', 'val_gen_lora', v => ["None", "Style A", "Style B"][v] || "None");
setupSlider('slider_img2img_denoise', 'val_img2img_denoise', v => (v / 100).toFixed(2));
setupSlider('slider_img2img_steps', 'val_img2img_steps', v => Math.round(v));
setupSlider('slider_img2img_cfg', 'val_img2img_cfg', v => (v / 10).toFixed(1));
setupSlider('slider_krea_aspect', 'val_krea_aspect', v => (KREA_ASPECT_RATIOS[Math.round(v)] || KREA_ASPECT_RATIOS[6]).label);
setupSlider('slider_krea_megapixels', 'val_krea_megapixels', v => `${Math.round(v)} MP`);
['slider_krea_aspect', 'slider_krea_megapixels'].forEach(id => {
    const slider = document.getElementById(id);
    if (slider) slider.addEventListener('input', updateKreaResolutionHint);
});
updateKreaResolutionHint();
setupSlider('slider_img2img_aspect', 'val_img2img_aspect', v => (KREA_ASPECT_RATIOS[Math.round(v)] || KREA_ASPECT_RATIOS[6]).label);
setupSlider('slider_img2img_megapixels', 'val_img2img_megapixels', v => `${Math.round(v)} MP`);
['slider_img2img_aspect', 'slider_img2img_megapixels'].forEach(id => {
    const slider = document.getElementById(id);
    if (slider) slider.addEventListener('input', updateImg2ImgResolutionHint);
});
updateImg2ImgResolutionHint();
setupSlider('slider_variation_aspect', 'val_variation_aspect', v => (KREA_ASPECT_RATIOS[Math.round(v)] || KREA_ASPECT_RATIOS[1]).label);
setupSlider('slider_variation_megapixels', 'val_variation_megapixels', v => Math.round(v) + ' MP');
setupSlider('slider_variation_similarity', 'val_variation_similarity', v => Math.round(v) + '%');
['slider_variation_aspect', 'slider_variation_megapixels'].forEach(id => {
    const slider = document.getElementById(id);
    if (slider) slider.addEventListener('input', updateVariationResolutionHint);
});
updateVariationResolutionHint();
setupSlider('slider_mockup_ai_aspect', 'val_mockup_ai_aspect', v => (KREA_ASPECT_RATIOS[Math.round(v)] || KREA_ASPECT_RATIOS[6]).label);
setupSlider('slider_mockup_ai_megapixels', 'val_mockup_ai_megapixels', v => Math.round(v) + ' MP');
['slider_mockup_ai_aspect', 'slider_mockup_ai_megapixels'].forEach(id => {
    const slider = document.getElementById(id);
    if (slider) slider.addEventListener('input', updateMockupAiResolutionHint);
});
updateMockupAiResolutionHint();
setupSlider('slider_uxui_megapixels', 'val_uxui_megapixels', v => Math.round(v) + ' MP');
setupSlider('slider_aplus_megapixels', 'val_aplus_megapixels', v => Math.round(v) + ' MP');
const uxuiMegapixelsSlider = document.getElementById('slider_uxui_megapixels');
if (uxuiMegapixelsSlider) uxuiMegapixelsSlider.addEventListener('input', updateUXUIFormatHint);
updateUXUIFormatHint();
setupSlider('slider_seedvr2_scale', 'val_seedvr2_scale', v => '×' + Math.round(v));

// =====================================================================
// 7. Настройки — Persistence
// =====================================================================
const serverIPInput = document.getElementById("serverIP");
const mockupIPInput = document.getElementById("mockupIP");
const hubIPInput = document.getElementById("hubIP");
if (localStorage.getItem("serverIP")) serverIPInput.value = localStorage.getItem("serverIP");
if (localStorage.getItem("mockupIP")) mockupIPInput.value = localStorage.getItem("mockupIP");
if (localStorage.getItem("hubIP")) hubIPInput.value = localStorage.getItem("hubIP");
serverIPInput.addEventListener("input", () => { localStorage.setItem("serverIP", serverIPInput.value); startComfyHealthCheck(); });
mockupIPInput.addEventListener("input", () => localStorage.setItem("mockupIP", mockupIPInput.value));
hubIPInput.addEventListener("input", () => {
    localStorage.setItem("hubIP", hubIPInput.value);
    connectToHub();
    ipcRenderer.send('chat:update-hub-ip', hubIPInput.value);
});

const GEMINI_ENHANCER_MODELS = Array.from(document.getElementById('geminiEnhancerModel').options, option => option.value);
const GEMINI_API_KEY = process.env.CFB_GEMINI_API_KEY || '';
const geminiEnhancerModelSelect = document.getElementById('geminiEnhancerModel');
if (geminiEnhancerModelSelect) {
    const savedGeminiModel = localStorage.getItem('geminiEnhancerModel');
    geminiEnhancerModelSelect.value = GEMINI_ENHANCER_MODELS.includes(savedGeminiModel)
        ? savedGeminiModel
        : 'gemini-3.1-flash-lite';
    geminiEnhancerModelSelect.addEventListener('change', () => {
        localStorage.setItem('geminiEnhancerModel', geminiEnhancerModelSelect.value);
    });
}

function getGeminiEnhancerModel() {
    const selected = geminiEnhancerModelSelect && geminiEnhancerModelSelect.value;
    return GEMINI_ENHANCER_MODELS.includes(selected) ? selected : 'gemini-3.1-flash-lite';
}

function getConfiguredGeminiApiKey() {
    return GEMINI_API_KEY;
}

function applyGeminiEnhancerModel(workflow) {
    const model = getGeminiEnhancerModel();
    const fallbackApiKey = getConfiguredGeminiApiKey();
    for (const node of Object.values(workflow || {})) {
        if (!node || node.class_type !== 'IFGeminiNode') continue;
        node.inputs = node.inputs || {};
        node.inputs.model_name = model;
        if (fallbackApiKey) node.inputs.external_api_key = fallbackApiKey;
    }
    return workflow;
}

const genModelSelect = document.getElementById('genModel');
function updateGenerationModelSettings() {
    const model = genModelSelect ? genModelSelect.value : 'turbo';
    const label = modelLabel(model);
    const title = document.getElementById('genModelSettingsTitle');
    if (title) title.textContent = `Параметры ${label}`;
    const generateButton = document.getElementById('btn_gen');
    if (generateButton && !isGenMode('img2img')) {
        generateButton.textContent = `Generate ${label}`;
    }
}

if (genModelSelect) {
    const savedModel = localStorage.getItem('genModel');
    if (['qwen21', 'krea2', 'turbo'].includes(savedModel)) genModelSelect.value = savedModel;
    else if (savedModel === 'zimage') genModelSelect.value = 'turbo';
    updateGenerationModelSettings();
    genModelSelect.addEventListener('change', () => {
        localStorage.setItem('genModel', genModelSelect.value);
        updateGenerationModelSettings(); loadTextModelControls();
    });
}

const kreaSeedInput = document.getElementById('kreaSeed');
if (kreaSeedInput) {
    const savedSeed = localStorage.getItem(`textSeed_${genModelSelect.value}`);
    const workflowSeed = getTextWorkflowForSelectedModel()['30:3'].inputs.seed;
    kreaSeedInput.value = savedSeed || String(workflowSeed);
    kreaSeedInput.addEventListener('input', () => localStorage.setItem(`textSeed_${genModelSelect.value}`, kreaSeedInput.value.trim()));
}
const kreaPromptEnhance = document.getElementById('kreaPromptEnhance');
if (kreaPromptEnhance) {
    const savedPromptEnhance = localStorage.getItem(`textPromptEnhance_${genModelSelect.value}`);
    if (savedPromptEnhance !== null) kreaPromptEnhance.checked = savedPromptEnhance === 'true';
    kreaPromptEnhance.addEventListener('change', () => localStorage.setItem(`textPromptEnhance_${genModelSelect.value}`, String(kreaPromptEnhance.checked)));
}

function getTextWorkflowForSelectedModel() {
    return genModelSelect && genModelSelect.value === 'krea2' ? workflows.KREA2_WORKFLOW : workflows.TURBO_WORKFLOW;
}

function loadTextModelControls() {
    const model = selectedImageModel(genModelSelect);
    const workflow = getTextWorkflowForSelectedModel();
    if (kreaSeedInput) kreaSeedInput.value = localStorage.getItem(`textSeed_${model}`) || String(workflow['30:3'].inputs.seed);
    if (kreaPromptEnhance) {
        const savedPromptEnhance = localStorage.getItem(`textPromptEnhance_${model}`);
        kreaPromptEnhance.checked = savedPromptEnhance === null ? Boolean(workflow['30:24'].inputs.value) : savedPromptEnhance === 'true';
    }
}

loadTextModelControls();


const img2imgModelSelect = document.getElementById('img2imgModel');
const img2imgSeedInput = document.getElementById('img2imgSeed');
const img2imgPromptEnhance = document.getElementById('img2imgPromptEnhance');
let lastImg2ImgInputInfo = null;

function getImg2ImgWorkflowForSelectedModel() {
    return img2imgModelSelect && img2imgModelSelect.value === 'krea2' ? workflows.KREA2_IMG2IMG_WORKFLOW : workflows.TURBO_IMG2IMG_WORKFLOW;
}

function loadImg2ImgModelControls() {
    const model = selectedImageModel(img2imgModelSelect);
    const workflow = getImg2ImgWorkflowForSelectedModel();
    if (img2imgSeedInput) img2imgSeedInput.value = localStorage.getItem(`img2imgSeed_${model}`) || String(workflow['30:3'].inputs.seed);
    if (img2imgPromptEnhance) {
        const savedPromptEnhance = localStorage.getItem(`img2imgPromptEnhance_${model}`);
        img2imgPromptEnhance.checked = savedPromptEnhance === null ? Boolean(workflow['30:24'].inputs.value) : savedPromptEnhance === 'true';
    }
    const title = document.getElementById('img2imgModelSettingsTitle');
    if (title) title.textContent = `Параметры ${modelLabel(model)} img2img`;
}

if (img2imgModelSelect) {
    const savedModel = localStorage.getItem('img2imgModel');
    if (['qwen21', 'krea2', 'turbo'].includes(savedModel)) img2imgModelSelect.value = savedModel;
    img2imgModelSelect.addEventListener('change', () => {
        localStorage.setItem('img2imgModel', img2imgModelSelect.value);
        loadImg2ImgModelControls();
    });
}
if (img2imgSeedInput) img2imgSeedInput.addEventListener('input', () => localStorage.setItem(`img2imgSeed_${img2imgModelSelect.value}`, img2imgSeedInput.value.trim()));
if (img2imgPromptEnhance) img2imgPromptEnhance.addEventListener('change', () => localStorage.setItem(`img2imgPromptEnhance_${img2imgModelSelect.value}`, String(img2imgPromptEnhance.checked)));
loadImg2ImgModelControls();

const variationModelSelect = document.getElementById('variationModel');
const variationSeedInput = document.getElementById('variationSeed');
const variationPromptInput = document.getElementById('variationPrompt');
const variationSeriesNumberInput = document.getElementById('variationSeriesNumber');

function getVariationModel() {
    return variationModelSelect && variationModelSelect.value === 'krea2' ? 'krea2' : 'turbo';
}

function getVariationWorkflowForMode(mode) {
    return mode === 'triptych' ? workflows.TRIPTYCH_TO_THREE_WORKFLOW : workflows.THREE_VARIATIONS_WORKFLOW;
}

function updateVariationModelControls() {
    const model = getVariationModel();
    const mode = isGenMode('triptych') ? 'triptych' : 'variations';
    const workflow = getVariationWorkflowForMode(mode);
    const defaultSeed = workflow && workflow['116'] && workflow['116'].inputs ? workflow['116'].inputs.seed : 0;
    const savedSeed = localStorage.getItem('variationSeed_' + model);
    if (variationSeedInput) variationSeedInput.value = savedSeed || String(defaultSeed);
    const title = document.getElementById('variationModelSettingsTitle');
    if (title) title.textContent = 'Параметры ' + (model === 'krea2' ? 'Krea 2' : 'Turbo') + (mode === 'triptych' ? ' · Триптих' : ' · 3 вариации');
}

if (variationModelSelect) {
    const savedModel = localStorage.getItem('variationModel');
    if (['krea2', 'turbo'].includes(savedModel)) variationModelSelect.value = savedModel;
    variationModelSelect.addEventListener('change', () => {
        localStorage.setItem('variationModel', variationModelSelect.value);
        updateVariationModelControls();
    });
}
if (variationSeedInput) variationSeedInput.addEventListener('input', () => localStorage.setItem('variationSeed_' + getVariationModel(), variationSeedInput.value.trim()));
if (variationPromptInput) {
    variationPromptInput.value = localStorage.getItem('variationPrompt') || '';
    variationPromptInput.addEventListener('input', () => localStorage.setItem('variationPrompt', variationPromptInput.value));
}
if (variationSeriesNumberInput) {
    variationSeriesNumberInput.value = localStorage.getItem('variationSeriesNumber') || '';
    variationSeriesNumberInput.addEventListener('input', () => {
        const normalized = variationSeriesNumberInput.value.replace(/[^pP0-9]/g, '');
        if (variationSeriesNumberInput.value !== normalized) variationSeriesNumberInput.value = normalized;
        localStorage.setItem('variationSeriesNumber', normalized);
    });
}
updateVariationModelControls();

const mockupAiModelSelect = document.getElementById('mockupAiModel');
const mockupAiSeedInput = document.getElementById('mockupAiSeed');
const mockupAdditionalPromptInput = document.getElementById('mockupAdditionalPrompt');
const mockupArtAdditionalPromptInput = document.getElementById('mockupArtAdditionalPrompt');

function getMockupAiKind() {
    const selected = document.querySelector('input[name="mockupAiKind"]:checked');
    return selected && selected.value === 'artwork' ? 'artwork' : 'wallpaper';
}

function getMockupArtCount() {
    const selected = document.querySelector('input[name="mockupArtCount"]:checked');
    return selected && selected.value === '3' ? 3 : 1;
}

function updateMockupArtCountUI(count = getMockupArtCount()) {
    const normalizedCount = Number(count) === 3 ? 3 : 1;
    const singlePlacement = document.getElementById('mockupArtSinglePlacement');
    const triplePlacement = document.getElementById('mockupArtTriplePlacement');
    const hint = document.getElementById('mockupArtCountHint');
    if (singlePlacement) singlePlacement.classList.toggle('hidden', normalizedCount !== 1);
    if (triplePlacement) triplePlacement.classList.toggle('hidden', normalizedCount !== 3);
    if (hint) hint.textContent = normalizedCount === 3
        ? 'Подготовьте активный документ Photoshop, где три дизайна расположены слева направо. Будет создан мокап ровно с тремя рамами.'
        : 'Активный документ Photoshop считается одной картиной. Макет будет показан в одной раме.';
    const button = document.getElementById('btn_gen_mockup');
    if (button && getMockupAiKind() === 'artwork') {
        button.textContent = normalizedCount === 3 ? 'Создать мокап: 3 картины' : 'Создать мокап: 1 картина';
    }
}

function setMockupAiKindUI(kind) {
    const normalizedKind = kind === 'artwork' ? 'artwork' : 'wallpaper';
    for (const id of ['mockupRemoveWallControl', 'mockupRemoveWallHint']) {
        const element = document.getElementById(id);
        if (element) element.classList.toggle('hidden', normalizedKind !== 'wallpaper');
    }
    const wallpaperOptions = document.getElementById('mockupWallpaperOptions');
    const artworkOptions = document.getElementById('mockupArtworkOptions');
    const button = document.getElementById('btn_gen_mockup');
    const enhancerHint = document.getElementById('mockupAiPromptEnhanceHint');
    if (wallpaperOptions) wallpaperOptions.classList.toggle('hidden', normalizedKind !== 'wallpaper');
    if (artworkOptions) artworkOptions.classList.toggle('hidden', normalizedKind !== 'artwork');
    if (button) {
        button.textContent = normalizedKind === 'artwork'
            ? (getMockupArtCount() === 3 ? 'Создать мокап: 3 картины' : 'Создать мокап: 1 картина')
            : 'Создать мокап для обоев';
    }
    if (enhancerHint) {
        enhancerHint.textContent = normalizedKind === 'artwork'
            ? 'Prompt Enhance включён всегда: он анализирует исходную картину и собирает точный интерьерный мокап.'
            : 'Prompt Enhance включён всегда: он берёт палитру дизайна для интерьера.';
    }
    localStorage.setItem('radio_mockupAiKind', normalizedKind);
}

function getMockupAiWorkflowForSelectedModel() {
    return workflows.KREA2_IMG2IMG_WORKFLOW;
}

function isValidMockupAiSeed(value) {
    const text = String(value === undefined || value === null ? '' : value).trim();
    return /^\d+$/.test(text) && Number.isSafeInteger(Number(text));
}

function getDefaultMockupAiSeed() {
    const workflow = getMockupAiWorkflowForSelectedModel();
    const seed = workflow && workflow['30:3'] && workflow['30:3'].inputs ? workflow['30:3'].inputs.seed : 0;
    return isValidMockupAiSeed(seed) ? String(seed) : '0';
}

function ensureMockupAiSeed() {
    const model = 'krea2';
    const key = 'mockupAiSeed_' + model;
    const saved = localStorage.getItem(key);
    const seedText = isValidMockupAiSeed(saved) ? String(saved).trim() : getDefaultMockupAiSeed();
    if (mockupAiSeedInput) mockupAiSeedInput.value = seedText;
    if (!isValidMockupAiSeed(saved)) localStorage.setItem(key, seedText);
    return Number(seedText);
}

function loadMockupAiModelControls() {
    const model = 'krea2';
    ensureMockupAiSeed();
    const title = document.getElementById('mockupAiModelSettingsTitle');
    if (title) title.textContent = 'Параметры ' + modelLabel(model) + ' img2img';
}

if (mockupAiModelSelect) {
    mockupAiModelSelect.value = 'krea2';
    localStorage.setItem('mockupAiModel', 'krea2');
}
if (mockupAiSeedInput) mockupAiSeedInput.addEventListener('input', () => {
    const model = 'krea2';
    const text = mockupAiSeedInput.value.trim();
    if (isValidMockupAiSeed(text)) localStorage.setItem('mockupAiSeed_' + model, text);
    else localStorage.removeItem('mockupAiSeed_' + model);
});
const mockupRemoveWallField = document.getElementById('mockupRemoveWall');
if (mockupRemoveWallField) {
    mockupRemoveWallField.checked = localStorage.getItem('mockupRemoveWall') === 'true';
    mockupRemoveWallField.addEventListener('change', () => localStorage.setItem('mockupRemoveWall', String(mockupRemoveWallField.checked)));
}
if (mockupAdditionalPromptInput) {
    mockupAdditionalPromptInput.value = localStorage.getItem('mockupAdditionalPrompt') || '';
    mockupAdditionalPromptInput.addEventListener('input', () => localStorage.setItem('mockupAdditionalPrompt', mockupAdditionalPromptInput.value));
}
if (mockupArtAdditionalPromptInput) {
    mockupArtAdditionalPromptInput.value = localStorage.getItem('mockupArtAdditionalPrompt') || '';
    mockupArtAdditionalPromptInput.addEventListener('input', () => localStorage.setItem('mockupArtAdditionalPrompt', mockupArtAdditionalPromptInput.value));
}

[
    'mockupRoom', 'mockupInteriorStyle', 'mockupComposition', 'mockupWallAngle',
    'mockupArtRoom', 'mockupArtInteriorStyle', 'mockupArtPlacementSingle', 'mockupArtPlacementTriple',
    'mockupArtFrame', 'mockupArtMat', 'mockupArtOrientation', 'mockupArtCamera', 'mockupArtLighting'
].forEach(id => {
    const select = document.getElementById(id);
    if (!select) return;
    const key = 'mockupChoice_' + id;
    const saved = localStorage.getItem(key);
    if (saved && Array.from(select.options).some(option => option.value === saved)) select.value = saved;
    select.addEventListener('change', () => localStorage.setItem(key, select.value));
});

const savedMockupArtCount = localStorage.getItem('radio_mockupArtCount') === '3' ? '3' : '1';
const savedMockupArtCountRadio = document.querySelector('input[name="mockupArtCount"][value="' + savedMockupArtCount + '"]');
if (savedMockupArtCountRadio) savedMockupArtCountRadio.checked = true;
document.querySelectorAll('input[name="mockupArtCount"]').forEach(input => input.addEventListener('change', event => {
    localStorage.setItem('radio_mockupArtCount', event.target.value === '3' ? '3' : '1');
    updateMockupArtCountUI(event.target.value);
}));

const savedMockupAiKind = localStorage.getItem('radio_mockupAiKind') === 'artwork' ? 'artwork' : 'wallpaper';
const savedMockupAiKindRadio = document.querySelector('input[name="mockupAiKind"][value="' + savedMockupAiKind + '"]');
if (savedMockupAiKindRadio) savedMockupAiKindRadio.checked = true;
document.querySelectorAll('input[name="mockupAiKind"]').forEach(input => input.addEventListener('change', event => setMockupAiKindUI(event.target.value)));

loadMockupAiModelControls();
updateMockupArtCountUI(savedMockupArtCount);
setMockupAiKindUI(savedMockupAiKind);

// =====================================================================
// 7b. PERSIST SLIDER VALUES — save & restore all slider positions
// =====================================================================
const SLIDER_IDS = [
    'slider_rmbg_cleanup', 'slider_rmbg_detail', 'slider_rmbg_edge_shift',
    'slider_enh_denoise', 'slider_enh_steps', 'slider_enh_lora',
    'slider_gen_batch', 'slider_gen_steps',
    'slider_gen_cfg', 'slider_gen_lora', 'slider_img2img_denoise',
    'slider_img2img_steps', 'slider_img2img_cfg',
    'slider_krea_aspect', 'slider_krea_megapixels',
    'slider_img2img_aspect', 'slider_img2img_megapixels',
    'slider_variation_aspect', 'slider_variation_megapixels', 'slider_variation_similarity',
    'slider_mockup_ai_aspect', 'slider_mockup_ai_megapixels',
    'slider_seedvr2_scale', 'slider_enhance_edge_fade'
];

// Restore slider values from localStorage
SLIDER_IDS.forEach(id => {
    const slider = document.getElementById(id);
    if (!slider) return;
    const saved = localStorage.getItem(id);
    if (saved) {
        slider.value = saved;
        // Trigger 'input' event so the label updates
        slider.dispatchEvent(new Event('input'));
    }
    // Save on change
    slider.addEventListener('input', () => localStorage.setItem(id, slider.value));
});

const enhanceEdgeFadeSlider = document.getElementById('slider_enhance_edge_fade');
const enhanceEdgeFadeInput = document.getElementById('input_enhance_edge_fade');
function normalizeEnhanceEdgeFadePercent(value) {
    const parsed = Math.round(Number(value));
    return Math.max(1, Math.min(25, Number.isFinite(parsed) ? parsed : 5));
}
function getEnhanceEdgeFadePercent() {
    return normalizeEnhanceEdgeFadePercent(enhanceEdgeFadeSlider ? enhanceEdgeFadeSlider.value : 5);
}
function setEnhanceEdgeFadePercent(value) {
    const percent = normalizeEnhanceEdgeFadePercent(value);
    if (enhanceEdgeFadeSlider) {
        enhanceEdgeFadeSlider.value = String(percent);
        localStorage.setItem('slider_enhance_edge_fade', String(percent));
    }
    if (enhanceEdgeFadeInput) enhanceEdgeFadeInput.value = String(percent);
}
if (enhanceEdgeFadeSlider) {
    setEnhanceEdgeFadePercent(enhanceEdgeFadeSlider.value);
    enhanceEdgeFadeSlider.addEventListener('input', () => setEnhanceEdgeFadePercent(enhanceEdgeFadeSlider.value));
}
if (enhanceEdgeFadeInput) {
    const commitEnhanceEdgeFadeInput = () => setEnhanceEdgeFadePercent(enhanceEdgeFadeInput.value);
    enhanceEdgeFadeInput.addEventListener('change', commitEnhanceEdgeFadeInput);
    enhanceEdgeFadeInput.addEventListener('blur', commitEnhanceEdgeFadeInput);
    enhanceEdgeFadeInput.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); enhanceEdgeFadeInput.blur(); } });
}

const SEAMLESS_PATTERN_SUFFIX = 'pattern, seamless texture';
const genSeamlessPatternCheckbox = document.getElementById('genSeamlessPattern');
const img2imgSeamlessPatternCheckbox = document.getElementById('img2imgSeamlessPattern');

function updateSeamlessPatternConstraints(checkbox, aspectSliderId, megapixelsSliderId) {
    const aspectSlider = document.getElementById(aspectSliderId);
    const megapixelsSlider = document.getElementById(megapixelsSliderId);
    if (!checkbox || !aspectSlider || !megapixelsSlider) return;
    if (checkbox.checked) {
        if (!aspectSlider.disabled) aspectSlider.dataset.seamlessPreviousValue = aspectSlider.value;
        if (!megapixelsSlider.disabled) megapixelsSlider.dataset.seamlessPreviousValue = megapixelsSlider.value;
        aspectSlider.value = '0';
        megapixelsSlider.value = '1';
        aspectSlider.disabled = true;
        megapixelsSlider.disabled = true;
    } else {
        aspectSlider.disabled = false;
        megapixelsSlider.disabled = false;
        if (aspectSlider.dataset.seamlessPreviousValue) {
            aspectSlider.value = aspectSlider.dataset.seamlessPreviousValue;
            delete aspectSlider.dataset.seamlessPreviousValue;
        }
        if (megapixelsSlider.dataset.seamlessPreviousValue) {
            megapixelsSlider.value = megapixelsSlider.dataset.seamlessPreviousValue;
            delete megapixelsSlider.dataset.seamlessPreviousValue;
        }
    }
    aspectSlider.dispatchEvent(new Event('input'));
    megapixelsSlider.dispatchEvent(new Event('input'));
}

function initializeSeamlessPatternCheckbox(checkbox, storageKey, aspectSliderId, megapixelsSliderId) {
    if (!checkbox) return;
    checkbox.checked = localStorage.getItem(storageKey) === 'true';
    updateSeamlessPatternConstraints(checkbox, aspectSliderId, megapixelsSliderId);
    checkbox.addEventListener('change', () => {
        localStorage.setItem(storageKey, String(checkbox.checked));
        updateSeamlessPatternConstraints(checkbox, aspectSliderId, megapixelsSliderId);
    });
}

function getSeamlessPatternPrompt(prompt, checkbox) {
    const text = (prompt || '').trim();
    if (!text) return '';
    return checkbox && checkbox.checked ? `${text}, ${SEAMLESS_PATTERN_SUFFIX}` : text;
}

initializeSeamlessPatternCheckbox(genSeamlessPatternCheckbox, 'genSeamlessPattern', 'slider_krea_aspect', 'slider_krea_megapixels');
initializeSeamlessPatternCheckbox(img2imgSeamlessPatternCheckbox, 'img2imgSeamlessPattern', 'slider_img2img_aspect', 'slider_img2img_megapixels');

function updatePatternAssemblyControls() {
    document.getElementById('genPatternAssemblyOptions').classList.toggle('hidden', !genSeamlessPatternCheckbox.checked);
    document.getElementById('img2imgPatternAssemblyOptions').classList.toggle('hidden', !img2imgSeamlessPatternCheckbox.checked);
    const manifestPath = localStorage.getItem('pendingPatternManifest');
    document.getElementById('btn_pattern_resume').classList.toggle('hidden', !manifestPath || !fs.existsSync(manifestPath));
}
for (const id of ['genPatternAssembly', 'img2imgPatternAssembly']) {
    const checkbox = document.getElementById(id);
    checkbox.checked = localStorage.getItem(id) !== 'false';
    checkbox.addEventListener('change', () => localStorage.setItem(id, String(checkbox.checked)));
}
genSeamlessPatternCheckbox.addEventListener('change', updatePatternAssemblyControls);
img2imgSeamlessPatternCheckbox.addEventListener('change', updatePatternAssemblyControls);
updatePatternAssemblyControls();

function wantsPatternAssembly(type) {
    if (['gen_krea2', 'gen_turbo', 'gen_qwen21'].includes(type)) return genSeamlessPatternCheckbox.checked && document.getElementById('genPatternAssembly').checked;
    if (['img2img_krea2', 'img2img_turbo', 'img2img_qwen21'].includes(type)) return img2imgSeamlessPatternCheckbox.checked && document.getElementById('img2imgPatternAssembly').checked;
    return false;
}

function getPatternAssemblySettings(type) {
    const generation = type.startsWith('img2img_') ? getImg2ImgGenerationOptions() : getKreaGenerationOptions();
    return {userPrompt:generation.prompt, seed:generation.seed, kreaVariant:krea2Model.value,
        lora:{...getKrea2LoraOptions()}, geminiModel:getGeminiEnhancerModel(), apiKey:getConfiguredGeminiApiKey()};
}

async function assemblePattern(referencePath, settings, controller, manifestPath = null) {
    const ip = document.getElementById('serverIP').value || '127.0.0.1:8188';
    const execute = async (graph, text) => {
        patternPipeline.checkCancelled(controller.signal);
        if (hubSupportsTopaz && hubSocket?.connected && (await topazRequest('topaz:busy')).busy) throw new Error('ПК-обработчик занят Topaz. Сборку паттерна можно продолжить после апскейла.');
        rememberWorkflowModel(graph, text ? 'Gemini' : 'ComfyUI');
        activePatternPromptId = await comfyBridge.sendPrompt(ip, graph);
        if (controller.signal.aborted) {
            await fetch(`http://${ip}/queue`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({delete:[activePatternPromptId]})});
            patternPipeline.checkCancelled(controller.signal);
        }
        const result = text ? await comfyBridge.pollHistoryText(ip, activePatternPromptId) :
            await comfyBridge.downloadImage(ip, await comfyBridge.pollHistory(ip, activePatternPromptId));
        activePatternPromptId = null;
        return result;
    };
    const directory = manifestPath ? path.dirname(manifestPath) : path.join(path.dirname(referencePath), 'Patterns', path.basename(referencePath, '.png') + '_' + Date.now());
    const result = await patternPipeline.run({referencePath, settings, directory, manifestPath, signal:controller.signal}, {
        fs, upload:filename => comfyBridge.uploadImage(ip, filename),
        executeText:graph => execute(graph, true), executeImage:graph => execute(graph, false), verifyTransparent:verifyTransparentPng,
        placeInPhotoshop:manifest => psBridge.placePatternAssets(manifest),
        onProgress:message => {
            setStatusBar('⏳ ' + message);
            if (message.startsWith('Размещение')) cancelBtn.classList.remove('visible');
        },
        onCheckpoint:(filename, manifest) => {
            if (manifest.state === 'complete') localStorage.removeItem('pendingPatternManifest');
            else localStorage.setItem('pendingPatternManifest', filename);
            updatePatternAssemblyControls();
        }
    });
    notifyGenerationHistoryChanged();
    setStatusBar('✓ Паттерн: ' + result.manifest.analysis.elements.length + ' элементов PNG и фон ×4 добавлены в Photoshop. Файлы: ' + path.dirname(result.manifestPath));
    return result;
}

document.getElementById('btn_pattern_resume').addEventListener('click', async () => {
    if (isTaskRunning) return;
    lockUI('gen_pattern'); localTaskStartedAt = Date.now(); localTaskType = 'gen_pattern'; markComfyProcessingStarted();
    const controller = activePatternController = new AbortController();
    try {
        await assemblePattern(null, {apiKey:getConfiguredGeminiApiKey()}, controller, localStorage.getItem('pendingPatternManifest'));
    } catch (error) {
        setStatusBar((controller.signal.aborted ? '' : 'Ошибка сборки паттерна: ') + (controller.signal.aborted ? 'Сборка отменена. Готовые файлы сохранены.' : error.message || error));
    } finally {
        activePatternController = null; activePatternPromptId = null; unlockUI();
    }
});

// =====================================================================
// 8. Радио переключатели — persist selection in localStorage
// =====================================================================
// Restore saved radio selections on startup
['genMode', 'mockupMode'].forEach(name => {
    const saved = localStorage.getItem('radio_' + name);
    if (saved) {
        const radio = document.querySelector(`input[name="${name}"][value="${saved}"]`);
        if (radio) { radio.checked = true; radio.dispatchEvent(new Event('change')); }
    }
});

function setEnhanceMode(mode) {
    const selected = ['image', 'object', 'combine'].includes(mode) ? mode : 'image';
    const imageUi = document.getElementById('enhanceImageUI');
    const objectUi = document.getElementById('enhanceObjectUI');
    const combineUi = document.getElementById('enhanceCombineUI');
    if (imageUi) imageUi.classList.toggle('hidden', selected !== 'image');
    if (objectUi) objectUi.classList.toggle('hidden', selected !== 'object');
    if (combineUi) combineUi.classList.toggle('hidden', selected !== 'combine');
    localStorage.setItem('radio_enhanceMode', selected);
}
document.querySelectorAll('input[name="enhanceMode"]').forEach(input => input.addEventListener('change', event => setEnhanceMode(event.target.value)));
const savedEnhanceMode = ['image', 'object', 'combine'].includes(localStorage.getItem('radio_enhanceMode')) ? localStorage.getItem('radio_enhanceMode') : 'image';
const savedEnhanceRadio = document.querySelector('input[name="enhanceMode"][value="' + savedEnhanceMode + '"]');
if (savedEnhanceRadio) savedEnhanceRadio.checked = true;
setEnhanceMode(savedEnhanceMode);
function setGenerationModeUI(mode) {
    const selected = ['normal', 'img2img', 'variations', 'triptych'].includes(mode) ? mode : 'normal';
    const isNormal = selected === 'normal';
    const isImg2Img = selected === 'img2img';
    const isVariationMode = selected === 'variations' || selected === 'triptych';
    const normalPromptGroup = document.getElementById('genNormalPromptGroup');
    const normalButton = document.getElementById('btn_gen');
    const img2imgUi = document.getElementById('genImg2ImgUI');
    const variationsUi = document.getElementById('genVariationsUI');
    if (normalPromptGroup) normalPromptGroup.classList.toggle('hidden', !isNormal);
    if (normalButton) normalButton.classList.toggle('hidden', !isNormal);
    if (img2imgUi) img2imgUi.classList.toggle('hidden', !isImg2Img);
    if (variationsUi) variationsUi.classList.toggle('hidden', !isVariationMode);
    const normalSettings = document.getElementById('normalGenSettingsBlock');
    const img2imgSettings = document.getElementById('img2imgGenSettingsBlock');
    const variationSettings = document.getElementById('variationsGenSettingsBlock');
    if (normalSettings) normalSettings.classList.toggle('hidden', !isNormal);
    if (img2imgSettings) img2imgSettings.classList.toggle('hidden', !isImg2Img);
    if (variationSettings) variationSettings.classList.toggle('hidden', !isVariationMode);
    const similarityGroup = document.getElementById('variationSimilarityGroup');
    if (similarityGroup) similarityGroup.classList.toggle('hidden', selected === 'triptych');
    const hint = document.getElementById('variationModeHint');
    if (hint) hint.textContent = selected === 'triptych'
        ? 'Загрузите фото или мокап, где видны три картины. Рамки, интерьер, блики и перспектива будут проигнорированы.'
        : 'Загрузите одну отдельную картину. Получите три новых согласованных дизайна для одной серии.';
    const button = document.getElementById('btn_generate_variations');
    if (button) button.textContent = selected === 'triptych' ? 'Разобрать триптих на 3 картины' : 'Создать 3 вариации';
    const hotkey = document.getElementById('hk_gen_variations');
    if (hotkey) hotkey.dataset.radio = selected === 'triptych' ? 'triptych' : 'variations';
    if (isNormal) updateGenerationModelSettings();
    if (isVariationMode) updateVariationModelControls();
    localStorage.setItem('radio_genMode', selected);
}
document.querySelectorAll('input[name="genMode"]').forEach(input => input.addEventListener('change', event => setGenerationModeUI(event.target.value)));
const selectedGenerationRadio = document.querySelector('input[name="genMode"]:checked');
setGenerationModeUI(selectedGenerationRadio ? selectedGenerationRadio.value : 'normal');
function setMockupModeUI(mode) {
    const selected = mode === 'ai' ? 'ai' : 'library';
    const isLibrary = selected === 'library';
    document.getElementById('mockupLibraryUI').classList.toggle('hidden', !isLibrary);
    document.getElementById('mockupAIPromptUI').classList.toggle('hidden', isLibrary);
    document.getElementById('mockupAIUI').classList.toggle('hidden', isLibrary);
    localStorage.setItem('radio_mockupMode', selected);
    if (isLibrary) loadMockupList();
}
document.querySelectorAll('input[name="mockupMode"]').forEach(input => input.addEventListener('change', event => setMockupModeUI(event.target.value)));
const selectedMockupModeRadio = document.querySelector('input[name="mockupMode"]:checked');
setMockupModeUI(selectedMockupModeRadio ? selectedMockupModeRadio.value : 'library');

// =====================================================================
// 9. Горячие клавиши
// =====================================================================
let isCapturingHotkey = false;
let activeHotkeyInput = null;

const HOTKEY_MODIFIER_CODES = new Set([
    'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight',
    'ShiftLeft', 'ShiftRight', 'MetaLeft', 'MetaRight'
]);

const LEGACY_LAYOUT_KEY_MAP = Object.freeze({
    'Ё': String.fromCharCode(96),
    'Й': 'Q', 'Ц': 'W', 'У': 'E', 'К': 'R', 'Е': 'T', 'Н': 'Y',
    'Г': 'U', 'Ш': 'I', 'Щ': 'O', 'З': 'P', 'Х': '[', 'Ъ': ']',
    'Ф': 'A', 'Ы': 'S', 'В': 'D', 'А': 'F', 'П': 'G', 'Р': 'H',
    'О': 'J', 'Л': 'K', 'Д': 'L', 'Ж': ';', 'Э': "'",
    'Я': 'Z', 'Ч': 'X', 'С': 'C', 'М': 'V', 'И': 'B', 'Т': 'N',
    'Ь': 'M', 'Б': ',', 'Ю': '.',
    'І': 'S', 'Ї': ']', 'Є': "'", 'Ґ': '\\', 'Ў': ']'
});

const PHYSICAL_KEY_NAMES = Object.freeze({
    Space: 'Space',
    Enter: 'Enter',
    NumpadEnter: 'Enter',
    Tab: 'Tab',
    Backspace: 'Backspace',
    Delete: 'Delete',
    Insert: 'Insert',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Backquote: String.fromCharCode(96),
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    Slash: '/',
    NumpadAdd: 'numadd',
    NumpadSubtract: 'numsub',
    NumpadMultiply: 'nummult',
    NumpadDivide: 'numdiv',
    NumpadDecimal: 'numdec'
});

function canonicalHotkeyToken(token) {
    const value = String(token || '').trim();
    const upper = value.toUpperCase();
    if (!value) return '';
    if (upper === 'CTRL' || upper === 'CONTROL') return 'Ctrl';
    if (upper === 'ALT' || upper === 'OPTION') return 'Alt';
    if (upper === 'SHIFT') return 'Shift';
    if (upper === 'WIN' || upper === 'META' || upper === 'SUPER' || upper === 'COMMAND') return 'Win';
    if (upper === 'SPACE') return 'Space';
    if (upper === 'RETURN') return 'Enter';
    if (upper === 'MOUSEMIDDLE') return 'MouseMiddle';
    if (upper === 'MOUSE4') return 'Mouse4';
    if (upper === 'MOUSE5') return 'Mouse5';
    if (LEGACY_LAYOUT_KEY_MAP[upper]) return LEGACY_LAYOUT_KEY_MAP[upper];
    if (/^[A-Z0-9]$/.test(upper) || /^F(?:[1-9]|1[0-9]|2[0-4])$/.test(upper)) return upper;
    return value;
}

function normalizeStoredHotkey(binding) {
    const modifiers = new Set();
    let key = '';
    String(binding || '').split('+').forEach(token => {
        const normalized = canonicalHotkeyToken(token);
        if (['Ctrl', 'Alt', 'Shift', 'Win'].includes(normalized)) modifiers.add(normalized);
        else if (normalized) key = normalized;
    });
    if (!key) return '';
    return ['Ctrl', 'Alt', 'Shift', 'Win']
        .filter(modifier => modifiers.has(modifier))
        .concat(key)
        .join('+');
}

function physicalKeyFromEvent(event) {
    const code = String(event.code || '');
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);
    if (/^Digit[0-9]$/.test(code)) return code.slice(5);
    if (/^Numpad[0-9]$/.test(code)) return 'num' + code.slice(6);
    if (/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
    return PHYSICAL_KEY_NAMES[code] || '';
}

function acceleratorForHotkey(binding) {
    if (/(?:^|\+)Mouse(?:Middle|4|5)$/.test(binding)) return '';
    return String(binding || '').split('+').map(token => {
        if (token === 'Ctrl') return 'Control';
        if (token === 'Win') return 'Super';
        return token;
    }).join('+');
}

function unregisterHotkey(input) {
    if (!input) return;
    ipcRenderer.send('unregister-shortcut', { id: input.id });
}

function clearDuplicateHotkeys(binding, currentInput) {
    const normalized = normalizeStoredHotkey(binding).toLowerCase();
    document.querySelectorAll('.hotkey-input').forEach(otherInput => {
        if (otherInput === currentInput) return;
        const otherBinding = normalizeStoredHotkey(localStorage.getItem(otherInput.id));
        if (!otherBinding || otherBinding.toLowerCase() !== normalized) return;
        unregisterHotkey(otherInput);
        localStorage.removeItem(otherInput.id);
        otherInput.value = 'Не назначена';
        otherInput.classList.remove('registration-error');
    });
}

function registerHotkey(input, binding) {
    ipcRenderer.send('register-shortcut', {
        id: input.id,
        binding,
        accelerator: acceleratorForHotkey(binding)
    });
}

function saveHotkeyBinding(input, rawBinding) {
    const binding = normalizeStoredHotkey(rawBinding);
    if (!input || !binding) return;
    unregisterHotkey(input);
    clearDuplicateHotkeys(binding, input);
    localStorage.setItem(input.id, binding);
    input.value = binding;
    input.classList.remove('registration-error');
    registerHotkey(input, binding);
    input.blur();
}

function clearHotkeyBinding(input) {
    unregisterHotkey(input);
    localStorage.removeItem(input.id);
    input.classList.remove('registration-error');
    input.value = 'Не назначена';
    input.blur();
}

function executeHotkeyAction(input) {
    if (!input) return;
    const btnId = input.dataset.btn;
    const secId = input.dataset.section;
    const promptId = input.dataset.prompt;
    const button = btnId ? document.getElementById(btnId) : null;
    if (!button) return;

    const header = document.querySelector('.tool-header[data-target="' + secId + '"]');
    const section = secId && document.getElementById(secId);
    if (header && section && section.classList.contains('hidden')) toggleSection(header);
    if (input.dataset.radioName && input.dataset.radio) {
        const selector = 'input[name="' + input.dataset.radioName + '"][value="' + input.dataset.radio + '"]';
        const radio = document.querySelector(selector);
        if (radio && !radio.checked) {
            radio.checked = true;
            radio.dispatchEvent(new Event('change'));
        }
    }
    if (promptId) {
        const promptEl = document.getElementById(promptId);
        if (promptEl && promptEl.value.trim() === '') setTimeout(() => promptEl.focus(), 50);
        else button.click();
    } else {
        button.click();
    }
}

ipcRenderer.on('shortcut-triggered', (event, id) => {
    executeHotkeyAction(document.getElementById(id));
});

ipcRenderer.on('hotkey:mouse-captured', (event, payload = {}) => {
    if (!isCapturingHotkey || !activeHotkeyInput || payload.id !== activeHotkeyInput.id) return;
    saveHotkeyBinding(activeHotkeyInput, payload.binding);
});

ipcRenderer.on('hotkey:registration-result', (event, payload = {}) => {
    const input = payload.id ? document.getElementById(payload.id) : null;
    if (!input) return;
    input.classList.toggle('registration-error', !payload.success);
    if (!payload.success) {
        setStatusBar('Ошибка бинда ' + input.value + ': ' + (payload.error || 'не удалось зарегистрировать.'));
    }
});

document.querySelectorAll('.hotkey-input').forEach(input => {
    input.title = 'Нажмите поле, затем клавишу, среднюю кнопку мыши, Mouse4 или Mouse5';

    const savedHotkey = normalizeStoredHotkey(localStorage.getItem(input.id));
    if (savedHotkey) {
        input.value = savedHotkey;
        localStorage.setItem(input.id, savedHotkey);
        clearDuplicateHotkeys(savedHotkey, input);
        registerHotkey(input, savedHotkey);
    } else {
        input.value = 'Не назначена';
    }

    input.addEventListener('focus', () => {
        isCapturingHotkey = true;
        activeHotkeyInput = input;
        input.value = 'Жмите...';
        input.classList.add('listening');
        input.classList.remove('registration-error');
        ipcRenderer.send('hotkey:capture-start', { id: input.id });
    });

    input.addEventListener('blur', () => {
        ipcRenderer.send('hotkey:capture-stop', { id: input.id });
        if (activeHotkeyInput === input) {
            isCapturingHotkey = false;
            activeHotkeyInput = null;
        }
        input.classList.remove('listening');
        input.value = localStorage.getItem(input.id) || 'Не назначена';
    });

    input.addEventListener('keydown', event => {
        event.preventDefault();
        event.stopPropagation();

        if (event.code === 'Escape' && !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey) {
            clearHotkeyBinding(input);
            return;
        }
        if (HOTKEY_MODIFIER_CODES.has(event.code)) return;

        const keyName = physicalKeyFromEvent(event);
        if (!keyName) {
            setStatusBar('Эта клавиша не поддерживается для глобального бинда.');
            return;
        }

        const modifiers = [];
        if (event.ctrlKey) modifiers.push('Ctrl');
        if (event.altKey) modifiers.push('Alt');
        if (event.shiftKey) modifiers.push('Shift');
        if (event.metaKey) modifiers.push('Win');
        saveHotkeyBinding(input, modifiers.concat(keyName).join('+'));
    });
});

window.addEventListener('blur', () => {
    if (activeHotkeyInput) activeHotkeyInput.blur();
});

['mousedown', 'mouseup', 'auxclick'].forEach(eventName => {
    document.addEventListener(eventName, event => {
        if ([1, 3, 4].includes(event.button)) {
            event.preventDefault();
            if (isCapturingHotkey) event.stopPropagation();
        }
    }, true);
});

// =====================================================================
// 10. Drop zone для img2img
// =====================================================================

let img2imgSelectedImagePath = null;

const img2imgDropZone = document.getElementById('img2imgDropZone');
const img2imgFileInput = document.getElementById('img2imgFileInput');
const img2imgPreview = document.getElementById('img2imgPreview');
const img2imgImageLabel = document.getElementById('img2imgImageLabel');
const btnImg2imgSelect = document.getElementById('btn_img2img_select');
const btnImg2imgClear = document.getElementById('btn_img2img_clear');

function setImg2ImgImage(filePath) {
    img2imgSelectedImagePath = filePath;
    try {
        const buffer = fs.readFileSync(filePath);
        const base64 = buffer.toString('base64');
        const ext = path.extname(filePath).toLowerCase();
        const mimeType = (ext === '.jpg' || ext === '.jpeg') ? 'image/jpeg' : 'image/png';
        img2imgPreview.src = `data:${mimeType};base64,${base64}`;
        img2imgPreview.classList.remove('hidden');
        img2imgImageLabel.classList.add('hidden');
    } catch(e) {
        img2imgSelectedImagePath = null;
        setStatusBar("Ошибка загрузки изображения: " + e.message);
        return;
    }
    btnImg2imgClear.classList.remove('hidden');
    setStatusBar("Изображение выбрано для img2img.");
}

function clearImg2ImgImage() {
    img2imgSelectedImagePath = null;
    img2imgPreview.src = '';
    img2imgPreview.classList.add('hidden');
    img2imgImageLabel.classList.remove('hidden');
    btnImg2imgClear.classList.add('hidden');
    setStatusBar("Изображение удалено.");
}

if (img2imgDropZone) {
    img2imgDropZone.addEventListener('click', () => img2imgFileInput.click());
    if (btnImg2imgSelect) btnImg2imgSelect.addEventListener('click', () => img2imgFileInput.click());

    if (img2imgFileInput) img2imgFileInput.addEventListener('change', e => {
        if (e.target.files.length > 0) {
            const file = e.target.files[0];
            const ext = path.extname(file.name) || '.png';
            const tempPath = path.join(os.tmpdir(), 'comfy_img2img_input' + ext);
            const reader = new FileReader();
            reader.onload = () => {
                try {
                    fs.writeFileSync(tempPath, Buffer.from(reader.result));
                    setImg2ImgImage(tempPath);
                } catch(err) { setStatusBar("Ошибка: " + err.message); }
            };
            reader.readAsArrayBuffer(file);
            e.target.value = '';
        }
    });

    if (btnImg2imgClear) btnImg2imgClear.addEventListener('click', clearImg2ImgImage);

    img2imgDropZone.addEventListener('dragover', e => { e.preventDefault(); e.stopPropagation(); img2imgDropZone.classList.add('drag-over'); });
    img2imgDropZone.addEventListener('dragleave', e => { img2imgDropZone.classList.remove('drag-over'); });
    img2imgDropZone.addEventListener('drop', e => {
        e.preventDefault(); e.stopPropagation();
        img2imgDropZone.classList.remove('drag-over');
        const file = e.dataTransfer.files[0];
        if (file && file.type.startsWith('image/')) {
            const ext = path.extname(file.name) || '.png';
            const tempPath = path.join(os.tmpdir(), 'comfy_img2img_input' + ext);
            const reader = new FileReader();
            reader.onload = () => {
                try {
                    fs.writeFileSync(tempPath, Buffer.from(reader.result));
                    setImg2ImgImage(tempPath);
                } catch(err) { setStatusBar("Ошибка: " + err.message); }
            };
            reader.readAsArrayBuffer(file);
        }
    });
}

// Ctrl+V Paste для img2img
document.addEventListener('paste', e => {
    const img2imgRadio = document.querySelector('input[name="genMode"][value="img2img"]');
    if (!img2imgRadio || !img2imgRadio.checked) return;
    for (const item of e.clipboardData.items) {
        if (item.type.startsWith('image/')) {
            const blob = item.getAsFile();
            const reader = new FileReader();
            reader.onload = () => {
                const tempPath = path.join(os.tmpdir(), 'comfy_img2img_paste.png');
                fs.writeFileSync(tempPath, Buffer.from(reader.result));
                setImg2ImgImage(tempPath);
            };
            reader.readAsArrayBuffer(blob);
            e.preventDefault();
            break;
        }
    }
});

// "Вставить выделенное" из Photoshop
const btnImg2imgFromSelection = document.getElementById('btn_img2img_from_selection');
if (btnImg2imgFromSelection) btnImg2imgFromSelection.addEventListener('click', async () => {
    if (isTaskRunning) { setStatusBar("Задача уже выполняется!"); return; }
    try {
        setStatusBar("⏳ Экспорт выделения...");
        const exportData = await psBridge.exportSelection();
        if (!exportData) { setStatusBar("Нет выделения!"); return; }
        setImg2ImgImage(exportData.filePath);
    } catch (error) {
        setStatusBar("Ошибка: " + (error.message || error));
    }
});


// =====================================================================
// =====================================================================
// 10a. UX/UI — сайты, приложения и игровые интерфейсы
// =====================================================================
const UXUI_GEMINI_PROMPT = [
    'You are a senior UX/UI product designer, design-system architect and visual prompt writer.',
    'Turn the structured user brief into one precise English image-generation prompt for a production-ready interface concept.',
    'If a reference image is supplied, analyze it as visual direction: reuse its relevant brand palette, typography character, spacing rhythm, component language and information hierarchy, but do not blindly copy defects, device frames or surrounding scenery.',
    'Create a straight-on, flat interface canvas or presentation board. Never create a phone, monitor or laptop mockup, hands holding a device, a desk scene, a room, an isometric product render or perspective-distorted screens.',
    'Respect the requested product type, platform, screen count, theme, density and language. Keep grid, alignment, spacing, typography, states, navigation and reusable components coherent.',
    'Use short, plausible and readable interface labels in the requested language; avoid gibberish, corrupted letters, random logos, watermarks and decorative text that has no UX purpose.',
    'For one screen, show exactly one complete usable screen. For a three-screen flow, show exactly three distinct related screens, front-facing and evenly arranged. For a UI kit, show one organized component and design-token sheet rather than an application screenshot.',
    'Make hierarchy and primary actions immediately clear, with realistic content and accessibility-aware contrast.',
    'Output only one cohesive final English prompt without explanations, markdown, headings, alternatives, quotation marks or JSON.'
].join(' ');

const UXUI_ICON_GEMINI_PROMPT = [
    'You are a senior product-icon designer, game UI artist and icon-system architect.',
    'Turn the structured brief into one precise English image-generation prompt for the requested icon or coherent icon family.',
    'Preserve the requested subject, purpose, target product, container shape, palette, rendering style and exact icon count.',
    'Use one unmistakable core concept per icon, a strong centered silhouette, simple readable geometry and enough negative space to remain recognizable at small sizes.',
    'For icon sets, keep every icon consistent in grid, optical size, stroke weight, corner language, perspective, materials, lighting and palette. Show exactly the requested number in equal edge-to-edge cells, with no title, labels, captions or extra swatches.',
    'For a transparent result, render the icon subjects isolated against one perfectly uniform pure white background with clean edges and no environmental surface, frame, cast shadow, border or scenery outside the icon itself; the background will be removed afterward.',
    'Never generate readable text, letters, numbers, existing company logos, trademarks, watermarks, app-store badges, mockup devices, hands, desks, rooms or perspective presentation boards.',
    'If a reference is supplied, use its relevant visual identity and subject language without copying unwanted text or logos.',
    'Output only one cohesive final English prompt without explanations, markdown, headings, alternatives, quotation marks or JSON.'
].join(' ');

const UXUI_WEB_STYLE_INSTRUCTIONS = {
    web_neobrutalism: 'Use a neobrutalist website construction: bold high-contrast blocks, heavy outlines, offset hard shadows, oversized typography, exposed grid logic and playful but very clear hierarchy.',
    web_bento: 'Use a polished bento-grid website construction: modular unequal cards, strong grouping, rounded containers, concise metrics and product visuals arranged in a clean responsive grid.',
    web_swiss: 'Use Swiss International construction: strict typographic grid, asymmetric alignment, generous whitespace, objective sans-serif type, disciplined scale and restrained color accents.',
    web_editorial: 'Use an editorial magazine construction: expressive headline typography, art-directed image rhythm, columns, pull quotes, strong pacing and clear long-form hierarchy.',
    web_saas: 'Use a conversion-focused SaaS construction: concise hero with one primary action, social proof, benefit-led feature sections, product UI preview, integrations, pricing and final CTA.',
    web_ecommerce: 'Use an editorial e-commerce construction: product-first imagery, prominent category navigation, curated collections, persuasive product cards, trust cues and a frictionless shopping hierarchy.',
    web_dark_tech: 'Use a dark-tech construction: deep neutral surfaces, luminous restrained accents, precise grid, technical data details, glass-like depth only where useful and high text contrast.',
    web_organic: 'Use an organic rounded construction: soft asymmetric sections, warm tactile palette, generous curves, natural imagery, friendly typography and calm human-centered spacing.',
    web_y2k: 'Use a deliberate Y2K retro-web construction: chrome or pixel accents, expressive gradients, compact windows and playful nostalgia while preserving modern usability and readable hierarchy.',
    web_luxury: 'Use a minimal-luxury construction: restrained palette, premium typography, cinematic negative space, carefully cropped imagery, subtle motion cues and very sparse high-value calls to action.'
};

function getUXUIStyleInstruction() {
    const value = getActivityFieldValue('uxuiStyle') || 'auto';
    return UXUI_WEB_STYLE_INSTRUCTIONS[value] || ('Use this visual direction: ' + getSelectLabel('uxuiStyle') + '.');
}
const uxuiFileInput = document.getElementById('uxuiFileInput');
const uxuiDropZone = document.getElementById('uxuiDropZone');
const uxuiPreview = document.getElementById('uxuiPreview');
const uxuiImageLabel = document.getElementById('uxuiImageLabel');
const uxuiFileInfo = document.getElementById('uxuiFileInfo');
const uxuiClearButton = document.getElementById('btn_uxui_clear');
const uxuiModelSelect = document.getElementById('uxuiModel');
const uxuiSeedInput = document.getElementById('uxuiSeed');
let uxuiReferencePath = null;
let uxuiReferenceName = '';

function getSelectLabel(id) {
    const select = document.getElementById(id);
    return select && select.selectedOptions && select.selectedOptions.length
        ? String(select.selectedOptions[0].textContent || '').trim()
        : '';
}

function setUXUIMode(mode) {
    const selected = ['web', 'app', 'game', 'icon'].includes(mode) ? mode : 'web';
    const panels = {
        web: document.getElementById('uxuiWebOptions'),
        app: document.getElementById('uxuiAppOptions'),
        game: document.getElementById('uxuiGameOptions'),
        icon: document.getElementById('uxuiIconOptions')
    };
    Object.keys(panels).forEach(key => { if (panels[key]) panels[key].classList.toggle('hidden', key !== selected); });
    ['uxuiStyleField', 'uxuiOutputField', 'uxuiLanguageField'].forEach(id => {
        const field = document.getElementById(id);
        if (field) field.classList.toggle('hidden', selected === 'icon');
    });
    const webStyleGroup = document.getElementById('uxuiWebStyleGroup');
    if (webStyleGroup) {
        webStyleGroup.hidden = selected !== 'web';
        webStyleGroup.disabled = selected !== 'web';
    }
    const styleSelect = document.getElementById('uxuiStyle');
    if (styleSelect) {
        Array.from(styleSelect.options).forEach(option => {
            const webOnly = String(option.value || '').startsWith('web_');
            if (webOnly) {
                option.hidden = selected !== 'web';
                option.disabled = selected !== 'web';
            }
        });
        if (selected !== 'web' && String(styleSelect.value || '').startsWith('web_')) styleSelect.value = 'auto';
    }
    const hint = document.getElementById('uxuiModeHint');
    if (hint) hint.textContent = selected === 'web'
        ? 'Проектирование сайта: от лендинга до интернет-магазина и SaaS-панели.'
        : selected === 'app'
            ? 'Концепты мобильных, планшетных и desktop-приложений с цельным пользовательским сценарием.'
            : selected === 'game'
                ? 'Игровые меню, HUD, инвентари и другие экраны с учётом платформы и читаемости во время игры.'
                : 'Одиночная иконка или цельный набор для приложения, сайта либо игры — с выбранным назначением и стилем.';
    const button = document.getElementById('btn_uxui_generate');
    if (button) {
        const iconCount = Number(getActivityFieldValue('uxuiIconCount')) || 1;
        button.textContent = selected === 'web'
            ? 'Создать дизайн сайта'
            : selected === 'app'
                ? 'Создать интерфейс приложения'
                : selected === 'game'
                    ? 'Создать игровой интерфейс'
                    : iconCount > 1 ? 'Создать набор из ' + iconCount + ' иконок' : 'Создать иконку';
    }
    const prompt = document.getElementById('uxuiPrompt');
    if (prompt) prompt.placeholder = selected === 'icon'
        ? 'Например: иконки стихий для RPG — огонь, вода, воздух, земля, свет и тьма...'
        : 'Например: сервис доставки цветов для молодой аудитории, акцент на быстрый заказ...';
    if (!uxuiReferencePath && uxuiImageLabel) uxuiImageLabel.textContent = selected === 'icon'
        ? 'Необязательный референс иконки или стиля: перетащите, нажмите или вставьте Ctrl+V'
        : 'Необязательный референс: перетащите, нажмите или вставьте Ctrl+V';
    localStorage.setItem('radio_uxuiMode', selected);
    updateUXUIFormatHint();
}

document.querySelectorAll('input[name="uxuiMode"]').forEach(input => input.addEventListener('change', event => setUXUIMode(event.target.value)));
const savedUXUIMode = ['web', 'app', 'game', 'icon'].includes(localStorage.getItem('radio_uxuiMode')) ? localStorage.getItem('radio_uxuiMode') : 'web';
const savedUXUIRadio = document.querySelector('input[name="uxuiMode"][value="' + savedUXUIMode + '"]');
if (savedUXUIRadio) savedUXUIRadio.checked = true;
setUXUIMode(savedUXUIMode);

const uxuiPersistentFields = ['uxuiPrompt', 'uxuiStyle', 'uxuiTheme', 'uxuiOutput', 'uxuiDensity', 'uxuiLanguage', 'uxuiWebType', 'uxuiWebViewport', 'uxuiAppType', 'uxuiAppPlatform', 'uxuiGameType', 'uxuiGamePlatform', 'uxuiIconTarget', 'uxuiIconPurpose', 'uxuiIconStyle', 'uxuiIconCount', 'uxuiIconShape', 'uxuiIconBackground'];
uxuiPersistentFields.forEach(id => {
    const field = document.getElementById(id);
    if (!field) return;
    const saved = localStorage.getItem('uxui_field_' + id);
    if (saved !== null) field.value = saved;
    const eventName = field.tagName === 'TEXTAREA' ? 'input' : 'change';
    field.addEventListener(eventName, () => {
        localStorage.setItem('uxui_field_' + id, field.value);
        updateUXUIFormatHint();
        if (id === 'uxuiIconCount') setUXUIMode(getUXUISelectedMode());
    });
});
setUXUIMode(savedUXUIMode);

if (uxuiMegapixelsSlider) {
    const savedMegapixels = Number(localStorage.getItem('uxuiMegapixels'));
    if ([1, 2, 3].includes(savedMegapixels)) uxuiMegapixelsSlider.value = String(savedMegapixels);
    uxuiMegapixelsSlider.dispatchEvent(new Event('input'));
    uxuiMegapixelsSlider.addEventListener('change', () => localStorage.setItem('uxuiMegapixels', uxuiMegapixelsSlider.value));
}

function getUXUIWorkflow(useReference, model) {
    if (useReference) return model === 'krea2' ? workflows.KREA2_IMG2IMG_WORKFLOW : workflows.TURBO_IMG2IMG_WORKFLOW;
    return model === 'krea2' ? workflows.KREA2_WORKFLOW : workflows.TURBO_WORKFLOW;
}

function loadUXUIModelControls() {
    const model = uxuiModelSelect && uxuiModelSelect.value === 'krea2' ? 'krea2' : 'turbo';
    const workflow = getUXUIWorkflow(false, model);
    if (uxuiSeedInput) uxuiSeedInput.value = localStorage.getItem('uxuiSeed_' + model) || String(workflow['30:3'].inputs.seed);
}

if (uxuiModelSelect) {
    const savedModel = localStorage.getItem('uxuiModel');
    if (['krea2', 'turbo'].includes(savedModel)) uxuiModelSelect.value = savedModel;
    uxuiModelSelect.addEventListener('change', () => {
        localStorage.setItem('uxuiModel', uxuiModelSelect.value);
        loadUXUIModelControls();
    });
}
if (uxuiSeedInput) uxuiSeedInput.addEventListener('input', () => localStorage.setItem('uxuiSeed_' + (uxuiModelSelect ? uxuiModelSelect.value : 'turbo'), uxuiSeedInput.value.trim()));
loadUXUIModelControls();

function setUXUIReference(filePath, sourceName) {
    try {
        const buffer = fs.readFileSync(filePath);
        uxuiReferencePath = filePath;
        uxuiReferenceName = sourceName || path.basename(filePath);
        uxuiPreview.src = 'data:' + imageMimeType(filePath) + ';base64,' + buffer.toString('base64');
        uxuiPreview.classList.remove('hidden');
        uxuiImageLabel.classList.add('hidden');
        uxuiClearButton.classList.remove('hidden');
        uxuiFileInfo.textContent = uxuiReferenceName + ' · будет ограничен до 1 MP только для ComfyUI';
        setStatusBar('Референс UX/UI добавлен.');
    } catch (error) {
        uxuiReferencePath = null;
        uxuiReferenceName = '';
        setStatusBar('Ошибка загрузки референса: ' + (error.message || error));
    }
}

function clearUXUIReference() {
    uxuiReferencePath = null;
    uxuiReferenceName = '';
    uxuiPreview.src = '';
    uxuiPreview.classList.add('hidden');
    uxuiImageLabel.classList.remove('hidden');
    uxuiClearButton.classList.add('hidden');
    uxuiFileInfo.textContent = '';
    setStatusBar('Референс UX/UI удалён.');
}

function saveUXUIBrowserImage(file) {
    if (!file || !String(file.type || '').startsWith('image/')) return;
    const extension = path.extname(file.name || '') || '.png';
    const temporaryPath = path.join(os.tmpdir(), 'comfy_uxui_reference' + extension);
    const reader = new FileReader();
    reader.onload = () => {
        try {
            fs.writeFileSync(temporaryPath, Buffer.from(reader.result));
            setUXUIReference(temporaryPath, file.name || path.basename(temporaryPath));
        } catch (error) { setStatusBar('Ошибка: ' + (error.message || error)); }
    };
    reader.readAsArrayBuffer(file);
}

if (uxuiDropZone) {
    uxuiDropZone.addEventListener('click', () => uxuiFileInput.click());
    document.getElementById('btn_uxui_select').addEventListener('click', () => uxuiFileInput.click());
    uxuiFileInput.addEventListener('change', event => {
        if (event.target.files && event.target.files[0]) saveUXUIBrowserImage(event.target.files[0]);
        event.target.value = '';
    });
    uxuiDropZone.addEventListener('dragover', event => { event.preventDefault(); event.stopPropagation(); uxuiDropZone.classList.add('drag-over'); });
    uxuiDropZone.addEventListener('dragleave', () => uxuiDropZone.classList.remove('drag-over'));
    uxuiDropZone.addEventListener('drop', event => {
        event.preventDefault(); event.stopPropagation(); uxuiDropZone.classList.remove('drag-over');
        if (event.dataTransfer.files && event.dataTransfer.files[0]) saveUXUIBrowserImage(event.dataTransfer.files[0]);
    });
    uxuiClearButton.addEventListener('click', clearUXUIReference);
}

document.addEventListener('paste', event => {
    const section = document.getElementById('sec_uxui');
    if (!section || section.classList.contains('hidden') || !event.clipboardData) return;
    const imageItem = Array.from(event.clipboardData.items || []).find(item => String(item.type || '').startsWith('image/'));
    if (!imageItem) return;
    saveUXUIBrowserImage(imageItem.getAsFile());
    event.preventDefault();
});

const uxuiPhotoshopButton = document.getElementById('btn_uxui_from_photoshop');
if (uxuiPhotoshopButton) uxuiPhotoshopButton.addEventListener('click', async () => {
    if (isTaskRunning) { setStatusBar('Задача уже выполняется!'); return; }
    try {
        setStatusBar('⏳ Экспорт активного документа Photoshop...');
        const sourceName = await psBridge.getActiveDocumentName();
        const filePath = await psBridge.exportDocument();
        if (!filePath) throw new Error('Не удалось экспортировать активный документ Photoshop.');
        setUXUIReference(filePath, sourceName || path.basename(filePath));
    } catch (error) { setStatusBar('Ошибка: ' + (error.message || error)); }
});
function getUXUIOptions() {
    const mode = getUXUISelectedMode();
    const model = uxuiModelSelect && uxuiModelSelect.value === 'krea2' ? 'krea2' : 'turbo';
    const seedText = uxuiSeedInput ? uxuiSeedInput.value.trim() : '';
    if (!/^\d+$/.test(seedText)) throw new Error('Seed UX/UI должен состоять только из цифр.');
    const seed = Number(seedText);
    if (!Number.isSafeInteger(seed)) throw new Error('Seed UX/UI находится вне допустимого диапазона.');
    const userPrompt = getActivityFieldValue('uxuiPrompt');
    const aspect = getUXUIAspectRatio();

    if (mode === 'icon') {
        const iconCount = [1, 6, 12].includes(Number(getActivityFieldValue('uxuiIconCount'))) ? Number(getActivityFieldValue('uxuiIconCount')) : 1;
        const iconBackground = getActivityFieldValue('uxuiIconBackground') || 'transparent';
        const gridInstruction = iconCount === 1
            ? 'Create exactly one icon centered on the square canvas. Do not duplicate it and do not add alternative versions.'
            : iconCount === 6
                ? 'Create exactly six distinct related icons in a precise 3-column by 2-row grid. Center every icon in an equally sized square safe area; use identical optical size and leave clean separation between cells. No seventh icon.'
                : 'Create exactly twelve distinct related icons in a precise 4-column by 3-row grid. Center every icon in an equally sized square safe area; use identical optical size and leave clean separation between cells. No thirteenth icon.';
        const backgroundInstruction = iconBackground === 'transparent'
            ? 'Use one perfectly uniform pure white removable background across the whole canvas, with no floor, texture, scenery, border or external cast shadow. Do not use white inside the icon unless essential. The application will convert this background to true transparency with BiRefNet.'
            : iconBackground === 'solid'
                ? 'Use one clean solid background color appropriate to the selected theme and keep it identical behind every icon.'
                : 'Use one restrained, coherent gradient background treatment, identical in direction and character behind every icon.';
        const promptParts = [
            'Design ' + (iconCount === 1 ? 'one production-ready icon' : 'a production-ready family of exactly ' + iconCount + ' icons') + ' for: ' + getSelectLabel('uxuiIconTarget') + '.',
            'Icon purpose: ' + getSelectLabel('uxuiIconPurpose') + '.',
            'Icon rendering style: ' + getSelectLabel('uxuiIconStyle') + '. Container shape: ' + getSelectLabel('uxuiIconShape') + '.',
            'Theme: ' + getSelectLabel('uxuiTheme') + '; visual complexity: ' + getSelectLabel('uxuiDensity') + '.',
            gridInstruction,
            backgroundInstruction,
            'Use a strong recognizable silhouette, centered composition, consistent geometry, perspective, stroke weight, material, lighting and palette. The result must remain legible at small UI sizes.',
            uxuiReferencePath ? 'Use the uploaded reference only for relevant subject language, palette and style consistency; ignore its text, logos, framing and background.' : 'Develop an original icon language appropriate to the selected target and purpose.',
            'Do not include text, letters, numbers, labels, logos, watermarks, device mockups, hands or presentation scenery.',
            userPrompt ? 'Subjects and additional requirements: ' + userPrompt : 'Invent suitable, clearly differentiated subjects for the selected purpose.'
        ];
        return {
            mode,
            modeLabel: 'Иконки',
            taskType: 'uxui_icon',
            model,
            seed,
            prompt: promptParts.join(' '),
            userPrompt,
            aspectRatio: aspect.value,
            aspectLabel: aspect.label,
            megapixels: Number(getActivityFieldValue('slider_uxui_megapixels')) || 2,
            productValue: getActivityFieldValue('uxuiIconPurpose'),
            productLabel: getSelectLabel('uxuiIconPurpose'),
            platformLabel: getSelectLabel('uxuiIconTarget'),
            styleLabel: getSelectLabel('uxuiIconStyle'),
            themeLabel: getSelectLabel('uxuiTheme'),
            outputLabel: getSelectLabel('uxuiIconCount'),
            densityLabel: getSelectLabel('uxuiDensity'),
            languageLabel: 'Без текста',
            referenceName: uxuiReferenceName,
            iconCount,
            iconStyleLabel: getSelectLabel('uxuiIconStyle'),
            iconShapeLabel: getSelectLabel('uxuiIconShape'),
            iconBackground,
            iconBackgroundLabel: getSelectLabel('uxuiIconBackground')
        };
    }

    const modeData = mode === 'web'
        ? { modeLabel: 'Веб-сайт', productId: 'uxuiWebType', platformId: 'uxuiWebViewport' }
        : mode === 'app'
            ? { modeLabel: 'Приложение', productId: 'uxuiAppType', platformId: 'uxuiAppPlatform' }
            : { modeLabel: 'Игра', productId: 'uxuiGameType', platformId: 'uxuiGamePlatform' };
    const output = getActivityFieldValue('uxuiOutput') || 'single';
    const outputInstruction = output === 'flow3'
        ? 'Create exactly three distinct, connected screens in one clean presentation board, shown front-facing, equally sized and ordered left to right as a realistic user flow.'
        : output === 'kit'
            ? 'Create one organized UI kit and design-system sheet containing color tokens, typography scale, spacing, buttons, inputs, cards, navigation, states and several representative components.'
            : 'Create exactly one complete, polished and immediately usable interface screen, filling the canvas with no duplicate screens.';
    const language = getActivityFieldValue('uxuiLanguage') || 'auto';
    const languageInstruction = language === 'ru'
        ? 'All visible interface labels must be concise, natural Russian.'
        : language === 'en'
            ? 'All visible interface labels must be concise, natural English.'
            : 'Use the language implied by the user brief; otherwise use concise English labels.';
    const promptParts = [
        'Design a production-ready ' + modeData.modeLabel.toLowerCase() + ' interface.',
        'Product or screen type: ' + getSelectLabel(modeData.productId) + '.',
        'Target platform or viewport: ' + getSelectLabel(modeData.platformId) + '.',
        getUXUIStyleInstruction() + ' Theme: ' + getSelectLabel('uxuiTheme') + '; information density: ' + getSelectLabel('uxuiDensity') + '.',
        outputInstruction,
        languageInstruction,
        uxuiReferencePath ? 'Use the uploaded reference for relevant visual identity, palette and component language while improving usability and consistency.' : 'Develop an original, coherent visual identity suitable for the product.',
        'Keep every screen perfectly front-facing and flat. Do not show device hardware, hands, rooms, desks, 3D mockups or perspective distortion.',
        userPrompt ? 'User brief: ' + userPrompt : 'Invent realistic content and a clear primary user goal appropriate to this product type.'
    ];
    return {
        mode,
        modeLabel: modeData.modeLabel,
        taskType: 'uxui_' + mode,
        model,
        seed,
        prompt: promptParts.join(' '),
        userPrompt,
        aspectRatio: aspect.value,
        aspectLabel: aspect.label,
        megapixels: Number(getActivityFieldValue('slider_uxui_megapixels')) || 2,
        productValue: getActivityFieldValue(modeData.productId),
        productLabel: getSelectLabel(modeData.productId),
        platformLabel: getSelectLabel(modeData.platformId),
        styleLabel: getSelectLabel('uxuiStyle'),
        themeLabel: getSelectLabel('uxuiTheme'),
        outputLabel: getSelectLabel('uxuiOutput'),
        densityLabel: getSelectLabel('uxuiDensity'),
        languageLabel: getSelectLabel('uxuiLanguage'),
        referenceName: uxuiReferenceName
    };
}

async function removeUXUIIconBackground(buffer, ip) {
    const temporaryPath = path.join(os.tmpdir(), 'comfy_uxui_icon_background_' + Date.now() + '.png');
    try {
        fs.writeFileSync(temporaryPath, Buffer.from(buffer));
        const comfyName = await comfyBridge.uploadImage(ip, temporaryPath);
        const workflow = JSON.parse(JSON.stringify(workflows.BIREFNET_WORKFLOW));
        workflow['1'].inputs.image = comfyName;
        if (workflow['3'] && workflow['3'].inputs) workflow['3'].inputs.filename_prefix = 'ComfyFloatBar/uxui_icon_transparent';
        rememberWorkflowModel(workflow, 'BiRefNet');
        const promptId = await sendWorkflow(ip, workflow);
        const resultFile = await comfyBridge.pollHistory(ip, promptId);
        return await comfyBridge.downloadImage(ip, resultFile);
    } finally {
        try { if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath); } catch (error) { console.warn('Не удалось удалить временный фон иконки:', error); }
    }
}

async function splitUXUIIconSheet(buffer, count) {
    if (![6, 12].includes(Number(count))) return [];
    const sourceBlob = new Blob([Uint8Array.from(Buffer.from(buffer))], { type: 'image/png' });
    const sourceUrl = URL.createObjectURL(sourceBlob);
    try {
        const image = new Image();
        await new Promise((resolve, reject) => {
            image.onload = resolve;
            image.onerror = () => reject(new Error('Не удалось открыть лист иконок для разделения.'));
            image.src = sourceUrl;
        });
        const columns = Number(count) === 6 ? 3 : 4;
        const rows = Number(count) === 6 ? 2 : 3;
        const sourceWidth = image.naturalWidth || image.width;
        const sourceHeight = image.naturalHeight || image.height;
        const regionWidth = sourceWidth / columns;
        const regionHeight = sourceHeight / rows;
        const squareSize = Math.min(regionWidth, regionHeight);
        const outputSize = Math.max(1, Math.floor(squareSize));
        const results = [];
        for (let index = 0; index < Number(count); index++) {
            const column = index % columns;
            const row = Math.floor(index / columns);
            const sourceX = column * regionWidth + (regionWidth - squareSize) / 2;
            const sourceY = row * regionHeight + (regionHeight - squareSize) / 2;
            const canvas = document.createElement('canvas');
            canvas.width = outputSize;
            canvas.height = outputSize;
            const context = canvas.getContext('2d');
            context.imageSmoothingEnabled = true;
            context.imageSmoothingQuality = 'high';
            context.drawImage(image, sourceX, sourceY, squareSize, squareSize, 0, 0, outputSize, outputSize);
            const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
            if (!blob) throw new Error('Не удалось сохранить отдельную иконку №' + (index + 1) + '.');
            results.push(Buffer.from(await blob.arrayBuffer()));
        }
        return results;
    } finally {
        URL.revokeObjectURL(sourceUrl);
    }
}

async function handleUXUIGeneration() {
    if (isTaskRunning) { setStatusBar('Задача уже выполняется!'); return; }
    let locked = false;
    try {
        const options = getUXUIOptions();
        lockUI(options.taskType);
        locked = true;
        localTaskStartedAt = Date.now();
        localTaskType = options.taskType;
        lastUXUIInfo = Object.assign({}, options, { inputSize: 'Без референса', resultSize: '—', outputName: '', outputFiles: [] });

        if (!workingFolder) {
            const detectedFolder = await ipcRenderer.invoke('get-working-folder');
            if (detectedFolder) {
                workingFolder = detectedFolder;
                localStorage.setItem('workingFolder', detectedFolder);
            }
        }
        if (!workingFolder) throw new Error('Папка download не найдена.');

        const ip = document.getElementById('serverIP').value || '127.0.0.1:8188';
        let comfyName = null;
        if (uxuiReferencePath) {
            setStatusBar('⏳ Подготовка UX/UI-референса до 1 MP...');
            const prepared = await prepareEnhanceInputAtOneMegapixel(uxuiReferencePath, 'uxui_reference');
            lastUXUIInfo.inputSize = prepared.width + ' × ' + prepared.height + ' px' + (prepared.reduced ? ' (уменьшено с ' + prepared.originalWidth + ' × ' + prepared.originalHeight + ')' : '');
            setStatusBar('⏳ Загрузка UX/UI-референса в ComfyUI...');
            comfyName = await comfyBridge.uploadImage(ip, prepared.filePath);
        }

        const workflow = JSON.parse(JSON.stringify(getUXUIWorkflow(Boolean(comfyName), options.model)));
        applyGeminiEnhancerModel(workflow);
        configureKrea2Workflow(workflow, {
            prompt: options.prompt,
            aspectRatio: options.aspectRatio,
            megapixels: options.megapixels,
            seed: options.seed,
            promptEnhance: true
        });
        if (workflow['30:18'] && workflow['30:18'].inputs) workflow['30:18'].inputs.value = options.mode === 'icon' ? UXUI_ICON_GEMINI_PROMPT : UXUI_GEMINI_PROMPT;
        if (comfyName) workflow['17'].inputs.image = comfyName;
        if (workflow['9'] && workflow['9'].inputs) workflow['9'].inputs.filename_prefix = 'ComfyFloatBar/uxui_' + options.mode;
        if (workflow['29'] && workflow['29'].inputs) workflow['29'].inputs.filename_prefix = 'ComfyFloatBar/uxui_' + options.mode;
        rememberWorkflowModel(workflow, options.model === 'krea2' ? 'Krea 2' : 'Turbo');

        setStatusBar(options.mode === 'icon' ? '⏳ ComfyUI рисует иконки...' : '⏳ ComfyUI проектирует ' + options.modeLabel.toLowerCase() + '...');
        markComfyProcessingStarted();
        const promptId = await sendWorkflow(ip, workflow);
        const resultFile = await comfyBridge.pollHistory(ip, promptId);
        let buffer = await comfyBridge.downloadImage(ip, resultFile);
        if (options.mode === 'icon' && options.iconBackground === 'transparent') {
            setStatusBar('⏳ BiRefNet создаёт прозрачный фон иконок...');
            buffer = await removeUXUIIconBackground(buffer, ip);
        }

        const size = getPngDimensionsFromBuffer(buffer);
        const sizeSuffix = size.width && size.height ? getPixelSizeSuffix(size.width, size.height) : 'size_unknown';
        const modelTag = options.model === 'krea2' ? 'Krea2' : 'Turbo';
        const outputName = options.mode === 'icon'
            ? ['Icon', options.platformLabel, options.productValue, options.iconStyleLabel, options.iconCount > 1 ? 'Set' + options.iconCount : 'Single', modelTag, sizeSuffix, Date.now().toString().slice(-5)].map(part => sanitize(String(part))).join('_')
            : ['UXUI', options.modeLabel, options.productValue, modelTag, sizeSuffix, Date.now().toString().slice(-5)].map(part => sanitize(String(part))).join('_');
        const outputFolder = options.mode === 'icon' ? path.join('UX_UI', 'Icons') : 'UX_UI';
        const primaryName = options.mode === 'icon' && options.iconCount > 1 ? outputName + '_Sheet' : outputName;
        const resultPath = saveResultToFolder(buffer, outputFolder, primaryName, 'png');
        if (!resultPath) throw new Error('Не удалось сохранить результат в папку UX_UI.');
        const outputFiles = [primaryName + '.png'];

        if (options.mode === 'icon' && options.iconCount > 1) {
            setStatusBar('⏳ Разделение набора на отдельные PNG...');
            const iconBuffers = await splitUXUIIconSheet(buffer, options.iconCount);
            iconBuffers.forEach((iconBuffer, index) => {
                const iconName = outputName + '_Icon_' + String(index + 1).padStart(2, '0');
                if (!saveResultToFolder(iconBuffer, outputFolder, iconName, 'png')) throw new Error('Не удалось сохранить отдельную иконку №' + (index + 1) + '.');
                outputFiles.push(iconName + '.png');
            });
        }

        lastUXUIInfo.resultSize = size.width && size.height ? size.width + ' × ' + size.height + ' px' : 'Не определён';
        lastUXUIInfo.outputName = primaryName;
        lastUXUIInfo.outputFiles = outputFiles;

        setStatusBar('⏳ Открытие результата в Photoshop...');
        await psBridge.openImageDocument(resultPath, primaryName);
        setStatusBar(options.mode === 'icon'
            ? '✓ Иконки сохранены в UX_UI/Icons: ' + outputFiles.length + ' PNG'
            : '✓ UX/UI сохранён в UX_UI и открыт в Photoshop');
    } catch (error) {
        setStatusBar('Ошибка: ' + (error.message || error));
        console.error(error);
    } finally {
        if (locked) unlockUI();
    }
}
// =====================================================================
// 10b. Amazon A+ Content — Basic, Premium и отдельные модули
// =====================================================================
const APLUS_GEMINI_PROMPT = [
    'You are a senior Amazon A+ Content art director and ecommerce product photographer.',
    'Convert the structured brief and supplied product reference into one precise English image-generation prompt for a single Amazon A+ visual module.',
    'Preserve the supplied product identity, shape, proportions, materials, construction, color, packaging and recognizable details as faithfully as possible. Never redesign the product, invent accessories, change its function or add unsupported variants.',
    'The generated image itself must contain no headlines, paragraphs, labels, icons with text, prices, discounts, coupons, ratings, review stars, rankings, awards, guarantees, warranty statements, shipping claims, QR codes, URLs, contact details, competitor products, competitor names or watermarks.',
    'Every module must be one continuous full-bleed photographic scene extending naturally to all four outer edges. Never place the scene inside a frame, border, white margin, matte, card, poster, inset canvas, picture-in-picture panel, browser window or collage.',
    'Leave deliberate clean negative space for native Amazon text fields. Keep the complete product, including every tip, edge, accessory and package boundary, fully visible inside the center-safe area with clear breathing room around its silhouette. Nothing belonging to the product may touch or cross the final crop.',
    'Use professional high-resolution product and lifestyle photography, physically plausible lighting and an internally consistent brand palette. Avoid generic scenery that does not explain the product.',
    'Only visualize benefits and facts explicitly supplied by the user. Do not invent performance claims, certifications, medical claims, environmental claims, measurements or technical specifications.',
    'Output only one cohesive final English image-generation prompt without explanations, markdown, headings, alternatives, quotation marks or JSON.'
].join(' ');

const APLUS_MODULE_LIBRARY = {
    hero: { code: 'HERO', labelRu: 'Hero / первое впечатление', labelEn: 'Hero / first impression', instruction: 'Create a premium hero banner. Make the exact product the unmistakable focal point, establish its category and brand mood immediately, and reserve a large uncluttered area for a native headline.' },
    lifestyle: { code: 'LIFESTYLE', labelRu: 'Товар в использовании', labelEn: 'Product in use', instruction: 'Show the exact product being used naturally by the intended customer in a realistic lifestyle context. Make scale, use case and practical value easy to understand without any written callouts.' },
    benefit: { code: 'BENEFIT', labelRu: 'Главное преимущество', labelEn: 'Key benefit', instruction: 'Visualize the most important verified customer benefit with a clear product-centered composition. Communicate the benefit through the scene and product interaction, not through embedded text or invented symbols.' },
    detail: { code: 'DETAIL', labelRu: 'Детали и материалы', labelEn: 'Details and materials', instruction: 'Create a refined product-focused banner showing verified material, construction, texture and craftsmanship while keeping the complete product fully visible with breathing room. Do not crop the product, use inset detail frames or invent internal parts or technical diagrams.' },
    howto: { code: 'HOW_TO', labelRu: 'Как использовать', labelEn: 'How to use', instruction: 'Create an intuitive use or setup scene that visually explains a real step or use case. Keep it as one coherent photographic banner with no numbered text, arrows or unsupported accessories.' },
    comparison: { code: 'RANGE', labelRu: 'Линейка / сравнение', labelEn: 'Range / comparison', instruction: 'Create a clean catalog-style scene suitable beside a native Amazon comparison table. Use only the supplied product identity and verified information; do not invent competitor products, unsupported variants, scores or rankings.' },
    brand: { code: 'BRAND', labelRu: 'История бренда', labelEn: 'Brand story', instruction: 'Create an emotional but product-relevant brand finale that expresses the supplied brand values, materials or process. Keep the exact product visible and avoid generic corporate imagery or invented heritage claims.' }
};

const aplusFileInput = document.getElementById('aplusFileInput');
const aplusDropZone = document.getElementById('aplusDropZone');
const aplusPreview = document.getElementById('aplusPreview');
const aplusImageLabel = document.getElementById('aplusImageLabel');
const aplusFileInfo = document.getElementById('aplusFileInfo');
const aplusClearButton = document.getElementById('btn_aplus_clear');
const aplusModelSelect = document.getElementById('aplusModel');
const aplusSeedInput = document.getElementById('aplusSeed');
const aplusMegapixelsSlider = document.getElementById('slider_aplus_megapixels');
let aplusReferencePath = null;
let aplusReferenceName = '';

function getAPlusMode() {
    const selected = document.querySelector('input[name="aplusMode"]:checked');
    return selected && ['basic', 'premium', 'single'].includes(selected.value) ? selected.value : 'basic';
}

function updateAPlusModeUI(mode = getAPlusMode()) {
    const selected = ['basic', 'premium', 'single'].includes(mode) ? mode : 'basic';
    const singleOptions = document.getElementById('aplusSingleOptions');
    if (singleOptions) singleOptions.classList.toggle('hidden', selected !== 'single');
    const hint = document.getElementById('aplusModeHint');
    const summary = document.getElementById('aplusOutputSummary');
    const button = document.getElementById('btn_aplus_generate');
    const singlePremium = getActivityFieldValue('aplusSingleStandard') === 'premium';
    if (selected === 'premium') {
        if (hint) hint.textContent = 'Полный комплект из семи модулей 1464 × 600 px для Premium A+.';
        if (summary) summary.textContent = '7 JPG · 1464 × 600 · Copy.txt';
        if (button) button.textContent = 'Создать Premium A+ комплект';
    } else if (selected === 'single') {
        const width = singlePremium ? 1464 : 970;
        const height = singlePremium ? 600 : 300;
        if (hint) hint.textContent = 'Перегенерация одного выбранного модуля без запуска полного комплекта.';
        if (summary) summary.textContent = '1 JPG · ' + width + ' × ' + height + ' · Copy.txt';
        if (button) button.textContent = 'Создать отдельный A+ модуль';
    } else {
        if (hint) hint.textContent = 'Полный комплект из пяти модулей 970 × 300 px для Basic A+.';
        if (summary) summary.textContent = '5 JPG · 970 × 300 · Copy.txt';
        if (button) button.textContent = 'Создать Basic A+ комплект';
    }
    localStorage.setItem('radio_aplusMode', selected);
}

document.querySelectorAll('input[name="aplusMode"]').forEach(input => input.addEventListener('change', event => updateAPlusModeUI(event.target.value)));
const savedAPlusMode = ['basic', 'premium', 'single'].includes(localStorage.getItem('radio_aplusMode')) ? localStorage.getItem('radio_aplusMode') : 'basic';
const savedAPlusRadio = document.querySelector('input[name="aplusMode"][value="' + savedAPlusMode + '"]');
if (savedAPlusRadio) savedAPlusRadio.checked = true;

const aplusPersistentFields = ['aplusProductName', 'aplusCategory', 'aplusAudience', 'aplusLanguage', 'aplusBenefits', 'aplusFacts', 'aplusObjections', 'aplusBrandDirection', 'aplusSingleModule', 'aplusSingleStandard'];
aplusPersistentFields.forEach(id => {
    const field = document.getElementById(id);
    if (!field) return;
    const saved = localStorage.getItem('aplus_field_' + id);
    if (saved !== null) field.value = saved;
    const eventName = field.tagName === 'SELECT' ? 'change' : 'input';
    field.addEventListener(eventName, () => {
        localStorage.setItem('aplus_field_' + id, field.value);
        updateAPlusModeUI();
    });
});
updateAPlusModeUI(savedAPlusMode);

if (aplusMegapixelsSlider) {
    const saved = Number(localStorage.getItem('aplusMegapixels'));
    if ([1, 2, 3].includes(saved)) aplusMegapixelsSlider.value = String(saved);
    aplusMegapixelsSlider.dispatchEvent(new Event('input'));
    aplusMegapixelsSlider.addEventListener('change', () => localStorage.setItem('aplusMegapixels', aplusMegapixelsSlider.value));
}

function loadAPlusModelControls() {
    const model = aplusModelSelect && aplusModelSelect.value === 'krea2' ? 'krea2' : 'turbo';
    const workflow = getUXUIWorkflow(true, model);
    if (aplusSeedInput) aplusSeedInput.value = localStorage.getItem('aplusSeed_' + model) || String(workflow['30:3'].inputs.seed);
}
if (aplusModelSelect) {
    const saved = localStorage.getItem('aplusModel');
    if (saved === 'turbo' || saved === 'krea2') aplusModelSelect.value = saved;
    aplusModelSelect.addEventListener('change', () => {
        localStorage.setItem('aplusModel', aplusModelSelect.value);
        loadAPlusModelControls();
    });
}
if (aplusSeedInput) aplusSeedInput.addEventListener('input', () => localStorage.setItem('aplusSeed_' + (aplusModelSelect ? aplusModelSelect.value : 'turbo'), aplusSeedInput.value.trim()));
loadAPlusModelControls();

function setAPlusReference(filePath, sourceName) {
    try {
        if (!filePath || !fs.existsSync(filePath)) throw new Error('Файл изображения не найден.');
        const buffer = fs.readFileSync(filePath);
        aplusReferencePath = filePath;
        aplusReferenceName = sourceName || path.basename(filePath);
        aplusPreview.src = 'data:' + imageMimeType(filePath) + ';base64,' + buffer.toString('base64');
        aplusPreview.classList.remove('hidden');
        aplusImageLabel.classList.add('hidden');
        aplusClearButton.classList.remove('hidden');
        aplusFileInfo.textContent = aplusReferenceName + ' · временная копия будет ограничена до 1 MP';
        setStatusBar('Фото товара для A+ Content добавлено.');
    } catch (error) {
        aplusReferencePath = null;
        aplusReferenceName = '';
        setStatusBar('Ошибка загрузки товара: ' + (error.message || error));
    }
}

function clearAPlusReference() {
    aplusReferencePath = null;
    aplusReferenceName = '';
    aplusPreview.src = '';
    aplusPreview.classList.add('hidden');
    aplusImageLabel.classList.remove('hidden');
    aplusClearButton.classList.add('hidden');
    aplusFileInfo.textContent = '';
    setStatusBar('Фото товара удалено.');
}

function saveAPlusBrowserImage(file) {
    if (!file || !String(file.type || '').startsWith('image/')) return;
    const extension = path.extname(file.name || '') || '.png';
    const temporaryPath = path.join(os.tmpdir(), 'comfy_aplus_product' + extension);
    const reader = new FileReader();
    reader.onload = () => {
        try {
            fs.writeFileSync(temporaryPath, Buffer.from(reader.result));
            setAPlusReference(temporaryPath, file.name || path.basename(temporaryPath));
        } catch (error) { setStatusBar('Ошибка: ' + (error.message || error)); }
    };
    reader.readAsArrayBuffer(file);
}

if (aplusDropZone) {
    aplusDropZone.addEventListener('click', () => aplusFileInput.click());
    document.getElementById('btn_aplus_select').addEventListener('click', () => aplusFileInput.click());
    aplusFileInput.addEventListener('change', event => {
        if (event.target.files && event.target.files[0]) saveAPlusBrowserImage(event.target.files[0]);
        event.target.value = '';
    });
    aplusDropZone.addEventListener('dragover', event => { event.preventDefault(); event.stopPropagation(); aplusDropZone.classList.add('drag-over'); });
    aplusDropZone.addEventListener('dragleave', () => aplusDropZone.classList.remove('drag-over'));
    aplusDropZone.addEventListener('drop', event => {
        event.preventDefault(); event.stopPropagation(); aplusDropZone.classList.remove('drag-over');
        if (event.dataTransfer.files && event.dataTransfer.files[0]) saveAPlusBrowserImage(event.dataTransfer.files[0]);
    });
    aplusClearButton.addEventListener('click', clearAPlusReference);
}

document.addEventListener('paste', event => {
    const section = document.getElementById('sec_aplus');
    if (!section || section.classList.contains('hidden') || !event.clipboardData) return;
    const item = Array.from(event.clipboardData.items || []).find(entry => String(entry.type || '').startsWith('image/'));
    if (!item) return;
    saveAPlusBrowserImage(item.getAsFile());
    event.preventDefault();
});

const aplusPhotoshopButton = document.getElementById('btn_aplus_from_photoshop');
if (aplusPhotoshopButton) aplusPhotoshopButton.addEventListener('click', async () => {
    if (isTaskRunning) { setStatusBar('Задача уже выполняется!'); return; }
    try {
        setStatusBar('⏳ Экспорт товара из активного документа Photoshop...');
        const sourceName = await psBridge.getActiveDocumentName();
        const filePath = await psBridge.exportDocument();
        if (!filePath) throw new Error('Не удалось экспортировать активный документ Photoshop.');
        setAPlusReference(filePath, sourceName || path.basename(filePath));
    } catch (error) { setStatusBar('Ошибка: ' + (error.message || error)); }
});
function getAPlusOptions() {
    if (!aplusReferencePath) throw new Error('Добавьте фотографию товара для A+ Content.');
    const mode = getAPlusMode();
    const standard = mode === 'single' ? (getActivityFieldValue('aplusSingleStandard') === 'premium' ? 'premium' : 'basic') : mode;
    const moduleKeys = mode === 'single'
        ? [getActivityFieldValue('aplusSingleModule') || 'hero']
        : standard === 'premium'
            ? ['hero', 'lifestyle', 'benefit', 'detail', 'howto', 'comparison', 'brand']
            : ['hero', 'lifestyle', 'benefit', 'detail', 'brand'];
    const seedText = aplusSeedInput ? aplusSeedInput.value.trim() : '';
    if (!/^\d+$/.test(seedText)) throw new Error('Базовый seed A+ должен состоять только из цифр.');
    const seed = Number(seedText);
    if (!Number.isSafeInteger(seed) || seed > Number.MAX_SAFE_INTEGER - moduleKeys.length) throw new Error('Базовый seed A+ находится вне допустимого диапазона.');
    const referenceBase = String(aplusReferenceName || path.basename(aplusReferencePath)).replace(/\.[^.]+$/, '');
    const productName = getActivityFieldValue('aplusProductName') || referenceBase || 'Product';
    return {
        mode,
        modeLabel: mode === 'single' ? 'Один модуль' : (standard === 'premium' ? 'Комплект из 7 модулей' : 'Комплект из 5 модулей'),
        taskType: 'aplus_' + mode,
        standard,
        standardLabel: standard === 'premium' ? 'Premium A+' : 'Basic A+',
        width: standard === 'premium' ? 1464 : 970,
        height: standard === 'premium' ? 600 : 300,
        moduleKeys,
        model: aplusModelSelect && aplusModelSelect.value === 'krea2' ? 'krea2' : 'turbo',
        megapixels: Number(getActivityFieldValue('slider_aplus_megapixels')) || 2,
        seed,
        productName,
        category: getActivityFieldValue('aplusCategory'),
        audience: getActivityFieldValue('aplusAudience'),
        benefits: getActivityFieldValue('aplusBenefits'),
        facts: getActivityFieldValue('aplusFacts'),
        objections: getActivityFieldValue('aplusObjections'),
        brandDirection: getActivityFieldValue('aplusBrandDirection'),
        language: getActivityFieldValue('aplusLanguage') === 'en' ? 'en' : 'ru',
        languageLabel: getActivityFieldValue('aplusLanguage') === 'en' ? 'English' : 'Русский',
        referenceName: aplusReferenceName || path.basename(aplusReferencePath)
    };
}

function buildAPlusModulePrompt(options, moduleKey, index) {
    const module = APLUS_MODULE_LIBRARY[moduleKey] || APLUS_MODULE_LIBRARY.hero;
    const verifiedBenefits = options.benefits || 'No additional benefit claims supplied; rely only on the visible product and category context.';
    const verifiedFacts = options.facts || 'No additional technical facts supplied; do not invent any.';
    return [
        'Create module ' + (index + 1) + ' of ' + options.moduleKeys.length + ' for a visually consistent ' + options.standardLabel + ' product story.',
        'Exact product: ' + options.productName + '.',
        options.category ? 'Product category: ' + options.category + '.' : '',
        options.audience ? 'Intended audience: ' + options.audience + '.' : '',
        'Verified benefits supplied by the user: ' + verifiedBenefits + '.',
        'Verified materials, dimensions and facts: ' + verifiedFacts + '.',
        options.objections ? 'Purchase questions this visual should help resolve: ' + options.objections + '.' : '',
        options.brandDirection ? 'Brand visual direction: ' + options.brandDirection + '.' : '',
        module.instruction,
        'Compose directly for the exact final aspect ratio of ' + options.width + ' by ' + options.height + ' pixels. The complete product silhouette must fit inside the central 64 percent of the canvas width and central 64 percent of the canvas height, leaving at least 18 percent uninterrupted scene around every outer edge. Keep all product parts away from the crop boundary; only background atmosphere may extend beyond the safe area.',
        'The scene must fill the whole rectangular canvas edge to edge as one uninterrupted photograph. No inner rectangle, frame, border, white strip, matte, card, poster, inset image, split panel, collage or picture-in-picture composition.',
        'Do not render any readable text, badges, promotional graphics, fake specifications, comparison claims, arrows, QR codes or watermarks. The same product and brand palette must remain consistent with every other module in this package.'
    ].filter(Boolean).join(' ');
}

function configureAPlusWorkflowDimensions(workflow, options) {
    const targetRatio = options.width / options.height;
    const totalPixels = Math.max(1, Number(options.megapixels) || 2) * 1000000;
    const generationWidth = Math.max(64, Math.round(Math.sqrt(totalPixels * targetRatio) / 8) * 8);
    const generationHeight = Math.max(64, Math.floor((generationWidth / targetRatio) / 8) * 8);
    if (workflow['30:5'] && workflow['30:5'].inputs) {
        workflow['30:5'].inputs.width = generationWidth;
        workflow['30:5'].inputs.height = generationHeight;
    }
    if (workflow['30:40'] && workflow['30:40'].inputs) {
        workflow['30:40'].inputs.width = generationWidth;
        workflow['30:40'].inputs.height = generationHeight;
        workflow['30:40'].inputs.crop = 'disabled';
        if (workflow['30:3'] && workflow['30:3'].inputs) {
            workflow.cfb_aplus_exact_latent = {
                class_type: 'EmptySD3LatentImage',
                inputs: { width: generationWidth, height: generationHeight, batch_size: 1 }
            };
            workflow['30:3'].inputs.latent_image = ['cfb_aplus_exact_latent', 0];
            workflow['30:3'].inputs.denoise = 1;
        }
    }
    return { width: generationWidth, height: generationHeight };
}

async function convertAPlusImageToJpeg(buffer, targetWidth, targetHeight) {
    const sourceBlob = new Blob([Uint8Array.from(Buffer.from(buffer))], { type: 'image/png' });
    const sourceUrl = URL.createObjectURL(sourceBlob);
    try {
        const image = new Image();
        await new Promise((resolve, reject) => {
            image.onload = resolve;
            image.onerror = () => reject(new Error('Не удалось открыть сгенерированный A+ модуль.'));
            image.src = sourceUrl;
        });
        const sourceWidth = image.naturalWidth || image.width;
        const sourceHeight = image.naturalHeight || image.height;
        const sourceRatio = sourceWidth / sourceHeight;
        const targetRatio = targetWidth / targetHeight;
        let sourceX = 0, sourceY = 0, cropWidth = sourceWidth, cropHeight = sourceHeight;
        if (sourceRatio > targetRatio) {
            cropWidth = sourceHeight * targetRatio;
            sourceX = (sourceWidth - cropWidth) / 2;
        } else {
            cropHeight = sourceWidth / targetRatio;
            sourceY = (sourceHeight - cropHeight) / 2;
        }
        const canvas = document.createElement('canvas');
        canvas.width = targetWidth;
        canvas.height = targetHeight;
        const context = canvas.getContext('2d');
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = 'high';
        context.drawImage(image, sourceX, sourceY, cropWidth, cropHeight, 0, 0, targetWidth, targetHeight);
        let result = null;
        for (const quality of [0.94, 0.9, 0.84, 0.78, 0.7, 0.6, 0.5]) {
            const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
            if (!blob) continue;
            result = Buffer.from(await blob.arrayBuffer());
            if (result.length <= 2 * 1024 * 1024) break;
        }
        if (!result) throw new Error('Не удалось подготовить JPG для Amazon.');
        if (result.length > 2 * 1024 * 1024) throw new Error('A+ модуль не удалось ужать до ограничения 2 МБ.');
        return result;
    } finally {
        URL.revokeObjectURL(sourceUrl);
    }
}

function truncateAPlusCopy(value, maximum) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (text.length <= maximum) return text;
    return text.slice(0, Math.max(1, maximum - 1)).trimEnd() + '…';
}

function firstAPlusLine(value) {
    return String(value || '').split(/\r?\n/).map(line => line.trim()).find(Boolean) || '';
}

function buildAPlusCopyPlan(options, fileNames) {
    const isEnglish = options.language === 'en';
    const benefits = firstAPlusLine(options.benefits);
    const facts = firstAPlusLine(options.facts);
    const audience = options.audience || (isEnglish ? 'your everyday needs' : 'повседневных задач');
    const headingMap = {
        hero: options.productName,
        lifestyle: isEnglish ? 'Made for ' + audience : 'Создано для ' + audience,
        benefit: benefits || (isEnglish ? 'A practical product advantage' : 'Практичное преимущество товара'),
        detail: isEnglish ? 'Thoughtful details' : 'Продуманные детали',
        howto: isEnglish ? 'Simple to use' : 'Просто использовать',
        comparison: isEnglish ? 'Explore the product line' : 'Познакомьтесь с линейкой',
        brand: isEnglish ? 'The story behind ' + options.productName : 'История ' + options.productName
    };
    const bodyMap = {
        hero: options.category || (isEnglish ? 'Introduce the product and its role clearly.' : 'Кратко представьте товар и его назначение.'),
        lifestyle: options.audience ? (isEnglish ? 'Show how the product fits the needs of ' + options.audience + '.' : 'Покажите, как товар подходит аудитории: ' + options.audience + '.') : '',
        benefit: benefits,
        detail: facts,
        howto: options.objections,
        comparison: options.facts,
        brand: options.brandDirection
    };
    const lines = [
        isEnglish ? 'AMAZON A+ CONTENT COPY PLAN' : 'ПЛАН ТЕКСТОВ AMAZON A+ CONTENT',
        '',
        (isEnglish ? 'Product: ' : 'Товар: ') + options.productName,
        (isEnglish ? 'Standard: ' : 'Стандарт: ') + options.standardLabel,
        (isEnglish ? 'Generated assets: ' : 'Создано файлов: ') + fileNames.length,
        (isEnglish ? 'Important: add this copy through native Amazon text fields. Review every fact before submission.' : 'Важно: добавляйте этот текст через нативные поля Amazon. Перед публикацией проверьте каждый факт.'),
        ''
    ];
    options.moduleKeys.forEach((key, index) => {
        const module = APLUS_MODULE_LIBRARY[key] || APLUS_MODULE_LIBRARY.hero;
        const label = isEnglish ? module.labelEn : module.labelRu;
        const heading = truncateAPlusCopy(headingMap[key] || options.productName, 80);
        const body = truncateAPlusCopy(bodyMap[key] || (isEnglish ? 'Add a concise verified product explanation.' : 'Добавьте краткое подтверждённое описание товара.'), 300);
        const altText = truncateAPlusCopy((isEnglish ? options.productName + ' — ' + label + ', product shown clearly' : options.productName + ' — ' + label + ', товар хорошо виден'), 100);
        lines.push('MODULE ' + String(index + 1).padStart(2, '0') + ' — ' + label);
        lines.push((isEnglish ? 'File: ' : 'Файл: ') + fileNames[index]);
        lines.push((isEnglish ? 'Headline (max 80): ' : 'Заголовок (до 80): ') + heading);
        lines.push((isEnglish ? 'Body (max 300): ' : 'Текст (до 300): ') + body);
        lines.push((isEnglish ? 'Image keywords / alt text: ' : 'Ключевые слова изображения / alt-text: ') + altText);
        lines.push('');
    });
    lines.push(isEnglish ? 'COMPLIANCE CHECK BEFORE SUBMISSION' : 'ПРОВЕРКА ПЕРЕД ПУБЛИКАЦИЕЙ');
    lines.push(isEnglish ? '- Verify product appearance, dimensions, materials and all statements.' : '- Проверьте внешний вид товара, размеры, материалы и все формулировки.');
    lines.push(isEnglish ? '- Do not add prices, discounts, shipping, QR codes, URLs, contacts, ratings, warranties, unsupported awards or competitor comparisons.' : '- Не добавляйте цены, скидки, доставку, QR-коды, ссылки, контакты, рейтинги, гарантии, неподтверждённые награды и сравнения с конкурентами.');
    lines.push(isEnglish ? '- Preview desktop and mobile versions in A+ Content Manager.' : '- Проверьте desktop- и mobile-превью в A+ Content Manager.');
    lines.push(isEnglish ? '- Amazon requirements can change; recheck Seller Central before publishing.' : '- Требования Amazon могут меняться — перед публикацией перепроверьте Seller Central.');
    return '\uFEFF' + lines.join('\r\n');
}

async function handleAPlusGeneration() {
    if (isTaskRunning) { setStatusBar('Задача уже выполняется!'); return; }
    let locked = false;
    try {
        const options = getAPlusOptions();
        lockUI(options.taskType);
        locked = true;
        localTaskStartedAt = Date.now();
        localTaskType = options.taskType;

        if (!workingFolder) {
            const detectedFolder = await ipcRenderer.invoke('get-working-folder');
            if (detectedFolder) {
                workingFolder = detectedFolder;
                localStorage.setItem('workingFolder', detectedFolder);
            }
        }
        if (!workingFolder) throw new Error('Папка download не найдена.');

        setStatusBar('⏳ Подготовка фото товара до 1 MP...');
        const prepared = await prepareEnhanceInputAtOneMegapixel(aplusReferencePath, 'aplus_product');
        const inputSize = prepared.width + ' × ' + prepared.height + ' px' + (prepared.reduced ? ' (уменьшено с ' + prepared.originalWidth + ' × ' + prepared.originalHeight + ')' : '');
        const ip = document.getElementById('serverIP').value || '127.0.0.1:8188';
        setStatusBar('⏳ Загрузка товара в ComfyUI...');
        const comfyName = await comfyBridge.uploadImage(ip, prepared.filePath);

        const productStem = sanitize(options.productName) || 'Product';
        const timestamp = Date.now().toString().slice(-5);
        const packageFolder = productStem + '__APlus_' + options.standard.toUpperCase() + '_' + timestamp;
        const nestedFolder = path.join('A_Plus_Content', packageFolder);
        const resultPaths = [];
        const fileNames = [];
        lastAPlusInfo = Object.assign({}, options, { inputSize, completed: 0, total: options.moduleKeys.length, packageFolder, files: [] });

        for (let index = 0; index < options.moduleKeys.length; index++) {
            const moduleKey = options.moduleKeys[index];
            const module = APLUS_MODULE_LIBRARY[moduleKey] || APLUS_MODULE_LIBRARY.hero;
            setStatusBar('⏳ A+ Content: модуль ' + (index + 1) + ' из ' + options.moduleKeys.length + ' — ' + module.labelRu + '...');
            const workflow = JSON.parse(JSON.stringify(getUXUIWorkflow(true, options.model)));
            applyGeminiEnhancerModel(workflow);
            configureKrea2Workflow(workflow, {
                prompt: buildAPlusModulePrompt(options, moduleKey, index),
                aspectRatio: KREA_ASPECT_RATIOS[7].value,
                megapixels: options.megapixels,
                seed: options.seed + index,
                promptEnhance: true
            });
            configureAPlusWorkflowDimensions(workflow, options);
            workflow['17'].inputs.image = comfyName;
            if (workflow['30:18'] && workflow['30:18'].inputs) workflow['30:18'].inputs.value = APLUS_GEMINI_PROMPT;
            const prefix = 'ComfyFloatBar/aplus_' + options.standard + '_' + String(index + 1).padStart(2, '0');
            if (workflow['9'] && workflow['9'].inputs) workflow['9'].inputs.filename_prefix = prefix;
            if (workflow['29'] && workflow['29'].inputs) workflow['29'].inputs.filename_prefix = prefix;
            rememberWorkflowModel(workflow, options.model === 'krea2' ? 'Krea 2' : 'Turbo');
            if (index === 0) markComfyProcessingStarted();
            const promptId = await sendWorkflow(ip, workflow);
            const resultFile = await comfyBridge.pollHistory(ip, promptId);
            const generatedBuffer = await comfyBridge.downloadImage(ip, resultFile);
            const amazonJpeg = await convertAPlusImageToJpeg(generatedBuffer, options.width, options.height);
            const fileStem = productStem + '__APlus_' + options.standard.toUpperCase() + '_M' + String(index + 1).padStart(2, '0') + '_' + module.code + '_' + getPixelSizeSuffix(options.width, options.height);
            const resultPath = saveResultToFolder(amazonJpeg, nestedFolder, fileStem, 'jpg');
            if (!resultPath) throw new Error('Не удалось сохранить A+ модуль.');
            resultPaths.push(resultPath);
            fileNames.push(path.basename(resultPath));
            lastAPlusInfo.completed = index + 1;
            lastAPlusInfo.files = fileNames.slice();
        }

        const copyPlan = buildAPlusCopyPlan(options, fileNames);
        const copyPath = saveResultToFolder(Buffer.from(copyPlan, 'utf8'), nestedFolder, '00_' + productStem + '__APlus_COPY', 'txt');
        if (!copyPath) throw new Error('Не удалось сохранить текстовый план A+ Content.');
        lastAPlusInfo.files = [path.basename(copyPath)].concat(fileNames);

        for (let index = 0; index < resultPaths.length; index++) {
            setStatusBar('⏳ Открытие A+ модуля в Photoshop: ' + (index + 1) + ' из ' + resultPaths.length + '...');
            await psBridge.openImageDocument(resultPaths[index], path.basename(resultPaths[index], '.jpg'));
        }
        setStatusBar('✓ A+ Content готов: ' + resultPaths.length + ' модулей сохранено в ' + packageFolder);
    } catch (error) {
        setStatusBar('Ошибка: ' + (error.message || error));
        console.error(error);
    } finally {
        if (locked) unlockUI();
    }
}
// 10a. Источник для трёх вариаций / разбора триптиха
// =====================================================================
let variationSelectedImagePath = null;
let variationSelectedSourceName = '';
const variationDropZone = document.getElementById('variationDropZone');
const variationFileInput = document.getElementById('variationFileInput');
const variationPreview = document.getElementById('variationPreview');
const variationImageLabel = document.getElementById('variationImageLabel');
const btnVariationSelect = document.getElementById('btn_variation_select');
const btnVariationClear = document.getElementById('btn_variation_clear');

function setVariationImage(filePath, sourceName) {
    if (isTaskRunning) throw new Error('Дождитесь завершения текущей задачи.');
    if (!filePath || !fs.existsSync(filePath)) throw new Error('Файл изображения не найден.');
    variationSelectedImagePath = filePath;
    variationSelectedSourceName = String(sourceName || path.basename(filePath));
    const extension = path.extname(filePath).toLowerCase();
    const mimeType = extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg' : (extension === '.webp' ? 'image/webp' : 'image/png');
    variationPreview.src = 'data:' + mimeType + ';base64,' + fs.readFileSync(filePath).toString('base64');
    variationPreview.classList.remove('hidden');
    variationImageLabel.classList.add('hidden');
    btnVariationClear.disabled = false;
    btnVariationClear.classList.remove('disabled');
    setStatusBar('Исходное изображение выбрано: ' + variationSelectedSourceName);
}

function clearVariationImage() {
    if (isTaskRunning) { setStatusBar('Дождитесь завершения текущей задачи.'); return; }
    variationSelectedImagePath = null;
    variationSelectedSourceName = '';
    variationPreview.src = '';
    variationPreview.classList.add('hidden');
    variationImageLabel.classList.remove('hidden');
    btnVariationClear.disabled = true;
    btnVariationClear.classList.add('disabled');
    setStatusBar('Исходное изображение удалено.');
}

function saveBrowserImageForVariations(file) {
    if (!file || !String(file.type || '').startsWith('image/')) {
        setStatusBar('Выберите файл изображения.');
        return;
    }
    const extension = path.extname(file.name || '') || '.png';
    const temporaryPath = path.join(os.tmpdir(), 'comfy_generation_variations_input' + extension);
    const reader = new FileReader();
    reader.onload = () => {
        try {
            fs.writeFileSync(temporaryPath, Buffer.from(reader.result));
            setVariationImage(temporaryPath, file.name);
        } catch (error) { setStatusBar('Ошибка сохранения изображения: ' + error.message); }
    };
    reader.readAsArrayBuffer(file);
}

if (variationDropZone) {
    variationDropZone.addEventListener('click', () => variationFileInput.click());
    variationDropZone.addEventListener('dragover', event => { event.preventDefault(); event.stopPropagation(); variationDropZone.classList.add('drag-over'); });
    variationDropZone.addEventListener('dragleave', () => variationDropZone.classList.remove('drag-over'));
    variationDropZone.addEventListener('drop', event => {
        event.preventDefault(); event.stopPropagation();
        variationDropZone.classList.remove('drag-over');
        saveBrowserImageForVariations(event.dataTransfer.files[0]);
    });
}
if (btnVariationSelect) btnVariationSelect.addEventListener('click', () => variationFileInput.click());
if (variationFileInput) variationFileInput.addEventListener('change', event => {
    saveBrowserImageForVariations(event.target.files[0]);
    event.target.value = '';
});
if (btnVariationClear) btnVariationClear.addEventListener('click', clearVariationImage);

document.addEventListener('paste', event => {
    if (!isGenMode('variations') && !isGenMode('triptych')) return;
    for (const item of event.clipboardData.items) {
        if (!item.type.startsWith('image/')) continue;
        saveBrowserImageForVariations(item.getAsFile());
        event.preventDefault();
        break;
    }
});

const btnVariationFromSelection = document.getElementById('btn_variation_from_selection');
if (btnVariationFromSelection) btnVariationFromSelection.addEventListener('click', async () => {
    if (isTaskRunning) { setStatusBar('Задача уже выполняется!'); return; }
    try {
        setStatusBar('⏳ Экспорт источника из Photoshop...');
        let exportData = await psBridge.exportSelection();
        let sourceName;
        if (exportData) {
            sourceName = 'Выделение Photoshop';
        } else {
            const filePath = await psBridge.exportDocument();
            exportData = { filePath };
            sourceName = await psBridge.getActiveDocumentName();
        }
        setVariationImage(exportData.filePath, sourceName);
    } catch (error) {
        setStatusBar('Ошибка: ' + (error.message || error));
    }
});

// =====================================================================
// 10b. Topaz — передача оригинала и серверная очередь
// =====================================================================
let upscaleSelectedImagePath = null;
const upscaleDropZone = document.getElementById('upscaleDropZone');
const upscaleFileInput = document.getElementById('upscaleFileInput');
const upscalePreview = document.getElementById('upscalePreview');
const upscaleImageLabel = document.getElementById('upscaleImageLabel');
const upscaleFileInfo = document.getElementById('upscaleFileInfo');
const upscaleRecipient = document.getElementById('upscaleRecipient');
const upscaleDescription = document.getElementById('upscaleTaskDescription');
const upscaleLinks = document.getElementById('upscaleTaskLinks');
const upscalePriority = document.getElementById('upscaleTaskPriority');
const upscaleDueAt = document.getElementById('upscaleTaskDueAt');
const btnUpscaleSelect = document.getElementById('btn_upscale_select');
const btnUpscaleClear = document.getElementById('btn_upscale_clear');
const btnUpscaleFromSelection = document.getElementById('btn_upscale_from_selection');

function imageMimeType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
    if (ext === '.webp') return 'image/webp';
    if (ext === '.gif') return 'image/gif';
    return 'image/png';
}

function refreshUpscaleRecipients() {
    if (!upscaleRecipient) return;
    const previous = upscaleRecipient.value;
    const names = new Set();
    hubActiveUsers.forEach(user => { if (user && user.nickname) names.add(String(user.nickname)); });
    const myNickname = localStorage.getItem('nickname') || '';
    if (myNickname) names.add(myNickname);
    const ordered = Array.from(names).sort((left, right) => left.localeCompare(right, 'ru'));
    upscaleRecipient.replaceChildren();
    if (!ordered.length) {
        const option = document.createElement('option');
        option.textContent = 'Нет подключённых пользователей';
        option.value = '';
        upscaleRecipient.appendChild(option);
        upscaleRecipient.disabled = true;
        return;
    }
    upscaleRecipient.disabled = false;
    ordered.forEach(name => {
        const option = document.createElement('option');
        option.value = name;
        option.textContent = name === myNickname ? name + ' (вы)' : name;
        upscaleRecipient.appendChild(option);
    });
    const ilya = ordered.find(name => name.toLowerCase() === 'ilya');
    upscaleRecipient.value = ordered.includes(previous) ? previous : (ilya || ordered[0]);
}

function setUpscaleImage(filePath) {
    try {
        const buffer = fs.readFileSync(filePath);
        upscaleSelectedImagePath = filePath;
        upscalePreview.src = 'data:' + imageMimeType(filePath) + ';base64,' + buffer.toString('base64');
        upscalePreview.onload = () => {
            upscaleFileInfo.textContent = path.basename(filePath) + ' · ' +
                upscalePreview.naturalWidth + ' × ' + upscalePreview.naturalHeight + ' px';
            topazPanel?.refresh?.();
        };
        upscalePreview.classList.remove('hidden');
        upscaleImageLabel.classList.add('hidden');
        btnUpscaleClear.classList.remove('hidden');
    } catch (error) {
        upscaleSelectedImagePath = null;
        setStatusBar('Ошибка загрузки изображения: ' + error.message);
    }
}

function clearUpscaleImage() {
    upscaleSelectedImagePath = null;
    upscalePreview.src = '';
    upscalePreview.classList.add('hidden');
    upscaleImageLabel.classList.remove('hidden');
    upscaleFileInfo.textContent = '';
    btnUpscaleClear.classList.add('hidden');
}

function saveBrowserImageForUpscale(file) {
    if (!file || !String(file.type || '').startsWith('image/')) {
        setStatusBar('Выберите файл изображения.');
        return;
    }
    const extension = path.extname(file.name || '') || '.png';
    const temporaryPath = path.join(os.tmpdir(), 'comfy_upscale_input' + extension);
    const reader = new FileReader();
    reader.onload = () => {
        try {
            fs.writeFileSync(temporaryPath, Buffer.from(reader.result));
            setUpscaleImage(temporaryPath);
        } catch (error) {
            setStatusBar('Ошибка сохранения изображения: ' + error.message);
        }
    };
    reader.readAsArrayBuffer(file);
}

function loadUpscaleSourceImage(filePath) {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('Не удалось прочитать изображение.'));
        image.src = 'data:' + imageMimeType(filePath) + ';base64,' + fs.readFileSync(filePath).toString('base64');
    });
}

let topazPanel;
function topazRequest(event, payload = {}) {
    return new Promise((resolve, reject) => {
        if (!hubSocket?.connected) { reject(new Error('Hub не подключён')); return; }
        // Large print originals can take a long time to cross Tailscale. Keep the
        // request alive; the stable requestId still protects retries from duplicates.
        hubSocket.timeout(event === 'topaz:upload' ? 3 * 60 * 60 * 1000 : 10000).emit(event, payload, (error, answer) => {
            if (error) reject(new Error('Обработчик не ответил. Проверьте очередь перед повтором.'));
            else if (!answer?.ok) reject(new Error(answer?.error || 'Ошибка обработчика Topaz'));
            else resolve(answer.result);
        });
    });
}
async function sendUpscaleRequest() { await topazPanel.upload(); }

async function receiveUpscaleFile(payload) {
    const myNickname = localStorage.getItem('nickname') || '';
    if (!payload || payload.recipientNickname !== myNickname || !payload.image) return;
    try {
        const inbox = await ipcRenderer.invoke('get-upscale-inbox-folder');
        const rawName = path.basename(String(payload.fileName || 'upscale.png'));
        const safeName = rawName.replace(/[^A-Za-z0-9._-]+/g, '_') || 'upscale.png';
        const savePath = path.join(inbox, safeName);
        fs.writeFileSync(savePath, Buffer.from(payload.image));
        setStatusBar('✓ Получен файл на апскейл от ' + (payload.senderNickname || 'участника') + ': ' + safeName);
    } catch (error) {
        console.error(error);
        setStatusBar('Ошибка сохранения файла на апскейл: ' + (error.message || error));
    }
}

if (upscaleDropZone) {
    upscaleDropZone.addEventListener('click', () => {
        upscaleDropZone.focus();
        upscaleFileInput.click();
    });
    upscaleDropZone.addEventListener('dragover', event => {
        event.preventDefault();
        upscaleDropZone.classList.add('drag-over');
    });
    upscaleDropZone.addEventListener('dragleave', () => upscaleDropZone.classList.remove('drag-over'));
    upscaleDropZone.addEventListener('drop', event => {
        event.preventDefault();
        upscaleDropZone.classList.remove('drag-over');
        saveBrowserImageForUpscale(event.dataTransfer.files[0]);
    });
    upscaleDropZone.addEventListener('paste', event => {
        for (const item of event.clipboardData.items) {
            if (!item.type.startsWith('image/')) continue;
            saveBrowserImageForUpscale(item.getAsFile());
            event.preventDefault();
            break;
        }
    });
}
if (upscaleFileInput) upscaleFileInput.addEventListener('change', event => {
    saveBrowserImageForUpscale(event.target.files[0]);
    event.target.value = '';
});
if (btnUpscaleSelect) btnUpscaleSelect.addEventListener('click', () => upscaleFileInput.click());
if (btnUpscaleClear) btnUpscaleClear.addEventListener('click', clearUpscaleImage);
if (btnUpscaleFromSelection) btnUpscaleFromSelection.addEventListener('click', async () => {
    try {
        setStatusBar('⏳ Экспорт выделения из Photoshop...');
        const data = await psBridge.exportSelection();
        if (!data) throw new Error('Сначала выделите область в Photoshop.');
        setUpscaleImage(data.filePath);
    } catch (error) {
        setStatusBar('Ошибка: ' + (error.message || error));
    }
});
refreshUpscaleRecipients();
topazPanel = require('./topaz-ui').mountTopaz({
    root: document.getElementById('topazPanel'), request: topazRequest, status: setStatusBar,
    dimensions: () => ({ width: upscalePreview.naturalWidth, height: upscalePreview.naturalHeight }),
    source: () => upscaleSelectedImagePath ? {
        image: fs.readFileSync(upscaleSelectedImagePath), sourceName: path.basename(upscaleSelectedImagePath),
        identity: upscaleSelectedImagePath + ':' + fs.statSync(upscaleSelectedImagePath).mtimeMs,
        width: upscalePreview.naturalWidth, height: upscalePreview.naturalHeight
    } : null,
    layer: async () => {
        setStatusBar('Экспорт слоя Photoshop в исходном разрешении…');
        const data = await psBridge.exportActiveLayerVisible(1000000);
        setUpscaleImage(data.filePath);
    }
});

// =====================================================================
// 10a.1 SeedVR2 ×1–×4 Upscale — input is normalized to 1 MP
// =====================================================================
let aiUpscaleSelectedImagePath = null;
let aiUpscaleSourceName = '';
let lastSeedvr2UpscaleInfo = null;
let lastSeedvr2BatchInfo = null;
const aiUpscaleDropZone = document.getElementById('aiUpscaleDropZone');
const aiUpscaleFileInput = document.getElementById('aiUpscaleFileInput');
const aiUpscalePreview = document.getElementById('aiUpscalePreview');
const aiUpscaleImageLabel = document.getElementById('aiUpscaleImageLabel');
const aiUpscaleFileInfo = document.getElementById('aiUpscaleFileInfo');
const aiUpscaleResizeNotice = document.getElementById('aiUpscaleResizeNotice');
const btnAiUpscaleSelect = document.getElementById('btn_ai_upscale_select');
const btnAiUpscaleFromLayer = document.getElementById('btn_ai_upscale_from_layer');
const btnAiUpscaleAllVisible = document.getElementById('btn_ai_upscale_all_visible');
const btnAiUpscaleClear = document.getElementById('btn_ai_upscale_clear');
const btnAiUpscaleFromSelection = document.getElementById('btn_ai_upscale_from_selection');
const btnAiUpscale = document.getElementById('btn_ai_upscale');
const seedvr2ScaleSlider = document.getElementById('slider_seedvr2_scale');

function updateAiUpscaleResizeNotice(width, height) {
    if (!aiUpscaleResizeNotice) return;
    const pixels = Math.max(1, Number(width) * Number(height));
    const megapixels = (pixels / 1000000).toFixed(2);
    if (pixels > 1000000) {
        aiUpscaleResizeNotice.textContent = '⚠ Исходник ' + megapixels + ' MP больше 1 MP. Перед обработкой дизайн будет подогнан ровно до 1 MP.';
    } else {
        aiUpscaleResizeNotice.textContent = 'Исходник ' + megapixels + ' MP. Перед обработкой дизайн будет подогнан ровно до 1 MP с сохранением пропорций.';
    }
}

function updateSeedvr2UpscaleButton() {
    const factor = Math.min(4, Math.max(1, Math.round(Number(seedvr2ScaleSlider && seedvr2ScaleSlider.value) || 4)));
    if (btnAiUpscale) btnAiUpscale.textContent = 'Upscale ×' + factor;
    if (btnAiUpscaleAllVisible) btnAiUpscaleAllVisible.textContent = '⚡ Авто: все видимые ×' + factor;
}

function setAiUpscaleImage(filePath, sourceName = path.basename(filePath)) {
    try {
        const buffer = fs.readFileSync(filePath);
        aiUpscaleSelectedImagePath = filePath;
        aiUpscaleSourceName = String(sourceName || path.basename(filePath));
        aiUpscalePreview.src = 'data:' + imageMimeType(filePath) + ';base64,' + buffer.toString('base64');
        aiUpscalePreview.onload = () => {
            const width = aiUpscalePreview.naturalWidth || aiUpscalePreview.width;
            const height = aiUpscalePreview.naturalHeight || aiUpscalePreview.height;
            aiUpscaleFileInfo.textContent = aiUpscaleSourceName + ' · ' + width + ' × ' + height + ' px';
            updateAiUpscaleResizeNotice(width, height);
        };
        aiUpscalePreview.classList.remove('hidden');
        aiUpscaleImageLabel.classList.add('hidden');
        btnAiUpscaleClear.classList.remove('hidden');
    } catch (error) {
        aiUpscaleSelectedImagePath = null;
        setStatusBar('Ошибка загрузки изображения: ' + (error.message || error));
    }
}

function clearAiUpscaleImage() {
    aiUpscaleSelectedImagePath = null;
    aiUpscaleSourceName = '';
    aiUpscalePreview.src = '';
    aiUpscalePreview.classList.add('hidden');
    aiUpscaleImageLabel.classList.remove('hidden');
    aiUpscaleFileInfo.textContent = '';
    btnAiUpscaleClear.classList.add('hidden');
    updateAiUpscaleResizeNotice(1000, 1000);
}

function saveBrowserImageForAiUpscale(file) {
    if (!file || !String(file.type || '').startsWith('image/')) {
        setStatusBar('Выберите файл изображения.');
        return;
    }
    const extension = path.extname(file.name || '') || '.png';
    const temporaryPath = path.join(os.tmpdir(), 'comfy_seedvr2_input' + extension);
    const reader = new FileReader();
    reader.onload = () => {
        try {
            fs.writeFileSync(temporaryPath, Buffer.from(reader.result));
            setAiUpscaleImage(temporaryPath, file.name || path.basename(temporaryPath));
        } catch (error) {
            setStatusBar('Ошибка сохранения изображения: ' + (error.message || error));
        }
    };
    reader.readAsArrayBuffer(file);
}

async function prepareSeedvr2Input() {
    if (!aiUpscaleSelectedImagePath) throw new Error('Добавьте изображение для Upscale.');
    const image = await loadUpscaleSourceImage(aiUpscaleSelectedImagePath);
    const originalWidth = image.naturalWidth || image.width;
    const originalHeight = image.naturalHeight || image.height;
    const originalPixels = originalWidth * originalHeight;
    const ratio = originalWidth / originalHeight;
    const width = Math.max(1, Math.round(Math.sqrt(1000000 * ratio)));
    const height = Math.max(1, Math.round(1000000 / width));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, 0, 0, width, height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('Не удалось подготовить PNG размером 1 MP.');
    const filePath = path.join(os.tmpdir(), 'comfy_seedvr2_1mp.png');
    fs.writeFileSync(filePath, Buffer.from(await blob.arrayBuffer()));
    return {
        filePath,
        sourceName: aiUpscaleSourceName || path.basename(aiUpscaleSelectedImagePath),
        originalWidth,
        originalHeight,
        originalPixels,
        width,
        height,
        wasReduced: originalPixels > 1000000
    };
}

async function runSeedvr2Upscale() {
    if (isTaskRunning) { setStatusBar('Задача уже выполняется!'); return; }
    if (!aiUpscaleSelectedImagePath) { setStatusBar('Добавьте изображение для Upscale.'); return; }
    try {
        lockUI('seedvr2_upscale');
        localTaskStartedAt = Date.now();
        localTaskType = 'seedvr2_upscale';
        const factor = Math.min(4, Math.max(1, Math.round(Number(seedvr2ScaleSlider && seedvr2ScaleSlider.value) || 4)));
        setStatusBar('⏳ Подгонка изображения до 1 MP...');
        const input = await prepareSeedvr2Input();
        lastSeedvr2UpscaleInfo = Object.assign({ factor }, input);
        if (input.wasReduced) {
            setStatusBar('⚠ Исходник больше 1 MP: дизайн подогнан до ' + input.width + ' × ' + input.height + ' px.');
        }
        const ip = document.getElementById('serverIP').value || '127.0.0.1:8188';
        setStatusBar('⏳ Загрузка изображения 1 MP в ComfyUI...');
        const comfyName = await comfyBridge.uploadImage(ip, input.filePath);
        const workflow = JSON.parse(JSON.stringify(workflows.SEEDVR2_UPSCALE_WORKFLOW));
        if (!workflow['1'] || !workflow['1'].inputs || !workflow['66:57'] || !workflow['66:57'].inputs) {
            throw new Error('Workflow SeedVR2 имеет неверную структуру.');
        }
        workflow['1'].inputs.image = comfyName;
        workflow['66:57'].inputs['resize_type.multiplier'] = factor;
        setLastLoadedModel('SeedVR2');
        setStatusBar('⏳ SeedVR2 выполняет Upscale ×' + factor + '...');
        markComfyProcessingStarted();
        const promptId = await sendWorkflow(ip, workflow);
        const resultFile = await comfyBridge.pollHistory(ip, promptId);
        setStatusBar('⏳ Добавление результата в Photoshop...');
        const buffer = await comfyBridge.downloadImage(ip, resultFile);
        const sourceStem = (String(input.sourceName || 'Upscale').replace(/\.[^.]+$/, '').replace(/[\/:*?"<>|]/g, '').trim().replace(/\s+/g, '_').slice(0, 70)) || 'Upscale';
        const resultSize = getPngDimensionsFromBuffer(buffer);
        const width = resultSize.width || Math.round(input.width * factor);
        const height = resultSize.height || Math.round(input.height * factor);
        lastSeedvr2UpscaleInfo.resultWidth = width;
        lastSeedvr2UpscaleInfo.resultHeight = height;
        const layerName = sourceStem + '_SeedVR2_x' + factor + '_' + getPixelSizeSuffix(width, height) + '_' + Date.now().toString().slice(-5);
        const resultPath = saveResultToFolder(buffer, 'Upscales', layerName, 'png');
        if (!resultPath) throw new Error('Папка download для сохранения Upscale недоступна.');
        await psBridge.openImageDocument(resultPath, layerName);
        setStatusBar('✓ Upscale ×' + factor + ' открыт отдельным документом Photoshop и сохранён в Upscales.');
        unlockUI();
    } catch (error) {
        setStatusBar('Ошибка: ' + (error.message || error));
        console.error(error);
        unlockUI();
    }
}

async function processSeedvr2PhotoshopLayer(factor, layerId = null, documentId = null, progressLabel = '') {
    const progressPrefix = progressLabel ? progressLabel + ' · ' : '';
    setStatusBar('⏳ ' + progressPrefix + 'экспорт слоя без маски...');
    const input = await psBridge.exportActiveLayerForUpscale(1, layerId, documentId);
    input.sourceName = input.sourceLayerName || progressLabel || 'Слой Photoshop';
    const info = Object.assign({ factor }, input);
    lastSeedvr2UpscaleInfo = info;
    if (input.wasReduced) {
        setStatusBar('⚠ ' + progressPrefix + 'слой подогнан до ' + input.width + ' × ' + input.height + ' px.');
    }

    const ip = document.getElementById('serverIP').value || '127.0.0.1:8188';
    setStatusBar('⏳ ' + progressPrefix + 'загрузка слоя в ComfyUI...');
    const comfyName = await comfyBridge.uploadImage(ip, input.filePath);
    const workflow = JSON.parse(JSON.stringify(workflows.SEEDVR2_UPSCALE_WORKFLOW));
    if (!workflow['1'] || !workflow['1'].inputs || !workflow['66:57'] || !workflow['66:57'].inputs) {
        throw new Error('Workflow SeedVR2 имеет неверную структуру.');
    }
    workflow['1'].inputs.image = comfyName;
    workflow['66:57'].inputs['resize_type.multiplier'] = factor;
    setLastLoadedModel('SeedVR2');
    setStatusBar('⏳ ' + progressPrefix + 'SeedVR2 Upscale ×' + factor + '...');
    if (!localComfyStartedAt) markComfyProcessingStarted();
    const promptId = await sendWorkflow(ip, workflow);
    const resultFile = await comfyBridge.pollHistory(ip, promptId);
    const buffer = await comfyBridge.downloadImage(ip, resultFile);
    const resultSize = getPngDimensionsFromBuffer(buffer);
    const width = resultSize.width || Math.round(input.width * factor);
    const height = resultSize.height || Math.round(input.height * factor);
    info.resultWidth = width;
    info.resultHeight = height;

    const sourceStem = (String(input.sourceName || 'Layer').replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '').trim().replace(/\s+/g, '_').slice(0, 55)) || 'Layer';
    const layerName = sourceStem + '_SeedVR2_x' + factor + '_' + getPixelSizeSuffix(width, height) + '_' + Date.now().toString().slice(-5);
    const resultPath = saveResultToFolder(buffer, 'Upscales', layerName, 'png');
    if (!resultPath) throw new Error('Папка download для сохранения Upscale недоступна.');
    setStatusBar('⏳ ' + progressPrefix + 'вставка результата и маски...');
    await psBridge.placeImage(buffer, true, input.coordsPath, layerName, true, true, false, null, input.sourceLayerId, input.documentId);
    return info;
}

async function runSeedvr2UpscaleFromActiveLayer() {
    if (isTaskRunning) { setStatusBar('Задача уже выполняется!'); return; }
    let taskLocked = false;
    try {
        lockUI('seedvr2_upscale');
        taskLocked = true;
        localTaskStartedAt = Date.now();
        localTaskType = 'seedvr2_upscale';
        const factor = Math.min(4, Math.max(1, Math.round(Number(seedvr2ScaleSlider && seedvr2ScaleSlider.value) || 4)));
        const info = await processSeedvr2PhotoshopLayer(factor);
        lastSeedvr2UpscaleInfo = info;
        setStatusBar('✓ Upscale ×' + factor + ' вставлен на место слоя «' + info.sourceName + '», исходник скрыт, папка перемещена вниз.');
    } catch (error) {
        if (String(error).indexOf('Polling aborted') >= 0 || !isTaskRunning) return;
        setStatusBar('Ошибка: ' + (error.message || error));
        console.error(error);
    } finally {
        if (taskLocked && isTaskRunning) unlockUI();
    }
}

async function runSeedvr2UpscaleAllVisibleLayers() {
    if (isTaskRunning) { setStatusBar('Задача уже выполняется!'); return; }
    let taskLocked = false;
    try {
        lockUI('seedvr2_batch_upscale');
        taskLocked = true;
        localTaskStartedAt = Date.now();
        localTaskType = 'seedvr2_batch_upscale';
        const factor = Math.min(4, Math.max(1, Math.round(Number(seedvr2ScaleSlider && seedvr2ScaleSlider.value) || 4)));

        setStatusBar('⏳ Получение списка видимых слоёв Photoshop...');
        const snapshot = await psBridge.getVisibleLayersForUpscale();
        if (!snapshot.layers.length) throw new Error('В активном документе нет подходящих видимых слоёв.');
        lastSeedvr2BatchInfo = {
            factor,
            total: snapshot.layers.length,
            completed: 0,
            results: [],
            failed: []
        };

        for (let index = 0; index < snapshot.layers.length; index++) {
            if (!isTaskRunning) return;
            const layer = snapshot.layers[index];
            const progressLabel = (index + 1) + '/' + snapshot.layers.length + ' · ' + layer.displayName;
            try {
                const info = await processSeedvr2PhotoshopLayer(factor, layer.id, snapshot.documentId, progressLabel);
                lastSeedvr2BatchInfo.completed++;
                lastSeedvr2BatchInfo.results.push({
                    name: layer.displayName,
                    size: info.resultWidth + ' × ' + info.resultHeight + ' px'
                });
            } catch (error) {
                if (String(error).indexOf('Polling aborted') >= 0 || !isTaskRunning) return;
                const message = String(error.message || error);
                const skippableLayer = message.indexOf('не содержит видимых пикселей') >= 0 ||
                    message.indexOf('не смог подготовить активный слой') >= 0;
                if (!skippableLayer) throw error;
                lastSeedvr2BatchInfo.failed.push(layer.displayName + ': ' + message);
            }
        }

        if (!lastSeedvr2BatchInfo.completed) {
            throw new Error('Не удалось обработать ни одного видимого слоя.');
        }
        const skippedText = lastSeedvr2BatchInfo.failed.length
            ? ' Пропущено: ' + lastSeedvr2BatchInfo.failed.length + '.'
            : '';
        setStatusBar('✓ Авто Upscale ×' + factor + ': обработано ' + lastSeedvr2BatchInfo.completed + ' из ' + lastSeedvr2BatchInfo.total + ' слоёв.' + skippedText + ' Все папки перемещены вниз.');
    } catch (error) {
        if (String(error).indexOf('Polling aborted') >= 0 || !isTaskRunning) return;
        setStatusBar('Ошибка: ' + (error.message || error));
        console.error(error);
    } finally {
        if (taskLocked && isTaskRunning) unlockUI();
    }
}
if (aiUpscaleDropZone) {
    aiUpscaleDropZone.addEventListener('click', () => {
        aiUpscaleDropZone.focus();
        aiUpscaleFileInput.click();
    });
    aiUpscaleDropZone.addEventListener('dragover', event => {
        event.preventDefault();
        aiUpscaleDropZone.classList.add('drag-over');
    });
    aiUpscaleDropZone.addEventListener('dragleave', () => aiUpscaleDropZone.classList.remove('drag-over'));
    aiUpscaleDropZone.addEventListener('drop', event => {
        event.preventDefault();
        aiUpscaleDropZone.classList.remove('drag-over');
        saveBrowserImageForAiUpscale(event.dataTransfer.files[0]);
    });
    aiUpscaleDropZone.addEventListener('paste', event => {
        for (const item of event.clipboardData.items) {
            if (!item.type.startsWith('image/')) continue;
            saveBrowserImageForAiUpscale(item.getAsFile());
            event.preventDefault();
            break;
        }
    });
}
if (aiUpscaleFileInput) aiUpscaleFileInput.addEventListener('change', event => {
    saveBrowserImageForAiUpscale(event.target.files[0]);
    event.target.value = '';
});
if (btnAiUpscaleSelect) btnAiUpscaleSelect.addEventListener('click', () => aiUpscaleFileInput.click());
if (btnAiUpscaleFromLayer) btnAiUpscaleFromLayer.addEventListener('click', runSeedvr2UpscaleFromActiveLayer);
if (btnAiUpscaleAllVisible) btnAiUpscaleAllVisible.addEventListener('click', runSeedvr2UpscaleAllVisibleLayers);
if (btnAiUpscaleClear) btnAiUpscaleClear.addEventListener('click', clearAiUpscaleImage);
if (btnAiUpscaleFromSelection) btnAiUpscaleFromSelection.addEventListener('click', async () => {
    try {
        setStatusBar('⏳ Экспорт выделения из Photoshop...');
        const data = await psBridge.exportSelection();
        if (!data) throw new Error('Сначала выделите область в Photoshop.');
        let sourceName = path.basename(data.filePath);
        try {
            const documentName = await psBridge.getActiveDocumentName();
            if (documentName && documentName !== 'ERROR') sourceName = documentName;
        } catch (ignore) {}
        setAiUpscaleImage(data.filePath, sourceName);
    } catch (error) {
        setStatusBar('Ошибка: ' + (error.message || error));
    }
});
if (btnAiUpscale) btnAiUpscale.addEventListener('click', runSeedvr2Upscale);
if (seedvr2ScaleSlider) seedvr2ScaleSlider.addEventListener('input', updateSeedvr2UpscaleButton);
updateSeedvr2UpscaleButton();

function setUpscaleMode(mode) {
    const isAi = mode === 'ai';
    const taskUi = document.getElementById('upscaleTaskUI');
    const aiUi = document.getElementById('upscaleAIUI');
    if (taskUi) taskUi.classList.toggle('hidden', isAi);
    if (aiUi) aiUi.classList.toggle('hidden', !isAi);
    localStorage.setItem('radio_upscaleMode', isAi ? 'ai' : 'tasks');
}
document.querySelectorAll('input[name="upscaleMode"]').forEach(input => input.addEventListener('change', event => setUpscaleMode(event.target.value)));
const savedUpscaleMode = localStorage.getItem('radio_upscaleMode') === 'ai' ? 'ai' : 'tasks';
const savedUpscaleRadio = document.querySelector('input[name="upscaleMode"][value="' + savedUpscaleMode + '"]');
if (savedUpscaleRadio) savedUpscaleRadio.checked = true;
setUpscaleMode(savedUpscaleMode);

// =====================================================================
// 10b. Enhance — Qwen: masked edit, image edit and combine
// =====================================================================
let enhanceExportData = null, enhanceImage = null, enhanceMask = null, enhanceMaskCtx = null;
let enhanceDrawing = false, enhancePoint = null, enhanceCursorPoint = null, enhanceHasMask = false;
const enhanceCanvas = document.getElementById('enhanceMaskCanvas');
const enhanceEditor = document.getElementById('enhanceMaskEditor');
const enhanceBrush = document.getElementById('enhanceBrushSize');
const enhanceBrushValue = document.getElementById('enhanceBrushSizeValue');
const enhanceLoadButton = document.getElementById('btn_enhance_load');
const enhanceClearButton = document.getElementById('btn_enhance_clear_mask');
const enhanceApplyButton = document.getElementById('btn_enhance_apply');

function makeEnhanceImageSlot(key, ids) {
    return {
        key,
        path: null,
        sourceName: '',
        coordsPath: null,
        input: document.getElementById(ids.input),
        dropZone: document.getElementById(ids.dropZone),
        label: document.getElementById(ids.label),
        preview: document.getElementById(ids.preview),
        info: document.getElementById(ids.info),
        selectButton: document.getElementById(ids.selectButton),
        selectionButton: document.getElementById(ids.selectionButton),
        clearButton: document.getElementById(ids.clearButton)
    };
}

const enhanceImageSlot = makeEnhanceImageSlot('image', {
    input: 'enhanceImageFileInput', dropZone: 'enhanceImageDropZone', label: 'enhanceImageLabel',
    preview: 'enhanceImagePreview', info: 'enhanceImageFileInfo', selectButton: 'btn_enhance_image_select',
    selectionButton: 'btn_enhance_image_from_selection', clearButton: 'btn_enhance_image_clear'
});
const enhanceCombineFirstSlot = makeEnhanceImageSlot('combine_first', {
    input: 'enhanceCombineFirstFileInput', dropZone: 'enhanceCombineFirstDropZone', label: 'enhanceCombineFirstLabel',
    preview: 'enhanceCombineFirstPreview', info: 'enhanceCombineFirstFileInfo', selectButton: 'btn_enhance_combine_first_select',
    selectionButton: 'btn_enhance_combine_first_from_selection', clearButton: 'btn_enhance_combine_first_clear'
});
const enhanceCombineSecondSlot = makeEnhanceImageSlot('combine_second', {
    input: 'enhanceCombineSecondFileInput', dropZone: 'enhanceCombineSecondDropZone', label: 'enhanceCombineSecondLabel',
    preview: 'enhanceCombineSecondPreview', info: 'enhanceCombineSecondFileInfo', selectButton: 'btn_enhance_combine_second_select',
    selectionButton: 'btn_enhance_combine_second_from_selection', clearButton: 'btn_enhance_combine_second_clear'
});

const ENHANCE_IMAGE_PROMPT_PRESETS = Object.freeze({
    faithful: [
        'Preserve the original image as faithfully as possible, with strict color and tonal matching to the source image. Maintain the exact original color palette, hue relationships, saturation levels, brightness, exposure, gamma, contrast, black point, white point, shadow density, highlight intensity, and overall tonal balance. Do not increase brightness, exposure, luminance, saturation, vibrance, or contrast. Do not make the image more vivid, more luminous, cleaner in tone, or more digitally enhanced than the source. Muted, dark, aged, subdued, and desaturated colors must remain exactly as they are in the original.',
        'Restore and improve the image by correcting defects through intelligent redrawing and reconstruction of damaged or malformed areas. Repair broken, distorted, incomplete, deformed, noisy, or artifacted parts by seamlessly painting in improved and more accurate replacements that match the surrounding image. Redraw defective details so they look cleaner, more coherent, anatomically correct where relevant, structurally consistent, and naturally integrated into the original image. Reconstruct missing or damaged parts with higher quality and better form while preserving the original design, composition, proportions, materials, and visual identity.',
        'Keep all non-defective areas visually unchanged. Only fix the flawed regions and blend the repaired parts naturally into the existing image. Remove generation artifacts, sketch marks, accidental lines, malformed edges, broken contours, surface defects, irregular textures, unwanted noise, and inconsistent details. Improve local clarity, edge quality, material definition, and fine detail only where needed for restoration.',
        'Preserve the original lighting, shadows, highlights, gradients, texture character, and overall atmosphere. Do not reinterpret the scene, do not restyle it, and do not introduce new objects, colors, lighting effects, or design changes. The final result should look like the same original image, but with defects professionally repaired by redrawing and reconstructing the damaged parts in a cleaner, more accurate, and higher-quality way. Source-image color fidelity and seamless defect correction are the highest priorities.'
    ].join('\n\n'),
    illustration: [
        'Faithfully restore this illustration or painting while preserving the exact composition, crop, subject placement, silhouettes, proportions, original palette, tonal balance, lighting, medium, brushwork, paper or canvas character, and the artists existing visual language. Match every color and value to the source. Do not brighten, saturate, modernize, photorealize, sharpen globally, or change the style.',
        'Intelligently redraw only malformed or damaged details: broken contours, awkward anatomy, incomplete objects, muddy edges, accidental marks, generation artifacts, inconsistent strokes, noisy patches, and disrupted local texture. Reconstruct them using the same line quality, paint handling, texture scale, softness, and level of detail as the surrounding artwork.',
        'Keep healthy areas visually unchanged and blend every repair invisibly across the entire tile. Add no new objects, decorative elements, colors, highlights, shadows, text, or stylistic interpretation. The result must remain the same artwork, professionally restored rather than redesigned.'
    ].join('\n\n'),
    photo: [
        'Restore this photograph with strict source fidelity. Preserve the exact framing, perspective, lens character, identities, facial features, body proportions, objects, materials, color grading, white balance, exposure, contrast, shadows, highlights, depth of field, grain, and atmosphere. Do not relight, recolor, beautify, oversharpen, increase saturation, or create a cleaner and brighter version of the scene.',
        'Repair only genuine defects and malformed details through realistic reconstruction: compression artifacts, generation errors, broken edges, damaged textures, inaccurate anatomy, distorted faces or hands, repeated patterns, noise clumps, and missing local detail. Match the surrounding photographic sharpness, noise, texture frequency, focus, and illumination exactly.',
        'Do not invent content or alter non-defective regions. Preserve natural skin, material texture, subtle imperfections, and original tonal density. Every corrected area must merge seamlessly with the source and remain indistinguishable from an untouched photograph.'
    ].join('\n\n'),
    characters: [
        'Preserve the original character, pose, composition, crop, identity, expression, costume, colors, lighting, rendering style, and background exactly. Maintain strict source color and tonal matching. Do not redesign the character, change the face, body shape, age, ethnicity, hairstyle, clothing, accessories, camera angle, or artistic style.',
        'Carefully repair malformed anatomy and drawing defects only where necessary. Reconstruct faces, eyes, teeth, ears, fingers, hands, limbs, joints, fabric edges, hair strands, and object interactions with correct structure while matching the surrounding level of realism or illustration. Remove duplicate features, fused fingers, broken contours, accidental marks, and generation artifacts.',
        'Keep all correct areas visually unchanged. Make local repairs subtle, coherent, and seamlessly blended, with the same texture, sharpness, palette, shadows, and highlights as the source. Add nothing new and do not beautify or stylize.'
    ].join('\n\n'),
    graphics: [
        'Faithfully restore this graphic design while preserving the exact layout, crop, geometry, alignment, spacing, proportions, line weights, shapes, palette, flat fills, gradients, texture, print character, and hierarchy. Preserve all existing letters, words, numbers, logos, symbols, and marks exactly as shown. Do not rewrite, translate, restyle, replace, or invent text.',
        'Repair only broken outlines, malformed geometry, jagged or accidental edges, noisy fills, interrupted linework, inconsistent curves, damaged print areas, and generation artifacts. Reconstruct missing local parts using the same graphic rules, stroke character, color values, edge softness, and production texture as adjacent areas.',
        'Do not add new elements, change typography, modernize the design, increase contrast or saturation, or turn flat artwork into a realistic scene. All untouched areas must remain visually identical and every repaired region must connect seamlessly.'
    ].join('\n\n'),
    pattern: [
        'Restore this ornament, textile, wallpaper, or repeating pattern with strict fidelity to the original motif, repeat scale, spacing, rhythm, symmetry, palette, tonal balance, texture, line weight, and material character. Do not change motif placement, enlarge or shrink elements, introduce new motifs, recolor, brighten, saturate, or modernize the pattern.',
        'Repair only malformed, interrupted, noisy, incomplete, or inconsistent local elements. Continue curves, borders, weave, grain, painted marks, and repeated structures logically from their neighbors while preserving natural variation present in the source. Remove generation artifacts, broken repeats, accidental seams, and damaged edges.',
        'Keep all valid pattern areas unchanged. Every reconstructed part must align seamlessly across the tile and maintain identical color, texture frequency, sharpness, lighting, and print or material character.'
    ].join('\n\n'),
    vintage: [
        'Professionally restore this vintage artwork, scan, or old print while preserving its exact composition, muted palette, aged tonal range, paper color, ink density, halftone or print texture, patina, grain, fading, and historical character. Do not whiten the paper, brighten shadows, increase contrast or saturation, remove authentic age, or make the image look modern and digitally clean.',
        'Repair only unwanted damage and malformed content: tears, missing fragments, accidental stains, generation artifacts, broken contours, distorted objects, inconsistent lettering, noisy patches, and defective local details. Reconstruct them using the same period-correct drawing, printing, paint, grain, softness, and limited color behavior as the surrounding source.',
        'Preserve authentic texture and intentional imperfections. Do not add new content, redesign, recolor, relight, or globally denoise. The finished result must look like the same original vintage piece in a carefully conserved condition.'
    ].join('\n\n')
});

const enhanceImagePromptPreset = document.getElementById('enhanceImagePromptPreset');
const enhanceImagePromptInput = document.getElementById('enhanceImagePrompt');
const enhanceAutoTileSizeInput = document.getElementById('enhanceAutoTileSize');
const enhanceAutoOverlapInput = document.getElementById('enhanceAutoOverlap');

function persistEnhancePrompt() {
    if (!enhanceImagePromptInput || !enhanceImagePromptPreset) return;
    localStorage.setItem('enhance_image_prompt_text', enhanceImagePromptInput.value);
    localStorage.setItem('enhance_image_prompt_preset', enhanceImagePromptPreset.value);
}

if (enhanceImagePromptPreset && enhanceImagePromptInput) {
    const savedPreset = localStorage.getItem('enhance_image_prompt_preset');
    const savedPrompt = localStorage.getItem('enhance_image_prompt_text');
    if (savedPrompt) {
        enhanceImagePromptInput.value = savedPrompt;
        enhanceImagePromptPreset.value = ENHANCE_IMAGE_PROMPT_PRESETS[savedPreset] ? savedPreset : 'custom';
    } else {
        enhanceImagePromptPreset.value = 'faithful';
        enhanceImagePromptInput.value = ENHANCE_IMAGE_PROMPT_PRESETS.faithful;
        persistEnhancePrompt();
    }
    enhanceImagePromptPreset.addEventListener('change', () => {
        const preset = enhanceImagePromptPreset.value;
        if (ENHANCE_IMAGE_PROMPT_PRESETS[preset]) enhanceImagePromptInput.value = ENHANCE_IMAGE_PROMPT_PRESETS[preset];
        persistEnhancePrompt();
    });
    enhanceImagePromptInput.addEventListener('input', () => {
        const preset = enhanceImagePromptPreset.value;
        if (ENHANCE_IMAGE_PROMPT_PRESETS[preset] && enhanceImagePromptInput.value.trim() !== ENHANCE_IMAGE_PROMPT_PRESETS[preset].trim()) {
            enhanceImagePromptPreset.value = 'custom';
        }
        persistEnhancePrompt();
    });
}

function clampEnhanceAutoNumber(value, minimum, maximum, fallback) {
    const parsed = Math.round(Number(value));
    return Math.max(minimum, Math.min(maximum, Number.isFinite(parsed) ? parsed : fallback));
}

function getEnhanceAutoSettings() {
    const tileSize = clampEnhanceAutoNumber(enhanceAutoTileSizeInput ? enhanceAutoTileSizeInput.value : 4000, 1000, 6000, 4000);
    let overlap = clampEnhanceAutoNumber(enhanceAutoOverlapInput ? enhanceAutoOverlapInput.value : 400, 100, 2000, 400);
    overlap = Math.min(overlap, tileSize - 100);
    if (enhanceAutoTileSizeInput) enhanceAutoTileSizeInput.value = String(tileSize);
    if (enhanceAutoOverlapInput) enhanceAutoOverlapInput.value = String(overlap);
    localStorage.setItem('enhance_auto_tile_size', String(tileSize));
    localStorage.setItem('enhance_auto_overlap', String(overlap));
    return { tileSize, overlap };
}

if (enhanceAutoTileSizeInput) enhanceAutoTileSizeInput.value = localStorage.getItem('enhance_auto_tile_size') || '4000';
if (enhanceAutoOverlapInput) enhanceAutoOverlapInput.value = localStorage.getItem('enhance_auto_overlap') || '400';
[enhanceAutoTileSizeInput, enhanceAutoOverlapInput].filter(Boolean).forEach(input => {
    input.addEventListener('change', getEnhanceAutoSettings);
    input.addEventListener('blur', getEnhanceAutoSettings);
});
getEnhanceAutoSettings();
function setEnhanceSlotImage(slot, filePath, sourceName = path.basename(filePath), coordsPath = null) {
    try {
        const buffer = fs.readFileSync(filePath);
        slot.path = filePath;
        slot.sourceName = String(sourceName || path.basename(filePath));
        slot.coordsPath = coordsPath || null;
        slot.preview.src = 'data:' + imageMimeType(filePath) + ';base64,' + buffer.toString('base64');
        slot.preview.onload = () => {
            const width = slot.preview.naturalWidth || slot.preview.width;
            const height = slot.preview.naturalHeight || slot.preview.height;
            slot.info.textContent = slot.sourceName + ' · ' + width + ' × ' + height + ' px';
        };
        slot.preview.classList.remove('hidden');
        slot.label.classList.add('hidden');
        if (slot.clearButton) {
            slot.clearButton.classList.remove('hidden');
            if (slot.key === 'image') slot.clearButton.classList.remove('is-inactive');
        }
    } catch (error) {
        slot.path = null;
        slot.sourceName = '';
        slot.coordsPath = null;
        setStatusBar('Ошибка загрузки изображения: ' + (error.message || error));
    }
}

function clearEnhanceSlot(slot) {
    slot.path = null;
    slot.sourceName = '';
    slot.coordsPath = null;
    slot.preview.src = '';
    slot.preview.classList.add('hidden');
    slot.label.classList.remove('hidden');
    slot.info.textContent = '';
    if (slot.clearButton) {
        if (slot.key === 'image') {
            slot.clearButton.classList.remove('hidden');
            slot.clearButton.classList.add('is-inactive');
        } else {
            slot.clearButton.classList.add('hidden');
        }
    }
}

function saveBrowserImageForEnhanceSlot(slot, file) {
    if (!file || !String(file.type || '').startsWith('image/')) {
        setStatusBar('Выберите файл изображения.');
        return;
    }
    const extension = path.extname(file.name || '') || '.png';
    const temporaryPath = path.join(os.tmpdir(), 'comfy_enhance_' + slot.key + '_input' + extension);
    const reader = new FileReader();
    reader.onload = () => {
        try {
            fs.writeFileSync(temporaryPath, Buffer.from(reader.result));
            setEnhanceSlotImage(slot, temporaryPath, file.name || path.basename(temporaryPath));
        } catch (error) {
            setStatusBar('Ошибка сохранения изображения: ' + (error.message || error));
        }
    };
    reader.readAsArrayBuffer(file);
}

async function loadEnhanceSlotFromPhotoshop(slot) {
    try {
        setStatusBar('⏳ Экспорт выделения из Photoshop...');
        const data = await psBridge.exportSelection();
        if (!data) throw new Error('Сначала выделите область в Photoshop.');
        const suffix = Date.now() + '_' + slot.key;
        const imagePath = path.join(os.tmpdir(), 'comfy_enhance_' + suffix + '.png');
        const coordsPath = path.join(os.tmpdir(), 'comfy_enhance_' + suffix + '_coords.txt');
        fs.copyFileSync(data.filePath, imagePath);
        if (data.coordsPath && fs.existsSync(data.coordsPath)) fs.copyFileSync(data.coordsPath, coordsPath);
        let sourceName = path.basename(data.filePath);
        try {
            const documentName = await psBridge.getActiveDocumentName();
            if (documentName && documentName !== 'ERROR') sourceName = documentName;
        } catch (ignore) {}
        setEnhanceSlotImage(slot, imagePath, sourceName, fs.existsSync(coordsPath) ? coordsPath : null);
    } catch (error) {
        setStatusBar('Ошибка: ' + (error.message || error));
    }
}

function bindEnhanceImageSlot(slot) {
    if (slot.dropZone) {
        slot.dropZone.addEventListener('click', () => {
            slot.dropZone.focus();
            slot.input.click();
        });
        slot.dropZone.addEventListener('dragover', event => {
            event.preventDefault();
            slot.dropZone.classList.add('drag-over');
        });
        slot.dropZone.addEventListener('dragleave', () => slot.dropZone.classList.remove('drag-over'));
        slot.dropZone.addEventListener('drop', event => {
            event.preventDefault();
            slot.dropZone.classList.remove('drag-over');
            saveBrowserImageForEnhanceSlot(slot, event.dataTransfer.files[0]);
        });
        slot.dropZone.addEventListener('paste', event => {
            for (const item of event.clipboardData.items) {
                if (!item.type.startsWith('image/')) continue;
                saveBrowserImageForEnhanceSlot(slot, item.getAsFile());
                event.preventDefault();
                break;
            }
        });
    }
    if (slot.input) slot.input.addEventListener('change', event => {
        saveBrowserImageForEnhanceSlot(slot, event.target.files[0]);
        event.target.value = '';
    });
    if (slot.selectButton) slot.selectButton.addEventListener('click', () => slot.input.click());
    if (slot.selectionButton) slot.selectionButton.addEventListener('click', () => loadEnhanceSlotFromPhotoshop(slot));
    if (slot.clearButton) slot.clearButton.addEventListener('click', () => clearEnhanceSlot(slot));
}

[enhanceImageSlot, enhanceCombineFirstSlot, enhanceCombineSecondSlot].forEach(bindEnhanceImageSlot);

async function prepareEnhanceInputAtOneMegapixel(sourcePath, temporaryName) {
    const image = await loadUpscaleSourceImage(sourcePath);
    const originalWidth = image.naturalWidth || image.width;
    const originalHeight = image.naturalHeight || image.height;
    const originalPixels = originalWidth * originalHeight;
    if (originalPixels <= 1000000) {
        return { filePath: sourcePath, originalWidth, originalHeight, width: originalWidth, height: originalHeight, reduced: false };
    }
    const scale = Math.sqrt(1000000 / originalPixels);
    let width = Math.max(1, Math.round(originalWidth * scale));
    let height = Math.max(1, Math.round(originalHeight * scale));
    while (width * height > 1000000) {
        if (width >= height) width--; else height--;
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, 0, 0, width, height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('Не удалось подготовить входное изображение размером 1 MP.');
    const filePath = path.join(os.tmpdir(), 'comfy_' + temporaryName + '_1mp.png');
    fs.writeFileSync(filePath, Buffer.from(await blob.arrayBuffer()));
    return { filePath, originalWidth, originalHeight, width, height, reduced: true };
}

function getPngDimensionsFromBuffer(buffer) {
    const png = Buffer.from(buffer || []);
    if (png.length >= 24 && png.toString('ascii', 12, 16) === 'IHDR') {
        return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
    }
    return { width: 0, height: 0 };
}

function getPixelSizeSuffix(width, height) {
    return Math.max(0, Math.round(width)) + 'w_' + Math.max(0, Math.round(height)) + 't_px';
}
function getEnhancePlacementSize(resultBuffer, coordsPath) {
    const generatedSize = getPngDimensionsFromBuffer(resultBuffer);
    let width = generatedSize.width, height = generatedSize.height;
    if (coordsPath && fs.existsSync(coordsPath)) {
        try {
            const parts = fs.readFileSync(coordsPath, 'utf8').trim().split(',').map(Number);
            if (Number.isFinite(parts[2]) && parts[2] > 0) width = Math.round(parts[2]);
            if (Number.isFinite(parts[3]) && parts[3] > 0) height = Math.round(parts[3]);
        } catch (error) {
            console.warn('Не удалось прочитать размер выделения для маски:', error);
        }
    }
    return { width: Math.max(1, width), height: Math.max(1, height) };
}

async function createExactEnhanceFadeMask(resultBuffer, coordsPath, temporaryName, fadeEdges = null) {
    const size = getEnhancePlacementSize(resultBuffer, coordsPath);
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext('2d');
    const pixels = context.createImageData(size.width, size.height);
    const fadePercent = getEnhanceEdgeFadePercent() / 100;
    const fadeX = Math.max(1, Math.round(size.width * fadePercent));
    const fadeY = Math.max(1, Math.round(size.height * fadePercent));
    const edges = fadeEdges || { left: true, right: true, top: true, bottom: true };
    for (let y = 0; y < size.height; y++) {
        let vertical = 1;
        if (edges.top) vertical = Math.min(vertical, Math.max(0, Math.min(1, y / fadeY)));
        if (edges.bottom) vertical = Math.min(vertical, Math.max(0, Math.min(1, (size.height - 1 - y) / fadeY)));
        for (let x = 0; x < size.width; x++) {
            let horizontal = 1;
            if (edges.left) horizontal = Math.min(horizontal, Math.max(0, Math.min(1, x / fadeX)));
            if (edges.right) horizontal = Math.min(horizontal, Math.max(0, Math.min(1, (size.width - 1 - x) / fadeX)));
            const shade = Math.round(255 * horizontal * vertical);
            const offset = (y * size.width + x) * 4;
            pixels.data[offset] = 255;
            pixels.data[offset + 1] = 255;
            pixels.data[offset + 2] = 255;
            pixels.data[offset + 3] = shade;
        }
    }
    context.putImageData(pixels, 0, 0);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('Не удалось создать маску краёв для Photoshop.');
    const filePath = path.join(os.tmpdir(), 'comfy_' + temporaryName + '_exact_edge_mask_' + Date.now() + '.png');
    fs.writeFileSync(filePath, Buffer.from(await blob.arrayBuffer()));
    return filePath;
}

async function placeEnhanceResultWithFadeMask(resultBuffer, useCoords, coordsPath, layerName, temporaryName, fadeEdges = null, targetDocumentId = null, targetGroupId = null) {
    const fadeMaskPath = await createExactEnhanceFadeMask(resultBuffer, coordsPath, temporaryName, fadeEdges);
    try {
        await psBridge.placeImage(resultBuffer, useCoords, coordsPath, layerName, false, true, true, fadeMaskPath, null, targetDocumentId, targetGroupId);
    } finally {
        try { if (fs.existsSync(fadeMaskPath)) fs.unlinkSync(fadeMaskPath); } catch (error) { console.warn('Не удалось удалить временную маску:', error); }
    }
}
function redrawEnhanceMask() {
    if (!enhanceImage || !enhanceMask) return;
    const context = enhanceCanvas.getContext('2d');
    context.clearRect(0, 0, enhanceCanvas.width, enhanceCanvas.height);
    context.drawImage(enhanceImage, 0, 0);
    context.save();
    context.globalAlpha = .48;
    context.drawImage(enhanceMask, 0, 0);
    context.restore();
    if (enhanceCursorPoint) {
        const size = Number(enhanceBrush.value) || 40;
        context.save();
        context.strokeStyle = '#00d4ff';
        context.lineWidth = 2;
        context.beginPath();
        context.arc(enhanceCursorPoint.x, enhanceCursorPoint.y, size / 2, 0, Math.PI * 2);
        context.stroke();
        context.restore();
    }
}

function enhancePointFromEvent(event) {
    const rect = enhanceCanvas.getBoundingClientRect();
    return { x: (event.clientX - rect.left) * enhanceCanvas.width / rect.width, y: (event.clientY - rect.top) * enhanceCanvas.height / rect.height };
}

function paintEnhanceMask(from, to) {
    const size = Number(enhanceBrush.value) || 40;
    enhanceMaskCtx.save();
    enhanceMaskCtx.fillStyle = '#fff';
    enhanceMaskCtx.strokeStyle = '#fff';
    enhanceMaskCtx.lineWidth = size;
    enhanceMaskCtx.lineCap = 'round';
    enhanceMaskCtx.beginPath();
    enhanceMaskCtx.moveTo(from.x, from.y);
    enhanceMaskCtx.lineTo(to.x, to.y);
    enhanceMaskCtx.stroke();
    enhanceMaskCtx.beginPath();
    enhanceMaskCtx.arc(to.x, to.y, size / 2, 0, Math.PI * 2);
    enhanceMaskCtx.fill();
    enhanceMaskCtx.restore();
    enhanceHasMask = true;
    enhanceClearButton.classList.remove('disabled');
    enhanceApplyButton.classList.remove('disabled');
    redrawEnhanceMask();
}

function clearEnhanceMask() {
    if (!enhanceMaskCtx) return;
    enhanceMaskCtx.clearRect(0, 0, enhanceMask.width, enhanceMask.height);
    enhanceHasMask = false;
    enhanceApplyButton.classList.add('disabled');
    redrawEnhanceMask();
}

function openEnhanceMask(filePath, data) {
    const image = new Image();
    image.onload = () => {
        enhanceExportData = data;
        enhanceImage = image;
        enhanceCanvas.width = image.naturalWidth;
        enhanceCanvas.height = image.naturalHeight;
        enhanceMask = document.createElement('canvas');
        enhanceMask.width = image.naturalWidth;
        enhanceMask.height = image.naturalHeight;
        enhanceMaskCtx = enhanceMask.getContext('2d');
        clearEnhanceMask();
        enhanceEditor.classList.remove('hidden');
        setStatusBar('Закрасьте белой кистью область, которую нужно изменить.');
    };
    image.onerror = () => setStatusBar('Не удалось открыть изображение для маски.');
    image.src = 'data:image/png;base64,' + fs.readFileSync(filePath).toString('base64');
}

async function saveEnhanceMaskImage(targetWidth = enhanceCanvas.width, targetHeight = enhanceCanvas.height) {
    const scaledMask = document.createElement('canvas');
    scaledMask.width = targetWidth;
    scaledMask.height = targetHeight;
    const scaledContext = scaledMask.getContext('2d');
    scaledContext.imageSmoothingEnabled = false;
    scaledContext.drawImage(enhanceMask, 0, 0, targetWidth, targetHeight);
    const output = document.createElement('canvas');
    output.width = targetWidth;
    output.height = targetHeight;
    const context = output.getContext('2d');
    const data = context.createImageData(output.width, output.height);
    const mask = scaledContext.getImageData(0, 0, output.width, output.height);
    for (let index = 0; index < data.data.length; index += 4) {
        data.data[index] = 0;
        data.data[index + 1] = 0;
        data.data[index + 2] = 0;
        data.data[index + 3] = mask.data[index + 3] > 0 ? 0 : 255;
    }
    context.putImageData(data, 0, 0);
    const blob = await new Promise(resolve => output.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('Не удалось подготовить PNG-маску.');
    const filePath = path.join(os.tmpdir(), 'comfy_qwen21_mask.png');
    fs.writeFileSync(filePath, Buffer.from(await blob.arrayBuffer()));
    return filePath;
}

async function loadEnhanceObjectSelection() {
    if (isTaskRunning) return;
    try {
        setStatusBar('⏳ Экспорт выделения из Photoshop...');
        const data = await psBridge.exportSelection();
        if (!data) throw new Error('Сначала выделите область в Photoshop.');
        openEnhanceMask(data.filePath, data);
    } catch (error) {
        setStatusBar('Ошибка: ' + (error.message || error));
    }
}

async function runEnhanceObject() {
    if (isTaskRunning) return;
    try {
        if (!enhanceExportData || !enhanceHasMask) throw new Error('Вставьте выделение и закрасьте область для редактирования.');
        const prompt = document.getElementById('enhancePrompt').value.trim();
        if (!prompt) throw new Error('Введите prompt.');
        lockUI('enh_object');
        localTaskStartedAt = Date.now();
        localTaskType = 'enh_object';
        const ip = document.getElementById('serverIP').value || '127.0.0.1:8188';
        setStatusBar('⏳ Подготовка изображения и маски до 1 MP...');
        const preparedInput = await prepareEnhanceInputAtOneMegapixel(enhanceExportData.filePath, 'qwen21_input');
        if (preparedInput.reduced) setStatusBar('⚠ Фрагмент уменьшен: ' + preparedInput.originalWidth + ' × ' + preparedInput.originalHeight + ' → ' + preparedInput.width + ' × ' + preparedInput.height + ' px (1 MP).');
        const originalName = await comfyBridge.uploadImage(ip, preparedInput.filePath);
        const maskName = await comfyBridge.uploadImage(ip, await saveEnhanceMaskImage(preparedInput.width, preparedInput.height));
        const workflow = editWorkflows.createInpaint(getEditModel(), originalName, maskName, prompt);
        applyGeminiEnhancerModel(workflow);
        rememberWorkflowModel(workflow, 'Qwen');
        setStatusBar('⏳ ' + getEditModelLabel() + ' изменяет объект по маске...');
        markComfyProcessingStarted();
        const promptId = await sendWorkflow(ip, workflow);
        const result = await comfyBridge.pollHistory(ip, promptId);
        const buffer = await comfyBridge.downloadImage(ip, result);
        await placeEnhanceResultWithFadeMask(buffer, true, enhanceExportData.coordsPath, generateName('enh_object'), 'enhance_object');
        setStatusBar('✓ Объект изменён.');
        unlockUI();
    } catch (error) {
        setStatusBar('Ошибка: ' + (error.message || error));
        console.error(error);
        unlockUI();
    }
}

function buildEnhanceTileStarts(totalSize, tileSize, overlap) {
    const total = Math.max(1, Math.round(Number(totalSize) || 1));
    const tile = Math.min(total, Math.max(1, Math.round(Number(tileSize) || total)));
    if (total <= tile) return [0];
    const requestedStep = Math.max(1, tile - Math.max(0, Math.round(Number(overlap) || 0)));
    const finalStart = total - tile;
    const tileCount = Math.max(2, Math.ceil(finalStart / requestedStep) + 1);
    const starts = [];
    for (let index = 0; index < tileCount; index++) {
        const position = Math.round(finalStart * index / (tileCount - 1));
        if (!starts.length || starts[starts.length - 1] !== position) starts.push(position);
    }
    return starts;
}
function buildEnhanceAutoTilePlan(documentInfo, tileSize, overlap) {
    const tileWidth = Math.min(tileSize, documentInfo.width);
    const tileHeight = Math.min(tileSize, documentInfo.height);
    const xStarts = buildEnhanceTileStarts(documentInfo.width, tileWidth, overlap);
    const yStarts = buildEnhanceTileStarts(documentInfo.height, tileHeight, overlap);
    const tiles = [];
    yStarts.forEach((y, rowIndex) => {
        const rowX = rowIndex % 2 === 0 ? xStarts.slice() : xStarts.slice().reverse();
        rowX.forEach(x => {
            tiles.push({
                x,
                y,
                width: Math.min(tileWidth, documentInfo.width - x),
                height: Math.min(tileHeight, documentInfo.height - y),
                fadeEdges: {
                    left: x > 0,
                    right: x + tileWidth < documentInfo.width,
                    top: y > 0,
                    bottom: y + tileHeight < documentInfo.height
                }
            });
        });
    });
    return tiles;
}

function ensureEnhanceAutoActive() {
    if (!isTaskRunning || localTaskType !== 'enh_image_auto') throw new Error('Операция отменена.');
}
async function generateEnhanceAutoTile(ip, tileData, prompt, tileNumber, totalTiles) {
    const progress = tileNumber + '/' + totalTiles;
    ensureEnhanceAutoActive();
    setStatusBar('⏳ Тайл ' + progress + ': подготовка до 1 MP...');
    const preparedInput = await prepareEnhanceInputAtOneMegapixel(tileData.filePath, 'qwen21_enhance_auto_' + tileNumber);
    ensureEnhanceAutoActive();
    setStatusBar('⏳ Тайл ' + progress + ': загрузка в ComfyUI...');
    const imageName = await comfyBridge.uploadImage(ip, preparedInput.filePath);
    ensureEnhanceAutoActive();
    const workflow = editWorkflows.createEdit(getEditModel(), imageName, prompt, getColorMatchOptions());
    rememberWorkflowModel(workflow, 'Qwen');
    setStatusBar('⏳ Тайл ' + progress + ': ' + getEditModelLabel() + ' улучшает картинку...');
    if (!localComfyStartedAt) markComfyProcessingStarted();
    ensureEnhanceAutoActive();
    const promptId = await sendWorkflow(ip, workflow);
    ensureEnhanceAutoActive();
    const result = await comfyBridge.pollHistory(ip, promptId);
    ensureEnhanceAutoActive();
    const buffer = await comfyBridge.downloadImage(ip, result);
    return { buffer, preparedInput };
}
async function runImageEditAuto() {
    if (isTaskRunning) return;
    const prompt = enhanceImagePromptInput ? enhanceImagePromptInput.value.trim() : '';
    if (!prompt) {
        setStatusBar('Ошибка: введите prompt.');
        return;
    }

    const exportedTiles = [];
    try {
        lockUI('enh_image_auto');
        localTaskStartedAt = Date.now();
        localTaskType = 'enh_image_auto';
        lastEnhanceAutoInfo = null;
        setStatusBar('⏳ Получение размера активного документа Photoshop...');
        const documentInfo = await psBridge.getActiveDocumentInfo();
        ensureEnhanceAutoActive();
        if (!documentInfo.width || !documentInfo.height) throw new Error('Активный документ Photoshop имеет некорректный размер.');

        const settings = getEnhanceAutoSettings();
        const minimumOverlap = Math.ceil(settings.tileSize * getEnhanceEdgeFadePercent() * 2 / 100);
        const overlap = Math.min(settings.tileSize - 100, Math.max(settings.overlap, minimumOverlap));
        const tiles = buildEnhanceAutoTilePlan(documentInfo, settings.tileSize, overlap);
        if (!tiles.length) throw new Error('Не удалось рассчитать тайлы документа.');

        lastEnhanceAutoInfo = {
            documentName: documentInfo.name,
            documentWidth: documentInfo.width,
            documentHeight: documentInfo.height,
            tileSize: settings.tileSize,
            overlap,
            total: tiles.length,
            completed: 0
        };

        if (overlap !== settings.overlap) {
            setStatusBar('⚠ Нахлёст автоматически увеличен до ' + overlap + ' px под фейд ' + getEnhanceEdgeFadePercent() + '%.');
        }
        for (let index = 0; index < tiles.length; index++) {
            ensureEnhanceAutoActive();
            const tile = tiles[index];
            setStatusBar('⏳ Сохранение исходных фрагментов: ' + (index + 1) + '/' + tiles.length + '...');
            exportedTiles.push(await psBridge.exportDocumentTile(tile.x, tile.y, tile.width, tile.height, index, documentInfo.documentId));
        }
        ensureEnhanceAutoActive();
        const groupName = generateName('enh_auto') + '_Tiles';
        const groupId = await psBridge.createLayerGroup(groupName, documentInfo.documentId);
        ensureEnhanceAutoActive();
        const ip = document.getElementById('serverIP').value || '127.0.0.1:8188';
        for (let index = 0; index < tiles.length; index++) {
            if (!isTaskRunning) throw new Error('Операция отменена.');
            const tile = tiles[index];
            let exportedTile = null;
            let preparedPath = null;
            try {
                setStatusBar('⏳ Тайл ' + (index + 1) + '/' + tiles.length + ': экспорт из Photoshop...');
                exportedTile = exportedTiles[index];
                ensureEnhanceAutoActive();
                const generated = await generateEnhanceAutoTile(ip, exportedTile, prompt, index + 1, tiles.length);
                ensureEnhanceAutoActive();
                preparedPath = generated.preparedInput.filePath;
                const generatedSize = getPngDimensionsFromBuffer(generated.buffer);
                const tileLayerName = 'Enhance_Tile_' + String(index + 1).padStart(2, '0') + '_' + getPixelSizeSuffix(generatedSize.width, generatedSize.height);
                setStatusBar('⏳ Тайл ' + (index + 1) + '/' + tiles.length + ': точная вставка и слой-маска...');
                await placeEnhanceResultWithFadeMask(
                    generated.buffer,
                    true,
                    exportedTile.coordsPath,
                    tileLayerName,
                    'enhance_auto_' + (index + 1),
                    tile.fadeEdges,
                    documentInfo.documentId,
                    groupId
                );
                ensureEnhanceAutoActive();
                lastEnhanceAutoInfo.completed = index + 1;
            } finally {
                const temporaryPaths = [];
                if (exportedTile) temporaryPaths.push(exportedTile.filePath, exportedTile.coordsPath);
                if (preparedPath && (!exportedTile || preparedPath !== exportedTile.filePath)) temporaryPaths.push(preparedPath);
                temporaryPaths.filter(Boolean).forEach(filePath => {
                    try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (error) { console.warn('Не удалось удалить временный тайл:', error); }
                });
            }
        }

        setStatusBar('✓ Документ улучшен: ' + tiles.length + ' тайлов собрано в группе ' + groupName + '.');
        unlockUI();
    } catch (error) {
        const ownsTask = localTaskType === 'enh_image_auto';
        const cancelled = String(error && (error.message || error)).indexOf('Polling aborted') >= 0 || String(error && (error.message || error)).indexOf('Операция отменена') >= 0;
        if (ownsTask && !cancelled) setStatusBar('Ошибка авто-улучшения: ' + (error.message || error));
        console.error(error);
        if (ownsTask) unlockUI();
    } finally {
        for (const tile of exportedTiles) {
            for (const filePath of [tile.filePath, tile.coordsPath]) {
                try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (_) {}
            }
        }
    }
}

async function runImageEdit() {
    if (isTaskRunning) return;
    try {
        if (!enhanceImageSlot.path) throw new Error('Добавьте картинку для улучшения.');
        const prompt = document.getElementById('enhanceImagePrompt').value.trim();
        if (!prompt) throw new Error('Введите prompt.');
        lockUI('enh_image');
        localTaskStartedAt = Date.now();
        localTaskType = 'enh_image';
        const ip = document.getElementById('serverIP').value || '127.0.0.1:8188';
        setStatusBar('⏳ Подготовка изображения до 1 MP...');
        const preparedInput = await prepareEnhanceInputAtOneMegapixel(enhanceImageSlot.path, 'qwen21_image_edit_input');
        if (preparedInput.reduced) setStatusBar('⚠ Картинка уменьшена: ' + preparedInput.originalWidth + ' × ' + preparedInput.originalHeight + ' → ' + preparedInput.width + ' × ' + preparedInput.height + ' px (1 MP).');
        setStatusBar('⏳ Загрузка изображения в ComfyUI...');
        const imageName = await comfyBridge.uploadImage(ip, preparedInput.filePath);
        const workflow = editWorkflows.createEdit(getEditModel(), imageName, prompt, getColorMatchOptions());
        rememberWorkflowModel(workflow, 'Qwen');
        setStatusBar('⏳ ' + getEditModelLabel() + ' улучшает картинку...');
        markComfyProcessingStarted();
        const promptId = await sendWorkflow(ip, workflow);
        const result = await comfyBridge.pollHistory(ip, promptId);
        const buffer = await comfyBridge.downloadImage(ip, result);
        // Keep the original ComfyUI dimensions in the name, before Photoshop scales the layer.
        const generatedSize = getPngDimensionsFromBuffer(buffer);
        const layerName = generateName('enh_image') + '_' + getPixelSizeSuffix(generatedSize.width, generatedSize.height);
        await placeEnhanceResultWithFadeMask(buffer, Boolean(enhanceImageSlot.coordsPath), enhanceImageSlot.coordsPath, layerName, 'enhance_image');
        setStatusBar('✓ Картинка улучшена.');
        unlockUI();
    } catch (error) {
        setStatusBar('Ошибка: ' + (error.message || error));
        console.error(error);
        unlockUI();
    }
}

async function runImageCombine() {
    if (isTaskRunning) return;
    try {
        if (!enhanceCombineFirstSlot.path || !enhanceCombineSecondSlot.path) throw new Error('Добавьте обе картинки для совмещения.');
        const prompt = document.getElementById('enhanceCombinePrompt').value.trim();
        if (!prompt) throw new Error('Введите prompt.');
        lockUI('enh_combine');
        localTaskStartedAt = Date.now();
        localTaskType = 'enh_combine';
        const ip = document.getElementById('serverIP').value || '127.0.0.1:8188';
        setStatusBar('⏳ Подготовка двух картинок до 1 MP...');
        const firstInput = await prepareEnhanceInputAtOneMegapixel(enhanceCombineFirstSlot.path, 'qwen21_combine_first');
        const secondInput = await prepareEnhanceInputAtOneMegapixel(enhanceCombineSecondSlot.path, 'qwen21_combine_second');
        if (firstInput.reduced || secondInput.reduced) setStatusBar('⚠ Картинки для совмещения приведены к 1 MP.');
        setStatusBar('⏳ Загрузка двух картинок в ComfyUI...');
        const firstName = await comfyBridge.uploadImage(ip, firstInput.filePath);
        const secondName = await comfyBridge.uploadImage(ip, secondInput.filePath);
        const workflow = editWorkflows.createCombine(getEditModel(), firstName, secondName, prompt);
        rememberWorkflowModel(workflow, 'Qwen');
        setStatusBar('⏳ ' + getEditModelLabel() + ' совмещает картинки...');
        markComfyProcessingStarted();
        const promptId = await sendWorkflow(ip, workflow);
        const result = await comfyBridge.pollHistory(ip, promptId);
        const buffer = await comfyBridge.downloadImage(ip, result);
        await psBridge.placeImage(buffer, Boolean(enhanceCombineFirstSlot.coordsPath), enhanceCombineFirstSlot.coordsPath, generateName('enh_combine'));
        setStatusBar('✓ Картинки совмещены.');
        unlockUI();
    } catch (error) {
        setStatusBar('Ошибка: ' + (error.message || error));
        console.error(error);
        unlockUI();
    }
}

if (enhanceBrush) enhanceBrush.addEventListener('input', () => enhanceBrushValue.textContent = enhanceBrush.value + ' px');
if (enhanceCanvas) {
    enhanceCanvas.addEventListener('pointerdown', event => {
        if (!enhanceImage) return;
        enhanceDrawing = true;
        enhancePoint = enhancePointFromEvent(event);
        enhanceCanvas.setPointerCapture(event.pointerId);
        paintEnhanceMask(enhancePoint, enhancePoint);
    });
    enhanceCanvas.addEventListener('pointermove', event => {
        if (!enhanceImage) return;
        const point = enhancePointFromEvent(event);
        enhanceCursorPoint = point;
        if (enhanceDrawing) {
            paintEnhanceMask(enhancePoint, point);
            enhancePoint = point;
        } else {
            redrawEnhanceMask();
        }
    });
    enhanceCanvas.addEventListener('pointerleave', () => {
        enhanceCursorPoint = null;
        redrawEnhanceMask();
    });
    const stopDrawing = () => { enhanceDrawing = false; enhancePoint = null; };
    enhanceCanvas.addEventListener('pointerup', stopDrawing);
    enhanceCanvas.addEventListener('pointercancel', stopDrawing);
}
if (enhanceLoadButton) enhanceLoadButton.addEventListener('click', loadEnhanceObjectSelection);
if (enhanceClearButton) enhanceClearButton.addEventListener('click', clearEnhanceMask);
if (enhanceApplyButton) enhanceApplyButton.addEventListener('click', runEnhanceObject);
const enhanceImageApplyButton = document.getElementById('btn_enhance_image_apply');
const enhanceImageAutoButton = document.getElementById('btn_enhance_image_auto');
const enhanceCombineApplyButton = document.getElementById('btn_enhance_combine_apply');
if (enhanceImageApplyButton) enhanceImageApplyButton.addEventListener('click', runImageEdit);
if (enhanceImageAutoButton) enhanceImageAutoButton.addEventListener('click', runImageEditAuto);
if (enhanceCombineApplyButton) enhanceCombineApplyButton.addEventListener('click', runImageCombine);

// =====================================================================
// 11. ДЕЙСТВИЯ (Actions) И ГЕНЕРАЦИЯ ИМЕН
// =====================================================================

let lastDesignPath = null;
let lastDesignName = null;
let lastMockupDocName = null;
let lastMockupOutputStem = null;
let lastMockupTemplateName = null;
let lastMockupAiInfo = null;
let mockupDesignPath = null;
const reservedMockupResultNames = new Set();
const MOCKUP_DESIGN_FILE = path.join(os.tmpdir(), 'comfy_mockup_design.png');

function getUiVal(id) { return document.getElementById(id).value; }
function getLoraName(sliderId) {
    const v = parseFloat(getUiVal(sliderId));
    const map = { 'slider_enh_lora': ["None", "Detail", "Repair"], 'slider_gen_lora': ["None", "Style A", "Style B"] };
    return map[sliderId][v] || "None";
}
function sanitize(str) { return str ? str.replace(/[\\/:*?"<>|]/g, '').trim().replace(/\s+/g, '_').substring(0, 40) : "none"; }
function getDesignName() { return sanitize((lastDesignName || "Design").replace(/\.psd|\.psb|\.png|\.jpg|\.jpeg/i, '')); }
function isGenMode(mode) { const r = document.querySelector(`input[name="genMode"][value="${mode}"]`); return r && r.checked; }

const MOCKUP_PLAIN_WHITE_WALL_PROMPT = 'Create a photorealistic interior mockup prepared for manual design placement in Photoshop. Use the supplied design only as a color palette and style reference for furniture, decor and accessories; do not generate it as wallpaper or a wall pattern. The single main feature wall must be a continuous, clean, matte neutral-white painted surface with generous empty space for placing the design later. It must have no wallpaper, print, mural, artwork, decor, molding, paneling, tile, brick, texture, colored light or furniture covering it. Use a clear, balanced and visible palette from the supplied design in the rest of the room: furniture, textiles, curtains, rugs, accessories and decor. Do not make the whole room white, monochrome, washed out, empty or high-key. Keep normal natural exposure and a rich, harmonious interior.';
const MOCKUP_PLAIN_WHITE_WALL_GEMINI_PROMPT = 'You are an interior color-palette analyst and prompt writer. Analyze the supplied design only as a color palette and mood reference for furniture, decor and accessories. Never describe, preserve, copy or reuse its objects, motif, pattern, artwork or wallpaper. Write one concise English prompt for a photorealistic interior mockup prepared for manual design placement in Photoshop. NON-NEGOTIABLE: only one main feature wall is a continuous, blank, smooth, matte neutral-white painted surface with generous empty space. It has no wallpaper, pattern, print, mural, artwork, wall decor, molding, paneling, tile, brick, texture, colored light or furniture covering it. The wall must be clearly visible, pure white and usable for design placement. Make the rest of the room visibly colorful with a balanced palette extracted from the supplied design in furniture, textiles, rugs, curtains, accessories and small decor. Do not make the whole interior white, monochrome, washed out, empty or high-key. Maintain normal natural exposure and a rich, harmonious interior. Output only the final prompt.';
const MOCKUP_ARTWORK_GEMINI_PROMPT = 'You are a senior product-mockup art director and visual prompt writer. Analyze the supplied reference as the ARTWORK that must appear inside framed wall art, never as an existing room, wallpaper, mural, textile, furniture print, or general decoration. Preserve the artwork visual identity, recognizable subject, composition, palette, drawing or painting style, orientation, and panel order as faithfully as the image generator permits. Follow the user instructions for exactly one artwork or exactly three artworks. For three artworks: if the reference contains three panels or designs, map them left-to-right into the left, center, and right frames; never reorder them, duplicate one panel, merge them, or create a fourth frame. Keep all artwork strictly inside the frame openings. Do not add extra framed art, blank frames, unrelated pictures, captions, labels, logos, watermarks, or glare that hides the design. The surrounding room must be newly composed, photorealistic, commercially polished, physically plausible, and subordinate to the artwork. Write one cohesive English generation prompt, concise but spatially explicit, with the exact frame count repeated clearly. Output only the final prompt without explanations, markdown, headings, quotes, or JSON. USER INSTRUCTIONS: ';

function getMockupChoiceValue(name) {
    const select = document.getElementById(name);
    if (select) return String(select.value || '').trim();
    const selected = document.querySelector('input[name="' + name + '"]:checked');
    return selected ? String(selected.value || '').trim() : '';
}

function getMockupChoiceLabel(name) {
    const select = document.getElementById(name);
    if (select && select.selectedOptions && select.selectedOptions.length) {
        return String(select.selectedOptions[0].textContent || '').trim();
    }
    const selected = document.querySelector('input[name="' + name + '"]:checked');
    return selected && selected.parentElement ? String(selected.parentElement.textContent || '').trim() : '';
}

function getMockupAdditionalPrompt(kind = getMockupAiKind()) {
    const input = kind === 'artwork' ? mockupArtAdditionalPromptInput : mockupAdditionalPromptInput;
    return input ? input.value.trim() : '';
}

function getMockupArtworkPlacementId(count = getMockupArtCount()) {
    return Number(count) === 3 ? 'mockupArtPlacementTriple' : 'mockupArtPlacementSingle';
}

function getMockupArtworkCountPrompt(count) {
    if (Number(count) === 3) {
        return [
            'Generate EXACTLY THREE framed artworks, no more and no fewer',
            'the three frames are separate, equally important, consistently sized, evenly spaced, and shown together in one coherent mockup',
            'preserve the reference panel order from left to right: left artwork to left frame, center artwork to center frame, right artwork to right frame',
            'never repeat the same artwork in all three frames and never create extra wall art anywhere else'
        ].join('; ');
    }
    return [
        'Generate EXACTLY ONE framed artwork and no other pictures or frames anywhere in the scene',
        'the supplied reference artwork fills that single frame opening and remains the unmistakable focal product',
        'do not duplicate, tile, crop away, or replace the artwork'
    ].join('; ');
}

function getMockupWallpaperAutoPrompt() {
    return [
        MOCKUP_PLAIN_WHITE_WALL_PROMPT,
        getMockupChoiceValue('mockupRoom'),
        getMockupChoiceValue('mockupInteriorStyle'),
        getMockupChoiceValue('mockupComposition'),
        getMockupChoiceValue('mockupWallAngle'),
        getMockupAdditionalPrompt('wallpaper')
    ].filter(Boolean).join('. ');
}

function getMockupArtworkAutoPrompt(count = getMockupArtCount()) {
    const placementId = getMockupArtworkPlacementId(count);
    return [
        'Create a premium photorealistic commercial mockup for framed wall art using the supplied image as the artwork content',
        'the supplied image is not wallpaper, not a mural, and not an interior reference; its visual content belongs only inside the frame opening or frame openings',
        getMockupArtworkCountPrompt(count),
        getMockupChoiceValue('mockupArtRoom'),
        getMockupChoiceValue('mockupArtInteriorStyle'),
        getMockupChoiceValue(placementId),
        getMockupChoiceValue('mockupArtFrame'),
        getMockupChoiceValue('mockupArtMat'),
        getMockupChoiceValue('mockupArtOrientation'),
        getMockupChoiceValue('mockupArtCamera'),
        getMockupChoiceValue('mockupArtLighting'),
        'keep frame edges straight and physically plausible; preserve clear readable artwork with realistic print texture, natural shadows, and no strong glass reflections',
        'the room may harmonize with the artwork palette, but must never copy the artwork motif onto walls, fabrics, furniture, or decor',
        getMockupAdditionalPrompt('artwork')
    ].filter(Boolean).join('. ');
}

function getMockupAutoPrompt(kind = getMockupAiKind(), artCount = getMockupArtCount()) {
    return kind === 'artwork' ? getMockupArtworkAutoPrompt(artCount) : getMockupWallpaperAutoPrompt();
}

function getMockupImg2ImgGenerationOptions() {
    const seed = ensureMockupAiSeed();
    const mockupKind = getMockupAiKind();
    const artCount = getMockupArtCount();
    const placementId = getMockupArtworkPlacementId(artCount);
    const model = 'krea2';
    const optionValues = mockupKind === 'artwork' ? {
        room: getMockupChoiceValue('mockupArtRoom'),
        interiorStyle: getMockupChoiceValue('mockupArtInteriorStyle'),
        placement: getMockupChoiceValue(placementId),
        frame: getMockupChoiceValue('mockupArtFrame'),
        mat: getMockupChoiceValue('mockupArtMat'),
        orientation: getMockupChoiceValue('mockupArtOrientation'),
        camera: getMockupChoiceValue('mockupArtCamera'),
        lighting: getMockupChoiceValue('mockupArtLighting')
    } : {
        room: getMockupChoiceValue('mockupRoom'),
        interiorStyle: getMockupChoiceValue('mockupInteriorStyle'),
        composition: getMockupChoiceValue('mockupComposition'),
        wallAngle: getMockupChoiceValue('mockupWallAngle')
    };
    const optionLabels = mockupKind === 'artwork' ? {
        room: getMockupChoiceLabel('mockupArtRoom'),
        interiorStyle: getMockupChoiceLabel('mockupArtInteriorStyle'),
        placement: getMockupChoiceLabel(placementId),
        frame: getMockupChoiceLabel('mockupArtFrame'),
        mat: getMockupChoiceLabel('mockupArtMat'),
        orientation: getMockupChoiceLabel('mockupArtOrientation'),
        camera: getMockupChoiceLabel('mockupArtCamera'),
        lighting: getMockupChoiceLabel('mockupArtLighting')
    } : {
        room: getMockupChoiceLabel('mockupRoom'),
        interiorStyle: getMockupChoiceLabel('mockupInteriorStyle'),
        composition: getMockupChoiceLabel('mockupComposition'),
        wallAngle: getMockupChoiceLabel('mockupWallAngle')
    };
    return {
        removeWall: mockupKind === 'wallpaper' && Boolean(document.getElementById('mockupRemoveWall')?.checked),
        prompt: getMockupAutoPrompt(mockupKind, artCount),
        aspectRatio: getMockupAiAspectRatio().value,
        aspectRatioLabel: getMockupAiAspectRatio().label,
        megapixels: Number(getUiVal('slider_mockup_ai_megapixels')),
        seed,
        promptEnhance: true,
        model,
        mockupKind,
        artCount,
        resultKind: mockupKind === 'artwork' ? (artCount === 3 ? 'ai_art_triple' : 'ai_art_single') : 'ai_wallpaper',
        additionalPrompt: getMockupAdditionalPrompt(mockupKind),
        optionValues,
        optionLabels
    };
}

function getGenerationRequestType() {
    return 'gen_' + selectedImageModel(genModelSelect);
}


function getImg2ImgRequestType() {
    return 'img2img_' + selectedImageModel(img2imgModelSelect);
}

function getImg2ImgGenerationOptions() {
    const prompt = getSeamlessPatternPrompt(document.getElementById('img2imgPrompt').value, img2imgSeamlessPatternCheckbox);
    if (!prompt) throw new Error('Введите prompt для img2img.');
    const seedText = img2imgSeedInput ? img2imgSeedInput.value.trim() : '';
    if (!/^\d+$/.test(seedText)) throw new Error('Seed img2img должен состоять только из цифр.');
    const seed = Number(seedText);
    if (!Number.isSafeInteger(seed)) throw new Error('Seed img2img находится вне допустимого диапазона.');

    return {
        prompt,
        aspectRatio: getImg2ImgAspectRatio().value,
        megapixels: Number(getUiVal('slider_img2img_megapixels')),
        seed,
        promptEnhance: Boolean(img2imgPromptEnhance && img2imgPromptEnhance.checked)
    };
}
function getKreaGenerationOptions() {
    const prompt = getSeamlessPatternPrompt(document.getElementById('promptInput').value, genSeamlessPatternCheckbox);
    if (!prompt) throw new Error('Введите prompt.');

    const seedText = kreaSeedInput ? kreaSeedInput.value.trim() : '';
    if (!/^\d+$/.test(seedText)) throw new Error('Seed должен состоять только из цифр.');
    const seed = Number(seedText);
    if (!Number.isSafeInteger(seed)) throw new Error('Seed находится вне допустимого диапазона.');

    return {
        prompt,
        aspectRatio: getKreaAspectRatio().value,
        megapixels: Number(getUiVal('slider_krea_megapixels')),
        seed,
        promptEnhance: Boolean(kreaPromptEnhance && kreaPromptEnhance.checked)
    };
}

function getVariationGenerationOptions() {
    if (!variationSelectedImagePath) throw new Error('Добавьте исходное изображение.');
    const mode = isGenMode('triptych') ? 'triptych' : 'variations';
    const seedText = variationSeedInput ? variationSeedInput.value.trim() : '';
    if (!/^\d+$/.test(seedText)) throw new Error('Базовый seed должен состоять только из цифр.');
    const seed = Number(seedText);
    if (!Number.isSafeInteger(seed) || seed > Number.MAX_SAFE_INTEGER - 2) throw new Error('Базовый seed находится вне допустимого диапазона.');
    const seriesText = variationSeriesNumberInput ? variationSeriesNumberInput.value.trim() : '';
    let seriesNumber = null;
    if (seriesText) {
        const match = seriesText.match(/^p?(\d+)$/i);
        if (!match) throw new Error('Номер серии должен выглядеть как 128 или p128.');
        seriesNumber = Number(match[1]);
        if (!Number.isSafeInteger(seriesNumber) || seriesNumber < 1 || seriesNumber > 999999) {
            throw new Error('Номер серии должен быть целым числом от 1 до 999999.');
        }
    }
    return {
        mode,
        model: getVariationModel(),
        sourcePath: variationSelectedImagePath,
        sourceName: variationSelectedSourceName || path.basename(variationSelectedImagePath),
        additionalPrompt: variationPromptInput ? variationPromptInput.value.trim() : '',
        aspectRatio: getVariationAspectRatio().value,
        megapixels: Number(getUiVal('slider_variation_megapixels')),
        similarity: Number(getUiVal('slider_variation_similarity')) || 75,
        seed,
        seriesNumber
    };
}

function getVariationTaskType(options) {
    return 'gen_' + options.mode + '_' + options.model;
}

function configureThreeResultWorkflow(workflow, options, comfyName) {
    const requiredNodeIds = ['17', '49', '100', '112', '114', '115', '116', '117', '118', '122', '124', '125', '126', '127', '128', '132', '134', '135', '136', '137', '138', '30:28', '30:29', '30:51'];
    const missingNode = requiredNodeIds.find(nodeId => !workflow[nodeId]);
    if (missingNode) throw new Error('В графе трёх результатов отсутствует нода ' + missingNode + '.');
    workflow['17'].inputs.image = comfyName;
    workflow['49'].inputs.aspect_ratio = options.aspectRatio;
    workflow['49'].inputs.megapixels = options.megapixels;
    workflow['100'].inputs.value = options.mode === 'triptych'
        ? 'maximum reconstruction fidelity'
        : 'high reference similarity (' + Math.round(options.similarity) + '%)';

    const instructionIds = ['112', '122', '132'];
    if (options.additionalPrompt) {
        instructionIds.forEach(nodeId => {
            workflow[nodeId].inputs.value = String(workflow[nodeId].inputs.value || '') + '\nAdditional user instruction: ' + options.additionalPrompt;
        });
    }

    const samplerIds = ['116', '126', '136'];
    const encodeIds = ['115', '125', '135'];
    const decodeIds = ['117', '127', '137'];
    const saveIds = ['118', '128', '138'];
    const modePrefix = options.mode === 'triptych' ? 'triptych' : 'series_variation';
    const similarity = Math.max(50, Math.min(95, options.similarity));
    const firstDenoise = Math.max(0.52, Math.min(0.86, 1.18 - similarity * 0.0065));
    const turboDenoise = [firstDenoise, Math.min(0.97, firstDenoise + 0.12), Math.min(1, firstDenoise + 0.22)];

    if (options.model === 'krea2') {
        workflow['30:28'] = { class_type: 'UNETLoader', inputs: { unet_name: 'krea2_turbo_fp8_scaled.safetensors', weight_dtype: 'default' }, _meta: { title: 'Krea 2 Turbo' } };
        workflow['30:51'] = { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen3vl_4b_fp8_scaled.safetensors', type: 'krea2', device: 'default' }, _meta: { title: 'Krea 2 CLIP' } };
        workflow['30:29'] = { class_type: 'VAELoader', inputs: { vae_name: 'qwen_image_vae.safetensors' }, _meta: { title: 'Krea 2 VAE' } };
        workflow.cfb_three_result_latent = { class_type: 'EmptyLatentImage', inputs: { width: ['49', 0], height: ['49', 1], batch_size: 1 } };
    } else if (options.mode === 'triptych') {
        workflow.cfb_three_result_latent = { class_type: 'EmptySD3LatentImage', inputs: { width: ['49', 0], height: ['49', 1], batch_size: 1 } };
    }

    samplerIds.forEach((samplerId, index) => {
        const sampler = workflow[samplerId];
        sampler.inputs.seed = options.seed + index;
        sampler.inputs.steps = 8;
        sampler.inputs.cfg = 1;
        sampler.inputs.scheduler = 'simple';
        workflow['cfb_three_negative_' + (index + 1)] = { class_type: 'ConditioningZeroOut', inputs: { conditioning: [encodeIds[index], 0] } };
        sampler.inputs.negative = ['cfb_three_negative_' + (index + 1), 0];
        if (options.model === 'krea2') {
            sampler.inputs.model = ['30:28', 0];
            sampler.inputs.sampler_name = 'euler';
            sampler.inputs.denoise = 1;
            sampler.inputs.latent_image = ['cfb_three_result_latent', 0];
            workflow[decodeIds[index]].inputs.vae = ['30:29', 0];
        } else {
            sampler.inputs.model = ['30:11', 0];
            sampler.inputs.sampler_name = 'res_multistep';
            sampler.inputs.denoise = options.mode === 'triptych' ? 1 : Number(turboDenoise[index].toFixed(3));
            if (options.mode === 'triptych') sampler.inputs.latent_image = ['cfb_three_result_latent', 0];
        }
        workflow[saveIds[index]].inputs.filename_prefix = 'ComfyFloatBar/' + modePrefix + '_' + String(index + 1).padStart(2, '0');
    });
    return workflow;
}

function configureKrea2Workflow(wf, options) {
    if (!wf['30:19'] || !wf['49'] || !wf['30:3'] || !wf['30:24']) throw new Error('В графе отсутствуют обязательные ноды.');
    wf['30:19'].inputs.value = options.prompt;
    wf['49'].inputs.aspect_ratio = options.aspectRatio;
    wf['49'].inputs.megapixels = options.megapixels;
    wf['30:3'].inputs.seed = options.seed;
    wf['30:24'].inputs.value = options.promptEnhance;
}

function configureMockupAiWorkflow(wf, options) {
    const isArtworkMockup = options && options.mockupKind === 'artwork';
    if (wf['30:18'] && wf['30:18'].inputs) {
        wf['30:18'].inputs.value = isArtworkMockup ? MOCKUP_ARTWORK_GEMINI_PROMPT : MOCKUP_PLAIN_WHITE_WALL_GEMINI_PROMPT;
    }

    if (!isArtworkMockup && wf['30:41'] && wf['30:3'] && wf['30:3'].inputs) {
        wf.cfb_plain_white_wall_latent = {
            class_type: 'EmptySD3LatentImage',
            inputs: { width: ['49', 0], height: ['49', 1], batch_size: 1 }
        };
        wf['30:3'].inputs.latent_image = ['cfb_plain_white_wall_latent', 0];
        wf['30:3'].inputs.denoise = 1;
    }

    const filenamePrefix = isArtworkMockup
        ? (options.artCount === 3 ? 'ComfyFloatBar/mockup_art_3' : 'ComfyFloatBar/mockup_art_1')
        : 'ComfyFloatBar/mockup_wallpaper';
    if (wf['9'] && wf['9'].inputs) wf['9'].inputs.filename_prefix = filenamePrefix;
    if (wf['29'] && wf['29'].inputs) wf['29'].inputs.filename_prefix = filenamePrefix;
}
const RMBG_MODEL_BY_PRESET = Object.freeze({
    clean: 'BiRefNet-general',
    detail: 'BiRefNet-HR-matting',
    graphic: 'BiRefNet_toonout',
    soft: 'BiRefNet-matting'
});

const RMBG_SENSITIVITY_BY_PRESET = Object.freeze({
    clean: 0.94,
    detail: 0.88,
    graphic: 0.94,
    soft: 0.90
});

function getRemoveBackgroundModelName(options = getRemoveBackgroundOptions()) {
    if (options?.model === 'qwen21') return 'Qwen';
    if (!options || options.preset === 'raw') return 'BiRefNet (базовая модель)';
    return RMBG_MODEL_BY_PRESET[options.preset] || RMBG_MODEL_BY_PRESET.clean;
}

const RMBG_TILE_TRIGGER_FACTOR = 1.55;
const RMBG_STANDARD_TILE_SIZE = 1408;
const RMBG_STANDARD_TILE_OVERLAP = 256;
const RMBG_HR_TILE_SIZE = 2048;
const RMBG_HR_TILE_OVERLAP = 320;

function getRemoveBackgroundTilingConfig(options, sourceSize) {
    const width = Math.max(0, Math.round(Number(sourceSize && sourceSize.width) || 0));
    const height = Math.max(0, Math.round(Number(sourceSize && sourceSize.height) || 0));
    const maxDimension = Math.max(width, height);
    const highResolutionModel = options && options.preset === 'detail';
    const nativeResolution = highResolutionModel ? 2048 : 1024;
    const tiled = width > 0 && height > 0 && maxDimension > Math.round(nativeResolution * RMBG_TILE_TRIGGER_FACTOR);
    const tileSize = highResolutionModel ? RMBG_HR_TILE_SIZE : RMBG_STANDARD_TILE_SIZE;
    const overlap = highResolutionModel ? RMBG_HR_TILE_OVERLAP : RMBG_STANDARD_TILE_OVERLAP;
    const guideExpand = Math.max(8, Math.min(24, Math.round(maxDimension * 0.005)));
    return { width, height, tiled, tileSize, overlap, guideExpand };
}

function configureRemoveBackgroundWorkflow(workflow, options = getRemoveBackgroundOptions(), sourceSize = null) {
    const node = workflow && workflow['11'];
    if (!node || node.class_type !== 'BiRefNetRMBG' || !node.inputs) return workflow;

    const baseSensitivity = RMBG_SENSITIVITY_BY_PRESET[options.preset] ?? RMBG_SENSITIVITY_BY_PRESET.clean;
    const sensitivity = Math.max(0.70, Math.min(1,
        baseSensitivity
        + (options.cleanup - 50) * 0.0015
        - (options.detail - 50) * 0.0015
    ));

    node.inputs.model = getRemoveBackgroundModelName(options);
    node.inputs.sensitivity = Number(sensitivity.toFixed(3));
    node.inputs.mask_blur = options.preset === 'soft' ? 1 : 0;
    node.inputs.mask_offset = Math.max(0, Math.min(3, options.edgeExpand));
    node.inputs.invert_output = false;
    node.inputs.refine_foreground = Boolean(options.decontaminate);
    node.inputs.background = 'Alpha';

    const tiling = getRemoveBackgroundTilingConfig(options, sourceSize);
    if (!tiling.tiled) return workflow;

    const globalNode = JSON.parse(JSON.stringify(node));
    globalNode.inputs.image = ['1', 0];
    globalNode.inputs.refine_foreground = Boolean(options.decontaminate);
    globalNode._meta = { title: 'BiRefNet — глобальная направляющая' };

    node.inputs.image = ['20', 0];
    node.inputs.refine_foreground = false;
    node._meta = { title: 'BiRefNet — детальные тайлы' };

    workflow['20'] = {
        class_type: 'SplitImageToTileList',
        inputs: {
            image: ['1', 0],
            tile_width: tiling.tileSize,
            tile_height: tiling.tileSize,
            overlap: tiling.overlap
        },
        _meta: { title: 'Разделить большое изображение на тайлы' }
    };
    workflow['22'] = {
        class_type: 'MaskToImage',
        inputs: { mask: ['11', 1] },
        _meta: { title: 'Тайловые маски в изображения' }
    };
    workflow['21'] = {
        class_type: 'ImageMergeTileList',
        inputs: {
            image_list: ['22', 0],
            final_width: tiling.width,
            final_height: tiling.height,
            overlap: tiling.overlap
        },
        _meta: { title: 'Плавно собрать детальную маску' }
    };
    workflow['23'] = {
        class_type: 'ImageToMask',
        inputs: { image: ['21', 0], channel: 'red' },
        _meta: { title: 'Собранная детальная маска' }
    };
    workflow['30'] = globalNode;
    workflow['31'] = {
        class_type: 'GrowMask',
        inputs: {
            mask: ['30', 1],
            expand: tiling.guideExpand,
            tapered_corners: true
        },
        _meta: { title: 'Безопасная область восстановления деталей' }
    };
    workflow['32'] = {
        class_type: 'MaskComposite',
        inputs: {
            destination: ['23', 0],
            source: ['31', 0],
            x: 0,
            y: 0,
            operation: 'multiply'
        },
        _meta: { title: 'Убрать ложные тайловые области' }
    };
    workflow['33'] = {
        class_type: 'MaskComposite',
        inputs: {
            destination: ['32', 0],
            source: ['30', 1],
            x: 0,
            y: 0,
            operation: 'add'
        },
        _meta: { title: 'Сохранить глобальный силуэт' }
    };
    workflow['35'] = {
        class_type: 'InvertMask',
        inputs: { mask: ['33', 0] },
        _meta: { title: 'Подготовить альфа-канал' }
    };
    workflow['34'] = {
        class_type: 'JoinImageWithAlpha',
        inputs: {
            image: ['30', 0],
            alpha: ['35', 0]
        },
        _meta: { title: 'Исходные цвета + точная альфа-маска' }
    };
    workflow['3'].inputs.images = ['34', 0];
    workflow['3'].inputs.filename_prefix = 'ComfyFloatBar/RemoveBG_HQ_Tiled';
    return workflow;
}
function getWorkflow(type) {
    if (type === 'rmbg') return workflows.BIREFNET_HQ_WORKFLOW;
    if (type === 'gen_krea2') return workflows.KREA2_WORKFLOW;
    if (type === 'gen_turbo' || type === 'gen_qwen21') return workflows.TURBO_WORKFLOW;
    if (type === 'img2img_krea2') return workflows.KREA2_IMG2IMG_WORKFLOW;
    if (type === 'img2img_turbo' || type === 'img2img_qwen21') return workflows.TURBO_IMG2IMG_WORKFLOW;
    if (type === 'expand') return {}; // Constructed with qwen.createOutpaint at submission.
    if (type === 'vector') return workflows.VECTORIZER_WORKFLOW;
    if (type === 'mockup_ai') return getMockupAiWorkflowForSelectedModel();
    return workflows.STUB_WORKFLOW;
}

function formatLayerAspect(value) {
    return String(value || 'image').replace(/[^A-Za-z0-9]+/g, 'x').replace(/^x+|x+$/g, '') || 'image';
}

function generateName(type) {
    const timestamp = Date.now().toString().slice(-5);
    switch (type) {
        case 'enh_auto': return 'Enhance_Auto_' + timestamp;
        case 'enh_custom': return 'Enhance_Custom_' + timestamp;
        case 'enh_inpaint': return 'Enhance_Fill_' + timestamp;
        case 'enh_object': return 'Enhance_Object_' + timestamp;
        case 'enh_image': return 'Enhance_Image_' + timestamp;
        case 'enh_combine': return 'Enhance_Combine_' + timestamp;
        case 'rmbg': return 'RemoveBG_' + timestamp;
        case 'gen_normal': return 'Generate_' + timestamp;
        case 'gen_pattern': return 'Pattern_' + timestamp;
        case 'gen_qwen21': return 'Qwen21_T2I_' + timestamp;
        case 'img2img_qwen21': return 'Qwen21_I2I_' + timestamp;
        case 'gen_krea2':
            return 'Krea2_T2I_' + formatLayerAspect(getKreaAspectRatio().label) + '_' + getUiVal('slider_krea_megapixels') + 'MP_' + timestamp;
        case 'gen_turbo':
            return 'Turbo_T2I_' + formatLayerAspect(getKreaAspectRatio().label) + '_' + getUiVal('slider_krea_megapixels') + 'MP_' + timestamp;
        case 'img2img_krea2':
            return 'Krea2_I2I_' + formatLayerAspect(getImg2ImgAspectRatio().label) + '_' + getUiVal('slider_img2img_megapixels') + 'MP_' + timestamp;
        case 'img2img_turbo':
            return 'Turbo_I2I_' + formatLayerAspect(getImg2ImgAspectRatio().label) + '_' + getUiVal('slider_img2img_megapixels') + 'MP_' + timestamp;
        case 'mockup_ai': return getNextMockupResultName('ai', '', lastDesignName);
        case 'expand': return 'Expand_' + timestamp;
        case 'vector': return 'Vector_' + timestamp;
        default: return 'Comfy_' + timestamp;
    }
}

function saveResultToFolder(buffer, folderName, filename, ext) {
    const outputFolder = workingFolder || localStorage.getItem("workingFolder");
    if (!outputFolder) return null;
    const folderPath = path.join(outputFolder, folderName);
    if (!fs.existsSync(folderPath)) fs.mkdirSync(folderPath, { recursive: true });
    const resultPath = path.join(folderPath, `${filename}.${ext}`);
    fs.writeFileSync(resultPath, Buffer.from(buffer));
    return resultPath;
}

function notifyGenerationHistoryChanged() {
    ipcRenderer.send('generation-history:changed');
}

async function placeSavedGenerationInPhotoshop(buffer, resultPath, layerName) {
    if (!await isPhotoshopCurrentlyRunning()) return { attempted:false, placed:false };
    try {
        await psBridge.placeImage(buffer, false, null, layerName);
        return { attempted:true, placed:true };
    } catch (placeError) {
        try {
            await psBridge.openImageDocument(resultPath, layerName);
            return { attempted:true, placed:true };
        } catch (openError) {
            console.error('Photoshop не принял сохранённую генерацию:', placeError, openError);
            return { attempted:true, placed:false, error:openError };
        }
    }
}

const THREE_RESULT_SERIES_COUNTER_KEY = 'threeResultSeriesLastNumber';
const THREE_RESULT_SERIES_INITIAL_NUMBER = 140;

function getHighestThreeResultSeriesNumber() {
    let highest = THREE_RESULT_SERIES_INITIAL_NUMBER;
    const stored = Number.parseInt(localStorage.getItem(THREE_RESULT_SERIES_COUNTER_KEY) || '', 10);
    if (Number.isSafeInteger(stored) && stored > highest) highest = stored;

    const outputFolder = workingFolder || localStorage.getItem('workingFolder');
    if (!outputFolder) return highest;
    const generationsFolder = path.join(outputFolder, 'Generations');
    try {
        if (!fs.existsSync(generationsFolder)) return highest;
        fs.readdirSync(generationsFolder).forEach(fileName => {
            const match = String(fileName).match(/^p(\d+)_(?:l|c|r)(?:_|\.png$)/i);
            if (!match) return;
            const number = Number.parseInt(match[1], 10);
            if (Number.isSafeInteger(number) && number > highest) highest = number;
        });
    } catch (error) {
        console.warn('Не удалось проверить номера серий в Generations:', error.message || error);
    }
    return highest;
}

async function reserveNextThreeResultSeriesNumber() {
    const localHighest = getHighestThreeResultSeriesNumber();
    if (!hubSocket || !hubSocket.connected) {
        throw new Error('Для общего номера серии требуется подключение к Hub. Проверьте Hub IP и повторите.');
    }

    return new Promise((resolve, reject) => {
        hubSocket.timeout(6000).emit(
            'picture-series:reserve',
            { minimumLastNumber: localHighest },
            (error, response) => {
                if (error) {
                    const message = hubSupportsSharedPictureSeries
                        ? 'Hub не успел подтвердить общий номер серии. Проверьте соединение и повторите.'
                        : 'На компьютере-хосте запущена старая версия Hub. Полностью перезапустите ComfyFloatBar на компьютере-хосте и повторите.';
                    reject(new Error(message));
                    return;
                }
                const number = Math.floor(Number(response && response.number));
                if (!response || !response.ok || !Number.isSafeInteger(number) || number <= localHighest) {
                    reject(new Error((response && response.error) || 'Hub вернул некорректный номер серии.'));
                    return;
                }
                localStorage.setItem(THREE_RESULT_SERIES_COUNTER_KEY, String(number));
                resolve(number);
            }
        );
    });
}

function sanitizeMockupNamePart(value, fallback = 'Design', maximumLength = 72) {
    let result = String(value || '')
        .normalize('NFKC')
        .replace(/\.(psd|psb|png|jpe?g|tiff?)$/i, '')
        .replace(/[\\/:*?"<>|]/g, ' ')
        .replace(/\s+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^[._\s]+|[._\s]+$/g, '');
    if (!result) result = fallback;
    result = result.slice(0, Math.max(8, maximumLength)).replace(/[._\s]+$/g, '');
    return result || fallback;
}

function escapeMockupRegex(value) {
    return String(value).replace(/[.*+?^$(){}|[\]\\]/g, '\\$&');
}

function getMockupDesignBaseName(designName = lastDesignName) {
    return sanitizeMockupNamePart(designName || 'Design', 'Design', 72);
}

function getMockupResultsFolder() {
    const outputFolder = workingFolder || localStorage.getItem('workingFolder');
    if (!outputFolder) return null;
    const folderPath = path.join(outputFolder, 'Mockups');
    if (!fs.existsSync(folderPath)) fs.mkdirSync(folderPath, { recursive: true });
    return folderPath;
}

function getNextMockupResultName(kind = 'ai', templateName = '', designName = lastDesignName) {
    const designBase = getMockupDesignBaseName(designName);
    const typeLabels = {
        library: 'LIB',
        ai: 'AI_WALL',
        ai_wallpaper: 'AI_WALL',
        ai_art_single: 'AI_ART_1',
        ai_art_triple: 'AI_ART_3'
    };
    const typeLabel = typeLabels[kind] || 'AI_WALL';
    const templateLabel = kind === 'library'
        ? sanitizeMockupNamePart(templateName || 'Template', 'Template', 46)
        : '';
    const prefix = designBase + '__Mockup_';
    const folderPath = getMockupResultsFolder();
    let maximumNumber = 0;

    if (folderPath && fs.existsSync(folderPath)) {
        const canonicalPattern = new RegExp('^' + escapeMockupRegex(prefix) + '(\\d+)__', 'i');
        const legacyAiPattern = new RegExp('^' + escapeMockupRegex(designBase) + '_(\\d+)\\.(?:png|jpe?g)$', 'i');
        fs.readdirSync(folderPath).forEach(file => {
            const canonicalMatch = file.match(canonicalPattern);
            const legacyMatch = file.match(legacyAiPattern);
            const match = canonicalMatch || legacyMatch;
            if (match) maximumNumber = Math.max(maximumNumber, Number(match[1]) || 0);
        });
    }

    let number = maximumNumber + 1;
    let usedNumber = number;
    let reservationKey = '';
    let stem = '';
    do {
        usedNumber = number;
        reservationKey = designBase.toLowerCase() + '|' + usedNumber;
        stem = prefix + String(usedNumber).padStart(3, '0') + '__' + typeLabel + (templateLabel ? '_' + templateLabel : '');
        number++;
    } while (reservedMockupResultNames.has(reservationKey));

    reservedMockupResultNames.add(reservationKey);
    return stem;
}
// =====================================================================
// 11a. Vectorize — image input or active Photoshop layer, max 1 MP
// =====================================================================
let vectorSelectedImagePath = null;
let vectorSelectedImageName = '';
let vectorSelectedPlacement = null;
const vectorDropZone = document.getElementById('vectorDropZone');
const vectorFileInput = document.getElementById('vectorFileInput');
const vectorPreview = document.getElementById('vectorPreview');
const vectorImageLabel = document.getElementById('vectorImageLabel');
const vectorFileInfo = document.getElementById('vectorFileInfo');
const vectorResizeNotice = document.getElementById('vectorResizeNotice');
const btnVectorSelect = document.getElementById('btn_vector_select');
const btnVectorClear = document.getElementById('btn_vector_clear');
const btnVectorFromSelection = document.getElementById('btn_vector_from_selection');
const vectorMode = document.getElementById('vectorMode');
const vectorColors = document.getElementById('vectorColors');
const vectorMaxMegapixels = document.getElementById('vectorMaxMegapixels');
const vectorFilePrefix = document.getElementById('vectorFilePrefix');

function getVectorizerSettings() {
    const mode = vectorMode && vectorMode.value === 'stable' ? 'stable' : 'quantized';
    const colors = Math.max(4, Math.min(256, Math.round(Number(vectorColors?.value) || 64)));
    const maxMegapixels = Math.max(0.1, Math.min(64, Math.round((Number(vectorMaxMegapixels?.value) || 2) * 10) / 10));
    const fallbackPrefix = mode === 'stable' ? 'vector_stable' : 'vector_quantized';
    const filePrefix = String(vectorFilePrefix?.value || fallbackPrefix).trim().replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80) || fallbackPrefix;
    return { mode, colors, maxMegapixels, filePrefix };
}

function refreshVectorResizeNotice() {
    const width = vectorPreview?.naturalWidth || vectorPreview?.width || 0;
    const height = vectorPreview?.naturalHeight || vectorPreview?.height || 0;
    if (width && height) updateVectorResizeNotice(width, height);
    else if (vectorResizeNotice) {
        const limit = getVectorizerSettings().maxMegapixels;
        vectorResizeNotice.textContent = 'Изображения больше ' + limit + ' MP перед векторизацией автоматически уменьшаются до этого лимита.';
    }
}

if (vectorMode) {
    const saved = localStorage.getItem('vectorMode');
    vectorMode.value = saved === 'stable' ? 'stable' : 'quantized';
    vectorMode.addEventListener('change', () => {
        const previousDefault = vectorMode.value === 'stable' ? 'vector_quantized' : 'vector_stable';
        const nextDefault = vectorMode.value === 'stable' ? 'vector_stable' : 'vector_quantized';
        if (vectorFilePrefix && (!vectorFilePrefix.value.trim() || vectorFilePrefix.value.trim() === previousDefault)) {
            vectorFilePrefix.value = nextDefault;
            localStorage.setItem('vectorFilePrefix', nextDefault);
        }
        localStorage.setItem('vectorMode', vectorMode.value);
    });
}
if (vectorColors) {
    vectorColors.value = String(Math.max(4, Math.min(256, Number(localStorage.getItem('vectorColors')) || 64)));
    setupSlider('vectorColors', 'val_vectorColors', value => String(Math.round(value)));
    vectorColors.addEventListener('input', () => localStorage.setItem('vectorColors', vectorColors.value));
}
if (vectorMaxMegapixels) {
    vectorMaxMegapixels.value = String(Math.max(0.1, Math.min(64, Number(localStorage.getItem('vectorMaxMegapixels')) || 2)));
    setupSlider('vectorMaxMegapixels', 'val_vectorMaxMegapixels', value => Number(value).toFixed(value % 1 ? 1 : 0) + ' MP');
    vectorMaxMegapixels.addEventListener('input', () => {
        localStorage.setItem('vectorMaxMegapixels', vectorMaxMegapixels.value);
        refreshVectorResizeNotice();
    });
}
if (vectorFilePrefix) {
    vectorFilePrefix.value = localStorage.getItem('vectorFilePrefix') || 'vector_quantized';
    vectorFilePrefix.addEventListener('input', () => localStorage.setItem('vectorFilePrefix', vectorFilePrefix.value));
}

function updateVectorResizeNotice(width, height) {
    if (!vectorResizeNotice) return;
    const limit = getVectorizerSettings().maxMegapixels;
    const megapixels = ((Number(width) * Number(height)) / 1000000).toFixed(2);
    vectorResizeNotice.textContent = Number(width) * Number(height) > limit * 1000000
        ? '⚠ Исходник ' + megapixels + ' MP: перед векторизацией он будет уменьшен до ' + limit + ' MP. Оригинал не изменяется.'
        : 'Исходник ' + megapixels + ' MP: уменьшение не требуется. Оригинал не изменяется.';
}

function setVectorImage(filePath, sourceName = path.basename(filePath), placement = null) {
    try {
        const buffer = fs.readFileSync(filePath);
        vectorSelectedImagePath = filePath;
        vectorSelectedImageName = String(sourceName || path.basename(filePath));
        vectorSelectedPlacement = placement;
        vectorPreview.src = 'data:' + imageMimeType(filePath) + ';base64,' + buffer.toString('base64');
        vectorPreview.onload = () => {
            const width = vectorPreview.naturalWidth || vectorPreview.width;
            const height = vectorPreview.naturalHeight || vectorPreview.height;
            vectorFileInfo.textContent = vectorSelectedImageName + ' · ' + width + ' × ' + height + ' px';
            updateVectorResizeNotice(width, height);
        };
        vectorPreview.classList.remove('hidden');
        vectorImageLabel.classList.add('hidden');
        btnVectorClear.classList.remove('hidden');
    } catch (error) {
        vectorSelectedImagePath = null;
        vectorSelectedImageName = '';
        vectorSelectedPlacement = null;
        setStatusBar('Ошибка загрузки изображения: ' + (error.message || error));
    }
}

function clearVectorImage() {
    vectorSelectedImagePath = null;
    vectorSelectedImageName = '';
    vectorSelectedPlacement = null;
    vectorPreview.src = '';
    vectorPreview.classList.add('hidden');
    vectorImageLabel.classList.remove('hidden');
    vectorFileInfo.textContent = '';
    refreshVectorResizeNotice();
    btnVectorClear.classList.add('hidden');
}

function saveBrowserImageForVector(file) {
    if (!file || !String(file.type || '').startsWith('image/')) {
        setStatusBar('Выберите файл изображения.');
        return;
    }
    const extension = path.extname(file.name || '') || '.png';
    const temporaryPath = path.join(os.tmpdir(), 'comfy_vector_user_input' + extension);
    const reader = new FileReader();
    reader.onload = () => {
        try {
            fs.writeFileSync(temporaryPath, Buffer.from(reader.result));
            setVectorImage(temporaryPath, file.name || path.basename(temporaryPath));
        } catch (error) {
            setStatusBar('Ошибка сохранения изображения: ' + (error.message || error));
        }
    };
    reader.readAsArrayBuffer(file);
}

function readVectorSelectionPlacement(coordsPath, fallbackWidth, fallbackHeight) {
    try {
        const parts = fs.readFileSync(coordsPath, 'utf8').split(',').map(Number);
        if (parts.length >= 4 && parts.every(Number.isFinite)) {
            return { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
        }
    } catch (ignore) {}
    return { x: 0, y: 0, width: fallbackWidth, height: fallbackHeight };
}

async function prepareSelectedVectorImage(maxMegapixels = 2) {
    const image = await loadUpscaleSourceImage(vectorSelectedImagePath);
    const fileWidth = image.naturalWidth || image.width;
    const fileHeight = image.naturalHeight || image.height;
    const originalPixels = fileWidth * fileHeight;
    let width = fileWidth;
    let height = fileHeight;
    const maxPixels = Math.max(0.1, Math.min(64, Number(maxMegapixels) || 2)) * 1000000;
    if (originalPixels > maxPixels) {
        const scale = Math.sqrt(maxPixels / originalPixels);
        width = Math.max(1, Math.round(fileWidth * scale));
        height = Math.max(1, Math.round(fileHeight * scale));
        while (width * height > maxPixels) {
            if (width >= height) width--; else height--;
        }
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, 0, 0, width, height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('Не удалось подготовить PNG для Vectorizer.');
    const filePath = path.join(os.tmpdir(), 'comfy_vector_input.png');
    fs.writeFileSync(filePath, Buffer.from(await blob.arrayBuffer()));
    const placement = vectorSelectedPlacement || { x: 0, y: 0, width: fileWidth, height: fileHeight };
    return {
        filePath,
        originalWidth: Math.max(1, Number(placement.width) || fileWidth),
        originalHeight: Math.max(1, Number(placement.height) || fileHeight),
        width,
        height,
        x: Math.max(0, Number(placement.x) || 0),
        y: Math.max(0, Number(placement.y) || 0),
        sourceName: vectorSelectedImageName || path.basename(vectorSelectedImagePath)
    };
}

if (vectorDropZone) {
    vectorDropZone.addEventListener('click', () => {
        vectorDropZone.focus();
        vectorFileInput.click();
    });
    vectorDropZone.addEventListener('dragover', event => {
        event.preventDefault();
        vectorDropZone.classList.add('drag-over');
    });
    vectorDropZone.addEventListener('dragleave', () => vectorDropZone.classList.remove('drag-over'));
    vectorDropZone.addEventListener('drop', event => {
        event.preventDefault();
        vectorDropZone.classList.remove('drag-over');
        saveBrowserImageForVector(event.dataTransfer.files[0]);
    });
    vectorDropZone.addEventListener('paste', event => {
        for (const item of event.clipboardData.items) {
            if (!item.type.startsWith('image/')) continue;
            saveBrowserImageForVector(item.getAsFile());
            event.preventDefault();
            break;
        }
    });
}
if (vectorFileInput) vectorFileInput.addEventListener('change', event => {
    saveBrowserImageForVector(event.target.files[0]);
    event.target.value = '';
});
if (btnVectorSelect) btnVectorSelect.addEventListener('click', () => vectorFileInput.click());
if (btnVectorClear) btnVectorClear.addEventListener('click', clearVectorImage);
if (btnVectorFromSelection) btnVectorFromSelection.addEventListener('click', async () => {
    try {
        setStatusBar('⏳ Экспорт выделения из Photoshop...');
        const data = await psBridge.exportSelection();
        if (!data) throw new Error('Сначала выделите область в Photoshop.');
        const image = await loadUpscaleSourceImage(data.filePath);
        const placement = readVectorSelectionPlacement(data.coordsPath, image.naturalWidth || image.width, image.naturalHeight || image.height);
        let sourceName = path.basename(data.filePath);
        try {
            const documentName = await psBridge.getActiveDocumentName();
            if (documentName && documentName !== 'ERROR') sourceName = documentName + ' — выделение';
        } catch (ignore) {}
        setVectorImage(data.filePath, sourceName, placement);
    } catch (error) {
        setStatusBar('Ошибка: ' + (error.message || error));
    }
});

async function handleVectorize() {
    if (isTaskRunning) { setStatusBar('Задача уже выполняется!'); return; }
    try {
        lockUI('vector');
        localTaskStartedAt = Date.now();
        localTaskType = 'vector';
        const vectorSettings = getVectorizerSettings();

        let vectorExport;
        if (vectorSelectedImagePath) {
            setStatusBar('⏳ Vectorizer: подготовка изображения до ' + vectorSettings.maxMegapixels + ' MP...');
            vectorExport = await prepareSelectedVectorImage(vectorSettings.maxMegapixels);
        } else {
            setStatusBar('⏳ Vectorizer: экспорт активного слоя...');
            vectorExport = await psBridge.exportActiveLayerVisible(vectorSettings.maxMegapixels);
            vectorExport.sourceName = 'Активный слой Photoshop';
        }
        const sourceDimensions = vectorExport.originalWidth + ' × ' + vectorExport.originalHeight + ' px';
        const uploadDimensions = vectorExport.width + ' × ' + vectorExport.height + ' px';
        if (vectorExport.width * vectorExport.height > vectorSettings.maxMegapixels * 1000000 + 1) {
            throw new Error('Не удалось уменьшить временную копию до ' + vectorSettings.maxMegapixels + ' MP.');
        }
        const wasReduced = vectorExport.width !== vectorExport.originalWidth || vectorExport.height !== vectorExport.originalHeight;
        setStatusBar(wasReduced
            ? '⏳ Vectorizer: ' + sourceDimensions + ' → ' + uploadDimensions + ' (до ' + vectorSettings.maxMegapixels + ' MP)...'
            : '⏳ Vectorizer: ' + uploadDimensions + ' (уменьшение не требуется)...');

        const ip = document.getElementById('serverIP').value || '127.0.0.1:8188';
        setStatusBar('⏳ Vectorizer: загрузка временной копии...');
        const comfyName = await comfyBridge.uploadImage(ip, vectorExport.filePath);

        const workflow = JSON.parse(JSON.stringify(workflows.VECTORIZER_WORKFLOW));
        if (!workflow['1'] || !workflow['2'] || !workflow['3'] || !workflow['4']) throw new Error('Граф Vectorizer загружен не полностью.');
        workflow['1'].inputs.image = comfyName;
        workflow['3'].inputs.max_megapixels = vectorSettings.maxMegapixels;
        workflow['4'].inputs.colors = vectorSettings.colors;
        workflow['4'].inputs.file_prefix = vectorSettings.filePrefix;
        workflow['4'].inputs.mode = vectorSettings.mode;
        setLastLoadedModel('My Vectorizer · ' + (vectorSettings.mode === 'stable' ? 'Stable' : 'Quantized'));

        setStatusBar('⏳ Vectorizer: создание SVG...');
        markComfyProcessingStarted();
        const promptId = await sendWorkflow(ip, workflow);
        const svgText = await comfyBridge.pollHistoryText(ip, promptId);
        if (!svgText || svgText.toLowerCase().indexOf('<svg') === -1) {
            throw new Error('Vectorizer не вернул корректный SVG.');
        }

        const layerName = generateName('vector');
        const resultPath = saveResultToFolder(Buffer.from(svgText, 'utf8'), 'Vectors', layerName, 'svg');
        if (!resultPath) throw new Error('Папка download для сохранения SVG недоступна.');

        setStatusBar('⏳ Vectorizer: вставка SVG в Photoshop...');
        await psBridge.placeSvg(svgText, vectorExport.originalWidth, vectorExport.originalHeight, vectorExport.x, vectorExport.y, layerName);
        setStatusBar('✓ SVG сохранён и вставлен: ' + uploadDimensions + ' → Vectors');
    } catch (error) {
        setStatusBar('Ошибка: ' + (error.message || error));
        console.error(error);
    } finally {
        unlockUI();
    }
}

// Обработка ВЫДЕЛЕНИЯ
async function handleSelectionProcess(type) {
    if (isTaskRunning) { setStatusBar("Задача уже выполняется!"); return; }
    try {
        lockUI(type); localTaskStartedAt = Date.now(); localTaskType = type;
        const ip = document.getElementById("serverIP").value || "127.0.0.1:8188";
        setStatusBar("⏳ Экспорт из PS...");
        const exportData = await psBridge.exportSelection();
        if (!exportData) { setStatusBar("Нет выделения!"); unlockUI(); return; }

        if (type === 'rmbg' && getRemoveBackgroundOptions().model === 'qwen21') {
            const options = getRemoveBackgroundOptions();
            const comfyName = await comfyBridge.uploadImage(ip, exportData.filePath);
            const workflow = qwen.createRemoval(comfyName, options.prompt);
            rememberWorkflowModel(workflow, 'Qwen');
            lastRemoveBackgroundInfo = { ...getPngDimensionsFromBuffer(fs.readFileSync(exportData.filePath)), tiled: false, fallback: false };
            setStatusBar('⏳ Qwen удаляет фон и создаёт прозрачный PNG...');
            markComfyProcessingStarted();
            const promptId = await sendWorkflow(ip, workflow);
            const result = await comfyBridge.pollHistory(ip, promptId);
            const buffer = await comfyBridge.downloadImage(ip, result);
            await verifyTransparentPng(buffer);
            await psBridge.placeImage(buffer, true, exportData.coordsPath, generateName(type));
            setStatusBar('✓ Фон удалён через Qwen.');
            unlockUI();
            return;
        }

        setStatusBar("⏳ Загрузка в ComfyUI...");
        const comfyName = await comfyBridge.uploadImage(ip, exportData.filePath);
        const rmbgOptions = type === 'rmbg' ? getRemoveBackgroundOptions() : null;
        const rmbgInputSize = type === 'rmbg'
            ? getPngDimensionsFromBuffer(fs.readFileSync(exportData.filePath))
            : null;
        const rmbgTiling = type === 'rmbg' && rmbgOptions.preset !== 'raw'
            ? getRemoveBackgroundTilingConfig(rmbgOptions, rmbgInputSize)
            : null;
        if (type === 'rmbg') {
            lastRemoveBackgroundInfo = {
                width: rmbgInputSize && rmbgInputSize.width ? rmbgInputSize.width : 0,
                height: rmbgInputSize && rmbgInputSize.height ? rmbgInputSize.height : 0,
                tiled: Boolean(rmbgTiling && rmbgTiling.tiled),
                fallback: false
            };
        }

        const prepareWorkflow = (sourceWorkflow) => {
            const workflow = JSON.parse(JSON.stringify(sourceWorkflow));
            applyGeminiEnhancerModel(workflow);
            workflow["1"].inputs.image = comfyName;
            if (type === 'rmbg' && rmbgOptions && rmbgOptions.preset !== 'raw') {
                configureRemoveBackgroundWorkflow(workflow, rmbgOptions, rmbgInputSize);
            }
            return workflow;
        };

        const runWorkflow = async (workflow) => {
            const promptId = await sendWorkflow(ip, workflow);
            return comfyBridge.pollHistory(ip, promptId);
        };

        const sourceWorkflow = type === 'rmbg' && rmbgOptions.preset === 'raw'
            ? workflows.BIREFNET_WORKFLOW
            : getWorkflow(type);
        let workflow = prepareWorkflow(sourceWorkflow);
        rememberWorkflowModel(workflow, type === 'rmbg' ? getRemoveBackgroundModelName(rmbgOptions) : 'ComfyUI');

        if (type === 'rmbg' && rmbgTiling && rmbgTiling.tiled) {
            setStatusBar('⏳ ComfyUI: детальная маска ' + rmbgTiling.width + '×' + rmbgTiling.height + '...');
        } else {
            setStatusBar("⏳ ComfyUI работает...");
        }
        markComfyProcessingStarted();

        let resultFile;
        try {
            resultFile = await runWorkflow(workflow);
        } catch (error) {
            if (type !== 'rmbg' || rmbgOptions.preset === 'raw') throw error;
            console.warn('Высокоточный BiRefNet недоступен, используется базовый workflow:', error);
            if (lastRemoveBackgroundInfo) {
                lastRemoveBackgroundInfo.fallback = true;
                lastRemoveBackgroundInfo.tiled = false;
            }
            setStatusBar("⚠ Высокоточный BiRefNet недоступен — запускаю базовую модель...");
            workflow = prepareWorkflow(workflows.BIREFNET_WORKFLOW);
            rememberWorkflowModel(workflow, 'BiRefNet (базовая модель)');
            resultFile = await runWorkflow(workflow);
        }

        setStatusBar("⏳ Помещение в PS...");
        const buffer = await comfyBridge.downloadImage(ip, resultFile);
        const layerName = generateName(type);
        await psBridge.placeImage(buffer, true, exportData.coordsPath, layerName);
        setStatusBar("✓ Готово!");
        unlockUI();
    } catch (error) {
        setStatusBar("Ошибка: " + (error.message || error));
        console.error(error);
        unlockUI();
    }
}
async function handleThreeResultGeneration() {
    if (isTaskRunning) { setStatusBar('Задача уже выполняется!'); return; }
    let taskLocked = false;
    try {
        const options = getVariationGenerationOptions();
        const taskType = getVariationTaskType(options);
        lockUI(taskType);
        taskLocked = true;
        localTaskStartedAt = Date.now();
        localTaskType = taskType;
        lastVariationGenerationInfo = null;

        if (!workingFolder) {
            const detectedFolder = await ipcRenderer.invoke('get-working-folder');
            if (detectedFolder) {
                workingFolder = detectedFolder;
                localStorage.setItem('workingFolder', detectedFolder);
            }
        }
        if (!workingFolder) throw new Error('Папка download не найдена.');

        setStatusBar('⏳ Подготовка временной копии до 1 MP...');
        const preparedInput = await prepareEnhanceInputAtOneMegapixel(
            options.sourcePath,
            options.mode === 'triptych' ? 'triptych_input' : 'three_variations_input'
        );
        const inputSize = preparedInput.width + ' × ' + preparedInput.height + ' px';
        if (preparedInput.reduced) {
            setStatusBar('⚠ Исходник уменьшен только для ComfyUI: ' + preparedInput.originalWidth + ' × ' + preparedInput.originalHeight + ' → ' + inputSize + '.');
        } else {
            setStatusBar('⏳ Размер источника ' + inputSize + ', уменьшение не требуется.');
        }

        const ip = document.getElementById('serverIP').value || '127.0.0.1:8188';
        setStatusBar('⏳ Загрузка источника в ComfyUI...');
        const comfyName = await comfyBridge.uploadImage(ip, preparedInput.filePath);

        const hasManualSeriesNumber = Number.isSafeInteger(options.seriesNumber);
        if (hasManualSeriesNumber) {
            setStatusBar('⏳ Повторная генерация серии p' + options.seriesNumber + ' — существующие файлы будут заменены...');
        } else {
            setStatusBar('⏳ Резервирование общего номера серии в Hub...');
        }
        const seriesNumber = hasManualSeriesNumber
            ? options.seriesNumber
            : await reserveNextThreeResultSeriesNumber();
        const seriesBase = 'p' + seriesNumber;
        const partSuffixes = ['l', 'c', 'r'];

        const sourceWorkflow = getVariationWorkflowForMode(options.mode);
        const workflow = JSON.parse(JSON.stringify(sourceWorkflow));
        applyGeminiEnhancerModel(workflow);
        configureThreeResultWorkflow(workflow, options, comfyName);
        ['118', '128', '138'].forEach((nodeId, index) => {
            workflow[nodeId].inputs.filename_prefix = 'ComfyFloatBar/' + seriesBase + '_' + partSuffixes[index];
        });
        rememberWorkflowModel(workflow, options.model === 'krea2' ? 'Krea 2' : 'Turbo');

        setStatusBar('⏳ ComfyUI создаёт три изображения...');
        markComfyProcessingStarted();
        const promptId = await sendWorkflow(ip, workflow);
        const resultFiles = await comfyBridge.pollHistoryImages(ip, promptId, 3, ['118', '128', '138']);

        const resultSizes = [];
        const resultFileNames = [];
        const resultPaths = [];

        for (let index = 0; index < resultFiles.length; index++) {
            setStatusBar('⏳ Серия ' + seriesBase + ': сохранение ' + (index + 1) + ' из 3...');
            const buffer = await comfyBridge.downloadImage(ip, resultFiles[index]);
            const dimensions = getPngDimensionsFromBuffer(buffer);
            const layerName = seriesBase + '_' + partSuffixes[index];
            const resultPath = saveResultToFolder(buffer, 'Generations', layerName, 'png');
            if (!resultPath) throw new Error('Не удалось сохранить результат в папку Generations.');
            resultPaths.push({ resultPath, layerName });
            resultFileNames.push(layerName + '.png');
            resultSizes.push(dimensions.width && dimensions.height
                ? dimensions.width + ' × ' + dimensions.height + ' px'
                : 'размер не определён');
        }

        lastVariationGenerationInfo = {
            inputSize,
            seriesName: seriesBase,
            seriesNumberMode: hasManualSeriesNumber ? 'Ручной повтор' : 'Следующий общий номер',
            resultCount: resultFiles.length,
            resultFiles: resultFileNames,
            resultSizes
        };
        notifyGenerationHistoryChanged();
        let photoshopErrors = 0;
        if (await isPhotoshopCurrentlyRunning()) {
            for (const item of resultPaths) {
                try { await psBridge.openImageDocument(item.resultPath, item.layerName); }
                catch (error) { photoshopErrors++; console.error(error); }
            }
        }
        setStatusBar(photoshopErrors
            ? '⚠ Серия ' + seriesBase + ' сохранена, но Photoshop открыл не все изображения.'
            : '✓ Серия ' + seriesBase + ' сохранена: ' + resultFileNames.join(', '));
    } catch (error) {
        setStatusBar('Ошибка: ' + (error.message || error));
        console.error(error);
    } finally {
        if (taskLocked) unlockUI();
    }
}

// Обработка ВСЕГО ДОКУМЕНТА
async function handleComfyRequest(type) {
    if (type === 'vector') return handleVectorize();
    if (isTaskRunning) { setStatusBar("Задача уже выполняется!"); return; }
    let patternController = null;
    try {
        lockUI(type); localTaskStartedAt = Date.now(); localTaskType = type;
        const patternSettings = wantsPatternAssembly(type) ? getPatternAssemblySettings(type) : null;
        if (patternSettings) patternController = activePatternController = new AbortController();
        const isModelTextGeneration = ['gen_krea2', 'gen_turbo', 'gen_qwen21'].includes(type);
        const isMockupAi = type === 'mockup_ai';
        const isModelImg2Img = ['img2img_krea2', 'img2img_turbo', 'img2img_qwen21'].includes(type) || isMockupAi;
        let ip = document.getElementById("serverIP").value || "127.0.0.1:8188";

        let comfyName = null;
        let expandDocument = null;
        let expandMargins = null;
        if (type === 'expand') {
            expandDocument = await psBridge.getActiveDocumentInfo();
            expandMargins = {
                left: Math.round(getExpandPixels('expandLeft')), top: Math.round(getExpandPixels('expandTop')),
                right: Math.round(getExpandPixels('expandRight')), bottom: Math.round(getExpandPixels('expandBottom'))
            };
        }
        let mockupDesignSourcePath = null;
        const mockupGenerationOptions = isMockupAi ? getMockupImg2ImgGenerationOptions() : null;
        if (isMockupAi) lastMockupAiInfo = null;
        if (isModelTextGeneration) {
            setStatusBar(`⏳ Подготовка ${modelLabel(type.replace('gen_', ''))}...`);
        } else {
            let filePath;
            if (isModelImg2Img && !isMockupAi) {
                if (!img2imgSelectedImagePath) throw new Error('Добавьте исходное изображение для img2img.');
                setStatusBar('⏳ Подготовка временной копии img2img до 1 MP...');
                const img2imgInput = await prepareEnhanceInputAtOneMegapixel(img2imgSelectedImagePath, 'img2img_input');
                lastImg2ImgInputInfo = img2imgInput;
                if (img2imgInput.reduced) {
                    setStatusBar('⚠ Исходник уменьшен только для ComfyUI: ' + img2imgInput.originalWidth + ' × ' + img2imgInput.originalHeight + ' → ' + img2imgInput.width + ' × ' + img2imgInput.height + ' px (до 1 MP).');
                } else {
                    setStatusBar('⏳ Исходник ' + img2imgInput.width + ' × ' + img2imgInput.height + ' px — уменьшение не требуется.');
                }
                filePath = img2imgInput.filePath;
            } else {
                setStatusBar(isMockupAi ? "⏳ Экспорт дизайна из Photoshop..." : "⏳ Экспорт из PS...");
                filePath = await psBridge.exportDocument();
                lastDesignPath = filePath;
                lastDesignName = await psBridge.getActiveDocumentName();
                if (isMockupAi) {
                    // Keep a stable original for Photoshop and send ComfyUI a fast 1 MP copy.
                    fs.writeFileSync(MOCKUP_DESIGN_FILE, fs.readFileSync(filePath));
                    mockupDesignSourcePath = MOCKUP_DESIGN_FILE;
                    setStatusBar('⏳ Подгонка дизайна мокапа до 1 MP...');
                    const mockupInput = await prepareEnhanceInputAtOneMegapixel(filePath, 'mockup_ai_input');
                    if (mockupInput.reduced) {
                        setStatusBar('⚠ Дизайн для AI Generate уменьшен: ' + mockupInput.originalWidth + ' × ' + mockupInput.originalHeight + ' → ' + mockupInput.width + ' × ' + mockupInput.height + ' px (1 MP).');
                    }
                    filePath = mockupInput.filePath;
                }
            }

            setStatusBar("⏳ Загрузка в ComfyUI...");
            comfyName = await comfyBridge.uploadImage(ip, filePath);
        }

        setStatusBar("⏳ ComfyUI работает...");
        let wf = JSON.parse(JSON.stringify(getWorkflow(type)));
        applyGeminiEnhancerModel(wf);
        if (isModelTextGeneration) {
            configureKrea2Workflow(wf, getKreaGenerationOptions());
        } else if (isModelImg2Img) {
            wf["17"].inputs.image = comfyName;
            configureKrea2Workflow(wf, isMockupAi ? mockupGenerationOptions : getImg2ImgGenerationOptions());
            if (isMockupAi) configureMockupAiWorkflow(wf, mockupGenerationOptions);
        } else if (type === 'expand') {
            const prompt = document.getElementById('expandPrompt').value.trim() || 'Extend the background naturally';
            wf = editWorkflows.createOutpaint(comfyName, expandMargins, prompt);
        } else {
            wf["1"].inputs.image = comfyName;
        }
        if (type === 'gen_qwen21' || type === 'img2img_qwen21' || (isMockupAi && mockupGenerationOptions.model === 'qwen21')) {
            const options = isMockupAi ? mockupGenerationOptions : isModelTextGeneration ? getKreaGenerationOptions() : getImg2ImgGenerationOptions();
            wf = qwen.fromGenerationWorkflow(wf, { ...options, image: comfyName,
                prefix: isMockupAi ? 'ComfyFloatBar/Qwen21_Mockup' : 'ComfyFloatBar/Qwen21_Generate' });
        }
        if (isMockupAi && mockupGenerationOptions.removeWall) {
            wf = qwen.appendWallRemoval(wf);
            setStatusBar('⏳ Создание мокапа и удаление белой стены через Qwen...');
        }
        rememberWorkflowModel(wf, 'ComfyUI');
        markComfyProcessingStarted();
        const promptId = await sendWorkflow(ip, wf);

        if (patternController) {
            activePatternPromptId = promptId;
            if (patternController.signal.aborted) {
                await fetch(`http://${ip}/queue`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({delete:[promptId]})});
                patternPipeline.checkCancelled(patternController.signal);
            }
        }

        let originalMockupBuffer = null;
        let resultFile;
        if (isMockupAi && mockupGenerationOptions.removeWall) {
            const results = await comfyBridge.pollHistoryImages(ip, promptId, 2, ['wall_qwen_save', 'mockup_original_save']);
            resultFile = results[0];
            originalMockupBuffer = await comfyBridge.downloadImage(ip, results[1]);
        } else {
            resultFile = await comfyBridge.pollHistory(ip, promptId);
        }
        const buffer = await comfyBridge.downloadImage(ip, resultFile);
        if (patternController) { activePatternPromptId = null; patternPipeline.checkCancelled(patternController.signal); }

        const layerName = isMockupAi
            ? getNextMockupResultName(mockupGenerationOptions.resultKind, '', lastDesignName)
            : generateName(type);
        const shouldSave = ['gen_krea2', 'gen_turbo', 'gen_qwen21', 'img2img_krea2', 'img2img_turbo', 'img2img_qwen21', 'mockup_ai', 'upscale', 'expand'].includes(type);
        let folderName = '', ext = 'png', resultPath = null;
        if (shouldSave) {
            if (type.includes('gen') || type.startsWith('img2img') || type === 'expand') folderName = 'Generations';
            else if (type === 'mockup_ai') folderName = 'Mockups';
            else if (type === 'upscale') folderName = 'Upscales';
        }
        if (isMockupAi) {
            if (mockupGenerationOptions.removeWall) await verifyTransparentPng(buffer);
            if (!mockupDesignSourcePath) throw new Error('Не найден экспорт исходного дизайна для мокапа.');
        }
        if (shouldSave) {
            resultPath = saveResultToFolder(buffer, folderName, layerName, ext);
            if (!resultPath) throw new Error('Не удалось сохранить результат в папку ' + folderName + '.');
            if (originalMockupBuffer) saveResultToFolder(originalMockupBuffer, folderName, layerName + '__Original', ext);
            notifyGenerationHistoryChanged();
        }

        if (patternSettings) {
            await assemblePattern(resultPath, patternSettings, patternController);
            activePatternController = null; activePatternPromptId = null;
            unlockUI();
            return;
        }

        let photoshopOutcome = { attempted:false, placed:false };
        if (isMockupAi) {
            const isArtworkMockup = mockupGenerationOptions.mockupKind === 'artwork';
            let openedMockupDocName = null;
            if (await isPhotoshopCurrentlyRunning()) {
                setStatusBar(isArtworkMockup ? '⏳ Открытие мокапа картин в Photoshop...' : '⏳ Открытие мокапа обоев в Photoshop...');
                try {
                    openedMockupDocName = await psBridge.openGeneratedMockupAndPlaceDesign(
                        buffer,
                        mockupDesignSourcePath,
                        layerName,
                        lastDesignName,
                        {
                            placeDesign: !isArtworkMockup,
                            designBehind: Boolean(mockupGenerationOptions.removeWall),
                            originalMockupBuffer,
                            mockupKind: isArtworkMockup
                                ? (mockupGenerationOptions.artCount === 3 ? 'art_triple' : 'art_single')
                                : 'wallpaper'
                        }
                    );
                    photoshopOutcome = { attempted:true, placed:true };
                } catch (error) {
                    console.error(error);
                    try {
                        await psBridge.openImageDocument(resultPath, layerName);
                        photoshopOutcome = { attempted:true, placed:true, fallback:true };
                    } catch (fallbackError) {
                        photoshopOutcome = { attempted:true, placed:false, error:fallbackError };
                    }
                }
            }
            lastMockupOutputStem = layerName;
            lastMockupTemplateName = isArtworkMockup
                ? 'AI Generate · Картины · ' + mockupGenerationOptions.artCount
                : 'AI Generate · Обои';
            lastMockupDocName = openedMockupDocName || path.basename(resultPath || (layerName + '.png'));
            lastMockupAiInfo = Object.assign({}, mockupGenerationOptions, { outputStem: layerName });
            mockupDesignPath = mockupDesignSourcePath;
        } else if (type === 'expand') {
            if (await isPhotoshopCurrentlyRunning()) {
                setStatusBar('⏳ Расширение холста Photoshop и вставка результата...');
                photoshopOutcome.attempted = true;
                try {
                    await psBridge.placeImage(buffer, false, null, layerName, false, false, false, null, null,
                        expandDocument.documentId, null, { ...expandMargins, width: expandDocument.width, height: expandDocument.height });
                    photoshopOutcome.placed = true;
                } catch (placementError) {
                    console.warn('Expand placement failed:', placementError);
                    try {
                        await psBridge.openImageDocument(resultPath, layerName);
                        photoshopOutcome.opened = true;
                    } catch (openError) {
                        photoshopOutcome.error = openError;
                    }
                }
            }
        } else if (shouldSave) {
            setStatusBar('⏳ Результат сохранён. Проверка Photoshop...');
            photoshopOutcome = await placeSavedGenerationInPhotoshop(buffer, resultPath, layerName);
        } else {
            setStatusBar('⏳ Помещение в Photoshop...');
            await psBridge.placeImage(buffer, false, null, layerName);
        }
        if (shouldSave) {
            if (photoshopOutcome.error) {
                setStatusBar('⚠ Сохранено: ' + layerName + '.png. Photoshop не принял изображение.');
            } else if (photoshopOutcome.opened) {
                setStatusBar('✓ Сохранено и открыто отдельным документом Photoshop: ' + layerName + '.png');
            } else if (photoshopOutcome.placed) {
                setStatusBar('✓ Сохранено и добавлено в Photoshop: ' + layerName + '.png');
            } else {
                setStatusBar('✓ Сохранено: ' + layerName + '.png. Photoshop закрыт.');
            }
        } else {
            setStatusBar("✓ Готово!");
        }
        unlockUI();
    } catch (error) {
        setStatusBar(patternController?.signal.aborted ? 'Сборка отменена. Готовые файлы сохранены.' : "Ошибка: " + (error.message || error));
        if (!patternController?.signal.aborted) console.error(error);
        if (patternController) { activePatternController = null; activePatternPromptId = null; }
        unlockUI();
    }
}

// =====================================================================
// 12. ЛОГИКА МОКАПОВ
// =====================================================================
let currentMockupFolder = null;

async function loadMockupList() {
    const grid = document.getElementById('mockupGrid');
    if (!grid) return;
    grid.innerHTML = '<div style="color: #888; grid-column: 1/-1; text-align: center;">Загрузка...</div>';
    try {
        const ip = document.getElementById("mockupIP").value || "127.0.0.1:8080";
        if (!currentMockupFolder) {
            const backBtn = document.getElementById('btn_mockup_back');
            if(backBtn) backBtn.style.display = 'none';
            const pathLabel = document.getElementById('mockup_path_label');
            if(pathLabel) pathLabel.textContent = '';
            const folders = await comfyBridge.getMockupFolders(ip);
            renderMockupFolders(folders);
        } else {
            const backBtn = document.getElementById('btn_mockup_back');
            if(backBtn) backBtn.style.display = 'block';
            const pathLabel = document.getElementById('mockup_path_label');
            if(pathLabel) pathLabel.textContent = '📁 ' + currentMockupFolder;
            const files = await comfyBridge.getMockupFiles(ip, currentMockupFolder);
            renderMockupFiles(files);
        }
    } catch (error) {
        grid.innerHTML = `<div style="color: #f55; grid-column: 1/-1; text-align: center;">Ошибка: ${error.message}</div>`;
    }
}

function renderMockupFolders(folders) {
    const grid = document.getElementById('mockupGrid');
    grid.innerHTML = '';
    if (folders.length === 0) {
        grid.innerHTML = '<div style="color: #888; grid-column: 1/-1; text-align: center;">Папки не найдены</div>';
        return;
    }
    folders.forEach(folder => {
        const div = document.createElement('div');
        div.className = 'folder-card';
        div.innerHTML = `<div class="folder-icon">📁</div>${folder}`;
        div.addEventListener('click', () => { currentMockupFolder = folder; loadMockupList(); });
        grid.appendChild(div);
    });
}

function renderMockupFiles(files) {
    const grid = document.getElementById('mockupGrid');
    grid.innerHTML = '';
    const ip = document.getElementById("mockupIP").value || "127.0.0.1:8080";
    if (files.length === 0) {
        grid.innerHTML = '<div style="color: #888; grid-column: 1/-1; text-align: center;">Превью не найдены</div>';
        return;
    }
    files.forEach(file => {
        const div = document.createElement('div');
        div.className = 'mockup-item-card';
        const img = document.createElement('img');
        img.src = comfyBridge.getMockupPreviewUrl(ip, currentMockupFolder, file);
        const name = document.createElement('span');
        name.textContent = file.replace('.png', '');
        div.appendChild(img);
        div.appendChild(name);
        div.addEventListener('click', () => applyMockup(file));
        grid.appendChild(div);
    });
}

async function applyMockup(file) {
    if (isTaskRunning) { setStatusBar('Задача уже выполняется!'); return; }
    try {
        lockUI('mockup_library');
        localTaskStartedAt = Date.now();
        localTaskType = 'mockup_library';
        setStatusBar('⏳ Подготовка дизайна...');
        const activeDocName = await psBridge.getActiveDocumentName();
        const activeStem = String(activeDocName || '').replace(/\.(psd|psb|png)$/i, '');
        const isTrackedMockup = Boolean(
            mockupDesignPath &&
            lastMockupOutputStem &&
            (activeDocName === lastMockupDocName || activeStem === lastMockupOutputStem)
        );

        if (!isTrackedMockup) {
            const exportPath = await psBridge.exportDocument();
            fs.writeFileSync(MOCKUP_DESIGN_FILE, fs.readFileSync(exportPath));
            mockupDesignPath = MOCKUP_DESIGN_FILE;
            lastDesignPath = exportPath;
            lastDesignName = activeDocName;
        }
        if (!mockupDesignPath) throw new Error('Не удалось подготовить исходный дизайн.');

        const mockupName = path.parse(String(file || 'Template')).name;
        const outputStem = getNextMockupResultName('library', mockupName, lastDesignName);
        setStatusBar('⏳ Скачивание шаблона ' + mockupName + '...');
        const mockupIP = document.getElementById('mockupIP').value || '127.0.0.1:8080';
        const mockupBuffer = await comfyBridge.downloadMockup(mockupIP, currentMockupFolder, file);

        setStatusBar('⏳ Открытие ' + outputStem + ' в Photoshop...');
        const openedDocName = await psBridge.openMockupAndPlaceDesign(
            mockupBuffer,
            mockupDesignPath,
            outputStem,
            lastDesignName,
            mockupName
        );

        lastMockupOutputStem = outputStem;
        lastMockupTemplateName = mockupName;
        lastMockupDocName = openedDocName || (outputStem + '.psd');
        setStatusBar('✓ Открыт мокап: ' + outputStem + '.psd');
        unlockUI();
    } catch (error) {
        setStatusBar('Ошибка: ' + (error.message || error));
        console.error(error);
        unlockUI();
    }
}

async function handleSaveMockupPng() {
    try {
        const folderPath = getMockupResultsFolder();
        if (!folderPath) { setStatusBar('Ошибка: папка download не найдена!'); return; }
        const docName = await psBridge.getActiveDocumentName();
        if (docName === 'ERROR' || !docName) { setStatusBar('Ошибка: нет активного документа.'); return; }

        const cleanDocumentName = String(docName)
            .replace('[ComfyMockup] ', '')
            .replace(/\.(psd|psb|png)$/i, '');
        const isTrackedMockup = Boolean(
            lastMockupOutputStem &&
            (docName === lastMockupDocName || cleanDocumentName === lastMockupOutputStem)
        );
        const outputStem = isTrackedMockup
            ? lastMockupOutputStem
            : (/__Mockup_\d+__(?:AI|LIB)(?:_|$)/i.test(cleanDocumentName)
                ? sanitizeMockupNamePart(cleanDocumentName, 'Mockup', 140)
                : getNextMockupResultName('library', 'Manual', lastDesignName || cleanDocumentName));
        const savePath = path.join(folderPath, outputStem + '.png');

        setStatusBar('⏳ Сохранение ' + outputStem + '.png...');
        await psBridge.savePngAndClose(savePath);
        lastMockupDocName = null;
        lastMockupOutputStem = null;
        lastMockupTemplateName = null;
        lastMockupAiInfo = null;
        mockupDesignPath = null;
        setStatusBar('✓ Сохранено: ' + outputStem + '.png');
    } catch (error) {
        setStatusBar('Ошибка: ' + (error.message || error));
    }
}
// =====================================================================
// 13. Привязка кнопок
// =====================================================================
const btn_qe = document.getElementById("btn_qe"); if(btn_qe) btn_qe.addEventListener("click", () => handleSelectionProcess('enh_auto'));
const btn_ep = document.getElementById("btn_ep"); if(btn_ep) btn_ep.addEventListener("click", () => handleSelectionProcess('enh_custom'));
const btn_rmbg = document.getElementById("btn_rmbg"); if(btn_rmbg) btn_rmbg.addEventListener("click", () => handleSelectionProcess('rmbg'));

const btn_upscale = document.getElementById("btn_upscale"); if(btn_upscale) btn_upscale.addEventListener("click", sendUpscaleRequest);
const btn_gen = document.getElementById("btn_gen"); if(btn_gen) btn_gen.addEventListener("click", () => handleComfyRequest(getGenerationRequestType()));
const btn_img2img = document.getElementById("btn_img2img"); if(btn_img2img) btn_img2img.addEventListener("click", () => handleComfyRequest(getImg2ImgRequestType()));
const btn_uxui_generate = document.getElementById('btn_uxui_generate'); if (btn_uxui_generate) btn_uxui_generate.addEventListener('click', handleUXUIGeneration);
const btn_aplus_generate = document.getElementById('btn_aplus_generate'); if (btn_aplus_generate) btn_aplus_generate.addEventListener('click', handleAPlusGeneration);
const btn_generate_variations = document.getElementById("btn_generate_variations"); if(btn_generate_variations) btn_generate_variations.addEventListener("click", handleThreeResultGeneration);
const btn_expand = document.getElementById("btn_expand"); if(btn_expand) btn_expand.addEventListener("click", () => handleComfyRequest('expand'));
const btn_vector = document.getElementById("btn_vector"); if(btn_vector) btn_vector.addEventListener("click", handleVectorize);

const btn_save_mockup_png = document.getElementById("btn_save_mockup_png"); if(btn_save_mockup_png) btn_save_mockup_png.addEventListener("click", handleSaveMockupPng);
const btn_refresh_mockups = document.getElementById("btn_refresh_mockups"); if(btn_refresh_mockups) btn_refresh_mockups.addEventListener("click", loadMockupList);

const btn_mockup_back = document.getElementById("btn_mockup_back");
if(btn_mockup_back) btn_mockup_back.addEventListener("click", () => { currentMockupFolder = null; loadMockupList(); });

const btn_gen_mockup = document.getElementById("btn_gen_mockup"); if(btn_gen_mockup) btn_gen_mockup.addEventListener("click", () => handleComfyRequest('mockup_ai'));

// =====================================================================
// 14. HUB CONNECTION + COMFYUI HEALTH CHECK — Initialize
// =====================================================================
connectToHub();
startComfyHealthCheck();

updateQwenStepVisibility();
