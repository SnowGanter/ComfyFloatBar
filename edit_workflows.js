const qwen = require('./qwen_workflows');
const clone = value => JSON.parse(JSON.stringify(value));
const node = (class_type, inputs) => ({ class_type, inputs });
const FLUX_EDIT = require('./flux2_image_edit.json');
const FLUX_COMBINE = require('./flux2_klein_combine_images.json');
const FLUX_INPAINT = require('./flux_fill_inpaint.json');

function addColorMatch(graph, reference, { enabled = true, strength = 1, method = 'mkl' } = {}) {
    if (!enabled || Number(strength) <= 0) return graph;
    const save = Object.values(graph).find(n => ['SaveImage', 'SaveImageAdvanced'].includes(n.class_type));
    if (!save) throw new Error('Не найден выход изображения для переноса цвета.');
    // Match RGB only, then restore the generated alpha without color-transforming it.
    graph.cfb_color_target = node('SplitImageWithAlpha', { image: save.inputs.images });
    graph.cfb_color_reference = node('SplitImageWithAlpha', { image: reference });
    graph.cfb_color_match = node('ColorMatch', {
        image_target: ['cfb_color_target', 0], image_ref: ['cfb_color_reference', 0],
        method, strength: Math.max(0, Math.min(1, Number(strength))), multithread: false
    });
    graph.cfb_color_alpha = node('JoinImageWithAlpha', { image: ['cfb_color_match', 0], alpha: ['cfb_color_target', 1] });
    save.inputs.images = ['cfb_color_alpha', 0];
    return graph;
}

function createEdit(model, image, prompt, color) {
    let graph, reference;
    if (model === 'flux') {
        graph = clone(FLUX_EDIT);
        graph['76'].inputs.image = image;
        graph['75:74'].inputs.text = prompt;
        reference = ['76', 0];
    } else {
        graph = qwen.withDetailEnhancer(qwen.createWorkflow({ images: [image], prompt }));
        reference = ['qwen_input_1', 0];
    }
    return addColorMatch(graph, reference, color);
}

function createCombine(model, first, second, prompt) {
    if (model !== 'flux') return qwen.createWorkflow({ images: [first, second], prompt });
    const graph = clone(FLUX_COMBINE);
    graph['76'].inputs.image = first;
    graph['121'].inputs.image = second;
    graph['92:109'].inputs.text = prompt;
    return graph;
}

function createInpaint(model, image, mask, prompt) {
    if (model !== 'flux') return qwen.createInpaint(image, mask, prompt);
    const graph = clone(FLUX_INPAINT);
    graph['17'].inputs.image = image;
    graph.cfb_mask = node('LoadImage', { image: mask });
    graph['21:19:18:47:38'].inputs.mask = ['cfb_mask', 1];
    graph['48:0'].inputs.value = prompt;
    return graph;
}

function createOutpaint(image, margins, prompt) {
    return qwen.createOutpaint(image, margins, prompt);
}

module.exports = { createEdit, createCombine, createInpaint, createOutpaint, addColorMatch };
