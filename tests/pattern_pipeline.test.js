const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pipeline = require('../pattern_pipeline');

const checks = changes => Object.assign(Object.fromEntries(pipeline.REVIEW_CHECKS.map(key => [key,true])),changes);
const analysis = {style:'Flat ink illustration with thin dark contours, smooth solid fills and restrained flat shading.',
    background:{name:'Бумага',prompt:'A warm sandy paper surface, subtle grain, no objects.',repairs:['Remove accidental blotches.']},
    elements:[
        {name:'Цветок',prompt:'One correctly formed tulip with coherent petals and stem.',matte:'black',repairs:['Separate fused petals.'],source_hint:'The upright tulip in the upper left.',
            identity:{subject:'One tulip plant',pose:'Its straight stem supports an upright cup-shaped bloom',view:'The bloom faces the viewer',colors:'The petals are crimson and the stem is muted teal',markings:'The petals have plain solid color'}},
        {name:'Бабочка',prompt:'One symmetric butterfly with two complete wings.',matte:'white',repairs:['Restore a missing wing.'],source_hint:'The butterfly in the lower right.',
            identity:{subject:'One butterfly',pose:'Two pairs of spread wings join a slender central body',view:'The wings are seen directly from above',colors:'The wings are ivory with a dark teal body',markings:'Thin dark contours outline each plain wing'}}
    ]};
const settings = {userPrompt:'Flowers and butterflies',geminiModel:'gemini-3.8-flash',apiKey:'test-secret',kreaVariant:'fp8',seed:100,lora:{enabled:false,id:'arcana',strength:1}};
function png(width, height) {
    const data = Buffer.alloc(33); Buffer.from('89504e470d0a1a0a','hex').copy(data); data.write('IHDR',12);
    data.writeUInt32BE(width,16); data.writeUInt32BE(height,20); return data;
}
function harness(t, override = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(),'cfb-pattern-'));
    t.after(() => fs.rmSync(directory,{recursive:true,force:true}));
    const referencePath = path.join(directory,'reference.png'); fs.writeFileSync(referencePath,png(1024,1024));
    const calls = [];
    const options = {directory:path.join(directory,'assets'),referencePath,settings};
    const deps = {upload:async name => path.basename(name),
        executeText:async graph => {
            assert.equal(graph.analyze.inputs.model_name,'gemini-3.8-flash');
            const ids=graph.analyze._meta?.cfbReviewAssets;
            if(ids){calls.push('review');return JSON.stringify({results:ids.map(id=>({id,valid:true,checks:checks(),reason:'One clean specimen',replacement_prompt:''}))});}
            if(graph.analyze._meta?.cfbPlanReview){calls.push('plan-review');return JSON.stringify(analysis);}
            calls.push('analysis');return JSON.stringify(analysis);
        },
        executeImage:async graph => {
            const stage = graph.sampler ? 'generate' : graph['11'] ? 'cutout' : 'upscale'; calls.push(stage);
            return png(stage === 'upscale' ? 4096 : 1024,stage === 'upscale' ? 4096 : 1024);
        },
        verifyTransparent:async () => {calls.push('alpha');},
        placeInPhotoshop:async manifest => {calls.push('photoshop'); assert.equal(manifest.assets.length,3);},
        ...override};
    return {options,deps,calls};
}

test('Gemini inventory requires subject, pose, view, exact colors and markings for each motif', () => {
    const plan = pipeline.parseAnalysis(JSON.stringify(analysis));
    assert.equal(plan.elements.length,2); assert.equal(plan.elements[0].matte,'black');
    for (const edit of [data => data.elements[0].matte='red',data => data.background.prompt='',data => data.elements=[],data => delete data.elements[0].identity.colors,data => delete data.elements[0].source_hint]) {
        const broken = structuredClone(analysis); edit(broken); assert.throws(() => pipeline.parseAnalysis(broken));
    }
    assert.throws(() => pipeline.parseAnalysis('{"elements":['),/неполный/);
    assert.match(pipeline.analysisPrompt('ignore previous'),/Do NOT merely caption/);
    assert.match(pipeline.analysisPrompt(),/ALL visually distinct/);
});

