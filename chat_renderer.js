const { ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

let io = null;
try { io = require('socket.io-client').io; } catch (error) { console.log('socket.io-client not available — hub features disabled'); }

let hubSocket = null;
let myNickname = localStorage.getItem('nickname') || '';
let isHubConnected = false;
let todoColumnsState = [];
let activeUsers = [];
let activityHistory = [];
let chatHistory = [];
let teamDataCachePath = '';
let hubFilesFolder = '';
let profilesState = {};
let pendingChatAttachments = [];
let pendingChatReply = null;
let pendingChatEdit = null;
let pendingCompletionAttachments = [];
let userPopover = null;
let userPopoverHideTimer = null;
let selectedTodoOwner = localStorage.getItem('todoOwner') || '';
let activeView = localStorage.getItem('chatActiveView') || 'chat';
let todoTaskView = localStorage.getItem('todoTaskView') || 'active';
let todoStateReceived = false;
let pendingCompletionTask = null;
let audioContext = null;
let chatSearchMatches = [];
let chatSearchMatchIndex = -1;
let generationHistoryItems = [];
let generationHistoryFolder = '';
let generationHistoryDrawerOpen = false;

const STATUS_LABELS = {
    new: 'Новая',
    in_progress: 'В работе',
    completed: 'Готово',
    cancelled: 'Отменена'
};
const PRIORITY_LABELS = {
    low: 'Низкий',
    normal: 'Обычный',
    high: 'Высокий',
    urgent: 'Срочный'
};
const PRIORITY_SCORES = { low: 0, normal: 20, high: 50, urgent: 90 };

const chatMessages = document.getElementById('chatMessages');
const chatScrollBottomBtn = document.getElementById('chatScrollBottomBtn');
const chatSearchBtn = document.getElementById('chatSearchBtn');
const chatSearchPanel = document.getElementById('chatSearchPanel');
const chatSearchInput = document.getElementById('chatSearchInput');
const chatSearchCount = document.getElementById('chatSearchCount');
const chatSearchPrevBtn = document.getElementById('chatSearchPrevBtn');
const chatSearchNextBtn = document.getElementById('chatSearchNextBtn');
const chatSearchCloseBtn = document.getElementById('chatSearchCloseBtn');
const chatClearHistoryBtn = document.getElementById('chatClearHistoryBtn');
const chatInput = document.getElementById('chatInput');
const chatSendBtn = document.getElementById('chatSendBtn');
const chatCloseBtn = document.getElementById('chatCloseBtn');
const chatTextSizeBtn = document.getElementById('chatTextSizeBtn');
const nickDisplay = document.getElementById('nickDisplay');
const nickEditBtn = document.getElementById('nickEditBtn');
const nickModalOverlay = document.getElementById('nickModalOverlay');
const nickModalError = document.getElementById('nickModalError');
const nickInput = document.getElementById('nickInput');
const nickSubmitBtn = document.getElementById('nickSubmitBtn');
const todoOwnerSelect = document.getElementById('todoOwnerSelect');
const todoColumnTitle = document.getElementById('todoColumnTitle');
const todoAddColumnBtn = document.getElementById('todoAddColumnBtn');
const todoColumnsElement = document.getElementById('todoColumns');
const todoNotice = document.getElementById('todoNotice');
const todoActiveTab = document.getElementById('todoActiveTab');
const todoCompletedTab = document.getElementById('todoCompletedTab');
const activityList = document.getElementById('activityList');
const activityClearHistoryBtn = document.getElementById('activityClearHistoryBtn');
const mentionSuggestions = document.getElementById('mentionSuggestions');
const completionModalOverlay = document.getElementById('completionModalOverlay');
const completionNoteInput = document.getElementById('completionNoteInput');
const completionModalError = document.getElementById('completionModalError');
const completionCancelBtn = document.getElementById('completionCancelBtn');
const completionSaveBtn = document.getElementById('completionSaveBtn');
const activeUsersSummary = document.getElementById('activeUsersSummary');
const activeUsersCount = document.getElementById('activeUsersCount');
const activeUsersTooltip = document.getElementById('activeUsersTooltip');
const chatImageInput = document.getElementById('chatImageInput');
const chatAttachBtn = document.getElementById('chatAttachBtn');
const chatEmojiBtn = document.getElementById('chatEmojiBtn');
const emojiMenu = document.getElementById('emojiMenu');
const chatAttachmentPreview = document.getElementById('chatAttachmentPreview');
const chatReplyPreview = document.getElementById('chatReplyPreview');
const chatReplyAuthor = document.getElementById('chatReplyAuthor');
const chatReplyText = document.getElementById('chatReplyText');
const chatReplyCancelBtn = document.getElementById('chatReplyCancelBtn');
const profileAvatarInput = document.getElementById('profileAvatarInput');
const profileAvatarBtn = document.getElementById('profileAvatarBtn');
const profileAvatarBox = document.getElementById('profileAvatarBox');
const profileNickname = document.getElementById('profileNickname');
const imageViewer = document.getElementById('imageViewer');
const imageViewerImage = document.getElementById('imageViewerImage');
const imageViewerClose = document.getElementById('imageViewerClose');

function saveLocalTeamData() {
    if (!teamDataCachePath) return;
    try {
        const temporaryPath = teamDataCachePath + '.tmp';
        fs.writeFileSync(temporaryPath, JSON.stringify({
            savedAt: Date.now(),
            chatHistory,
            todoColumns: todoColumnsState,
            activityHistory,
            profiles: profilesState
        }, null, 2), 'utf8');
        fs.renameSync(temporaryPath, teamDataCachePath);
    } catch (error) {
        console.warn('Could not save local team data cache.', error);
    }
}

async function initializeLocalTeamDataCache() {
    try {
        hubFilesFolder = await ipcRenderer.invoke('get-hub-files-folder');
        if (!hubFilesFolder) return;
        fs.mkdirSync(hubFilesFolder, { recursive: true });
        teamDataCachePath = path.join(hubFilesFolder, 'team-workspace.json');
        saveLocalTeamData();
    } catch (error) {
        console.warn('Could not initialize local team data cache.', error);
    }
}



function getHubBaseUrl() {
    const hubIP = localStorage.getItem('hubIP') || '127.0.0.1:3003';
    return 'http://' + hubIP;
}

function getHubFileUrl(file) {
    if (!file || !file.id || !/^[A-Za-z0-9_.-]+$/.test(String(file.id))) return '';
    return getHubBaseUrl() + '/hub-files/' + encodeURIComponent(file.id);
}

function profileAvatarFile(nickname) {
    const profile = profilesState && profilesState[String(nickname || '')];
    return profile && profile.avatar ? profile.avatar : null;
}

function makeAvatar(nickname, sizeClass) {
    const avatar = profileAvatarFile(nickname);
    if (avatar) {
        const image = document.createElement('img');
        image.className = 'user-avatar' + (sizeClass ? ' ' + sizeClass : '');
        image.src = getHubFileUrl(avatar);
        image.alt = String(nickname || 'Аватар');
        image.addEventListener('load', () => cacheHubFile(avatar));
        return image;
    }
    const fallback = document.createElement('span');
    fallback.className = 'user-avatar avatar-placeholder' + (sizeClass ? ' ' + sizeClass : '');
    fallback.textContent = String(nickname || '?').trim().slice(0, 1).toUpperCase() || '?';
    return fallback;
}

async function cacheHubFile(file) {
    if (!hubFilesFolder || !file || !file.id || !/^[A-Za-z0-9_.-]+$/.test(String(file.id))) return;
    const localPath = path.join(hubFilesFolder, String(file.id));
    if (fs.existsSync(localPath)) return;
    try {
        const response = await fetch(getHubFileUrl(file));
        if (!response.ok) return;
        fs.writeFileSync(localPath, Buffer.from(await response.arrayBuffer()));
    } catch (error) {}
}

function showImageViewer(source, label) {
    if (!source || !imageViewer || !imageViewerImage) return;
    imageViewerImage.src = source;
    imageViewerImage.alt = label || 'Изображение';
    imageViewer.classList.remove('hidden');
}

function hideImageViewer() {
    if (!imageViewer) return;
    imageViewer.classList.add('hidden');
    if (imageViewerImage) imageViewerImage.src = '';
}

function renderStoredAttachments(container, attachments) {
    if (!container || !Array.isArray(attachments) || !attachments.length) return;
    const gallery = document.createElement('div');
    gallery.className = 'attachment-gallery';
    attachments.forEach(file => {
        const source = getHubFileUrl(file);
        if (!source) return;
        const image = document.createElement('img');
        image.className = 'attachment-image';
        image.src = source;
        image.alt = file.name || 'Изображение';
        image.title = 'Открыть: ' + (file.name || 'изображение');
        image.addEventListener('load', () => cacheHubFile(file));
        image.addEventListener('click', () => showImageViewer(source, file.name));
        gallery.appendChild(image);
    });
    if (gallery.childElementCount) container.appendChild(gallery);
}

function renderPendingAttachments(container, attachments, onRemove) {
    if (!container) return;
    container.replaceChildren();
    container.classList.toggle('hidden', !attachments.length);
    attachments.forEach((file, index) => {
        const chip = document.createElement('div');
        chip.className = 'attachment-chip';
        const image = document.createElement('img');
        image.src = file.dataUrl;
        image.alt = file.name || 'Изображение';
        image.addEventListener('click', () => showImageViewer(file.dataUrl, file.name));
        const remove = makeButton('×', 'attachment-remove', 'Убрать изображение');
        remove.addEventListener('click', () => {
            attachments.splice(index, 1);
            renderPendingAttachments(container, attachments, onRemove);
            if (onRemove) onRemove();
        });
        chip.append(image, remove);
        container.appendChild(chip);
    });
}

function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('Не удалось прочитать изображение.'));
        reader.onload = () => resolve(String(reader.result || ''));
        reader.readAsDataURL(file);
    });
}

function loadDataUrlImage(dataUrl) {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('Не удалось открыть изображение.'));
        image.src = dataUrl;
    });
}

