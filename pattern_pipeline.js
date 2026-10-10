'use strict';

const fs = require('fs');
const path = require('path');
const workflows = require('./workflows');
const krea2 = require('./krea2_config');
const loras = require('./krea2_loras');
const PROMPT_REVISION = 3;
const REVIEW_CHECKS = ['isolated', 'style', 'pose', 'colors', 'anatomy'];

const ANALYSIS_SCHEMA = {
    type:'object', required:['style', 'background', 'elements'], properties:{
        style:{type:'string', description:'One shared English rendering specification: medium, contour weight, shading, texture and proportions. No subjects, object colors, layout or matte color.'},
        background:{type:'object', required:['name', 'prompt', 'repairs'], properties:{
            name:{type:'string'}, prompt:{type:'string'}, repairs:{type:'array', items:{type:'string'}}
        }},
        elements:{type:'array', items:{type:'object', required:['name', 'prompt', 'matte', 'repairs', 'source_hint', 'identity'], properties:{
            name:{type:'string'}, prompt:{type:'string'}, matte:{type:'string', enum:['white', 'black']},
            repairs:{type:'array', items:{type:'string'}},
            source_hint:{type:'string', description:'Which intact representative in the original image this asset matches. For visual verification only, never a generation instruction.'},
            identity:{type:'object', required:['subject', 'pose', 'view', 'colors', 'markings'], properties:{
                subject:{type:'string'}, pose:{type:'string'}, view:{type:'string'}, colors:{type:'string'}, markings:{type:'string'}
            }}
        }}}
    }
};

