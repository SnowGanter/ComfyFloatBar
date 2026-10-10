const test = require('node:test');
const assert = require('node:assert/strict');
const edit = require('../edit_workflows');
const qwen = require('../qwen_workflows');
const bridge = require('../comfy_bridge');

test('Both editing models match RGB to the original and restore alpha', () => {
    for (const model of ['flux', 'qwen21']) {
        const graph = edit.createEdit(model, 'input.png', 'Restore details', { enabled: true, strength: 0.75 });
        const save = Object.values(graph).find(n => /^SaveImage/.test(n.class_type));
        assert.deepEqual(save.inputs.images, ['cfb_color_alpha', 0]);
        assert.deepEqual(graph.cfb_color_alpha.inputs.alpha, ['cfb_color_target', 1]);
        assert.deepEqual(graph.cfb_color_match.inputs.image_ref, ['cfb_color_reference', 0]);
        assert.equal(graph.cfb_color_match.inputs.strength, 0.75);
        const ref = graph.cfb_color_reference.inputs.image[0];
        assert.equal(graph[ref].class_type, 'LoadImage');
        assert.equal(graph[ref].inputs.image, 'input.png');
        const bypass = edit.createEdit(model, 'input.png', 'Change colors', { enabled: false });
        assert.ok(!bypass.cfb_color_match);
    }
});

test('Only the first Qwen Enhance mode loads Detail Enhancer and its trigger', () => {
    const graph = edit.createEdit('qwen21', 'one.png', 'Preserve the face', { enabled: false });
    assert.equal(graph.qwen_detail_lora.class_type, 'LoraLoaderModelOnly');
    assert.equal(graph.qwen_detail_lora.inputs.lora_name, qwen.DETAIL_ENHANCER_LORA);
    assert.equal(graph.qwen_detail_lora.inputs.strength_model, 1);
    assert.deepEqual(graph.qwen_cache.inputs.model, ['qwen_detail_lora', 0]);
    assert.match(graph.qwen_encode.inputs.prompt, /^Enhance this image\b/i);
    assert.equal(edit.createCombine('qwen21', 'one.png', 'two.png', 'Blend').qwen_detail_lora, undefined);
});

test('Masked Qwen mode uses native Fun ControlNet without the detail LoRA', () => {
    const graph = edit.createInpaint('qwen21', 'one.png', 'mask.png', 'Repair the selected area');
    assert.equal(graph.qwen_detail_lora, undefined);
    assert.equal(graph.qwen_control_patch.class_type, 'ModelPatchLoader');
    assert.equal(graph.qwen_control_patch.inputs.name, qwen.FUN_CONTROLNET);
    assert.equal(graph.qwen_control_apply.class_type, 'ZImageFunControlnet');
    assert.deepEqual(graph.qwen_control_apply.inputs.mask, ['qwen_mask', 1]);
    assert.deepEqual(graph.qwen_control_apply.inputs.inpaint_image, ['qwen_input_1', 0]);
    assert.deepEqual(graph.qwen_cache.inputs.model, ['qwen_control_apply', 0]);
    assert.equal(graph.qwen_encode.inputs.vae, undefined);
    assert.deepEqual(graph.qwen_save.inputs.images, ['qwen_composite', 0]);
});

test('Global Qwen Detail Enhancer settings control only graphs that contain the LoRA', () => {
    const graph = edit.createEdit('qwen21', 'one.png', 'Restore', { enabled:false });
    qwen.configure(graph, { detailEnhancerEnabled:true, detailEnhancerStrength:0.75 });
    assert.equal(graph.qwen_detail_lora.inputs.strength_model, 0.75);
    qwen.configure(graph, { detailEnhancerEnabled:false });
    assert.equal(graph.qwen_detail_lora, undefined);
    assert.deepEqual(graph.qwen_cache.inputs.model, ['qwen_model', 0]);
});

test('FLUX and Qwen routing covers mask and combine', () => {
    for (const model of ['flux', 'qwen21']) {
        const graphs = [edit.createCombine(model, 'a.png', 'b.png', 'Combine'),
            edit.createInpaint(model, 'a.png', 'mask.png', 'Replace')];
        for (const graph of graphs) {
            const models = Object.values(graph).filter(n => n.class_type === 'UNETLoader');
            assert.equal(models.length, 1);
            assert.ok(models[0].inputs.unet_name.includes(model === 'flux' ? 'flux' : 'qwen_image_2.1'));
            for (const n of Object.values(graph)) for (const value of Object.values(n.inputs)) {
                if (Array.isArray(value)) assert.ok(graph[value[0]], 'Missing graph dependency');
            }
        }
    }
});

test('Outpaint always uses Qwen and accepts margins beyond 400 pixels', () => {
    const graph = edit.createOutpaint('a.png', { left: 1600, right: 2048, top: 600, bottom: 800 }, 'Extend');
    assert.equal(graph.qwen_model.inputs.unet_name, qwen.MODELS.unet);
    assert.equal(graph.qwen_pad.inputs.left, 1600);
    assert.equal(graph.qwen_pad.inputs.right, 2048);
    assert.ok(!JSON.stringify(graph).includes('flux'));
});

test('Color node negotiates V2 and clearly rejects missing KJNodes', async () => {
    const oldFetch = global.fetch;
    const graph = edit.createEdit('flux', 'input.png', 'Restore');
    const info = Object.fromEntries(Object.values(graph).map(n => [n.class_type, {}]));
    delete info.ColorMatch; info.ColorMatchV2 = {};
    let posted;
    global.fetch = async (url, options) => url.includes('/object_info/')
        ? { ok: true, json: async () => info }
        : { ok: true, json: async () => { posted = JSON.parse(options.body).prompt; return { prompt_id: 'test' }; } };
    try {
        await bridge.sendPrompt('test', graph);
        assert.equal(posted.cfb_color_match.class_type, 'ColorMatchV2');
        assert.equal(graph.cfb_color_match.class_type, 'ColorMatch');
        delete info.ColorMatchV2;
        await assert.rejects(bridge.sendPrompt('test', graph), /ComfyUI-KJNodes/);
    } finally { global.fetch = oldFetch; }
});

test('Memory release respects shared queue and posts both freeing flags', async () => {
    const oldFetch = global.fetch;
    let busy = true, posted = null;
    global.fetch = async (url, options) => {
        if (url.endsWith('/queue')) return { ok: true, json: async () => ({ queue_running: busy ? [['job']] : [], queue_pending: [] }) };
        posted = JSON.parse(options.body); return { ok: true };
    };
    try {
        await assert.rejects(bridge.freeMemory('test'), /занят/);
        assert.equal(posted, null);
        busy = false;
        await bridge.freeMemory('test');
        assert.deepEqual(posted, { unload_models: true, free_memory: true });
    } finally { global.fetch = oldFetch; }
});
