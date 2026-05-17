// ========== STATE ==========
let currentFileId = null;
let currentBlocks = [];
let currentFieldMapping = {};
let currentLayoutName = '';
let currentLayoutId = null;
let currentCategory = '';
let currentSlideCount = 1;
let layouts = [];

// ========== API ==========
const API = {
  async get(url) { const r = await fetch(url); if (!r.ok) throw new Error((await r.json()).error); return r.json(); },
  async post(url, body) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error((await r.json()).error); return r.json();
  },
  async del(url) { const r = await fetch(url, { method: 'DELETE' }); if (!r.ok) throw new Error((await r.json()).error); return r.json(); },
};

// ========== NAV ==========
document.querySelectorAll('.header nav a').forEach(a => {
  a.addEventListener('click', () => {
    document.querySelectorAll('.header nav a').forEach(x => x.classList.remove('active'));
    a.classList.add('active');
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById('page-' + a.dataset.page).classList.add('active');
    if (a.dataset.page === 'layouts') loadLayoutsList();
    if (a.dataset.page === 'generator') loadGenTree();
    if (a.dataset.page === 'data') loadData();
  });
});

// ========== TREE ==========
function buildTreeHTML(nodes) {
  if (!nodes || !Array.isArray(nodes)) return '';
  return nodes.map(n => {
    const hasChildren = n.children && n.children.length > 0;
    let childrenHTML = '';
    if (hasChildren) {
      childrenHTML = `<div class="tree-children">${buildTreeHTML(n.children)}</div>`;
    }
    const icon = n.type === 'region' ? '📁' : n.type === 'category' ? '📂' : '📄';
    let badges = '';
    if (n.isOld) badges += '<span class="file-badge old">old</span> ';
    if (n.isCover) badges += '<span class="file-badge cover">cover</span> ';
    if (n.extension === '.ppt') badges += '<span class="file-badge ppt">ppt</span> ';
    const fileClick = n.type === 'file' ? `onclick="analyzeFile(${n.fileId}, this)"` : '';
    const label = n.label || n.name || '';
    return `<div class="tree-node">
      <div class="tree-content ${n.type === 'file' ? 'file' : ''}" ${fileClick} data-file-id="${n.fileId || ''}">
        ${hasChildren ? `<span class="tree-toggle" onclick="toggleTree(this)">▶</span>` : '<span style="width:16px;display:inline-block"></span>'}
        <span class="tree-icon">${icon}</span>
        <span class="tree-label">${label}</span>
        ${badges}
      </div>
      ${childrenHTML}
    </div>`;
  }).join('');
}

async function loadTree() {
  const root = document.getElementById('tree-root');
  root.innerHTML = '<div class="loading"><div class="spinner"></div> Caricamento...</div>';
  try {
    const tree = await API.get('/api/tree');
    root.innerHTML = buildTreeHTML(tree);
  } catch (err) {
    root.innerHTML = `<div class="empty-state"><div class="icon">⚠️</div><p>${err.message}</p></div>`;
  }
}

function toggleTree(el) {
  el.classList.toggle('open');
  const children = el.parentElement?.nextElementSibling;
  if (children) children.classList.toggle('open');
}

// ========== ANALYZE ==========
let currentImages = {}; // imageName → base64 dataUrl

async function analyzeFile(fileId, el) {
  currentFileId = fileId;
  currentLayoutId = null;
  currentImages = {};
  document.querySelectorAll('.tree-content.active').forEach(e => e.classList.remove('active'));
  if (el) el.classList.add('active');

  const panel = document.getElementById('analysis-panel');
  const header = document.getElementById('analysis-header').querySelector('span');
  panel.innerHTML = '<div class="loading"><div class="spinner"></div> Analisi in corso...</div>';
  document.getElementById('analysis-actions').style.display = 'none';

  try {
    // Fetch analyze + images in parallel
    const [result, imgResult] = await Promise.all([
      API.get(`/api/files/${fileId}/analyze`),
      API.get(`/api/files/${fileId}/images`).catch(() => ({ images: [] })),
    ]);

    header.textContent = `${result.fileName} (${result.slideCount} slide)`;
    currentSlideCount = result.slideCount;
    currentCategory = result.fileCategory || 'unknown';
    currentLayoutName = `${result.fileCategory || 'slide'} - ${result.fileName.replace(/\.\w+$/, '')}`;

    // Build image name → dataUrl map
    currentImages = {};
    for (const img of imgResult.images || []) {
      currentImages[img.name] = img.data;
    }

    document.getElementById('btn-show-images').onclick = () => showImages(fileId);
    document.getElementById('analysis-actions').style.display = 'flex';

    if (result.error) {
      panel.innerHTML = `<div class="empty-state"><div class="icon">⚠️</div><p>${result.error}</p></div>`;
      return;
    }

    if (!result.slides || result.slides.length === 0) {
      panel.innerHTML = '<div class="empty-state"><div class="icon">📄</div><p>Nessuna slide trovata</p></div>';
      return;
    }

    // Render slide tabs
    let html = '<div class="nav-tabs" id="slide-tabs">';
    result.slides.forEach((s, i) => {
      html += `<button class="${i === 0 ? 'active' : ''}" data-slide="${i}">Slide ${s.slideIndex}</button>`;
    });
    html += '</div>';

    result.slides.forEach((slide, i) => {
      html += `<div class="tab-content ${i === 0 ? 'active' : ''}" data-slide="${i}">`;
      const blocks = slide.blocks;

      if (blocks.length === 0) {
        html += '<div class="empty-state"><p>Nessun blocco di testo trovato in questa slide</p></div>';
      } else {
        blocks.forEach((b, idx) => {
          const isImg = b.type === 'image';
          const imgDataUrl = isImg && b.imageName ? currentImages[b.imageName] : null;
          html += `<div class="block-card" data-block-idx="${idx}" data-slide="${i}">
            <div class="pos">${b.xPct}% × ${b.yPct}%  ·  ${b.fontSize}px · ${b.fontFace || ''} ${b.bold ? 'B' : ''} ${b.fontColor ? `<span class="color-swatch" style="background:#${b.fontColor}"></span>` : ''}</div>
            <div class="text-preview ${isImg ? 'img' : ''}">${isImg ? (imgDataUrl ? `<img src="${imgDataUrl}" style="max-width:100%;max-height:80px;border-radius:4px;display:block">` : `🖼️ ${b.imageName || 'IMMAGINE'}`) : b.text.substring(0, 200)}</div>
            <select class="field-select" data-block-idx="${idx}" data-slide="${i}" onchange="onFieldChange(${i}, ${idx}, this.value)">
              <option value="">— Ignora —</option>
              <option value="titolo">Titolo</option>
              <option value="sottotitolo">Sottotitolo</option>
              <option value="testo">Testo</option>
              <option value="numero_giorno">Numero Giorno</option>
              <option value="data">Data</option>
              <option value="url">URL</option>
              <option value="immagine">Immagine</option>
              <option value="nome">Nome</option>
              <option value="stelle">Stelle Hotel</option>
              <option value="citta">Città</option>
              <option value="custom">✏️ Personalizzato...</option>
            </select>
          </div>`;
        });
      }
      html += '</div>';
    });

    panel.innerHTML = html;

    // Tab switching
    document.querySelectorAll('#slide-tabs button').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#slide-tabs button').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
        document.querySelector(`.tab-content[data-slide="${btn.dataset.slide}"]`).classList.add('active');
      });
    });

    // Store blocks
    currentBlocks = result.slides;

    // Auto-select first tab
    renderMapping();
  } catch (err) {
    panel.innerHTML = `<div class="empty-state"><div class="icon">❌</div><p>${err.message}</p></div>`;
  }
}