async function prepareSharedImage(file, maxPixels = 1000000, maxDimension = 0) {
    if (!file || !String(file.type || '').startsWith('image/')) throw new Error('Можно прикрепить только изображение.');
    const originalDataUrl = await readFileAsDataUrl(file);
    const image = await loadDataUrlImage(originalDataUrl);
    const originalWidth = image.naturalWidth || image.width;
    const originalHeight = image.naturalHeight || image.height;
    const originalPixels = originalWidth * originalHeight;
    const dimensionScale = maxDimension && Math.max(originalWidth, originalHeight) > maxDimension
        ? maxDimension / Math.max(originalWidth, originalHeight) : 1;
    const pixelScale = originalPixels > maxPixels ? Math.sqrt(maxPixels / originalPixels) : 1;
    const scale = Math.min(1, dimensionScale, pixelScale);
    if (scale >= 0.9999) return { name: file.name || 'image.png', mime: file.type || 'image/png', dataUrl: originalDataUrl, width: originalWidth, height: originalHeight };
    const width = Math.max(1, Math.round(originalWidth * scale));
    const height = Math.max(1, Math.round(originalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, 0, 0, width, height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('Не удалось уменьшить изображение.');
    const resizedDataUrl = await readFileAsDataUrl(new File([blob], (file.name || 'image').replace(/\.[^.]+$/, '') + '.png', { type: 'image/png' }));
    return { name: (file.name || 'image').replace(/\.[^.]+$/, '') + '.png', mime: 'image/png', dataUrl: resizedDataUrl, width, height };
}

async function addImagesToList(files, target, preview) {
    const list = Array.from(files || []).filter(file => file && String(file.type || '').startsWith('image/'));
    if (!list.length) return;
    try {
        for (const file of list.slice(0, Math.max(0, 4 - target.length))) target.push(await prepareSharedImage(file));
        renderPendingAttachments(preview, target);
    } catch (error) {
        addSystemMessage('⚠️ ' + (error.message || error));
    }
}

function makeAttachmentControls(attachments) {
    const wrapper = document.createElement('div');
    wrapper.className = 'todo-attachment-controls';
    const preview = document.createElement('div');
    preview.className = 'todo-attachment-preview hidden';
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp,image/gif';
    input.multiple = true;
    input.className = 'hidden';
    const button = makeButton('📎', 'task-action-btn image-attachment-btn', 'Прикрепить изображение до 1 MP');
    const refresh = () => renderPendingAttachments(preview, attachments);
    button.addEventListener('click', () => input.click());
    input.addEventListener('change', async () => { await addImagesToList(input.files, attachments, preview); input.value = ''; });
    wrapper.append(button, input, preview);
    wrapper.imageAttachmentReceiver = async files => { await addImagesToList(files, attachments, preview); };
    wrapper.refreshAttachments = refresh;
    refresh();
    return wrapper;
}

function enableTextImageAttachments(input, controls) {
    if (!input || !controls) return;
    input.imageAttachmentReceiver = controls.imageAttachmentReceiver;
    input.addEventListener('dragover', event => event.preventDefault());
    input.addEventListener('drop', event => {
        const files = event.dataTransfer && event.dataTransfer.files;
        if (files && files.length) {
            event.preventDefault();
            controls.imageAttachmentReceiver(files);
        }
    });
    input.addEventListener('paste', event => {
        const files = Array.from(event.clipboardData?.items || []).filter(item => item.type.startsWith('image/')).map(item => item.getAsFile()).filter(Boolean);
        if (files.length) {
            event.preventDefault();
            controls.imageAttachmentReceiver(files);
        }
    });
}

function updateProfileView() {
    if (profileNickname) profileNickname.textContent = myNickname || 'Сначала укажите ник';
    if (!profileAvatarBox) return;
    profileAvatarBox.replaceChildren(makeAvatar(myNickname || '?', 'large'));
}

function appendUserLabel(container, nickname, prefix, className) {
    const label = document.createElement('span');
    if (className) label.className = className;
    if (prefix) label.appendChild(document.createTextNode(prefix));
    label.append(makeAvatar(nickname, 'small'), document.createTextNode(String(nickname || '—')));
    attachUserPopover(label, nickname);
    container.appendChild(label);
    return label;
}

function escapeText(value) {
    return typeof value === 'string' ? value : String(value === undefined || value === null ? '' : value);
}

function formatDateTime(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime())
        ? '—'
        : date.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatDuration(durationMs) {
    const seconds = Math.max(0, Math.round((Number(durationMs) || 0) / 1000));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const restSeconds = seconds % 60;
    if (hours) return hours + ' ч ' + minutes + ' мин';
    return minutes ? minutes + ' мин ' + restSeconds + ' с' : restSeconds + ' с';
}

function appendText(element, text) {
    element.textContent = escapeText(text);
    return element;
}

function makeButton(text, className, title) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = text;
    if (title) button.title = title;
    return button;
}

function playNotificationBeep(isEveryone) {
    try {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) return;
        if (!audioContext) audioContext = new AudioContextClass();
        const now = audioContext.currentTime;
        const oscillator = audioContext.createOscillator();
        const gain = audioContext.createGain();
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(isEveryone ? 760 : 660, now);
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(isEveryone ? 0.07 : 0.035, now + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + (isEveryone ? 0.2 : 0.12));
        oscillator.connect(gain);
        gain.connect(audioContext.destination);
        oscillator.start(now);
        oscillator.stop(now + (isEveryone ? 0.21 : 0.13));
    } catch (error) {
        console.warn('Notification sound is unavailable.', error);
    }
}

function isMentionedInMessage(text) {
    if (!myNickname) return false;
    const escapedNickname = myNickname.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
    const mentionPattern = new RegExp('(^|\\s)@' + escapedNickname + '(?=$|\\s|[.,!?;:])', 'i');
    return mentionPattern.test(String(text || ''));
}

function isEveryoneMentioned(text) {
    return /(^|\\s)@everyone(?=$|\\s|[.,!?;:])/i.test(String(text || ''));
}

function setActiveView(view) {
    activeView = ['chat', 'todo', 'activity', 'profile'].includes(view) ? view : 'chat';
    localStorage.setItem('chatActiveView', activeView);
    const map = {
        chat: ['tabChat', 'chatView'],
        todo: ['tabTodo', 'todoView'],
        activity: ['tabActivity', 'activityView'],
        profile: ['tabProfile', 'profileView']
    };
    Object.entries(map).forEach(([name, ids]) => {
        document.getElementById(ids[0]).classList.toggle('active', name === activeView);
        document.getElementById(ids[1]).classList.toggle('active', name === activeView);
    });
    if (activeView === 'chat') ipcRenderer.send('chat:clear-notification', { kind: 'chat' });
    if (activeView === 'todo') ipcRenderer.send('chat:clear-notification', { kind: 'todo' });
    if (activeView === 'activity') refreshGenerationHistory();
}

function setTodoTaskView(view) {
    todoTaskView = view === 'completed' ? 'completed' : 'active';
    localStorage.setItem('todoTaskView', todoTaskView);
    todoActiveTab.classList.toggle('active', todoTaskView === 'active');
    todoCompletedTab.classList.toggle('active', todoTaskView === 'completed');
    renderTodoColumns();
}

document.getElementById('tabChat').addEventListener('click', () => setActiveView('chat'));
document.getElementById('tabTodo').addEventListener('click', () => setActiveView('todo'));
document.getElementById('tabActivity').addEventListener('click', () => setActiveView('activity'));
document.getElementById('tabProfile').addEventListener('click', () => setActiveView('profile'));
todoActiveTab.addEventListener('click', () => setTodoTaskView('active'));
todoCompletedTab.addEventListener('click', () => setTodoTaskView('completed'));

chatCloseBtn.addEventListener('click', () => {
    window.close();
});

const CHAT_TEXT_SCALES = [1, 1.1, 1.2, 1.3, 1.4];
let chatTextScale = Number(localStorage.getItem('chatTextScale')) || 1;
if (!CHAT_TEXT_SCALES.includes(chatTextScale)) chatTextScale = 1;

function applyChatTextScale() {
    localStorage.setItem('chatTextScale', String(chatTextScale));
    if (chatTextSizeBtn) {
        chatTextSizeBtn.title = 'Размер текста: ' + Math.round(chatTextScale * 100) + '%. Нажмите для увеличения.';
    }
    ipcRenderer.send('chat:set-text-scale', chatTextScale);
}

if (chatTextSizeBtn) {
    chatTextSizeBtn.addEventListener('click', () => {
        const currentIndex = CHAT_TEXT_SCALES.indexOf(chatTextScale);
        chatTextScale = CHAT_TEXT_SCALES[(currentIndex + 1) % CHAT_TEXT_SCALES.length];
        applyChatTextScale();
    });
}
applyChatTextScale();

function isChatAdministrator() {
    return String(myNickname || '').trim().toLocaleLowerCase('en-US') === 'ilya';
}

function updateChatAdminControls() {
    if (chatClearHistoryBtn) chatClearHistoryBtn.classList.toggle('hidden', !isChatAdministrator());
    if (activityClearHistoryBtn) activityClearHistoryBtn.classList.toggle('hidden', !isChatAdministrator());
}

function updateNickDisplay() {
    nickDisplay.replaceChildren(makeAvatar(myNickname || '?', 'small'), document.createTextNode(myNickname || '—'));
    updateChatAdminControls();
    updateProfileView();
    renderTodoOwnerOptions();
}

function setNickModalError(message) {
    if (!nickModalError) return;
    nickModalError.textContent = String(message || '');
    nickModalError.classList.toggle('hidden', !message);
}

function showNickModal() {
    nickModalOverlay.classList.remove('hidden');
    nickInput.value = myNickname;
    nickInput.focus();
}

function saveNickname() {
    const nickname = nickInput.value.trim();
    if (!nickname) return;
    setNickModalError('');
    myNickname = nickname;
    localStorage.setItem('nickname', nickname);
    updateNickDisplay();
    nickModalOverlay.classList.add('hidden');
    ipcRenderer.send('chat:send-nickname', nickname);
    if (hubSocket && hubSocket.connected) hubSocket.emit('user:join', nickname);
}

nickEditBtn.addEventListener('click', showNickModal);
nickSubmitBtn.addEventListener('click', saveNickname);
nickInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') saveNickname();
});

ipcRenderer.on('chat:set-nickname', (event, nickname) => {
    myNickname = String(nickname || '').trim();
    localStorage.setItem('nickname', myNickname);
    updateNickDisplay();
    if (hubSocket && hubSocket.connected && myNickname) hubSocket.emit('user:join', myNickname);
});

ipcRenderer.on('chat:update-hub-ip', (event, newHubIP) => {
    localStorage.setItem('hubIP', newHubIP);
    connectToHub();
});

window.addEventListener('focus', () => {
    if (activeView === 'chat') ipcRenderer.send('chat:clear-notification', { kind: 'chat' });
    if (activeView === 'todo') ipcRenderer.send('chat:clear-notification', { kind: 'todo' });
});

function highlightNavigationTarget(target) {
    if (!target) return;
    target.classList.remove('navigation-highlight');
    requestAnimationFrame(() => target.classList.add('navigation-highlight'));
    setTimeout(() => target.classList.remove('navigation-highlight'), 6000);
}

function openTodoFromMessage(todoLink) {
    if (!todoLink || !todoLink.ownerNickname || !todoLink.taskId) return;
    selectedTodoOwner = String(todoLink.ownerNickname);
    localStorage.setItem('todoOwner', selectedTodoOwner);
    setActiveView('todo');
    setTodoTaskView(todoLink.view === 'completed' ? 'completed' : 'active');
    renderTodoOwnerOptions();
    setTimeout(() => {
        const target = document.getElementById('todo-task-' + todoLink.taskId);
        if (target) { target.scrollIntoView({ behavior: 'smooth', block: 'center' }); highlightNavigationTarget(target); }
    }, 0);
}


