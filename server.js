const express = require('express');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const JSZip = require('jszip');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3988;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- DB ----------
const DB_PATH = path.join(__dirname, 'database.sqlite');
function getDb() {
  try {
    const db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    return db;
  } catch (err) {
    console.error('DB error:', err.message);
    throw err;
  }
}

// ---------- LAYOUTS STORAGE ----------
const LAYOUTS_PATH = path.join(__dirname, 'layouts');
if (!fs.existsSync(LAYOUTS_PATH)) fs.mkdirSync(LAYOUTS_PATH, { recursive: true });

function loadLayouts() {
  try {
    const files = fs.readdirSync(LAYOUTS_PATH).filter(f => f.endsWith('.json'));
    return files.map(f => {
      const data = JSON.parse(fs.readFileSync(path.join(LAYOUTS_PATH, f), 'utf8'));
      return { id: f.replace('.json', ''), ...data };
    });
  } catch { return []; }
}

function saveLayout(id, data) {
  fs.writeFileSync(path.join(LAYOUTS_PATH, `${id}.json`), JSON.stringify(data, null, 2), 'utf8');
}

// ---------- API: TREE ----------
app.get('/api/tree', (req, res) => {
  const db = getDb();
  const regions = db.prepare('SELECT * FROM regions ORDER BY is_extra, name').all();
  const categories = db.prepare('SELECT DISTINCT slide_type FROM slide_files ORDER BY slide_type').all();

  const tree = [];
  const catLabels = {
    hotel: 'Hotel', ristoranti: 'Ristoranti', attivita: 'Attività',
    venue: 'Venue', slide: 'Slide singole', copertina: 'Copertine',
    sicilia: 'Sicilia',
  };

  for (const reg of regions) {
    const byCat = db.prepare(`
      SELECT slide_type, COUNT(*) as count, GROUP_CONCAT(id) as ids
      FROM slide_files WHERE region_id = ?
      GROUP BY slide_type ORDER BY slide_type
    `).all(reg.id);

    const children = [];
    for (const cat of byCat) {
      const label = catLabels[cat.slide_type] || cat.slide_type;
      const files = db.prepare(`
        SELECT id, file_name, is_cover, is_old_version, extension
        FROM slide_files WHERE region_id = ? AND slide_type = ?
        ORDER BY file_name
      `).all(reg.id, cat.slide_type);

      children.push({
        id: `cat-${reg.id}-${cat.slide_type}`,
        label: `${label} (${cat.count})`,
        type: 'category',
        children: files.map(f => ({
          id: `file-${f.id}`,
          label: f.file_name,
          type: 'file',
          fileId: f.id,
          isCover: !!f.is_cover,
          isOld: !!f.is_old_version,
          extension: f.extension,
        })),
      });
    }

    tree.push({
      id: `reg-${reg.id}`,
      label: reg.name + (reg.is_extra ? '' : ''),
      type: 'region',
      children,
    });
  }

  db.close();
  res.json(tree);
});

