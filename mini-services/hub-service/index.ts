import topazQueue from "./topaz-queue.js";
import { createServer } from "http";
import { Server } from "socket.io";
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "fs";
import { basename, dirname, extname, join } from "path";
import { fileURLToPath } from "url";

const PORT = Number(process.env.CFB_HUB_PORT) || 3003;
const MAX_HISTORY = 200;
const HUB_ADMIN_NICKNAME = "ilya";
const MAX_ACTIVITY_HISTORY = 500;
// Topaz originals are deliberately not capped by ComfyFloatBar. The practical
// ceiling is the memory available to Electron/Node and the transport itself.
const MAX_UPSCALE_IMAGE_BYTES = Number.MAX_SAFE_INTEGER;
const MAX_SHARED_IMAGE_BYTES = 8 * 1024 * 1024;
const UPSCALE_COLUMN_TITLE = "Апскейл";
const PICTURE_SERIES_INITIAL_NUMBER = 140;
const HUB_PROTOCOL_VERSION = 2;
const REACTION_EMOJIS = ["👍", "❤️", "🔥", "😂", "🎉", "👀", "✅", "💯", "👎", "😢", "😡", "💔", "🤮"];
const TODO_STATUSES = ["new", "in_progress", "completed", "cancelled"] as const;
type TodoStatus = typeof TODO_STATUSES[number];
type TodoPriority = "low" | "normal" | "high" | "urgent";
type ActivityMetadata = Record<string, string | number | boolean>;

type SharedFile = { id: string; name: string; mime: string; size: number };
type TodoChatLink = { ownerNickname: string; taskId: string; view: "active" | "completed" };
type ActivityChatLink = { activityId: string };
type ChatReplyReference = { messageId: string; nickname: string; text: string; timestamp: number };
type MessageReaction = { emoji: string; users: string[] };
type ChatMessage = {
  id: string;
  nickname: string;
  text: string;
  timestamp: number;
  todoLink?: TodoChatLink;
  activityLink?: ActivityChatLink;
  replyTo?: ChatReplyReference;
  editedAt?: number;
  reactions?: MessageReaction[];
  attachments?: SharedFile[];
};
type TodoComment = { id: string; nickname: string; text: string; createdAt: number; attachments?: SharedFile[] };
type TodoTask = {
  id: string;
  description: string;
  links: string;
  dueAt: string;
  priority: TodoPriority;
  status: TodoStatus;
  createdBy: string;
  createdAt: number;
  attachments?: SharedFile[];
  completionNote?: string;
  completionAttachments?: SharedFile[];
  completedBy?: string;
  completedAt?: number;
  reactions?: MessageReaction[];
  comments?: TodoComment[];
};
type TodoColumn = {
  id: string;
  ownerNickname: string;
  title: string;
  createdBy: string;
  createdAt: number;
  tasks: TodoTask[];
};
type ActivityEntry = {
  id: string;
  nickname: string;
  action: string;
  taskType: string;
  durationMs: number;
  totalDurationMs: number;
  startedAt: number;
  comfyStartedAt: number;
  completedAt: number;
  timestamp: number;
  metadata: ActivityMetadata;
};
type UserProfile = { avatar?: SharedFile; updatedAt: number };
type SharedState = {
  messageHistory: ChatMessage[];
  todoColumns: TodoColumn[];
  activityHistory: ActivityEntry[];
  profiles: Record<string, UserProfile>;
  pictureSeriesLastNumber: number;
};

const hubDir = typeof __dirname === "string" ? __dirname : dirname(fileURLToPath(import.meta.url));
const dataDir = join(hubDir, "data");
const sharedStatePath = join(dataDir, "shared-data.json");
// The active Hub stores original files in download/HubFiles. Every connected app also caches them there.
const sharedFilesDir = process.env.CFB_HUB_FILES_DIR || join(dataDir, "HubFiles");

function ensureDirectories() {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  if (!existsSync(sharedFilesDir)) mkdirSync(sharedFilesDir, { recursive: true });
}

