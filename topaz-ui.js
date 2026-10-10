// Topaz queue UI. Settings are chosen before upload; the same button uploads and starts.
'use strict';
function mountTopaz({ root, request, source, dimensions, layer, status }) {
  const panel = document.createElement('div');
  panel.innerHTML = `<div id="topazConnection" style="font-size:11px;color:#aaa;margin:8px 0">Подключение к обработчику…</div>
    <div id="topazCurrent" style="font-size:11px;color:#e3b758;margin:6px 0"></div>
    <div class="sub-tool-section"><div class="sub-tool-header" id="topazHistoryToggle"><span>🕘 История Topaz</span><span class="arrow">▼</span></div>
      <div id="topazHistory" class="sub-tool-content hidden"><div id="topazJobs" style="font-size:12px;overflow-wrap:anywhere"></div></div></div>
    <div style="font-size:10px;color:#999;margin-top:8px">Обработка может занимать 30 минут и дольше. Окно можно свернуть: очередь продолжит работу, а результат придёт файлом в Избранное Telegram.</div>`;
  root.appendChild(panel);

  const settingsHost = document.getElementById('set_upscale') || root;
  const fieldset = document.createElement('fieldset');
  fieldset.id = 'topazSettings';
  fieldset.style.cssText = 'border:0;padding:0;margin:0 0 12px';
  fieldset.innerHTML = `<div style="font-size:11px;color:#aaa;margin-bottom:8px">Настройки применятся после нажатия «Загрузить в Topaz».</div>
    <label>Модель<select name="model"></select></label>
    <label>Размер<select name="resizeMode"><option value="scale">Масштаб</option><option value="width">Ширина</option><option value="height">Высота</option></select></label>
    <div data-size="scale"><label>Увеличение <output></output><input name="scale" type="range" min="1" max="6" step="0.01" value="4"></label></div>
    <div data-size="dimension" class="hidden" style="display:grid;grid-template-columns:minmax(0,1fr) 72px;gap:6px">
      <label style="margin:0">Значение<input name="dimension" type="number" min="1" max="32000" step="0.01" value="213" inputmode="decimal"></label>
      <label style="margin:0">Единица<select name="unit"><option value="px">px</option><option value="in">дюймы</option><option value="cm">см</option></select></label>
    </div>
    <label>Плотность, PPI<input name="ppi" type="number" min="1" max="1200" step="1" value="100"></label>
    <div id="topazDimensions" style="font-size:11px;margin:6px 0;color:#8abf92"></div>
    <div data-model="core"></div><div data-model="recover"></div><div data-model="redefine"></div>
    <label data-feature="face"><input type="checkbox" name="face"> Восстановление лиц</label>
    <label data-feature="gamma"><input type="checkbox" name="gamma"> Коррекция гаммы</label>
    <label>Формат<select name="format"><option>JPEG</option><option>PNG</option><option>TIFF</option></select></label>
    <label data-feature="quality">Качество JPEG <output></output><input name="quality" type="range" min="1" max="100" value="100"></label>
    <label>Цветовой профиль<select name="colorSpace"><option>Adobe RGB (1998)</option><option>sRGB IEC61966-2.1</option><option>ProPhoto RGB</option></select></label>`;
  settingsHost.insertBefore(fieldset, settingsHost.firstChild);
  fieldset.querySelectorAll('label').forEach(e => { e.style.display = 'block'; e.style.marginTop = '8px'; e.style.marginBottom = '8px'; });
  ['Standard v2','High fidelity v2','Low res v2','Text & shapes','Art & CG','Recover v2','Redefine'].forEach(value => {
    const option = document.createElement('option'); option.value = option.textContent = value; fieldset.querySelector('[name=model]').appendChild(option);
  });
  const sliders = {
    core: [['sharpen','Резкость',0,100,33],['denoise','Удаление шума',0,100,50],['compression','Артефакты сжатия',0,100,1]],
    recover: [['detail','Детализация',0,100,50]],
    redefine: [['creativity','Креативность',1,6,2],['texture','Текстура',1,6,3],['extraSharpen','Дополнительная резкость',0,6,0],['extraDenoise','Дополнительное шумоподавление',0,6,2]]
  };
  for (const [group, fields] of Object.entries(sliders)) for (const [name,label,min,max,value] of fields) {
    const element = document.createElement('label');
    element.innerHTML = `${label} <output>${value}</output><input type="range" name="${name}" min="${min}" max="${max}" value="${value}">`;
    fieldset.querySelector(`[data-model=${group}]`).appendChild(element);
  }
  const prompt = document.createElement('textarea'); prompt.name = 'description'; prompt.placeholder = 'Описание изображения для Redefine'; prompt.maxLength = 2000;
  fieldset.querySelector('[data-model=redefine]').appendChild(prompt);

  let jobs = [], uploading = false, requestId = null, lastSource = null;
  const uploadButton = document.getElementById('btn_upscale');
  const values = () => Object.fromEntries(Array.from(fieldset.querySelectorAll('[name]'), e => [e.name, e.type === 'checkbox' ? e.checked : ['range','number'].includes(e.type) ? Number(e.value) : e.value]));
  const update = () => {
    const v = values(), group = v.model === 'Redefine' ? 'redefine' : v.model === 'Recover v2' ? 'recover' : 'core';
    fieldset.querySelectorAll('[data-model]').forEach(e => e.classList.toggle('hidden', e.dataset.model !== group));
    fieldset.querySelector('[data-feature=face]').classList.toggle('hidden', group === 'redefine');
    fieldset.querySelector('[data-feature=gamma]').classList.toggle('hidden', group !== 'core');
    fieldset.querySelector('[name=compression]').parentElement.classList.toggle('hidden', v.model === 'Art & CG');
    fieldset.querySelector('[data-feature=quality]').classList.toggle('hidden', v.format !== 'JPEG');
    fieldset.querySelector('[data-size=scale]').classList.toggle('hidden', v.resizeMode !== 'scale');
    fieldset.querySelector('[data-size=dimension]').classList.toggle('hidden', v.resizeMode === 'scale');
    fieldset.querySelectorAll('input[type=range]').forEach(e => { e.parentElement.querySelector('output').value = e.value; });
    const input = dimensions();
    if (input?.width && input?.height) {
      const px = v.dimension * (v.unit === 'cm' ? v.ppi / 2.54 : v.unit === 'in' ? v.ppi : 1);
      const scale = v.resizeMode === 'scale' ? v.scale : px / (v.resizeMode === 'width' ? input.width : input.height);
      fieldset.querySelector('#topazDimensions').textContent = `${input.width} × ${input.height} → ${Math.round(input.width * scale)} × ${Math.round(input.height * scale)} px`;
    } else fieldset.querySelector('#topazDimensions').textContent = 'Добавьте изображение, чтобы увидеть итоговый размер.';
  };
  fieldset.addEventListener('input', update); fieldset.addEventListener('change', update); update();
  panel.querySelector('#topazHistoryToggle').onclick = event => {
    const content = panel.querySelector('#topazHistory'); content.classList.toggle('hidden');
    event.currentTarget.querySelector('.arrow').textContent = content.classList.contains('hidden') ? '▼' : '▲';
  };
  async function action(event, data) { try { return await request(event, data); } catch (error) { status(error.message); throw error; } }
  document.getElementById('btn_topaz_from_layer').addEventListener('click', async () => { try { await layer(); update(); } catch (error) { status(error.message); } });
  return {
    refresh: update,
    async upload() {
      if (uploading) return;
      try {
        const input = source(); if (!input) throw new Error('Сначала добавьте изображение');
        if (!fieldset.reportValidity()) throw new Error('Проверьте размер и остальные настройки Topaz.');
        const chosen = values();
        if (lastSource !== input.identity) { requestId = require('crypto').randomUUID(); lastSource = input.identity; }
        uploading = true; uploadButton.disabled = true; fieldset.disabled = true; status('Передача оригинала и запуск Topaz…');
        await action('topaz:upload', { ...input, requestId, settings: chosen });
        requestId = null; lastSource = null;
        status('Задача передана: Topaz откроет изображение и сразу начнёт апскейл.');
      } catch (error) { status(error.message); uploadButton.disabled = false; fieldset.disabled = false; }
      finally { uploading = false; uploadButton.disabled = false; fieldset.disabled = false; }
    },
    render(state) {
      jobs = state.jobs || [];
      panel.querySelector('#topazConnection').textContent = state.enabled ? 'Обработчик Topaz подключён' : 'Topaz не настроен на ПК-обработчике';
      const active = [...jobs].reverse().find(job => !['done','failed','cancelled','interrupted'].includes(job.state));
      panel.querySelector('#topazCurrent').textContent = active ? `${active.sourceName}: ${active.message}` : '';
      const list = panel.querySelector('#topazJobs'); list.replaceChildren();
      for (const job of jobs.slice(-10).reverse()) {
        const row = document.createElement('div'); row.style.cssText = 'padding:8px 0;border-bottom:1px solid #444';
        const title = document.createElement('b'); title.textContent = job.sourceName;
        const message = document.createElement('div'); message.textContent = job.message; row.append(title,message);
        if (['queued','ready'].includes(job.state)) {
          const cancel = document.createElement('button'); cancel.textContent = 'Отменить';
          cancel.onclick = () => action('topaz:cancel', { id: job.id }).catch(() => {}); row.appendChild(cancel);
        }
        list.appendChild(row);
      }
      update();
    }
  };
}
module.exports = { mountTopaz };