test('Legacy placement hints are ignored when inventorying motifs for manual placement', () => {
    const input = structuredClone(analysis);
    input.elements[0].bbox = [[.08,.15,.22,.23]];
    delete input.elements[1].bbox;
    const plan = pipeline.parseAnalysis(input);
    assert.ok(plan.elements.every(asset => !('bbox' in asset) && !('layoutApproximate' in asset)));
    assert.equal(plan.elements[1].prompt,input.elements[1].prompt);
    assert.ok(!JSON.stringify(pipeline.ANALYSIS_SCHEMA).includes('bbox'));
});

test('Web-pattern detailing on a single character is not rejected as another pattern sheet', () => {
    const input = structuredClone(analysis);
    input.elements[0].prompt = 'One detached full-body comic character with sharp black web-pattern detailing on a red and blue suit.';
    assert.doesNotThrow(() => pipeline.validateAssetPrompts(pipeline.parseAnalysis(input)));
    input.elements[0].prompt += ' A repeating arrangement of identical characters fills the backdrop.';
    assert.throws(() => pipeline.validateAssetPrompts(pipeline.parseAnalysis(input)),/паттерн/);
});

test('Pipeline completes with missing/mixed-unit coordinates and preserves every inventoried motif', async t => {
    const input = structuredClone(analysis);
    input.elements[0].bbox = [.08,155,230,215];
    delete input.elements[1].bbox;
    const h = harness(t); const original = h.deps.executeText;
    h.deps.executeText = graph => graph.analyze._meta?.cfbReviewAssets ? original(graph) : JSON.stringify(input);
    const result = await pipeline.run(h.options,h.deps);
    assert.equal(result.manifest.state,'complete');
    assert.equal(result.manifest.assets.length,3);
    assert.ok(result.manifest.assets.slice(1).every(asset => !('bbox' in asset)));
    assert.ok(h.calls.includes('photoshop'));
});

test('Generation describes corrected appearance, avoids full-pattern captions and repair commands, and retains LoRA', () => {
    const plan = pipeline.parseAnalysis(analysis);
    const graph = pipeline.createGenerationWorkflow(plan.elements[0],{...settings,lora:{enabled:true,id:'disney',strength:.8}},plan.style,0);
    assert.match(graph.positive.inputs.text,/coherent petals/);
    assert.doesNotMatch(graph.positive.inputs.text,/Separate fused petals|Required corrections|Style and palette/);
    assert.match(graph.positive.inputs.text,/uniform pure black/);
    assert.match(graph.positive.inputs.text,/D1sneyCl4ssic/);
    const lora = Object.values(graph).find(node => node.class_type === 'LoraLoaderModelOnly');
    assert.equal(lora.inputs.strength_model,.8);
    assert.equal(graph.sampler.inputs.model[0],'cfb_krea2_lora');
    assert.ok(!Object.values(graph).some(node => node.class_type === 'IFGeminiNode'));
    assert.match(pipeline.correctedPrompt(plan.background,plan.style),/warm sandy paper/);
    assert.doesNotMatch(pipeline.correctedPrompt(plan.background,'dense seamless repeating floral pattern, tulips'),/seamless|repeating|floral|tulips/);
    assert.doesNotMatch(pipeline.correctedPrompt(plan.elements[0],'dense seamless repeating floral pattern, tulips'),/seamless|repeating|floral/);
    const upscale = pipeline.createUpscaleWorkflow('alpha.png',plan.elements[0],12);
    assert.equal(upscale['66:57'].inputs['resize_type.multiplier'],4);
    assert.deepEqual(upscale['66:59'].inputs.original_resized_images,['66:57',0]);
    assert.deepEqual(upscale['66:50'].inputs.alpha,['1',1]);
    assert.ok(!upscale['65']);
});