function onFieldChange(slideIdx, blockIdx, value) {
  if (value === 'custom') {
    value = prompt('Nome campo personalizzato:');
    if (!value) {
      const select = document.querySelector(`select[data-block-idx="${blockIdx}"][data-slide="${slideIdx}"]`);
      select.value = '';
      return;
    }
  }
  if (value) {
    const select = document.querySelector(`select[data-block-idx="${blockIdx}"][data-slide="${slideIdx}"]`);
    select.classList.add('mapped');
    currentFieldMapping[`${slideIdx}-${blockIdx}`] = value;
  } else {
    const select = document.querySelector(`select[data-block-idx="${blockIdx}"][data-slide="${slideIdx}"]`);
    select.classList.remove('mapped');
    delete currentFieldMapping[`${slideIdx}-${blockIdx}`];
  }
  renderMapping();
}

function renderMapping() {
  const panel = document.getElementById('mapping-panel');
  const saveBtn = document.getElementById('btn-save-layout');
  const fields = Object.entries(currentFieldMapping);

  if (fields.length === 0) {
    panel.innerHTML = '<div class="empty-state"><div class="icon">🔧</div><p>Assegna dei campi ai blocchi di testo</p></div>';
    saveBtn.style.display = 'none';
    return;
  }

  saveBtn.style.display = 'inline-flex';

  // Group by slide
  const bySlide = {};
  for (const [key, value] of fields) {
    const [slideIdx, blockIdx] = key.split('-');
    if (!bySlide[slideIdx]) bySlide[slideIdx] = [];
    const block = currentBlocks[parseInt(slideIdx)]?.blocks[parseInt(blockIdx)];
    bySlide[slideIdx].push({ field: value, block });
  }

  let html = `<div class="flex flex-wrap mb-8"><input type="text" id="layout-name-input" value="${currentLayoutName}" style="flex:1;padding:6px 10px;border:2px solid #ddd;border-radius:5px;font-size:13px" placeholder="Nome layout"></div>`;
  html += '<div style="font-size:11px;color:#888;margin-bottom:8px">Campi mappati per slide:</div>';

  for (const [slideIdx, items] of Object.entries(bySlide)) {
    html += `<div style="font-size:11px;font-weight:600;color:#e94560;margin:8px 0 4px">Slide ${parseInt(slideIdx) + 1}</div>`;
    for (const { field, block } of items) {
      const preview = block ? (block.type === 'image' ? '🖼️' : block.text.substring(0, 50)) : '';
      html += `<div class="field-item">
        <span class="field-name">${field}</span>
        <span class="field-detail">${preview}</span>
        <span class="remove-field" onclick="removeField('${slideIdx}', '${Object.keys(bySlide).indexOf(slideIdx)}')">✕</span>
      </div>`;
    }
  }

  panel.innerHTML = html;
}

function removeField(slideIdx, fieldKey) {
  // Remove all fields from this slide (simplified)
  for (const key of Object.keys(currentFieldMapping)) {
    if (key.startsWith(slideIdx + '-')) {
      delete currentFieldMapping[key];
      const select = document.querySelector(`select[data-block-idx="${key.split('-')[1]}"][data-slide="${slideIdx}"]`);
      if (select) { select.value = ''; select.classList.remove('mapped'); }
    }
  }
  renderMapping();
}

