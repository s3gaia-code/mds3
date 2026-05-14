const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, 'POWERPOINT', 'v2');
const DB_PATH = path.join(__dirname, 'database.sqlite');

// ---------- DB SCHEMA ----------
function initDb() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS regions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      category TEXT NOT NULL DEFAULT 'region',
      is_extra INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS destinations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      region_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      FOREIGN KEY (region_id) REFERENCES regions(id),
      UNIQUE(region_id, name)
    );

    CREATE TABLE IF NOT EXISTS slide_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      region_id INTEGER NOT NULL,
      destination_id INTEGER,
      slide_type TEXT NOT NULL,
      file_name TEXT NOT NULL,
      file_path TEXT NOT NULL UNIQUE,
      extension TEXT NOT NULL,
      is_old_version INTEGER NOT NULL DEFAULT 0,
      is_cover INTEGER NOT NULL DEFAULT 0,
      slide_count INTEGER DEFAULT 0,
      file_size INTEGER DEFAULT 0,
      last_modified TEXT,
      checksum TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS scan_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      level TEXT NOT NULL,
      message TEXT NOT NULL,
      details TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_slide_files_region ON slide_files(region_id);
    CREATE INDEX IF NOT EXISTS idx_slide_files_type ON slide_files(slide_type);
    CREATE INDEX IF NOT EXISTS idx_slide_files_cover ON slide_files(is_cover);
  `);

  return db;
}

// ---------- HELPERS ----------
const CATEGORY_MAP = {
  'hotel': 'hotel',
  'hoteles': 'hotel',
  'ristoranti': 'ristoranti',
  'restaurantes': 'ristoranti',
  'attività': 'attivita',
  "attivita'": 'attivita',
  'attivita': 'attivita',
  'actividades': 'attivita',
  'venue': 'venue',
  'venues': 'venue',
  'copertina': 'copertina',
  'copertine': 'copertina',
  'cover': 'copertina',
  'sicilia': 'slide',
};

const EXTRA_PREFIXES = ['_ENG', '_ESP', '_FRA', '_DEU', '_ITA', '_ESTERO', '_ENTRETENIMIENTOS', '_TEAM BUILDING', '_TEAM_BUILDING', '_EXTRA'];

function isExtraFolder(name) {
  return EXTRA_PREFIXES.some(p => name.toUpperCase().startsWith(p));
}

function getCategoryFromDir(dirname) {
  const lower = dirname.toLowerCase().replace(/['']/g, "'");
  return CATEGORY_MAP[lower] || lower;
}

function isCoverFile(filename) {
  const base = path.basename(filename, path.extname(filename)).toLowerCase();
  return base.includes('cover') || base.includes('copertina') || base.startsWith('cover');
}

function isOldVersion(filename) {
  const base = path.basename(filename, path.extname(filename));
  return base.endsWith('_');
}

function extractDestination(filename) {
  const base = path.basename(filename, path.extname(filename));
  // Patterns:
  // "Nome - cover" or "Nome - Cover" -> "Nome"
  // "COVER - Nome" -> "Nome"
  // "Nome cover" -> "Nome"
  let dest = base
    .replace(/[-–]\s*cover$/i, '')
    .replace(/^cover\s*[-–]\s*/i, '')
    .replace(/\s+cover$/i, '')
    .replace(/^cover\s+/i, '')
    .trim();
  return dest || base;
}

function extractHotelInfo(filename) {
  // Pattern: [City] Stars - HotelName
  const match = filename.match(/^\[(.+?)\]\s+(\d+)\s*[-–]\s*(.+?)\.\w+$/);
  if (match) {
    return { city: match[1].trim(), stars: parseInt(match[2]), name: match[3].trim() };
  }
  return null;
}

function extractBusinessInfo(filename) {
  // Pattern: [City] BusinessName
  const match = filename.match(/^\[(.+?)\]\s+(.+?)\.\w+$/);
  if (match) {
    return { city: match[1].trim(), name: match[2].trim() };
  }
  return null;
}

function getFileSizeKB(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch { return 0; }
}

function getLastModified(filePath) {
  try {
    return fs.statSync(filePath).mtime.toISOString();
  } catch { return null; }
}

// ---------- MAIN SCANNER ----------
function scan() {
  const db = initDb();
  const log = [];

  function addLog(level, msg, details) {
    log.push({ level, msg, details });
    const stmt = db.prepare('INSERT INTO scan_log (level, message, details) VALUES (?, ?, ?)');
    stmt.run(level, msg, details || null);
  }

  if (!fs.existsSync(ROOT)) {
    console.error(`ERROR: Root directory not found: ${ROOT}`);
    process.exit(1);
  }

  addLog('info', `Starting scan of: ${ROOT}`);

  const regionDirs = fs.readdirSync(ROOT, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('.'))
    .sort((a, b) => a.name.localeCompare(b.name));

  addLog('info', `Found ${regionDirs.length} top-level directories`);

  const allFiles = []; // for duplicate checking
  let totalFiles = 0;
  let pptCount = 0;
  let pptxCount = 0;
  let oldVersionCount = 0;

  for (const regionDir of regionDirs) {
    const regionName = regionDir.name;
    const regionPath = path.join(ROOT, regionName);
    const isExtra = isExtraFolder(regionName);

    // Insert or get region
    const insertRegion = db.prepare('INSERT OR IGNORE INTO regions (name, category, is_extra) VALUES (?, ?, ?)');
    insertRegion.run(regionName, isExtra ? 'extra' : 'region', isExtra ? 1 : 0);
    const region = db.prepare('SELECT id FROM regions WHERE name = ?').get(regionName);
    const regionId = region.id;

    addLog('info', `Processing region: ${regionName}${isExtra ? ' [EXTRA]' : ''}`);

    // Scan items in region directory
    const items = fs.readdirSync(regionPath, { withFileTypes: true });

    // Identify subcategories (directories) and standalone files
    const subdirs = items.filter(i => i.isDirectory() && !i.name.startsWith('.'));
    const files = items.filter(i => i.isFile() && !i.name.startsWith('.'));

    // Process standalone slides (covers, etc.)
    for (const file of files) {
      const ext = path.extname(file.name).toLowerCase();
      if (ext !== '.pptx' && ext !== '.ppt') {
        addLog('warning', `Skipping non-PPT file: ${path.join(regionName, file.name)}`, ext);
        continue;
      }

      if (file.name.startsWith('~$')) {
        addLog('warning', `Skipping temp Office file: ${path.join(regionName, file.name)}`);
        continue;
      }

      totalFiles++;
      if (ext === '.ppt') pptCount++;
      if (ext === '.pptx') pptxCount++;

      const isCover = isCoverFile(file.name);
      const isOld = isOldVersion(file.name);
      if (isOld) oldVersionCount++;
      const destName = isCover ? extractDestination(file.name) : null;
      const destId = insertDestination(db, regionId, destName);

      const filePath = path.join(regionPath, file.name);
      const size = getFileSizeKB(filePath);
      const modified = getLastModified(filePath);

      const insertFile = db.prepare(`
        INSERT INTO slide_files (region_id, destination_id, slide_type, file_name, file_path, extension, is_old_version, is_cover, file_size, last_modified)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insertFile.run(regionId, destId, 'slide', file.name, filePath, ext, isOld ? 1 : 0, isCover ? 1 : 0, size, modified);

      if (isCover) {
        addLog('info', `  Cover: ${file.name} -> destination "${destName}"${isOld ? ' [OLD]' : ''}`);
      }
    }

    // Process subcategories
    for (const subdir of subdirs) {
      const category = getCategoryFromDir(subdir.name);
      const subdirPath = path.join(regionPath, subdir.name);
      const subdirFiles = fs.readdirSync(subdirPath, { withFileTypes: true });

      for (const file of subdirFiles) {
        if (!file.isFile() || file.name.startsWith('.')) continue;
        const ext = path.extname(file.name).toLowerCase();
        if (ext !== '.pptx' && ext !== '.ppt') {
          addLog('warning', `Skipping non-PPT file in ${regionName}/${subdir.name}: ${file.name}`, ext);
          continue;
        }

        if (file.name.startsWith('~$')) {
          addLog('warning', `Skipping temp Office file in ${regionName}/${subdir.name}: ${file.name}`);
          continue;
        }

        totalFiles++;
        if (ext === '.ppt') pptCount++;
        if (ext === '.pptx') pptxCount++;

        const isOld = isOldVersion(file.name);
        if (isOld) oldVersionCount++;
        const isCover = category === 'copertina' || isCoverFile(file.name);

        // Extract destination from filename pattern
        let destName = null;
        if (category === 'hotel') {
          const info = extractHotelInfo(file.name);
          if (info) destName = info.city;
        } else if (['ristoranti', 'venue', 'attivita'].includes(category) && file.name.startsWith('[')) {
          const info = extractBusinessInfo(file.name);
          if (info) destName = info.city;
        }
        const destId = insertDestination(db, regionId, destName);

        const filePath = path.join(subdirPath, file.name);
        const size = getFileSizeKB(filePath);
        const modified = getLastModified(filePath);

        const insertFile = db.prepare(`
          INSERT INTO slide_files (region_id, destination_id, slide_type, file_name, file_path, extension, is_old_version, is_cover, file_size, last_modified)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        insertFile.run(regionId, destId, category, file.name, filePath, ext, isOld ? 1 : 0, isCover ? 1 : 0, size, modified);

        allFiles.push({ name: file.name, path: filePath, region: regionName, category });
      }
    }
  }

  // ---------- ANALYZE ----------
  // Duplicates check
  addLog('info', '--- DUPLICATE CHECK ---');
  const dupes = db.prepare(`
    SELECT sf1.file_name, sf1.file_path AS path1, sf2.file_path AS path2,
           r1.name AS region1, r2.name AS region2,
           sf1.slide_type AS cat1, sf2.slide_type AS cat2
    FROM slide_files sf1
    JOIN slide_files sf2 ON sf1.file_name = sf2.file_name AND sf1.id < sf2.id
    JOIN regions r1 ON sf1.region_id = r1.id
    JOIN regions r2 ON sf2.region_id = r2.id
  `).all();
  for (const d of dupes) {
    const msg = `DUPLICATE: "${d.file_name}" in ${d.region1}/${d.cat1} AND ${d.region2}/${d.cat2}`;
    addLog('warning', msg, `${d.path1} | ${d.path2}`);
  }

  // Files in wrong place heuristic
  addLog('info', '--- CROSS-REGION CHECK ---');
  // Check if any file with [City] pattern has city mismatch with region
  const cityRegionIssues = db.prepare(`
    SELECT sf.file_name, sf.file_path, r.name AS region
    FROM slide_files sf
    JOIN regions r ON sf.region_id = r.id
    WHERE sf.file_name LIKE '[%'
  `).all();
  for (const row of cityRegionIssues) {
    const match = row.file_name.match(/^\[(.+?)\]/);
    if (match) {
      const city = match[1].toLowerCase();
      const region = row.region.toLowerCase();
      // Simple heuristic: check if city name is not in region name
      const knownCities = {
        'sicilia': ['siracusa', 'catania', 'palermo', 'taormina', 'cefalu', 'agrigento', 'brucoli', 'eolie', 'isole eolie', 'vulcano', 'stromboli', 'panarea', 'lipari', 'etna', 'sciacca', 'giardini naxos'],
        'lombardia': ['milano', 'como', 'bergamo', 'sirmione', 'stresa', 'bellagio', 'monza', 'lainate', 'franciacorta', 'garda', 'tremezzo', 'menaggio', 'porleza', 'abbiategrasso', 'gallarate', 'feriolo'],
        'piemonte': ['torino', 'stresa', 'langhe', 'isola bella', 'verbania', 'novara', 'ghemme', 'rivarolo canavese', 'mergozzo', 'venaria', 'omega', 'feriolo'],
        'toscana': ['firenze', 'pisa', 'siena', 'viareggio', 'chianti', 'lucca', 'san gimignano', 'monteriggioni', 'forte dei marmi', 'colle val d\'elsa', 'san miniato', 'montalcino', 'massa', 'garfagnana'],
        'puglia': ['bari', 'lecce', 'monopoli', 'ostuni', 'otranto', 'polignano', 'taranto', 'fasano', 'matera', 'alberobello', 'conversano', 'gravina', 'lama monachile', 'gallipoli', 'foggia', 'santa maria di leuca'],
        'veneto': ['venezia', 'verona', 'padova', 'vicenza', 'trieste', 'cortina', 'gardaland', 'burano', 'murano', 'torcello', 'riviera del brenta', 'lazise', 'peschiera del garda', 'maser', 'garda', 'treviso', 'valpolicella'],
        'lazio': ['roma', 'orvieto', 'tivoli', 'castelli'],
        'liguria': ['genova', 'rapallo', 'la spezia', 'portofino', 'santa margherita', 'recco', 'sestri levante', 'cinque terre', 'san fruttuoso'],
        'basilicata': ['matera'],
        'sardegna': ['cagliari', 'alghero', 'cerdena', 'costa smeralda', 'villasimius', 'porto cervo', 'arzachena', 'cabras', 'pula', 'teulada', 'maddalena', 'gallura', 'l\'agnata'],
        'campania': ['napoli', 'pompei', 'sorrento', 'positano', 'amalfi', 'capri', 'ischia', 'castellammare'],
        'trentino': ['bolzano', 'merano', 'madonna di campiglio', 'ortisei', 'san vigilio di marebbe', 'misurina', 'lago di braies', 'castelrotto', 'porta vescovo', 'lago di fedai'],
        'friuli': ['udine', 'trieste', 'gradisca', 'pordenone', 'san daniele'],
        'marche': ['pesaro'],
        'umbria': ['perugia', 'orvieto', 'assisi', 'marmore'],
        'valle d\'aosta': ['aosta', 'courmayeur', 'saint-vincent', 'cervinia', 'cogne', 'issogne', 'skyway', 'val ferret'],
        'emilia romagna': ['bologna', 'parma', 'modena', 'rimini', 'riccione', 'santarcangelo', 'torrechiara', 'san giovanni persiceto', 'san marino', 'ferrara'],
      };
      const regionCities = knownCities[region] || [];
      if (regionCities.length > 0 && !regionCities.some(c => city.includes(c) || c.includes(city))) {
        addLog('warning', `Possible misplaced: "${row.file_name}" in ${row.region}`, row.file_path);
      }
    }
  }

  // ---------- SUMMARY ----------
  const slideTypeSummary = db.prepare(`
    SELECT sf.slide_type, COUNT(*) as count FROM slide_files sf GROUP BY sf.slide_type ORDER BY count DESC
  `).all();

  const regionSummary = db.prepare(`
    SELECT r.name, COUNT(sf.id) as count FROM regions r
    LEFT JOIN slide_files sf ON sf.region_id = r.id
    GROUP BY r.id ORDER BY count DESC
  `).all();

  const destSummary = db.prepare(`
    SELECT r.name AS region, d.name AS destination, COUNT(sf.id) as slides
    FROM destinations d
    JOIN regions r ON d.region_id = r.id
    JOIN slide_files sf ON sf.destination_id = d.id
    GROUP BY d.id ORDER BY region, destination
  `).all();

  console.log('\n========================================');
  console.log('  SCAN COMPLETE');
  console.log('========================================');
  console.log(`  Total files: ${totalFiles}`);
  console.log(`  .pptx: ${pptxCount}`);
  console.log(`  .ppt: ${pptCount} (needs conversion)`);
  console.log(`  Old versions (_): ${oldVersionCount}`);
  console.log(`  Duplicates: ${dupes.length}`);
  console.log(`  Regions: ${regionDirs.length}`);
  console.log('----------------------------------------');
  console.log('\nFiles by type:');
  for (const s of slideTypeSummary) {
    console.log(`  ${s.slide_type}: ${s.count}`);
  }
  console.log('\nFiles by region:');
  for (const r of regionSummary) {
    if (r.count > 0) console.log(`  ${r.name}: ${r.count}`);
  }
  console.log('\nDestinations found:');
  for (const d of destSummary) {
    console.log(`  ${d.region} / ${d.destination}: ${d.slides} slides`);
  }
  console.log('\nWarnings:');
  const warnings = db.prepare("SELECT message, details FROM scan_log WHERE level = 'warning'").all();
  for (const w of warnings) {
    console.log(`  ⚠ ${w.message}`);
    if (w.details) console.log(`     ${w.details}`);
  }
  console.log('\nDatabase saved to:', DB_PATH);
  console.log('========================================\n');

  db.close();
}

function insertDestination(db, regionId, destName) {
  if (!destName) return null;
  const stmt = db.prepare('INSERT OR IGNORE INTO destinations (region_id, name) VALUES (?, ?)');
  stmt.run(regionId, destName);
  const dest = db.prepare('SELECT id FROM destinations WHERE region_id = ? AND name = ?').get(regionId, destName);
  return dest ? dest.id : null;
}

// Run
scan();