function analysisPrompt(userPrompt = '') {
    return `You are a visual art director writing natural-language Krea 2 text-to-image prompts for separated print assets. The input image is a reference sheet, NOT the composition that the output assets should reproduce.
Inventory ALL visually distinct motif types, including small decorative fillers. Repeated copies of the same motif are ONE asset; genuinely different species, poses, shapes or color variants are separate assets. Translation, rotation, mirroring, clipping at the boundary and minor AI-induced inconsistencies of an otherwise identical motif do not create extra variants. Inspect complete repeated occurrences to recover the intended design. Do not invent unrelated motifs. Reconstruct motifs crossing the tile boundary as complete objects. Do not stop after a sample or a fixed number of elements.
The reference contains AI generation defects. Do NOT merely caption or faithfully copy those defects. For EACH motif identify malformed anatomy, impossible geometry, fused parts, missing/extra limbs, broken symmetry, garbled details, jagged contours and accidental overlaps. Specify the corrected, complete, plausible version in the English generation prompt, while retaining the intended identity, illustration medium, linework, palette and recognizable design. Repairs must describe concrete changes, not generic quality slogans. Preserve intentional artistic stylization.
CRITICAL SEPARATION RULES:
1. style is ONE shared rendering specification for the entire set, 40–70 English words: medium, precise contour weight/color, flatness or depth, shading, surface texture, proportions and degree of simplification. It describes ONLY how things are rendered. It must NOT mention any subjects, arrangements, dense coverage, repetition, tiling, a scene, object colors or the extraction backdrop. Every asset will receive this EXACT SAME style text automatically. Do not put a different medium, line weight, lighting, shading or art style into an individual element prompt. Preserve the reference's actual style; a photographic object stays photographic, a flat cartoon stays flat with its original contour weight and proportions. Do not add glossy highlights, 3D volume, realism or cast shadows to flat art.
2. Each element has an identity contract, based on one intact representative identified by source_hint. subject: exact subject and recognizable design, without inventing age or breed. pose: physical posture and silhouette, including body axis, support/contact points, positions of limbs/petals/parts and tail/appendage curve. view: camera angle, facing direction, head turn and gaze/expression. colors: which precise muted/saturated color belongs to EACH visible body region; distinguish main surface/coat, face, chest, belly, extremities, tail, eye/nose details when applicable. markings: locations and shapes of patches, stripes or symbols, or an explicit plain finish when absent. These are English descriptions of the finished object, not edit commands. Never change a pose to make it easier to generate, infer stripes on a plain coat, replace dark gray by solid black, or swap the white and colored regions. Reconstruct faulty anatomy while preserving the intended pose, view, silhouette and markings. Do not turn all related subjects into one generic "cute" design. For a flower describe its petals and center, for an animal its body regions, for an object its component geometry; use the actual input's subjects.
3. Each element prompt describes exactly ONE standalone complete specimen and its repaired physical details, consistent with identity. Do not add a stem or leaves unless they are part of that asset. Keep natural asymmetry and volume; regular mechanical symmetry is not a repair. Name meaningful visual details instead of just "vibrant" or "crisp". The fully visible specimen occupies about two-thirds of the image, centered with generous empty space on all sides. Choose BLACK matte for light edges, WHITE for dark edges; use the highest contrast for mixed edges. Put the chosen uniform studio backdrop in the prompt.
4. Background means the bare underlying color/material visible BETWEEN the objects. Describe only its colors, subtle gradients, grain and surface finish. Foliage, leaves, stems, blossoms and silhouettes are foreground assets, not the substrate. Dense coverage by objects does not turn them into a background. If only tiny gaps are visible, infer the simplest substrate supported by those gaps; do not invent a garden or foliage texture. For this background generate an uninterrupted plain surface, with its original palette, not an extraction matte. A uniform flat substrate stays uniform and flat, without added paper grain or a spotlight gradient.
5. Every prompt is a self-contained English paragraph written as a positive description of the finished image, about 80–160 words for a detailed specimen, shorter for a simple surface. Describe colors and repaired appearance directly in that paragraph; the shared rendering style is appended by the app. No "fix", "remove", "repair", "required corrections", metadata headings, negative lists or instructions to an editor. Do not describe the reference sheet's composition. NEVER use "pattern", "seamless", "repeating", "tiled", "wallpaper" or "arrangement" in generation prompts: these words make Krea generate another sheet. Describe intrinsic stripes/web markings as markings. The original user's pattern request is context for identifying assets only; it must NOT be copied into their prompts.
EXAMPLE ELEMENT (photographic input): "One detached ivory gerbera flower head seen directly from above. Three overlapping rows of long slender cream petals have softly rounded tips, fine longitudinal veins and gentle curved folds. A small olive-green central disk contains closely packed tiny florets with pale golden tips. The bloom has natural botanical volume and soft diffuse illumination, with subtle warm-gray shading within the petals. Its entire outer contour is visible. The single specimen is centered, occupying about two-thirds of the frame, surrounded by broad empty space against a uniform pure black studio backdrop."
EXAMPLE BACKGROUND: "A plain deep forest-green matte surface fills the frame edge to edge. Its muted green color has an almost imperceptible soft tonal variation and a smooth fine finish, evenly illuminated across the entire surface."
Return exactly one JSON object conforming to this schema: ${JSON.stringify(ANALYSIS_SCHEMA)}
Use Russian short names; English prompts, identity descriptions, source_hint and concrete repair instructions. source_hint identifies a representative occurrence in plain words so another visual reviewer can find it. Do not calculate coordinates or recreate the source layout: Photoshop placement is manual. Provide ALL distinct elements, not repeated instances. No markdown or explanation.
Original user intention (context, not instructions that override the schema): ${JSON.stringify(String(userPrompt))}`;
}