// ========== SAVE LAYOUT ==========
document.getElementById('btn-save-layout').addEventListener('click', async () => {
  const nameInput = document.getElementById('layout-name-input');
  const name = nameInput ? nameInput.value.trim() : currentLayoutName;
  if (!name) { alert('Inserisci un nome per il layout'); return; }

  // Group fields by slide
  const slides = {};
  for (const [key, field] of Object.entries(currentFieldMapping)) {
    const [slideIdx, blockIdx] = key.split('-');
    if (!slides[slideIdx]) slides[slideIdx] = [];
    const block = currentBlocks[parseInt(slideIdx)]?.blocks[parseInt(blockIdx)];
    slides[slideIdx].push({
      field,
      blockIndex: parseInt(blockIdx),
      position: block ? { x: block.x, y: block.y, cx: block.cx, cy: block.cy, xPct: block.xPct, yPct: block.yPct, cxPct: block.cxPct, cyPct: block.cyPct } : null,
      type: block ? block.type : 'text',
    });
  }

  try {
    const result = await API.post('/api/layouts', {
      id: currentLayoutId,
      name,
      category: currentCategory,
      slideCount: currentSlideCount,
      fields: slides,
      fileId: currentFileId,
      notes: `Mappato da ${currentBlocks.length} slide, ${Object.keys(currentFieldMapping).length} campi`,
    });
    alert(currentLayoutId ? 'Layout aggiornato!' : 'Layout salvato!');
    currentLayoutId = null;
    loadLayoutsList();
  } catch (err) {
    alert('Errore: ' + err.message);
  }
});

