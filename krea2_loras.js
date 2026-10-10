'use strict';

const LORAS = Object.freeze([
  { id:'arcana', file:'Arcana_Press_-_Krea2.safetensors', label:'Arcana Press', strength:1, trigger:'arcanapress', civitai:2701936, versionId:3113777, strengthNote:'Автор: 1.0; 1.1 для сложных сюжетов.' },
  { id:'fabel', file:'FableLightKrea2.safetensors', aliases:['FabelLightKrea2.safetensors'], label:'Fable Light', strength:1, trigger:'lastunic0rn', civitai:2880541, versionId:3255659, strengthNote:'Нейтральная сила 1.0; отдельное значение автор не указал.' },
  { id:'disney', file:'Krea2D1sneyCl4ssic.safetensors', label:'Disney Classic', strength:.8, trigger:'D1sneyCl4ssic', civitai:2823137, versionId:3184699, strengthNote:'Автор: 0.5–1.0; выбрано 0.8.' },
  { id:'spirou', file:'spirou_fantasio_krea2.safetensors', aliases:['spirou_fantazio_krea2.safetensors'], label:'Spirou & Fantasio', strength:1, trigger:'spirou_fantasio style', civitai:750299, versionId:3141470, strengthNote:'Автор: 1.0.' },
  { id:'handdrawn', file:'kr2_handdrawn_toon.safetensors', label:'Expressive Euro Cartoon', strength:1, trigger:'kr2h4ndtn, comic, 2d, flat color', civitai:2694211, versionId:3133709, strengthNote:'Автор: 1.0; до 1.5 для реалистичных сюжетов.' },
  { id:'minimalistic', file:'Minimalistic_illustration.safetensors', label:'Minimalistic Illustration', strength:.85, trigger:'stylized illustration, brush strokes', civitai:2809867, versionId:3168649, strengthNote:'Автор: 0.75–1.0; выбрано 0.85.' },
  { id:'darkchurch', file:'Darkchurch_style_krea2_v1.0.safetensors', label:'Darkchurch', strength:1, trigger:'Digital high-contrast drawing', civitai:2920325, versionId:3304095, strengthNote:'База 1.0; автор предлагает 1.1–1.5, если стиль перебивается.' },
  { id:'marbas', file:'MARBAS-KREA-V1.safetensors', label:'Marbas Soft Crayon', strength:.7, trigger:'M4RB4SFX, crayon, textured, hand-drawn, grainy, soft', civitai:2855519, versionId:3225028, strengthNote:'Автор: 0.6–0.8; выбрано 0.7.' },
  { id:'chizhikov', file:'Chizikov_byKotoshko_c1-st6000.safetensors', label:'Chizhikov Illustration', strength:1, trigger:'chizikov0, illustration', civitai:2770208, versionId:3151012, strengthNote:'Нейтральная сила 1.0; триггер необязателен, но помогает закрепить стиль.' },
  { id:'moebius', file:'Krea2_Moebius_LoRA.safetensors', label:'Moebius / Jean Giraud', strength:1, trigger:'', civitai:2762376, versionId:3108904, strengthNote:'Автор не требует триггер; используется нейтральная сила 1.0.' },
  { id:'impressionism', file:'ImpressionismKrea2Raw.safetensors', label:'Impressionism', strength:1, trigger:'ArsMJStyle, impressionism', civitai:545264, versionId:3219131, strengthNote:'Автор: 0.6–1.5; выбрано 1.0.' },
  { id:'danmora', file:'Krea 2 - Dan Mora Chavez Style.safetensors', label:'Dan Mora Chavez', strength:1, trigger:'In the style of Dan Mora Chavez', civitai:2793943, versionId:3148918, strengthNote:'Отдельное значение не указано; используется 1.0.' },
  { id:'bisley', file:'BisleyV4_000001800.safetensors', label:'Simon Bisley', strength:1, trigger:'painting in Simon Bisley style', civitai:2628760, versionId:3139812, strengthNote:'Отдельное значение не указано; используется 1.0.' },
  { id:'brom', file:'Brom_Krea2_v2.safetensors', label:'Brom', strength:1, trigger:'bromk2style', civitai:2537540, versionId:3125138, strengthNote:'Отдельное значение не указано; используется 1.0.' },
  { id:'softwater', file:'softwatercolor.safetensors', label:'Soft Watercolor', strength:1, trigger:'Art Deco watercolor style', source:'https://huggingface.co/krea/Krea-2-LoRA-softwatercolor', strengthNote:'Официальная рекомендация: 1.0.' },
  { id:'fleischer', file:'Fleischer Krea.safetensors', label:'Fleischer Studio', strength:1, trigger:'Fleischer Style', civitai:2817646, versionId:3178066, strengthNote:'Отдельное значение не указано; используется 1.0.' },
  { id:'tuniques', file:'tuniques_bleues_krea2.safetensors', label:'Les Tuniques Bleues', strength:1, trigger:'comic style', civitai:930835, versionId:3115756, strengthNote:'Автор: 1.0.' },
  { id:'flat', file:'Krea2FlatIllustrationV1.safetensors', label:'Flat Illustration / Anime', strength:1, trigger:'', civitai:2744176, versionId:3086495, strengthNote:'Автор: 1.0; триггер не нужен.' },
  { id:'vessago', file:'VESSAGO-KREA-V1 (1).safetensors', label:'Vassago Flat Cartoon', strength:.7, trigger:'V4SS4G0X, flat art, cartoon', civitai:2853357, versionId:3258343, strengthNote:'Автор: 0.6–0.8; выбрано 0.7.' },
  { id:'nix', file:'Krea 2 Nix Comic v2_balanced.safetensors', label:'Nix Comic v2', strength:.8, trigger:'', civitai:2836231, versionId:3268616, strengthNote:'Автор: 0.7–0.85; выбрано 0.8, триггер не нужен.' },
  { id:'niji', file:'Niji_Sweet_Spot_Krea2_v2A.safetensors', label:'Niji Sweet Spot', strength:1, trigger:'@NJSW33T', civitai:2554999, versionId:3210573, strengthNote:'Автор: 0.8–1.5; обычно 1.0.' },
  { id:'storybook', file:'Storybook_Folk_Art_Krea2.safetensors', label:'Storybook Folk Art', strength:1, trigger:'whimsical storybook illustration', civitai:1321740, versionId:3199069, strengthNote:'Автор: 1.0.' },
  { id:'rolua', file:'@rolua.safetensors', label:'Rolua Painterly', strength:.7, trigger:'@rolua', civitai:2737255, versionId:3134747, strengthNote:'Автор: 0.6–0.8; выбрано 0.7.' },
  { id:'punkydoodles', file:'Style_soph-PunkyDoodlesKREA2.safetensors', label:'PunkyDoodles', strength:.9, trigger:'digital illustration with rough lines', civitai:2737630, versionId:3322893, strengthNote:'Автор: 0.9–1.0; выбрано 0.9.' },
  { id:'hollowvoid', file:'krea2_hollowvoid_v1.safetensors', label:'Hollow Void', strength:1, trigger:'', civitai:2851092, versionId:3219631, strengthNote:'Триггер не нужен; используется нейтральная сила 1.0.' },
  { id:'hades', file:'sxz-hades-pdxl.safetensors', label:'Hades — Pony (несовместима)', strength:1, trigger:'hds style, cel shading, linear hatching', civitai:429227, versionId:478222, baseModel:'Pony', strengthNote:'Файл обучен под Pony и не может работать с Krea 2.' },
  { id:'clashroyale', file:'sxz-clashroyale-krea2-v1-alt_epoch_10.safetensors', label:'Clash Royale', strength:1, trigger:'@clashroyale, 3d render, stylized', civitai:2869644, versionId:3242154, strengthNote:'Отдельное значение не указано; используется 1.0.' },
  { id:'xutzzz', file:'sxz-xutzzz-krea2-v1_epoch_10.safetensors', label:'Xutzzz', strength:1, trigger:'@xutzzz, stylized', civitai:2853442, versionId:3222535, strengthNote:'Отдельное значение не указано; используется 1.0.' },
  { id:'crystalbeastie', file:'sxz-crystalbeastie-krea2-v1_epoch_10.safetensors', label:'Crystal Beastie', strength:1, trigger:'@crystalbeastie, 2d illustration, stylized', civitai:2853857, versionId:3223045, strengthNote:'Отдельное значение не указано; используется 1.0.' },
  { id:'bayardwu', file:'sxz-bayardwu-v1-anima.safetensors', label:'Bayard Wu — Anima (несовместима)', strength:1, trigger:'@bayardwu', civitai:2535619, versionId:2849701, baseModel:'Anima', replacement:'sxz-bayardwu-krea2_epoch_10.safetensors', strengthNote:'Файл обучен под Anima. Для Krea 2 нужна версия sxz-bayardwu-krea2_epoch_10.safetensors.' },
  { id:'berserk', file:'berserk_krea2.safetensors', label:'Berserk Manga', strength:1.2, trigger:'manga style', civitai:743448, versionId:3092513, strengthNote:'Автор: 1.2 для Krea 2 Turbo.' },
  { id:'marvelscreen', file:'MarvelScreen2_Krea2.safetensors', label:'Marvel Rivals Screens', strength:1, trigger:'', civitai:2512559, versionId:3140583, strengthNote:'Для Krea 2 отдельное значение не указано; используется 1.0.' }
].map(item => Object.freeze({
  baseModel:'Krea 2',
  ...item,
  previews:[1,2,3].map(index => `assets/krea2-loras/${item.id}-${index}.${item.id === 'softwater' ? 'jpg' : 'jpeg'}`).filter(file => require('fs').existsSync(require('path').join(__dirname, file)))
})));

