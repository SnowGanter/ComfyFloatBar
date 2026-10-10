const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// Run the actual generated JSX with a small Photoshop DOM substitute. No live
// Photoshop process, user documents or temporary files are touched by these tests.
function placementHarness({ failResize = false, documentId = 42, keepProcessRunning = false } = {}) {
    const files = new Map(), operations = [];
    const number = value => ({ as: () => value });
    const doc = { id: documentId, width: number(512), height: number(512), resolution:300,
        activeLayer:{ id:10, name:'Original' }, layers:[],
        resizeCanvas(width, height, anchor) {
            if (failResize) throw Object.assign(new Error('Canvas resize failed'), { line:20 });
            operations.push({ width:width.as('px'), height:height.as('px'), anchor });
            this.width = width; this.height = height;
        }
    };
    const resultLayer = { id:20, rasterize() {} };
    const tempDoc = { width:number(832), height:number(672),
        activeLayer:{ isBackgroundLayer:false, duplicate(target) { target.activeLayer = resultLayer; } },
        resizeImage() {}, close() { operations.push('close-temp'); }
    };
    const adobe = {
        app:{ displayDialogs:'ALL', activeDocument:doc, documents:[doc], open: () => tempDoc },
        DialogModes:{ NO:'NO' }, AnchorPosition:{ BOTTOMRIGHT:'BOTTOMRIGHT', TOPLEFT:'TOPLEFT' },
        UnitValue: value => number(value), ElementPlacement:{ PLACEATBEGINNING:'FIRST' },
        SaveOptions:{ DONOTSAVECHANGES:'NO' }, ResampleMethod:{ NONE:'NONE' }, RasterizeType:{ ENTIRELAYER:'ALL' },
        File: function(filename) {
            this.open = () => true;
            this.write = value => files.set(filename, Buffer.from(value));
            this.close = () => {};
        }
    };
    const mockedFs = {
        existsSync: file => /Photoshop\.exe$/.test(file) || files.has(file),
        writeFileSync: (file, data) => files.set(file, Buffer.from(data)),
        unlinkSync: file => files.delete(file),
        readFileSync: (file, encoding) => encoding ? files.get(file).toString(encoding) : files.get(file)
    };
    const mockedProcess = { execFile(exe, args, callback) {
        const jsx = files.get(args[1]).toString('utf8');
        assert.ok(jsx.startsWith('\uFEFF'), 'JSX must preserve non-ASCII text with a UTF-8 BOM');
        vm.runInNewContext(jsx, adobe);
        if (!keepProcessRunning) callback(null);
    } };
    const module = { exports:{} };
    const source = fs.readFileSync(path.join(__dirname, '../ps_bridge.js'), 'utf8');
    vm.runInNewContext(source, { module, exports:module.exports, Buffer, console:{log(){}},
        setInterval, clearInterval, setTimeout, clearTimeout,
        require: name => name === 'fs' ? mockedFs : name === 'child_process' ? mockedProcess : require(name)
    });
    const png = Buffer.alloc(24); png.write('IHDR', 12); png.writeUInt32BE(832, 16); png.writeUInt32BE(672, 20);
    const place = () => module.exports.placeImage(png, false, null, 'Expand_test', false, false, false, null, null, 42, null,
        { width:512, height:512, left:128, right:192, top:64, bottom:96 });
    return { place, adobe, doc, operations, resultLayer };
}

test('Expanded PNG resizes the correct Photoshop document and inserts the result layer', async () => {
    const run = placementHarness();
    await run.place();
    assert.deepEqual(run.operations.slice(0, 2), [
        {width:640, height:576, anchor:'BOTTOMRIGHT'},
        {width:832, height:672, anchor:'TOPLEFT'}
    ]);
    assert.equal(run.doc.activeLayer, run.resultLayer);
    assert.equal(run.resultLayer.name, 'Expand_test');
    assert.equal(run.adobe.app.displayDialogs, 'ALL');
});

test('A freshly launched Photoshop can finish insertion while its process is still running', {timeout:1500}, async () => {
    const run = placementHarness({keepProcessRunning:true});
    await run.place(); assert.equal(run.resultLayer.name,'Expand_test');
});

test('Photoshop insertion errors are returned and dialogs restored instead of hanging', async () => {
    for (const options of [{ failResize:true }, { documentId:99 }]) {
        const run = placementHarness(options);
        await assert.rejects(run.place(), /Photoshop не смог вставить изображение/);
        assert.equal(run.adobe.app.displayDialogs, 'ALL');
        assert.equal(run.doc.activeLayer.id, 10);
    }
});