function loadSharedState(): SharedState {
  try {
    ensureDirectories();
    if (!existsSync(sharedStatePath)) return { messageHistory: [], todoColumns: [], activityHistory: [], profiles: {}, pictureSeriesLastNumber: PICTURE_SERIES_INITIAL_NUMBER };
    const raw = JSON.parse(readFileSync(sharedStatePath, "utf8")) as Partial<SharedState>;
    const storedPictureSeriesNumber = Math.floor(Number(raw.pictureSeriesLastNumber));
    const pictureSeriesLastNumber = Number.isSafeInteger(storedPictureSeriesNumber) && storedPictureSeriesNumber >= PICTURE_SERIES_INITIAL_NUMBER
      ? storedPictureSeriesNumber
      : PICTURE_SERIES_INITIAL_NUMBER;
    return {
      messageHistory: Array.isArray(raw.messageHistory) ? raw.messageHistory : [],
      todoColumns: Array.isArray(raw.todoColumns) ? raw.todoColumns : [],
      activityHistory: Array.isArray(raw.activityHistory) ? raw.activityHistory : [],
      profiles: raw.profiles && typeof raw.profiles === "object" && !Array.isArray(raw.profiles) ? raw.profiles : {},
      pictureSeriesLastNumber
    };
  } catch (error) {
    console.warn("Could not read shared data; starting with an empty state.", error);
    return { messageHistory: [], todoColumns: [], activityHistory: [], profiles: {}, pictureSeriesLastNumber: PICTURE_SERIES_INITIAL_NUMBER };
  }
}

const sharedState = loadSharedState();

function saveSharedState() {
  try {
    ensureDirectories();
    const temporaryPath = sharedStatePath + ".tmp";
    writeFileSync(temporaryPath, JSON.stringify(sharedState, null, 2), "utf8");
    renameSync(temporaryPath, sharedStatePath);
  } catch (error) {
    console.error("Could not save shared data.", error);
  }
}

function makeId(prefix: string) {
  return prefix + "_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);
}

function isHubAdministrator(user: { nickname: string } | undefined) {
  return String(user?.nickname || "").trim().toLocaleLowerCase("en-US") === HUB_ADMIN_NICKNAME;
}

function cleanText(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function cleanPriority(value: unknown): TodoPriority {
  return value === "low" || value === "high" || value === "urgent" ? value : "normal";
}

function cleanDuration(value: unknown) {
  return Math.min(Math.max(Number(value) || 0, 0), 24 * 60 * 60 * 1000);
}

function cleanTimestamp(value: unknown, fallback: number) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : fallback;
}

function cleanActivityMetadata(value: unknown): ActivityMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const metadata: ActivityMetadata = {};
  Object.entries(value as Record<string, unknown>).slice(0, 30).forEach(([key, item]) => {
    const cleanKey = cleanText(key, 60);
    if (!cleanKey) return;
    if (typeof item === "string") metadata[cleanKey] = item.slice(0, 2000);
    else if (typeof item === "number" && Number.isFinite(item)) metadata[cleanKey] = item;
    else if (typeof item === "boolean") metadata[cleanKey] = item;
  });
  return metadata;
}

function sanitizeFileName(value: unknown, fallback: string) {
  const clean = cleanText(value, 120).replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return clean || fallback;
}

function extensionForMime(mime: string) {
  if (mime === "image/jpeg") return ".jpg";
  if (mime === "image/webp") return ".webp";
  if (mime === "image/gif") return ".gif";
  return ".png";
}

function normalizeImageUpload(value: unknown, prefix: string): SharedFile | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const dataUrl = typeof raw.dataUrl === "string" ? raw.dataUrl : "";
  const match = dataUrl.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/i);
  if (!match) return null;
  const mime = match[1].toLowerCase();
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length || buffer.length > MAX_SHARED_IMAGE_BYTES) return null;
  const id = makeId(prefix) + extensionForMime(mime);
  try {
    ensureDirectories();
    writeFileSync(join(sharedFilesDir, id), buffer);
    return { id, name: sanitizeFileName(raw.name, "image" + extensionForMime(mime)), mime, size: buffer.length };
  } catch (error) {
    console.warn("Could not save shared image.", error);
    return null;
  }
}

function normalizeImageUploads(value: unknown, prefix: string, maximum = 4) {
  if (!Array.isArray(value)) return [] as SharedFile[];
  const files: SharedFile[] = [];
  value.slice(0, maximum).forEach(item => {
    const file = normalizeImageUpload(item, prefix);
    if (file) files.push(file);
  });
  return files;
}

