'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loras = require('../krea2_loras');
const krea2 = require('../krea2_config');
const bridge = require('../comfy_bridge');

test('all 32 requested LoRAs are catalogued with exact filenames and valid optional previews', () => {
  assert.equal(loras.LORAS.length, 32);
  assert.deepEqual(loras.LORAS.map(item => item.file), [
    'Arcana_Press_-_Krea2.safetensors','FableLightKrea2.safetensors','Krea2D1sneyCl4ssic.safetensors',
    'spirou_fantasio_krea2.safetensors','kr2_handdrawn_toon.safetensors','Minimalistic_illustration.safetensors',
    'Darkchurch_style_krea2_v1.0.safetensors','MARBAS-KREA-V1.safetensors','Chizikov_byKotoshko_c1-st6000.safetensors',
    'Krea2_Moebius_LoRA.safetensors','ImpressionismKrea2Raw.safetensors','Krea 2 - Dan Mora Chavez Style.safetensors',
    'BisleyV4_000001800.safetensors','Brom_Krea2_v2.safetensors','softwatercolor.safetensors','Fleischer Krea.safetensors',
    'tuniques_bleues_krea2.safetensors','Krea2FlatIllustrationV1.safetensors','VESSAGO-KREA-V1 (1).safetensors',
    'Krea 2 Nix Comic v2_balanced.safetensors','Niji_Sweet_Spot_Krea2_v2A.safetensors','Storybook_Folk_Art_Krea2.safetensors',
    '@rolua.safetensors','Style_soph-PunkyDoodlesKREA2.safetensors','krea2_hollowvoid_v1.safetensors',
    'sxz-hades-pdxl.safetensors','sxz-clashroyale-krea2-v1-alt_epoch_10.safetensors',
    'sxz-xutzzz-krea2-v1_epoch_10.safetensors','sxz-crystalbeastie-krea2-v1_epoch_10.safetensors',
    'sxz-bayardwu-v1-anima.safetensors','berserk_krea2.safetensors','MarvelScreen2_Krea2.safetensors'
  ]);
  for (const item of loras.LORAS) {
    assert.ok(item.previews.length <= 3, `${item.id} has at most three optional previews`);
    for (const preview of item.previews) assert.equal(fs.existsSync(path.join(__dirname, '..', preview)), true, preview);
  }
});

test('Krea preflight resolves known filename aliases and rejects missing server weights', async () => {
  const originalFetch = global.fetch;
  const graph = structuredClone(require('../krea2.json'));
  krea2.configure(graph, 'bf16');
  loras.configure(graph, { enabled:true, id:'fabel', strength:1 });
  let posted = null;
  const serverFiles = {
    UNETLoader:['krea2_turbo_bf16.safetensors'],
    LoraLoaderModelOnly:['FabelLightKrea2.safetensors'],
    CLIPLoader:['qwen3vl_4b_fp8_scaled.safetensors'],
    VAELoader:['qwen_image_vae.safetensors']
  };
  global.fetch = async (url, options) => {
    const type = decodeURIComponent(String(url).split('/object_info/')[1] || '');
    if (type) {
      const key = type === 'UNETLoader' ? 'unet_name' : type === 'LoraLoaderModelOnly' ? 'lora_name' : type === 'CLIPLoader' ? 'clip_name' : 'vae_name';
      return { ok:true, json:async()=>({ [type]:{ input:{ required:{ [key]:[serverFiles[type] || []] } } } }) };
    }
    posted = JSON.parse(options.body).prompt;
    return { ok:true, json:async()=>({prompt_id:'test'}) };
  };
  try {
    assert.equal(await bridge.sendPrompt('test', graph), 'test');
    assert.equal(posted['30:15'].inputs.lora_name, 'FabelLightKrea2.safetensors');
    assert.equal(graph['30:15'].inputs.lora_name, 'FableLightKrea2.safetensors');
    krea2.configure(graph, 'kreation'); posted = null;
    await assert.rejects(bridge.sendPrompt('test', graph), /не видит модель.*kreation_variant3_mxfp8/);
    assert.equal(posted, null);
  } finally { global.fetch = originalFetch; }
});

test('partial ComfyUI acceptance is reported as a graph error instead of a missing image', async () => {
  const originalFetch = global.fetch;
  const graph = { preview:{ class_type:'PreviewAny', inputs:{ source:'text' } } };
  global.fetch = async (url, options) => String(url).endsWith('/queue')
    ? { ok:true, json:async()=>({}) }
    : { ok:true, json:async()=>({ prompt_id:'partial', node_errors:{ '29':{ errors:[{ message:'Value not in list: unet_name' }] } } }) };
  try {
    await assert.rejects(bridge.sendPrompt('test', graph), /29: Value not in list: unet_name/);
  } finally { global.fetch = originalFetch; }
});

test('LoRA toggle configures bundled Krea workflows, strength and trigger phrase', () => {
  const graph = structuredClone(require('../krea2.json'));
  loras.configure(graph, { enabled:true, id:'arcana', strength:.75 });
  assert.equal(graph['30:15'].inputs.lora_name, 'Arcana_Press_-_Krea2.safetensors');
  assert.equal(graph['30:15'].inputs.strength_model, .75);
  assert.equal(graph['30:23'].inputs.value, true);
  assert.equal(graph['30:27'].inputs.string_b, 'arcanapress');
  loras.configure(graph, { enabled:false, id:'arcana' });
  assert.equal(graph['30:15'].inputs.strength_model, 0);
  assert.equal(graph['30:23'].inputs.value, false);
});

test('LoRA is inserted into generated Krea graphs without changing non-Krea models', () => {
  const graph = {
    model:{ class_type:'UNETLoader', inputs:{ unet_name:'kreation_variant3_mxfp8.safetensors' } },
    sampler:{ class_type:'KSampler', inputs:{ model:['model',0] } },
    prompt:{ class_type:'CLIPTextEncode', inputs:{ text:['text',0], clip:['clip',0] } },
    qwen:{ class_type:'UNETLoader', inputs:{ unet_name:'qwen_image_2.1_int8_convrot.safetensors' } }
  };
  loras.configure(graph, { enabled:true, id:'storybook', strength:1.2 });
  assert.equal(graph.cfb_krea2_lora.inputs.lora_name, 'Storybook_Folk_Art_Krea2.safetensors');
  assert.deepEqual(graph.sampler.inputs.model, ['cfb_krea2_lora',0]);
  assert.equal(graph.cfb_krea2_lora_prompt.inputs.string_b, 'whimsical storybook illustration');
  assert.equal(graph.qwen.inputs.unet_name, 'qwen_image_2.1_int8_convrot.safetensors');
});

test('documented defaults and trigger phrases are applied automatically', () => {
  const graph = structuredClone(require('../krea2.json'));
  loras.configure(graph, { enabled:true, id:'punkydoodles' });
  assert.equal(graph['30:15'].inputs.strength_model, .9);
  assert.equal(graph['30:27'].inputs.string_b, 'digital illustration with rough lines');
  const berserk = structuredClone(require('../krea2.json'));
  loras.configure(berserk, { enabled:true, id:'berserk' });
  assert.equal(berserk['30:15'].inputs.strength_model, 1.2);
  assert.equal(berserk['30:27'].inputs.string_b, 'manga style');
});

test('LoRAs trained for another architecture fail before queueing Krea 2', () => {
  for (const id of ['hades','bayardwu']) {
    const graph = structuredClone(require('../krea2.json'));
    assert.throws(() => loras.configure(graph, { enabled:true, id }), /несовместима с Krea 2/);
  }
});