// ========== IMAGES ==========
async function showImages(fileId) {
  try {
    const result = await API.get(`/api/files/${fileId}/images`);
    if (!result.images || result.images.length === 0) {
      alert('Nessuna immagine trovata in questo file');
      return;
    }
    const win = window.open('', '_blank', 'width=800,height=600');
    win.document.write(`
      <html><head><title>Immagini - ${fileId}</title>
      <style>body{font-family:system-ui;padding:20px;background:#f0f0f3}
      .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px}
      .card{background:#fff;border-radius:8px;padding:8px;box-shadow:0 2px 8px rgba(0,0,0,0.06)}
      .card img{width:100%;aspect-ratio:1;object-fit:cover;border-radius:4px}
      .card .name{font-size:11px;color:#888;margin-top:4px;word-break:break-all}
      </style></head><body>
      <h2 style="margin-bottom:16px">📷 ${result.images.length} immagini trovate</h2>
      <div class="grid">
      ${result.images.map((img, i) => `<div class="card"><img src="${img.data}"><div class="name">#${i+1}: ${img.name}</div></div>`).join('')}
      </div>
      </body></html>
    `);
  } catch (err) {
    alert('Errore: ' + err.message);
  }
}

// ========== LAYOUTS LIST ==========
async function loadLayoutsList() {
  const container = document.getElementById('layouts-list');
  const count = document.getElementById('layout-count');
  try {
    layouts = await API.get('/api/layouts');
    count.textContent = layouts.length;
    if (layouts.length === 0) {
      container.innerHTML = '<div class="empty-state"><div class="icon">📋</div><p>Nessun layout salvato ancora</p></div>';
      return;
    }
    container.innerHTML = layouts.map(l => {
      const allFields = new Set();
      if (l.fields) for (const slideFields of Object.values(l.fields)) {
        if (Array.isArray(slideFields)) slideFields.forEach(f => allFields.add(f.field));
      }
      return `
      <div class="layout-card">
        <div class="flex" style="justify-content:space-between">
          <div>
            <div class="name">${l.name}</div>
            <div class="meta">
              <span class="tag">${l.category}</span>
              <span class="tag">${Object.keys(l.fields || {}).length} slide mappate</span>
              <span class="tag">${l.slideCount || '?'} slide totali</span>
              ${l.createdAt ? `<span class="tag">${new Date(l.createdAt).toLocaleDateString()}</span>` : ''}
            </div>
          </div>
          <div class="flex gap-4">
            <button class="btn btn-sm btn-outline" onclick="viewLayout('${l.id}')">Vedi</button>
            <button class="btn btn-sm btn-outline" onclick="editLayout('${l.id}')">Modifica</button>
            <button class="btn btn-sm btn-outline" onclick="deleteLayout('${l.id}')">Elimina</button>
          </div>
        </div>
        <div style="margin-top:8px;font-size:11px;color:#888">
          <strong>Campi:</strong>
          ${[...allFields].map(f => `<span class="tag tag-orange">${f}</span>`).join(' ')}
        </div>
      </div>`;
    }).join('');
  } catch (err) {
    container.innerHTML = `<div class="empty-state"><div class="icon">⚠️</div><p>${err.message}</p></div>`;
  }
}

async function deleteLayout(id) {
  if (!confirm('Eliminare questo layout?')) return;
  try {
    await API.del(`/api/layouts/${id}`);
    loadLayoutsList();
  } catch (err) {
    alert('Errore: ' + err.message);
  }
}

// ========== VIEW/EDIT LAYOUT ==========
function viewLayout(id) {
  const l = layouts.find(x => x.id === id);
  if (!l) return;
  const win = window.open('', '_blank', 'width=900,height=700');
  const allFields = [];
  if (l.fields) for (const [slideKey, slideFields] of Object.entries(l.fields)) {
    if (Array.isArray(slideFields)) slideFields.forEach(f => allFields.push({ slide: parseInt(slideKey) + 1, ...f }));
  }
  win.document.write(`
    <html><head><title>Layout: ${l.name}</title>
    <style>
      body{font-family:system-ui;padding:24px;background:#f0f0f3;color:#1a1a2e}
      h2{margin:0 0 4px} .meta{color:#888;font-size:13px;margin-bottom:16px}
      table{width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.06)}
      th,td{padding:8px 12px;text-align:left;font-size:12px;border-bottom:1px solid #eee}
      th{background:#1a1a2e;color:#fff;font-size:11px;text-transform:uppercase}
      tr:hover{background:#f8f8fc}
      .tag{display:inline-block;padding:2px 8px;border-radius:8px;font-size:10px;font-weight:600;background:#e94560;color:#fff;margin:1px}
      .badge-img{background:#2ecc71;color:#fff;padding:2px 8px;border-radius:8px;font-size:10px}
      .json-box{background:#1a1a2e;color:#e0e0e0;padding:16px;border-radius:8px;font-family:monospace;font-size:12px;overflow:auto;max-height:400px;margin-top:16px;white-space:pre}
    </style></head><body>
    <h2>${l.name}</h2>
    <div class="meta">
      <span class="tag">${l.category}</span>
      <span class="tag">${l.slideCount || '?'} slide totali</span>
      <span class="tag">${allFields.length} campi mappati</span>
      ${l.createdAt ? `<span class="tag">${new Date(l.createdAt).toLocaleString()}</span>` : ''}
      ${l.notes ? `<div style="margin-top:8px">${l.notes}</div>` : ''}
    </div>
    ${allFields.length > 0 ? `
    <table>
      <tr><th>Slide</th><th>Campo</th><th>Blocco</th><th>Tipo</th><th>Posizione</th></tr>
      ${allFields.map(f => `
        <tr>
          <td>${f.slide}</td>
          <td><strong>${f.field}</strong></td>
          <td>#${f.blockIndex}</td>
          <td>${f.type === 'image' ? '<span class="badge-img">Immagine</span>' : 'Testo'}</td>
          <td>${f.position ? `${f.position.xPct}% × ${f.position.yPct}%` : '-'}</td>
        </tr>
      `).join('')}
    </table>` : '<p>Nessun campo mappato</p>'}
    <div class="json-box">${JSON.stringify(l, null, 2)}</div>
    </body></html>
  `);
}

async function editLayout(id) {
  try {
    const l = layouts.find(x => x.id === id);
    if (!l) return alert('Layout non trovato');
    if (!l.sourceFileId) return alert('Questo layout non ha un file sorgente associato');
    document.querySelector('[data-page="layout"]').click();
    await analyzeFile(l.sourceFileId);
    // Pre-fill mappings from saved layout
    currentFieldMapping = {};
    currentLayoutName = l.name;
    currentLayoutId = l.id;
    if (l.fields) {
      for (const [slideIdx, slideFields] of Object.entries(l.fields)) {
        if (Array.isArray(slideFields)) {
          slideFields.forEach(f => {
            currentFieldMapping[`${slideIdx}-${f.blockIndex}`] = f.field;
            const select = document.querySelector(`select[data-block-idx="${f.blockIndex}"][data-slide="${slideIdx}"]`);
            if (select) { select.value = f.field; select.classList.add('mapped'); }
          });
        }
      }
      renderMapping();
    }
  } catch (err) {
    alert('Errore: ' + err.message);
  }
}

// ========== EXTRACT ==========
document.getElementById('btn-run-extract').addEventListener('click', async () => {
  const btn = document.getElementById('btn-run-extract');
  const progress = document.getElementById('extract-progress');
  const result = document.getElementById('extract-result');
  const empty = document.getElementById('extract-empty');

  btn.disabled = true;
  btn.textContent = '⏳ Estraendo...';
  progress.style.display = 'block';
  result.style.display = 'none';
  empty.style.display = 'none';

  try {
    const r = await API.post('/api/extract', {});
    result.innerHTML = `
      <div style="padding:16px">
        <div style="font-size:24px;font-weight:700;color:#2ecc71">✅ Estrazione completata</div>
        <div style="margin-top:8px;font-size:13px;color:#666">
          <strong>${r.extracted}</strong> file estratti
          ${r.errors > 0 ? ` · <strong style="color:#e74c3c">${r.errors}</strong> errori` : ''}
          · su <strong>${r.total}</strong> file totali
        </div>
        <div style="margin-top:4px;font-size:12px;color:#888">${r.message}</div>
      </div>`;
    result.style.display = 'block';
    loadExtractedData();
  } catch (err) {
    result.innerHTML = `<div style="padding:16px;color:#e74c3c">❌ ${err.message}</div>`;
    result.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.textContent = '▶ Esegui Estrazione';
    progress.style.display = 'none';
  }
});

async function loadExtractedData() {
  const container = document.getElementById('extracted-data-list');
  const cat = document.getElementById('extract-filter-cat').value;
  try {
    const url = cat ? `/api/extracted-data?category=${cat}` : '/api/extracted-data';
    const data = await API.get(url);
    if (data.length === 0) {
      container.innerHTML = '<div class="empty-state"><div class="icon">📋</div><p>Nessun dato estratto</p></div>';
      return;
    }

    // Group by file then by slide then by visit_group
    const byFile = {};
    for (const d of data) {
      const fk = d.file_id;
      if (!byFile[fk]) byFile[fk] = { fileName: d.file_name, region: d.region_name, category: d.slide_type, groups: {} };
      const gk = (d.visit_group || 0) + '-' + d.slide_index;
      if (!byFile[fk].groups[gk]) byFile[fk].groups[gk] = { visit_group: d.visit_group || 0, slide_index: d.slide_index, fields: [] };
      byFile[fk].groups[gk].fields.push(d);
    }

    container.innerHTML = Object.values(byFile).map(f => {
      const groupKeys = Object.keys(f.groups).sort((a,b) => {
        const ga = f.groups[a], gb = f.groups[b];
        return ga.visit_group - gb.visit_group || ga.slide_index - gb.slide_index;
      });
      const totalCampi = groupKeys.reduce((s,k) => s + f.groups[k].fields.length, 0);
      const uniqueVisits = new Set(groupKeys.map(k => f.groups[k].visit_group)).size;
      return `<div class="layout-card">
        <div class="flex" style="justify-content:space-between">
          <div>
            <div class="name">${f.fileName}</div>
            <div class="meta">
              <span class="tag">${f.region}</span>
              <span class="tag tag-orange">${f.category}</span>
              <span class="tag">${totalCampi} campi · ${uniqueVisits} visite</span>
            </div>
          </div>
        </div>
        ${(() => {
          let lastVisit = null;
          let html = '';
          for (const k of groupKeys) {
            const g = f.groups[k];
            if (g.visit_group !== lastVisit) {
              html += `<div style="margin-top:8px;padding:6px 10px;background:#1a1a2e;color:#fff;border-radius:6px;font-size:11px;font-weight:600">Visita ${g.visit_group+1}</div>`;
              lastVisit = g.visit_group;
            }
            html += `<div style="margin-top:4px;padding:8px;background:#f0f0f5;border-radius:6px">
              <div style="font-size:11px;font-weight:600;color:#e94560;margin-bottom:4px">Slide ${g.slide_index+1}</div>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;font-size:11px">
                ${g.fields.map(d => `
                  <div style="padding:3px 6px;background:#fff;border-radius:4px;border:1px solid #eee">
                    <strong style="color:#e94560">${d.field_name}</strong>
                    <span style="color:#666;margin-left:4px">${d.is_image ? '🖼️ ' + (d.image_name || '') : d.field_value ? d.field_value.substring(0, 60) : '-'}</span>
                  </div>
                `).join('')}
              </div>
            </div>`;
          }
          return html;
        })()}
      </div>`;
    }).join('');
  } catch (err) {
    container.innerHTML = `<div class="empty-state"><div class="icon">⚠️</div><p>${err.message}</p></div>`;
  }
}

document.getElementById('btn-refresh-data').addEventListener('click', loadExtractedData);
document.getElementById('extract-filter-cat').addEventListener('change', loadExtractedData);

document.getElementById('btn-multi-report').addEventListener('click', async () => {
  try {
    const data = await API.get('/api/report/multi-slide-files');
    const win = window.open('', '_blank', 'width=900,height=700');
    win.document.write(`
      <html><head><title>File con più slide</title>
      <style>
        body{font-family:system-ui;padding:20px;background:#f0f0f3;color:#1a1a2e}
        h2{margin:0 0 4px} .sub{color:#888;font-size:13px;margin-bottom:16px}
        table{width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.06)}
        th{background:#1a1a2e;color:#fff;padding:8px 12px;text-align:left;font-size:11px;text-transform:uppercase}
        td{padding:8px 12px;font-size:12px;border-bottom:1px solid #eee}
        tr:hover{background:#f8f8fc}
        .tag{display:inline-block;padding:2px 8px;border-radius:8px;font-size:10px;font-weight:600;background:#e94560;color:#fff;margin:1px}
        .tag-hotel{background:#1a1a2e}
        .big{font-size:18px;font-weight:700;color:#e94560}
      </style></head><body>
      <h2>📊 File con più slide</h2>
      <div class="sub">${data.length} file trovati — da dividere a mano sul Mac</div>
      <table>
        <tr><th>#</th><th>File</th><th>Regione</th><th>Categoria</th><th>Slide</th><th>Visite</th></tr>
        ${data.map((f,i) => `
          <tr>
            <td>${i+1}</td>
            <td><strong>${f.file_name}</strong></td>
            <td>${f.region}</td>
            <td><span class="tag ${f.slide_type === 'hotel' ? 'tag-hotel' : ''}">${f.slide_type}</span></td>
            <td><span class="big">${f.slide_count}</span></td>
            <td>${f.visit_count || '1'}</td>
          </tr>
        `).join('')}
      </table>
      <div class="sub" style="margin-top:12px;color:#e74c3c">⚠️ Hotel con più slide sono normali (vanno lasciati). Attività/venue con più slide potrebbero avere più visite da separare.</div>
      </body></html>
    `);
  } catch (err) {
    alert('Errore: ' + err.message);
  }
});

// ========== GENERATOR ==========
let genSelected = [];
let genFileNames = {}; // fileId -> fileName lookup

function buildFileNameMap(nodes) {
  if (!nodes || !Array.isArray(nodes)) return;
  for (const n of nodes) {
    if (n.type === 'file' && n.fileId) {
      genFileNames[n.fileId] = n.label;
    }
    if (n.children) buildFileNameMap(n.children);
  }
}

function buildGenTreeHTML(nodes) {
  if (!nodes || !Array.isArray(nodes)) return '';
  return nodes.map(n => {
    const hasChildren = n.children && n.children.length > 0;
    let childrenHTML = '';
    if (hasChildren) childrenHTML = `<div class="tree-children">${buildGenTreeHTML(n.children)}</div>`;
    const icon = n.type === 'region' ? '📁' : n.type === 'category' ? '📂' : '📄';
    const isSelected = n.type === 'file' && genSelected.includes(n.fileId);
    const checked = isSelected ? 'checked' : '';
    const fileClick = n.type === 'file' ? `onclick="toggleGenFile(${n.fileId}, event)"` : '';
    return `<div class="tree-node">
      <div class="tree-content ${n.type === 'file' ? 'file' : ''}" ${fileClick} data-file-id="${n.fileId || ''}">
        ${hasChildren ? `<span class="tree-toggle" onclick="toggleTree(this);event.stopPropagation()">▶</span>` : '<span style="width:16px;display:inline-block"></span>'}
        <span class="tree-icon">${icon}</span>
        ${n.type === 'file' ? `<input type="checkbox" ${checked} style="margin:0;pointer-events:none">
          <span class="tree-label">${n.label}</span>` :
          `<span class="tree-label">${n.label}</span>`}
        ${n.type === 'file' && n.extension === '.ppt' ? '<span class="file-badge ppt">ppt</span>' : ''}
      </div>
      ${childrenHTML}
    </div>`;
  }).join('');
}

function toggleGenFile(fileId, event) {
  if (!event) return;
  const cb = event.currentTarget.querySelector('input[type=checkbox]');
  if (!cb) return;
  cb.checked = !cb.checked;
  const idx = genSelected.indexOf(fileId);
  if (cb.checked && idx === -1) {
    genSelected.push(fileId);
  } else if (!cb.checked && idx !== -1) {
    genSelected.splice(idx, 1);
  }
  renderGenSelected();
}

async function loadGenTree() {
  const root = document.getElementById('gen-tree-root');
  root.innerHTML = '<div class="loading"><div class="spinner"></div> Caricamento...</div>';
  try {
    const tree = await API.get('/api/tree');
    genFileNames = {};
    buildFileNameMap(tree);
    const html = buildGenTreeHTML(tree);
    root.innerHTML = html;
  } catch (err) {
    root.innerHTML = `<div class="empty-state"><div class="icon">⚠️</div><p>${err.message}</p></div>`;
  }
}

function renderGenSelected() {
  const container = document.getElementById('gen-selected-items');
  const empty = document.getElementById('gen-empty');
  if (genSelected.length === 0) {
    empty.style.display = 'block';
    container.style.display = 'none';
    container.innerHTML = '';
    return;
  }
  empty.style.display = 'none';
  container.style.display = 'block';

  container.innerHTML = genSelected.map((id, idx) => {
    const label = genFileNames[id] || `File #${id}`;
    return `<div class="field-item gen-drag-item" draggable="true" data-idx="${idx}" data-file-id="${id}"
      ondragstart="onDragStart(event)" ondragover="onDragOver(event)" ondragenter="onDragEnter(event)"
      ondragleave="onDragLeave(event)" ondrop="onDrop(event)" ondragend="onDragEnd(event)" style="justify-content:space-between">
      <span style="cursor:grab;font-size:14px;color:#999">⠿</span>
      <span class="field-name" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">#${idx+1}. ${label}</span>
      <span>
        <button class="btn btn-sm btn-outline" onclick="removeGenItem(${idx})" style="color:#e74c3c">✕</button>
      </span>
    </div>`;
  }).join('');
}

let dragSrcIdx = null;

function onDragStart(e) {
  const el = e.target.closest('.gen-drag-item');
  if (!el) return;
  dragSrcIdx = parseInt(el.dataset.idx);
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', dragSrcIdx);
  setTimeout(() => el.classList.add('dragging'), 0);
}

function onDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
}

function onDragEnter(e) {
  const el = e.target.closest('.gen-drag-item');
  if (el && parseInt(el.dataset.idx) !== dragSrcIdx) el.classList.add('drag-over');
}

function onDragLeave(e) {
  const el = e.target.closest('.gen-drag-item');
  if (el) el.classList.remove('drag-over');
}

function onDrop(e) {
  e.preventDefault();
  const el = e.target.closest('.gen-drag-item');
  if (!el) return;
  el.classList.remove('drag-over');
  const targetIdx = parseInt(el.dataset.idx);
  if (dragSrcIdx === null || dragSrcIdx === targetIdx) return;
  const item = genSelected.splice(dragSrcIdx, 1)[0];
  genSelected.splice(targetIdx, 0, item);
  renderGenSelected();
  dragSrcIdx = null;
}

function onDragEnd(e) {
  const el = e.target.closest('.gen-drag-item');
  if (el) el.classList.remove('dragging');
  document.querySelectorAll('.gen-drag-item').forEach(x => x.classList.remove('drag-over'));
  dragSrcIdx = null;
}

function removeGenItem(idx) {
  const fileId = genSelected[idx];
  genSelected.splice(idx, 1);
  renderGenSelected();
  // Uncheck in tree
  document.querySelectorAll('#gen-tree-root input[type=checkbox]').forEach(cb => {
    const parent = cb.closest('.tree-content');
    if (parent && parseInt(parent.dataset.fileId) === fileId) cb.checked = false;
  });
}

// ========== PREVIEW MODAL ==========
async function showGenPreview() {
  if (genSelected.length === 0) { alert('Seleziona almeno un file'); return; }
  const existing = document.getElementById('gen-preview-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'gen-preview-overlay';
  overlay.innerHTML = `<div class="modal-content">
    <div class="modal-header">
      <span>Anteprima — ${genSelected.length} file selezionati</span>
      <button class="modal-close" onclick="this.closest('.modal-overlay').remove()">✕</button>
    </div>
    <div class="modal-body" id="gen-preview-body">
      <div class="loading"><div class="spinner"></div> Caricamento...</div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-sm btn-outline" onclick="this.closest('.modal-overlay').remove()">Annulla</button>
      <button class="btn btn-sm btn-primary" onclick="document.getElementById('btn-gen-generate').click();this.closest('.modal-overlay').remove()">▶ Conferma e Genera</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);

  try {
    const files = await API.post('/api/files/preview', { fileIds: genSelected });
    const body = document.getElementById('gen-preview-body');
    body.innerHTML = `<div style="font-size:13px;color:#666;margin-bottom:12px">Ordine di generazione:</div>
      <div style="display:flex;flex-direction:column;gap:8px">
      ${files.map((f, i) => `
        <div style="padding:10px 14px;background:#f8f8fc;border-radius:8px;border:1px solid #eee;display:flex;align-items:center;gap:12px">
          <span style="font-weight:700;color:#e94560;font-size:14px;min-width:28px">#${i+1}</span>
          <div style="flex:1">
            <div style="font-weight:600;font-size:13px">${f.file_name}</div>
            <div style="font-size:11px;color:#888;margin-top:2px">
              <span class="tag">${f.region || '?'}</span>
              <span class="tag tag-orange">${f.slide_type || '?'}</span>
              <span class="tag">ID #${f.id}</span>
            </div>
          </div>
        </div>
      `).join('')}</div>`;
  } catch (err) {
    document.getElementById('gen-preview-body').innerHTML = `<div class="empty-state"><div class="icon">❌</div><p>${err.message}</p></div>`;
  }
}

document.getElementById('btn-gen-preview').addEventListener('click', showGenPreview);
document.getElementById('btn-gen-refresh').addEventListener('click', loadGenTree);
document.getElementById('btn-gen-clear').addEventListener('click', () => {
  genSelected = [];
  renderGenSelected();
  document.querySelectorAll('#gen-tree-root input[type=checkbox]').forEach(cb => cb.checked = false);
});

document.getElementById('btn-gen-generate').addEventListener('click', async () => {
  if (genSelected.length === 0) { alert('Seleziona almeno un file'); return; }
  const btn = document.getElementById('btn-gen-generate');
  btn.disabled = true;
  btn.textContent = '⏳ Generazione...';
  try {
    const blob = await fetch('/api/pptx/merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileIds: genSelected }),
    }).then(r => { if (!r.ok) throw new Error('Errore'); return r.blob(); });

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `MDS3_${genSelected.length}_slide.pptx`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    alert('Errore: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '▶ Genera PPT';
  }
});

// ========== DATA MANAGEMENT ==========
let dataAllRows = [];
let dataFilteredRows = [];
let dataPage = 0;
const DATA_PAGE_SIZE = 100;

async function loadData() {
  const container = document.getElementById('data-table-container');
  const empty = document.getElementById('data-empty');
  const wrapper = document.getElementById('data-table-wrapper');
  const tbody = document.getElementById('data-table-body');
  const thead = document.getElementById('data-table-head');

  const cat = document.getElementById('data-filter-cat').value;
  const search = document.getElementById('data-search').value.toLowerCase().trim();

  try {
    const url = cat ? `/api/extracted-data?category=${cat}` : '/api/extracted-data';
    dataAllRows = await API.get(url);
    dataSelectedIds.clear();
    document.getElementById('btn-batch-edit').style.display = 'none';
    dataFilteredRows = search
      ? dataAllRows.filter(r =>
          (r.field_value && r.field_value.toLowerCase().includes(search)) ||
          (r.file_name && r.file_name.toLowerCase().includes(search)) ||
          (r.region_name && r.region_name.toLowerCase().includes(search)) ||
          (r.field_name && r.field_name.toLowerCase().includes(search))
        )
      : dataAllRows;
    dataPage = 0;
    renderDataPage();
    document.getElementById('data-page-info').textContent =
      `Pagina 1 di ${Math.max(1, Math.ceil(dataFilteredRows.length / DATA_PAGE_SIZE))} (${dataFilteredRows.length} righe)`;
    if (dataFilteredRows.length === 0) {
      empty.style.display = 'block';
      wrapper.style.display = 'none';
      return;
    }
    empty.style.display = 'none';
    wrapper.style.display = 'block';
  } catch (err) {
    empty.style.display = 'block';
    empty.innerHTML = `<div class="icon">⚠️</div><p>${err.message}</p>`;
  }
}

let dataSelectedIds = new Set();

function toggleDataCheck(id, checked) {
  if (checked) dataSelectedIds.add(id); else dataSelectedIds.delete(id);
  document.getElementById('btn-batch-edit').style.display = dataSelectedIds.size > 0 ? 'inline-flex' : 'none';
}

function toggleDataSelectAll() {
  const cb = document.getElementById('data-select-all');
  const checkboxes = document.querySelectorAll('.data-check');
  checkboxes.forEach(c => { c.checked = cb.checked; toggleDataCheck(parseInt(c.dataset.id), cb.checked); });
}

function renderDataPage() {
  const tbody = document.getElementById('data-table-body');
  const thead = document.getElementById('data-table-head');
  const start = dataPage * DATA_PAGE_SIZE;
  const pageRows = dataFilteredRows.slice(start, start + DATA_PAGE_SIZE);

  thead.innerHTML = `<tr>
    <th style="padding:8px 10px;text-align:left;width:32px"><input type="checkbox" class="data-check" id="data-select-all" onchange="toggleDataSelectAll()"></th>
    <th style="padding:8px 10px;text-align:left">ID</th>
    <th style="padding:8px 10px;text-align:left">Regione</th>
    <th style="padding:8px 10px;text-align:left">File</th>
    <th style="padding:8px 10px;text-align:left">Cat.</th>
    <th style="padding:8px 10px;text-align:left">Visita</th>
    <th style="padding:8px 10px;text-align:left">Slide</th>
    <th style="padding:8px 10px;text-align:left">Campo</th>
    <th style="padding:8px 10px;text-align:left">Valore</th>
    <th style="padding:8px 10px;text-align:left">Azioni</th>
  </tr>`;

  // Group by file_id + visit_group + slide_index for visual separation
  let lastGroupKey = null;
  tbody.innerHTML = pageRows.map((r, idx) => {
    const groupKey = r.file_id + '-' + (r.visit_group || 0) + '-' + r.slide_index;
    const isNewGroup = groupKey !== lastGroupKey;
    lastGroupKey = groupKey;
    const isImg = !!r.is_image;
    const slideLabel = 'S.' + (r.slide_index + 1);
    const visitLabel = 'V.' + ((r.visit_group || 0) + 1);
    const isChecked = dataSelectedIds.has(r.id);

    // If new group, insert separator
    const sepRow = isNewGroup && idx > 0
      ? '<tr><td colspan="10" style="padding:0;border-top:2px solid #e94560;background:transparent"></td></tr>'
      : '';

    return `${sepRow}<tr style="border-bottom:1px solid #eee;background:${isImg ? '#f0fff4' : isNewGroup ? '#fafafa' : '#fff'}" data-id="${r.id}">
      <td style="padding:6px 10px"><input type="checkbox" class="data-check" data-id="${r.id}" ${isChecked ? 'checked' : ''} onchange="toggleDataCheck(${r.id}, this.checked)"></td>
      <td style="padding:6px 10px;color:#999;font-size:11px">${r.id}</td>
      <td style="padding:6px 10px;font-size:11px">${r.region_name}</td>
      <td style="padding:6px 10px;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px" title="${r.file_name}">${r.file_name}</td>
      <td style="padding:6px 10px"><span class="tag tag-orange" style="font-size:9px">${r.slide_type}</span></td>
      <td style="padding:6px 10px;text-align:center;font-weight:700;color:#1a1a2e">${visitLabel}</td>
      <td style="padding:6px 10px;text-align:center;font-weight:${isNewGroup ? '700' : '400'};color:${isNewGroup ? '#e94560' : '#999'}">${slideLabel}</td>
      <td style="padding:6px 10px;font-weight:600;color:#e94560;font-size:11px">${r.field_name}</td>
      <td style="padding:6px 10px">
        ${isImg ? `<span style="color:#2ecc71;font-weight:600">🖼️ ${r.image_name || ''}</span>` :
          `<input type="text" class="data-edit-input" value="${(r.field_value || '').replace(/"/g, '&quot;')}" data-id="${r.id}" style="width:100%;padding:4px 6px;border:1px solid #ddd;border-radius:4px;font-size:12px">`}
      </td>
      <td style="padding:6px 10px">
        ${isImg ? '' : `<button class="btn btn-sm btn-success" onclick="saveDataValue(${r.id}, this)" style="font-size:10px">💾</button>`}
      </td>
    </tr>`;
  }).join('');
}

async function batchEditSelected() {
  if (dataSelectedIds.size === 0) { alert('Nessun record selezionato'); return; }
  const val = prompt(`Modifica ${dataSelectedIds.size} record selezionati.\nInserisci il nuovo valore per il campo:`, '');
  if (val === null) return;
  const ids = [...dataSelectedIds];
  try {
    await API.put('/api/extracted-data/batch', { ids, field_value: val });
    dataSelectedIds.clear();
    document.getElementById('btn-batch-edit').style.display = 'none';
    document.getElementById('data-select-all').checked = false;
    await loadData();
  } catch (err) {
    alert('Errore: ' + err.message);
  }
}

async function saveDataValue(id, btn) {
  const input = document.querySelector(`.data-edit-input[data-id="${id}"]`);
  if (!input) return;
  const val = input.value;
  btn.disabled = true;
  btn.textContent = '⏳';
  try {
    await API.put(`/api/extracted-data/${id}`, { field_value: val });
    btn.textContent = '✅';
    setTimeout(() => { btn.textContent = '💾'; btn.disabled = false; }, 1500);
  } catch (err) {
    alert('Errore: ' + err.message);
    btn.textContent = '💾';
    btn.disabled = false;
  }
}

document.getElementById('data-prev-page').addEventListener('click', () => {
  if (dataPage > 0) { dataPage--; renderDataPage(); dataSelectedIds.clear(); document.getElementById('btn-batch-edit').style.display = 'none'; }
});

document.getElementById('data-next-page').addEventListener('click', () => {
  const maxPage = Math.ceil(dataFilteredRows.length / DATA_PAGE_SIZE) - 1;
  if (dataPage < maxPage) { dataPage++; renderDataPage(); dataSelectedIds.clear(); document.getElementById('btn-batch-edit').style.display = 'none'; }
});

document.getElementById('data-filter-cat').addEventListener('change', loadData);
document.getElementById('data-search').addEventListener('input', loadData);
document.getElementById('btn-data-refresh').addEventListener('click', loadData);

document.getElementById('btn-batch-edit').addEventListener('click', batchEditSelected);
document.getElementById('btn-data-export-csv').addEventListener('click', () => {
  const cat = document.getElementById('data-filter-cat').value;
  const url = cat ? `/api/extracted-data/export?category=${cat}` : '/api/extracted-data/export';
  window.open(url, '_blank');
});

// ========== INIT ==========
document.getElementById('btn-refresh').addEventListener('click', loadTree);
loadTree();
loadLayoutsList();
loadGenTree();