function cleanTodoLink(value: unknown): TodoChatLink | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const ownerNickname = cleanText(raw.ownerNickname, 20);
  const taskId = cleanText(raw.taskId, 120);
  if (!ownerNickname || !taskId) return undefined;
  return { ownerNickname, taskId, view: raw.view === "completed" ? "completed" : "active" };
}

function cleanActivityLink(value: unknown): ActivityChatLink | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const activityId = cleanText((value as Record<string, unknown>).activityId, 120);
  return activityId ? { activityId } : undefined;
}

function cleanChatReply(value: unknown): ChatReplyReference | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const nickname = cleanText(raw.nickname, 20);
  const text = cleanText(raw.text, 280);
  if (!nickname || !text) return undefined;
  const timestamp = Number(raw.timestamp);
  return { messageId: cleanText(raw.messageId, 120), nickname, text, timestamp: Number.isFinite(timestamp) && timestamp > 0 ? Math.floor(timestamp) : 0 };
}

function cleanReactionEmoji(value: unknown) {
  const emoji = cleanText(value, 12);
  return REACTION_EMOJIS.includes(emoji) ? emoji : "";
}

function toggleReaction(reactions: unknown, emoji: string, nickname: string): MessageReaction[] {
  const list: MessageReaction[] = Array.isArray(reactions) ? reactions.map(item => {
    const raw = item && typeof item === "object" ? item as Record<string, unknown> : {};
    return { emoji: cleanReactionEmoji(raw.emoji), users: Array.isArray(raw.users) ? raw.users.map(user => cleanText(user, 20)).filter(Boolean) : [] };
  }).filter(item => item.emoji && item.users.length) : [];
  let reaction = list.find(item => item.emoji === emoji);
  if (!reaction) { reaction = { emoji, users: [] }; list.push(reaction); }
  if (reaction.users.includes(nickname)) reaction.users = reaction.users.filter(user => user !== nickname);
  else reaction.users.push(nickname);
  return list.filter(item => item.users.length);
}

function mimeForStaticFile(fileName: string) {
  const ext = extname(fileName).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/png";
}

const httpServer = createServer((request, response) => {
  const requestUrl = new URL(request.url || "/", "http://" + (request.headers.host || "localhost"));
  if (request.method !== "GET" || !requestUrl.pathname.startsWith("/hub-files/")) {
    response.writeHead(404, { "Access-Control-Allow-Origin": "*" });
    response.end("Not found");
    return;
  }
  const fileId = basename(decodeURIComponent(requestUrl.pathname.slice("/hub-files/".length)));
  if (!/^[A-Za-z0-9_.-]+$/.test(fileId)) {
    response.writeHead(400, { "Access-Control-Allow-Origin": "*" });
    response.end("Bad file name");
    return;
  }
  const filePath = join(sharedFilesDir, fileId);
  if (!existsSync(filePath)) {
    response.writeHead(404, { "Access-Control-Allow-Origin": "*" });
    response.end("Not found");
    return;
  }
  try {
    response.writeHead(200, {
      "Content-Type": mimeForStaticFile(fileId),
      "Content-Length": statSync(filePath).size,
      "Cache-Control": "public, max-age=31536000, immutable",
      "Access-Control-Allow-Origin": "*"
    });
    createReadStream(filePath).pipe(response);
  } catch (error) {
    response.writeHead(500, { "Access-Control-Allow-Origin": "*" });
    response.end("Unable to read file");
  }
});

const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  maxHttpBufferSize: MAX_UPSCALE_IMAGE_BYTES
});

// A single application opens two sockets, so counts use unique nicknames.
const users = new Map<string, { nickname: string; connectedAt: number; clientAddress: string }>();
topazQueue.attach(io, users, sharedFilesDir);
let currentTask: { nickname: string; taskType: string; startedAt: number } | null = null;
const messageHistory = sharedState.messageHistory;
let migratedMessageHistory = false;
messageHistory.forEach(message => {
  if (message && !message.id) {
    message.id = makeId("message");
    migratedMessageHistory = true;
  }
});
if (migratedMessageHistory) saveSharedState();
const todoColumns = sharedState.todoColumns;
const activityHistory = sharedState.activityHistory;
const profiles = sharedState.profiles;
let serviceIPs: { comfyIP: string; mockupIP: string } | null = null;