function openActivityFromMessage(activityLink) {
    if (!activityLink || !activityLink.activityId) return;
    setActiveView('activity');
    setTimeout(() => {
        const target = document.getElementById('activity-' + activityLink.activityId);
        if (target) { target.scrollIntoView({ behavior: 'smooth', block: 'center' }); highlightNavigationTarget(target); }
    }, 0);
}

function findInProgressTask(nickname) {
    for (const column of todoColumnsState) {
        const task = Array.isArray(column.tasks) && column.tasks.find(item => item.status === 'in_progress');
        if (column.ownerNickname === nickname && task) return { ownerNickname: column.ownerNickname, taskId: task.id, view: 'active', description: task.description };
    }
    return null;
}

function ensureUserPopover() {
    if (userPopover) return userPopover;
    userPopover = document.createElement('div');
    userPopover.className = 'user-popover hidden';
    userPopover.addEventListener('mouseenter', () => { if (userPopoverHideTimer) clearTimeout(userPopoverHideTimer); });
    userPopover.addEventListener('mouseleave', scheduleUserPopoverHide);
    document.body.appendChild(userPopover);
    return userPopover;
}

function scheduleUserPopoverHide() {
    if (userPopoverHideTimer) clearTimeout(userPopoverHideTimer);
    userPopoverHideTimer = setTimeout(() => { if (userPopover) userPopover.classList.add('hidden'); }, 180);
}

function showUserPopover(anchor, nickname) {
    if (!anchor || !nickname) return;
    if (userPopoverHideTimer) clearTimeout(userPopoverHideTimer);
    const popover = ensureUserPopover();
    popover.replaceChildren();
    const row = document.createElement('div');
    row.className = 'profile-name-row';
    row.append(makeAvatar(nickname, 'small'));
    const name = document.createElement('span');
    name.className = 'user-popover-name';
    name.textContent = nickname;
    row.appendChild(name);
    popover.appendChild(row);
    const activeTask = findInProgressTask(nickname);
    if (activeTask) {
        const taskLink = makeButton('В работе: ' + String(activeTask.description || '').slice(0, 90), 'user-popover-task', 'Открыть текущую задачу');
        taskLink.addEventListener('click', () => { openTodoFromMessage(activeTask); popover.classList.add('hidden'); });
        popover.appendChild(taskLink);
    } else {
        const empty = document.createElement('div');
        empty.className = 'user-popover-empty';
        empty.textContent = 'Активных задач «В работе» нет.';
        popover.appendChild(empty);
    }
    const rect = anchor.getBoundingClientRect();
    popover.style.left = '0px';
    popover.style.top = '0px';
    popover.classList.remove('hidden');
    const popoverWidth = popover.offsetWidth;
    const popoverHeight = popover.offsetHeight;
    popover.style.left = Math.max(6, Math.min(window.innerWidth - popoverWidth - 6, rect.left)) + 'px';
    popover.style.top = Math.max(6, rect.top - popoverHeight - 6) + 'px';
}

function attachUserPopover(element, nickname, allowInChat = false) {
    if (!element || !nickname || !allowInChat || String(nickname) === 'ComfyFloatBar') return;
    element.addEventListener('mouseenter', () => showUserPopover(element, nickname));
    element.addEventListener('mouseleave', scheduleUserPopoverHide);
    element.addEventListener('contextmenu', event => { event.preventDefault(); showUserPopover(element, nickname); });
}

const REACTION_EMOJIS = ['👍', '❤️', '🔥', '😂', '🎉', '👀', '✅', '💯', '👎', '😢', '😡', '💔', '🤮'];
let reactionPicker = null;
let reactionPickerTarget = null;

function normalizedReactions(reactions) {
    if (!Array.isArray(reactions)) return [];
    return reactions.map(item => ({ emoji: String(item && item.emoji || ''), users: Array.isArray(item && item.users) ? item.users.map(user => String(user || '')).filter(Boolean) : [] })).filter(item => REACTION_EMOJIS.includes(item.emoji) && item.users.length);
}

function ensureReactionPicker() {
    if (reactionPicker) return reactionPicker;
    reactionPicker = document.createElement('div');
    reactionPicker.className = 'reaction-picker hidden';
    const actions = document.createElement('div');
    actions.className = 'reaction-picker-actions hidden';
    const emojis = document.createElement('div');
    emojis.className = 'reaction-picker-emojis';
    REACTION_EMOJIS.forEach(emoji => {
        const button = makeButton(emoji, '', 'Поставить реакцию ' + emoji);
        button.addEventListener('click', () => {
            if (!reactionPickerTarget || !requireReadyConnection()) return;
            const payload = reactionPickerTarget.type === 'message' ? { messageId: reactionPickerTarget.id, emoji } : { taskId: reactionPickerTarget.id, emoji };
            hubSocket.emit(reactionPickerTarget.type === 'message' ? 'chat:reaction:toggle' : 'todo:task:reaction:toggle', payload);
            hideReactionPicker();
        });
        emojis.appendChild(button);
    });
    reactionPicker.append(actions, emojis);
    document.body.appendChild(reactionPicker);
    return reactionPicker;
}

function hideReactionPicker() {
    if (reactionPicker) reactionPicker.classList.add('hidden');
    reactionPickerTarget = null;
}

function fillMessageActions(actions, message) {
    actions.replaceChildren();
    const ownMessage = message && String(message.nickname || '') === String(myNickname || '') && String(message.id || '');
    const administrator = isChatAdministrator();
    actions.classList.toggle('hidden', !ownMessage && !administrator);
    if (!ownMessage && !administrator) return;
    if (ownMessage) {
        const edit = makeButton('✎  Редактировать сообщение', '', 'Редактировать своё сообщение');
        edit.addEventListener('click', () => { hideReactionPicker(); startChatEdit(message); });
        actions.appendChild(edit);
    }
    const remove = makeButton('🗑  Удалить сообщение', 'reaction-delete-action', ownMessage ? 'Удалить своё сообщение' : 'Удалить сообщение для всех участников');
    remove.addEventListener('click', () => {
        if (!window.confirm('Удалить это сообщение для всех участников?')) return;
        if (requireReadyConnection()) hubSocket.emit('chat:message:delete', { messageId: String(message.id) });
        hideReactionPicker();
    });
    actions.appendChild(remove);
}

function showReactionPicker(event, type, id, message) {
    if (!id) return;
    event.preventDefault();
    event.stopPropagation();
    const picker = ensureReactionPicker();
    reactionPickerTarget = { type, id };
    fillMessageActions(picker.querySelector('.reaction-picker-actions'), type === 'message' ? message : null);
    picker.classList.remove('hidden');
    const width = picker.offsetWidth;
    const height = picker.offsetHeight;
    picker.style.left = Math.max(6, Math.min(window.innerWidth - width - 6, event.clientX - 10)) + 'px';
    picker.style.top = Math.max(6, Math.min(window.innerHeight - height - 6, event.clientY - height - 8)) + 'px';
}

function renderReactionBar(container, reactions, type, id) {
    if (!container) return;
    const existing = Array.from(container.children).find(child => child.classList && child.classList.contains('reaction-bar'));
    const normalized = normalizedReactions(reactions);
    if (!normalized.length) { if (existing) existing.remove(); return; }
    const bar = existing || document.createElement('div');
    bar.className = 'reaction-bar';
    bar.replaceChildren();
    normalized.forEach(reaction => {
        const chip = makeButton(reaction.emoji, 'reaction-chip' + (reaction.users.includes(myNickname) ? ' own' : ''), reaction.users.join(', '));
        const count = document.createElement('span');
        count.className = 'reaction-count';
        count.textContent = String(reaction.users.length);
        chip.appendChild(count);
        chip.addEventListener('click', event => {
            event.stopPropagation();
            if (!requireReadyConnection()) return;
            hubSocket.emit(type === 'message' ? 'chat:reaction:toggle' : 'todo:task:reaction:toggle', type === 'message' ? { messageId: id, emoji: reaction.emoji } : { taskId: id, emoji: reaction.emoji });
        });
        bar.appendChild(chip);
    });
    if (!existing) container.appendChild(bar);
}

document.addEventListener('pointerdown', event => { if (reactionPicker && !reactionPicker.classList.contains('hidden') && !reactionPicker.contains(event.target)) hideReactionPicker(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && reactionPicker && !reactionPicker.classList.contains('hidden')) hideReactionPicker(); });

function getReplyPreviewText(message) {
    const text = String(message && message.text || '').replace(/\s+/g, ' ').trim();
    if (text) return text.slice(0, 280);
    return Array.isArray(message && message.attachments) && message.attachments.length ? '🖼 Изображение' : 'Сообщение';
}

function makeReplyReference(message) {
    return { messageId: String(message && message.id || '').slice(0, 120), nickname: String(message && message.nickname || 'Участник').trim().slice(0, 20), text: getReplyPreviewText(message), timestamp: Number(message && message.timestamp) || Date.now() };
}

function renderChatReplyPreview() {
    if (!chatReplyPreview) return;
    const reference = pendingChatReply;
    const editing = pendingChatEdit;
    chatReplyPreview.classList.toggle('hidden', !reference && !editing);
    if (!reference && !editing) {
        if (chatReplyAuthor) chatReplyAuthor.textContent = '';
        if (chatReplyText) chatReplyText.textContent = '';
        if (chatAttachBtn) { chatAttachBtn.disabled = false; chatAttachBtn.title = 'Прикрепить изображение'; }
        return;
    }
    if (editing) {
        if (chatReplyAuthor) chatReplyAuthor.textContent = 'Редактирование сообщения';
        if (chatReplyText) chatReplyText.textContent = 'Измените текст и нажмите отправку.';
        if (chatAttachBtn) { chatAttachBtn.disabled = true; chatAttachBtn.title = 'Во время редактирования нельзя менять вложения'; }
        return;
    }
    if (chatReplyAuthor) chatReplyAuthor.textContent = 'Ответ ' + (reference.nickname || 'участнику');
    if (chatReplyText) chatReplyText.textContent = reference.text || 'Сообщение';
    if (chatAttachBtn) { chatAttachBtn.disabled = false; chatAttachBtn.title = 'Прикрепить изображение'; }
}

function startChatReply(message) { pendingChatEdit = null; pendingChatReply = makeReplyReference(message); renderChatReplyPreview(); chatInput.focus(); }
function startChatEdit(message) {
    if (!message || !message.id || String(message.nickname || '') !== String(myNickname || '')) return;
    pendingChatReply = null;
    pendingChatEdit = { id: String(message.id), hasAttachments: Array.isArray(message.attachments) && message.attachments.length > 0 };
    chatInput.value = String(message.text || '');
    renderChatReplyPreview();
    chatInput.focus();
    chatInput.setSelectionRange(chatInput.value.length, chatInput.value.length);
}
function clearChatReply() { pendingChatReply = null; pendingChatEdit = null; renderChatReplyPreview(); }

function scrollToReplyTarget(reference) {
    if (!reference) return;
    const id = String(reference.messageId || '');
    const timestamp = String(Number(reference.timestamp) || '');
    const target = Array.from(chatMessages.querySelectorAll('.chat-msg')).find(item => (id && item.dataset.messageId === id) || (!id && item.dataset.messageNickname === String(reference.nickname || '') && item.dataset.messageTimestamp === timestamp));
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    highlightNavigationTarget(target);
}