test('All motif prompts share the exact rendering specification and retain their own poses/colors', () => {
    const plan = pipeline.parseAnalysis(analysis);
    const prompts = plan.elements.map((asset,i) => pipeline.createGenerationWorkflow(asset,settings,plan.style,i).positive.inputs.text);
    assert.ok(prompts.every(prompt => prompt.startsWith(plan.style)));
    assert.match(prompts[0],/straight stem|upright cup-shaped bloom/);
    assert.match(prompts[0],/crimson.*muted teal/);
    assert.match(prompts[1],/seen directly from above/);
    assert.match(prompts[1],/ivory.*dark teal/);
    assert.doesNotMatch(prompts[1],/crimson/);
    assert.doesNotMatch(pipeline.analysisPrompt(),/\bcats?\b/i);
    const unsafe = structuredClone(analysis); unsafe.style='A dense floral pattern with tulips.';
    assert.throws(() => pipeline.validateAssetPrompts(pipeline.parseAnalysis(unsafe)),/Общий стиль/);
});

test('Plan audit corrects invented variants and identities before any Krea generation', async t => {
    const h = harness(t); const original = h.deps.executeText;
    const draft = structuredClone(analysis); draft.elements[0].identity.colors='Invented blue petals';
    draft.elements.push({...draft.elements[0],name:'Repeated tulip'});
    h.deps.executeText = async graph => {
        if (graph.analyze._meta?.cfbPlanReview) {
            h.calls.push('plan-review'); assert.match(graph.analyze.inputs.prompt,/Invented blue petals/);
            assert.ok(!h.calls.includes('generate')); return JSON.stringify(analysis);
        }
        if (graph.analyze._meta?.cfbReviewAssets) return original(graph);
        h.calls.push('analysis'); return JSON.stringify(draft);
    };
    const result = await pipeline.run(h.options,h.deps);
    assert.equal(result.manifest.assets.length,3);
    assert.match(result.manifest.assets[1].identity.colors,/crimson/);
    assert.equal(result.manifest.planReviewedPromptRevision,pipeline.PROMPT_REVISION);
});

test('Style/pose/color failures force regeneration even when the overall Gemini verdict mistakenly says valid', async t => {
    const h = harness(t); const original = h.deps.executeText; let reviews = 0;
    h.deps.executeText = async graph => {
        const ids = graph.analyze._meta?.cfbReviewAssets;
        if (!ids) return original(graph);
        h.calls.push('review'); reviews++;
        assert.match(graph.analyze.inputs.prompt,/upright cup-shaped bloom|upper left/);
        assert.match(graph.analyze.inputs.prompt,/contours/);
        return JSON.stringify({results:ids.map(id=>({id,valid:true,checks:checks({style:reviews>1 || id!=='element_001',pose:reviews>1 || id!=='element_001',colors:reviews>1 || id!=='element_001'}),
            reason:'Wrong pose and palette',replacement_prompt:reviews===1 && id==='element_001' ? 'One upright crimson tulip with a muted teal stem, complete and isolated on a uniform black backdrop.' : ''}))});
    };
    const result = await pipeline.run(h.options,h.deps);
    assert.equal(result.manifest.assets[1].generationRetries,1);
    assert.equal(h.calls.filter(call=>call==='generate').length,4);
    assert.ok(h.calls.indexOf('cutout')>h.calls.lastIndexOf('review'));
    const asset = result.manifest.assets[1];
    const conditioning = pipeline.createGenerationWorkflow(asset,settings,result.manifest.analysis.style,0).positive.inputs.text;
    assert.ok(conditioning.startsWith(analysis.style)); assert.match(conditioning,/crimson/);
});

test('Review cannot silently skip reference fidelity checks', () => {
    const asset = pipeline.parseAnalysis(analysis).elements[0];
    assert.throws(()=>pipeline.parseReview(JSON.stringify({results:[{id:asset.id,valid:true,reason:'Looks fine',replacement_prompt:''}]}),[asset]),/не сверил/);
});