function uniqueUserCount(): number {
  return new Set(Array.from(users.values(), user => user.nickname)).size;
}

function normalizeNickname(nickname: string) {
  return String(nickname || "").trim().toLocaleLowerCase("ru-RU");
}

function socketClientAddress(socket: any) {
  return String(socket?.handshake?.address || socket?.conn?.remoteAddress || "");
}

function nicknameIsTakenByAnotherClient(nickname: string, socket: any) {
  const normalizedNickname = normalizeNickname(nickname);
  if (normalizedNickname === normalizeNickname("ComfyFloatBar")) return true;
  const clientAddress = socketClientAddress(socket);
  return Array.from(users.entries()).some(([socketId, user]) => socketId !== socket.id && normalizeNickname(user.nickname) === normalizedNickname && user.clientAddress !== clientAddress);
}

function uniqueUserList(): { nickname: string; connectedAt: number; avatar?: SharedFile }[] {
  const seen = new Map<string, { nickname: string; connectedAt: number; avatar?: SharedFile }>();
  users.forEach(user => {
    if (!seen.has(user.nickname)) {
      const profile = profiles[user.nickname];
      seen.set(user.nickname, { nickname: user.nickname, connectedAt: user.connectedAt, avatar: profile?.avatar });
    }
  });
  return Array.from(seen.values());
}

function broadcastUsersUpdate() {
  io.emit("users:update", { count: uniqueUserCount(), list: uniqueUserList() });
}

function broadcastProfiles() {
  io.emit("profiles:state", profiles);
}

function broadcastTodoState() {
  io.emit("todo:state", todoColumns);
}

function emitTodoChatMessage(text: string, todoLink: TodoChatLink) {
  const message: ChatMessage = { id: makeId("message"), nickname: "ComfyFloatBar", text, timestamp: Date.now(), todoLink };
  messageHistory.push(message);
  if (messageHistory.length > MAX_HISTORY) messageHistory.shift();
  io.emit("chat:message", message);
}

function connectedSocketIdsForNickname(nickname: string) {
  const ids: string[] = [];
  users.forEach((user, socketId) => {
    if (user.nickname === nickname) ids.push(socketId);
  });
  return ids;
}

function getOrCreateUpscaleColumn(ownerNickname: string, createdBy: string) {
  let column = todoColumns.find(item => item.ownerNickname === ownerNickname && item.title === UPSCALE_COLUMN_TITLE);
  if (!column) {
    column = { id: makeId("column"), ownerNickname, title: UPSCALE_COLUMN_TITLE, createdBy, createdAt: Date.now(), tasks: [] };
    todoColumns.push(column);
  }
  return column;
}

function findTask(taskId: unknown) {
  const column = todoColumns.find(item => item.tasks.some(task => task.id === taskId));
  const task = column?.tasks.find(item => item.id === taskId);
  return { column, task };
}

function requireTodoOwner(socket: any, taskId: unknown) {
  const user = users.get(socket.id);
  const found = findTask(taskId);
  if (!user || !found.column || !found.task) return null;
  if (found.column.ownerNickname !== user.nickname) {
    socket.emit("todo:error", "Это действие доступно только владельцу списка.");
    return null;
  }
  return { user, column: found.column, task: found.task };
}

httpServer.listen(PORT, () => console.log("ComfyFloatBar Hub running on port " + PORT));

