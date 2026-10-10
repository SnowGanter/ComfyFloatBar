// Explicit opt-in integration test against a real, idle ComfyUI server.
const fs = require('fs');
const path = require('path');
const qwen = require('../qwen_workflows');
const edit = require('../edit_workflows');
const bridge = require('../comfy_bridge');
const ip = process.argv[2];
if (!ip) throw new Error('Pass the ComfyUI host:port explicitly.');
(async () => {
    const queue = await (await fetch('http://' + ip + '/queue')).json();
    if (queue.queue_running.length || queue.queue_pending.length) throw new Error('Server busy; test not submitted.');
    const name = await bridge.uploadImage(ip, path.join(__dirname, 'live/input.png'));
    const mode = process.argv[3] || 'qwen21';
    const graph = mode === 'layers'
        ? qwen.appendWallRemoval({ source: { class_type: 'LoadImage', inputs: { image: name } }, save: { class_type: 'SaveImage', inputs: { images: ['source', 0], filename_prefix: 'ComfyFloatBar/TestOriginal' } } })
        : mode === 'remove'
        ? qwen.createRemoval(name)
        : edit.createEdit(mode, name, 'Preserve the exact terracotta red mug, composition, colors and plain cream background. Refine the edges and improve the material detail without adding objects.', { enabled: true, strength: 1 });
    if (graph.qwen_encode) graph.qwen_encode.inputs.resolution = 512;
    if (mode === 'layers') {
        graph.wall_qwen_encode.inputs.resolution = 512;
        graph.wall_qwen_encode.inputs.prompt = qwen.REMOVE_BACKGROUND_PROMPT;
    }
    const start = Date.now();
    const id = await bridge.sendPrompt(ip, graph);
    console.log('Submitted', mode, id);
    let image;
    if (mode === 'layers') {
        const images = await bridge.pollHistoryImages(ip, id, 2, ['wall_qwen_save', 'mockup_original_save']);
        image = images[0];
        fs.writeFileSync(path.join(__dirname, 'live/layers_original.png'), Buffer.from(await bridge.downloadImage(ip, images[1])));
    } else image = await bridge.pollHistory(ip, id);
    const buffer = await bridge.downloadImage(ip, image);
    const output = path.join(__dirname, 'live/' + mode + '.png');
    fs.writeFileSync(output, Buffer.from(buffer));
    console.log('Completed', mode, Math.round((Date.now() - start) / 1000) + 's', output);
})().catch(error => { console.error(error.message); process.exitCode = 1; });