function find(id) { return LORAS.find(item => item.id === id) || LORAS[0]; }

function uniqueNodeId(workflow, base) {
  let id = base, index = 2;
  while (workflow[id]) id = `${base}_${index++}`;
  return id;
}

function configure(workflow, raw = {}) {
  const enabled = raw.enabled === true;
  const selected = find(raw.id);
  const strength = Number.isFinite(Number(raw.strength)) ? Math.max(-2, Math.min(2, Number(raw.strength))) : selected.strength;
  const nodes = Object.entries(workflow || {});
  const loaders = nodes.filter(([, node]) => node?.class_type === 'UNETLoader' && /(?:krea2|kreation|museByStableYogi)/i.test(String(node.inputs?.unet_name || '')));
  if (!loaders.length) return workflow;
  if (enabled && selected.baseModel !== 'Krea 2') {
    const replacement = selected.replacement ? ` Установите Krea 2 версию: ${selected.replacement}.` : '';
    throw new Error(`LoRA «${selected.label.replace(/ —.*/, '')}» обучена для ${selected.baseModel} и несовместима с Krea 2.${replacement}`);
  }

  const builtIn = nodes.find(([, node]) => node?.class_type === 'LoraLoaderModelOnly' && loaders.some(([id]) => node.inputs?.model?.[0] === id));
  if (builtIn) {
    builtIn[1].inputs.lora_name = selected.file;
    builtIn[1].inputs.strength_model = enabled ? strength : 0;
    builtIn[1]._meta = { ...(builtIn[1]._meta || {}), cfbEnabled:enabled, cfbAliases:selected.aliases || [] };
    if (workflow['30:23']?.class_type === 'PrimitiveBoolean') workflow['30:23'].inputs.value = enabled;
    if (workflow['30:27']?.class_type === 'StringConcatenate') workflow['30:27'].inputs.string_b = enabled ? selected.trigger : '';
    return workflow;
  }
  if (!enabled) return workflow;

  for (const [loaderId] of loaders) {
    const loraId = uniqueNodeId(workflow, 'cfb_krea2_lora');
    for (const [, node] of Object.entries(workflow)) {
      for (const [key, value] of Object.entries(node?.inputs || {})) {
        if (Array.isArray(value) && value[0] === loaderId && value[1] === 0) node.inputs[key] = [loraId, 0];
      }
    }
    workflow[loraId] = { class_type:'LoraLoaderModelOnly', inputs:{ model:[loaderId,0], lora_name:selected.file, strength_model:strength }, _meta:{ title:'Krea 2 LoRA', cfbEnabled:true, cfbAliases:selected.aliases || [] } };
  }
  if (selected.trigger) {
    for (const [, node] of Object.entries(workflow)) {
      if (node?.class_type !== 'CLIPTextEncode' || !Array.isArray(node.inputs?.text)) continue;
      const concatId = uniqueNodeId(workflow, 'cfb_krea2_lora_prompt');
      const original = node.inputs.text;
      workflow[concatId] = { class_type:'StringConcatenate', inputs:{ string_a:original, string_b:selected.trigger, delimiter:', ' }, _meta:{ title:'Krea 2 LoRA Trigger' } };
      node.inputs.text = [concatId,0];
      break;
    }
  }
  return workflow;
}

module.exports = { LORAS, find, configure };