test('Pipeline generates all assets, then cuts motifs only, then upscales motifs AND background before Photoshop', async t => {
    const {options,deps,calls} = harness(t);
    const result = await pipeline.run(options,deps);
    assert.deepEqual(calls,['analysis','plan-review','generate','generate','generate','review','cutout','alpha','cutout','alpha','upscale','upscale','alpha','upscale','alpha','photoshop']);
    assert.equal(result.manifest.state,'complete');
    assert.equal(result.manifest.assets[0].cutoutPath,undefined);
    assert.ok(result.manifest.assets.every(asset => fs.existsSync(asset.upscaledPath)));
    assert.ok(!fs.readFileSync(result.manifestPath,'utf8').includes('test-secret'));
});

test('Downloaded ArrayBuffer images are normalized before saving files', async t => {
    const h = harness(t); const original = h.deps.executeImage;
    h.deps.executeImage = async graph => {const buffer=await original(graph);return buffer.buffer.slice(buffer.byteOffset,buffer.byteOffset+buffer.byteLength);};
    const result = await pipeline.run(h.options,h.deps); assert.equal(result.manifest.state,'complete');
});

test('Failed upscale resumes saved files without repeating analysis, generation or cutout', async t => {
    const h = harness(t); const original = h.deps.executeImage; let failed = false;
    h.deps.executeImage = async graph => { if (graph['66:54'] && !failed) {failed=true;throw new Error('GPU unavailable');} return original(graph); };
    await assert.rejects(pipeline.run(h.options,h.deps),/GPU unavailable/);
    const manifestPath = path.join(h.options.directory,'pattern.json');
    assert.equal(JSON.parse(fs.readFileSync(manifestPath)).state,'failed');
    h.calls.length = 0;
    await pipeline.run({manifestPath,settings:{apiKey:'renewed-key'}},h.deps);
    assert.deepEqual(h.calls,['upscale','upscale','alpha','upscale','alpha','photoshop']);
});

test('Resume keeps saved files and reviewed prompts while ignoring legacy placement hints', async t => {
    const h = harness(t); const completed = await pipeline.run(h.options,h.deps);
    const saved = completed.manifest;
    saved.assets[1].bbox = [[.08,.15,.22,.23]];
    saved.assets[1].prompt = 'One corrected standalone red tulip.';
    delete saved.analysis.elements[1].bbox;
    delete saved.assets[2].bbox;
    fs.writeFileSync(completed.manifestPath,JSON.stringify(saved));
    h.calls.length = 0;
    const resumed = await pipeline.run({manifestPath:completed.manifestPath,settings:{apiKey:'renewed'}},h.deps);
    assert.deepEqual(h.calls,['photoshop']);
    assert.equal(resumed.manifest.assets[1].prompt,'One corrected standalone red tulip.');
    assert.ok(!('bbox' in resumed.manifest.analysis.elements[1]));
});

test('Cancellation prevents submitting the next generation and retains completed assets', async t => {
    const controller = new AbortController(); const h = harness(t);
    h.options.signal = controller.signal;
    h.deps.onCheckpoint = (_,manifest) => {if (manifest.assets[0]?.generatedPath) controller.abort();};
    await assert.rejects(pipeline.run(h.options,h.deps),{name:'AbortError'});
    assert.deepEqual(h.calls,['analysis','plan-review','generate']);
    const manifest = JSON.parse(fs.readFileSync(path.join(h.options.directory,'pattern.json')));
    assert.equal(manifest.state,'cancelled'); assert.ok(fs.existsSync(manifest.assets[0].generatedPath));
});

test('Invalid alpha or wrong ×4 dimensions cannot proceed to Photoshop', async t => {
    const h = harness(t,{verifyTransparent:async () => {throw new Error('Empty alpha');}});
    await assert.rejects(pipeline.run(h.options,h.deps),/Empty alpha/); assert.ok(!h.calls.includes('photoshop'));
    const another = harness(t);
    const original = another.deps.executeImage;
    another.deps.executeImage = graph => graph['66:54'] ? png(2048,2048) : original(graph);
    await assert.rejects(pipeline.run(another.options,another.deps),/неверный размер/); assert.ok(!another.calls.includes('photoshop'));
});