function addChatMessage(messageData, isSelf) {
    const data = messageData && typeof messageData === 'object' ? messageData : {};
    const nickname = String(data.nickname || 'Участник');
    const text = String(data.text || '');
    const timestamp = Number(data.timestamp) || Date.now();
    const todoLink = data.todoLink;
    const activityLink = data.activityLink;
    const attachments = data.attachments;
    const replyTo = data.replyTo;
    const isSystem = nickname === 'ComfyFloatBar';
    const placeholder = chatMessages.querySelector('.no-messages');
    if (placeholder) placeholder.remove();
    const message = document.createElement('div');
    message.className = 'chat-msg ' + (isSelf ? 'self ' : '') + (isSystem ? 'system' : '');
    message.dataset.messageId = String(data.id || '');
    message.dataset.messageNickname = nickname;
    message.dataset.messageTimestamp = String(timestamp);
    message.dataset.searchKey = chatSearchKey(data);
    if (!isSelf && !isSystem) message.appendChild(makeAvatar(nickname, 'small chat-msg-avatar'));
    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble';
    const header = document.createElement('div');
    header.className = 'msg-header';
    const nick = document.createElement('span');
    nick.className = 'msg-nick';
    nick.style.cursor = isSystem ? 'default' : 'pointer';
    nick.title = isSystem ? nickname : 'Нажмите, чтобы вставить @' + nickname + '. Наведите, чтобы увидеть задачу в работе.';
    appendText(nick, nickname);
    if (!isSystem) { nick.addEventListener('click', () => insertMention(nickname)); attachUserPopover(nick, nickname, true); }
    const time = document.createElement('span');
    time.className = 'msg-time';
    appendText(time, new Date(timestamp).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }));
    header.append(nick, time);
    if (data.editedAt) {
        const edited = document.createElement('span');
        edited.className = 'msg-edited';
        edited.textContent = 'изменено';
        header.appendChild(edited);
    }
    bubble.appendChild(header);
    if (replyTo && replyTo.nickname) {
        const reply = document.createElement('button');
        reply.type = 'button'; reply.className = 'message-reply'; reply.title = 'Перейти к исходному сообщению';
        const author = document.createElement('span'); author.className = 'message-reply-author'; appendText(author, String(replyTo.nickname));
        const preview = document.createElement('span'); preview.className = 'message-reply-text'; appendText(preview, String(replyTo.text || 'Сообщение'));
        reply.append(author, preview); reply.addEventListener('click', () => scrollToReplyTarget(replyTo)); bubble.appendChild(reply);
    }
    const body = document.createElement('div');
    body.className = 'msg-text';
    appendTextWithExternalLinks(body, text);
    const messageLink = todoLink && todoLink.ownerNickname && todoLink.taskId ? () => openTodoFromMessage(todoLink) : activityLink && activityLink.activityId ? () => openActivityFromMessage(activityLink) : null;
    if (messageLink) { body.classList.add('message-reference'); body.title = 'Открыть связанный элемент'; body.addEventListener('click', messageLink); }
    bubble.appendChild(body);
    renderStoredAttachments(bubble, attachments);
    renderReactionBar(bubble, data.reactions, 'message', String(data.id || ''));
    bubble.addEventListener('contextmenu', event => showReactionPicker(event, 'message', String(data.id || ''), data));
    message.appendChild(bubble);
    const replyButton = makeButton('↩', 'chat-reply-btn', 'Ответить на сообщение');
    replyButton.addEventListener('click', () => startChatReply(data));
    message.appendChild(replyButton);
    chatMessages.appendChild(message);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function addChatSeparator(text) {
    const separator = document.createElement('div');
    separator.className = 'chat-msg system';
    const content = document.createElement('div');
    content.className = 'msg-text';
    content.style.cssText = 'color:#888; font-size:10px; text-align:center;';
    appendText(content, text);
    separator.appendChild(content);
    chatMessages.appendChild(separator);
}

function addSystemMessage(text) {
    const message = document.createElement('div');
    message.className = 'chat-msg system';
    const content = document.createElement('div');
    content.className = 'msg-text';
    content.style.cssText = 'color:#f6ad55; font-style:italic;';
    appendText(content, text);
    message.appendChild(content);
    chatMessages.appendChild(message);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    setTimeout(() => { if (message.parentNode) message.remove(); }, 5000);
}

function chatSearchKey(message) {
    const data = message && typeof message === 'object' ? message : {};
    const id = String(data.id || '').trim();
    return id ? 'id:' + id : 'legacy:' + String(data.nickname || '') + ':' + String(Number(data.timestamp) || 0);
}

function messageMatchesSearch(message, query) {
    const data = message && typeof message === 'object' ? message : {};
    const attachmentNames = Array.isArray(data.attachments) ? data.attachments.map(item => String(item && item.name || '')).join(' ') : '';
    const searchable = [data.nickname, data.text, attachmentNames, data.replyTo && data.replyTo.text].map(value => String(value || '')).join(' ').toLocaleLowerCase('ru-RU');
    return searchable.includes(query);
}

function clearChatSearchHighlights() {
    if (!chatMessages) return;
    chatMessages.querySelectorAll('.search-match, .search-current').forEach(element => element.classList.remove('search-match', 'search-current'));
}

function showCurrentChatSearchMatch(shouldScroll) {
    clearChatSearchHighlights();
    chatSearchMatches.forEach(element => element.classList.add('search-match'));
    const current = chatSearchMatches[chatSearchMatchIndex];
    if (!current) return;
    current.classList.add('search-current');
    if (shouldScroll) current.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function refreshChatSearch(shouldScroll) {
    if (!chatSearchInput || !chatSearchPanel || chatSearchPanel.classList.contains('hidden')) return;
    const query = String(chatSearchInput.value || '').trim().toLocaleLowerCase('ru-RU');
    clearChatSearchHighlights();
    if (!query) {
        chatSearchMatches = [];
        chatSearchMatchIndex = -1;
        if (chatSearchCount) chatSearchCount.textContent = '';
        return;
    }
    const matchingKeys = new Set(chatHistory.filter(message => messageMatchesSearch(message, query)).map(chatSearchKey));
    chatSearchMatches = Array.from(chatMessages.querySelectorAll('.chat-msg[data-search-key]')).filter(element => matchingKeys.has(element.dataset.searchKey));
    if (!chatSearchMatches.length) {
        chatSearchMatchIndex = -1;
        if (chatSearchCount) chatSearchCount.textContent = '0';
        return;
    }
    if (chatSearchMatchIndex < 0 || chatSearchMatchIndex >= chatSearchMatches.length) chatSearchMatchIndex = 0;
    if (chatSearchCount) chatSearchCount.textContent = (chatSearchMatchIndex + 1) + '/' + chatSearchMatches.length;
    showCurrentChatSearchMatch(Boolean(shouldScroll));
}

function moveChatSearchResult(step) {
    if (!chatSearchMatches.length) { refreshChatSearch(true); return; }
    chatSearchMatchIndex = (chatSearchMatchIndex + step + chatSearchMatches.length) % chatSearchMatches.length;
    if (chatSearchCount) chatSearchCount.textContent = (chatSearchMatchIndex + 1) + '/' + chatSearchMatches.length;
    showCurrentChatSearchMatch(true);
}

function openChatSearch() {
    if (!chatSearchPanel) return;
    chatSearchPanel.classList.remove('hidden');
    if (chatSearchBtn) chatSearchBtn.classList.add('active');
    refreshChatSearch(false);
    if (chatSearchInput) chatSearchInput.focus();
}

function closeChatSearch() {
    if (chatSearchPanel) chatSearchPanel.classList.add('hidden');
    if (chatSearchBtn) chatSearchBtn.classList.remove('active');
    if (chatSearchInput) chatSearchInput.value = '';
    chatSearchMatches = [];
    chatSearchMatchIndex = -1;
    if (chatSearchCount) chatSearchCount.textContent = '';
    clearChatSearchHighlights();
}

function renderChatHistory(history) {
    chatHistory = Array.isArray(history) ? history : [];
    saveLocalTeamData();
    chatMessages.replaceChildren();
    if (!chatHistory.length) {
        const empty = document.createElement('div');
        empty.className = 'no-messages';
        empty.textContent = 'Нет сообщений';
        chatMessages.appendChild(empty);
        return;
    }
    addChatSeparator('── предыдущие сообщения ──');
    chatHistory.forEach(message => addChatMessage(message, message.nickname === myNickname));
    addChatSeparator('── новые сообщения ──');
    chatMessages.scrollTop = chatMessages.scrollHeight;
    refreshChatSearch(false);
}

function requireReadyConnection() {
    if (!myNickname) {
        showNickModal();
        return false;
    }
    if (!hubSocket || !hubSocket.connected) {
        addSystemMessage('⚠️ Hub не подключён — проверьте адрес в настройках');
        return false;
    }
    return true;
}

function sendToChat(text, options = {}) {
    const cleanText = String(text || '').trim().slice(0, 2000);
    const attachments = Array.isArray(options.attachments) ? options.attachments : [];
    if ((!cleanText && !attachments.length) || !requireReadyConnection()) return false;
    hubSocket.emit('chat:message', { text: cleanText, todoLink: options.todoLink, activityLink: options.activityLink, replyTo: options.replyTo, attachments });
    return true;
}

function updateChatScrollBottomButton() {
    if (!chatScrollBottomBtn || !chatMessages) return;
    const distance = chatMessages.scrollHeight - chatMessages.scrollTop - chatMessages.clientHeight;
    chatScrollBottomBtn.classList.toggle('hidden', distance < 72);
}
if (chatMessages) chatMessages.addEventListener('scroll', updateChatScrollBottomButton);
if (chatScrollBottomBtn) chatScrollBottomBtn.addEventListener('click', () => { chatMessages.scrollTo({ top: chatMessages.scrollHeight, behavior: 'smooth' }); });
if (chatSearchBtn) chatSearchBtn.addEventListener('click', () => {
    if (chatSearchPanel && !chatSearchPanel.classList.contains('hidden')) closeChatSearch();
    else openChatSearch();
});
if (chatSearchInput) {
    chatSearchInput.addEventListener('input', () => { chatSearchMatchIndex = -1; refreshChatSearch(true); });
    chatSearchInput.addEventListener('keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); moveChatSearchResult(event.shiftKey ? -1 : 1); }
        else if (event.key === 'Escape') { event.preventDefault(); closeChatSearch(); chatInput.focus(); }
    });
}
if (chatSearchPrevBtn) chatSearchPrevBtn.addEventListener('click', () => moveChatSearchResult(-1));
if (chatSearchNextBtn) chatSearchNextBtn.addEventListener('click', () => moveChatSearchResult(1));
if (chatSearchCloseBtn) chatSearchCloseBtn.addEventListener('click', () => { closeChatSearch(); chatInput.focus(); });
if (chatClearHistoryBtn) chatClearHistoryBtn.addEventListener('click', () => {
    if (!isChatAdministrator() || !requireReadyConnection()) return;
    if (window.confirm('Удалить всю историю чата для всех участников? Это действие нельзя отменить.')) hubSocket.emit('chat:history:clear');
});
if (activityClearHistoryBtn) activityClearHistoryBtn.addEventListener('click', () => {
    if (!isChatAdministrator() || !requireReadyConnection()) return;
    if (window.confirm('Удалить всю историю действий для всех участников? Это действие нельзя отменить.')) hubSocket.emit('activity:history:clear');
});
document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && String(event.key || '').toLowerCase() === 'f') { event.preventDefault(); openChatSearch(); }
});

