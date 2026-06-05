const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Dirs ───────────────────────────────────────────────────────────────────
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const DATA_DIR = path.join(__dirname, 'data');
[UPLOADS_DIR, DATA_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

app.use(cors());
app.use(express.json());
app.use('/files', express.static(UPLOADS_DIR));

// ─── Multer ──────────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOADS_DIR),
  filename: (_, file, cb) => cb(null, uuidv4() + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } });

// ─── SQLite ──────────────────────────────────────────────────────────────────
const db = new Database(path.join(DATA_DIR, 'sotark.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS apps (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    package     TEXT    UNIQUE NOT NULL,
    description TEXT,
    category    TEXT    DEFAULT 'Other',
    version     TEXT    DEFAULT '1.0.0',
    size_bytes  INTEGER DEFAULT 0,
    icon_url    TEXT,
    apk_url     TEXT,
    developer   TEXT    NOT NULL,
    dev_email   TEXT,
    downloads   INTEGER DEFAULT 0,
    rating      REAL    DEFAULT 0,
    rating_cnt  INTEGER DEFAULT 0,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS reviews (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    app_id      INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    author      TEXT    NOT NULL,
    rating      INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
    text        TEXT,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS screenshots (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    app_id INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    url    TEXT    NOT NULL
  );
`);

// ─── Helpers ─────────────────────────────────────────────────────────────────
const recalcRating = db.transaction((appId) => {
  const row = db.prepare('SELECT AVG(rating) as avg, COUNT(*) as cnt FROM reviews WHERE app_id = ?').get(appId);
  db.prepare('UPDATE apps SET rating = ?, rating_cnt = ? WHERE id = ?')
    .run(parseFloat((row.avg || 0).toFixed(1)), row.cnt, appId);
});

function serveUrl(req, rel) {
  return rel ? `${req.protocol}://${req.get('host')}${rel}` : null;
}

function fmtApp(req, app) {
  return {
    ...app,
    icon_url:  serveUrl(req, app.icon_url),
    apk_url:   serveUrl(req, app.apk_url),
    size_mb:   app.size_bytes ? +(app.size_bytes / 1_048_576).toFixed(2) : 0,
    screenshots: db.prepare('SELECT url FROM screenshots WHERE app_id = ?')
      .all(app.id).map(s => serveUrl(req, s.url))
  };
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// Health
app.get('/', (_, res) => res.json({ ok: true, service: 'Sotark Play API', version: '2.0.0' }));

// LIST apps
app.get('/apps', (req, res) => {
  const { q, category, sort = 'downloads', limit = 30, offset = 0 } = req.query;
  let sql = 'SELECT * FROM apps WHERE 1=1';
  const p = [];
  if (q) { sql += ' AND (name LIKE ? OR description LIKE ? OR developer LIKE ?)'; p.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (category) { sql += ' AND category = ?'; p.push(category); }
  const cols = { downloads: 'downloads DESC', rating: 'rating DESC', newest: 'created_at DESC', name: 'name ASC' };
  sql += ` ORDER BY ${cols[sort] || cols.downloads} LIMIT ? OFFSET ?`;
  p.push(+limit, +offset);
  const apps = db.prepare(sql).all(...p).map(a => fmtApp(req, a));
  res.json({ apps, count: apps.length });
});

// GET single app
app.get('/apps/:id', (req, res) => {
  const app = db.prepare('SELECT * FROM apps WHERE id = ?').get(req.params.id);
  if (!app) return res.status(404).json({ error: 'Not found' });
  res.json(fmtApp(req, app));
});

// PUBLISH app
app.post('/apps', upload.fields([{ name: 'apk', maxCount: 1 }, { name: 'icon', maxCount: 1 }]), (req, res) => {
  try {
    const { name, package: pkg, description, category, version = '1.0.0', developer, dev_email } = req.body;
    if (!name || !pkg || !developer) return res.status(400).json({ error: 'name, package, developer required' });

    const existing = db.prepare('SELECT id FROM apps WHERE package = ?').get(pkg);
    if (existing) return res.status(409).json({ error: 'Package already exists' });

    const apkFile  = req.files?.apk?.[0];
    const iconFile = req.files?.icon?.[0];

    const info = db.prepare(
      `INSERT INTO apps (name, package, description, category, version, size_bytes, icon_url, apk_url, developer, dev_email)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      name, pkg, description || '', category || 'Other', version,
      apkFile?.size || 0,
      iconFile ? `/files/${iconFile.filename}` : null,
      apkFile  ? `/files/${apkFile.filename}`  : null,
      developer, dev_email || ''
    );

    const app = db.prepare('SELECT * FROM apps WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json(fmtApp(req, app));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// UPDATE app
app.put('/apps/:id', upload.fields([{ name: 'apk', maxCount: 1 }, { name: 'icon', maxCount: 1 }]), (req, res) => {
  const app = db.prepare('SELECT * FROM apps WHERE id = ?').get(req.params.id);
  if (!app) return res.status(404).json({ error: 'Not found' });

  const { name, description, category, version } = req.body;
  const apkFile  = req.files?.apk?.[0];
  const iconFile = req.files?.icon?.[0];

  db.prepare(
    `UPDATE apps SET
      name = COALESCE(?, name),
      description = COALESCE(?, description),
      category = COALESCE(?, category),
      version = COALESCE(?, version),
      size_bytes = COALESCE(?, size_bytes),
      icon_url = COALESCE(?, icon_url),
      apk_url = COALESCE(?, apk_url),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?`
  ).run(
    name || null, description || null, category || null, version || null,
    apkFile?.size || null,
    iconFile ? `/files/${iconFile.filename}` : null,
    apkFile  ? `/files/${apkFile.filename}`  : null,
    req.params.id
  );

  res.json(fmtApp(req, db.prepare('SELECT * FROM apps WHERE id = ?').get(req.params.id)));
});

// DELETE app
app.delete('/apps/:id', (req, res) => {
  const app = db.prepare('SELECT * FROM apps WHERE id = ?').get(req.params.id);
  if (!app) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM apps WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// DOWNLOAD (redirect + counter)
app.get('/apps/:id/download', (req, res) => {
  const app = db.prepare('SELECT * FROM apps WHERE id = ?').get(req.params.id);
  if (!app) return res.status(404).json({ error: 'Not found' });
  if (!app.apk_url) return res.status(404).json({ error: 'No APK uploaded' });
  db.prepare('UPDATE apps SET downloads = downloads + 1 WHERE id = ?').run(app.id);
  res.redirect(serveUrl(req, app.apk_url));
});

// SCREENSHOTS upload
app.post('/apps/:id/screenshots', upload.array('screenshots', 8), (req, res) => {
  const app = db.prepare('SELECT id FROM apps WHERE id = ?').get(req.params.id);
  if (!app) return res.status(404).json({ error: 'Not found' });
  const urls = (req.files || []).map(f => {
    db.prepare('INSERT INTO screenshots (app_id, url) VALUES (?, ?)').run(app.id, `/files/${f.filename}`);
    return serveUrl(req, `/files/${f.filename}`);
  });
  res.json({ screenshots: urls });
});

// REVIEWS
app.get('/apps/:id/reviews', (req, res) => {
  const reviews = db.prepare('SELECT * FROM reviews WHERE app_id = ? ORDER BY created_at DESC').all(req.params.id);
  res.json({ reviews });
});

app.post('/apps/:id/reviews', (req, res) => {
  const { author, rating, text } = req.body;
  if (!author || !rating) return res.status(400).json({ error: 'author and rating required' });
  const app = db.prepare('SELECT id FROM apps WHERE id = ?').get(req.params.id);
  if (!app) return res.status(404).json({ error: 'Not found' });
  db.prepare('INSERT INTO reviews (app_id, author, rating, text) VALUES (?, ?, ?, ?)').run(app.id, author, +rating, text || '');
  recalcRating(app.id);
  res.status(201).json({ ok: true });
});

// CATEGORIES
app.get('/categories', (_, res) => {
  const rows = db.prepare('SELECT DISTINCT category, COUNT(*) as count FROM apps GROUP BY category ORDER BY count DESC').all();
  res.json({ categories: rows });
});

// TOP
app.get('/top', (req, res) => {
  const apps = db.prepare('SELECT * FROM apps ORDER BY downloads DESC, rating DESC LIMIT 10').all().map(a => fmtApp(req, a));
  res.json({ apps });
});

// SEARCH suggestions
app.get('/suggest', (req, res) => {
  const { q } = req.query;
  if (!q) return res.json({ suggestions: [] });
  const rows = db.prepare('SELECT name FROM apps WHERE name LIKE ? LIMIT 8').all(`%${q}%`);
  res.json({ suggestions: rows.map(r => r.name) });
});

// ─── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Sotark Play API v2 running on :${PORT}`);
});
