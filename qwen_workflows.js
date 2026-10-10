// Qwen Image 2.1 API graphs. Based on Comfy-Org's official 2.1 templates.
// Keep weight_dtype=default: ConvRot files carry their own quantization metadata.
const MODELS = Object.freeze({
    unet: 'qwen_image_2.1_int8_convrot.safetensors',
    clip: 'qwen3vl_8b_int8_convrot.safetensors',
    vae: 'qwen_image_2.1_vae_bf16.safetensors'
});
const BF16_MODEL = 'qwen_image_2.1_bf16.safetensors';
const DETAIL_ENHANCER_LORA = 'elusarcas-qwen2-1-detailer-v1.safetensors';
const DETAIL_ENHANCER_TRIGGER = 'Enhance this image';
const FUN_CONTROLNET = 'qwen_image_2.1_fun_controlnet_union_int8_convrot.safetensors';

function configure(graph, { precision = 'int8', steps = 25, detailEnhancerEnabled = true, detailEnhancerStrength = 1 } = {}) {
    for (const value of Object.values(graph)) {
        if (value.class_type === 'UNETLoader' && /qwen_image_2\.1_/.test(value.inputs.unet_name || '')) {
            value.inputs.unet_name = precision === 'bf16' ? BF16_MODEL : MODELS.unet;
        }
        if (value.class_type === 'KSampler' && graph[value.inputs.positive?.[0]]?.class_type === 'TextEncodeQwenImage21') {
            value.inputs.steps = Math.max(1, Math.min(80, Math.round(Number(steps) || 25)));
        }
    }
    if (graph.qwen_detail_lora) {
        if (detailEnhancerEnabled === false) {
            if (graph.qwen_cache) graph.qwen_cache.inputs.model = ['qwen_model', 0];
            delete graph.qwen_detail_lora;
        } else {
            graph.qwen_detail_lora.inputs.strength_model = Math.max(0, Math.min(2, Number(detailEnhancerStrength) || 1));
        }
    }
    return graph;
}
const REMOVE_BACKGROUND_PROMPT = 'This is an RGBA image with transparency. Remove the background from <image1> and extract the foreground subject. Preserve its appearance, colors, fine details, position and scale. The image has an alpha channel and the background is transparent. Output a PNG image.';
const REMOVE_WALL_PROMPT = 'This is an RGBA image with transparency. In <image1>, remove ONLY the blank white main feature wall surface and make that wall area fully transparent for wallpaper placement. Preserve the rest of the interior: furniture, plants, curtains, lamps, floor, ceiling, skirting boards, window frames, framed pictures and all foreground objects. Keep their original colors, textures, positions, scale and perspective. White furniture, white artwork and white objects must remain opaque. Do not replace the room with an isolated product. The image has an alpha channel and only the main wall surface is transparent. Output a PNG image.';

function node(class_type, inputs) { return { class_type, inputs }; }
function seed() { return Math.floor(Math.random() * 0x1000000000000); }

function createWorkflow({ images = [], prompt = '', width, height, steps = 25, seed: noiseSeed = seed(), resolution = 0, prefix = 'ComfyFloatBar/Qwen21' } = {}) {
    const wf = {
        qwen_model: node('UNETLoader', { unet_name: MODELS.unet, weight_dtype: 'default' }),
        qwen_clip: node('CLIPLoader', { clip_name: MODELS.clip, type: 'qwen_image', device: 'default' }),
        qwen_vae: node('VAELoader', { vae_name: MODELS.vae }),
        qwen_cache: node('QwenImage21Cache', { model: ['qwen_model', 0], device: 'auto', dtype: 'default' }),
        qwen_encode: node('TextEncodeQwenImage21', { clip: ['qwen_clip', 0], vae: ['qwen_vae', 0], prompt, negative_prompt: '', resolution }),
        qwen_sample: node('KSampler', { model: ['qwen_cache', 0], positive: ['qwen_encode', 0], negative: ['qwen_encode', 1], latent_image: ['qwen_encode', 2], seed: noiseSeed, steps, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1 }),
        qwen_decode: node('VAEDecode', { samples: ['qwen_sample', 0], vae: ['qwen_vae', 0] }),
        qwen_save: node('SaveImageAdvanced', { images: ['qwen_decode', 0], filename_prefix: prefix, format: 'png', 'format.bit_depth': '8-bit', 'format.input_color_space': 'sRGB' })
    };
    images.forEach((image, index) => {
        const id = 'qwen_input_' + (index + 1);
        if (Array.isArray(image)) wf.qwen_encode.inputs['images.image_' + (index + 1)] = image;
        else {
            wf[id] = node('LoadImage', { image });
            wf[id + '_rgba'] = node('JoinImageWithAlpha', { image: [id, 0], alpha: [id, 1] });
            wf.qwen_encode.inputs['images.image_' + (index + 1)] = [id + '_rgba', 0];
        }
    });
    if (!images.length || (width && height)) {
        wf.qwen_latent = node('EmptyLatentImage', { width: width || 1024, height: height || 1024, batch_size: 1 });
        wf.qwen_sample.inputs.latent_image = ['qwen_latent', 0];
    }
    return wf;
}

