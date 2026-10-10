const { execFile, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TEMP_DIR = os.tmpdir();

// Auto-detect Photoshop path — registry + hardcoded + portable + running process
function findPhotoshopPath() {
    // ── 1. Fast hardcoded paths (most common installations) ──
    const possiblePaths = [
        // Adobe Photoshop 2026
        "C:\\Program Files\\Adobe\\Adobe Photoshop 2026\\Photoshop.exe",
        "C:\\Program Files (x86)\\Adobe\\Adobe Photoshop 2026\\Photoshop.exe",
        // Adobe Photoshop 2025
        "C:\\Program Files\\Adobe\\Adobe Photoshop 2025\\Photoshop.exe",
        "C:\\Program Files (x86)\\Adobe\\Adobe Photoshop 2025\\Photoshop.exe",
        // Adobe Photoshop 2024
        "C:\\Program Files\\Adobe\\Adobe Photoshop 2024\\Photoshop.exe",
        "C:\\Program Files (x86)\\Adobe\\Adobe Photoshop 2024\\Photoshop.exe",
        // Adobe Photoshop 2023
        "C:\\Program Files\\Adobe\\Adobe Photoshop 2023\\Photoshop.exe",
        // Adobe Photoshop 2022–2020
        "C:\\Program Files\\Adobe\\Adobe Photoshop 2022\\Photoshop.exe",
        "C:\\Program Files\\Adobe\\Adobe Photoshop 2021\\Photoshop.exe",
        "C:\\Program Files\\Adobe\\Adobe Photoshop 2020\\Photoshop.exe",
        // Generic/older versions
        "C:\\Program Files\\Adobe\\Adobe Photoshop (64 Bit)\\Photoshop.exe",
        "C:\\Program Files\\Adobe\\Photoshop\\Photoshop.exe",
        "C:\\Program Files (x86)\\Adobe\\Photoshop\\Photoshop.exe",
        // Adobe Photoshop Elements (limited, but still .jsx support)
        "C:\\Program Files\\Adobe\\Adobe Photoshop Elements 2025\\PhotoshopElementsEditor.exe",
        "C:\\Program Files\\Adobe\\Adobe Photoshop Elements 2024\\PhotoshopElementsEditor.exe",
        "C:\\Program Files\\Adobe\\Adobe Photoshop Elements 2023\\PhotoshopElementsEditor.exe",
    ];
    for (const p of possiblePaths) {
        try { if (fs.existsSync(p)) return p; } catch(e) {}
    }

    // ── 2. Windows Registry — the most reliable method ──
    // App Paths key (HKLM) — Windows stores the EXE path for apps registered in Start menu
    const regQueries = [
        // 64-bit registry view (standard on 64-bit Windows)
        'reg query "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Photoshop.exe" /ve 2>nul',
        // 32-bit registry view (WOW6432Node — for 32-bit Photoshop on 64-bit Windows)
        'reg query "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Photoshop.exe" /ve 2>nul',
        // Uninstall keys — search for Photoshop InstallLocation (64-bit view)
        'reg query "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall" /s /f Photoshop 2>nul',
        // Uninstall keys (32-bit view)
        'reg query "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall" /s /f Photoshop 2>nul',
        // Current user uninstall keys (Creative Cloud installs per-user sometimes)
        'reg query "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall" /s /f Photoshop 2>nul',
    ];
    for (const q of regQueries) {
        try {
            const result = execSync(q, { timeout: 3000, encoding: 'utf8' });
            // Parse registry output for paths
            // App Paths returns:    REG_SZ    C:\Program Files\Adobe\...\Photoshop.exe
            // Uninstall returns:    InstallLocation    REG_SZ    C:\Program Files\Adobe\...
            const lines = result.trim().split('\n');
            for (const line of lines) {
                // Look for REG_SZ lines containing a path
                if (line.includes('REG_SZ') && (line.includes('Photoshop') || line.includes('photoshop'))) {
                    const value = line.split('REG_SZ').pop().trim();
                    if (value) {
                        // Could be full EXE path or directory — try both
                        if (value.toLowerCase().endsWith('.exe') && fs.existsSync(value)) return value;
                        const exeFromDir = path.join(value, 'Photoshop.exe');
                        if (fs.existsSync(exeFromDir)) return exeFromDir;
                        // Adobe CC format: "C:\Program Files\Adobe\Adobe Photoshop 2025"
                        const adobeExe = path.join(value, value.split('\\').pop() + '\\Photoshop.exe');
                        try { if (fs.existsSync(adobeExe)) return adobeExe; } catch(e) {}
                    }
                }
            }
        } catch (e) {} // reg query fails if key doesn't exist — that's OK
    }

    // ── 3. Check if Photoshop is currently running (WMIC) ──
    try {
        const result = execSync(
            'wmic process where "name=\'Photoshop.exe\'" get ExecutablePath /value 2>nul',
            { timeout: 3000, encoding: 'utf8' }
        );
        const match = result.match(/ExecutablePath=(.+)/i);
        if (match && match[1] && fs.existsSync(match[1].trim())) return match[1].trim();
    } catch (e) {}
    // Fallback: tasklist + wmic combination
    try {
        const result = execSync(
            'wmic process where "name like \'%Photoshop%\'" get ExecutablePath /value 2>nul',
            { timeout: 3000, encoding: 'utf8' }
        );
        const lines = result.trim().split('\n');
        for (const line of lines) {
            const m = line.match(/ExecutablePath=(.+)/i);
            if (m && m[1] && m[1].toLowerCase().includes('photoshop') && fs.existsSync(m[1].trim())) return m[1].trim();
        }
    } catch (e) {}

    // ── 4. Portable Photoshop — search common portable locations ──
    const userProfile = process.env.USERPROFILE || process.env.HOME || 'C:\\Users\\Default';
    const portableSearchDirs = [
        userProfile,                         // C:\Users\Name
        path.join(userProfile, 'Desktop'),   // C:\Users\Name\Desktop
        path.join(userProfile, 'Downloads'), // C:\Users\Name\Downloads
        'D:\\',                               // D: drive (common for portable apps)
        'E:\\',                               // E: drive
        path.join(userProfile, 'Documents'), // Documents folder
    ];
    for (const dir of portableSearchDirs) {
        try {
            if (!fs.existsSync(dir)) continue;
            // Quick: check if dir itself contains Photoshop.exe (user unzipped portable directly here)
            const directExe = path.join(dir, 'Photoshop.exe');
            try { if (fs.existsSync(directExe)) return directExe; } catch(e) {}
            // Search one level deep for folders named "Photoshop" or "Adobe Photoshop"
            const subdirs = fs.readdirSync(dir, { withFileTypes: true });
            for (const sd of subdirs) {
                if (!sd.isDirectory()) continue;
                const nameLower = sd.name.toLowerCase();
                if (nameLower.includes('photoshop') || nameLower.includes('adobe')) {
                    const exePath = path.join(dir, sd.name, 'Photoshop.exe');
                    try { if (fs.existsSync(exePath)) return exePath; } catch(e) {}
                    // Portable often has "App" subfolder
                    const appPath = path.join(dir, sd.name, 'App', 'Photoshop.exe');
                    try { if (fs.existsSync(appPath)) return appPath; } catch(e) {}
                }
            }
        } catch (e) {} // permission denied or other errors — skip
    }

    // ── 5. Last resort: slow dir /s /b search ──
    try {
        const result = execSync(
            'dir /s /b "C:\\Program Files\\Adobe\\Photoshop.exe" 2>nul',
            { timeout: 8000, encoding: 'utf8' }
        );
        const lines = result.trim().split('\n');
        if (lines.length > 0 && lines[0] && fs.existsSync(lines[0].trim())) return lines[0].trim();
    } catch (e) {}
    try {
        const result = execSync(
            'dir /s /b "C:\\Program Files (x86)\\Adobe\\Photoshop.exe" 2>nul',
            { timeout: 8000, encoding: 'utf8' }
        );
        const lines = result.trim().split('\n');
        if (lines.length > 0 && lines[0] && fs.existsSync(lines[0].trim())) return lines[0].trim();
    } catch (e) {}

    return null; // Not found — user must install or specify manually
}

let _psPath = null;
function getPSPath() {
    if (_psPath === null) {
        _psPath = findPhotoshopPath();
        if (_psPath) console.log(`✓ Photoshop found: ${_psPath}`);
        else console.log("✗ Photoshop not found on this machine");
    }
    return _psPath;
}

function runScript(scriptPath, doneFilePath, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
        const psPath = getPSPath();
        if (!psPath) { reject("Photoshop.exe не найден! Установите Photoshop или эта функция недоступна."); return; }
        
        if (fs.existsSync(doneFilePath)) fs.unlinkSync(doneFilePath);
        // A newly launched Photoshop process stays alive after the JSX completes.
        // Observe the script result immediately, without waiting for Photoshop to exit.
        const interval = setInterval(() => {
            if (fs.existsSync(doneFilePath)) { clearInterval(interval); clearTimeout(timeout); resolve(); }
        }, 100);
        const timeout = setTimeout(() => {
            clearInterval(interval);
            if (fs.existsSync(doneFilePath)) resolve();
            else reject("Photoshop завис.");
        }, timeoutMs);
        execFile(psPath, ['-r', scriptPath], (error) => {
            if (error && error.code === 'ENOENT') { 
                _psPath = null; // reset cache so next call searches again
                clearInterval(interval); clearTimeout(timeout);
                reject("Photoshop.exe не найден!"); 
            }
        });
    });
}

