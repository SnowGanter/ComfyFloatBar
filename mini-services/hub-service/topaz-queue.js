'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { spawn } = require('child_process');
const MODELS = ['Standard v2', 'High fidelity v2', 'Low res v2', 'Text & shapes', 'Art & CG', 'Recover v2', 'Redefine'];
const TERMINAL = new Set(['done', 'failed', 'cancelled', 'interrupted']);
function settings(raw = {}) {
  const number = (key, fallback, min, max) => {
    const n = raw[key] === undefined ? fallback : Number(raw[key]);
    if (!Number.isFinite(n) || n < min || n > max) throw new Error('Неверное значение: ' + key);
    return n;
  };
  if (!MODELS.includes(raw.model)) throw new Error('Неизвестная модель Topaz');
  if (!['scale', 'width', 'height'].includes(raw.resizeMode)) throw new Error('Выберите способ изменения размера');
  if (!['px', 'in', 'cm'].includes(raw.unit)) throw new Error('Неизвестная единица размера');
  if (!['JPEG', 'PNG', 'TIFF'].includes(raw.format)) throw new Error('Неизвестный формат');
  if (!['sRGB IEC61966-2.1', 'Adobe RGB (1998)', 'ProPhoto RGB'].includes(raw.colorSpace)) throw new Error('Неизвестный профиль');
  return { model: raw.model, resizeMode: raw.resizeMode, unit: raw.unit, format: raw.format,
    colorSpace: raw.colorSpace, scale: number('scale', 4, 1, 6), dimension: number('dimension', 8000, 1, 32000),
    ppi: number('ppi', 100, 1, 1200), sharpen: number('sharpen', 33, 0, 100), denoise: number('denoise', 50, 0, 100),
    compression: number('compression', 1, 0, 100), detail: number('detail', 50, 0, 100),
    creativity: number('creativity', 2, 1, 6), texture: number('texture', 3, 1, 6),
    extraSharpen: number('extraSharpen', 0, 0, 6), extraDenoise: number('extraDenoise', 2, 0, 6),
    quality: number('quality', 100, 1, 100), face: raw.face === true, gamma: raw.gamma === true,
    description: String(raw.description || '').slice(0, 2000) };
}