renderActiveUsers();

function sendChatMessage() {
    const text = chatInput.value.trim();
    if (pendingChatEdit) {
        if (!text && !pendingChatEdit.hasAttachments) { addSystemMessage('Введите текст сообщения или отмените редактирование.'); return; }
        if (!requireReadyConnection()) return;
        hubSocket.emit('chat:message:edit', { messageId: pendingChatEdit.id, text });
        chatInput.value = '';
        pendingChatAttachments = [];
        renderPendingAttachments(chatAttachmentPreview, pendingChatAttachments);
        clearChatReply();
        return;
    }
    if (sendToChat(text, { attachments: pendingChatAttachments, replyTo: pendingChatReply })) {
        chatInput.value = '';
        pendingChatAttachments = [];
        renderPendingAttachments(chatAttachmentPreview, pendingChatAttachments);
        clearChatReply();
    }
}

chatSendBtn.addEventListener('click', sendChatMessage);
if (chatReplyCancelBtn) chatReplyCancelBtn.addEventListener('click', clearChatReply);
chatInput.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
        if (pendingChatReply) clearChatReply();
        else hideMentionSuggestions();
        return;
    }
    if (event.key === 'Enter') sendChatMessage();
});
chatInput.addEventListener('input', updateMentionSuggestions);
chatInput.addEventListener('blur', () => setTimeout(hideMentionSuggestions, 120));

if (imageViewerClose) imageViewerClose.addEventListener('click', hideImageViewer);
if (imageViewer) imageViewer.addEventListener('click', event => { if (event.target === imageViewer) hideImageViewer(); });
ipcRenderer.on('generation-history:changed', refreshGenerationHistory);
if (chatAttachBtn) chatAttachBtn.addEventListener('click', () => { if (pendingChatEdit) return; chatImageInput.click(); });
if (chatImageInput) chatImageInput.addEventListener('change', async () => { if (!pendingChatEdit) await addImagesToList(chatImageInput.files, pendingChatAttachments, chatAttachmentPreview); chatImageInput.value = ''; });
const CHAT_EMOJIS = ['😀', '😂', '😍', '👍', '👎', '🙏', '🔥', '🎉', '✅', '❗', '🤝', '💡', '🖼️', '🚀', '❤️', '😎', '🤔', '😢'];
if (emojiMenu) CHAT_EMOJIS.forEach(emoji => {
    const button = makeButton(emoji, '', 'Вставить ' + emoji);
    button.addEventListener('click', () => { const caret = chatInput.selectionStart || chatInput.value.length; chatInput.value = chatInput.value.slice(0, caret) + emoji + chatInput.value.slice(caret); chatInput.focus(); chatInput.setSelectionRange(caret + emoji.length, caret + emoji.length); emojiMenu.classList.add('hidden'); });
    emojiMenu.appendChild(button);
});
function positionEmojiMenu() {
    if (!emojiMenu || !chatEmojiBtn) return;
    const rect = chatEmojiBtn.getBoundingClientRect();
    const width = emojiMenu.offsetWidth;
    const height = emojiMenu.offsetHeight;
    emojiMenu.style.left = Math.max(6, Math.min(window.innerWidth - width - 6, rect.right - width)) + 'px';
    emojiMenu.style.top = Math.max(6, rect.top - height - 6) + 'px';
}
if (chatEmojiBtn) chatEmojiBtn.addEventListener('click', () => {
    const willOpen = emojiMenu.classList.contains('hidden');
    emojiMenu.classList.toggle('hidden', !willOpen);
    if (willOpen) requestAnimationFrame(positionEmojiMenu);
});
const chatViewElement = document.getElementById('chatView');
if (chatViewElement) {
    chatViewElement.addEventListener('dragover', event => event.preventDefault());
    chatViewElement.addEventListener('drop', event => { const files = event.dataTransfer && event.dataTransfer.files; if (files && files.length) { event.preventDefault(); addImagesToList(files, pendingChatAttachments, chatAttachmentPreview); } });
}
document.addEventListener('paste', event => {
    if (event.defaultPrevented) return;
    const files = Array.from(event.clipboardData?.items || []).filter(item => item.type.startsWith('image/')).map(item => item.getAsFile()).filter(Boolean);
    if (!files.length) return;
    const receiver = document.activeElement && document.activeElement.imageAttachmentReceiver;
    if (receiver) { event.preventDefault(); receiver(files); return; }
    if (activeView === 'chat') { event.preventDefault(); addImagesToList(files, pendingChatAttachments, chatAttachmentPreview); }
});

if (profileAvatarBtn) profileAvatarBtn.addEventListener('click', () => profileAvatarInput.click());
if (profileAvatarInput) profileAvatarInput.addEventListener('change', async () => {
    const file = profileAvatarInput.files && profileAvatarInput.files[0];
    profileAvatarInput.value = '';
    if (!file || !requireReadyConnection()) return;
    try {
        const avatar = await prepareSharedImage(file, 256 * 256, 256);
        hubSocket.emit('profile:update', { avatar }, result => { if (!result || !result.ok) addSystemMessage('⚠️ ' + ((result && result.error) || 'Не удалось сохранить аватар.')); });
    } catch (error) { addSystemMessage('⚠️ ' + (error.message || error)); }
});

function hideMentionSuggestions() {
    mentionSuggestions.replaceChildren();
    mentionSuggestions.classList.add('hidden');
}

function getMentionInputState() {
    const caret = chatInput.selectionStart || 0;
    const beforeCaret = chatInput.value.slice(0, caret);
    const match = beforeCaret.match(/(^|\s)@([^\s@]*)$/);
    if (!match) return null;
    return {
        query: match[2].toLocaleLowerCase('ru-RU'),
        replaceStart: beforeCaret.length - match[2].length - 1,
        caret
    };
}

function activeNicknameList() {
    const names = new Set();
    activeUsers.forEach(user => {
        if (user && user.nickname) names.add(String(user.nickname));
    });
    if (myNickname) names.add(myNickname);
    return Array.from(names).sort((left, right) => left.localeCompare(right, 'ru'));
}

function renderActiveUsers() {
    if (!activeUsersSummary || !activeUsersCount || !activeUsersTooltip) return;
    const names = Array.from(new Set(activeUsers
        .filter(user => user && user.nickname)
        .map(user => String(user.nickname))))
        .sort((left, right) => left.localeCompare(right, 'ru'));
    activeUsersCount.textContent = names.length + ' онлайн';
    activeUsersSummary.classList.toggle('offline', names.length === 0);
    activeUsersTooltip.replaceChildren();
    const title = document.createElement('div');
    title.className = 'active-users-tooltip-title';
    title.textContent = names.length ? 'Подключённые участники (' + names.length + ')' : 'Подключённых участников нет';
    activeUsersTooltip.appendChild(title);
    names.forEach(name => {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'active-users-tooltip-name';
        row.append(makeAvatar(name, 'small'), document.createTextNode(name + (name === myNickname ? ' (вы)' : '')));
        row.title = 'Нажмите, чтобы вставить @' + name;
        row.addEventListener('click', () => insertMention(name));
        activeUsersTooltip.appendChild(row);
    });
}

function insertMention(nickname, replaceStart) {
    const name = String(nickname || '').trim();
    if (!name) return;
    const caret = chatInput.selectionStart || chatInput.value.length;
    const start = typeof replaceStart === 'number' ? replaceStart : caret;
    const before = chatInput.value.slice(0, start);
    const needsSpace = before.length > 0 && !/\s$/.test(before);
    const insertion = (needsSpace ? ' ' : '') + '@' + name + ' ';
    const after = chatInput.value.slice(caret);
    chatInput.value = before + insertion + after;
    const nextCaret = (before + insertion).length;
    chatInput.focus();
    chatInput.setSelectionRange(nextCaret, nextCaret);
    hideMentionSuggestions();
}

function updateMentionSuggestions() {
    const mention = getMentionInputState();
    if (!mention) {
        hideMentionSuggestions();
        return;
    }
    const names = activeNicknameList().filter(name => name.toLocaleLowerCase('ru-RU').startsWith(mention.query));
    if ('everyone'.startsWith(mention.query)) names.unshift('everyone');
    mentionSuggestions.replaceChildren();
    if (!names.length) {
        mentionSuggestions.classList.add('hidden');
        return;
    }
    names.forEach(name => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'mention-suggestion';
        button.textContent = '@' + name;
        if (name === myNickname || name === 'everyone') {
            const note = document.createElement('small');
            note.textContent = name === 'everyone' ? 'все' : 'вы';
            button.appendChild(note);
        }
        button.addEventListener('mousedown', event => {
            event.preventDefault();
            insertMention(name, mention.replaceStart);
        });
        mentionSuggestions.appendChild(button);
    });
    mentionSuggestions.classList.remove('hidden');
}

function ownerNames() {
    const names = new Set();
    if (myNickname) names.add(myNickname);
    activeUsers.forEach(user => {
        if (user && user.nickname) names.add(user.nickname);
    });
    todoColumnsState.forEach(column => {
        if (column && column.ownerNickname) names.add(column.ownerNickname);
    });
    return Array.from(names).sort((left, right) => left.localeCompare(right, 'ru'));
}

function setTodoNotice(text) {
    if (!text) {
        todoNotice.classList.add('hidden');
        todoNotice.textContent = '';
        return;
    }
    todoNotice.textContent = text;
    todoNotice.classList.remove('hidden');
}

function renderTodoOwnerOptions() {
    const names = ownerNames();
    if (!selectedTodoOwner || !names.includes(selectedTodoOwner)) {
        selectedTodoOwner = myNickname && names.includes(myNickname) ? myNickname : (names[0] || '');
    }
    todoOwnerSelect.replaceChildren();
    if (!names.length) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = 'Нет доступных профилей';
        todoOwnerSelect.appendChild(option);
    } else {
        names.forEach(name => {
            const option = document.createElement('option');
            option.value = name;
            option.textContent = name === myNickname ? name + ' (вы)' : name;
            option.selected = name === selectedTodoOwner;
            todoOwnerSelect.appendChild(option);
        });
    }
    todoOwnerSelect.disabled = !names.length;
    renderTodoColumns();
}