test('Gemini temporary busy reply retries; malformed JSON never creates partial inventory', async t => {
    const h = harness(t,{delay:async () => {}}); let tries=0;
    const original=h.deps.executeText;
    h.deps.executeText = async graph => graph.analyze._meta?.cfbReviewAssets || graph.analyze._meta?.cfbPlanReview ? original(graph) : ++tries === 1 ? 'Error: 503 UNAVAILABLE' : JSON.stringify(analysis);
    await pipeline.run(h.options,h.deps); assert.equal(tries,2);
    const broken = harness(t,{executeText:async () => '{"elements":['});
    await assert.rejects(pipeline.run(broken.options,broken.deps),/неполный/); assert.equal(broken.calls.length,0);
});

test('Prompts for repeated sheets or a floral background are rewritten before any generation', async t => {
    const h=harness(t);const original=h.deps.executeText;let tries=0;
    h.deps.executeText=async graph=>{
        if(graph.analyze._meta?.cfbReviewAssets || graph.analyze._meta?.cfbPlanReview) return original(graph);
        if(++tries===1){const bad=structuredClone(analysis);bad.elements[0].prompt='A seamless repeating floral pattern of tulips';return JSON.stringify(bad);}
        assert.match(graph.analyze.inputs.prompt,/previous response violated/);return JSON.stringify(analysis);
    };
    await pipeline.run(h.options,h.deps);assert.equal(tries,2);
    const bad=structuredClone(analysis);bad.background.prompt='A dark green foliage background with flowers';
    assert.throws(()=>pipeline.validateAssetPrompts(pipeline.parseAnalysis(bad)),/подложки/);
});

test('Vision rejects duplicated elements and regenerates only those assets before cutting or upscaling', async t => {
    const h=harness(t);const original=h.deps.executeText;let reviews=0;
    h.deps.executeText=async graph=>{
        const ids=graph.analyze._meta?.cfbReviewAssets;if(!ids)return original(graph);
        h.calls.push('review');reviews++;
        return JSON.stringify({results:ids.map(id=>({id,valid:reviews>1 || id!=='element_001',checks:checks({isolated:reviews>1 || id!=='element_001'}),reason:'Extra flowers at edges',replacement_prompt:'One detached red tulip head with complete petals, centered on a uniform black studio backdrop.'}))});
    };
    const result=await pipeline.run(h.options,h.deps);
    assert.equal(h.calls.filter(call=>call==='generate').length,4);
    assert.equal(reviews,2);
    const rejected=result.manifest.assets[1];assert.equal(rejected.generationRetries,1);
    assert.ok(fs.existsSync(rejected.previousGenerations[0].path));assert.ok(fs.existsSync(rejected.generatedPath));
    assert.ok(h.calls.indexOf('cutout')>h.calls.lastIndexOf('review'));
});

test('Uncorrected duplicates are stopped before spending time on cutout, SeedVR2 or Photoshop', async t => {
    const h=harness(t);const original=h.deps.executeText;
    h.deps.executeText=async graph=>{
        const ids=graph.analyze._meta?.cfbReviewAssets;if(!ids)return original(graph);
        return JSON.stringify({results:ids.map(id=>({id,valid:id!=='background',checks:checks({isolated:id!=='background'}),reason:'Still a flower sheet',replacement_prompt:'A plain deep green smooth matte surface, evenly lit.'}))});
    };
    await assert.rejects(pipeline.run(h.options,h.deps),/Krea после повторов/);
    assert.ok(!h.calls.includes('cutout')&&!h.calls.includes('upscale')&&!h.calls.includes('photoshop'));
});

test('Old prompt revisions rebuild in a separate directory and do not reuse or overwrite bad results', async t => {
    const h=harness(t);const first=await pipeline.run(h.options,h.deps);
    const legacy={...first.manifest};delete legacy.promptRevision;fs.writeFileSync(first.manifestPath,JSON.stringify(legacy));
    h.calls.length=0;const second=await pipeline.run({manifestPath:first.manifestPath,settings:{apiKey:'new'}},h.deps);
    assert.notEqual(second.manifestPath,first.manifestPath);assert.ok(h.calls.includes('analysis')&&h.calls.includes('generate'));
    assert.ok(fs.existsSync(first.manifest.assets[1].generatedPath));
});