// Runs on the Hub machine, never on the sender's workstation. Only one desktop job at a time.
class TopazQueue {
  constructor({ directory, adapter, onChange = () => {}, enabled = true }) {
    this.directory = directory; this.adapter = adapter; this.onChange = onChange; this.enabled = enabled;
    fs.mkdirSync(directory, { recursive: true });
    this.statePath = path.join(directory, 'queue.json'); this.active = null;
    const stored = fs.existsSync(this.statePath) ? JSON.parse(fs.readFileSync(this.statePath, 'utf8')) : [];
    this.jobs = Array.isArray(stored) ? stored : (Array.isArray(stored.jobs) ? stored.jobs : []);
    for (const job of this.jobs) if (!TERMINAL.has(job.state)) {
      job.state = 'interrupted'; job.message = 'Обработчик перезапущен. Автоматический повтор отключён, чтобы не отправить файл дважды.';
    }
    this.save();
  }
  snapshot(owner) { return this.jobs.filter(j => j.owner === owner).map(({ input, outputDir, resultPath, ...j }) => j); }
  save() { fs.writeFileSync(this.statePath + '.tmp', JSON.stringify({jobs:this.jobs}, null, 2)); fs.renameSync(this.statePath + '.tmp', this.statePath); }
  change(job, state, message) { job.state = state; job.message = message; job.updatedAt = Date.now(); this.save(); this.onChange(); }
  async hideDesktop(job) {
    if (job.desktopHidden === true) return;
    const result = await this.adapter('desktop-hide', job);
    job.hiddenWindowHandles = Array.isArray(result?.handles) ? result.handles : [];
    job.desktopHidden = true;
    this.save();
  }
  async restoreDesktop(job) {
    try { await this.adapter('desktop-restore', job); }
    catch (_) {}
    delete job.hiddenWindowHandles;
    delete job.desktopHidden;
    this.save();
  }
  upload(owner, raw, requestId) {
    if (!this.enabled) throw new Error('Topaz не настроен на этом Hub');
    if (!/^[a-f0-9-]{36}$/i.test(requestId || '')) throw new Error('Некорректный номер загрузки');
    const existing = this.jobs.find(j => j.owner === owner && j.requestId === requestId);
    if (existing) return existing.id;
    if (this.jobs.filter(j => !TERMINAL.has(j.state)).length >= 20) throw new Error('Очередь заполнена');
    const image = Buffer.from(raw.image || []);
    if (!image.length) throw new Error('Исходник пуст');
    let extension;
    if (image.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) extension = '.png';
    else if (image[0] === 255 && image[1] === 216 && image[2] === 255) extension = '.jpg';
    else if (image.subarray(0,4).toString() === 'RIFF' && image.subarray(8,12).toString() === 'WEBP') extension = '.webp';
    else if (['49492a00','4d4d002a'].includes(image.subarray(0,4).toString('hex'))) extension = '.tiff';
    else throw new Error('Поддерживаются PNG, JPEG, WebP и TIFF');
    const id = crypto.randomUUID(); const folder = path.join(this.directory, id);
    fs.mkdirSync(folder); const input = path.join(folder, 'CFB_' + id + extension);
    fs.writeFileSync(input, image);
    const job = { id, requestId, owner, sourceName: path.basename(String(raw.sourceName || 'Image')).slice(0,150), input,
      outputDir: path.join(folder, 'result'), state: 'queued', message: 'Ожидание обработчика', createdAt: Date.now() };
    if (raw.settings) job.settings = settings(raw.settings);
    this.jobs.push(job); this.save(); this.onChange(); this.pump(); return id;
  }
  owned(owner, id) { const job = this.jobs.find(j => j.id === id && j.owner === owner); if (!job) throw new Error('Задача не найдена'); return job; }
  async pump() {
    if (this.active || !this.enabled) return;
    const job = this.jobs.find(j => j.state === 'queued'); if (!job) return;
    this.active = job;
    try {
      this.change(job, 'preparing', 'Освобождение памяти и загрузка в Topaz');
      await this.hideDesktop(job);
      const result = await this.adapter('prepare', job, msg => { job.message = msg; this.save(); this.onChange(); });
      job.width = result.width; job.height = result.height;
      if (job.settings) this.begin(job);
      else {
        await this.restoreDesktop(job);
        this.change(job, 'ready', 'Изображение открыто в Topaz. Выберите настройки.');
      }
    } catch (error) {
      // No export or Telegram send has started yet, so this failure is safe.
      // Do not block every subsequent job after an OCR/open-file miss.
      await this.restoreDesktop(job);
      job.failurePhase = 'prepare';
      this.change(job, 'failed', error.message);
      this.active = null;
      this.pump();
    }
  }
  start(owner, id, raw) {
    const job = this.owned(owner, id); if (job !== this.active || job.state !== 'ready') throw new Error('Topaz ещё не готов');
    job.settings = settings(raw);
    this.begin(job); return true;
  }
  begin(job) {
    const s = job.settings;
    const dimensionPx = s.dimension * (s.unit === 'cm' ? s.ppi / 2.54 : s.unit === 'in' ? s.ppi : 1);
    const factor = s.resizeMode === 'scale' ? s.scale : dimensionPx / (s.resizeMode === 'width' ? job.width : job.height);
    if (factor < 1 || Math.max(job.width, job.height) * factor > 32000) throw new Error('Размер должен быть не меньше исходника и не больше 32000 px');
    this.change(job, 'processing', 'Topaz: обработка изображения');
    this.run(job);
  }
  async run(job) {
    try {
      await this.hideDesktop(job);
      const result = await this.adapter('process', job, msg => { job.message = msg; this.save(); this.onChange(); });
      job.resultName = result.fileName;
      job.resultPath = result.path;
      try { if (fs.existsSync(job.input)) fs.unlinkSync(job.input); } catch (_) {}
      this.change(job, 'sending', 'Отправка файла в Избранное Telegram');
      await this.adapter('telegram', { ...job, resultPath: result.path });
      this.change(job, 'done', 'Файл отправлен в Избранное Telegram');
      this.cleanup(job);
    } catch (error) { this.change(job, 'failed', error.message); }
    finally { await this.restoreDesktop(job); this.active = null; this.pump(); }
  }
  cleanup(job) {
    const folder = path.dirname(job.input);
    if (path.dirname(folder) !== this.directory || path.basename(folder) !== job.id) return;
    try { fs.rmSync(folder, { recursive:true, force:true }); } catch (_) {}
  }
  cancel(owner, id) {
    const job = this.owned(owner, id);
    if (!['queued','ready'].includes(job.state)) throw new Error('Во время обработки остановите Topaz на ПК-сервере; повторная отправка не будет запущена автоматически.');
    this.change(job, 'cancelled', 'Задача отменена'); if (this.active === job) this.active = null; this.pump();
  }
}

