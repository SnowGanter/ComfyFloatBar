const fs = require('fs');

let isPollingAborted = false;

function abortPolling() {
    isPollingAborted = true;
}

async function uploadImage(ip, filePath) {
    const imageBuffer = fs.readFileSync(filePath);
    const blob = new Blob([imageBuffer], { type: 'image/png' });
    const formData = new FormData();
    formData.append("image", blob, "ps_export_temp.png");

    const res = await fetch(`http://${ip}/upload/image`, { method: "POST", body: formData });
    if (!res.ok) throw new Error(`ComfyUI загрузка: статус ${res.status}`);
    const data = await res.json();
    return data.name;
}

async function sendPrompt(ip, workflow) {
    workflow = await prepareModelSelections(ip, workflow);
    if (Object.values(workflow).some(node => ['TextEncodeQwenImage21', 'ColorMatch'].includes(node.class_type))) {
        workflow = await prepareWorkflow(ip, workflow);
    }
    const res = await fetch(`http://${ip}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: workflow })
    });
    const data = await res.json();
    const hasNodeErrors = data.node_errors && Object.keys(data.node_errors).length > 0;
    if (!res.ok || data.error || !data.prompt_id || hasNodeErrors) {
        const message = data && data.error && (data.error.message || data.error.type)
            ? (data.error.message || data.error.type)
            : 'статус ' + res.status;
        const nodeErrors = Object.entries(data.node_errors || {}).map(([id, value]) => {
            const details = (value.errors || []).map(error => error.message || error.details || error.type).filter(Boolean).join('; ');
            return id + ': ' + details;
        }).join(' | ');
        if (data.prompt_id) {
            try { await fetch(`http://${ip}/queue`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ delete:[data.prompt_id] }) }); } catch (_) {}
        }
        throw new Error('Ошибка графа ComfyUI: ' + message + (nodeErrors ? ' — ' + nodeErrors : ''));
    }
    return data.prompt_id;
}

async function prepareModelSelections(ip, source) {
    const workflow = JSON.parse(JSON.stringify(source));
    const keys = ['unet_name', 'clip_name', 'vae_name', 'lora_name', 'name'];
    const selections = [];
    for (const node of Object.values(workflow)) {
        for (const key of keys) {
            const value = node.inputs?.[key];
            if (typeof value !== 'string') continue;
            if (key === 'name' && node.class_type !== 'ModelPatchLoader') continue;
            if (key === 'lora_name' && node._meta?.cfbEnabled === false) continue;
            selections.push({ node, key, value });
        }
    }
    if (!selections.length) return workflow;
    const types = [...new Set(selections.map(item => item.node.class_type))];
    const descriptions = await Promise.all(types.map(async type => {
        const response = await fetch(`http://${ip}/object_info/${encodeURIComponent(type)}`, { signal:AbortSignal.timeout(30000) });
        if (!response.ok) throw new Error('Не удалось получить список моделей ComfyUI для ' + type + '.');
        return response.json();
    }));
    const info = Object.assign({}, ...descriptions);
    const basename = name => String(name).split(/[\\/]/).pop().toLowerCase();
    for (const { node, key, value } of selections) {
        const allowed = info[node.class_type]?.input?.required?.[key]?.[0];
        if (!Array.isArray(allowed)) continue;
        if (allowed.includes(value)) {
            node.inputs[key] = value;
            continue;
        }
        const requested = [value, ...(Array.isArray(node._meta?.cfbAliases) ? node._meta.cfbAliases : [])];
        const matches = allowed.filter(name => requested.some(candidate => basename(name) === basename(candidate)));
        if (matches.length === 1) node.inputs[key] = matches[0];
        else if (!matches.length) {
            const kind = key === 'lora_name' ? 'LoRA' : key === 'unet_name' ? 'модель' : key === 'name' ? 'ControlNet patch' : 'файл модели';
            throw new Error(`ComfyUI на ПК-обработчике не видит ${kind} «${value}». Скопируйте файл на сервер и обновите список моделей ComfyUI.`);
        } else throw new Error(`ComfyUI нашёл несколько файлов «${value}». Оставьте один экземпляр или укажите точную подпапку.`);
    }
    return workflow;
}