function getDueState(task) {
    if (!task || !task.dueAt) return { key: '', score: 0, label: '' };
    const due = new Date(task.dueAt);
    if (Number.isNaN(due.getTime())) return { key: '', score: 0, label: '' };
    const deltaMs = due.getTime() - Date.now();
    const absoluteHours = Math.max(1, Math.round(Math.abs(deltaMs) / (60 * 60 * 1000)));
    if (deltaMs < 0) return { key: 'overdue', score: 420, label: 'Просрочено на ' + absoluteHours + ' ч' };
    if (deltaMs <= 24 * 60 * 60 * 1000) return { key: 'today', score: 320, label: 'Осталось менее суток' };
    if (deltaMs <= 3 * 24 * 60 * 60 * 1000) return { key: 'soon', score: 210, label: 'Осталось около ' + Math.ceil(deltaMs / (24 * 60 * 60 * 1000)) + ' дн.' };
    if (deltaMs <= 7 * 24 * 60 * 60 * 1000) return { key: 'soon', score: 100, label: 'Срок в течение недели' };
    return { key: '', score: 0, label: '' };
}

function compareTasks(left, right) {
    if (todoTaskView === 'completed') {
        return (Number(right.completedAt) || 0) - (Number(left.completedAt) || 0);
    }
    const leftPriority = PRIORITY_SCORES[left.priority] === undefined ? PRIORITY_SCORES.normal : PRIORITY_SCORES[left.priority];
    const rightPriority = PRIORITY_SCORES[right.priority] === undefined ? PRIORITY_SCORES.normal : PRIORITY_SCORES[right.priority];
    const scoreDifference = getDueState(right).score + rightPriority - getDueState(left).score - leftPriority;
    if (scoreDifference) return scoreDifference;
    const leftDue = new Date(left.dueAt || '9999-12-31').getTime();
    const rightDue = new Date(right.dueAt || '9999-12-31').getTime();
    return leftDue - rightDue;
}

function priorityElement(priority) {
    const label = document.createElement('span');
    const normalized = PRIORITY_LABELS[priority] ? priority : 'normal';
    label.className = 'priority-' + normalized;
    label.textContent = 'Приоритет: ' + PRIORITY_LABELS[normalized];
    return label;
}

function openExternalLink(url) {
    ipcRenderer.invoke('open-external-link', url).catch(() => {});
}

function appendTextWithExternalLinks(container, value) {
    const text = String(value || '');
    const pieces = text.split(/(https?:\/\/[^\s]+)/g);
    pieces.forEach(piece => {
        if (!piece) return;
        if (/^https?:\/\//i.test(piece)) {
            let url;
            try { url = new URL(piece); } catch (error) { url = null; }
            if (url && (url.protocol === 'http:' || url.protocol === 'https:')) {
                const link = document.createElement('a');
                link.href = '#';
                link.className = 'todo-link';
                link.textContent = piece;
                link.addEventListener('click', event => {
                    event.preventDefault();
                    event.stopPropagation();
                    openExternalLink(url.href);
                });
                container.appendChild(link);
                return;
            }
        }
        container.appendChild(document.createTextNode(piece));
    });
}

function appendLinks(container, links) {
    const values = String(links || '').split(/[\s,]+/).filter(Boolean);
    if (!values.length) return;
    const row = document.createElement('div');
    row.className = 'todo-link';
    values.forEach((value, index) => {
        if (index) row.appendChild(document.createTextNode(' · '));
        let url;
        try { url = new URL(value); } catch (error) { url = null; }
        if (url && (url.protocol === 'http:' || url.protocol === 'https:')) {
            const link = document.createElement('a');
            link.href = '#';
            link.className = 'todo-link';
            link.textContent = value;
            link.addEventListener('click', event => {
                event.preventDefault();
                openExternalLink(url.href);
            });
            row.appendChild(link);
        } else {
            row.appendChild(document.createTextNode(value));
        }
    });
    container.appendChild(row);
}

function showCompletionModal(task) {
    pendingCompletionTask = task;
    pendingCompletionAttachments.length = 0;
    if (completionAttachmentControls) completionAttachmentControls.refreshAttachments();
    completionNoteInput.value = '';
    completionModalError.textContent = '';
    completionModalOverlay.classList.remove('hidden');
    completionNoteInput.focus();
}

function hideCompletionModal() {
    pendingCompletionTask = null;
    pendingCompletionAttachments.length = 0;
    if (completionAttachmentControls) completionAttachmentControls.refreshAttachments();
    completionModalOverlay.classList.add('hidden');
    completionModalError.textContent = '';
}

completionCancelBtn.addEventListener('click', () => {
    hideCompletionModal();
    renderTodoColumns();
});

completionSaveBtn.addEventListener('click', () => {
    const completionNote = completionNoteInput.value.trim();
    if (!pendingCompletionTask || (!completionNote && !pendingCompletionAttachments.length)) {
        completionModalError.textContent = 'Укажите результат, ссылку или прикрепите изображение для проверки.';
        return;
    }
    if (!requireReadyConnection()) return;
    hubSocket.emit('todo:task:update-status', {
        taskId: pendingCompletionTask.id,
        status: 'completed',
        completionNote,
        completionAttachments: pendingCompletionAttachments
    });
    hideCompletionModal();
});

const completionAttachmentControls = makeAttachmentControls(pendingCompletionAttachments);
completionNoteInput.parentNode.insertBefore(completionAttachmentControls, completionModalError);
enableTextImageAttachments(completionNoteInput, completionAttachmentControls);

function createCommentsSection(task) {
    const section = document.createElement('section');
    section.className = 'comments-section';
    const title = document.createElement('div');
    title.className = 'comments-title';
    title.textContent = 'Комментарии для проверки';
    section.appendChild(title);

    const comments = Array.isArray(task.comments) ? task.comments : [];
    comments.forEach(comment => {
        const item = document.createElement('div');
        item.className = 'comment-item';
        const author = document.createElement('span');
        author.className = 'comment-author profile-name-row';
        author.append(makeAvatar(comment.nickname, 'small'), document.createTextNode(comment.nickname));
        attachUserPopover(author, comment.nickname);
        const time = document.createElement('span');
        time.className = 'comment-time';
        time.textContent = formatDateTime(comment.createdAt);
        const body = document.createElement('div');
        appendTextWithExternalLinks(body, comment.text);
        item.append(author, time, body);
        renderStoredAttachments(item, comment.attachments);
        section.appendChild(item);
    });

    const form = document.createElement('div');
    form.className = 'comment-form';
    const input = document.createElement('input');
    input.className = 'field-input';
    input.type = 'text';
    input.maxLength = 1000;
    input.placeholder = 'Комментарий для автора';
    const attachments = [];
    const attachmentControls = makeAttachmentControls(attachments);
    enableTextImageAttachments(input, attachmentControls);
    const submit = makeButton('Отправить', 'primary-btn', 'Добавить комментарий');
    const addComment = () => {
        const text = input.value.trim();
        if ((!text && !attachments.length) || !requireReadyConnection()) return;
        hubSocket.emit('todo:task:add-comment', { taskId: task.id, text, attachments });
        input.value = '';
        attachments.length = 0;
        attachmentControls.refreshAttachments();
    };
    submit.addEventListener('click', addComment);
    input.addEventListener('keydown', event => {
        if (event.key === 'Enter') addComment();
    });
    form.append(input, attachmentControls, submit);
    section.appendChild(form);
    return section;
}

function shareTaskToChat(task, column) {
    const summary = String(task.description || '').replace(/\s+/g, ' ').slice(0, 115);
    const due = task.dueAt ? ', срок: ' + formatDateTime(task.dueAt) : '';
    const mentions = Array.from(new Set([column.ownerNickname, task.createdBy].filter(Boolean))).map(nickname => '@' + nickname).join(' ');
    sendToChat('📌 ' + mentions + ' Задача [' + column.ownerNickname + ' / ' + column.title + ']: ' + summary + ' — ' + (STATUS_LABELS[task.status] || task.status) + due, {
        todoLink: { ownerNickname: column.ownerNickname, taskId: task.id, view: task.status === 'completed' ? 'completed' : 'active' }
    });
}

function createTaskElement(task, column) {
    const priority = PRIORITY_LABELS[task.priority] ? task.priority : 'normal';
    const dueState = getDueState(task);
    const card = document.createElement('article');
    card.id = 'todo-task-' + task.id;
    card.className = 'todo-task priority-' + priority + (dueState.key ? ' due-' + dueState.key : '');

    const description = document.createElement('div');
    description.className = 'todo-task-description';
    appendTextWithExternalLinks(description, task.description);
    card.appendChild(description);
    renderStoredAttachments(card, task.attachments);

    const details = document.createElement('div');
    details.className = 'todo-task-info';
    details.appendChild(priorityElement(priority));
    if (task.dueAt) {
        const due = document.createElement('span');
        due.className = dueState.key ? 'todo-due-' + dueState.key : '';
        due.textContent = 'Срок: ' + formatDateTime(task.dueAt) + (dueState.label ? ' · ' + dueState.label : '');
        details.appendChild(due);
    }
    if (task.createdBy) {
        const created = document.createElement('span');
        created.className = 'profile-name-row';
        created.appendChild(document.createTextNode('Добавил(а): '));
        created.append(makeAvatar(task.createdBy, 'small'), document.createTextNode(task.createdBy));
        attachUserPopover(created, task.createdBy);
        details.appendChild(created);
    }
    appendLinks(details, task.links);
    card.appendChild(details);

    if (task.status === 'completed' && (task.completionNote || (Array.isArray(task.completionAttachments) && task.completionAttachments.length))) {
        const completion = document.createElement('div');
        completion.className = 'completion-note';
        const caption = document.createElement('strong');
        caption.textContent = 'Результат: ';
        completion.appendChild(caption);
        appendTextWithExternalLinks(completion, task.completionNote);
        if (task.completedBy || task.completedAt) {
            const meta = document.createElement('div');
            meta.style.cssText = 'margin-top:4px; color:#8abf92; font-size:10px;';
            meta.className = 'profile-name-row';
            meta.appendChild(document.createTextNode('Отметил(а): '));
            meta.append(makeAvatar(task.completedBy || '?', 'small'), document.createTextNode(task.completedBy || '—'));
            meta.appendChild(document.createTextNode(' · ' + formatDateTime(task.completedAt)));
            attachUserPopover(meta, task.completedBy);
            completion.appendChild(meta);
        }
        renderStoredAttachments(completion, task.completionAttachments);
        card.appendChild(completion);
    }

    if (task.status === 'completed') {
        renderReactionBar(card, task.reactions, 'task', String(task.id || ''));
        card.addEventListener('contextmenu', event => {
            if (event.target.closest('button, input, select, a')) return;
            showReactionPicker(event, 'task', String(task.id || ''));
        });
    }

    const statusRow = document.createElement('div');
    statusRow.className = 'todo-status-row';
    const statusCaption = document.createElement('span');
    statusCaption.className = 'todo-status-label';
    statusCaption.textContent = 'Статус';
    const select = document.createElement('select');
    select.className = 'field-select status-select';
    Object.entries(STATUS_LABELS).forEach(([value, label]) => {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        option.selected = value === task.status;
        select.appendChild(option);
    });
    const isOwner = column.ownerNickname === myNickname;
    select.disabled = !isOwner;
    select.title = isOwner ? 'Изменить статус' : 'Статус меняет ' + column.ownerNickname;
    select.addEventListener('change', () => {
        if (!isOwner) return;
        if (select.value === 'completed') {
            showCompletionModal(task);
            return;
        }
        if (requireReadyConnection()) {
            hubSocket.emit('todo:task:update-status', { taskId: task.id, status: select.value });
        }
    });
    statusRow.append(statusCaption, select);
    card.appendChild(statusRow);

    const actions = document.createElement('div');
    actions.className = 'task-action-row';
    const share = makeButton('↗ В чат', 'task-action-btn', 'Поделиться задачей в чате');
    share.addEventListener('click', () => shareTaskToChat(task, column));
    actions.appendChild(share);
    if (isOwner) {
        const remove = makeButton('Удалить', 'task-action-btn task-delete-btn', 'Удалить задачу');
        remove.addEventListener('click', () => {
            if (!window.confirm('Удалить эту задачу?')) return;
            if (requireReadyConnection()) hubSocket.emit('todo:task:delete', { taskId: task.id });
        });
        actions.appendChild(remove);
    }
    card.appendChild(actions);

    if (task.status === 'completed') card.appendChild(createCommentsSection(task));
    return card;
}