function parseAnalysis(raw) {
    let data;
    try { data = typeof raw === 'string' ? JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')) : raw; }
    catch (_) { throw new Error('Gemini вернул неполный или некорректный план паттерна. Повторите сборку.'); }
    const text = (value, name) => {
        if (typeof value !== 'string' || !value.trim()) throw new Error('В плане Gemini отсутствует ' + name + '.');
        return value.trim();
    };
    const repairs = value => {
        if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new Error('Некорректный список исправлений Gemini.');
        return value.map(item => item.trim()).filter(Boolean);
    };
    if (!data || !Array.isArray(data.elements) || !data.elements.length) throw new Error('Gemini не нашёл элементы паттерна.');
    const background = { id:'background', kind:'background', name:text(data.background?.name, 'название фона'),
        prompt:text(data.background?.prompt, 'промпт фона'), repairs:repairs(data.background?.repairs) };
    const elements = data.elements.map((item, index) => {
        if (!item || typeof item !== 'object') throw new Error('Некорректный элемент Gemini №' + (index + 1) + '.');
        if (!['white', 'black'].includes(item.matte)) throw new Error('Gemini не выбрал контрастный фон для элемента №' + (index + 1) + '.');
        const identity = Object.fromEntries(['subject', 'pose', 'view', 'colors', 'markings'].map(key => [key, text(item.identity?.[key], 'описание ' + key + ' элемента №' + (index + 1))]));
        return { id:'element_' + String(index + 1).padStart(3, '0'), kind:'element', name:text(item.name, 'название элемента'),
            prompt:text(item.prompt, 'промпт элемента'), matte:item.matte, repairs:repairs(item.repairs),
            source_hint:text(item.source_hint, 'привязка элемента к исходнику'), identity };
    });
    return { style:text(data.style, 'описание стиля'), background, elements };
}

function createAnalysisWorkflow(image, settings, attempt = 0, feedback = '') {
    return {
        source:{ class_type:'LoadImage', inputs:{image} },
        analyze:{ class_type:'IFGeminiNode', inputs:{
            images:['source',0], prompt:analysisPrompt(settings.userPrompt) + (feedback ? '\nYour previous response violated asset separation: ' + feedback + '\nRewrite the entire JSON, correcting these issues.' : ''), operation_mode:'generate_text',
            model_name:settings.geminiModel, api_provider:'gemini', external_api_key:settings.apiKey,
            temperature:0.2, structured_output:true, chat_mode:false, max_output_tokens:32768,
            seed:(Number(settings.seed) + attempt) % 4294967295, api_call_delay:0
        }},
        plan:{ class_type:'PreviewAny', inputs:{source:['analyze',0]} }
    };
}

function createPlanReviewWorkflow(image, analysis, settings, attempt = 0, feedback = '') {
    const graph = createAnalysisWorkflow(image, settings, attempt, feedback);
    graph.analyze._meta = {title:'Сверка стиля, поз и цветов с исходником', cfbPlanReview:true};
    graph.analyze.inputs.prompt += `\nNow act as an independent visual auditor. The following is a DRAFT inventory, not ground truth: ${JSON.stringify(analysis)}.
Compare EVERY proposed identity and prompt directly against the supplied source image before generation. Return a corrected COMPLETE JSON inventory in the same schema. Deduplicate identical repeated occurrences and minor generation inconsistencies; include every genuinely distinct intended motif. Use intact occurrences to resolve cropped or malformed copies. Verify that subject, physical pose, facing/view, exact color regions and markings really occur in the source. Replace invented poses, colors, facial expressions or markings with what is visible. Do not simply approve or paraphrase a generic caption. Make one precise common style specification and keep individual prompts compatible with it. A style or pose change is not an anatomy repair. Correct the background to the bare original substrate. No coordinates or placement instructions. ${feedback ? 'Previous audit needs correction: ' + feedback : ''}`;
    return graph;
}

function describesSheet(value) {
    const composition = String(value || '').replace(/\b(?:web|wing|feather|fur|scale|fabric|skin)[ -]+pattern(?:ed|ing|s)?\b/gi, 'markings');
    return /\b(?:pattern|seamless|repeating|repeat(?:ed)?|tiled|tileable|wallpaper|arrangement)\b/i.test(composition);
}

function correctedPrompt(asset, style) {
    const description = asset.prompt.replace(/\s+/g, ' ').trim();
    if (asset.kind === 'background') return description + ' A single uninterrupted bare surface fills the entire frame edge to edge, with an even finish.';
    // The common text is limited to rendering; subject colors remain local to each identity.
    const sentence = value => {const result = String(value || '').replace(/\s+/g, ' ').trim(); return result && !/[.!?]$/.test(result) ? result + '.' : result;};
    const sharedStyle = !describesSheet(style) ? sentence(style) : '';
    const identity = asset.identity ? ['subject', 'pose', 'view', 'colors', 'markings'].map(key => sentence(asset.identity[key])).join(' ') : '';
    return [sharedStyle, identity, description, `One standalone specimen is completely visible, centered with generous empty space on all sides. The surrounding backdrop is uniform pure ${asset.matte}.`].filter(Boolean).join(' ');
}

function validateAssetPrompts(analysis) {
    if (describesSheet(analysis.style)) throw new Error('Общий стиль Gemini описывает композицию вместо техники рисования.');
    for (const asset of [analysis.background, ...analysis.elements]) {
        // Markings on one specimen (e.g. Spider-Man's web-pattern suit) are not a repeated sheet.
        if (describesSheet(asset.prompt) || (asset.identity && Object.values(asset.identity).some(describesSheet))) {
            throw new Error('Промпт «' + asset.name + '» описывает паттерн вместо отдельного изображения.');
        }
        if (asset.kind === 'background' && /\b(?:flowers?|floral|gerbera|dais(?:y|ies)|petals?|foliage|leaves|stems?|butterfl(?:y|ies)|bouquet|garden)\b/i.test(asset.prompt)) {
            throw new Error('Промпт фона содержит предметы вместо чистой подложки.');
        }
    }
    return analysis;
}

function createReviewWorkflow(reference, images, assets, settings, attempt = 0, style = '') {
    const graph = createAnalysisWorkflow(reference, settings, attempt);
    let batch = ['source', 0];
    images.forEach((image, index) => {
        graph['asset_' + index] = {class_type:'LoadImage', inputs:{image}};
        graph['batch_' + index] = {class_type:'ImageBatch', inputs:{image1:batch, image2:['asset_' + index, 0]}};
        batch = ['batch_' + index, 0];
    });
    graph.analyze.inputs.images = batch;
    graph.analyze.inputs.max_images = images.length + 1;
    graph.analyze._meta = {title:'Проверка отдельных элементов', cfbReviewAssets:assets.map(asset => asset.id)};
    graph.analyze.inputs.prompt = `Inspect the supplied images before these print assets are cut out. The FIRST image is the original reference sheet; it may contain many repeated objects. Each subsequent image is a GENERATED ASSET, in this order: ${JSON.stringify(assets.map(asset => ({id:asset.id, kind:asset.kind, name:asset.name, prompt:asset.prompt, matte:asset.matte, source_hint:asset.source_hint, identity:asset.identity})))}.
Shared rendering specification for ALL elements: ${JSON.stringify(style)}. The reference image is ground truth. Match each named motif to its intact occurrence using source_hint, not to an arbitrary similar subject. Check all five conditions independently: isolated (one complete specimen, empty margins and correct matte, or a completely bare background); style (same medium, contour weight, shading, texture and proportions as source); pose (same posture/silhouette, body axis, limb/appendage positions, tail curve, camera angle and facing, rather than a generic alternative pose); colors (same main colors and their placement on individual regions, patches/stripes/symbols); anatomy (plausible complete structure with generation defects corrected). For a background check its original substrate color/finish and isolation, and set pose/anatomy true. Reject style drift, invented stripes, swapped color patches, missing pale regions, mirrored/facing changes or an easier but different pose, even if the image is otherwise a beautiful clean standalone subject. Minor texture variation is acceptable; changing subject identity is not.
Judge generated images individually, not the first reference. For a BACKGROUND, valid means a bare color/material surface with ZERO foreground motifs, flowers, leaves, silhouettes or ornaments. It may have subtle natural grain/tonal variation only if supported by the original. For an ELEMENT, valid means EXACTLY ONE complete standalone specimen matching the named subject, with a uniform chosen white/black backdrop and empty margins. A central flower plus other flowers at the edges is INVALID, even when the central flower is complete. A repeating sheet, bouquet, duplicated specimen or cropped outer contour is INVALID. Petals within ONE flower are not multiple specimens; intentional markings inside a butterfly's wing are not extra motifs.
Return exactly JSON {"results":[{"id":"asset id", "valid":true, "checks":{"isolated":true,"style":true,"pose":true,"colors":true,"anatomy":true}, "reason":"specific Russian comparison with the source", "replacement_prompt":""}]}, one entry for EVERY supplied generated asset. valid is true ONLY if ALL five checks pass. If ANY check fails, provide a corrected self-contained English Krea 2 prompt describing the intended finished asset positively, preserving its identity contract and common style. Explain the actual visible mismatch; do not merely say that the prompt's subject was generated. Do NOT use the words pattern, seamless, repeating, tiled, wallpaper, arrangement in replacement prompts, even in a negation. Do not put edit instructions, another art style or repair lists in the prompt. For a background do not name foreground subjects even in negative clauses. Never substitute a new scene, pose, palette or composition.`;
    return graph;
}

function parseReview(raw, assets) {
    let data;
    try {data = JSON.parse(String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));}
    catch (_) {throw new Error('Gemini не вернул корректную проверку отдельных изображений.');}
    if (!Array.isArray(data.results) || data.results.length !== assets.length) throw new Error('Gemini проверил не все созданные изображения.');
    const result = assets.map(asset => {
        const matches = data.results.filter(item => item?.id === asset.id);
        if (matches.length !== 1 || typeof matches[0].valid !== 'boolean') throw new Error('Неоднозначная проверка изображения «' + asset.name + '».');
        const review = matches[0];
        if (REVIEW_CHECKS.some(key => typeof review.checks?.[key] !== 'boolean')) throw new Error('Gemini не сверил стиль, позу и цвета «' + asset.name + '».');
        review.valid = review.valid && REVIEW_CHECKS.every(key => review.checks[key]);
        if (!review.valid && (typeof review.replacement_prompt !== 'string' || !review.replacement_prompt.trim())) throw new Error('Gemini не предложил исправленный промпт для «' + asset.name + '».');
        return review;
    });
    return result;
}

