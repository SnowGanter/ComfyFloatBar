const KREA2_WORKFLOW = require('./krea2.json');
const TURBO_WORKFLOW = require('./turbo.json');
const KREA2_IMG2IMG_WORKFLOW = require('./krea2_img2img.json');
const TURBO_IMG2IMG_WORKFLOW = require('./turbo_img2img.json');
const VECTORIZER_WORKFLOW = require('./Vectorizer.json');
const SEEDVR2_UPSCALE_WORKFLOW = require('./seedvr2_upscale.json');
const THREE_VARIATIONS_WORKFLOW = require('./three_variations.json');
const TRIPTYCH_TO_THREE_WORKFLOW = require('./triptych_to_three.json');

const STUB_WORKFLOW = {
  "1": { "inputs": { "image": "placeholder.png" }, "class_type": "LoadImage" },
  "3": { "inputs": { "filename_prefix": "ComfyUI", "images": ["1", 0] }, "class_type": "SaveImage" }
};


// Реальный граф удаления фона BiRefNet
// (ID нод переименованы для совместимости с нашим мостом)
const BIREFNET_WORKFLOW = {
  "1": {
    "inputs": { "image": "placeholder.png" },
    "class_type": "LoadImage",
    "_meta": { "title": "Загрузить изображение" }
  },
  "10": {
    "inputs": { "bg_removal_name": "birefnet.safetensors" },
    "class_type": "LoadBackgroundRemovalModel",
    "_meta": { "title": "Загрузить модель удаления фона" }
  },
  "11": {
    "inputs": {
      "bg_removal_model": [ "10", 0 ],
      "image": [ "1", 0 ]
    },
    "class_type": "RemoveBackground",
    "_meta": { "title": "Удалить фон" }
  },
  "12": {
    "inputs": { "mask": [ "11", 0 ] },
    "class_type": "InvertMask",
    "_meta": { "title": "Инвертировать маску" }
  },
  "13": {
    "inputs": {
      "image": [ "1", 0 ],
      "alpha": [ "12", 0 ]
    },
    "class_type": "JoinImageWithAlpha",
    "_meta": { "title": "Объединить изображение с альфа-каналом" }
  },
  "3": {
    "inputs": {
      "filename_prefix": "ComfyUI",
      "format": "png",
      "format.bit_depth": "8-bit",
      "format.input_color_space": "sRGB",
      "images": [ "13", 0 ]
    },
    "class_type": "SaveImageAdvanced",
    "_meta": { "title": "Save Image (Advanced)" }
  }
};

// Высокоточный BiRefNet из установленного ComfyUI-RMBG.
// Он поддерживает специализированные модели и foreground refinement,
// возвращая готовый RGBA без разрушительного порога после генерации.
const BIREFNET_HQ_WORKFLOW = {
  "1": {
    "inputs": { "image": "placeholder.png" },
    "class_type": "LoadImage",
    "_meta": { "title": "Загрузить изображение" }
  },
  "11": {
    "inputs": {
      "image": [ "1", 0 ],
      "model": "BiRefNet-general",
      "sensitivity": 0.94,
      "mask_blur": 0,
      "mask_offset": 0,
      "invert_output": false,
      "refine_foreground": true,
      "background": "Alpha",
      "background_color": "#222222"
    },
    "class_type": "BiRefNetRMBG",
    "_meta": { "title": "BiRefNet High Quality" }
  },
  "3": {
    "inputs": {
      "filename_prefix": "ComfyFloatBar/RemoveBG_HQ",
      "images": [ "11", 0 ]
    },
    "class_type": "SaveImage",
    "_meta": { "title": "Сохранить прозрачный PNG" }
  }
};

module.exports = { STUB_WORKFLOW, BIREFNET_WORKFLOW, BIREFNET_HQ_WORKFLOW, KREA2_WORKFLOW, TURBO_WORKFLOW, KREA2_IMG2IMG_WORKFLOW, TURBO_IMG2IMG_WORKFLOW, VECTORIZER_WORKFLOW, SEEDVR2_UPSCALE_WORKFLOW, THREE_VARIATIONS_WORKFLOW, TRIPTYCH_TO_THREE_WORKFLOW };
