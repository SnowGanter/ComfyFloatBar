const test = require('node:test');
const assert = require('node:assert/strict');
const qwen = require('../qwen_workflows');
const bridge = require('../comfy_bridge');

function validate(graph) {
    const visiting = new Set(), visited = new Set();
    function visit(id) {
        assert.ok(graph[id], 'Missing node ' + id);
        assert.ok(!visiting.has(id), 'Cycle at ' + id);
        if (visited.has(id)) return;
        visiting.add(id);
        for (const value of Object.values(graph[id].inputs)) {
            if (Array.isArray(value)) { assert.equal(value.length, 2); visit(value[0]); }
        }
        visiting.delete(id); visited.add(id);
    }
    Object.keys(graph).forEach(visit);
    assert.equal(Object.values(graph).filter(n => /^SaveImage/.test(n.class_type)).length, graph.mockup_original_save ? 2 : 1);
    assert.ok(!JSON.stringify(graph).includes('flux'));
}

test('All Qwen modes have complete acyclic graphs and one final PNG', () => {
    [qwen.createWorkflow(), qwen.createWorkflow({ images: ['one.png', 'two.png'], prompt: 'Combine' }),
        qwen.createRemoval('one.png'), qwen.createInpaint('one.png', 'mask.png', 'Replace'),
        qwen.createOutpaint('one.png', { left: 100, right: 200, top: 0, bottom: 50 }, 'Extend')].forEach(validate);
});

test('Masked edit and outpaint preserve the original outside the mask', () => {
    const edit = qwen.createInpaint('one.png', 'mask.png', 'Replace');
    assert.deepEqual(edit.qwen_composite.inputs.destination, ['qwen_input_1', 0]);
    assert.deepEqual(edit.qwen_composite.inputs.mask, ['qwen_mask', 1]);
    assert.deepEqual(edit.qwen_save.inputs.images, ['qwen_composite', 0]);
    const expand = qwen.createOutpaint('one.png', { left: 100, right: 200, top: 0, bottom: 50 }, 'Extend');
    assert.deepEqual(expand.qwen_composite.inputs.mask, ['qwen_pad', 1]);
    assert.equal(expand.qwen_pad.inputs.feathering, 0);
    assert.equal(expand.qwen_pad.inputs.right, 200);
    assert.deepEqual(expand.qwen_control_apply.inputs.inpaint_image, ['qwen_pad', 0]);
    assert.deepEqual(expand.qwen_control_apply.inputs.mask, ['qwen_pad', 1]);
    assert.equal(expand.qwen_control_apply.inputs.strength, 1);
    assert.ok(!expand.qwen_control_edges);
    assert.ok(!expand.qwen_encode.inputs.vae);
    assert.ok(!expand.qwen_encode.inputs['images.image_2']);
    assert.deepEqual(expand.qwen_encode.inputs['images.image_1'], ['qwen_original', 0]);
    assert.deepEqual(expand.qwen_sample.inputs.latent_image, ['qwen_latent', 0]);
    assert.deepEqual(expand.qwen_latent.inputs.width, ['qwen_working_size', 0]);
});

test('Fun ControlNet adapts to merged and experimental ComfyUI schemas', async () => {
    const originalFetch = global.fetch;
    try {
        for (const serverType of ['ZImageFunControlnet', 'QwenImage21FunControlNetApply']) {
            const graph = qwen.createInpaint('one.png', 'mask.png', 'A restored building');
            const info = Object.fromEntries(Object.values(graph).map(n => [n.class_type, { input: { required: {} } }]));
            delete info.ZImageFunControlnet;
            info[serverType] = { input: { required: {} } };
            let posted;
            global.fetch = async (url, options) => {
                if (url.includes('/object_info/')) return { ok: true, json: async () => info };
                posted = JSON.parse(options.body).prompt;
                return { ok: true, json: async () => ({ prompt_id: 'test' }) };
            };
            await bridge.sendPrompt('test', graph);
            assert.equal(posted.qwen_control_apply.class_type, serverType);
            const controlKey = serverType === 'ZImageFunControlnet' ? 'image' : 'control_image';
            assert.deepEqual(posted.qwen_control_apply.inputs[controlKey], ['qwen_control_edges', 0]);
            assert.deepEqual(posted.qwen_control_apply.inputs.mask, ['qwen_mask', 1]);
            assert.equal(graph.qwen_control_apply.class_type, 'ZImageFunControlnet');
        }
    } finally { global.fetch = originalFetch; }
});

