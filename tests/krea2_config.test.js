const test = require('node:test');
const assert = require('node:assert/strict');
const krea2 = require('../krea2_config');

function loaders(graph) {
    return Object.values(graph).filter(node => node.class_type === 'UNETLoader');
}

test('Global Krea 2 model choice reaches text and image workflows', () => {
    for (const source of ['krea2.json', 'krea2_img2img.json']) {
        for (const [variant, filename] of Object.entries(krea2.MODELS)) {
            const graph = structuredClone(require('../' + source));
            krea2.configure(graph, variant);
            assert.equal(loaders(graph).length, 1);
            assert.equal(loaders(graph)[0].inputs.unet_name, filename);
        }
    }
});

test('Krea 2 choice updates generated variation loaders and leaves other models alone', () => {
    const graph = {
        krea: { class_type: 'UNETLoader', inputs: { unet_name: krea2.MODELS.fp8 } },
        qwen: { class_type: 'UNETLoader', inputs: { unet_name: 'qwen_image_2.1_int8_convrot.safetensors' } }
    };
    krea2.configure(graph, 'muse');
    assert.equal(graph.krea.inputs.unet_name, krea2.MODELS.muse);
    assert.equal(graph.qwen.inputs.unet_name, 'qwen_image_2.1_int8_convrot.safetensors');
    krea2.configure(graph, 'unknown');
    assert.equal(graph.krea.inputs.unet_name, krea2.MODELS.fp8);
});
