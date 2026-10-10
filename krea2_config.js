const MODELS = Object.freeze({
    fp8: 'krea2_turbo_fp8_scaled.safetensors',
    bf16: 'krea2_turbo_bf16.safetensors',
    muse: 'museByStableYogi_v35Int8Extended.safetensors',
    kreation: 'kreation_variant3_mxfp8.safetensors'
});

function normalizeVariant(variant) {
    return Object.prototype.hasOwnProperty.call(MODELS, variant) ? variant : 'fp8';
}

function configure(workflow, variant = 'fp8') {
    const selectedModel = MODELS[normalizeVariant(variant)];
    for (const node of Object.values(workflow || {})) {
        if (node?.class_type !== 'UNETLoader') continue;
        const currentModel = String(node.inputs?.unet_name || '');
        if (!/^(?:krea2_turbo_(?:fp8_scaled|bf16)|museByStableYogi_v35Int8Extended|kreation_variant3_mxfp8)\.safetensors$/i.test(currentModel)) continue;
        node.inputs.unet_name = selectedModel;
    }
    return workflow;
}

module.exports = { MODELS, normalizeVariant, configure };