test('Generation uses Qwen only while retaining prompt enhancement and dimensions', () => {
    for (const filename of ['turbo', 'turbo_img2img', 'krea2', 'krea2_img2img']) {
        for (const enhanced of [false, true]) {
            const source = structuredClone(require('../' + filename + '.json'));
            const graph = qwen.fromGenerationWorkflow(source, { image: filename.includes('img2img') ? 'input.png' : null, prompt: 'A test scene', promptEnhance: enhanced, seed: 123 });
            validate(graph);
            const models = Object.values(graph).filter(n => n.class_type === 'UNETLoader');
            assert.equal(models.length, 1);
            assert.equal(models[0].inputs.unet_name, qwen.MODELS.unet);
            assert.equal(graph.qwen_sample.inputs.seed, 123);
            assert.equal(graph['49'].inputs.multiple, 32);
            if (!enhanced) assert.ok(!Object.values(graph).some(n => n.class_type === 'IFGeminiNode'));
            else assert.ok(Object.values(graph).some(n => n.class_type === 'IFGeminiNode'));
            const wall = qwen.appendWallRemoval(graph);
            validate(wall);
            assert.deepEqual(wall.wall_qwen_encode.inputs['images.image_1'], ['qwen_decode', 0]);
            assert.ok(wall.wall_qwen_encode.inputs.prompt.includes('ONLY the blank white main feature wall'));
        }
    }
});

test('Wall removal also follows legacy generators without returning the opaque intermediate', () => {
    const graph = qwen.appendWallRemoval(structuredClone(require('../turbo_img2img.json')));
    validate(graph);
    assert.ok(!graph['9']);
    assert.deepEqual(graph.wall_qwen_encode.inputs['images.image_1'], ['30:8', 0]);
    assert.deepEqual(graph.mockup_original_save.inputs.images, ['30:8', 0]);
});

test('Global precision and steps reach every Qwen pass, not other models', () => {
    const graph = qwen.appendWallRemoval(qwen.createWorkflow({ images: ['input.png'], prompt: 'An interior' }));
    qwen.configure(graph, { precision: 'bf16', steps: 37 });
    assert.equal(graph.qwen_model.inputs.unet_name, qwen.BF16_MODEL);
    assert.equal(graph.wall_qwen_model.inputs.unet_name, qwen.BF16_MODEL);
    assert.equal(graph.qwen_sample.inputs.steps, 37);
    assert.equal(graph.wall_qwen_sample.inputs.steps, 37);
    qwen.configure(graph, { precision: 'int8', steps: 0 });
    assert.equal(graph.qwen_model.inputs.unet_name, qwen.MODELS.unet);
    assert.equal(graph.qwen_sample.inputs.steps, 25);
    const flux = structuredClone(require('../flux2_image_edit.json'));
    const original = structuredClone(flux);
    qwen.configure(flux, { precision: 'bf16', steps: 50 });
    assert.deepEqual(flux, original);
});

test('Preflight resolves model subfolders and reports missing VAE before submitting', async () => {
    const originalFetch = global.fetch;
    const graph = qwen.createRemoval('input.png');
    const info = Object.fromEntries(Object.values(graph).map(n => [n.class_type, { input: { required: {} } }]));
    for (const [type, key, model] of [['UNETLoader', 'unet_name', qwen.MODELS.unet], ['CLIPLoader', 'clip_name', qwen.MODELS.clip], ['VAELoader', 'vae_name', qwen.MODELS.vae]]) {
        info[type].input.required[key] = [['Qwen2_1\\' + model]];
    }
    let posted = null;
    global.fetch = async (url, options) => {
        if (url.includes('/object_info/')) return { ok: true, json: async () => info };
        posted = JSON.parse(options.body).prompt;
        return { ok: true, json: async () => ({ prompt_id: 'test' }) };
    };
    try {
        assert.equal(await bridge.sendPrompt('test', graph), 'test');
        assert.equal(posted.qwen_model.inputs.unet_name, 'Qwen2_1\\' + qwen.MODELS.unet);
        assert.equal(graph.qwen_model.inputs.unet_name, qwen.MODELS.unet);
        info.VAELoader.input.required.vae_name = [[]]; posted = null;
        await assert.rejects(bridge.sendPrompt('test', graph), /qwen_image_2.1_vae_bf16/);
        assert.equal(posted, null);
    } finally { global.fetch = originalFetch; }
});
