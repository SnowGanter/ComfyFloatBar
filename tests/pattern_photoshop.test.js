const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {buildPlacementScript} = require('../pattern_photoshop');
const manifest = {referencePath:'C:\\Паттерны\\reference.png',assets:[
    {kind:'background',upscaledPath:'C:\\Паттерны\\background.png'},
    {kind:'element',name:'Белая бабочка',upscaledPath:'C:\\Паттерны\\element.png',bbox:[.1,.2,.3,.4]}
]};

function harness({empty=false,fail=false,input=manifest}={}) {
    const operations=[]; const files={}; let imports=0;
    function unit(value,measure) {return {value:value*(measure==='in'?300:1),as:() => value*(measure==='in'?300:1)};}
    function group(parent) {return {parent,layerSets:{add(){const g=group(this);operations.push({kind:'group',group:g});return g;}},remove(){operations.push({kind:'rollback'});}};}
    const doc={width:unit(2000,'px'),height:unit(1000,'px'),layerSets:{add(){return group(doc);}},close(){operations.push({kind:'close-created'});}};
    const documents=empty?[]:[doc];
    documents.add=(width,height,dpi,name) => {doc.width=width;doc.height=height;doc.resolution=dpi;documents.push(doc);operations.push({kind:'document',width:width.as('px'),height:height.as('px'),dpi,name});return doc;};
    const app={displayDialogs:'ALL',documents,activeDocument:empty?null:doc,
        open(file) {
            const layer={bounds:[unit(0),unit(0),unit(4096),unit(4096)],isBackgroundLayer:true,allLocked:true,visible:true,
                move(parent,placement){this.parent=parent;doc.activeLayer=parent;operations.push({kind:'move',layer:this,placement});},
                resize(w,h){if(this.allLocked||!this.visible||app.activeDocument!==doc||doc.activeLayer!==this)throw new Error('Transform unavailable');operations.push({kind:'resize',w,h});this.bounds=[unit(0),unit(0),unit(4096*w/100),unit(4096*h/100)];},
                translate(x,y){if(this.allLocked||!this.visible||app.activeDocument!==doc||doc.activeLayer!==this)throw new Error('Perspective unavailable');operations.push({kind:'translate',x:x.as('px'),y:y.as('px'),layer:this});},
                duplicate(target){assert.equal(target,doc);if(fail && ++imports===2) throw new Error('Import failed');operations.push({kind:'duplicate',layer:this});return this;}
            };
            const temp={activeLayer:layer,close(){operations.push({kind:'close-temp'});}};app.activeDocument=temp;return temp;
        }};
    const adobe={app,UnitValue:unit,DialogModes:{NO:'NO'},NewDocumentMode:{RGB:'RGB'},DocumentFill:{TRANSPARENT:'TRANSPARENT'},
        AnchorPosition:{MIDDLECENTER:'CENTER'},ElementPlacement:{PLACEATBEGINNING:'FIRST',INSIDE:'INSIDE',PLACEATEND:'LAST'},
        SaveOptions:{DONOTSAVECHANGES:'NO'},
        File:function(name){this.path=name;this.exists=true;this.open=()=>true;this.close=()=>{};this.write=data=>files[name]=data;}};
    vm.runInNewContext(buildPlacementScript(input,'done.txt'),adobe);
    return {operations,files,app,doc};
}

test('Pattern import keeps all images at their native size in separate named layers for manual arrangement', () => {
    const h=harness(); assert.equal(h.files['done.txt'],'OK');
    assert.ok(!h.operations.some(op=>op.kind==='document'));
    const layers=h.operations.filter(op=>op.kind==='duplicate').map(op=>op.layer);
    assert.deepEqual(layers.map(layer=>layer.name),['Фон ×4','Исходный паттерн — ориентир','Белая бабочка ×4']);
    assert.equal(layers[1].visible,false);
    assert.equal(layers[2].parent.name,'Элементы PNG ×4');
    assert.equal(layers[0].parent.name,'Паттерн — исправленные элементы ×4');
    assert.ok(!h.operations.some(op=>op.kind==='resize'));
    assert.ok(layers.every(layer=>layer.bounds[2].as('px')===4096 && layer.bounds[3].as('px')===4096));
    assert.equal(h.app.displayDialogs,'ALL');
});

test('Every image is simply centered regardless of old Gemini coordinates', () => {
    for (const bbox of [undefined, [[.08,.15,.22,.23]], [1,1,0,0], [.08,155,230,215], [0,0,1e-20,1e-20]]) {
        const input = structuredClone(manifest); input.assets[1].bbox = bbox;
        const h = harness({input}); assert.equal(h.files['done.txt'],'OK');
        assert.ok(!h.operations.some(op=>op.kind==='resize'));
        const moves = h.operations.filter(op=>op.kind==='translate');
        assert.equal(moves.length,3);
        assert.ok(moves.every(move=>move.x === 1000-2048 && move.y === 500-2048));
    }
});

test('No document creates exactly 40×40 inches at 300dpi (12000px), without resizing a user document', () => {
    const h=harness({empty:true}); assert.equal(h.files['done.txt'],'OK');
    const created=h.operations.find(op=>op.kind==='document');
    assert.equal(created.width,12000);assert.equal(created.height,12000);assert.equal(created.dpi,300);
    assert.ok(!h.operations.some(op=>op.kind==='resize'));
    assert.ok(h.operations.filter(op=>op.kind==='translate').every(op=>op.x===6000-2048 && op.y===6000-2048));
    assert.equal(h.app.activeDocument,h.doc);
});

test('Failed imports roll back only their own group and restore Photoshop dialog mode', () => {
    const h=harness({fail:true});assert.match(h.files['done.txt'],/ERROR: .*Import failed/);
    assert.ok(h.operations.some(op=>op.kind==='rollback'));
    assert.ok(!h.operations.some(op=>op.kind==='close-created'));
    assert.equal(h.app.displayDialogs,'ALL');
    const created=harness({empty:true,fail:true});assert.ok(created.operations.some(op=>op.kind==='close-created'));
});
