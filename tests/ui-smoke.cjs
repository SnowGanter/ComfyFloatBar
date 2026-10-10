// Real Chromium DOM, with Photoshop, filesystem writes and ComfyUI isolated.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-ui-test-'));
app.setPath('userData', path.join(temporary, 'profile'));
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, width: 300, height: 1000,
        webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false, backgroundThrottling: false, offscreen: true } });
    win.webContents.on('console-message', event => { if (event.level === 'error') console.error(event.message); });
    try {
        const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace('<script src="renderer.js"></script>', '');
        const file = path.join(temporary, 'index.html'); fs.writeFileSync(file, html);
        await win.loadFile(file);
        await win.webContents.executeJavaScript(`
            window.__errors = []; window.addEventListener('error', e => __errors.push(e.message));
            window.addEventListener('unhandledrejection', e => __errors.push(String(e.reason)));
            window.__graphs = []; window.__events = []; window.__placed = [];
            window.__photoshopAvailable = true;
            const actualRequire = require;
            const root = ${JSON.stringify(root)};
            const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 64;
            const ctx = canvas.getContext('2d'); ctx.fillStyle = '#a08060'; ctx.fillRect(0, 0, 32, 64);
            window.__png = Buffer.from(canvas.toDataURL('image/png').split(',')[1], 'base64');
            window.__files = new Map(); window.__patternMode = false;
            const upscaleCanvas = document.createElement('canvas'); upscaleCanvas.width=256; upscaleCanvas.height=256;
            upscaleCanvas.getContext('2d').fillRect(0,0,128,256);
            window.__upscaledPng = Buffer.from(upscaleCanvas.toDataURL('image/png').split(',')[1],'base64');
            window.__mockFs = { readdirSync: () => [], existsSync: name => __files.has(name), mkdirSync: () => {},
                readFileSync: (name, encoding) => __files.has(name) ? (encoding ? __files.get(name).toString() : __files.get(name)) : (encoding ? '0,0,64,64' : __png),
                writeFileSync: (name, data) => __files.set(name,Buffer.from(data)), renameSync: (from,to) => {__files.set(to,__files.get(from));__files.delete(from);},
                unlinkSync: name => __files.delete(name), statSync: () => ({ size: 1000 }) };
            window.__ps = { getActiveDocumentInfo: async () => ({ width: 2000, height: 1000, name: 'test', documentId: 1 }),
                exportDocument: async () => 'test.png', getActiveDocumentName: async () => 'test',
                exportSelection: async () => ({ filePath: 'test.png', coordsPath: 'coords.txt' }),
                exportActiveLayerVisible: async maxMegapixels => ({ filePath:'test.png', originalWidth:2400, originalHeight:1200, width:2000, height:1000, x:0, y:0, maxMegapixels }),
                createLayerGroup: async () => 2,
                exportDocumentTile: async (x,y,w,h,i) => { __events.push('export'); return { filePath: 'tile'+i+'.png', coordsPath: 'tile'+i+'.txt' }; },
                placeImage: async (...args) => { __events.push('place'); __placed.push(args); },
                placeSvg: async (...args) => { __events.push('place-svg'); __placed.push(args); },
                openImageDocument: async (...args) => { __events.push('open-document'); __placed.push(args); },
                placePatternAssets: async manifest => { __events.push('place-pattern'); __placed.push(manifest); },
                openGeneratedMockupAndPlaceDesign: async (...args) => { __placed.push(args); return 'mockup.png'; }
            };
            window.__comfy = { uploadImage: async () => 'uploaded.png',
                sendPrompt: async (ip, wf) => { __events.push('send'); __graphs.push(wf); return 'test'; },
                pollHistory: async () => ({ filename: 'result.png' }),
                pollHistoryText: async () => __patternMode && __graphs.at(-1).analyze?._meta?.cfbReviewAssets ? JSON.stringify({results:__graphs.at(-1).analyze._meta.cfbReviewAssets.map(id=>({id,valid:true,checks:{isolated:true,style:true,pose:true,colors:true,anatomy:true},reason:'One clean asset',replacement_prompt:''}))}) : __patternMode ? JSON.stringify({style:'Flat drawing with thin dark contours and smooth solid fills.',background:{name:'Paper',prompt:'Sand colored paper.',repairs:[]},
                    elements:[{name:'Flower',prompt:'One complete flower.',matte:'white',repairs:['Correct its petals.'],source_hint:'Flower at the upper left.',identity:{subject:'One flower',pose:'Its petals spread around the center',view:'Seen from above',colors:'Ivory petals and a golden center',markings:'Plain petals'}},
                        {name:'Butterfly',prompt:'One symmetric butterfly.',matte:'black',repairs:['Restore both wings.'],source_hint:'Butterfly at the lower right.',identity:{subject:'One butterfly',pose:'Two pairs of wings spread around the body',view:'Seen from above',colors:'Cream wings with a dark body',markings:'Thin dark wing outlines'}}]}) : '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>',
                pollHistoryImages: async () => [{ filename: 'result.png' }, { filename: 'original.png' }], downloadImage: async () => __patternMode && __graphs.at(-1)?.['66:54'] ? __upscaledPng : __png,
                getMockupFolders: async () => [], freeMemory: async () => { __events.push('free'); return true; } };
            window.require = name => {
                if (name === 'electron') return { ipcRenderer: { on: () => {}, send: () => {}, invoke: async channel => channel === 'window:get-photoshop-state' ? { photoshopRunning:__photoshopAvailable } : 'test-output' } };
                if (name === 'fs') return __mockFs;
                if (name === './ps_bridge') return __ps;
                if (name === './comfy_bridge') return __comfy;
                if (name === 'socket.io-client') throw new Error('Isolated UI test');
                return actualRequire(name.startsWith('./') ? root + '/' + name.slice(2) : name);
            };
            window.setInterval = () => 0;
            window.fetch = async () => ({ ok: true, json: async () => ({}) });
            localStorage.clear(); localStorage.setItem('nickname', 'UI test');
        `);
        await win.webContents.executeJavaScript(fs.readFileSync(path.join(root, 'renderer.js'), 'utf8'));
        const result = await win.webContents.executeJavaScript(`(async () => {
            function check(value, message) { if (!value) { console.error(message); throw new Error(message); } }
            function change(id, value) { const field = document.getElementById(id); field.value = value; field.dispatchEvent(new Event('change', { bubbles: true })); }
            check(__errors.length === 0, 'Renderer errors: ' + __errors.join('; '));
            for (const model of ['gemini-3.8-flash', 'gemini-3.6-flash']) {
                change('geminiEnhancerModel', model);
                check(getGeminiEnhancerModel() === model, 'New Gemini choice is not replaced by Flash Lite');
                check(localStorage.getItem('geminiEnhancerModel') === model, 'New Gemini choice persists');
                const enhanced = applyGeminiEnhancerModel({
                    first:{class_type:'IFGeminiNode',inputs:{model_name:'gemini-3.1-flash-lite'}},
                    second:{class_type:'IFGeminiNode',inputs:{model_name:'gemini-3.5-flash-lite'}},
                    other:{class_type:'CLIPTextEncode',inputs:{text:'A landscape'}}
                });
                check(enhanced.first.inputs.model_name === model && enhanced.second.inputs.model_name === model, 'Selected Gemini reaches every enhancer node');
                check(enhanced.other.inputs.text === 'A landscape', 'Gemini settings do not change other nodes');
            }
            change('geminiEnhancerModel', 'gemini-3.1-flash-lite');
            topazPanel.render({ enabled:true, jobs:[{id:'ui-job',sourceName:'Original.png',state:'ready',message:'Ready',width:512,height:256}] });
            check(document.getElementById('set_upscale').contains(document.getElementById('topazSettings')), 'Topaz settings use existing settings drawer');
            check(document.getElementById('topazHistory').classList.contains('hidden'), 'Topaz history starts collapsed');
            const topazModel=document.querySelector('#topazSettings [name=model]'); topazModel.value='Redefine'; topazModel.dispatchEvent(new Event('change',{bubbles:true}));
            check(!document.querySelector('#topazSettings [data-model=redefine]').classList.contains('hidden'), 'Redefine sliders shown');
            check(document.querySelector('#topazSettings [data-model=core]').classList.contains('hidden'), 'Core settings hidden for Redefine');
            const resizeMode=document.querySelector('#topazSettings [name=resizeMode]'); resizeMode.value='width'; resizeMode.dispatchEvent(new Event('change',{bubbles:true}));
            const dimension=document.querySelector('#topazSettings [name=dimension]'); dimension.value='213';
            const unit=document.querySelector('#topazSettings [name=unit]'); unit.value='in'; unit.dispatchEvent(new Event('change',{bubbles:true}));
            check(Number(dimension.value) === 213 && unit.value === 'in', 'Manual 213-inch size accepted');
            topazPanel.render({enabled:true,jobs:[]});
            check(!document.getElementById('topazSettings').classList.contains('hidden'), 'Settings remain available before upload');
            const upscaleHeader=document.querySelector('.tool-header[data-target="sec_upscale"]');
            toggleSection(upscaleHeader); await Promise.resolve();
            check(upscaleHeader.classList.contains('is-open') && getComputedStyle(upscaleHeader).position==='sticky', 'Open tool header stays sticky');
            check(!document.getElementById('stickyActionRow').classList.contains('hidden'), 'Active action is fixed above status');
            check(document.getElementById('stickyActionBtn').textContent.includes('Загрузить в Topaz'), 'Topaz action selected for task mode');
            check(document.getElementById('btn_upscale').classList.contains('sticky-action-source') && getComputedStyle(document.getElementById('btn_upscale')).opacity==='0', 'Original primary action removed from content');
            const aiMode=document.querySelector('input[name="upscaleMode"][value="ai"]'); aiMode.checked=true; aiMode.dispatchEvent(new Event('change',{bubbles:true})); await Promise.resolve();
            check(document.getElementById('stickyActionBtn').textContent.includes('Upscale ×4'), 'Fixed action follows selected submode');

            check(document.getElementById('rmbgQwenSettings').classList.contains('hidden'), 'Initial BiRefNet controls');
            check(!document.getElementById('sec_generation_history'), 'Duplicate generation history is absent from main toolbar');
            change('vectorMode', 'stable');
            document.getElementById('vectorColors').value = '128';
            document.getElementById('vectorMaxMegapixels').value = '2.5';
            document.getElementById('vectorFilePrefix').value = 'custom_vector';
            await handleVectorize();
            check(__graphs.at(-1)?.['4']?.class_type === 'MyVectorizerStable', 'New vectorizer workflow submitted');
            check(__graphs.at(-1)['2'].class_type === 'JoinImageWithAlpha', 'Vectorizer preserves alpha');
            check(__graphs.at(-1)['3'].inputs.max_megapixels === 2.5, 'Vectorizer megapixel limit applied');
            check(__graphs.at(-1)['4'].inputs.mode === 'stable' && __graphs.at(-1)['4'].inputs.colors === 128, 'Vectorizer mode and palette applied');
            check(__graphs.at(-1)['4'].inputs.file_prefix === 'custom_vector', 'Vectorizer SVG prefix applied');
            change('rmbgModel', 'qwen21');
            check(document.getElementById('rmbgBiRefSettings').classList.contains('hidden'), 'Qwen hides BiRefNet controls');
            await handleSelectionProcess('rmbg');
            check(__graphs.at(-1)?.qwen_encode, 'Qwen removal submitted');
            document.getElementById('promptInput').value = 'A landscape';
            for (const model of ['qwen21', 'turbo', 'krea2']) {
                change('genModel', model);
                await handleComfyRequest(getGenerationRequestType());
                check(__graphs.at(-1), 'Generation submitted');
                check(Boolean(__graphs.at(-1).qwen_encode) === (model === 'qwen21'), 'Correct generation model ' + model);
            }
            __photoshopAvailable = false;
            const placedBeforeClosedGeneration = __placed.length;
            change('genModel', 'qwen21');
            await handleComfyRequest(getGenerationRequestType());
            check(__placed.length === placedBeforeClosedGeneration, 'Closed Photoshop does not block or receive generation');
            check(document.getElementById('statusBar').textContent.includes('Photoshop закрыт'), 'Closed Photoshop completion is reported');
            __photoshopAvailable = true;
            change('qwenPrecision', 'bf16');
            change('genModel', 'qwen21');
            document.getElementById('qwenStepsGenerate').value = '37';
            await handleComfyRequest(getGenerationRequestType());
            check(__graphs.at(-1).qwen_model.inputs.unet_name.includes('_bf16'), 'Global BF16 choice');
            check(__graphs.at(-1).qwen_sample.inputs.steps === 37, 'Generation steps');
            change('qwenPrecision', 'int8');
            for (const [choice, filename] of [['bf16', 'krea2_turbo_bf16.safetensors'], ['muse', 'museByStableYogi_v35Int8Extended.safetensors'], ['kreation', 'kreation_variant3_mxfp8.safetensors'], ['fp8', 'krea2_turbo_fp8_scaled.safetensors']]) {
                change('krea2Model', choice);
                change('genModel', 'krea2');
                await handleComfyRequest(getGenerationRequestType());
                const loader = Object.values(__graphs.at(-1)).find(node => node.class_type === 'UNETLoader');
                check(loader?.inputs?.unet_name === filename, 'Global Krea 2 choice ' + choice);
            }
            check(document.getElementById('krea2Lora').options.length === 32, 'All 32 LoRAs listed');
            document.getElementById('krea2LoraEnabled').checked = true;
            document.getElementById('krea2LoraEnabled').dispatchEvent(new Event('change',{bubbles:true}));
            change('krea2Lora', 'arcana'); document.getElementById('krea2LoraStrength').value = '.75';
            document.getElementById('krea2LoraStrength').dispatchEvent(new Event('input',{bubbles:true}));
            change('genModel', 'krea2'); await handleComfyRequest(getGenerationRequestType());
            check(__graphs.at(-1)['30:15'].inputs.lora_name === 'Arcana_Press_-_Krea2.safetensors', 'Krea 2 LoRA workflow');
            check(__graphs.at(-1)['30:15'].inputs.strength_model === .75, 'Krea 2 LoRA strength');
            check(__graphs.at(-1)['30:27'].inputs.string_b === 'arcanapress', 'Krea 2 trigger phrase');
            document.querySelector('#krea2LoraPreviews img').click();
            check(!document.getElementById('krea2PreviewOverlay').classList.contains('hidden'), 'LoRA preview opens enlarged');
            document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
            check(document.getElementById('krea2PreviewOverlay').classList.contains('hidden'), 'LoRA preview closes with Escape');
            document.getElementById('krea2LoraEnabled').checked = false;
            document.getElementById('krea2LoraEnabled').dispatchEvent(new Event('change',{bubbles:true}));
            document.getElementById('qwenDetailLoraEnabled').checked = true;
            document.getElementById('qwenDetailLoraEnabled').dispatchEvent(new Event('change',{bubbles:true}));
            document.getElementById('qwenDetailLoraStrength').value = '.75';
            document.getElementById('qwenDetailLoraStrength').dispatchEvent(new Event('input',{bubbles:true}));
            enhanceImageSlot.path = 'test.png';
            for (const model of ['flux', 'qwen21']) {
                change('enhanceModel', model);
                check(document.querySelector('[data-qwen-model=enhanceModel]').classList.contains('hidden') === (model === 'flux'), 'Steps visibility');
                await runImageEdit();
                check(Boolean(__graphs.at(-1).qwen_encode) === (model === 'qwen21'), 'Correct edit model ' + model);
                check(__graphs.at(-1).cfb_color_match, 'Color match in ' + model);
                if (model === 'qwen21') {
                    check(__graphs.at(-1).qwen_detail_lora.inputs.strength_model === .75, 'Qwen Detail Enhancer strength');
                    check(/^Enhance this image/i.test(__graphs.at(-1).qwen_encode.inputs.prompt), 'Qwen Detail Enhancer trigger');
                    check(!__graphs.at(-1).qwen_control_apply, 'Whole-image mode does not use ControlNet');
                }
            }
            check(!document.getElementById('expandModel'), 'Outpaint model selector removed');
            document.getElementById('expandLeft').value = '1600';
            document.getElementById('expandLeft').dispatchEvent(new Event('input',{bubbles:true}));
            check(document.getElementById('expandLeft').value === '1600', 'Margins above 400 are not clamped');
            updateQwenStepVisibility();
            check(!document.querySelector('[data-qwen-fixed=true]').classList.contains('hidden'), 'Outpaint Qwen steps always visible');
            document.getElementById('expandRight').value = '192';
            document.getElementById('expandTop').value = '64';
            document.getElementById('expandBottom').value = '96';
            await handleComfyRequest('expand');
            check(__graphs.at(-1).qwen_control_apply.class_type === 'ZImageFunControlnet', 'Outpaint uses native Union');
            check(__graphs.at(-1).qwen_encode.inputs['images.image_1'][0] === 'qwen_original', 'Outpaint reference has no blank padding');
            check(__placed.at(-1)[9] === 1, 'Outpaint goes to its original Photoshop document');
            check(__placed.at(-1)[11].left === 1600 && __placed.at(-1)[11].right === 192, 'Photoshop expands by captured margins');
            check(__placed.at(-1)[11].width === 2000 && __placed.at(-1)[11].height === 1000, 'Photoshop validates original canvas dimensions');
            const originalPlace = __ps.placeImage;
            __ps.placeImage = async () => { throw new Error('Original canvas changed'); };
            const openedBefore = __events.filter(e => e === 'open-document').length;
            await handleComfyRequest('expand');
            __ps.placeImage = originalPlace;
            check(__events.filter(e => e === 'open-document').length === openedBefore + 1, 'Failed outpaint insertion opens saved result separately');
            check(document.getElementById('statusBar').textContent.includes('отдельным документом'), 'Fallback completion is reported');
            document.getElementById('enhanceAutoTileSize').value = '1000';
            __events.length = 0;
            await runImageEditAuto();
            check(__events.filter(e => e === 'export').length > 1, 'Multiple tile exports');
            check(__events.lastIndexOf('export') < __events.indexOf('send'), 'All source tiles captured before generation');
            check(lastEnhanceAutoInfo.completed === lastEnhanceAutoInfo.total, 'All tiles placed');
            document.getElementById('mockupRemoveWall').checked = true;
            await handleComfyRequest('mockup_ai');
            check(__graphs.at(-1).wall_qwen_encode, 'Mockup wall removal submitted');
            check(Object.values(__graphs.at(-1)).some(node => node.class_type === 'UNETLoader' && node.inputs.unet_name.includes('krea2_turbo')), 'Mockup interior generated by Krea 2');
            check(__placed.at(-1)[4].designBehind, 'Wallpaper design below interior');
            check(__placed.at(-1)[4].originalMockupBuffer, 'Original mockup supplied to Photoshop');
            setMockupAiKindUI('artwork');
            check(document.getElementById('mockupRemoveWallControl').classList.contains('hidden'), 'Wall option hidden for art');
            document.getElementById('btn_free_models').click();
            await new Promise(resolve => setTimeout(resolve, 20));
            check(__events.includes('free'), 'Free memory clicked');
            check(!document.getElementById('btn_free_models').disabled, 'Free memory re-enabled');

            __patternMode = true;
            change('genModel','krea2'); change('krea2Model','fp8'); document.getElementById('krea2LoraEnabled').checked=false;
            document.getElementById('genSeamlessPattern').checked=true;
            document.getElementById('genSeamlessPattern').dispatchEvent(new Event('change',{bubbles:true}));
            check(!document.getElementById('genPatternAssemblyOptions').classList.contains('hidden'), 'Pattern assembly settings appear');
            check(document.getElementById('genPatternAssembly').checked, 'Pattern assembly enabled by default');
            const patternGraphStart=__graphs.length, patternPlaceStart=__placed.length;
            await handleComfyRequest('gen_krea2');
            check(__graphs.length===patternGraphStart+12, 'Original pattern, Gemini inventory and plan audit, three assets, visual review, two cutouts and three upscales');
            check(__placed.length===patternPlaceStart+1 && __events.at(-1)==='place-pattern', 'All layers delivered together without duplicate original insertion');
            check(__placed.at(-1).assets.length===3 && __placed.at(-1).assets.every(asset=>asset.upscaledPath), 'Background and all elements upscaled');
            check(__placed.at(-1).assets[0].cutoutPath===undefined, 'Background remains opaque');
            check(!localStorage.getItem('pendingPatternManifest'), 'Successful assembly clears resume state');
            check(!isTaskRunning && !activePatternController, 'Pattern task releases its lock');
            check(document.getElementById('statusBar').textContent.includes('2 элементов PNG'), 'Pattern completion status');
            document.getElementById('genSeamlessPattern').checked=false; __patternMode=false;
            check(__errors.length === 0, 'Renderer errors: ' + __errors.join('; '));


            return { graphs: __graphs.length, errors: __errors, checks: 'models, colors, alpha, snapshots, mockup layers, memory' };
        })()`);
        await win.webContents.executeJavaScript(`
            document.querySelectorAll('.tool-content').forEach(element => element.classList.toggle('hidden', element.id !== 'sec_enh'));
            document.getElementById('set_enh_image').classList.remove('hidden');
            document.getElementById('setupOverlay').classList.add('hidden');
            document.getElementById('statusBar').textContent = 'Проверка интерфейса завершена';
            window.scrollTo(0, 0);
        `);
        await new Promise(resolve => setTimeout(resolve, 150));
        fs.writeFileSync(path.join(__dirname, 'ui-preview.png'), (await win.webContents.capturePage()).toPNG());
        console.log('UI smoke passed:', JSON.stringify(result));
        win.destroy(); app.exit(0);
    } catch (error) { console.error('UI smoke failed:', error.message); win.destroy(); app.exit(1); }
});