function withFunControlNet(wf, source, { mask = null, strength = 0.8, endPercent = 1, controlEdges = true } = {}) {
    if (!wf?.qwen_model || !wf?.qwen_cache || !wf?.qwen_encode || !wf?.qwen_vae) {
        throw new Error('В Qwen workflow отсутствуют узлы для Fun ControlNet.');
    }
    // The source stays visible to Qwen3-VL, but is not added as a reference latent.
    // This lets the model actually reconstruct defects instead of copying them.
    delete wf.qwen_encode.inputs.vae;
    if (controlEdges) wf.qwen_control_edges = node('Canny', {
        image: source, low_threshold: 0.25, high_threshold: 0.65
    });
    wf.qwen_control_patch = node('ModelPatchLoader', { name: FUN_CONTROLNET });
    const inputs = {
        model: ['qwen_model', 0], model_patch: ['qwen_control_patch', 0], vae: ['qwen_vae', 0],
        strength, start_percent: 0, end_percent: endPercent
    };
    if (controlEdges) inputs.image = ['qwen_control_edges', 0];
    if (mask) {
        inputs.inpaint_image = source;
        inputs.mask = mask;
    }
    wf.qwen_control_apply = node('ZImageFunControlnet', inputs);
    wf.qwen_cache.inputs.model = ['qwen_control_apply', 0];
    return wf;
}

function withDetailEnhancer(wf, strength = 1) {
    if (!wf?.qwen_model || !wf?.qwen_cache || !wf?.qwen_encode) {
        throw new Error('В Qwen workflow отсутствуют узлы для Detail Enhancer.');
    }
    const prompt = String(wf.qwen_encode.inputs.prompt || '').trim();
    if (!/^enhance this image\b/i.test(prompt)) {
        wf.qwen_encode.inputs.prompt = DETAIL_ENHANCER_TRIGGER + (prompt ? '. ' + prompt : '.');
    }
    wf.qwen_detail_lora = node('LoraLoaderModelOnly', {
        model: ['qwen_model', 0], lora_name: DETAIL_ENHANCER_LORA,
        strength_model: Math.max(-10, Math.min(10, Number(strength) || 1))
    });
    wf.qwen_cache.inputs.model = ['qwen_detail_lora', 0];
    return wf;
}

function matchOutputSize(wf, image) {
    wf.qwen_size = node('GetImageSize', { image });
    wf.qwen_resize = node('ImageScale', { image: ['qwen_decode', 0], width: ['qwen_size', 0], height: ['qwen_size', 1], upscale_method: 'lanczos', crop: 'disabled' });
    wf.qwen_save.inputs.images = ['qwen_resize', 0];
    return wf;
}

function createRemoval(image, prompt = REMOVE_BACKGROUND_PROMPT) {
    // Resize only the model's reference; restore the original canvas for Photoshop.
    return matchOutputSize(createWorkflow({ images: [image], prompt, resolution: 1024, prefix: 'ComfyFloatBar/Qwen21_RemoveBG' }), Array.isArray(image) ? image : ['qwen_input_1', 0]);
}

function appendWallRemoval(graph) {
    const saveId = Object.keys(graph).find(id => ['SaveImage', 'SaveImageAdvanced'].includes(graph[id].class_type));
    if (!saveId) throw new Error('В графе мокапа нет итогового изображения.');
    const removal = createRemoval(['__mockup_result', 0], REMOVE_WALL_PROMPT);
    const renamed = {};
    for (const [id, value] of Object.entries(removal)) {
        const copy = JSON.parse(JSON.stringify(value));
        for (const [key, input] of Object.entries(copy.inputs)) {
            if (Array.isArray(input) && input[0] === '__mockup_result') copy.inputs[key] = graph[saveId].inputs.images;
            else if (Array.isArray(input) && removal[input[0]]) copy.inputs[key] = ['wall_' + input[0], input[1]];
        }
        renamed['wall_' + id] = copy;
    }
    renamed.wall_qwen_save.inputs.filename_prefix = 'ComfyFloatBar/Qwen21_Mockup_TransparentWall';
    const originalSave = JSON.parse(JSON.stringify(graph[saveId]));
    originalSave.inputs.filename_prefix = 'ComfyFloatBar/Mockup_BeforeWallRemoval';
    return keepDependencies({ ...graph, ...renamed, mockup_original_save: originalSave }, ['wall_qwen_save', 'mockup_original_save']);
}