async function prepareWorkflow(ip, source) {
    // Query only this graph's nodes. Some unrelated custom nodes make /object_info very slow.
    const types = [...new Set(Object.values(source).map(node => node.class_type))];
    if (types.includes('ColorMatch')) types.push('ColorMatchV2');
    // The merged Qwen 2.1 implementation uses the shared Apply Fun ControlNet.
    // Support the earlier experimental node too, without modifying ComfyUI core.
    if (types.includes('ZImageFunControlnet')) types.push('QwenImage21FunControlNetApply');
    if (types.includes('QwenImage21FunControlNetApply')) types.push('ZImageFunControlnet');
    const descriptions = await Promise.all(types.map(async type => {
        const response = await fetch(`http://${ip}/object_info/${encodeURIComponent(type)}`, { signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error('Не удалось проверить узел ' + type + ' на сервере ComfyUI.');
        return response.json();
    }));
    const info = Object.assign({}, ...descriptions);
    const workflow = JSON.parse(JSON.stringify(source));
    for (const node of Object.values(workflow)) {
        if (node.class_type === 'ColorMatch' && info.ColorMatchV2) node.class_type = 'ColorMatchV2';
        if (node.class_type === 'QwenImage21FunControlNetApply' && !info.QwenImage21FunControlNetApply && info.ZImageFunControlnet) {
            node.class_type = 'ZImageFunControlnet';
            if (node.inputs.control_image) node.inputs.image = node.inputs.control_image;
            delete node.inputs.control_image;
        } else if (node.class_type === 'ZImageFunControlnet' && info.QwenImage21FunControlNetApply) {
            node.class_type = 'QwenImage21FunControlNetApply';
            if (node.inputs.image) node.inputs.control_image = node.inputs.image;
            delete node.inputs.image;
        }
    }
    const missing = [...new Set(Object.values(workflow).map(node => node.class_type))].filter(type => !info[type]);
    if (missing.length) throw new Error('На сервере ComfyUI отсутствуют узлы: ' + missing.join(', ') + '. ' + (missing.includes('ColorMatch') ? 'Установите ComfyUI-KJNodes с зависимостью color-matcher или отключите сохранение цветов. ' : '') + 'Проверьте обновления ComfyUI и дополнений.');
    for (const node of Object.values(workflow)) {
        for (const key of ['unet_name', 'clip_name', 'vae_name', 'lora_name']) {
            const value = node.inputs[key];
            if (typeof value !== 'string' || (!value.toLowerCase().includes('qwen') && value !== 'elusarcas-qwen2-1-detailer-v1.safetensors')) continue;
            const allowed = info[node.class_type]?.input?.required?.[key]?.[0];
            if (!Array.isArray(allowed)) continue;
            if (allowed.includes(value)) continue;
            const basename = name => String(name).split(/[\\/]/).pop().toLowerCase();
            const matches = allowed.filter(name => basename(name) === basename(value));
            if (matches.length === 1) node.inputs[key] = matches[0];
            else if (!matches.length) throw new Error('ComfyUI не видит модель ' + value + '. Проверьте папку моделей и обновите список в ComfyUI.');
            else throw new Error('Найдено несколько файлов ' + value + '. Укажите точную подпапку в qwen_workflows.js.');
        }
    }
    return workflow;
}

async function freeMemory(ip) {
    const queueResponse = await fetch(`http://${ip}/queue`, { signal: AbortSignal.timeout(10000) });
    if (!queueResponse.ok) throw new Error('Не удалось проверить очередь ComfyUI.');
    const queue = await queueResponse.json();
    if (!Array.isArray(queue.queue_running) || !Array.isArray(queue.queue_pending)) throw new Error('ComfyUI вернул неизвестный формат очереди.');
    if (queue.queue_running.length || queue.queue_pending.length) throw new Error('ComfyUI занят: дождитесь завершения очереди перед выгрузкой моделей.');
    const response = await fetch(`http://${ip}/free`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ unload_models: true, free_memory: true }), signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) throw new Error('ComfyUI не принял запрос на выгрузку: ' + response.status);
    return true;
}

function checkExecutionError(entry) {
    if (!entry || entry.status?.status_str !== 'error') return;
    const detail = (entry.status.messages || []).find(message => message[0] === 'execution_error')?.[1];
    throw new Error(detail ? 'ComfyUI: ' + (detail.node_type || detail.node_id) + ' — ' + (detail.exception_message || 'ошибка выполнения') : 'ComfyUI завершил задачу с ошибкой.');
}

function findFirstOutputImage(outputs) {
    for (const output of Object.values(outputs || {})) {
        if (Array.isArray(output.images) && output.images.length > 0) {
            return output.images[0];
        }
    }
    return null;
}

function findOutputImages(outputs, preferredNodeIds = []) {
    const images = [];
    const seen = new Set();
    const appendImages = output => {
        if (!output || !Array.isArray(output.images)) return;
        output.images.forEach(image => {
            if (!image || !image.filename) return;
            const key = [image.type || '', image.subfolder || '', image.filename].join('|');
            if (seen.has(key)) return;
            seen.add(key);
            images.push(image);
        });
    };

    preferredNodeIds.forEach(nodeId => appendImages(outputs && outputs[nodeId]));
    Object.entries(outputs || {}).forEach(([nodeId, output]) => {
        if (!preferredNodeIds.includes(nodeId)) appendImages(output);
    });
    return images;
}
function findFirstOutputText(outputs) {
    for (const output of Object.values(outputs || {})) {
        if (!output) continue;
        for (const key of ['svg_text', 'text', 'strings']) {
            if (Array.isArray(output[key]) && output[key].length > 0) {
                return String(output[key][0]);
            }
        }
    }
    return null;
}