function getPngDimensions(filepath) {
    const buf = fs.readFileSync(filepath);
    if (buf.length >= 24 && buf.toString('ascii', 12, 16) === 'IHDR') {
        return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    return { width: 0, height: 0 };
}

async function getActiveDocumentName() {
    const scriptPath = path.join(TEMP_DIR, "comfy_get_name.jsx");
    const donePath = path.join(TEMP_DIR, "comfy_get_name.txt").replace(/\\/g, '/');
    const jsx = `var doneFile = new File("${donePath}"); doneFile.open("w"); try { doneFile.write(app.activeDocument.name); } catch(e) { doneFile.write("ERROR"); } doneFile.close();`;
    fs.writeFileSync(scriptPath, jsx);
    await runScript(scriptPath, donePath);
    return fs.readFileSync(path.join(TEMP_DIR, "comfy_get_name.txt"), 'utf8');
}

async function exportSelection() {
    const exportPngPath = path.join(TEMP_DIR, "ps_enh_temp.png").replace(/\\/g, '/');
    const scriptPath = path.join(TEMP_DIR, "comfy_enh_export.jsx");
    const donePath = path.join(TEMP_DIR, "comfy_enh_done.txt").replace(/\\/g, '/');
    const coordsPath = path.join(TEMP_DIR, "comfy_coords.txt").replace(/\\/g, '/');
    const jsx = `
        var oldDialogs = app.displayDialogs; app.displayDialogs = DialogModes.NO;
        var doc = app.activeDocument; var selBounds;
        try { selBounds = doc.selection.bounds; } catch(e) { selBounds = null; }
        if (selBounds) {
            // A Photoshop pixel selection must be returned on integer pixel boundaries.
            var x = Math.round(selBounds[0].as('px')), y = Math.round(selBounds[1].as('px'));
            var w = Math.round(selBounds[2].as('px') - selBounds[0].as('px'));
            var h = Math.round(selBounds[3].as('px') - selBounds[1].as('px'));
            
            var coordsFile = new File("${coordsPath}"); 
            coordsFile.open("w"); 
            coordsFile.write(x + "," + y + "," + w + "," + h); 
            coordsFile.close();
            
            doc.selection.copy(true);
            var tempDoc = app.documents.add(UnitValue(w, 'px'), UnitValue(h, 'px'), doc.resolution, "ComfyTemp", NewDocumentMode.RGB, DocumentFill.TRANSPARENT);
            tempDoc.bitsPerChannel = doc.bitsPerChannel;
            try { if (doc.colorProfileName != "") tempDoc.colorProfileName = doc.colorProfileName; } catch(e) {}
            tempDoc.paste();
            var file = new File("${exportPngPath}"); var opts = new PNGSaveOptions(); opts.compression = 6; opts.transparency = true;
            tempDoc.saveAs(file, opts, true, Extension.LOWERCASE); tempDoc.close(SaveOptions.DONOTSAVECHANGES);
            app.displayDialogs = oldDialogs; var doneFile = new File("${donePath}"); doneFile.open("w"); doneFile.write("ok"); doneFile.close();
        } else {
            app.displayDialogs = oldDialogs; var doneFile = new File("${donePath}"); doneFile.open("w"); doneFile.write("NO_SELECTION"); doneFile.close();
        }
    `;
    fs.writeFileSync(scriptPath, jsx);
    await runScript(scriptPath, donePath);
    const doneContent = fs.readFileSync(path.join(TEMP_DIR, "comfy_enh_done.txt"), 'utf8');
    if (doneContent === "NO_SELECTION") return null;
    return { filePath: path.join(TEMP_DIR, "ps_enh_temp.png"), coordsPath: path.join(TEMP_DIR, "comfy_coords.txt") };
}


async function getActiveDocumentInfo() {
    const scriptPath = path.join(TEMP_DIR, "comfy_enhance_document_info.jsx");
    const donePath = path.join(TEMP_DIR, "comfy_enhance_document_info_done.txt").split(path.sep).join('/');
    const jsx = [
        'var oldDialogs = app.displayDialogs; app.displayDialogs = DialogModes.NO;',
        'var doneFile = new File("' + donePath + '");',
        'try {',
        '  var doc = app.activeDocument;',
        '  var width = Math.round(doc.width.as("px"));',
        '  var height = Math.round(doc.height.as("px"));',
        '  app.displayDialogs = oldDialogs;',
        '  doneFile.open("w"); doneFile.write("OK\t" + doc.id + "\t" + width + "\t" + height + "\t" + encodeURIComponent(doc.name)); doneFile.close();',
        '} catch(e) {',
        '  try { app.displayDialogs = oldDialogs; } catch(ignore) {}',
        '  doneFile.open("w"); doneFile.write("ERROR\t" + encodeURIComponent(String(e.message || "CFB_DOCUMENT_INFO_FAILED"))); doneFile.close();',
        '}'
    ].join('\r\n');
    fs.writeFileSync(scriptPath, jsx);
    await runScript(scriptPath, donePath);
    const result = fs.readFileSync(path.join(TEMP_DIR, "comfy_enhance_document_info_done.txt"), 'utf8');
    if (result.indexOf('OK\t') !== 0) throw new Error('Photoshop не смог получить размер активного документа.');
    const parts = result.split('\t');
    return {
        documentId: Number(parts[1]) || 0,
        width: Number(parts[2]) || 0,
        height: Number(parts[3]) || 0,
        name: decodeURIComponent(parts[4] || 'Document')
    };
}

async function createLayerGroup(groupName, documentId = null) {
    const scriptPath = path.join(TEMP_DIR, "comfy_enhance_create_group.jsx");
    const donePath = path.join(TEMP_DIR, "comfy_enhance_create_group_done.txt").split(path.sep).join('/');
    const safeName = String(groupName || 'Enhance Auto').replace(/[^ -~]/g, '_').replace(/"/g, '').slice(0, 80);
    const requestedDocumentId = Math.max(0, Math.round(Number(documentId) || 0));
    const jsx = [
        'var oldDialogs = app.displayDialogs; app.displayDialogs = DialogModes.NO;',
        'var doneFile = new File("' + donePath + '");',
        'try {',
        '  var requestedDocumentId = ' + requestedDocumentId + ';',
        '  if (requestedDocumentId > 0) {',
        '    for (var i = 0; i < app.documents.length; i++) { if (app.documents[i].id === requestedDocumentId) { app.activeDocument = app.documents[i]; break; } }',
        '  }',
        '  var doc = app.activeDocument;',
        '  if (requestedDocumentId > 0 && doc.id !== requestedDocumentId) throw new Error("CFB_ENHANCE_DOCUMENT_CHANGED");',
        '  var group = doc.layerSets.add(); group.name = "' + safeName + '";',
        '  app.displayDialogs = oldDialogs;',
        '  doneFile.open("w"); doneFile.write("OK," + group.id); doneFile.close();',
        '} catch(e) {',
        '  try { app.displayDialogs = oldDialogs; } catch(ignore) {}',
        '  doneFile.open("w"); doneFile.write("ERROR," + String(e.message || "CFB_CREATE_GROUP_FAILED")); doneFile.close();',
        '}'
    ].join('\r\n');
    fs.writeFileSync(scriptPath, jsx);
    await runScript(scriptPath, donePath);
    const result = fs.readFileSync(path.join(TEMP_DIR, "comfy_enhance_create_group_done.txt"), 'utf8');
    if (result.indexOf('OK,') !== 0) throw new Error(result.indexOf('CFB_ENHANCE_DOCUMENT_CHANGED') >= 0 ? 'Активный документ Photoshop изменился.' : 'Photoshop не смог создать группу для тайлов.');
    return Number(result.split(',')[1]) || 0;
}

async function exportDocumentTile(x, y, width, height, tileIndex = 0, documentId = null) {
    const token = Date.now() + '_' + Math.max(0, Math.round(Number(tileIndex) || 0));
    const exportFileName = 'ps_enhance_auto_tile_' + token + '.png';
    const coordsFileName = 'comfy_enhance_auto_tile_' + token + '_coords.txt';
    const doneFileName = 'comfy_enhance_auto_tile_' + token + '_done.txt';
    const exportPngPath = path.join(TEMP_DIR, exportFileName).split(path.sep).join('/');
    const coordsPath = path.join(TEMP_DIR, coordsFileName).split(path.sep).join('/');
    const donePath = path.join(TEMP_DIR, doneFileName).split(path.sep).join('/');
    const scriptPath = path.join(TEMP_DIR, 'comfy_enhance_auto_tile_' + token + '.jsx');
    const tileX = Math.max(0, Math.round(Number(x) || 0));
    const tileY = Math.max(0, Math.round(Number(y) || 0));
    const tileWidth = Math.max(1, Math.round(Number(width) || 1));
    const tileHeight = Math.max(1, Math.round(Number(height) || 1));
    const requestedDocumentId = Math.max(0, Math.round(Number(documentId) || 0));
    const jsx = [
        'var oldDialogs = app.displayDialogs; app.displayDialogs = DialogModes.NO;',
        'var doneFile = new File("' + donePath + '");',
        'var sourceDoc = null, tempDoc = null;',
        'try {',
        '  var requestedDocumentId = ' + requestedDocumentId + ';',
        '  if (requestedDocumentId > 0) {',
        '    for (var i = 0; i < app.documents.length; i++) { if (app.documents[i].id === requestedDocumentId) { app.activeDocument = app.documents[i]; break; } }',
        '  }',
        '  sourceDoc = app.activeDocument;',
        '  if (requestedDocumentId > 0 && sourceDoc.id !== requestedDocumentId) throw new Error("CFB_ENHANCE_DOCUMENT_CHANGED");',
        '  var x = ' + tileX + ', y = ' + tileY + ', w = ' + tileWidth + ', h = ' + tileHeight + ';',
        '  sourceDoc.selection.select([[UnitValue(x, "px"), UnitValue(y, "px")], [UnitValue(x + w, "px"), UnitValue(y, "px")], [UnitValue(x + w, "px"), UnitValue(y + h, "px")], [UnitValue(x, "px"), UnitValue(y + h, "px")]]);',
        '  var coordsFile = new File("' + coordsPath + '"); coordsFile.open("w"); coordsFile.write(x + "," + y + "," + w + "," + h); coordsFile.close();',
        '  sourceDoc.selection.copy(true);',
        '  tempDoc = app.documents.add(UnitValue(w, "px"), UnitValue(h, "px"), sourceDoc.resolution, "ComfyEnhanceAutoTile", NewDocumentMode.RGB, DocumentFill.TRANSPARENT);',
        '  try { tempDoc.bitsPerChannel = sourceDoc.bitsPerChannel; } catch(ignore) {}',
        '  try { if (sourceDoc.colorProfileName != "") tempDoc.colorProfileName = sourceDoc.colorProfileName; } catch(ignore) {}',
        '  tempDoc.paste();',
        '  var file = new File("' + exportPngPath + '"); var opts = new PNGSaveOptions(); opts.compression = 6; opts.transparency = true;',
        '  tempDoc.saveAs(file, opts, true, Extension.LOWERCASE); tempDoc.close(SaveOptions.DONOTSAVECHANGES); tempDoc = null;',
        '  app.activeDocument = sourceDoc; sourceDoc.selection.deselect(); app.displayDialogs = oldDialogs;',
        '  doneFile.open("w"); doneFile.write("OK"); doneFile.close();',
        '} catch(e) {',
        '  try { if (tempDoc) tempDoc.close(SaveOptions.DONOTSAVECHANGES); } catch(ignore) {}',
        '  try { if (sourceDoc) { app.activeDocument = sourceDoc; sourceDoc.selection.deselect(); } } catch(ignore) {}',
        '  try { app.displayDialogs = oldDialogs; } catch(ignore) {}',
        '  doneFile.open("w"); doneFile.write("ERROR," + String(e.message || "CFB_TILE_EXPORT_FAILED")); doneFile.close();',
        '}'
    ].join('\r\n');
    fs.writeFileSync(scriptPath, jsx);
    await runScript(scriptPath, donePath);
    const result = fs.readFileSync(path.join(TEMP_DIR, doneFileName), 'utf8');
    if (result !== 'OK') throw new Error(result.indexOf('CFB_ENHANCE_DOCUMENT_CHANGED') >= 0 ? 'Активный документ Photoshop изменился.' : 'Photoshop не смог экспортировать тайл ' + (Number(tileIndex) + 1) + '.');
    return {
        filePath: path.join(TEMP_DIR, exportFileName),
        coordsPath: path.join(TEMP_DIR, coordsFileName),
        x: tileX,
        y: tileY,
        width: tileWidth,
        height: tileHeight,
        documentId: requestedDocumentId
    };
}

async function exportActiveLayerVisible(maxMegapixels = 1) {
    const exportPngPath = path.join(TEMP_DIR, "ps_vector_temp.png").split(path.sep).join('/');
    const scriptPath = path.join(TEMP_DIR, "comfy_vector_export.jsx");
    const donePath = path.join(TEMP_DIR, "comfy_vector_export_done.txt").split(path.sep).join('/');
    const maxPixels = Math.max(1, Number(maxMegapixels) || 1) * 1000000;
    const jsx = `
        var oldDialogs = app.displayDialogs; app.displayDialogs = DialogModes.NO;
        var sourceDoc = null, tempDoc = null;
        var doneFile = new File("${donePath}");
        try {
            sourceDoc = app.activeDocument;
            var sourceLayer = sourceDoc.activeLayer;
            tempDoc = app.documents.add(sourceDoc.width, sourceDoc.height, sourceDoc.resolution, "ComfyVectorTemp", NewDocumentMode.RGB, DocumentFill.TRANSPARENT);
            try { tempDoc.bitsPerChannel = sourceDoc.bitsPerChannel; } catch(e) {}
            app.activeDocument = sourceDoc;
            var copiedLayer = sourceLayer.duplicate(tempDoc, ElementPlacement.PLACEATBEGINNING);
            app.activeDocument = tempDoc;
            tempDoc.activeLayer = copiedLayer;
            copiedLayer.visible = true;

            var copiedBounds = copiedLayer.bounds;
            var sourceX = Math.round(copiedBounds[0].as('px'));
            var sourceY = Math.round(copiedBounds[1].as('px'));
            var visibleW = Math.round(copiedBounds[2].as('px') - copiedBounds[0].as('px'));
            var visibleH = Math.round(copiedBounds[3].as('px') - copiedBounds[1].as('px'));
            if (visibleW < 1 || visibleH < 1) throw new Error("CFB_EMPTY_ACTIVE_LAYER");
            tempDoc.trim(TrimType.TRANSPARENT, true, true, true, true);

            var originalW = Math.round(tempDoc.width.as('px')), originalH = Math.round(tempDoc.height.as('px'));
            if (originalW < 1 || originalH < 1) throw new Error("CFB_EMPTY_ACTIVE_LAYER");
            var targetW = originalW, targetH = originalH;
            var pixels = originalW * originalH;
            if (pixels > ${maxPixels}) {
                var scale = Math.sqrt(${maxPixels} / pixels);
                targetW = Math.max(1, Math.round(originalW * scale));
                targetH = Math.max(1, Math.round(originalH * scale));
                while (targetW * targetH > ${maxPixels}) {
                    if (targetW >= targetH) targetW--; else targetH--;
                }
                tempDoc.resizeImage(UnitValue(targetW, 'px'), UnitValue(targetH, 'px'), sourceDoc.resolution, ResampleMethod.BICUBICSHARPER);
            }

            var file = new File("${exportPngPath}");
            var opts = new PNGSaveOptions(); opts.compression = 6; opts.transparency = true;
            tempDoc.saveAs(file, opts, true, Extension.LOWERCASE);
            tempDoc.close(SaveOptions.DONOTSAVECHANGES);
            app.activeDocument = sourceDoc;
            app.displayDialogs = oldDialogs;
            doneFile.open("w"); doneFile.write("OK," + originalW + "," + originalH + "," + targetW + "," + targetH + "," + sourceX + "," + sourceY); doneFile.close();
        } catch(e) {
            try { if (tempDoc) tempDoc.close(SaveOptions.DONOTSAVECHANGES); } catch(ignore) {}
            try { app.activeDocument = sourceDoc; } catch(ignore) {}
            app.displayDialogs = oldDialogs;
            var errorCode = "";
            try { errorCode = String(e.message || ""); } catch(ignore) {}
            if (errorCode.indexOf("CFB_") !== 0) errorCode = "CFB_VECTOR_EXPORT_FAILED";
            doneFile.open("w"); doneFile.write("ERROR," + errorCode); doneFile.close();
        }
    `;
    fs.writeFileSync(scriptPath, jsx);
    await runScript(scriptPath, donePath);
    const result = fs.readFileSync(path.join(TEMP_DIR, "comfy_vector_export_done.txt"), 'utf8');
    if (result.indexOf("OK,") !== 0) {
        const errorCode = result.replace(/^ERROR,?/, '');
        if (errorCode === 'CFB_EMPTY_ACTIVE_LAYER') throw new Error('Активный слой не содержит видимых пикселей.');
        throw new Error('Photoshop не смог подготовить активный слой для векторизации.');
    }
    const parts = result.split(',');
    return {
        filePath: path.join(TEMP_DIR, "ps_vector_temp.png"),
        originalWidth: Number(parts[1]) || 0,
        originalHeight: Number(parts[2]) || 0,
        width: Number(parts[3]) || 0,
        height: Number(parts[4]) || 0,
        x: Number(parts[5]) || 0,
        y: Number(parts[6]) || 0
    };
}

async function getVisibleLayersForUpscale() {
    const scriptPath = path.join(TEMP_DIR, "comfy_visible_upscale_layers.jsx");
    const donePath = path.join(TEMP_DIR, "comfy_visible_upscale_layers_done.txt").split(path.sep).join('/');
    const jsx = `
        var oldDialogs = app.displayDialogs; app.displayDialogs = DialogModes.NO;
        var doneFile = new File("${donePath}");
        function isRenderableArtLayer(layer) {
            if (!layer || layer.typename !== "ArtLayer") return false;
            try {
                var kind = String(layer.kind);
                return kind === "LayerKind.NORMAL" ||
                    kind === "LayerKind.SMARTOBJECT" ||
                    kind === "LayerKind.TEXT" ||
                    kind === "LayerKind.SOLIDFILL" ||
                    kind === "LayerKind.GRADIENTFILL" ||
                    kind === "LayerKind.PATTERNFILL" ||
                    kind === "LayerKind.VIDEO" ||
                    kind === "LayerKind.LAYER3D";
            } catch(e) { return true; }
        }
        function hasPixelBounds(layer) {
            try {
                var bounds = layer.bounds;
                return bounds[2].as("px") > bounds[0].as("px") && bounds[3].as("px") > bounds[1].as("px");
            } catch(e) { return false; }
        }
        function collectVisible(container, parentPath, rows) {
            for (var index = 0; index < container.layers.length; index++) {
                var layer = container.layers[index];
                if (!layer.visible) continue;
                if (layer.typename === "LayerSet") {
                    if (String(layer.name).indexOf("Upscale ") === 0) continue;
                    collectVisible(layer, parentPath ? parentPath + " / " + layer.name : layer.name, rows);
                } else if (isRenderableArtLayer(layer) && hasPixelBounds(layer)) {
                    var displayName = parentPath ? parentPath + " / " + layer.name : layer.name;
                    rows.push(String(layer.id) + "\\t" + encodeURIComponent(layer.name) + "\\t" + encodeURIComponent(displayName));
                }
            }
        }
        try {
            var doc = app.activeDocument;
            var rows = [];
            collectVisible(doc, "", rows);
            app.displayDialogs = oldDialogs;
            doneFile.open("w");
            doneFile.write("OK\\t" + String(doc.id) + "\\n" + rows.join("\\n"));
            doneFile.close();
        } catch(e) {
            try { app.displayDialogs = oldDialogs; } catch(ignore) {}
            doneFile.open("w"); doneFile.write("ERROR\\t" + encodeURIComponent(String(e.message || "CFB_VISIBLE_LAYER_LIST_FAILED"))); doneFile.close();
        }
    `;
    fs.writeFileSync(scriptPath, jsx);
    await runScript(scriptPath, donePath);
    const result = fs.readFileSync(path.join(TEMP_DIR, "comfy_visible_upscale_layers_done.txt"), 'utf8');
    if (result.indexOf('OK\t') !== 0) throw new Error('Photoshop не смог получить список видимых слоёв.');
    const lines = result.split(/\r?\n/);
    const header = lines.shift().split('\t');
    const documentId = Number(header[1]) || 0;
    const layers = lines.filter(Boolean).map(line => {
        const parts = line.split('\t');
        return {
            id: Number(parts[0]) || 0,
            name: decodeURIComponent(parts[1] || ''),
            displayName: decodeURIComponent(parts[2] || parts[1] || '')
        };
    }).filter(layer => layer.id > 0);
    return { documentId, layers };
}

async function exportActiveLayerForUpscale(maxMegapixels = 1, layerId = null, documentId = null) {
    const exportPngPath = path.join(TEMP_DIR, "ps_upscale_layer_temp.png").split(path.sep).join('/');
    const coordsPath = path.join(TEMP_DIR, "comfy_upscale_layer_coords.txt");
    const scriptPath = path.join(TEMP_DIR, "comfy_upscale_layer_export.jsx");
    const donePath = path.join(TEMP_DIR, "comfy_upscale_layer_export_done.txt").split(path.sep).join('/');
    const maxPixels = Math.max(1, Number(maxMegapixels) || 1) * 1000000;
    const requestedLayerId = Math.max(0, Math.round(Number(layerId) || 0));
    const requestedDocumentId = Math.max(0, Math.round(Number(documentId) || 0));
    const jsx = `
        var oldDialogs = app.displayDialogs; app.displayDialogs = DialogModes.NO;
        var sourceDoc = null, tempDoc = null;
        var doneFile = new File("${donePath}");
        function cID(value) { return charIDToTypeID(value); }
        var requestedLayerId = ${requestedLayerId};
        var requestedDocumentId = ${requestedDocumentId};
        function selectLayerById(targetLayerId) {
            var desc = new ActionDescriptor(), ref = new ActionReference();
            ref.putIdentifier(cID("Lyr "), targetLayerId);
            desc.putReference(cID("null"), ref);
            desc.putBoolean(cID("MkVs"), false);
            executeAction(cID("slct"), desc, DialogModes.NO);
        }
        function hasUserMask() {
            try { var ref = new ActionReference(); ref.putEnumerated(cID("Lyr "), cID("Ordn"), cID("Trgt")); return executeActionGet(ref).hasKey(cID("UsrM")); } catch(e) { return false; }
        }
        function removeUserMask() {
            var desc = new ActionDescriptor(), ref = new ActionReference();
            ref.putEnumerated(cID("Chnl"), cID("Chnl"), cID("Msk "));
            desc.putReference(cID("null"), ref);
            executeAction(cID("Dlt "), desc, DialogModes.NO);
        }
        try {
            sourceDoc = app.activeDocument;
            if (requestedDocumentId > 0 && sourceDoc.id !== requestedDocumentId) throw new Error("CFB_UPSCALE_DOCUMENT_CHANGED");
            if (requestedLayerId > 0) selectLayerById(requestedLayerId);
            var sourceLayer = sourceDoc.activeLayer;
            var sourceHadMask = hasUserMask() ? 1 : 0;
            tempDoc = app.documents.add(sourceDoc.width, sourceDoc.height, sourceDoc.resolution, "ComfyUpscaleLayerTemp", NewDocumentMode.RGB, DocumentFill.TRANSPARENT);
            app.activeDocument = sourceDoc;
            var copiedLayer = sourceLayer.duplicate(tempDoc, ElementPlacement.PLACEATBEGINNING);
            app.activeDocument = tempDoc;
            tempDoc.activeLayer = copiedLayer;
            try { if (hasUserMask()) removeUserMask(); } catch(e) {}
            copiedLayer.visible = true;
            var copiedBounds = copiedLayer.bounds;
            var sourceX = Math.round(copiedBounds[0].as('px'));
            var sourceY = Math.round(copiedBounds[1].as('px'));
            var originalW = Math.round(copiedBounds[2].as('px') - copiedBounds[0].as('px'));
            var originalH = Math.round(copiedBounds[3].as('px') - copiedBounds[1].as('px'));
            if (originalW < 1 || originalH < 1) throw new Error("CFB_EMPTY_ACTIVE_LAYER");
            tempDoc.trim(TrimType.TRANSPARENT, true, true, true, true);
            var targetW = originalW, targetH = originalH;
            if (originalW * originalH > ${maxPixels}) {
                var scale = Math.sqrt(${maxPixels} / (originalW * originalH));
                targetW = Math.max(1, Math.round(originalW * scale));
                targetH = Math.max(1, Math.round(originalH * scale));
                while (targetW * targetH > ${maxPixels}) { if (targetW >= targetH) targetW--; else targetH--; }
                tempDoc.resizeImage(UnitValue(targetW, 'px'), UnitValue(targetH, 'px'), sourceDoc.resolution, ResampleMethod.BICUBICSHARPER);
            }
            var file = new File("${exportPngPath}"); var opts = new PNGSaveOptions(); opts.compression = 6; opts.transparency = true;
            tempDoc.saveAs(file, opts, true, Extension.LOWERCASE); tempDoc.close(SaveOptions.DONOTSAVECHANGES);
            app.activeDocument = sourceDoc; app.displayDialogs = oldDialogs;
            doneFile.open("w"); doneFile.write("OK," + originalW + "," + originalH + "," + targetW + "," + targetH + "," + sourceX + "," + sourceY + "," + sourceHadMask + "," + sourceLayer.id + "," + sourceDoc.id + "," + encodeURIComponent(sourceLayer.name)); doneFile.close();
        } catch(e) {
            try { if (tempDoc) tempDoc.close(SaveOptions.DONOTSAVECHANGES); } catch(ignore) {}
            try { app.activeDocument = sourceDoc; } catch(ignore) {}
            app.displayDialogs = oldDialogs;
            doneFile.open("w"); doneFile.write("ERROR," + String(e.message || "CFB_UPSCALE_LAYER_EXPORT_FAILED")); doneFile.close();
        }
    `;
    fs.writeFileSync(scriptPath, jsx);
    await runScript(scriptPath, donePath);
    const result = fs.readFileSync(path.join(TEMP_DIR, "comfy_upscale_layer_export_done.txt"), 'utf8');
    if (result.indexOf('OK,') !== 0) throw new Error(result.indexOf('CFB_EMPTY_ACTIVE_LAYER') >= 0 ? 'Активный слой не содержит видимых пикселей.' : (result.indexOf('CFB_UPSCALE_DOCUMENT_CHANGED') >= 0 ? 'Во время пакетного Upscale был переключён документ Photoshop.' : 'Photoshop не смог подготовить активный слой для Upscale.'));
    const parts = result.split(',');
    const originalWidth = Number(parts[1]) || 0, originalHeight = Number(parts[2]) || 0;
    const width = Number(parts[3]) || 0, height = Number(parts[4]) || 0;
    const x = Number(parts[5]) || 0, y = Number(parts[6]) || 0;
    fs.writeFileSync(coordsPath, [x, y, originalWidth, originalHeight].join(','), 'utf8');
    return { filePath: path.join(TEMP_DIR, "ps_upscale_layer_temp.png"), coordsPath, originalWidth, originalHeight, originalPixels: originalWidth * originalHeight, width, height, wasReduced: originalWidth * originalHeight > maxPixels, sourceHadMask: parts[7] === '1', sourceLayerId: Number(parts[8]) || requestedLayerId, documentId: Number(parts[9]) || requestedDocumentId, sourceLayerName: decodeURIComponent(parts[10] || '') };
}

async function exportDocument() {
    const exportPngPath = path.join(TEMP_DIR, "ps_export_temp.png").replace(/\\/g, '/');
    const scriptPath = path.join(TEMP_DIR, "comfy_export.jsx");
    const donePath = path.join(TEMP_DIR, "comfy_export_done.txt").replace(/\\/g, '/');
    const jsx = `
        var oldDialogs = app.displayDialogs; app.displayDialogs = DialogModes.NO;
        var doc = app.activeDocument; var file = new File("${exportPngPath}");
        var opts = new PNGSaveOptions(); opts.compression = 6;
        doc.saveAs(file, opts, true, Extension.LOWERCASE);
        app.displayDialogs = oldDialogs; var doneFile = new File("${donePath}"); doneFile.open("w"); doneFile.write("ok"); doneFile.close();
    `;
    fs.writeFileSync(scriptPath, jsx);
    await runScript(scriptPath, donePath);
    return path.join(TEMP_DIR, "ps_export_temp.png");
}

async function exportDocumentOverview(maxDimension = 1400, documentId = null) {
    const limit = Math.max(512, Math.min(2048, Math.round(Number(maxDimension) || 1400)));
    const outputPath = path.join(TEMP_DIR, 'comfy_enhance_overview.png').replace(/\\/g, '/');
    const scriptPath = path.join(TEMP_DIR, 'comfy_enhance_overview.jsx');
    const donePath = path.join(TEMP_DIR, 'comfy_enhance_overview_done.txt').replace(/\\/g, '/');
    const requestedDocumentId = Number(documentId) || 0;
    const jsx = [
        'var oldDialogs = app.displayDialogs; app.displayDialogs = DialogModes.NO;',
        'var doneFile = new File("' + donePath + '");',
        'try {',
        '  var source = app.activeDocument;',
        requestedDocumentId > 0 ? '  for (var i=0; i<app.documents.length; i++) { if (app.documents[i].id === ' + requestedDocumentId + ') { source = app.documents[i]; break; } }' : '',
        '  var copy = source.duplicate("CFB_Gemini_Overview", true);',
        '  var w = copy.width.as("px"), h = copy.height.as("px");',
        '  var scale = Math.min(1, ' + limit + ' / Math.max(w, h));',
        '  if (scale < 1) copy.resizeImage(UnitValue(Math.max(1, Math.round(w*scale)), "px"), UnitValue(Math.max(1, Math.round(h*scale)), "px"), undefined, ResampleMethod.BICUBICSHARPER);',
        '  var opts = new PNGSaveOptions(); opts.compression = 6;',
        '  copy.saveAs(new File("' + outputPath + '"), opts, true, Extension.LOWERCASE);',
        '  copy.close(SaveOptions.DONOTSAVECHANGES);',
        '  app.activeDocument = source;',
        '  app.displayDialogs = oldDialogs;',
        '  doneFile.open("w"); doneFile.write("OK"); doneFile.close();',
        '} catch(e) {',
        '  try { app.displayDialogs = oldDialogs; } catch(ignore) {}',
        '  doneFile.open("w"); doneFile.write("ERROR: " + e.message); doneFile.close();',
        '}'
    ].filter(Boolean).join('\r\n');
    fs.writeFileSync(scriptPath, '\uFEFF' + jsx, 'utf8');
    await runScript(scriptPath, donePath);
    const result = fs.existsSync(path.join(TEMP_DIR, 'comfy_enhance_overview_done.txt'))
        ? fs.readFileSync(path.join(TEMP_DIR, 'comfy_enhance_overview_done.txt'), 'utf8') : '';
    if (result !== 'OK') throw new Error('Photoshop не смог создать обзор для Gemini' + (result ? ': ' + result : '.'));
    return path.join(TEMP_DIR, 'comfy_enhance_overview.png');
}


async function placeSvg(svgText, targetWidth, targetHeight, targetX, targetY, layerName = null) {
    if (!svgText || svgText.toLowerCase().indexOf('<svg') === -1) {
        throw new Error('Некорректный SVG для вставки в Photoshop.');
    }
    const svgPath = path.join(TEMP_DIR, "comfy_vector_result.svg").replace(/\\/g, '/');
    const scriptPath = path.join(TEMP_DIR, "comfy_place_svg.jsx");
    const donePath = path.join(TEMP_DIR, "comfy_place_svg_done.txt").replace(/\\/g, '/');
    const safeLayerName = layerName ? String(layerName).replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '\\"').slice(0, 80) : "";
    fs.writeFileSync(path.join(TEMP_DIR, "comfy_vector_result.svg"), svgText, 'utf8');

    const jsx = `
        var oldDialogs = app.displayDialogs; app.displayDialogs = DialogModes.NO;
        var doneFile = new File("${donePath}");
        try {
            var doc = app.activeDocument;
            var desc = new ActionDescriptor();
            desc.putPath(charIDToTypeID("null"), new File("${svgPath}"));
            desc.putEnumerated(charIDToTypeID("FTcs"), charIDToTypeID("QCSt"), charIDToTypeID("Qcsa"));
            executeAction(charIDToTypeID("Plc "), desc, DialogModes.NO);

            var layer = doc.activeLayer;
            try { layer.name = "${safeLayerName}"; } catch(e) {}
            var bounds = layer.bounds;
            var currentWidth = bounds[2].as('px') - bounds[0].as('px');
            var currentHeight = bounds[3].as('px') - bounds[1].as('px');
            if (currentWidth <= 0 || currentHeight <= 0) throw new Error("CFB_SVG_EMPTY");
            layer.resize((${Number(targetWidth)} / currentWidth) * 100, (${Number(targetHeight)} / currentHeight) * 100, AnchorPosition.TOPLEFT);

            bounds = layer.bounds;
            layer.translate(UnitValue(${Number(targetX)} - bounds[0].as('px'), 'px'), UnitValue(${Number(targetY)} - bounds[1].as('px'), 'px'));
            app.displayDialogs = oldDialogs;
            doneFile.open("w"); doneFile.write("OK"); doneFile.close();
        } catch(e) {
            try { app.displayDialogs = oldDialogs; } catch(ignore) {}
            doneFile.open("w"); doneFile.write("ERROR"); doneFile.close();
        }
    `;
    fs.writeFileSync(scriptPath, jsx);
    await runScript(scriptPath, donePath);
    const result = fs.readFileSync(path.join(TEMP_DIR, "comfy_place_svg_done.txt"), 'utf8');
    if (result !== 'OK') throw new Error('Photoshop не смог вставить SVG как Smart Object.');
}

async function placeImage(resultBuffer, useCoords, coordsPath, layerName = null, copySourceLayerMask = false, fitResultToSelection = false, addLayerMask = false, fadeMaskPath = null, sourceLayerId = null, targetDocumentId = null, targetGroupId = null, expandedCanvas = null) {
    const resultPngPath = path.join(TEMP_DIR, "comfy_result.png").replace(/\\/g, '/');
    fs.writeFileSync(path.join(TEMP_DIR, "comfy_result.png"), Buffer.from(resultBuffer));
    const resultSize = getPngDimensions(path.join(TEMP_DIR, "comfy_result.png"));
    if (!resultSize.width || !resultSize.height) throw new Error('ComfyUI returned an invalid PNG image.');
    if (expandedCanvas) {
        for (const key of ['width', 'height', 'left', 'top', 'right', 'bottom']) {
            if (!Number.isInteger(expandedCanvas[key]) || expandedCanvas[key] < 0) throw new Error('Некорректные размеры расширения холста.');
        }
        if (!targetDocumentId || resultSize.width !== expandedCanvas.width + expandedCanvas.left + expandedCanvas.right || resultSize.height !== expandedCanvas.height + expandedCanvas.top + expandedCanvas.bottom) {
            throw new Error('Размер дорисованного изображения не совпадает с запрошенным холстом.');
        }
    }
    const scriptPath = path.join(TEMP_DIR, "comfy_place.jsx");
    const donePath = path.join(TEMP_DIR, "comfy_place_done.txt").replace(/\\/g, '/');
    
    const safeLayerName = layerName ? String(layerName).replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '\\"').slice(0, 80) : "";
    const safeFadeMaskPath = fadeMaskPath ? String(fadeMaskPath).replace(/\\/g, '/').replace(/"/g, '\\"') : "";
    const requestedSourceLayerId = Math.max(0, Math.round(Number(sourceLayerId) || 0));
    const requestedDocumentId = Math.max(0, Math.round(Number(targetDocumentId) || 0));
    const requestedTargetGroupId = Math.max(0, Math.round(Number(targetGroupId) || 0));

    const jsx = `
        var oldDialogs = app.displayDialogs; app.displayDialogs = DialogModes.NO;
        var requestedSourceLayerId = ${requestedSourceLayerId};
        var requestedDocumentId = ${requestedDocumentId};
        var requestedTargetGroupId = ${requestedTargetGroupId};
        try {
        if (requestedDocumentId > 0) {
            for (var docIndex = 0; docIndex < app.documents.length; docIndex++) {
                if (app.documents[docIndex].id === requestedDocumentId) { app.activeDocument = app.documents[docIndex]; break; }
            }
        }
        var doc = app.activeDocument;
        ${expandedCanvas ? `
        if (doc.id !== requestedDocumentId) throw new Error("Исходный документ Photoshop закрыт.");
        if (Math.round(doc.width.as('px')) !== ${expandedCanvas.width} || Math.round(doc.height.as('px')) !== ${expandedCanvas.height}) {
            throw new Error("Размер исходного документа изменился во время дорисовки.");
        }
        // First add left/top, moving existing content; then add right/bottom.
        doc.resizeCanvas(UnitValue(${expandedCanvas.width + expandedCanvas.left}, 'px'), UnitValue(${expandedCanvas.height + expandedCanvas.top}, 'px'), AnchorPosition.BOTTOMRIGHT);
        doc.resizeCanvas(UnitValue(${resultSize.width}, 'px'), UnitValue(${resultSize.height}, 'px'), AnchorPosition.TOPLEFT);
        ` : ''}
        function cID(value) { return charIDToTypeID(value); }
        function findLayerById(container, layerId) {
            for (var findIndex = 0; findIndex < container.layers.length; findIndex++) {
                var candidate = container.layers[findIndex];
                if (candidate.id === layerId) return candidate;
                if (candidate.typename === "LayerSet") {
                    var nested = findLayerById(candidate, layerId);
                    if (nested) return nested;
                }
            }
            return null;
        }
        function hasUserMask(layerId) {
            try {
                var ref = new ActionReference();
                ref.putIdentifier(cID("Lyr "), layerId);
                var info = executeActionGet(ref);
                var presentKey = stringIDToTypeID("hasUserMask");
                var enabledKey = stringIDToTypeID("userMaskEnabled");
                var isPresent = info.hasKey(presentKey) && info.getBoolean(presentKey);
                return isPresent || info.hasKey(enabledKey);
            } catch(e) { return false; }
        }
        function selectLayerById(layerId) {
            var desc = new ActionDescriptor(), ref = new ActionReference();
            ref.putIdentifier(cID("Lyr "), layerId);
            desc.putReference(cID("null"), ref);
            desc.putBoolean(cID("MkVs"), false);
            executeAction(cID("slct"), desc, DialogModes.NO);
        }
        function addMaskFromCurrentSelection() {
            var desc = new ActionDescriptor(), at = new ActionReference();
            desc.putClass(cID("Nw  "), cID("Chnl"));
            at.putEnumerated(cID("Chnl"), cID("Chnl"), cID("Msk "));
            desc.putReference(cID("At  "), at);
            desc.putEnumerated(cID("Usng"), cID("UsrM"), cID("RvlS"));
            executeAction(cID("Mk  "), desc, DialogModes.NO);
            doc.selection.deselect();
        }
        function loadActiveLayerTransparencySelection() {
            var idChnl = cID("Chnl");
            var selectionRef = new ActionReference();
            selectionRef.putProperty(idChnl, cID("fsel"));
            var transparencyRef = new ActionReference();
            transparencyRef.putEnumerated(idChnl, idChnl, cID("Trsp"));
            var desc = new ActionDescriptor();
            desc.putReference(cID("null"), selectionRef);
            desc.putReference(cID("T   "), transparencyRef);
            executeAction(cID("setd"), desc, DialogModes.NO);
        }
        function loadLayerMaskAsSelection(layerId) {
            var selectionRef = new ActionReference();
            selectionRef.putProperty(cID("Chnl"), cID("fsel"));
            var maskRef = new ActionReference();
            maskRef.putEnumerated(cID("Chnl"), cID("Chnl"), cID("Msk "));
            maskRef.putIdentifier(cID("Lyr "), layerId);
            var desc = new ActionDescriptor();
            desc.putReference(cID("null"), selectionRef);
            desc.putReference(cID("T   "), maskRef);
            executeAction(cID("setd"), desc, DialogModes.NO);
        }
        function loadExactFadeSelection(maskFile, targetX, targetY, targetW, targetH) {
            if (!maskFile.exists) throw new Error("Fade mask file is missing.");
            var maskDoc = null, temporaryMaskLayer = null;
            try {
                maskDoc = app.open(maskFile);
                try { if (maskDoc.activeLayer.isBackgroundLayer) maskDoc.activeLayer.isBackgroundLayer = false; } catch(ignore) {}
                var sourceW = maskDoc.width.as("px"), sourceH = maskDoc.height.as("px");
                var paddedW = Math.max(sourceW, Math.ceil(targetX + targetW));
                var paddedH = Math.max(sourceH, Math.ceil(targetY + targetH));
                maskDoc.resizeCanvas(UnitValue(paddedW, "px"), UnitValue(paddedH, "px"), AnchorPosition.BOTTOMRIGHT);
                maskDoc.resizeCanvas(doc.width, doc.height, AnchorPosition.TOPLEFT);
                temporaryMaskLayer = maskDoc.activeLayer.duplicate(doc, ElementPlacement.PLACEATBEGINNING);
                maskDoc.close(SaveOptions.DONOTSAVECHANGES);
                maskDoc = null;
                app.activeDocument = doc;
                selectLayerById(temporaryMaskLayer.id);
                loadActiveLayerTransparencySelection();
                temporaryMaskLayer.remove();
            } catch(e) {
                try { if (maskDoc) maskDoc.close(SaveOptions.DONOTSAVECHANGES); } catch(ignore) {}
                try { app.activeDocument = doc; if (temporaryMaskLayer) temporaryMaskLayer.remove(); } catch(ignore) {}
                throw e;
            }
        }

        if (requestedSourceLayerId > 0) {
            try { selectLayerById(requestedSourceLayerId); } catch(ignore) {}
        }
        var sourcePsLayer = doc.activeLayer;
        var sourcePsLayerId = sourcePsLayer.id;
        var sourceHasMask = ${copySourceLayerMask ? 'true' : 'false'};
        
        var selW = 0, selH = 0, x = 0, y = 0;
        ${useCoords ? `
        var coordsFile = new File("${coordsPath.replace(/\\/g, '\\\\')}"); 
        if (coordsFile.exists) { 
            coordsFile.open("r"); 
            var str = coordsFile.read(); 
            var parts = str.split(","); 
            if (parts.length >= 4) {
                x = parseFloat(parts[0]); y = parseFloat(parts[1]); 
                selW = parseFloat(parts[2]); selH = parseFloat(parts[3]); 
            }
            coordsFile.close(); 
        }
        ` : ''}
        
        var file = new File("${resultPngPath}");
        var fadeMaskFile = new File("${safeFadeMaskPath}");
        var resultW = ${resultSize.width}, resultH = ${resultSize.height};
        var fitResultToSelection = ${fitResultToSelection ? "true" : "false"};
        var shouldAddLayerMask = ${addLayerMask ? "true" : "false"};
        
        // 1. Duplicate the raster result directly. Place Embedded applies its own DPI/smart-object transform.
        var tempDoc = app.open(file);
        // Convert the opened PNG background into a normal layer before expanding the canvas.
        // Added pixels must stay transparent, not be filled with the Photoshop background color.
        try { if (tempDoc.activeLayer.isBackgroundLayer) tempDoc.activeLayer.isBackgroundLayer = false; } catch(e) {}
        var currentW = tempDoc.width.as('px'), currentH = tempDoc.height.as('px');
        if (fitResultToSelection && selW > 0 && selH > 0) {
            // Enhance Image is rendered at a reduced ComfyUI size; scale its actual pixels
            // back to the original Photoshop selection before anchoring it to X/Y.
            tempDoc.resizeImage(UnitValue(selW, 'px'), UnitValue(selH, 'px'), doc.resolution, ResampleMethod.BICUBIC);
        } else if (selW > 0 && selH > 0 && (currentW < selW || currentH < selH)) {
            // Remove Background keeps pixels intact and only extends a transparent canvas.
            tempDoc.resizeCanvas(
                UnitValue(Math.max(currentW, selW), 'px'),
                UnitValue(Math.max(currentH, selH), 'px'),
                AnchorPosition.TOPLEFT
            );
        }
        // Match resolution without resampling: source pixels retain their exact values.
        tempDoc.resizeImage(undefined, undefined, doc.resolution, ResampleMethod.NONE);
        var sourceLayer = tempDoc.activeLayer;
        // Photoshop drops a layer's transparent canvas while duplicating it. Add a temporary
        // one-pixel anchor outside the source canvas so X/Y are measured from the PNG origin,
        // not from the first opaque pixel of the cut-out.
        var hasTransparentCanvasAnchor = false;
        if (selW > 0 && selH > 0) {
            var sourceCanvasW = tempDoc.width.as('px');
            var sourceCanvasH = tempDoc.height.as('px');
            tempDoc.resizeCanvas(UnitValue(sourceCanvasW + 1, 'px'), UnitValue(sourceCanvasH + 1, 'px'), AnchorPosition.BOTTOMRIGHT);
            var anchorLayer = tempDoc.artLayers.add();
            var anchorColor = new SolidColor(); anchorColor.rgb.red = 1; anchorColor.rgb.green = 1; anchorColor.rgb.blue = 1;
            var anchorZero = UnitValue(0, 'px'), anchorOne = UnitValue(1, 'px');
            tempDoc.selection.select([[anchorZero, anchorZero], [anchorOne, anchorZero], [anchorOne, anchorOne], [anchorZero, anchorOne]]);
            tempDoc.selection.fill(anchorColor, ColorBlendMode.NORMAL, 100, false);
            tempDoc.selection.deselect();
            anchorLayer.merge();
            sourceLayer = tempDoc.activeLayer;
            hasTransparentCanvasAnchor = true;
        }
        sourceLayer.duplicate(doc, ElementPlacement.PLACEATBEGINNING);
        tempDoc.close(SaveOptions.DONOTSAVECHANGES);
        app.activeDocument = doc;
        var layer = doc.activeLayer; 
        
        // Переименовываем
        ${layerName ? `try { layer.name = "${safeLayerName}"; } catch(e) {}` : ''}
        
        ${useCoords ? `
        // Pin the actual PNG canvas origin to the original selection X/Y.
        // The temporary anchor preserves transparent margins, which layer.bounds normally loses.
        if (selW > 0 && selH > 0) {
            var b = layer.bounds;
            if (hasTransparentCanvasAnchor) {
                layer.translate(UnitValue((x - 1) - b[0].as('px'), 'px'), UnitValue((y - 1) - b[1].as('px'), 'px'));
                // Remove only the artificial marker after it has served as a coordinate anchor.
                if (x > 0 && y > 0) {
                    doc.selection.select([[UnitValue(x - 1, 'px'), UnitValue(y - 1, 'px')], [UnitValue(x, 'px'), UnitValue(y - 1, 'px')], [UnitValue(x, 'px'), UnitValue(y, 'px')], [UnitValue(x - 1, 'px'), UnitValue(y, 'px')]]);
                    doc.selection.clear();
                    doc.selection.deselect();
                }
            } else {
                layer.translate(UnitValue(x - b[0].as('px'), 'px'), UnitValue(y - b[1].as('px'), 'px'));
            }
        }
        ` : ''}
        // The duplicated result is already a raster layer.
        try { layer.rasterize(RasterizeType.ENTIRELAYER); } catch(e) {}

        // 5. One editable pixel Layer Mask. The temporary source is deleted before the
        // script completes, leaving only the result layer and its exact 5% edge mask.
        if (shouldAddLayerMask) {
            var resultLayerId = layer.id;
            try {
                selectLayerById(resultLayerId);
                loadExactFadeSelection(
                    fadeMaskFile,
                    x, y,
                    selW > 0 ? selW : resultW,
                    selH > 0 ? selH : resultH
                );
                selectLayerById(resultLayerId);
                addMaskFromCurrentSelection();
            } catch(e) {
                try { doc.selection.deselect(); } catch(ignore) {}
            }
            try { selectLayerById(resultLayerId); layer = doc.activeLayer; } catch(ignore) {}
        }

        if (sourceHasMask && hasUserMask(sourcePsLayerId)) {
            var copyMaskResultLayerId = layer.id;
            try {
                loadLayerMaskAsSelection(sourcePsLayerId);
                selectLayerById(copyMaskResultLayerId);
                addMaskFromCurrentSelection();
            } catch(e) {
                try { doc.selection.deselect(); } catch(ignore) {}
            }
            try { selectLayerById(copyMaskResultLayerId); layer = doc.activeLayer; } catch(ignore) {}
        }

        // Upscale from an active Photoshop layer: keep the source for later edits,
        // but hide it and keep both versions together in one layer group.
        if (sourceHasMask) {
            try {
                var resultUpscaleLayer = layer;
                var upscaleGroup = doc.layerSets.add();
                upscaleGroup.name = "Upscale " + sourcePsLayer.name;
                sourcePsLayer.move(upscaleGroup, ElementPlacement.INSIDE);
                resultUpscaleLayer.move(upscaleGroup, ElementPlacement.INSIDE);
                sourcePsLayer.visible = false;
                try {
                    upscaleGroup.move(doc, ElementPlacement.PLACEATEND);
                } catch(moveError) {
                    try {
                        var bottomLayer = doc.layers[doc.layers.length - 1];
                        if (bottomLayer && bottomLayer.id !== upscaleGroup.id) upscaleGroup.move(bottomLayer, ElementPlacement.PLACEAFTER);
                    } catch(ignoreMove) {}
                }
                doc.activeLayer = resultUpscaleLayer;
                layer = resultUpscaleLayer;
            } catch(e) {
                try { selectLayerById(layer.id); } catch(ignore) {}
            }
        }

        if (requestedTargetGroupId > 0) {
            try {
                var targetGroup = findLayerById(doc, requestedTargetGroupId);
                if (targetGroup && targetGroup.typename === "LayerSet") {
                    layer.move(targetGroup, ElementPlacement.INSIDE);
                    doc.activeLayer = layer;
                }
            } catch(e) {}
        }
        app.displayDialogs = oldDialogs;
        var doneFile = new File("${donePath}"); doneFile.open("w"); doneFile.write("ok"); doneFile.close();
        } catch (placeError) {
            try { if (tempDoc) tempDoc.close(SaveOptions.DONOTSAVECHANGES); } catch(ignoreClose) {}
            try { app.displayDialogs = oldDialogs; } catch(ignoreDialogs) {}
            var errorFile = new File("${donePath}"); errorFile.encoding = "UTF8";
            errorFile.open("w"); errorFile.write("ERROR: " + placeError.message + " (line " + placeError.line + ")"); errorFile.close();
        }
    `;
    fs.writeFileSync(scriptPath, '\uFEFF' + jsx, 'utf8');
    await runScript(scriptPath, donePath);
    const placement = fs.readFileSync(donePath, 'utf8').replace(/^\uFEFF/, '').trim();
    if (placement !== 'ok') throw new Error('Photoshop не смог вставить изображение: ' + placement);
}

// Санитизация имени для PSD-файлов: только ASCII, без запрещённых символов Windows
function sanitizeForPSD(str) {
    return (str || "untitled").replace(/[\\/:*?"<>|]/g, '').replace(/\.psd|\.psb|\.png|\.jpg|\.jpeg/i, '').replace(/[^\x20-\x7e]/g, '_').trim().substring(0, 30);
}

function sanitizeForMockupName(value, fallback = 'Mockup', maximumLength = 160) {
    let result = String(value || '')
        .normalize('NFKC')
        .replace(/\.(psd|psb|png|jpe?g)$/i, '')
        .replace(/[\\/:*?"<>|]/g, ' ')
        .replace(/\s+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^[._\s]+|[._\s]+$/g, '');
    if (!result) result = fallback;
    result = result.slice(0, Math.max(8, maximumLength)).replace(/[._\s]+$/g, '');
    return result || fallback;
}

function escapeJsxText(value) {
    return String(value || '')
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\r?\n/g, ' ');
}

async function openMockupAndPlaceDesign(mockupBuffer, designPngPath, outputStem, designName, templateName = 'Template') {
    const safeOutputStem = sanitizeForMockupName(outputStem, 'Design__Mockup_001__LIB_Template', 160);
    const safeDesignName = sanitizeForMockupName(designName || 'Design', 'Design', 72);
    const safeTemplateName = sanitizeForMockupName(templateName || 'Template', 'Template', 72);
    const documentName = safeOutputStem + '.psd';
    const mockupPsdPath = path.join(TEMP_DIR, documentName).split(path.sep).join('/');
    const designPath = String(designPngPath).split(path.sep).join('/');
    const scriptPath = path.join(TEMP_DIR, 'comfy_mockup.jsx');
    const donePath = path.join(TEMP_DIR, 'comfy_mockup_done.txt').split(path.sep).join('/');
    fs.writeFileSync(mockupPsdPath, Buffer.from(mockupBuffer));

    const jsx = [
        'var oldDialogs = app.displayDialogs; app.displayDialogs = DialogModes.NO;',
        'var doneFile = new File("' + escapeJsxText(donePath) + '");',
        'try {',
        '  var mockupDoc = app.open(new File("' + escapeJsxText(mockupPsdPath) + '"));',
        '  var desc = new ActionDescriptor();',
        '  desc.putPath(charIDToTypeID("null"), new File("' + escapeJsxText(designPath) + '"));',
        '  desc.putEnumerated(charIDToTypeID("FTcs"), charIDToTypeID("QCSt"), charIDToTypeID("Qcsa"));',
        '  executeAction(charIDToTypeID("Plc "), desc, DialogModes.NO);',
        '  var layer = mockupDoc.activeLayer;',
        '  layer.rasterize(RasterizeType.ENTIRELAYER);',
        '  try { layer.name = "Design__' + escapeJsxText(safeDesignName) + '"; } catch(ignore) {}',
        '  try { layer.move(mockupDoc, ElementPlacement.PLACEATEND); } catch(ignore) {}',
        '  var docW = mockupDoc.width.as("px");',
        '  var curW = layer.bounds[2].as("px") - layer.bounds[0].as("px");',
        '  if (curW > 0) { var scale = (docW / curW) * 90; layer.resize(scale, scale, AnchorPosition.MIDDLECENTER); }',
        '  try { mockupDoc.info.caption = "ComfyFloatBar Library PSD: ' + escapeJsxText(safeTemplateName) + '"; } catch(ignore) {}',
        '  app.activeDocument = mockupDoc;',
        '  app.displayDialogs = oldDialogs;',
        '  doneFile.open("w"); doneFile.write("OK"); doneFile.close();',
        '} catch(e) {',
        '  try { app.displayDialogs = oldDialogs; } catch(ignore) {}',
        '  doneFile.open("w"); doneFile.write("ERROR: " + e.message); doneFile.close();',
        '}'
    ].join('\r\n');

    fs.writeFileSync(scriptPath, '\uFEFF' + jsx, 'utf8');
    await runScript(scriptPath, donePath);
    const resultPath = path.join(TEMP_DIR, 'comfy_mockup_done.txt');
    const result = fs.existsSync(resultPath) ? fs.readFileSync(resultPath, 'utf8') : '';
    if (result !== 'OK') throw new Error('Photoshop не смог открыть Library PSD' + (result ? ': ' + result : '.'));
    return documentName;
}

async function openGeneratedMockupAndPlaceDesign(mockupBuffer, designPngPath, outputStem, designName, options = {}) {
    const safeOutputStem = sanitizeForMockupName(outputStem, 'Design__Mockup_001__AI_WALL', 160);
    const safeDesignName = sanitizeForMockupName(designName || 'Design', 'Design', 72);
    const config = options && typeof options === 'object' ? options : {};
    const shouldPlaceDesign = config.placeDesign !== false;
    const mockupKind = config.mockupKind === 'art_triple'
        ? 'art_triple'
        : (config.mockupKind === 'art_single' ? 'art_single' : 'wallpaper');
    const backgroundLayerName = mockupKind === 'art_triple'
        ? 'Mockup__AI_Artwork_3'
        : (mockupKind === 'art_single' ? 'Mockup__AI_Artwork_1' : 'Mockup__AI_Wallpaper_Background');
    const documentName = safeOutputStem + '.png';
    const mockupPngPath = path.join(TEMP_DIR, documentName).split(path.sep).join('/');
    const designPath = String(designPngPath).split(path.sep).join('/');
    const scriptPath = path.join(TEMP_DIR, 'comfy_open_ai_mockup.jsx');
    const donePath = path.join(TEMP_DIR, 'comfy_open_ai_mockup_done.txt').split(path.sep).join('/');
    fs.writeFileSync(mockupPngPath, Buffer.from(mockupBuffer));
    const originalMockupPath = config.originalMockupBuffer
        ? path.join(TEMP_DIR, safeOutputStem + '__Original.png').split(path.sep).join('/') : null;
    if (originalMockupPath) fs.writeFileSync(originalMockupPath, Buffer.from(config.originalMockupBuffer));

    const sourcePlacementLines = shouldPlaceDesign ? [
        '  var desc = new ActionDescriptor();',
        '  desc.putPath(charIDToTypeID("null"), new File("' + escapeJsxText(designPath) + '"));',
        '  desc.putEnumerated(charIDToTypeID("FTcs"), charIDToTypeID("QCSt"), charIDToTypeID("Qcsa"));',
        '  executeAction(charIDToTypeID("Plc "), desc, DialogModes.NO);',
        '  var layer = doc.activeLayer;',
        '  try { layer.name = "Design__' + escapeJsxText(safeDesignName) + '"; } catch(ignore) {}',
        '  var docW = doc.width.as("px"), docH = doc.height.as("px");',
        '  var bounds = layer.bounds;',
        '  var layerW = bounds[2].as("px") - bounds[0].as("px");',
        '  var layerH = bounds[3].as("px") - bounds[1].as("px");',
        '  if (layerW > 0 && layerH > 0) {',
        '    var scale = Math.min((docW * 0.8) / layerW, (docH * 0.8) / layerH) * 100;',
        '    layer.resize(scale, scale, AnchorPosition.MIDDLECENTER);',
        '    bounds = layer.bounds;',
        '    var centerX = (bounds[0].as("px") + bounds[2].as("px")) / 2;',
        '    var centerY = (bounds[1].as("px") + bounds[3].as("px")) / 2;',
        '    layer.translate(UnitValue((docW / 2) - centerX, "px"), UnitValue((docH / 2) - centerY, "px"));',
        '  }'
    ] : [];

    const jsx = [
        'var oldDialogs = app.displayDialogs; app.displayDialogs = DialogModes.NO;',
        'var doneFile = new File("' + escapeJsxText(donePath) + '");',
        'try {',
        '  var doc = app.open(new File("' + escapeJsxText(mockupPngPath) + '"));',
        '  var interiorLayer = doc.activeLayer;',
        '  try { doc.activeLayer.name = "' + escapeJsxText(backgroundLayerName) + '"; } catch(ignore) {}',
        ...sourcePlacementLines,
        ...(shouldPlaceDesign && config.designBehind ? [
            '  layer.move(interiorLayer, ElementPlacement.PLACEAFTER);'
        ] : []),
        ...(originalMockupPath ? [
            '  var originalDoc = app.open(new File("' + escapeJsxText(originalMockupPath) + '"));',
            '  originalDoc.activeLayer.name = "Original__BeforeWallRemoval";',
            '  originalDoc.activeLayer.duplicate(doc, ElementPlacement.PLACEATEND);',
            '  originalDoc.close(SaveOptions.DONOTSAVECHANGES);',
            '  app.activeDocument = doc;',
            '  doc.layers.getByName("Original__BeforeWallRemoval").visible = false;',
            '  doc.activeLayer = doc.layers.getByName("' + escapeJsxText(backgroundLayerName) + '");'
        ] : []),
        '  try { doc.info.caption = "ComfyFloatBar AI Mockup: ' + escapeJsxText(mockupKind) + '"; } catch(ignore) {}',
        '  app.activeDocument = doc;',
        '  app.displayDialogs = oldDialogs;',
        '  doneFile.open("w"); doneFile.write("OK"); doneFile.close();',
        '} catch(e) {',
        '  try { app.displayDialogs = oldDialogs; } catch(ignore) {}',
        '  doneFile.open("w"); doneFile.write("ERROR: " + e.message); doneFile.close();',
        '}'
    ].join('\r\n');

    fs.writeFileSync(scriptPath, '\uFEFF' + jsx, 'utf8');
    await runScript(scriptPath, donePath);
    const resultPath = path.join(TEMP_DIR, 'comfy_open_ai_mockup_done.txt');
    const result = fs.existsSync(resultPath) ? fs.readFileSync(resultPath, 'utf8') : '';
    if (result !== 'OK') throw new Error('Photoshop не смог открыть AI-мокап' + (result ? ': ' + result : '.'));
    return documentName;
}
async function openImageDocument(imagePath, layerName = null) {
    if (!imagePath || !fs.existsSync(imagePath)) throw new Error('Файл апскейла для Photoshop не найден.');
    const inputPath = String(imagePath).replace(/\\/g, '/').replace(/"/g, '\\"');
    const safeLayerName = layerName ? sanitizeForPSD(layerName).replace(/"/g, '\\"') : '';
    const scriptPath = path.join(TEMP_DIR, 'comfy_open_image_document.jsx');
    const donePath = path.join(TEMP_DIR, 'comfy_open_image_document_done.txt').replace(/\\/g, '/');
    const jsx = [
        'var oldDialogs = app.displayDialogs; app.displayDialogs = DialogModes.NO;',
        'var doneFile = new File("' + donePath + '");',
        'try {',
        '  var doc = app.open(new File("' + inputPath + '"));',
        safeLayerName ? '  try { doc.activeLayer.name = "' + safeLayerName + '"; } catch(ignore) {}' : '',
        '  app.activeDocument = doc;',
        '  app.displayDialogs = oldDialogs;',
        '  doneFile.open("w"); doneFile.write("OK"); doneFile.close();',
        '} catch(e) {',
        '  try { app.displayDialogs = oldDialogs; } catch(ignore) {}',
        '  doneFile.open("w"); doneFile.write("ERROR: " + e.message); doneFile.close();',
        '}'
    ].filter(Boolean).join('\r\n');
    fs.writeFileSync(scriptPath, '﻿' + jsx, 'utf8');
    await runScript(scriptPath, donePath);
    const resultPath = path.join(TEMP_DIR, 'comfy_open_image_document_done.txt');
    const result = fs.existsSync(resultPath) ? fs.readFileSync(resultPath, 'utf8') : '';
    if (result !== 'OK') throw new Error('Photoshop не смог открыть результат Upscale' + (result ? ': ' + result : '.'));
}

async function savePngAndClose(filePath) {
    const scriptPath = path.join(TEMP_DIR, 'comfy_save_png.jsx');
    const donePath = path.join(TEMP_DIR, 'comfy_save_png_done.txt').split(path.sep).join('/');
    const safeFilePath = String(filePath).split(path.sep).join('/');
    const jsx = [
        'var oldDialogs = app.displayDialogs; app.displayDialogs = DialogModes.NO;',
        'var doneFile = new File("' + escapeJsxText(donePath) + '");',
        'try {',
        '  var doc = app.activeDocument;',
        '  var file = new File("' + escapeJsxText(safeFilePath) + '");',
        '  var opts = new PNGSaveOptions(); opts.compression = 6;',
        '  doc.saveAs(file, opts, true, Extension.LOWERCASE);',
        '  doc.close(SaveOptions.DONOTSAVECHANGES);',
        '  app.displayDialogs = oldDialogs;',
        '  doneFile.open("w"); doneFile.write("OK"); doneFile.close();',
        '} catch(e) {',
        '  try { app.displayDialogs = oldDialogs; } catch(ignore) {}',
        '  doneFile.open("w"); doneFile.write("ERROR: " + e.message); doneFile.close();',
        '}'
    ].join('\r\n');
    fs.writeFileSync(scriptPath, '\uFEFF' + jsx, 'utf8');
    await runScript(scriptPath, donePath);
    const resultPath = path.join(TEMP_DIR, 'comfy_save_png_done.txt');
    const result = fs.existsSync(resultPath) ? fs.readFileSync(resultPath, 'utf8') : '';
    if (result !== 'OK') throw new Error('Photoshop не смог сохранить PNG' + (result ? ': ' + result : '.'));
}
async function placePatternAssets(manifest) {
    const {buildPlacementScript} = require('./pattern_photoshop');
    const scriptPath = path.join(TEMP_DIR, 'comfy_pattern_assets.jsx');
    const donePath = path.join(TEMP_DIR, 'comfy_pattern_assets_done.txt');
    fs.writeFileSync(scriptPath, '\uFEFF' + buildPlacementScript(manifest, donePath), 'utf8');
    await runScript(scriptPath, donePath, 180000);
    const result = fs.readFileSync(donePath, 'utf8');
    if (result !== 'OK') throw new Error('Photoshop не смог разместить паттерн: ' + result);
}

module.exports = { getActiveDocumentName, exportSelection, getActiveDocumentInfo, createLayerGroup, exportDocumentTile, exportActiveLayerVisible, getVisibleLayersForUpscale, exportActiveLayerForUpscale, exportDocument, exportDocumentOverview, placeSvg, placeImage, openMockupAndPlaceDesign, openGeneratedMockupAndPlaceDesign, openImageDocument, savePngAndClose, sanitizeForPSD, placePatternAssets };