function pythonAdapter(config, scriptPath) {
  return (command, job, progress = () => {}) => new Promise((resolve, reject) => {
    const child = spawn(config.python || 'python', [scriptPath, command], { windowsHide: true, stdio: ['pipe','pipe','pipe'] });
    let pending = '', errorText = '', result;
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Превышено время ожидания. Проверьте Topaz на сервере; результат мог сохраниться.')); }, (command === 'process' ? 24 * 60 * 60 : 20 * 60) * 1000);
    child.stdout.on('data', data => {
      pending += data.toString(); let line;
      while (pending.includes('\n')) { const index = pending.indexOf('\n'); line = pending.slice(0, index); pending = pending.slice(index + 1);
        try { const msg = JSON.parse(line); if (msg.progress) progress(msg.progress); if (msg.result) result = msg.result; if (msg.error) errorText = msg.error; } catch (_) {}
      }
    });
    child.stderr.on('data', data => { errorText = (errorText + data).slice(-3000); });
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('close', code => { clearTimeout(timeout); code === 0 && result ? resolve(result) : reject(new Error(errorText || 'Обработчик Topaz завершился без результата')); });
    child.stdin.end(JSON.stringify({ config, job }));
  });
}

function attach(io, users, baseDir) {
  const configPath = process.env.CFB_TOPAZ_CONFIG || path.join(baseDir, 'topaz-config.json');
  const defaults = {
    enabled: process.platform === 'win32',
    python: 'C:/Python314/python.exe',
    comfyUrl: 'http://127.0.0.1:8188',
    topazExe: 'C:/Program Files/Topaz Labs LLC/Topaz Gigapixel AI/Topaz Gigapixel AI.exe',
    telegramExe: path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Telegram Desktop', 'Telegram.exe'),
    telegramTitle: 'Избранное', telegramAccount: 'Ilya', closeCS2: true
  };
  const config = fs.existsSync(configPath) ? { ...defaults, ...JSON.parse(fs.readFileSync(configPath, 'utf8')) } : defaults;
  config.enabled = config.enabled === true && [config.python, config.topazExe, config.telegramExe].every(file => fs.existsSync(file));
  let queue;
  const emit = () => { for (const [id, user] of users) io.to(id).emit('topaz:state', { enabled: queue.enabled, jobs: queue.snapshot(user.nickname) }); };
  queue = new TopazQueue({ directory: path.join(baseDir, 'TopazQueue'), enabled: config.enabled === true,
    adapter: pythonAdapter(config, path.join(__dirname, 'topaz-worker.py')), onChange: emit });
  io.on('connection', socket => {
    const handle = (event, fn) => socket.on(event, (data, ack) => {
      try { const user = users.get(socket.id); if (!user) throw new Error('Сначала задайте имя пользователя в чате');
        const result = fn(user.nickname, data || {}); if (typeof ack === 'function') ack({ ok: true, result }); emit();
      } catch (error) { if (typeof ack === 'function') ack({ ok: false, error: error.message }); }
    });
    handle('topaz:list', owner => ({ enabled: queue.enabled, jobs: queue.snapshot(owner) }));
    handle('topaz:upload', (owner, data) => ({ id: queue.upload(owner, data, data.requestId) }));
    handle('topaz:start', (owner, data) => queue.start(owner, data.id, data.settings));
    handle('topaz:cancel', (owner, data) => queue.cancel(owner, data.id));
    handle('topaz:busy', () => ({ busy: Boolean(queue.active) }));
  });
  return queue;
}
module.exports = { TopazQueue, settings, pythonAdapter, attach, MODELS };