function createTaskForm(column) {
    const form = document.createElement('div');
    form.className = 'todo-task-form';
    const title = document.createElement('div');
    title.className = 'todo-task-form-title';
    title.textContent = 'Добавить задачу';
    const description = document.createElement('textarea');
    description.className = 'task-description';
    description.placeholder = 'Описание задачи';
    description.maxLength = 1200;
    const links = document.createElement('input');
    links.className = 'field-input';
    links.placeholder = 'Ссылка или несколько ссылок';
    links.maxLength = 2000;
    const attachments = [];
    const attachmentControls = makeAttachmentControls(attachments);
    enableTextImageAttachments(description, attachmentControls);
    const row = document.createElement('div');
    row.className = 'task-form-row';
    const due = document.createElement('input');
    due.className = 'field-input';
    due.type = 'datetime-local';
    due.title = 'Срок выполнения';
    const priority = document.createElement('select');
    priority.className = 'field-select';
    Object.entries(PRIORITY_LABELS).forEach(([value, label]) => {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = 'Приоритет: ' + label;
        priority.appendChild(option);
    });
    row.append(due, priority);
    const submit = makeButton('Добавить задачу', 'primary-btn');
    submit.addEventListener('click', () => {
        const taskDescription = description.value.trim();
        if (!taskDescription) {
            setTodoNotice('Введите описание задачи.');
            return;
        }
        if (!requireReadyConnection()) return;
        hubSocket.emit('todo:task:create', {
            columnId: column.id,
            description: taskDescription,
            links: links.value.trim(),
            dueAt: due.value,
            priority: priority.value,
            attachments
        });
        description.value = '';
        attachments.length = 0;
        attachmentControls.refreshAttachments();
        links.value = '';
        due.value = '';
        priority.value = 'normal';
    });
    form.append(title, description, attachmentControls, links, row, submit);
    return form;
}

function createColumnElement(column, isOwner) {
    const element = document.createElement('section');
    element.className = 'todo-column';
    const heading = document.createElement('div');
    heading.className = 'todo-column-title';
    const name = document.createElement('div');
    name.textContent = column.title;
    const meta = document.createElement('div');
    meta.className = 'todo-column-meta profile-name-row';
    meta.appendChild(document.createTextNode('Создал(а): '));
    meta.append(makeAvatar(column.createdBy || '?', 'small'), document.createTextNode(column.createdBy || '—'));
    attachUserPopover(meta, column.createdBy);
    heading.append(name, meta);

    if (isOwner) {
        const removeColumn = makeButton('Удалить колонку', 'task-action-btn task-delete-btn', 'Удалить колонку и все её задачи');
        removeColumn.style.marginTop = '6px';
        removeColumn.addEventListener('click', () => {
            if (!window.confirm('Удалить колонку вместе со всеми задачами?')) return;
            if (requireReadyConnection()) hubSocket.emit('todo:column:delete', { columnId: column.id });
        });
        heading.appendChild(removeColumn);
    }

    const allTasks = Array.isArray(column.tasks) ? column.tasks : [];
    const tasks = allTasks
        .filter(task => todoTaskView === 'completed' ? task.status === 'completed' : task.status !== 'completed')
        .slice()
        .sort(compareTasks);
    const list = document.createElement('div');
    list.className = 'todo-task-list';
    if (!tasks.length) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.textContent = todoTaskView === 'completed' ? 'Готовых задач нет.' : 'Активных задач нет.';
        list.appendChild(empty);
    } else {
        tasks.forEach(task => list.appendChild(createTaskElement(task, column)));
    }
    element.append(heading, list);
    if (todoTaskView === 'active') element.appendChild(createTaskForm(column));
    return { element, hasTasks: tasks.length > 0 };
}

function renderTodoColumns() {
    todoColumnsElement.replaceChildren();
    if (!selectedTodoOwner) {
        setTodoNotice('Сначала укажите никнейм, чтобы открыть список задач.');
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.textContent = 'Нет выбранного профиля.';
        todoColumnsElement.appendChild(empty);
        return;
    }

    const isOwner = selectedTodoOwner === myNickname;
    const listName = todoTaskView === 'completed' ? 'готовых задач' : 'активных задач';
    setTodoNotice(isOwner
        ? 'Это ваш список ' + listName + '. Только вы можете менять статусы и удалять задачи или колонки.'
        : 'Список ' + listName + ' пользователя ' + selectedTodoOwner + '. Вы можете добавлять задачи, а менять статусы и удалять может только владелец.');

    const columns = todoColumnsState.filter(column => column.ownerNickname === selectedTodoOwner);
    if (!columns.length) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.textContent = 'В этом списке пока нет колонок. Создайте первую сверху.';
        todoColumnsElement.appendChild(empty);
        return;
    }

    let rendered = 0;
    columns.forEach(column => {
        const result = createColumnElement(column, isOwner);
        if (todoTaskView === 'completed' && !result.hasTasks) return;
        rendered += 1;
        todoColumnsElement.appendChild(result.element);
    });
    if (!rendered) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.textContent = 'Готовых задач пока нет.';
        todoColumnsElement.appendChild(empty);
    }
}

todoOwnerSelect.addEventListener('change', () => {
    selectedTodoOwner = todoOwnerSelect.value;
    localStorage.setItem('todoOwner', selectedTodoOwner);
    renderTodoColumns();
});

function createTodoColumn() {
    const title = todoColumnTitle.value.trim();
    if (!title) {
        setTodoNotice('Введите название колонки.');
        return;
    }
    if (!selectedTodoOwner) {
        setTodoNotice('Выберите профиль для списка.');
        return;
    }
    if (!requireReadyConnection()) return;
    todoColumnTitle.value = '';
    hubSocket.emit('todo:column:create', { ownerNickname: selectedTodoOwner, title }, result => {
        if (result && result.ok === false) {
            todoColumnTitle.value = title;
            setTodoNotice(result.error || 'Не удалось создать колонку.');
        }
    });
}
todoAddColumnBtn.addEventListener('click', createTodoColumn);
todoColumnTitle.addEventListener('keydown', event => {
    if (event.key === 'Enter') createTodoColumn();
});

function activityMetadataRows(entry) {
    const rows = [
        ['ID', entry.id],
        ['Код операции', entry.taskType],
        ['Начало задачи', entry.startedAt ? formatDateTime(entry.startedAt) : '—'],
        ['Старт ComfyUI', entry.comfyStartedAt ? formatDateTime(entry.comfyStartedAt) : '—'],
        ['Завершено', entry.completedAt ? formatDateTime(entry.completedAt) : formatDateTime(entry.timestamp)],
        ['ComfyUI', formatDuration(entry.durationMs)],
        ['Всего', formatDuration(entry.totalDurationMs || entry.durationMs)]
    ];
    if (entry.metadata && typeof entry.metadata === 'object') {
        Object.entries(entry.metadata).forEach(([key, value]) => rows.push([key, value]));
    }
    return rows.filter(row => row[1] !== undefined && row[1] !== null && String(row[1]) !== '');
}

function shareActivityToChat(entry) {
    sendToChat('◷ История: ' + entry.nickname + ' — ' + entry.action + ' · ComfyUI ' + formatDuration(entry.durationMs) + ' · ' + formatDateTime(entry.completedAt || entry.timestamp), { activityLink: { activityId: entry.id } });
}

const GENERATION_HISTORY_FOLDERS = Object.freeze([
    { name: 'Generations', label: 'Генерация' },
    { name: 'Mockups', label: 'Мокап' }
]);

async function refreshGenerationHistory() {
    try {
        generationHistoryFolder = await ipcRenderer.invoke('get-working-folder') || localStorage.getItem('workingFolder') || '';
        const allowed = /\.(?:png|jpe?g|webp)$/i;
        const items = [];
        if (generationHistoryFolder) {
            for (const folder of GENERATION_HISTORY_FOLDERS) {
                const folderPath = path.join(generationHistoryFolder, folder.name);
                if (!fs.existsSync(folderPath)) continue;
                for (const fileName of fs.readdirSync(folderPath)) {
                    if (!allowed.test(fileName) || /__Original\.(?:png|jpe?g|webp)$/i.test(fileName)) continue;
                    const filePath = path.join(folderPath, fileName);
                    const stats = fs.statSync(filePath);
                    if (!stats.isFile || stats.isFile()) {
                        items.push({ fileName, filePath, label: folder.label, mtimeMs: Number(stats.mtimeMs) || 0 });
                    }
                }
                if (folder.name === 'Generations') {
                    const patternsPath = path.join(folderPath, 'Patterns');
                    if (!fs.existsSync(patternsPath)) continue;
                    for (const runName of fs.readdirSync(patternsPath)) {
                        const manifestPath = path.join(patternsPath, runName, 'pattern.json');
                        if (!fs.existsSync(manifestPath)) continue;
                        try {
                            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
                            for (const asset of manifest.assets || []) {
                                if (!asset.upscaledPath || !fs.existsSync(asset.upscaledPath)) continue;
                                const stats = fs.statSync(asset.upscaledPath);
                                items.push({fileName:asset.name + ' ×4.png', filePath:asset.upscaledPath,
                                    label:asset.kind === 'background' ? 'Фон паттерна' : 'Элемент паттерна', mtimeMs:Number(stats.mtimeMs) || 0});
                            }
                        } catch (error) { console.warn('Не удалось прочитать паттерн:', error.message || error); }
                    }
                }
            }
        }
        generationHistoryItems = items.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 80);
    } catch (error) {
        generationHistoryItems = [];
        console.warn('Не удалось прочитать сохранённые изображения:', error.message || error);
    }
    if (activeView === 'activity') renderActivity();
}