// ---------- API: ANALYZE SLIDE ----------
app.get('/api/files/:fileId/analyze', async (req, res) => {
  try {
    const db = getDb();
    const file = db.prepare('SELECT * FROM slide_files WHERE id = ?').get(req.params.fileId);
    if (!file) { db.close(); return res.status(404).json({ error: 'File not found' }); }
    if (!fs.existsSync(file.file_path)) { db.close(); return res.status(404).json({ error: 'File not found on disk' }); }
    if (file.extension !== '.pptx') { db.close(); return res.status(400).json({ error: 'Only .pptx files can be analyzed. Convert .ppt first.' }); }

    const fileRegion = db.prepare('SELECT name FROM regions WHERE id = ?').get(file.region_id)?.name;
    db.close();

    const data = fs.readFileSync(file.file_path);
    const zip = await JSZip.loadAsync(data);

    const slideFiles = Object.keys(zip.files)
      .filter(f => f.match(/^ppt\/slides\/slide\d+\.xml$/))
      .sort();

    if (slideFiles.length === 0) {
      return res.json({ slideCount: 0, blocks: [], fileName: file.file_name });
    }

    const allSlides = [];

    for (const slideFile of slideFiles) {
      const xml = await zip.files[slideFile].async('string');
      const blocks = await extractBlocks(xml, zip, slideFile);
      allSlides.push({ slideIndex: parseInt(slideFile.match(/\d+/)[0]), blocks });
    }

    res.json({
      slideCount: slideFiles.length,
      slides: allSlides,
      fileName: file.file_name,
      filePath: file.file_path,
      fileRegion,
      fileCategory: file.slide_type,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function extractBlocks(xml, zip, slideFile) {
  const blocks = [];
  const slideW = 12192000;
  const slideH = 6858000;

  const pxMatch = xml.match(/<p:px>(\d+)<\/p:px>/);
  const pyMatch = xml.match(/<p:py>(\d+)<\/p:py>/);
  const sw = pxMatch ? parseInt(pxMatch[1]) : slideW;
  const sh = pyMatch ? parseInt(pyMatch[1]) : slideH;

  // Pre-load rels for this slide (needed for image name resolution)
  const slideName = path.basename(slideFile, '.xml');
  const relsFile = `ppt/slides/_rels/${slideName}.xml.rels`;
  let relsXml = null;
  if (zip.files[relsFile]) {
    relsXml = await zip.files[relsFile].async('string');
  }
  const relsMap = {};
  if (relsXml) {
    const relRegex = /<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g;
    let rm;
    while ((rm = relRegex.exec(relsXml)) !== null) {
      relsMap[rm[1]] = rm[2];
    }
  }

  const spTree = xml.match(/<p:spTree[^>]*>([\s\S]*?)<\/p:spTree>/);
  if (!spTree) return blocks;
  const spTreeContent = spTree[1];

  // Parse text shapes inside spTree (handles <p:sp> anywhere including inside groups)
  const spRegex = /<p:sp>([\s\S]*?)<\/p:sp>/g;
  let m;
  while ((m = spRegex.exec(spTreeContent)) !== null) {
    const sp = m[1];
    const off = sp.match(/<a:off[^>]*x="(\d+)"[^>]*y="(\d+)"/);
    const ext = sp.match(/<a:ext[^>]*cx="(\d+)"[^>]*cy="(\d+)"\/>/);

    const texts = [];
    const tRegex = /<a:t>([^<]*)<\/a:t>/g;
    let t;
    while ((t = tRegex.exec(sp)) !== null) {
      texts.push(t[1]);
    }

    if (texts.length === 0) continue;

    const joined = texts.join('').trim();
    if (!joined) continue;

    const rPr = sp.match(/<a:rPr([^>]*)>/);
    let fontSize = 18;
    let bold = false;
    let italic = false;
    let fontFace = 'Calibri';
    let fontColor = null;

    if (rPr) {
      const szMatch = rPr[1].match(/sz="(\d+)"/);
      if (szMatch) fontSize = Math.round(parseInt(szMatch[1]) / 100);
      bold = /b="(1|true)"/.test(rPr[1]);
      italic = /i="(1|true)"/.test(rPr[1]);
      const latinMatch = rPr[1].match(/latin[^>]*typeface="([^"]+)"/);
      if (latinMatch) fontFace = latinMatch[1];
      const runColorMatch = rPr[1].match(/srgbClr val="([^"]+)"/);
      if (runColorMatch) fontColor = runColorMatch[1];
    }

    let align = 'l';
    const algnMatch = sp.match(/<a:pPr[^>]*algn="([^"]+)"/);
    if (algnMatch) align = algnMatch[1];

    let bgColor = null;
    const solidFill = sp.match(/<a:solidFill>[\s\S]*?<a:srgbClr val="([^"]+)"/);
    if (solidFill) bgColor = solidFill[1];

    blocks.push({
      x: off ? parseInt(off[1]) : 0,
      y: off ? parseInt(off[2]) : 0,
      cx: ext ? parseInt(ext[1]) : 0,
      cy: ext ? parseInt(ext[2]) : 0,
      text: joined,
      fontSize,
      bold,
      italic,
      fontFace,
      fontColor,
      align,
      bgColor,
      type: 'text',
      sortY: off ? parseInt(off[2]) : 0,
    });
  }

  // Also find <a:t> in the XML OUTSIDE <p:sp> (tables, SmartArt, etc.)
  // by removing all <p:sp>...</p:sp> content and checking remaining <a:t>
  const cleanedXml = spTreeContent.replace(/<p:sp>[\s\S]*?<\/p:sp>/g, '').replace(/<p:pic>[\s\S]*?<\/p:pic>/g, '');
  const extraRegex = /<a:t>([^<]*)<\/a:t>/g;
  let extraMatch;
  while ((extraMatch = extraRegex.exec(cleanedXml)) !== null) {
    const text = extraMatch[1].trim();
    if (!text) continue;
    // Skip text already captured in shape blocks (heuristic: if it looks like a fragment, skip)
    const alreadyCaptured = blocks.some(b => b.type === 'text' && b.text.includes(text));
    if (alreadyCaptured) continue;
    blocks.push({
      x: 0, y: 0, cx: 0, cy: 0,
      text,
      fontSize: 18, bold: false, fontFace: 'Calibri', fontColor: null,
      align: 'l', bgColor: null,
      type: 'text',
      sortY: 0,
    });
  }

  // Parse images
  const picRegex = /<p:pic>([\s\S]*?)<\/p:pic>/g;
  while ((m = picRegex.exec(spTreeContent)) !== null) {
    const pic = m[1];
    const off = pic.match(/<a:off[^>]*x="(\d+)"[^>]*y="(\d+)"/);
    const ext = pic.match(/<a:ext[^>]*cx="(\d+)"[^>]*cy="(\d+)"\/>/);

    let imageName = null;
    const blip = pic.match(/<a:blip[^>]*r:embed="([^"]+)"/);
    if (blip) {
      const target = relsMap[blip[1]];
      if (target) imageName = path.basename(target);
    }

    blocks.push({
      x: off ? parseInt(off[1]) : 0,
      y: off ? parseInt(off[2]) : 0,
      cx: ext ? parseInt(ext[1]) : 0,
      cy: ext ? parseInt(ext[2]) : 0,
      text: '[IMMAGINE]',
      imageName,
      type: 'image',
      sortY: off ? parseInt(off[2]) : 0,
    });
  }

  // Sort by position (top to bottom, left to right)
  blocks.sort((a, b) => a.sortY - b.sortY || a.x - b.x);
  // Normalize positions as percentage of slide
  for (const b of blocks) {
    b.xPct = Math.round((b.x / sw) * 100);
    b.yPct = Math.round((b.y / sh) * 100);
    b.cxPct = Math.round((b.cx / sw) * 100);
    b.cyPct = Math.round((b.cy / sh) * 100);
  }

  return blocks;
}