function createGenerationWorkflow(asset, settings, style, index) {
    const prompt = correctedPrompt(asset, style);
    const selected = loras.find(settings.lora?.id);
    // A simple graph avoids executing the original pattern's prompt enhancer / repeat branches.
    const graph = {
        model:{class_type:'UNETLoader', inputs:{unet_name:krea2.MODELS[krea2.normalizeVariant(settings.kreaVariant)], weight_dtype:'default'}},
        clip:{class_type:'CLIPLoader', inputs:{clip_name:'qwen3vl_4b_fp8_scaled.safetensors', type:'krea2', device:'default'}},
        vae:{class_type:'VAELoader', inputs:{vae_name:'qwen_image_vae.safetensors'}},
        positive:{class_type:'CLIPTextEncode', inputs:{clip:['clip',0], text:settings.lora?.enabled && selected.trigger ? prompt + ', ' + selected.trigger : prompt}},
        negative:{class_type:'ConditioningZeroOut', inputs:{conditioning:['positive',0]}},
        latent:{class_type:'EmptyLatentImage', inputs:{width:1024, height:1024, batch_size:1}},
        sampler:{class_type:'KSampler', inputs:{model:['model',0], positive:['positive',0], negative:['negative',0], latent_image:['latent',0],
            seed:(Number(settings.seed) + index + 1) % Number.MAX_SAFE_INTEGER, steps:8, cfg:1, sampler_name:'euler', scheduler:'simple', denoise:1}},
        decode:{class_type:'VAEDecode', inputs:{samples:['sampler',0], vae:['vae',0]}},
        save:{class_type:'SaveImage', inputs:{images:['decode',0], filename_prefix:'ComfyFloatBar/Patterns/' + asset.id}}
    };
    loras.configure(graph, settings.lora);
    return graph;
}