io.on("connection", (socket) => {
  socket.emit("hub:capabilities", { protocolVersion: HUB_PROTOCOL_VERSION, pictureSeriesCounter: true, topazQueue: true });
  socket.emit("users:update", { count: uniqueUserCount(), list: uniqueUserList() });
  socket.emit("profiles:state", profiles);
  if (currentTask) socket.emit("task:status", currentTask);
  if (messageHistory.length > 0) socket.emit("chat:history", messageHistory);
  socket.emit("todo:state", todoColumns);
  socket.emit("activity:history", activityHistory);
  socket.emit("picture-series:state", { lastNumber: sharedState.pictureSeriesLastNumber });
  if (serviceIPs) socket.emit("hub:service-ips", serviceIPs);

  socket.on("user:join", (nickname: string) => {
    const cleanNickname = cleanText(nickname, 20);
    if (!cleanNickname) return;
    if (nicknameIsTakenByAnotherClient(cleanNickname, socket)) {
      socket.emit("user:error", "Этот никнейм уже занят другим участником.");
      return;
    }
    const clientAddress = socketClientAddress(socket);
    users.forEach((user, socketId) => {
      if (socketId !== socket.id && user.clientAddress === clientAddress) user.nickname = cleanNickname;
    });
    users.set(socket.id, { nickname: cleanNickname, connectedAt: Date.now(), clientAddress });
    console.log("+ " + cleanNickname + " (unique=" + uniqueUserCount() + ", sockets=" + users.size + ")");
    broadcastUsersUpdate();
  });

  socket.on("picture-series:reserve", (data: { minimumLastNumber?: number }, respond?: (result: { ok: boolean; number?: number; error?: string }) => void) => {
    const user = users.get(socket.id);
    if (!user) {
      if (respond) respond({ ok: false, error: "Сначала подключитесь к Hub." });
      return;
    }

    const requestedMinimum = Math.floor(Number(data?.minimumLastNumber));
    const minimumLastNumber = Number.isSafeInteger(requestedMinimum) && requestedMinimum >= PICTURE_SERIES_INITIAL_NUMBER && requestedMinimum <= 999999
      ? requestedMinimum
      : PICTURE_SERIES_INITIAL_NUMBER;
    const currentNumber = Math.max(PICTURE_SERIES_INITIAL_NUMBER, sharedState.pictureSeriesLastNumber, minimumLastNumber);
    if (!Number.isSafeInteger(currentNumber) || currentNumber >= 999999) {
      if (respond) respond({ ok: false, error: "Общий счётчик серий повреждён или достиг лимита." });
      return;
    }

    const number = currentNumber + 1;
    sharedState.pictureSeriesLastNumber = number;
    saveSharedState();
    const state = { lastNumber: number, reservedBy: user.nickname, timestamp: Date.now() };
    io.emit("picture-series:state", state);
    if (respond) respond({ ok: true, number });
    console.log("Picture series p" + number + " reserved by " + user.nickname);
  });

  socket.on("profile:update", (data: { avatar?: unknown }, respond?: (result: { ok: boolean; error?: string }) => void) => {
    const user = users.get(socket.id);
    if (!user) {
      if (respond) respond({ ok: false, error: "Сначала подключитесь к Hub." });
      return;
    }
    const avatar = normalizeImageUpload(data?.avatar, "avatar");
    if (!avatar) {
      if (respond) respond({ ok: false, error: "Выберите изображение PNG, JPG, WEBP или GIF размером до 8 МБ." });
      return;
    }
    profiles[user.nickname] = { avatar, updatedAt: Date.now() };
    saveSharedState();
    broadcastProfiles();
    broadcastUsersUpdate();
    if (respond) respond({ ok: true });
  });

  socket.on("service:register", (data: { comfyIP: string; mockupIP: string }) => {
    serviceIPs = { comfyIP: data.comfyIP, mockupIP: data.mockupIP };
    io.emit("hub:service-ips", serviceIPs);
  });

  socket.on("chat:message", (data: { text?: string; todoLink?: unknown; activityLink?: unknown; replyTo?: unknown; attachments?: unknown }) => {
    const user = users.get(socket.id);
    const text = cleanText(data?.text, 2000);
    const attachments = normalizeImageUploads(data?.attachments, "chat", 4);
    if (!user || (!text && !attachments.length)) return;
    const message: ChatMessage = {
      id: makeId("message"),
      nickname: user.nickname,
      text,
      timestamp: Date.now(),
      todoLink: cleanTodoLink(data?.todoLink),
      activityLink: cleanActivityLink(data?.activityLink),
      replyTo: cleanChatReply(data?.replyTo),
      attachments
    };
    if (!message.todoLink) delete message.todoLink;
    if (!message.activityLink) delete message.activityLink;
    if (!message.replyTo) delete message.replyTo;
    if (!message.attachments?.length) delete message.attachments;
    messageHistory.push(message);
    if (messageHistory.length > MAX_HISTORY) messageHistory.shift();
    saveSharedState();
    io.emit("chat:message", message);
  });

  socket.on("todo:column:create", (data: { ownerNickname: string; title: string }, respond?: (result: { ok: boolean; error?: string }) => void) => {
    const user = users.get(socket.id);
    const ownerNickname = cleanText(data?.ownerNickname, 20);
    const title = cleanText(data?.title, 80);
    let error = "";
    if (!user) error = "Подключение к Hub ещё не завершено. Подождите секунду и повторите.";
    else if (!ownerNickname) error = "Выберите профиль, для которого создаётся колонка.";
    else if (!title) error = "Введите название колонки.";
    if (error) {
      socket.emit("todo:error", error);
      if (respond) respond({ ok: false, error });
      return;
    }
    todoColumns.push({ id: makeId("column"), ownerNickname, title, createdBy: user.nickname, createdAt: Date.now(), tasks: [] });
    saveSharedState();
    broadcastTodoState();
    if (respond) respond({ ok: true });
  });

  socket.on("todo:column:delete", (data: { columnId: string }) => {
    const user = users.get(socket.id);
    const columnIndex = todoColumns.findIndex(column => column.id === data?.columnId);
    const column = columnIndex >= 0 ? todoColumns[columnIndex] : null;
    if (!user || !column) return;
    if (column.ownerNickname !== user.nickname) {
      socket.emit("todo:error", "Удалить колонку может только владелец списка.");
      return;
    }
    todoColumns.splice(columnIndex, 1);
    saveSharedState();
    broadcastTodoState();
  });

  socket.on("upscale:request", (data: { recipientNickname: string; description: string; links?: string; dueAt?: string; priority?: string; sourceName?: string; image?: unknown }, respond?: (result: { ok: boolean; error?: string; taskId?: string; fileName?: string }) => void) => {
    const user = users.get(socket.id);
    const recipientNickname = cleanText(data?.recipientNickname, 20);
    const description = cleanText(data?.description, 1200);
    const recipientSocketIds = connectedSocketIdsForNickname(recipientNickname);
    const image = Buffer.isBuffer(data?.image) ? data.image : data?.image instanceof Uint8Array ? Buffer.from(data.image) : null;
    let error = "";
    if (!user) error = "Подключение к Hub ещё не завершено. Повторите через секунду.";
    else if (!recipientNickname) error = "Выберите исполнителя.";
    else if (!description) error = "Введите название или описание задачи.";
    else if (!recipientSocketIds.length) error = "Исполнитель сейчас не подключён. Откройте приложение у получателя и повторите отправку.";
    if (error) {
      socket.emit("todo:error", error);
      if (respond) respond({ ok: false, error });
      return;
    }
    const column = getOrCreateUpscaleColumn(recipientNickname, user.nickname);
    const originalName = image ? sanitizeFileName(data?.sourceName, "upscale.png") : "";
    const extension = originalName.toLowerCase().endsWith(".png") ? "" : ".png";
    const fileName = image ? "upscale_" + Date.now().toString(36) + "_" + originalName.replace(/\.[^.]+$/, "") + extension : "";
    const task: TodoTask = {
      id: makeId("task"),
      description: "Апскейл: " + description,
      links: (image ? "Файл: " + fileName : "Без прикреплённого изображения") + (cleanText(data?.links, 2000) ? " · " + cleanText(data?.links, 2000) : ""),
      dueAt: cleanText(data?.dueAt, 40), priority: cleanPriority(data?.priority), status: "new", createdBy: user.nickname, createdAt: Date.now(), comments: []
    };
    column.tasks.push(task);
    if (recipientNickname !== user.nickname) {
      emitTodoChatMessage("📌 @" + recipientNickname + ", вам отправлена задача на апскейл: " + description.slice(0, 120), { ownerNickname: recipientNickname, taskId: task.id, view: "active" });
    }
    if (image) recipientSocketIds.forEach(socketId => io.to(socketId).emit("upscale:incoming", { recipientNickname, senderNickname: user.nickname, taskId: task.id, fileName, image }));
    saveSharedState();
    broadcastTodoState();
    if (respond) respond({ ok: true, taskId: task.id, fileName });
  });

  socket.on("todo:task:create", (data: { columnId: string; description: string; links: string; dueAt: string; priority: string; attachments?: unknown }) => {
    const user = users.get(socket.id);
    const column = todoColumns.find(item => item.id === data?.columnId);
    const description = cleanText(data?.description, 1200);
    if (!user || !column || !description) return;
    const task: TodoTask = {
      id: makeId("task"), description, links: cleanText(data?.links, 2000), dueAt: cleanText(data?.dueAt, 40), priority: cleanPriority(data?.priority), status: "new", createdBy: user.nickname, createdAt: Date.now(), comments: [], attachments: normalizeImageUploads(data?.attachments, "todo", 4)
    };
    if (!task.attachments?.length) delete task.attachments;
    column.tasks.push(task);
    if (column.ownerNickname !== user.nickname) {
      emitTodoChatMessage("📌 @" + column.ownerNickname + ", вам назначена задача: " + task.description.slice(0, 120), { ownerNickname: column.ownerNickname, taskId: task.id, view: "active" });
    }
    saveSharedState();
    broadcastTodoState();
  });

  socket.on("todo:task:update-status", (data: { taskId: string; status: TodoStatus; completionNote?: string; completionAttachments?: unknown }) => {
    const owned = requireTodoOwner(socket, data?.taskId);
    if (!owned || !TODO_STATUSES.includes(data?.status)) return;
    const becameCompleted = data.status === "completed" && owned.task.status !== "completed";
    if (data.status === "completed") {
      const completionNote = cleanText(data?.completionNote, 2000);
      const completionAttachments = normalizeImageUploads(data?.completionAttachments, "result", 4);
      if (!completionNote && !completionAttachments.length) {
        socket.emit("todo:error", "Для готовой задачи добавьте результат, ссылку, комментарий или изображение для проверки.");
        return;
      }
      owned.task.completionNote = completionNote;
      if (completionAttachments.length) owned.task.completionAttachments = completionAttachments;
      else delete owned.task.completionAttachments;
      owned.task.completedBy = owned.user.nickname;
      owned.task.completedAt = Date.now();
    } else {
      delete owned.task.completionNote;
      delete owned.task.completionAttachments;
      delete owned.task.completedBy;
      delete owned.task.completedAt;
    }
    owned.task.status = data.status;
    if (becameCompleted) emitTodoChatMessage("✅ @" + owned.task.createdBy + ", задача готова: " + owned.task.description.slice(0, 120), { ownerNickname: owned.column.ownerNickname, taskId: owned.task.id, view: "completed" });
    saveSharedState();
    broadcastTodoState();
  });

  socket.on("todo:task:delete", (data: { taskId: string }) => {
    const owned = requireTodoOwner(socket, data?.taskId);
    if (!owned) return;
    const taskIndex = owned.column.tasks.findIndex(task => task.id === owned.task.id);
    if (taskIndex < 0) return;
    owned.column.tasks.splice(taskIndex, 1);
    saveSharedState();
    broadcastTodoState();
  });

  socket.on("todo:task:add-comment", (data: { taskId: string; text?: string; attachments?: unknown }) => {
    const user = users.get(socket.id);
    const found = findTask(data?.taskId);
    const text = cleanText(data?.text, 1000);
    const attachments = normalizeImageUploads(data?.attachments, "comment", 4);
    if (!user || !found.task || found.task.status !== "completed" || (!text && !attachments.length)) return;
    if (!Array.isArray(found.task.comments)) found.task.comments = [];
    const comment: TodoComment = { id: makeId("comment"), nickname: user.nickname, text, createdAt: Date.now(), attachments };
    if (!comment.attachments?.length) delete comment.attachments;
    found.task.comments.push(comment);
    saveSharedState();
    broadcastTodoState();
  });

  socket.on("chat:message:edit", (data: { messageId?: unknown; text?: unknown }) => {
    const user = users.get(socket.id);
    const messageId = cleanText(data?.messageId, 120);
    const message = messageHistory.find(item => item.id === messageId);
    const text = cleanText(data?.text, 2000);
    if (!user || !message || message.nickname !== user.nickname || (!text && !message.attachments?.length)) return;
    message.text = text;
    message.editedAt = Date.now();
    saveSharedState();
    io.emit("chat:message:update", { messageId, message });
  });

  socket.on("chat:message:delete", (data: { messageId?: unknown }) => {
    const user = users.get(socket.id);
    const messageId = cleanText(data?.messageId, 120);
    const index = messageHistory.findIndex(item => item.id === messageId);
    const message = index >= 0 ? messageHistory[index] : null;
    if (!user || !message || (message.nickname !== user.nickname && !isHubAdministrator(user))) return;
    messageHistory.splice(index, 1);
    saveSharedState();
    io.emit("chat:message:update", { messageId, deleted: true });
  });

  socket.on("chat:history:clear", () => {
    const user = users.get(socket.id);
    if (!isHubAdministrator(user)) return;
    messageHistory.splice(0, messageHistory.length);
    saveSharedState();
    io.emit("chat:history:clear");
  });

  socket.on("activity:history:clear", () => {
    const user = users.get(socket.id);
    if (!isHubAdministrator(user)) return;
    activityHistory.splice(0, activityHistory.length);
    saveSharedState();
    io.emit("activity:history", activityHistory);
  });

  socket.on("chat:reaction:toggle", (data: { messageId?: unknown; emoji?: unknown }) => {
    const user = users.get(socket.id);
    const messageId = cleanText(data?.messageId, 120);
    const emoji = cleanReactionEmoji(data?.emoji);
    const message = messageHistory.find(item => item.id === messageId);
    if (!user || !emoji || !message) return;
    message.reactions = toggleReaction(message.reactions, emoji, user.nickname);
    if (!message.reactions.length) delete message.reactions;
    saveSharedState();
    io.emit("chat:reactions:update", { messageId, reactions: message.reactions || [] });
  });

  socket.on("todo:task:reaction:toggle", (data: { taskId?: unknown; emoji?: unknown }) => {
    const user = users.get(socket.id);
    const taskId = cleanText(data?.taskId, 120);
    const emoji = cleanReactionEmoji(data?.emoji);
    const found = findTask(taskId);
    if (!user || !emoji || !found.task || found.task.status !== "completed") return;
    found.task.reactions = toggleReaction(found.task.reactions, emoji, user.nickname);
    if (!found.task.reactions.length) delete found.task.reactions;
    saveSharedState();
    broadcastTodoState();
  });

  socket.on("activity:add", (data: { action: string; taskType?: string; durationMs: number; totalDurationMs?: number; startedAt?: number; comfyStartedAt?: number; completedAt?: number; metadata?: Record<string, unknown> }) => {
    const user = users.get(socket.id);
    const action = cleanText(data?.action, 100);
    if (!user || !action) return;
    const now = Date.now();
    const startedAt = cleanTimestamp(data?.startedAt, now);
    const comfyStartedAt = cleanTimestamp(data?.comfyStartedAt, startedAt);
    const completedAt = cleanTimestamp(data?.completedAt, now);
    const entry: ActivityEntry = { id: makeId("activity"), nickname: user.nickname, action, taskType: cleanText(data?.taskType, 100), durationMs: cleanDuration(data?.durationMs), totalDurationMs: cleanDuration(data?.totalDurationMs), startedAt, comfyStartedAt, completedAt, timestamp: now, metadata: cleanActivityMetadata(data?.metadata) };
    activityHistory.unshift(entry);
    if (activityHistory.length > MAX_ACTIVITY_HISTORY) activityHistory.pop();
    saveSharedState();
    io.emit("activity:entry", entry);
  });

  socket.on("task:start", (data: { taskType: string }) => {
    const user = users.get(socket.id);
    if (!user) return;
    currentTask = { nickname: user.nickname, taskType: data.taskType, startedAt: Date.now() };
    io.emit("task:status", currentTask);
  });
  socket.on("task:complete", () => { if (users.get(socket.id)) { currentTask = null; io.emit("task:status", null); } });
  socket.on("task:cancel", () => { if (users.get(socket.id)) { currentTask = null; io.emit("task:status", null); } });

  socket.on("disconnect", () => {
    const user = users.get(socket.id);
    if (user) {
      const stillOnline = Array.from(users.entries()).some(([socketId, candidate]) => socketId !== socket.id && candidate.nickname === user.nickname);
      if (!stillOnline && currentTask?.nickname === user.nickname) {
        currentTask = null;
        io.emit("task:status", null);
      }
    }
    users.delete(socket.id);
    broadcastUsersUpdate();
  });
});
