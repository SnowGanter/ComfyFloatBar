import { Server } from "socket.io";

const PORT = 3003;

const io = new Server(PORT, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// Active users map: socketId -> { nickname, connectedAt }
const users = new Map<string, { nickname: string; connectedAt: number }>();

// Current task info: who is running what
let currentTask: { nickname: string; taskType: string; startedAt: number } | null = null;

console.log(`🟢 ComfyFloatBar Hub Service running on port ${PORT}`);

io.on("connection", (socket) => {
  console.log(`⚡ Client connected: ${socket.id}`);

  // Send current state to newly connected client
  socket.emit("users:update", { count: users.size, list: Array.from(users.values()) });
  if (currentTask) {
    socket.emit("task:status", currentTask);
  }

  // User joins with nickname
  socket.on("user:join", (nickname: string) => {
    users.set(socket.id, { nickname, connectedAt: Date.now() });
    console.log(`👤 ${nickname} joined`);
    // Broadcast updated user list
    io.emit("users:update", { count: users.size, list: Array.from(users.values()) });
  });

  // Chat message
  socket.on("chat:message", (data: { text: string }) => {
    const user = users.get(socket.id);
    if (!user) return; // Must join first
    const message = {
      nickname: user.nickname,
      text: data.text,
      timestamp: Date.now()
    };
    console.log(`💬 ${user.nickname}: ${data.text}`);
    // Relay to ALL clients (including sender for confirmation)
    io.emit("chat:message", message);
  });

  // Task started
  socket.on("task:start", (data: { taskType: string }) => {
    const user = users.get(socket.id);
    if (!user) return;
    currentTask = {
      nickname: user.nickname,
      taskType: data.taskType,
      startedAt: Date.now()
    };
    console.log(`⚙️ ${user.nickname} started task: ${data.taskType}`);
    io.emit("task:status", currentTask);
  });

  // Task completed
  socket.on("task:complete", () => {
    const user = users.get(socket.id);
    if (!user) return;
    console.log(`✅ ${user.nickname} task completed`);
    currentTask = null;
    io.emit("task:status", null);
  });

  // Task cancelled
  socket.on("task:cancel", () => {
    const user = users.get(socket.id);
    if (!user) return;
    console.log(`❌ ${user.nickname} task cancelled`);
    currentTask = null;
    io.emit("task:status", null);
  });

  // Disconnect
  socket.on("disconnect", () => {
    const user = users.get(socket.id);
    if (user) {
      console.log(`👋 ${user.nickname} disconnected`);
      // If this user had a running task, clear it
      if (currentTask && currentTask.nickname === user.nickname) {
        currentTask = null;
        io.emit("task:status", null);
      }
    }
    users.delete(socket.id);
    io.emit("users:update", { count: users.size, list: Array.from(users.values()) });
  });
});