function createInpaint(image, maskImage, prompt) {
    const wf = createWorkflow({ images: [image], prompt: 'Reconstruct the masked area of this image. ' + prompt + '. Match the surrounding composition, colors, materials, lighting and visual style.' });
    wf.qwen_mask = node('LoadImage', { image: maskImage });
    withFunControlNet(wf, ['qwen_input_1', 0], { mask: ['qwen_mask', 1], strength: 0.8, endPercent: 1 });
    matchOutputSize(wf, ['qwen_input_1', 0]);
    wf.qwen_composite = node('ImageCompositeMasked', {
        destination: ['qwen_input_1', 0], source: ['qwen_resize', 0], x: 0, y: 0,
        resize_source: false, mask: ['qwen_mask', 1]
    });
    wf.qwen_save.inputs.images = ['qwen_composite', 0];
    return wf;
}

function createOutpaint(image, margins, prompt) {
    const wf = createWorkflow({ images: [['qwen_original', 0]], prompt: 'A complete seamless extension of the scene in <image1>. ' + prompt + '. Continue the surrounding scenery, perspective, lighting, colors and textures naturally into the new canvas areas. The entire canvas is filled with scene content, without blank borders.', resolution: 1024, prefix: 'ComfyFloatBar/Qwen21_Outpaint' });
    wf.qwen_original = node('LoadImage', { image });
    wf.qwen_pad = node('ImagePadForOutpaint', { image: ['qwen_original', 0], left: margins.left, top: margins.top, right: margins.right, bottom: margins.bottom, feathering: 0 });
    // Keep blank padding out of Qwen3-VL's reference: it otherwise draws a frame.
    // Sampling dimensions come from the expanded canvas, independently of vision.
    wf.qwen_working_canvas = node('ImageScaleToTotalPixels', {
        image: ['qwen_pad', 0], upscale_method: 'lanczos', megapixels: 1, resolution_steps: 32
    });
    wf.qwen_working_size = node('GetImageSize', { image: ['qwen_working_canvas', 0] });
    wf.qwen_latent = node('EmptyLatentImage', {
        width: ['qwen_working_size', 0], height: ['qwen_working_size', 1], batch_size: 1
    });
    wf.qwen_sample.inputs.latent_image = ['qwen_latent', 0];
    // Union's inpainting channels carry the padded canvas and its actual mask.
    // No Canny here: edges of the blank padding would constrain the new scenery.
    withFunControlNet(wf, ['qwen_pad', 0], { mask: ['qwen_pad', 1], strength: 1, controlEdges: false });
    matchOutputSize(wf, ['qwen_pad', 0]);
    wf.qwen_composite = node('ImageCompositeMasked', {
        destination: ['qwen_pad', 0], source: ['qwen_resize', 0], x: 0, y: 0,
        resize_source: false, mask: ['qwen_pad', 1]
    });
    wf.qwen_save.inputs.images = ['qwen_composite', 0];
    return wf;
}

function keepDependencies(graph, outputs) {
    const result = {};
    function visit(id) {
        if (result[id]) return;
        if (!graph[id]) throw new Error('Отсутствует узел workflow: ' + id);
        result[id] = graph[id];
        for (const value of Object.values(graph[id].inputs)) {
            if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'string') visit(value[0]);
        }
    }
    outputs.forEach(visit);
    return result;
}

function fromGenerationWorkflow(source, { image = null, prompt, promptEnhance, seed: noiseSeed, prefix } = {}) {
    // Reuse the existing Gemini prompt branch and size controls, never its diffusion model.
    const encode = Object.values(source).find(node => node.class_type === 'CLIPTextEncode');
    if (!encode) throw new Error('В исходном графе не найден текстовый prompt.');
    const wf = createWorkflow({ images: image ? [image] : [], prompt: promptEnhance ? encode.inputs.text : prompt,
        width: ['49', 0], height: ['49', 1], seed: noiseSeed, resolution: 1024, prefix });
    const graph = { ...source, ...wf };
    graph['49'] = JSON.parse(JSON.stringify(source['49']));
    graph['49'].inputs.multiple = 32;
    return keepDependencies(graph, ['qwen_save']);
}

module.exports = { MODELS, BF16_MODEL, DETAIL_ENHANCER_LORA, DETAIL_ENHANCER_TRIGGER, FUN_CONTROLNET, configure, createWorkflow, withDetailEnhancer, withFunControlNet, REMOVE_BACKGROUND_PROMPT, REMOVE_WALL_PROMPT, createRemoval, createInpaint, createOutpaint, fromGenerationWorkflow, appendWallRemoval, keepDependencies };