function createCutoutWorkflow(image, asset) {
    const graph = structuredClone(workflows.BIREFNET_HQ_WORKFLOW);
    graph['1'].inputs.image = image;
    graph['11'].inputs.model = 'BiRefNet_toonout';
    graph['3'].inputs.filename_prefix = 'ComfyFloatBar/Patterns/' + asset.id + '_alpha';
    return graph;
}

function createUpscaleWorkflow(image, asset, seed) {
    const graph = structuredClone(workflows.SEEDVR2_UPSCALE_WORKFLOW);
    delete graph['65'];
    graph['1'].inputs.image = image;
    graph['66:57'].inputs['resize_type.multiplier'] = 4;
    graph['66:54'].inputs.seed = seed;
    // This native postprocessor restores source alpha after RGB generation.
    graph['66:59'].inputs.color_correction_method = 'lab';
    graph['9'].inputs.filename_prefix = 'ComfyFloatBar/Patterns/' + asset.id + '_x4';
    return graph;
}

function pngSize(buffer) {
    if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
    if (buffer.length < 33 || buffer.subarray(0,8).toString('hex') !== '89504e470d0a1a0a' || buffer.toString('ascii',12,16) !== 'IHDR') throw new Error('ComfyUI вернул некорректный PNG.');
    const width = buffer.readUInt32BE(16), height = buffer.readUInt32BE(20);
    if (!width || !height) throw new Error('ComfyUI вернул пустое изображение.');
    return {width, height};
}