// ---------- API: LAYOUTS ----------
app.get('/api/layouts', (req, res) => {
  res.json(loadLayouts());
});

app.post('/api/layouts', (req, res) => {
  const { id, name, category, fields, slideCount, fileId, notes } = req.body;
  const layoutId = id || `layout_${Date.now()}`;
  const layout = {
    name: name || 'Untitled Layout',
    category: category || 'unknown',
    slideCount: slideCount || 1,
    fields: fields || [],
    sourceFileId: fileId || null,
    notes: notes || '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  saveLayout(layoutId, layout);
  res.json({ id: layoutId, ...layout });
});

app.get('/api/layouts/:id', (req, res) => {
  const filePath = path.join(LAYOUTS_PATH, `${req.params.id}.json`);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Layout not found' });
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  res.json({ id: req.params.id, ...data });
});

app.delete('/api/layouts/:id', (req, res) => {
  const filePath = path.join(LAYOUTS_PATH, `${req.params.id}.json`);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  res.json({ success: true });
});

// ---------- API: Extract images from a slide ----------
app.get('/api/files/:fileId/images', async (req, res) => {
  try {
    const db = getDb();
    const file = db.prepare('SELECT * FROM slide_files WHERE id = ?').get(req.params.fileId);
    db.close();
    if (!file) return res.status(404).json({ error: 'File not found' });
    if (!fs.existsSync(file.file_path)) return res.status(404).json({ error: 'File not found on disk' });

    const data = fs.readFileSync(file.file_path);
    const zip = await JSZip.loadAsync(data);

    // Find all media files
    const mediaFiles = Object.keys(zip.files).filter(f => f.match(/^ppt\/media\//));
    const images = [];

    for (const mediaPath of mediaFiles) {
      const ext = path.extname(mediaPath).toLowerCase();
      if (['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg'].includes(ext)) {
        const buf = await zip.files[mediaPath].async('nodebuffer');
        const base64 = buf.toString('base64');
        images.push({
          name: path.basename(mediaPath),
          path: mediaPath,
          size: buf.length,
          mime: ext === '.svg' ? 'image/svg+xml' : `image/${ext.replace('.', '')}`,
          data: `data:${ext === '.svg' ? 'image/svg+xml' : `image/${ext.replace('.', '')}`};base64,${base64}`,
        });
      }
    }

    res.json({ images, slideCount: Object.keys(zip.files).filter(f => f.match(/^ppt\/slides\/slide\d+\.xml$/)).length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- DB INIT (extracted_data) ----------
function initExtractTable() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS extracted_data (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id INTEGER NOT NULL,
      slide_index INTEGER NOT NULL DEFAULT 0,
      visit_group INTEGER NOT NULL DEFAULT 0,
      field_name TEXT NOT NULL,
      field_value TEXT,
      image_name TEXT,
      block_index INTEGER NOT NULL DEFAULT 0,
      is_image INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (file_id) REFERENCES slide_files(id),
      UNIQUE(file_id, slide_index, field_name, block_index, visit_group)
    );
    CREATE INDEX IF NOT EXISTS idx_extracted_file ON extracted_data(file_id);
    CREATE INDEX IF NOT EXISTS idx_extracted_field ON extracted_data(field_name);
  `);
  // Add visit_group column for existing databases
  try { db.exec('ALTER TABLE extracted_data ADD COLUMN visit_group INTEGER NOT NULL DEFAULT 0'); } catch (e) {}
  db.close();
}

// ---------- API: EXTRACT DATA ----------
// Map: categories that use the same layout
const LAYOUT_CATEGORY_MAP = {
  ristoranti: 'ristoranti',
  venue: 'ristoranti',      // venue uses same layout as ristoranti
  hotel: 'hotel',
  attivita: 'attivita',
};

async function analyzePPTX(filePath) {
  const data = fs.readFileSync(filePath);
  const zip = await JSZip.loadAsync(data);
  const slideFiles = Object.keys(zip.files).filter(f => f.match(/^ppt\/slides\/slide\d+\.xml$/)).sort();
  const slides = [];
  for (const sf of slideFiles) {
    const xml = await zip.files[sf].async('string');
    const blocks = await extractBlocks(xml, zip, sf);
    slides.push({ slideIndex: parseInt(sf.match(/\d+/)[0]), blocks });
  }
  return slides;
}

// Extract values from a file using a layout
function extractValuesFromLayout(slides, layout) {
  const results = [];
  for (const slide of slides) {
    const slideKey = String(slide.slideIndex - 1); // layout uses 0-based
    const slideFields = layout.fields[slideKey] || layout.fields['0'];
    if (!slideFields) continue;
    for (const f of slideFields) {
      const block = slide.blocks[f.blockIndex];
      if (!block) continue;
      const value = f.type === 'image' ? (block.imageName || '') : (block.text || '');
      results.push({
        slide_index: slide.slideIndex - 1,
        field_name: f.field,
        field_value: value,
        image_name: f.type === 'image' ? (block.imageName || null) : null,
        block_index: f.blockIndex,
        is_image: f.type === 'image' ? 1 : 0,
      });
    }
  }
  return results;
}

app.post('/api/extract', async (req, res) => {
  try {
    const db = getDb();
    // Load all layouts
    const layouts = loadLayouts();
    // Build layout map by category
    const layoutByCategory = {};
    for (const l of layouts) {
      layoutByCategory[l.category] = l;
    }

    // Get all files that have a matching layout
    const categories = Object.keys(LAYOUT_CATEGORY_MAP);
    const placeholders = categories.map(() => '?').join(',');
    const files = db.prepare(`SELECT * FROM slide_files WHERE slide_type IN (${placeholders}) ORDER BY slide_type, file_name`).all(...categories);

    // Backup database before extraction
    try {
      const fs = require('fs');
      const backupDir = path.join(__dirname, 'backups');
      if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      fs.copyFileSync(DB_PATH, path.join(backupDir, `database_${ts}.sqlite`));
    } catch (e) { console.error('Backup failed:', e.message); }

    // Clear old extracted data for these files
    const fileIds = files.map(f => f.id);
    db.prepare(`DELETE FROM extracted_data WHERE file_id IN (${fileIds.map(() => '?').join(',')})`).run(...fileIds);

    let extracted = 0;
    let errors = 0;

    for (const file of files) {
      const layoutCategory = LAYOUT_CATEGORY_MAP[file.slide_type];
      const layout = layoutByCategory[layoutCategory];
      if (!layout) continue;

      if (!fs.existsSync(file.file_path)) { errors++; continue; }
      if (file.extension !== '.pptx') { errors++; continue; }

      try {
        const slides = await analyzePPTX(file.file_path);
        const values = extractValuesFromLayout(slides, layout);

        // Assign visit groups: only for attività and venue (hotel/ristoranti are always 1 visit)
        if (values.length > 0 && (file.slide_type === 'attivita' || file.slide_type === 'venue')) {
          const bySlide = {};
          for (const v of values) {
            if (!bySlide[v.slide_index]) bySlide[v.slide_index] = [];
            bySlide[v.slide_index].push(v);
          }
          const sortedSlides = Object.keys(bySlide).map(Number).sort((a, b) => a - b);
          let currentVisit = 0;
          const visitMap = {};
          for (const si of sortedSlides) {
            const hasTesto = bySlide[si].some(v => v.field_name === 'testo' && v.field_value && v.field_value.trim().length > 0);
            if (hasTesto && si > sortedSlides[0]) currentVisit++;
            visitMap[si] = currentVisit;
          }
          for (const v of values) {
            v.visit_group = visitMap[v.slide_index] || 0;
          }
        }

        const insert = db.prepare(`
          INSERT OR REPLACE INTO extracted_data (file_id, slide_index, visit_group, field_name, field_value, image_name, block_index, is_image)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const v of values) {
          insert.run(file.id, v.slide_index, v.visit_group, v.field_name, v.field_value, v.image_name, v.block_index, v.is_image);
        }
        extracted++;
      } catch (e) {
        errors++;
      }
    }

    db.close();
    res.json({
      extracted,
      errors,
      total: files.length,
      message: `Estratti ${extracted} file, ${errors} errori su ${files.length} totali`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- API: QUERY EXTRACTED DATA ----------
app.get('/api/extracted-data', (req, res) => {
  try {
    const db = getDb();
    const { fileId, category, regionId } = req.query;

    let query = `
      SELECT ed.*, sf.file_name, sf.slide_type, r.name as region_name
      FROM extracted_data ed
      JOIN slide_files sf ON ed.file_id = sf.id
      JOIN regions r ON sf.region_id = r.id
    `;
    const params = [];
    const conditions = [];

    if (fileId) { conditions.push('ed.file_id = ?'); params.push(fileId); }
    if (category) { conditions.push('sf.slide_type = ?'); params.push(category); }
    if (regionId) { conditions.push('sf.region_id = ?'); params.push(regionId); }

    if (conditions.length > 0) query += ' WHERE ' + conditions.join(' AND ');
    query += ' ORDER BY r.name, sf.file_name, ed.slide_index, ed.visit_group, ed.block_index';

    const data = db.prepare(query).all(...params);
    db.close();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- API: SUMMARY ----------
app.get('/api/extract-summary', (req, res) => {
  try {
    const db = getDb();
    const summary = db.prepare(`
      SELECT sf.slide_type, COUNT(DISTINCT ed.file_id) as files_extracted,
             COUNT(ed.id) as total_fields,
             (SELECT COUNT(*) FROM slide_files WHERE slide_type = sf.slide_type) as files_total
      FROM slide_files sf
      LEFT JOIN extracted_data ed ON ed.file_id = sf.id
      GROUP BY sf.slide_type
      ORDER BY sf.slide_type
    `).all();
    db.close();
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- API: PPTX MERGE ----------
const { mergePPTX } = require('./pptx-merge');

app.post('/api/pptx/merge', async (req, res) => {
  try {
    const { fileIds } = req.body;
    if (!fileIds || !Array.isArray(fileIds) || fileIds.length === 0) {
      return res.status(400).json({ error: 'Specifica almeno un file' });
    }

    const db = getDb();
    const files = [];
    for (const id of fileIds) {
      const f = db.prepare('SELECT * FROM slide_files WHERE id = ?').get(id);
      if (!f) { db.close(); return res.status(404).json({ error: `File #${id} non trovato` }); }
      if (f.extension !== '.pptx') { db.close(); return res.status(400).json({ error: `"${f.file_name}" non è .pptx. Converti .ppt prima.` }); }
      if (!require('fs').existsSync(f.file_path)) { db.close(); return res.status(404).json({ error: `File "${f.file_name}" non trovato su disco` }); }
      files.push(f);
    }
    db.close();

    const filePaths = files.map(f => f.file_path);
    const buf = await mergePPTX(filePaths);

    const safeName = files.length === 1
      ? files[0].file_name.replace(/\.\w+$/, '')
      : `Merged_${files.length}_slides`;

    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'Content-Disposition': `attachment; filename="${safeName}.pptx"`,
    });
    res.send(buf);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- API: UPDATE EXTRACTED DATA ----------
app.put('/api/extracted-data/:id', (req, res) => {
  try {
    const db = getDb();
    const { field_value } = req.body;
    const existing = db.prepare('SELECT * FROM extracted_data WHERE id = ?').get(req.params.id);
    if (!existing) { db.close(); return res.status(404).json({ error: 'Record non trovato' }); }
    db.prepare('UPDATE extracted_data SET field_value = ? WHERE id = ?').run(field_value, req.params.id);
    db.close();
    res.json({ success: true, id: parseInt(req.params.id), field_value });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- API: MULTI-SLIDE FILES REPORT ----------
app.get('/api/report/multi-slide-files', (req, res) => {
  try {
    const db = getDb();
    const data = db.prepare(`
      SELECT sf.id, sf.file_name, sf.slide_type, r.name AS region,
             COUNT(DISTINCT ed.slide_index) as slide_count,
             COUNT(ed.id) as total_fields,
             COUNT(DISTINCT ed.visit_group) as visit_count
      FROM extracted_data ed
      JOIN slide_files sf ON ed.file_id = sf.id
      JOIN regions r ON sf.region_id = r.id
      GROUP BY sf.id
      HAVING CASE WHEN sf.slide_type = 'hotel' THEN COUNT(DISTINCT ed.slide_index) >= 4
             ELSE COUNT(DISTINCT ed.slide_index) > 1 END
      ORDER BY slide_count DESC, r.name, sf.file_name
    `).all();
    db.close();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- API: EXPORT EXTRACTED DATA AS CSV ----------
app.get('/api/extracted-data/export', (req, res) => {
  try {
    const db = getDb();
    const { category, regionId } = req.query;
    let query = `
      SELECT r.name AS regione, sf.file_name AS file, sf.slide_type AS categoria,
             ed.slide_index AS slide, ed.visit_group AS gruppo_visita,
             ed.field_name AS campo, ed.field_value AS valore,
             ed.image_name AS immagine, ed.is_image
      FROM extracted_data ed
      JOIN slide_files sf ON ed.file_id = sf.id
      JOIN regions r ON sf.region_id = r.id
    `;
    const params = [];
    const conds = [];
    if (category) { conds.push('sf.slide_type = ?'); params.push(category); }
    if (regionId) { conds.push('sf.region_id = ?'); params.push(regionId); }
    if (conds.length > 0) query += ' WHERE ' + conds.join(' AND ');
    query += ' ORDER BY r.name, sf.file_name, ed.slide_index, ed.visit_group, ed.block_index';

    const data = db.prepare(query).all(...params);
    db.close();

    const headers = ['regione', 'file', 'categoria', 'slide', 'gruppo_visita', 'campo', 'valore', 'immagine', 'is_image'];
    const csvLines = [headers.join(';')];
    for (const row of data) {
      const vals = headers.map(h => {
        const v = String(row[h] ?? '');
        if (v.includes(';') || v.includes('"') || v.includes('\n')) {
          return '"' + v.replace(/"/g, '""') + '"';
        }
        return v;
      });
      csvLines.push(vals.join(';'));
    }

    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="dati_estratti.csv"',
    });
    res.send('\uFEFF' + csvLines.join('\r\n'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- API: BATCH UPDATE EXTRACTED DATA ----------
app.put('/api/extracted-data/batch', (req, res) => {
  try {
    const { ids, field_value } = req.body;
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'Specifica almeno un ID' });
    }
    const db = getDb();
    const stmt = db.prepare('UPDATE extracted_data SET field_value = ? WHERE id = ?');
    const updateMany = db.transaction((items) => { for (const id of items) stmt.run(field_value, id); });
    updateMany(ids);
    db.close();
    res.json({ success: true, updated: ids.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- API: PREVIEW FILES ----------
app.post('/api/files/preview', (req, res) => {
  try {
    const { fileIds } = req.body;
    if (!fileIds || !Array.isArray(fileIds) || fileIds.length === 0) {
      return res.status(400).json({ error: 'Specifica fileIds' });
    }
    const db = getDb();
    const placeholders = fileIds.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT sf.id, sf.file_name, sf.slide_type, r.name as region
      FROM slide_files sf
      JOIN regions r ON sf.region_id = r.id
      WHERE sf.id IN (${placeholders})
    `).all(...fileIds);
    db.close();
    // Map to order as requested
    const map = {};
    for (const r of rows) map[r.id] = r;
    const ordered = fileIds.map(id => map[id]).filter(Boolean);
    res.json(ordered);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- START ----------
initExtractTable();
app.listen(PORT, () => {
  console.log(`MDS3 Layout Designer running on http://localhost:${PORT}`);
});