async function pollHistory(ip, promptId) {
    isPollingAborted = false;
    return new Promise((resolve, reject) => {
        const interval = setInterval(async () => {
            if (isPollingAborted) {
                clearInterval(interval);
                reject('Polling aborted');
                return;
            }
            try {
                const res = await fetch(`http://${ip}/history/${promptId}`);
                const data = await res.json();
                const historyEntry = data[promptId];
                checkExecutionError(historyEntry);
                const image = findFirstOutputImage(historyEntry && historyEntry.outputs);
                if (image) {
                    clearInterval(interval);
                    resolve(image);
                    return;
                }
                if (historyEntry && historyEntry.status && historyEntry.status.completed) {
                    clearInterval(interval);
                    reject(new Error('ComfyUI завершил обработку без итогового изображения.'));
                }
            } catch (e) {
                clearInterval(interval);
                reject(e instanceof Error ? e : new Error(String(e)));
            }
        }, 1000);
    });
}

async function pollHistoryImages(ip, promptId, expectedCount = 3, preferredNodeIds = []) {
    isPollingAborted = false;
    return new Promise((resolve, reject) => {
        const interval = setInterval(async () => {
            if (isPollingAborted) {
                clearInterval(interval);
                reject('Polling aborted');
                return;
            }
            try {
                const res = await fetch(`http://${ip}/history/${promptId}`);
                const data = await res.json();
                const historyEntry = data[promptId];
                if (!historyEntry) return;
                checkExecutionError(historyEntry);
                const outputs = preferredNodeIds.length
                    ? Object.fromEntries(preferredNodeIds.map(id => [id, historyEntry.outputs?.[id]]))
                    : historyEntry.outputs;
                const images = findOutputImages(outputs, preferredNodeIds);
                if (images.length >= expectedCount) {
                    clearInterval(interval);
                    resolve(images.slice(0, expectedCount));
                    return;
                }
                if (historyEntry.status && historyEntry.status.completed) {
                    clearInterval(interval);
                    reject(new Error(`ComfyUI вернул ${images.length} из ${expectedCount} изображений.`));
                }
            } catch (e) {
                clearInterval(interval);
                reject(e instanceof Error ? e : new Error(String(e)));
            }
        }, 1000);
    });
}
async function pollHistoryText(ip, promptId) {
    isPollingAborted = false;
    return new Promise((resolve, reject) => {
        const interval = setInterval(async () => {
            if (isPollingAborted) {
                clearInterval(interval);
                reject('Polling aborted');
                return;
            }
            try {
                const res = await fetch(`http://${ip}/history/${promptId}`);
                const data = await res.json();
                const historyEntry = data[promptId];
                checkExecutionError(historyEntry);
                const text = findFirstOutputText(historyEntry && historyEntry.outputs);
                if (text) {
                    clearInterval(interval);
                    resolve(text);
                    return;
                }
                if (historyEntry && historyEntry.status && historyEntry.status.completed) {
                    clearInterval(interval);
                    reject(new Error('ComfyUI завершил векторизацию, но не передал SVG в приложение.'));
                }
            } catch (e) {
                clearInterval(interval);
                reject(e instanceof Error ? e : new Error(String(e)));
            }
        }, 1000);
    });
}

async function downloadImage(ip, image) {
    const imageInfo = typeof image === 'string' ? { filename: image } : image;
    if (!imageInfo || !imageInfo.filename) throw new Error('ComfyUI не вернул имя файла результата');
    const query = new URLSearchParams({ filename: imageInfo.filename });
    if (imageInfo.subfolder) query.set('subfolder', imageInfo.subfolder);
    if (imageInfo.type) query.set('type', imageInfo.type);

    const res = await fetch(`http://${ip}/view?${query.toString()}`);
    if (!res.ok) throw new Error("Ошибка скачивания");
    return await res.arrayBuffer();
}

async function getMockupFolders(ip) {
    const res = await fetch(`http://${ip}/api/folders`);
    if (!res.ok) throw new Error("Сервер мокапов недоступен");
    return await res.json();
}

async function getMockupFiles(ip, folder) {
    const res = await fetch(`http://${ip}/api/files?folder=${encodeURIComponent(folder)}`);
    if (!res.ok) throw new Error("Папка недоступна");
    return await res.json();
}

async function downloadMockup(ip, folder, file) {
    const res = await fetch(`http://${ip}/download?folder=${encodeURIComponent(folder)}&file=${encodeURIComponent(file)}`);
    if (!res.ok) throw new Error("Ошибка скачивания PSD");
    return await res.arrayBuffer();
}

async function interruptComfy(ip) {
    const res = await fetch(`http://${ip}/interrupt`, { method: "POST" });
    if (!res.ok) throw new Error("Ошибка interrupt");
    return true;
}

function getMockupPreviewUrl(ip, folder, file) {
    return `http://${ip}/${encodeURIComponent(folder)}/${encodeURIComponent(file)}`;
}

module.exports = { uploadImage, sendPrompt, pollHistory, pollHistoryImages, pollHistoryText, downloadImage, getMockupFolders, getMockupFiles, downloadMockup, getMockupPreviewUrl, interruptComfy, abortPolling, freeMemory };
