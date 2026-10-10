'use strict';

// Pure builder so the Adobe script can be tested without touching an open document.
function buildPlacementScript(manifest, donePath) {
    const quote = value => JSON.stringify(String(value));
    const elements = manifest.assets.filter(asset => asset.kind === 'element');
    const files = [
        {path:manifest.assets.find(asset => asset.kind === 'background')?.upscaledPath, name:'Фон ×4', kind:'background'},
        {path:manifest.referencePath, name:'Исходный паттерн — ориентир', kind:'reference'},
        ...elements.map(asset => ({path:asset.upscaledPath, name:asset.name + ' ×4', kind:'element'}))
    ];
    if (files.some(item => !item.path)) throw new Error('Не все файлы паттерна готовы к размещению.');
    const input = JSON.stringify(files.map(item => ({...item, path:item.path.replace(/\\/g, '/')})));
    return [
        'var oldDialogs = app.displayDialogs; app.displayDialogs = DialogModes.NO;',
        'var doneFile = new File(' + quote(donePath.replace(/\\/g, '/')) + '); doneFile.encoding = "UTF8";',
        'var temporaryDoc = null; var group = null; var createdDocument = false; var doc = null; var step = "Подготовка";',
        'try {',
        '  var inputs = ' + input + ';',
        '  for (var f = 0; f < inputs.length; f++) { if (!new File(inputs[f].path).exists) throw new Error("Файл не найден: " + inputs[f].path); }',
        '  if (app.documents.length > 0) { doc = app.activeDocument; }',
        '  else { doc = app.documents.add(UnitValue(40, "in"), UnitValue(40, "in"), 300, "Pattern 40x40in 300dpi", NewDocumentMode.RGB, DocumentFill.TRANSPARENT); createdDocument = true; }',
        '  var width = doc.width.as("px"), height = doc.height.as("px");',
        '  group = doc.layerSets.add(); group.name = "Паттерн — исправленные элементы ×4";',
        '  var elements = group.layerSets.add(); elements.name = "Элементы PNG ×4";',
        '  for (var i = 0; i < inputs.length; i++) {',
        '    var item = inputs[i];',
        '    step = item.name + ": открытие PNG";',
        '    temporaryDoc = app.open(new File(item.path));',
        '    var layer = temporaryDoc.activeLayer.duplicate(doc, ElementPlacement.PLACEATBEGINNING);',
        '    temporaryDoc.close(SaveOptions.DONOTSAVECHANGES); temporaryDoc = null;',
        '    app.activeDocument = doc;',
        '    doc.activeLayer = layer;',
        '    if (layer.isBackgroundLayer) layer.isBackgroundLayer = false;',
        '    layer.allLocked = false; layer.visible = true;',
        '    step = item.name + ": перенос в группу";',
        '    layer.move(item.kind === "element" ? elements : group, ElementPlacement.INSIDE);',
        '    layer.name = item.name;',
        '    doc.activeLayer = layer;',
        '    var bounds = layer.bounds; var lw = bounds[2].as("px") - bounds[0].as("px"), lh = bounds[3].as("px") - bounds[1].as("px");',
        '    if (lw <= 0 || lh <= 0) throw new Error("Пустой слой: " + item.name);',
        '    var centerX = width/2, centerY = height/2;',
        '    if (item.kind === "background") layer.move(group, ElementPlacement.PLACEATEND);',
        '    step = item.name + ": размещение на холсте";',
        '    doc.activeLayer = layer;',
        '    bounds = layer.bounds;',
        '    layer.translate(UnitValue(centerX-(bounds[0].as("px")+bounds[2].as("px"))/2, "px"), UnitValue(centerY-(bounds[1].as("px")+bounds[3].as("px"))/2, "px"));',
        '    if (item.kind === "reference") layer.visible = false;',
        '  }',
        '  doc.activeLayer = elements; app.activeDocument = doc;',
        '  app.displayDialogs = oldDialogs;',
        '  doneFile.open("w"); doneFile.write("OK"); doneFile.close();',
        '} catch(e) {',
        '  try { if (temporaryDoc) temporaryDoc.close(SaveOptions.DONOTSAVECHANGES); } catch(ignore) {}',
        '  try { if (group) group.remove(); } catch(ignore) {}',
        '  try { if (createdDocument && doc) doc.close(SaveOptions.DONOTSAVECHANGES); } catch(ignore) {}',
        '  try { app.displayDialogs = oldDialogs; } catch(ignore) {}',
        '  doneFile.open("w"); doneFile.write("ERROR: " + step + ": " + e.message); doneFile.close();',
        '}'
    ].join('\r\n');
}

module.exports = {buildPlacementScript};
