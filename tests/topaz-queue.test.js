'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { TopazQueue, settings } = require('../mini-services/hub-service/topaz-queue');
const image = Buffer.from([137,80,78,71,13,10,26,10,0]);
const options = { model:'Standard v2', resizeMode:'scale', unit:'px', format:'PNG', colorSpace:'Adobe RGB (1998)' };
const tick = () => new Promise(resolve => setImmediate(resolve));
function queue(adapter) { return new TopazQueue({ directory:fs.mkdtempSync(path.join(os.tmpdir(),'cfb-topaz-')), adapter }); }
test('Topaz queue preserves the input, waits for settings, serializes jobs and sends only the generated result', async () => {
  const calls=[];
  const q=queue(async (command,job) => { calls.push([command,job.id]); return command==='prepare'?{width:512,height:512}:command==='process'?{path:path.join(job.outputDir,'out.png'),fileName:'out.png'}:{sent:true}; });
  const first=q.upload('A',{image,sourceName:'original.png'},crypto.randomUUID());
  const second=q.upload('B',{image,sourceName:'other.png'},crypto.randomUUID());
  await tick(); assert.equal(q.jobs[0].state,'ready'); assert.equal(q.jobs[1].state,'queued');
  assert.deepEqual(fs.readFileSync(q.jobs[0].input),image);
  const firstFolder=path.dirname(q.jobs[0].input);
  assert.throws(()=>q.start('B',first,options),/не найдена/);
  q.start('A',first,options); await tick();
  assert.equal(q.jobs[0].state,'done'); assert.equal(q.jobs[1].state,'ready');
  assert.equal(fs.existsSync(firstFolder),false);
  assert.deepEqual(calls.map(c=>c[0]),['desktop-hide','prepare','desktop-restore','desktop-hide','process','telegram','desktop-restore','desktop-hide','prepare','desktop-restore']);
  assert.equal(q.snapshot('A').length,1); assert.equal(q.snapshot('A')[0].input,undefined);
  assert.equal(q.active.id,second);
});
test('Settings uploaded with the image start processing without a second command', async () => {
  const calls=[];
  const q=queue(async (command,job) => { calls.push(command); return command==='prepare'?{width:720,height:1038}:command==='process'?{path:path.join(job.outputDir,'out.jpg'),fileName:'out.jpg'}:{sent:true}; });
  q.upload('A',{image,sourceName:'one-click.jpg',settings:{...options,format:'JPEG',resizeMode:'height',dimension:213,unit:'in',ppi:100}},crypto.randomUUID());
  await tick(); await tick();
  assert.equal(q.jobs[0].state,'done');
  assert.deepEqual(calls,['desktop-hide','prepare','process','telegram','desktop-restore']);
});
test('Failures end only their task and the queue remains automatic', async () => {
  const q=queue(async command => {
    if (command === 'desktop-hide') return { handles:[123] };
    if (command === 'desktop-restore') return { restored:1 };
    if (command === 'prepare') throw new Error('Lost focus');
    return {};
  }); const requestId=crypto.randomUUID();
  const id=q.upload('A',{image},requestId); assert.equal(q.upload('A',{image},requestId),id);
  await tick(); await tick(); assert.equal(q.jobs[0].state,'failed');
  q.upload('A',{image},crypto.randomUUID()); await tick(); await tick(); assert.equal(q.jobs[1].state,'failed');
  const restarted=new TopazQueue({directory:q.directory,adapter:()=>{throw new Error('Must not run');}});
  assert.equal(restarted.jobs[1].state,'failed');

  const processing=queue(async command => {
    if (command === 'desktop-hide') return { handles:[] };
    if (command === 'desktop-restore') return { restored:0 };
    if (command === 'prepare') return {width:512,height:512};
    if (command === 'process') throw new Error('Export outcome unknown');
    return {};
  });
  processing.upload('A',{image,settings:options},crypto.randomUUID());
  await tick(); await tick();
  assert.equal(processing.jobs[0].state,'failed');
  assert.equal(processing.active,null);
});
test('Reject unknown models, invalid settings and non-images, but accept originals above 49 MB', () => {
  assert.throws(()=>settings({...options,model:'unknown'})); assert.throws(()=>settings({...options,scale:Infinity}));
  assert.throws(()=>settings({...options,format:'EXE'})); assert.equal(settings(options).sharpen,33);
  const q=queue(async()=>({}));
  assert.throws(()=>q.upload('A',{image:Buffer.from('not an image')},crypto.randomUUID()));
  const large = Buffer.alloc(50*1024*1024); image.copy(large, 0);
  assert.doesNotThrow(()=>q.upload('A',{image:large},crypto.randomUUID()));
});