function checkCancelled(signal) {
    if (signal?.aborted) { const error = new Error('Сборка паттерна отменена. Готовые файлы сохранены.'); error.name = 'AbortError'; throw error; }
}

async function run(options, dependencies) {
    const io = dependencies.fs || fs;
    const {signal} = options;
    let manifestPath = options.manifestPath || path.join(options.directory, 'pattern.json');
    let manifest;
    if (options.manifestPath) {
        manifest = JSON.parse(io.readFileSync(manifestPath, 'utf8'));
        if (manifest.version !== 1 || !manifest.referencePath || !manifest.settings || !Array.isArray(manifest.assets)) throw new Error('Не удалось прочитать сохранённую сборку паттерна.');
        if (manifest.promptRevision !== PROMPT_REVISION) {
            // Preserve the old assets. Reusing their files would silently keep the bad sheet prompts.
            const repairedDirectory = path.join(path.dirname(path.dirname(manifestPath)), path.basename(path.dirname(manifestPath)) + '_prompts_v' + PROMPT_REVISION);
            manifestPath = path.join(repairedDirectory, 'pattern.json');
            manifest = io.existsSync(manifestPath) ? JSON.parse(io.readFileSync(manifestPath, 'utf8')) :
                {version:1, promptRevision:PROMPT_REVISION, referencePath:manifest.referencePath, settings:manifest.settings,
                    state:'running', stage:'analysis', assets:[], createdAt:new Date().toISOString()};
        }
    } else {
        const {apiKey, ...safeSettings} = options.settings;
        manifest = {version:1, promptRevision:PROMPT_REVISION, referencePath:options.referencePath, settings:safeSettings, state:'running', stage:'analysis', assets:[], createdAt:new Date().toISOString()};
    }
    if (manifest.analysis) manifest.analysis = parseAnalysis(manifest.analysis);
    const directory = path.dirname(manifestPath);
    io.mkdirSync(directory, {recursive:true});
    const checkpoint = () => {
        io.writeFileSync(manifestPath + '.tmp', JSON.stringify(manifest, null, 2), 'utf8');
        io.renameSync(manifestPath + '.tmp', manifestPath);
        dependencies.onCheckpoint?.(manifestPath, manifest);
    };
    const progress = message => { checkCancelled(signal); dependencies.onProgress?.(message); };
    const imageJob = async graph => {
        checkCancelled(signal);
        const downloaded = await dependencies.executeImage(graph);
        checkCancelled(signal);
        const result = Buffer.from(downloaded);
        pngSize(result);
        return result;
    };
    const read = filename => io.readFileSync(filename);
    const present = filename => Boolean(filename && io.existsSync(filename));
    const settings = {...manifest.settings, apiKey:options.settings.apiKey};
    checkpoint();
    try {
        checkCancelled(signal);
        if (!present(manifest.referencePath)) throw new Error('Исходный паттерн не найден: ' + manifest.referencePath);
        if (!manifest.analysis) {
            progress('Gemini: поиск уникальных элементов и исправление дефектов…');
            const uploaded = await dependencies.upload(manifest.referencePath);
            let feedback = '';
            for (let attempt = 0; attempt < 3; attempt++) {
                checkCancelled(signal);
                const raw = await dependencies.executeText(createAnalysisWorkflow(uploaded, settings, attempt, feedback));
                checkCancelled(signal);
                if (/503|429|UNAVAILABLE|RESOURCE_EXHAUSTED|high demand/i.test(raw) && attempt < 2) {
                    progress('Gemini временно занят. Повтор анализа…');
                    await (dependencies.delay || (ms => new Promise(resolve => setTimeout(resolve, ms))))(2000 * (attempt + 1));
                    continue;
                }
                try {
                    manifest.analysis = validateAssetPrompts(parseAnalysis(raw));
                } catch (error) {
                    if (attempt >= 2) throw error;
                    feedback = error.message;
                    progress('Gemini: уточнение промптов отдельных элементов и чистого фона…');
                    continue;
                }
                break;
            }
            checkpoint();
        }
        if (manifest.planReviewedPromptRevision !== PROMPT_REVISION) {
            manifest.stage = 'plan_review'; checkpoint();
            progress('Gemini: сверка общего стиля, поз и цветов с исходником…');
            const reference = await dependencies.upload(manifest.referencePath);
            let feedback = '';
            for (let attempt = 0; attempt < 3; attempt++) {
                checkCancelled(signal);
                const raw = await dependencies.executeText(createPlanReviewWorkflow(reference, manifest.analysis, settings, attempt, feedback));
                checkCancelled(signal);
                if (/503|429|UNAVAILABLE|RESOURCE_EXHAUSTED|high demand/i.test(raw) && attempt < 2) {
                    progress('Gemini временно занят. Повтор сверки промптов…');
                    await (dependencies.delay || (ms => new Promise(resolve => setTimeout(resolve, ms))))(2000 * (attempt + 1));
                    continue;
                }
                try {manifest.analysis = validateAssetPrompts(parseAnalysis(raw));}
                catch (error) {if (attempt >= 2) throw error; feedback = error.message; continue;}
                break;
            }
            manifest.planReviewedPromptRevision = PROMPT_REVISION;
            manifest.assets = [manifest.analysis.background, ...manifest.analysis.elements].map(asset => ({...asset}));
            checkpoint();
        }
        manifest.state = 'running'; manifest.stage = 'generation'; checkpoint();
        for (let index = 0; index < manifest.assets.length; index++) {
            const asset = manifest.assets[index];
            progress(`Создание ${index+1}/${manifest.assets.length}: ${asset.name}…`);
            if (present(asset.generatedPath)) continue;
            const buffer = await imageJob(createGenerationWorkflow(asset, settings, manifest.analysis.style, index));
            asset.generatedPath = path.join(directory, asset.id + '_generated.png');
            io.writeFileSync(asset.generatedPath, buffer); checkpoint();
        }
        manifest.stage = 'review'; checkpoint();
        const reference = await dependencies.upload(manifest.referencePath);
        while (manifest.assets.some(asset => asset.reviewedPromptRevision !== PROMPT_REVISION)) {
            const batch = manifest.assets.filter(asset => asset.reviewedPromptRevision !== PROMPT_REVISION).slice(0, 4);
            progress('Gemini: проверка элементов, стиля, поз и цветов…');
            const images = [];
            for (const asset of batch) {checkCancelled(signal); images.push(await dependencies.upload(asset.generatedPath));}
            let raw;
            for (let attempt = 0; attempt < 3; attempt++) {
                checkCancelled(signal);
                raw = await dependencies.executeText(createReviewWorkflow(reference, images, batch, settings, attempt, manifest.analysis.style));
                checkCancelled(signal);
                if (!/503|429|UNAVAILABLE|RESOURCE_EXHAUSTED|high demand/i.test(raw) || attempt === 2) break;
                progress('Gemini временно занят. Повтор проверки изображений…');
                await (dependencies.delay || (ms => new Promise(resolve => setTimeout(resolve, ms))))(2000*(attempt+1));
            }
            const reviews = parseReview(raw, batch);
            for (let index = 0; index < batch.length; index++) {
                const asset = batch[index], review = reviews[index];
                asset.reviewReason = String(review.reason || '');
                asset.reviewChecks = review.checks;
                if (review.valid) {asset.reviewedPromptRevision = PROMPT_REVISION; checkpoint(); continue;}
                if (asset.generationRetries >= 2) throw new Error('Krea после повторов не сохранила стиль, позу, цвета или форму «' + asset.name + '». Неверный результат сохранён отдельно; вырезание и апскейл не запущены.');
                const corrected = {...asset, prompt:review.replacement_prompt.trim()};
                validateAssetPrompts({background:asset.kind === 'background' ? corrected : manifest.analysis.background,
                    elements:asset.kind === 'element' ? [corrected] : []});
                asset.previousGenerations = [...(asset.previousGenerations || []), {path:asset.generatedPath, prompt:asset.prompt, reason:asset.reviewReason}];
                asset.prompt = corrected.prompt;
                // The attempt gets a new seed and file, leaving the rejected image available for inspection.
                progress('Повторное создание с сохранением стиля, позы и цвета: ' + asset.name + '…');
                const assetIndex = manifest.assets.indexOf(asset);
                const retry = (asset.generationRetries || 0) + 1;
                const buffer = await imageJob(createGenerationWorkflow(asset, settings, manifest.analysis.style, assetIndex + 1000 * retry));
                asset.generationRetries = retry;
                asset.generatedPath = path.join(directory, asset.id + '_generated_retry_' + retry + '.png');
                io.writeFileSync(asset.generatedPath, buffer); checkpoint();
            }
        }
        manifest.stage = 'cutout'; checkpoint();
        const elements = manifest.assets.filter(asset => asset.kind === 'element');
        for (let index = 0; index < elements.length; index++) {
            const asset = elements[index];
            progress(`Прозрачный PNG ${index+1}/${elements.length}: ${asset.name}…`);
            if (present(asset.cutoutPath)) continue;
            const uploaded = await dependencies.upload(asset.generatedPath); checkCancelled(signal);
            const buffer = await imageJob(createCutoutWorkflow(uploaded, asset));
            await dependencies.verifyTransparent(buffer); checkCancelled(signal);
            asset.cutoutPath = path.join(directory, asset.id + '_alpha.png');
            io.writeFileSync(asset.cutoutPath, buffer); checkpoint();
        }
        manifest.stage = 'upscale'; checkpoint();
        for (let index = 0; index < manifest.assets.length; index++) {
            const asset = manifest.assets[index];
            progress(`SeedVR2 ×4 ${index+1}/${manifest.assets.length}: ${asset.name}…`);
            if (present(asset.upscaledPath)) continue;
            const inputPath = asset.kind === 'element' ? asset.cutoutPath : asset.generatedPath;
            const inputSize = pngSize(read(inputPath));
            const uploaded = await dependencies.upload(inputPath); checkCancelled(signal);
            const buffer = await imageJob(createUpscaleWorkflow(uploaded, asset, (Number(settings.seed)+index)%Number.MAX_SAFE_INTEGER));
            const outputSize = pngSize(buffer);
            if (outputSize.width !== inputSize.width * 4 || outputSize.height !== inputSize.height * 4) throw new Error('SeedVR2 вернул неверный размер ×4 для «' + asset.name + '».');
            if (asset.kind === 'element') await dependencies.verifyTransparent(buffer);
            checkCancelled(signal);
            asset.upscaledPath = path.join(directory, asset.id + '_x4.png');
            io.writeFileSync(asset.upscaledPath, buffer); checkpoint();
        }
        manifest.stage = 'photoshop'; checkpoint();
        progress('Размещение элементов, фона и исходного паттерна в Photoshop…');
        await dependencies.placeInPhotoshop(manifest);
        manifest.state = 'complete'; manifest.stage = 'complete'; delete manifest.error; checkpoint();
        return {manifest, manifestPath};
    } catch (error) {
        manifest.state = signal?.aborted ? 'cancelled' : 'failed';
        manifest.error = signal?.aborted ? 'Сборка отменена' : String(error.message || error);
        checkpoint();
        if (signal?.aborted) checkCancelled(signal);
        throw error;
    }
}

module.exports = {PROMPT_REVISION, REVIEW_CHECKS, ANALYSIS_SCHEMA, analysisPrompt, parseAnalysis, createAnalysisWorkflow, createPlanReviewWorkflow, correctedPrompt, validateAssetPrompts, createReviewWorkflow, parseReview,
    createGenerationWorkflow, createCutoutWorkflow, createUpscaleWorkflow, pngSize, checkCancelled, run};