function createGenerationHistoryDrawer() {
    const drawer = document.createElement('details');
    drawer.className = 'generation-history-drawer';
    drawer.open = generationHistoryDrawerOpen;
    drawer.addEventListener('toggle', () => { generationHistoryDrawerOpen = drawer.open; });

    const summary = document.createElement('summary');
    summary.append(document.createTextNode('🖼 Сгенерированные изображения '));
    const count = document.createElement('span');
    count.className = 'generation-history-count';
    count.textContent = '(' + generationHistoryItems.length + ')';
    summary.appendChild(count);

    const body = document.createElement('div');
    body.className = 'generation-history-body';
    const toolbar = document.createElement('div');
    toolbar.className = 'generation-history-toolbar';
    const location = document.createElement('div');
    location.className = 'generation-history-location';
    location.textContent = generationHistoryFolder || 'Папка сохранения ещё не определена';
    location.title = generationHistoryFolder;
    const refresh = document.createElement('button');
    refresh.type = 'button';
    refresh.className = 'generation-history-refresh';
    refresh.textContent = 'Обновить';
    refresh.addEventListener('click', refreshGenerationHistory);
    toolbar.append(location, refresh);

    const grid = document.createElement('div');
    grid.className = 'generation-history-grid';
    if (!generationHistoryItems.length) {
        const empty = document.createElement('div');
        empty.className = 'generation-history-empty';
        empty.textContent = 'Сохранённых генераций пока нет.';
        grid.appendChild(empty);
    } else {
        for (const item of generationHistoryItems) {
            const source = pathToFileURL(item.filePath).href + '?v=' + item.mtimeMs;
            const card = document.createElement('button');
            card.type = 'button';
            card.className = 'generation-history-card';
            card.title = 'Открыть на весь экран: ' + item.fileName;
            const image = document.createElement('img');
            image.src = source;
            image.alt = item.fileName;
            image.loading = 'lazy';
            const name = document.createElement('div');
            name.className = 'generation-history-card-name';
            name.textContent = item.fileName;
            const detail = document.createElement('div');
            detail.className = 'generation-history-card-detail';
            detail.textContent = item.label + (item.mtimeMs ? ' · ' + new Date(item.mtimeMs).toLocaleString() : '');
            card.append(image, name, detail);
            card.addEventListener('click', () => showImageViewer(source, item.fileName));
            grid.appendChild(card);
        }
    }
    body.append(toolbar, grid);
    drawer.append(summary, body);
    return drawer;
}

function renderActivity() {
    activityList.replaceChildren();
    activityList.appendChild(createGenerationHistoryDrawer());
    if (!Array.isArray(activityHistory) || !activityHistory.length) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.textContent = 'История действий пока пуста.';
        activityList.appendChild(empty);
        return;
    }
    activityHistory.forEach(entry => {
        const item = document.createElement('article');
        item.id = 'activity-' + entry.id;
        item.className = 'activity-item';
        const header = document.createElement('div');
        header.className = 'activity-header';
        const nickname = document.createElement('span');
        nickname.className = 'activity-nick profile-name-row';
        nickname.append(makeAvatar(entry.nickname, 'small'), document.createTextNode(entry.nickname));
        attachUserPopover(nickname, entry.nickname);
        const time = document.createElement('span');
        time.className = 'activity-time';
        time.textContent = formatDateTime(entry.completedAt || entry.timestamp);
        header.append(nickname, time);
        const action = document.createElement('div');
        action.className = 'activity-action';
        appendTextWithExternalLinks(action, entry.action);
        const duration = document.createElement('div');
        duration.className = 'activity-duration';
        duration.textContent = 'ComfyUI: ' + formatDuration(entry.durationMs) + ' · Всего: ' + formatDuration(entry.totalDurationMs || entry.durationMs);
        const metadataRows = activityMetadataRows(entry);
        const metadata = document.createElement('details');
        metadata.className = 'activity-metadata';
        const metadataSummary = document.createElement('summary');
        metadataSummary.textContent = 'Метаданные (' + metadataRows.length + ')';
        metadata.appendChild(metadataSummary);
        const metadataBody = document.createElement('div');
        metadataBody.className = 'activity-metadata-body';
        metadataRows.forEach(row => {
            const detail = document.createElement('div');
            const label = document.createElement('strong');
            label.textContent = row[0] + ': ';
            detail.appendChild(label);
            appendTextWithExternalLinks(detail, String(row[1]));
            metadataBody.appendChild(detail);
        });
        metadata.appendChild(metadataBody);
        const actions = document.createElement('div');
        actions.className = 'task-action-row';
        const share = makeButton('↗ В чат', 'task-action-btn', 'Поделиться записью в чате');
        share.addEventListener('click', () => shareActivityToChat(entry));
        actions.appendChild(share);
        item.append(header, action, duration, metadata, actions);
        activityList.appendChild(item);
    });
}

function taskIdsOwnedByMe(columns) {
    const ids = new Set();
    columns.forEach(column => {
        if (column.ownerNickname !== myNickname || !Array.isArray(column.tasks)) return;
        column.tasks.forEach(task => ids.add(task.id));
    });
    return ids;
}

function notifyAboutIncomingTasks(nextColumns) {
    if (!todoStateReceived || !myNickname) return;
    const oldIds = taskIdsOwnedByMe(todoColumnsState);
    const incoming = [];
    nextColumns.forEach(column => {
        if (column.ownerNickname !== myNickname || !Array.isArray(column.tasks)) return;
        column.tasks.forEach(task => {
            if (!oldIds.has(task.id) && task.createdBy !== myNickname) incoming.push(task);
        });
    });
    if (incoming.length) {
        playNotificationBeep(false);
        if (!document.hasFocus() || activeView !== 'todo') {
            ipcRenderer.send('chat:notification', { kind: 'todo' });
        }
    }
}

function connectToHub() {
    if (!io) {
        isHubConnected = false;
        addSystemMessage('ℹ️ socket.io-client не установлен — общий чат недоступен');
        return;
    }
    const hubIP = localStorage.getItem('hubIP') || '127.0.0.1:3003';
    if (hubSocket) {
        hubSocket.removeAllListeners();
        hubSocket.disconnect();
        hubSocket = null;
    }

    hubSocket = io('http://' + hubIP, { reconnection: true, reconnectionDelay: 2000, reconnectionDelayMax: 10000 });

    hubSocket.on('connect', () => {
        isHubConnected = true;
        addSystemMessage('✅ Hub подключён');
        if (myNickname) hubSocket.emit('user:join', myNickname);
        else showNickModal();
    });

    hubSocket.on('disconnect', () => {
        isHubConnected = false;
        activeUsers = [];
        renderActiveUsers();
        addSystemMessage('⚠️ Hub отключён');
    });

    hubSocket.on('chat:history', renderChatHistory);
    hubSocket.on('user:error', message => {
        const rejectedNickname = myNickname;
        myNickname = '';
        localStorage.removeItem('nickname');
        updateNickDisplay();
        showNickModal();
        nickInput.value = rejectedNickname;
        setNickModalError(String(message || 'Не удалось занять этот никнейм.'));
        addSystemMessage('⚠️ ' + String(message || 'Не удалось занять этот никнейм.'));
    });
    hubSocket.on('chat:history:clear', () => {
        chatHistory = [];
        saveLocalTeamData();
        renderChatHistory(chatHistory);
    });
    hubSocket.on('chat:message', message => {
        chatHistory.push(message);
        if (chatHistory.length > 200) chatHistory.shift();
        saveLocalTeamData();
        const isSelf = message.nickname === myNickname;
        const taskAssignment = message.nickname === 'ComfyFloatBar' && message.todoLink && message.todoLink.view === 'active';
        const everyoneMentioned = !isSelf && isEveryoneMentioned(message.text);
        const directMentioned = !isSelf && isMentionedInMessage(message.text);
        addChatMessage(message, isSelf);
        refreshChatSearch(false);

        if ((everyoneMentioned || directMentioned) && !taskAssignment) {
            playNotificationBeep(everyoneMentioned);
            if (!document.hasFocus() || activeView !== 'chat') {
                ipcRenderer.send('chat:notification', { kind: 'chat' });
            }
        } else if (!isSelf && !taskAssignment && !document.hasFocus()) {
            ipcRenderer.send('chat:notification', { kind: 'chat' });
        }
    });

    hubSocket.on('chat:reactions:update', payload => {
        const messageId = String(payload && payload.messageId || '');
        const reactions = normalizedReactions(payload && payload.reactions);
        const message = chatHistory.find(item => String(item && item.id || '') === messageId);
        if (message) message.reactions = reactions;
        const element = Array.from(chatMessages.querySelectorAll('.chat-msg')).find(item => item.dataset.messageId === messageId);
        const bubble = element && element.querySelector('.chat-bubble');
        if (bubble) renderReactionBar(bubble, reactions, 'message', messageId);
        saveLocalTeamData();
    });

    hubSocket.on('chat:message:update', payload => {
        const messageId = String(payload && payload.messageId || '');
        const deleted = Boolean(payload && payload.deleted);
        if (deleted) chatHistory = chatHistory.filter(item => String(item && item.id || '') !== messageId);
        else if (payload && payload.message) {
            const index = chatHistory.findIndex(item => String(item && item.id || '') === messageId);
            if (index >= 0) chatHistory[index] = payload.message;
        }
        saveLocalTeamData();
        renderChatHistory(chatHistory);
    });

    hubSocket.on('users:update', data => {
        activeUsers = Array.isArray(data?.list) ? data.list : [];
        activeUsers.forEach(user => {
            if (user && user.nickname && user.avatar) profilesState[String(user.nickname)] = Object.assign({}, profilesState[String(user.nickname)] || {}, { avatar: user.avatar });
        });
        renderActiveUsers();
        updateMentionSuggestions();
        renderTodoOwnerOptions();
    });

    hubSocket.on('profiles:state', state => {
        profilesState = state && typeof state === 'object' ? state : {};
        saveLocalTeamData();
        updateNickDisplay();
        renderActiveUsers();
        renderTodoColumns();
        renderActivity();
        if (chatHistory.length) renderChatHistory(chatHistory);
    });

    hubSocket.on('todo:state', columns => {
        const nextColumns = Array.isArray(columns) ? columns : [];
        notifyAboutIncomingTasks(nextColumns);
        todoColumnsState = nextColumns;
        todoStateReceived = true;
        saveLocalTeamData();
        renderTodoOwnerOptions();
    });

    hubSocket.on('todo:error', message => {
        renderTodoColumns();
        setTodoNotice(String(message || 'Не удалось обновить задачу.'));
    });

    hubSocket.on('activity:history', history => {
        activityHistory = Array.isArray(history) ? history : [];
        saveLocalTeamData();
        renderActivity();
    });

    hubSocket.on('activity:entry', entry => {
        if (!entry || !entry.id || activityHistory.some(item => item.id === entry.id)) return;
        activityHistory.unshift(entry);
        saveLocalTeamData();
        renderActivity();
    });

    hubSocket.on('connect_error', () => { isHubConnected = false; });
}

initializeLocalTeamDataCache();
updateNickDisplay();
setActiveView(activeView);
setTodoTaskView(todoTaskView);
renderTodoOwnerOptions();
renderActivity();
connectToHub();
if (!myNickname) showNickModal();
