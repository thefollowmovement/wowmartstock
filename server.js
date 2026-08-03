const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const XLSX = require('xlsx');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Base de données
// ---------------------------------------------------------------------------
// SQLite intégré à Node.js (>= 22.5) : aucune compilation nécessaire
const db = new DatabaseSync(path.join(DATA_DIR, 'stock.db'));
db.exec('PRAGMA journal_mode = WAL');

function withTransaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

db.exec(`
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT UNIQUE,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  price REAL NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  photo TEXT NOT NULL DEFAULT '',
  stock INTEGER NOT NULL DEFAULT 0,
  min_stock INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  delta INTEGER NOT NULL,
  stock_after INTEGER NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  session_id INTEGER,
  cancelled INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS live_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL,
  ended_at TEXT,
  report_imported_at TEXT,
  validated_at TEXT
);

-- Lignes du rapport plateforme qui ne correspondent pas à une vente « Vue à
-- l'écran » enregistrée dans l'app : gives (abonné / acheteur) et produits
-- référencés dans la boutique de la plateforme, chacun avec sa propre
-- numérotation (#1, #2…).
CREATE TABLE IF NOT EXISTS live_extras (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  ref TEXT NOT NULL DEFAULT '',
  label TEXT NOT NULL DEFAULT '',
  sold_price REAL,
  net_amount REAL,
  payment_status TEXT NOT NULL DEFAULT 'paid',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

// Migration : ajout des colonnes session_id / cancelled / sale_no / sold_price / fees
{
  const mcols = db.prepare('PRAGMA table_info(movements)').all().map((c) => c.name);
  if (!mcols.includes('session_id')) db.exec('ALTER TABLE movements ADD COLUMN session_id INTEGER');
  if (!mcols.includes('cancelled')) db.exec('ALTER TABLE movements ADD COLUMN cancelled INTEGER NOT NULL DEFAULT 0');
  if (!mcols.includes('sale_no')) db.exec('ALTER TABLE movements ADD COLUMN sale_no INTEGER');
  if (!mcols.includes('sold_price')) db.exec('ALTER TABLE movements ADD COLUMN sold_price REAL');
  if (!mcols.includes('fees')) db.exec('ALTER TABLE movements ADD COLUMN fees REAL');
  if (!mcols.includes('is_gift')) db.exec('ALTER TABLE movements ADD COLUMN is_gift INTEGER NOT NULL DEFAULT 0');
  if (!mcols.includes('payment_status')) db.exec('ALTER TABLE movements ADD COLUMN payment_status TEXT');
  if (!mcols.includes('net_amount')) db.exec('ALTER TABLE movements ADD COLUMN net_amount REAL');

  const scols = db.prepare('PRAGMA table_info(live_sessions)').all().map((c) => c.name);
  if (!scols.includes('report_imported_at')) db.exec('ALTER TABLE live_sessions ADD COLUMN report_imported_at TEXT');
  if (!scols.includes('validated_at')) db.exec('ALTER TABLE live_sessions ADD COLUMN validated_at TEXT');

  // Numérotation rétroactive des ventes des lives existants (#1, #2… par ordre chronologique)
  const toNumber = db
    .prepare(
      `SELECT id, session_id FROM movements
       WHERE session_id IS NOT NULL AND delta < 0 AND sale_no IS NULL
       ORDER BY session_id, id`
    )
    .all();
  if (toNumber.length) {
    withTransaction(() => {
      const counters = new Map();
      const upd = db.prepare('UPDATE movements SET sale_no = ? WHERE id = ?');
      for (const m of toNumber) {
        const n = (counters.get(m.session_id) || 0) + 1;
        counters.set(m.session_id, n);
        upd.run(n, m.id);
      }
    });
  }
}

// Migration depuis l'ancien schéma à stock par canal → stock unique partagé.
// Si les trois canaux ont la même valeur, elle vient d'un import dupliqué :
// on la garde une seule fois. Sinon on additionne.
{
  const cols = db.prepare('PRAGMA table_info(products)').all().map((c) => c.name);
  if (cols.includes('stock_online')) {
    withTransaction(() => {
      if (!cols.includes('stock')) {
        db.exec(`ALTER TABLE products ADD COLUMN stock INTEGER NOT NULL DEFAULT 0`);
      }
      db.exec(`
        UPDATE products SET stock = CASE
          WHEN stock_online = stock_store AND stock_store = stock_live THEN stock_online
          ELSE stock_online + stock_store + stock_live
        END`);
      db.exec(`ALTER TABLE products DROP COLUMN stock_online`);
      db.exec(`ALTER TABLE products DROP COLUMN stock_store`);
      db.exec(`ALTER TABLE products DROP COLUMN stock_live`);
    });
    console.log('Migration effectuée : stock par canal → stock unique partagé');
  }
}

// Canaux de vente (pour tracer d'où vient chaque mouvement) + 'adjust' pour
// les réassorts / corrections manuelles. 'live' reste accepté pour les
// anciens mouvements enregistrés avant la séparation TikTok / Whatnot.
const SALE_CHANNELS = ['online', 'store', 'tiktok', 'whatnot'];
const LIVE_PLATFORMS = ['tiktok', 'whatnot'];
const MOVEMENT_CHANNELS = [...SALE_CHANNELS, 'live', 'adjust'];

const now = () => new Date().toISOString();

function logMovement(productId, channel, delta, stockAfter, reason, sessionId = null, saleNo = null) {
  return db
    .prepare(
      `INSERT INTO movements (product_id, channel, delta, stock_after, reason, created_at, session_id, sale_no)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(productId, channel, delta, stockAfter, reason || '', now(), sessionId, saleNo).lastInsertRowid;
}

// ---------------------------------------------------------------------------
// Upload de photos
// ---------------------------------------------------------------------------
const photoStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname) || '.jpg').toLowerCase();
    cb(null, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`);
  },
});
const uploadPhoto = multer({
  storage: photoStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\//.test(file.mimetype)) cb(null, true);
    else cb(new Error('Le fichier doit être une image (jpg, png, webp...)'));
  },
});

// Fichiers d'import (Excel / CSV) gardés en mémoire
const uploadImport = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

// ---------------------------------------------------------------------------
// Produits
// ---------------------------------------------------------------------------
app.get('/api/products', (req, res) => {
  const search = (req.query.search || '').trim();
  let rows;
  if (search) {
    const like = `%${search}%`;
    rows = db
      .prepare(
        `SELECT * FROM products
         WHERE name LIKE ? OR sku LIKE ? OR category LIKE ?
         ORDER BY name COLLATE NOCASE`
      )
      .all(like, like, like);
  } else {
    rows = db.prepare('SELECT * FROM products ORDER BY name COLLATE NOCASE').all();
  }
  res.json(rows);
});

function readProductBody(body) {
  return {
    sku: (body.sku || '').trim() || null,
    name: (body.name || '').trim(),
    category: (body.category || '').trim(),
    price: Number(body.price) || 0,
    cost: Number(body.cost) || 0,
    stock: Math.max(0, parseInt(body.stock, 10) || 0),
    min_stock: Math.max(0, parseInt(body.min_stock, 10) || 0),
  };
}

app.post('/api/products', uploadPhoto.single('photo'), (req, res) => {
  const p = readProductBody(req.body);
  if (!p.name) return res.status(400).json({ error: 'Le nom du produit est obligatoire' });
  if (p.sku) {
    const existing = db.prepare('SELECT id FROM products WHERE sku = ?').get(p.sku);
    if (existing) return res.status(409).json({ error: `Le SKU "${p.sku}" existe déjà` });
  }
  const photo = req.file ? `/uploads/${req.file.filename}` : '';
  const ts = now();
  const info = db
    .prepare(
      `INSERT INTO products (sku, name, category, price, cost, photo, stock, min_stock, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(p.sku, p.name, p.category, p.price, p.cost, photo, p.stock, p.min_stock, ts, ts);
  const id = info.lastInsertRowid;
  if (p.stock > 0) logMovement(id, 'adjust', p.stock, p.stock, 'Création du produit');
  res.status(201).json(db.prepare('SELECT * FROM products WHERE id = ?').get(id));
});

app.put('/api/products/:id', uploadPhoto.single('photo'), (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Produit introuvable' });
  const p = readProductBody(req.body);
  if (!p.name) return res.status(400).json({ error: 'Le nom du produit est obligatoire' });
  if (p.sku) {
    const dup = db.prepare('SELECT id FROM products WHERE sku = ? AND id != ?').get(p.sku, id);
    if (dup) return res.status(409).json({ error: `Le SKU "${p.sku}" existe déjà` });
  }

  let photo = existing.photo;
  if (req.file) {
    if (existing.photo) {
      const old = path.join(UPLOADS_DIR, path.basename(existing.photo));
      fs.unlink(old, () => {});
    }
    photo = `/uploads/${req.file.filename}`;
  }

  if (p.stock !== existing.stock) {
    logMovement(id, 'adjust', p.stock - existing.stock, p.stock, 'Modification manuelle');
  }

  db.prepare(
    `UPDATE products SET sku=?, name=?, category=?, price=?, cost=?, photo=?, stock=?, min_stock=?, updated_at=?
     WHERE id=?`
  ).run(p.sku, p.name, p.category, p.price, p.cost, photo, p.stock, p.min_stock, now(), id);
  res.json(db.prepare('SELECT * FROM products WHERE id = ?').get(id));
});

app.delete('/api/products/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Produit introuvable' });
  if (existing.photo) {
    fs.unlink(path.join(UPLOADS_DIR, path.basename(existing.photo)), () => {});
  }
  db.prepare('DELETE FROM movements WHERE product_id = ?').run(id);
  db.prepare('DELETE FROM products WHERE id = ?').run(id);
  res.json({ ok: true });
});

// Mouvement de stock : { channel, delta: -1, reason, session_id }
// Le stock est partagé : une vente sur n'importe quel canal décompte du même total,
// le canal sert uniquement à tracer d'où vient la vente. session_id relie la
// vente à un live en cours (horodatée à la seconde dans l'historique).
app.post('/api/products/:id/stock', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Produit introuvable' });
  const channel = req.body.channel;
  if (!MOVEMENT_CHANNELS.includes(channel)) {
    return res.status(400).json({ error: 'Canal invalide (online, store, tiktok, whatnot ou adjust)' });
  }
  const delta = parseInt(req.body.delta, 10);
  if (!Number.isFinite(delta) || delta === 0) {
    return res.status(400).json({ error: 'Quantité invalide' });
  }
  if (delta < 0 && existing.stock <= 0) {
    return res.status(400).json({ error: 'Stock déjà à zéro' });
  }
  let sessionId = null;
  if (req.body.session_id != null) {
    const session = db.prepare('SELECT * FROM live_sessions WHERE id = ?').get(Number(req.body.session_id));
    if (!session) return res.status(404).json({ error: 'Live introuvable' });
    if (session.ended_at) return res.status(400).json({ error: 'Ce live est déjà terminé' });
    sessionId = session.id;
  }
  const after = Math.max(0, existing.stock + delta);
  const realDelta = after - existing.stock;
  if (realDelta === 0) return res.json({ product: existing, movement_id: null, sale_no: null });
  db.prepare('UPDATE products SET stock = ?, updated_at = ? WHERE id = ?').run(after, now(), id);
  const defaultReason =
    realDelta < 0 && SALE_CHANNELS.includes(channel) ? 'Vente' : 'Ajustement rapide';
  // Numéro de vente séquentiel dans le live (#1, #2…), comme sur Whatnot / TikTok
  let saleNo = null;
  if (sessionId && realDelta < 0) {
    saleNo = db
      .prepare('SELECT COALESCE(MAX(sale_no), 0) + 1 AS n FROM movements WHERE session_id = ?')
      .get(sessionId).n;
  }
  const movementId = logMovement(id, channel, realDelta, after, req.body.reason || defaultReason, sessionId, saleNo);
  res.json({
    product: db.prepare('SELECT * FROM products WHERE id = ?').get(id),
    movement_id: movementId,
    sale_no: saleNo,
  });
});

// Annulation d'un mouvement (mauvais clic pendant un live) : le stock est
// restauré via un mouvement inverse, l'original est marqué annulé.
app.post('/api/movements/:id/cancel', (req, res) => {
  const id = Number(req.params.id);
  const m = db.prepare('SELECT * FROM movements WHERE id = ?').get(id);
  if (!m) return res.status(404).json({ error: 'Mouvement introuvable' });
  if (m.cancelled) return res.status(400).json({ error: 'Mouvement déjà annulé' });
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(m.product_id);
  if (!product) return res.status(404).json({ error: 'Produit introuvable' });
  const after = Math.max(0, product.stock - m.delta);
  withTransaction(() => {
    db.prepare('UPDATE movements SET cancelled = 1 WHERE id = ?').run(id);
    db.prepare('UPDATE products SET stock = ?, updated_at = ? WHERE id = ?').run(after, now(), m.product_id);
    const reverseId = logMovement(m.product_id, 'adjust', -m.delta, after, 'Annulation', m.session_id);
    db.prepare('UPDATE movements SET cancelled = 1 WHERE id = ?').run(reverseId);
  });
  res.json({ product: db.prepare('SELECT * FROM products WHERE id = ?').get(m.product_id) });
});

// ---------------------------------------------------------------------------
// Réglages (taux de TVA)
// ---------------------------------------------------------------------------
function getSetting(key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

// Barème de frais par plateforme, pour estimer les gains nets avant l'import
// du rapport. Valeurs Whatnot relevées sur un détail de vente réel :
// commission 6,67 % du prix + frais de traitement 2,42 % + 0,25 €.
const DEFAULT_FEES = {
  whatnot: { commission: 6.67, processing: 2.42, fixed: 0.25 },
  tiktok: { commission: 0, processing: 0, fixed: 0 },
};

function getFees(platform) {
  const base = DEFAULT_FEES[platform] || { commission: 0, processing: 0, fixed: 0 };
  try {
    const raw = getSetting(`fees_${platform}`, null);
    if (raw) return { ...base, ...JSON.parse(raw) };
  } catch (e) {
    /* base conservée */
  }
  return base;
}

app.get('/api/settings', (req, res) => {
  res.json({
    vat_rate: parseFloat(getSetting('vat_rate', '20')),
    fees: { whatnot: getFees('whatnot'), tiktok: getFees('tiktok') },
  });
});

app.put('/api/settings', (req, res) => {
  if (req.body.vat_rate !== undefined) {
    const rate = parseFloat(req.body.vat_rate);
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
      return res.status(400).json({ error: 'Taux de TVA invalide (entre 0 et 100)' });
    }
    setSetting('vat_rate', rate);
  }
  if (req.body.fees) {
    for (const platform of ['whatnot', 'tiktok']) {
      const f = req.body.fees[platform];
      if (!f) continue;
      const commission = parseFloat(f.commission);
      const processing = parseFloat(f.processing);
      const fixed = parseFloat(f.fixed);
      if (
        ![commission, processing, fixed].every(Number.isFinite) ||
        commission < 0 || commission > 100 || processing < 0 || processing > 100 || fixed < 0 || fixed > 100
      ) {
        return res.status(400).json({ error: `Frais ${platform} invalides` });
      }
      setSetting(`fees_${platform}`, JSON.stringify({ commission, processing, fixed }));
    }
  }
  res.json({
    vat_rate: parseFloat(getSetting('vat_rate', '20')),
    fees: { whatnot: getFees('whatnot'), tiktok: getFees('tiktok') },
  });
});

// ---------------------------------------------------------------------------
// Statistiques + mouvements
// ---------------------------------------------------------------------------
app.get('/api/stats', (req, res) => {
  const s = db
    .prepare(
      `SELECT COUNT(*) AS products,
              COALESCE(SUM(stock),0) AS stock,
              COALESCE(SUM(stock*price),0) AS value
       FROM products`
    )
    .get();
  const low = db
    .prepare('SELECT COUNT(*) AS n FROM products WHERE stock <= min_stock AND min_stock > 0')
    .get();
  // Ventes des 30 derniers jours, par canal (hors mouvements annulés).
  // Les anciens mouvements 'live' (avant séparation) sont comptés avec TikTok.
  const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const sales = { online: 0, store: 0, tiktok: 0, whatnot: 0 };
  for (const row of db
    .prepare(
      `SELECT channel, COALESCE(SUM(-delta),0) AS sold
       FROM movements
       WHERE delta < 0 AND cancelled = 0 AND is_gift = 0 AND created_at >= ?
         AND channel IN ('online','store','tiktok','whatnot','live')
       GROUP BY channel`
    )
    .all(since)) {
    if (row.channel === 'live') sales.tiktok += row.sold;
    else sales[row.channel] += row.sold;
  }
  // Lives terminés avec des ventes mais pas encore vérifiés / validés
  const toCheck = db
    .prepare(
      `SELECT COUNT(*) AS n FROM live_sessions s
       WHERE s.ended_at IS NOT NULL AND s.validated_at IS NULL
         AND EXISTS (SELECT 1 FROM movements m WHERE m.session_id = s.id AND m.delta < 0)`
    )
    .get();
  res.json({ ...s, low: low.n, sales, lives_to_check: toCheck.n });
});

// ---------------------------------------------------------------------------
// Lives (sessions TikTok / Whatnot)
// ---------------------------------------------------------------------------
// Prix effectif d'une vente : le prix réel du rapport de la plateforme
// (sold_price) s'il a été importé, sinon le prix catalogue du produit.
// Marge = prix effectif − frais de la plateforme − coût d'achat.
const sessionSales = db.prepare(
  `SELECT m.id, m.created_at, m.delta, m.channel, m.reason, m.cancelled,
          m.sale_no, m.sold_price, m.fees, m.is_gift, m.payment_status, m.net_amount,
          p.id AS product_id, p.name AS product_name, p.sku AS product_sku,
          p.price AS product_price, p.cost AS product_cost, p.photo AS product_photo
   FROM movements m JOIN products p ON p.id = m.product_id
   WHERE m.session_id = ? AND m.delta < 0
   ORDER BY m.sale_no DESC, m.id DESC`
);

const sessionExtras = db.prepare('SELECT * FROM live_extras WHERE session_id = ? ORDER BY kind, id');

// Les cadeaux (is_gift=1) ont un prix de vente de 0 : leur coût d'achat est
// déduit de la marge. Les ventes en échec de paiement sont exclues du CA et
// de la marge. Gains nets = « Statut du gains » de la plateforme quand il est
// importé ; sinon estimation avec le barème de frais de la plateforme
// (commission % + traitement % + fixe €).
function sessionSummary(session) {
  const fees = getFees(session.platform);
  const feePct = (fees.commission + fees.processing) / 100;
  const feeFixed = fees.fixed;
  const agg = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN m.is_gift = 0 THEN -m.delta ELSE 0 END),0) AS items,
              COALESCE(SUM(CASE WHEN m.is_gift = 1 THEN -m.delta ELSE 0 END),0) AS gifts,
              COALESCE(SUM(CASE WHEN COALESCE(m.payment_status,'paid') != 'failed'
                THEN -m.delta * COALESCE(m.sold_price, p.price) ELSE 0 END),0) AS revenue,
              COALESCE(SUM(CASE WHEN COALESCE(m.payment_status,'paid') != 'failed'
                THEN -m.delta * (COALESCE(m.net_amount,
                  COALESCE(m.sold_price, p.price) - COALESCE(m.fees,
                    CASE WHEN COALESCE(m.sold_price, p.price) > 0
                      THEN COALESCE(m.sold_price, p.price) * ? + ? ELSE 0 END)) - p.cost)
                ELSE 0 END),0) AS margin,
              COALESCE(SUM(CASE WHEN m.is_gift = 0 AND m.sold_price IS NOT NULL THEN 1 ELSE 0 END),0) AS reported,
              COALESCE(SUM(CASE WHEN m.is_gift = 0 AND m.payment_status IN ('failed','pending') THEN 1 ELSE 0 END),0) AS unpaid
       FROM movements m JOIN products p ON p.id = m.product_id
       WHERE m.session_id = ? AND m.delta < 0 AND m.cancelled = 0`
    )
    .get(feePct, feeFixed, session.id);
  const extras = db
    .prepare(
      `SELECT COUNT(*) AS n,
              COALESCE(SUM(CASE WHEN payment_status != 'failed' THEN COALESCE(sold_price,0) ELSE 0 END),0) AS revenue,
              COALESCE(SUM(CASE WHEN payment_status != 'failed' THEN COALESCE(net_amount, COALESCE(sold_price,0)) ELSE 0 END),0) AS net,
              COALESCE(SUM(CASE WHEN payment_status IN ('failed','pending') THEN 1 ELSE 0 END),0) AS unpaid
       FROM live_extras WHERE session_id = ?`
    )
    .get(session.id);
  return {
    ...session,
    items: agg.items,
    gifts: agg.gifts,
    revenue: agg.revenue + extras.revenue,
    margin: agg.margin + extras.net,
    reported: agg.reported,
    unpaid: agg.unpaid + extras.unpaid,
    extras: extras.n,
  };
}

// Démarrer un live : { platform: "tiktok"|"whatnot", name? }
app.post('/api/lives', (req, res) => {
  const platform = req.body.platform;
  if (!LIVE_PLATFORMS.includes(platform)) {
    return res.status(400).json({ error: 'Plateforme invalide (tiktok ou whatnot)' });
  }
  const open = db.prepare('SELECT * FROM live_sessions WHERE ended_at IS NULL').get();
  if (open) {
    return res.status(409).json({ error: 'Un live est déjà en cours, terminez-le d’abord', session: sessionSummary(open) });
  }
  const info = db
    .prepare('INSERT INTO live_sessions (platform, name, started_at) VALUES (?, ?, ?)')
    .run(platform, (req.body.name || '').trim(), now());
  res.status(201).json(sessionSummary(db.prepare('SELECT * FROM live_sessions WHERE id = ?').get(info.lastInsertRowid)));
});

// Live en cours (pour reprendre après un rechargement de page)
app.get('/api/lives/active', (req, res) => {
  const open = db.prepare('SELECT * FROM live_sessions WHERE ended_at IS NULL').get();
  if (!open) return res.json(null);
  res.json({ ...sessionSummary(open), sales: sessionSales.all(open.id) });
});

// Historique des lives
app.get('/api/lives', (req, res) => {
  const rows = db.prepare('SELECT * FROM live_sessions ORDER BY id DESC LIMIT 100').all();
  res.json(rows.map(sessionSummary));
});

// Détail d'un live : ventes horodatées + lignes hors « Vue à l'écran »
app.get('/api/lives/:id', (req, res) => {
  const session = db.prepare('SELECT * FROM live_sessions WHERE id = ?').get(Number(req.params.id));
  if (!session) return res.status(404).json({ error: 'Live introuvable' });
  res.json({
    ...sessionSummary(session),
    sales: sessionSales.all(session.id),
    extra_lines: sessionExtras.all(session.id),
    fee_config: getFees(session.platform),
  });
});

// Validation manuelle après vérification du rapport
app.post('/api/lives/:id/validate', (req, res) => {
  const session = db.prepare('SELECT * FROM live_sessions WHERE id = ?').get(Number(req.params.id));
  if (!session) return res.status(404).json({ error: 'Live introuvable' });
  if (!session.ended_at) return res.status(400).json({ error: 'Terminez le live avant de le valider' });
  db.prepare('UPDATE live_sessions SET validated_at = ? WHERE id = ?').run(now(), session.id);
  res.json(sessionSummary(db.prepare('SELECT * FROM live_sessions WHERE id = ?').get(session.id)));
});

// Ajouter un cadeau à une vente du live : { sale_no, product_id }
// Le cadeau est rattaché au numéro de la vente (ex : vente #8 = iPad
// + 🎁 câble + 🎁 stylet), décompte le stock, prix de vente = 0.
app.post('/api/lives/:id/gift', (req, res) => {
  const session = db.prepare('SELECT * FROM live_sessions WHERE id = ?').get(Number(req.params.id));
  if (!session) return res.status(404).json({ error: 'Live introuvable' });
  if (session.ended_at) return res.status(400).json({ error: 'Ce live est déjà terminé' });
  const saleNo = parseInt(req.body.sale_no, 10);
  const sale = db
    .prepare('SELECT id FROM movements WHERE session_id = ? AND sale_no = ? AND is_gift = 0 AND delta < 0')
    .get(session.id, saleNo);
  if (!sale) return res.status(404).json({ error: `Vente #${saleNo} introuvable dans ce live` });
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(req.body.product_id));
  if (!product) return res.status(404).json({ error: 'Produit introuvable' });
  if (product.stock <= 0) return res.status(400).json({ error: 'Stock déjà à zéro pour ce produit' });

  const after = product.stock - 1;
  let movementId;
  withTransaction(() => {
    db.prepare('UPDATE products SET stock = ?, updated_at = ? WHERE id = ?').run(after, now(), product.id);
    movementId = logMovement(product.id, session.platform, -1, after, `Cadeau (vente #${saleNo})`, session.id, saleNo);
    db.prepare('UPDATE movements SET is_gift = 1, sold_price = 0 WHERE id = ?').run(movementId);
  });
  res.json({
    product: db.prepare('SELECT * FROM products WHERE id = ?').get(product.id),
    movement_id: movementId,
    sale_no: saleNo,
  });
});

app.post('/api/lives/:id/end', (req, res) => {
  const session = db.prepare('SELECT * FROM live_sessions WHERE id = ?').get(Number(req.params.id));
  if (!session) return res.status(404).json({ error: 'Live introuvable' });
  if (!session.ended_at) {
    db.prepare('UPDATE live_sessions SET ended_at = ? WHERE id = ?').run(now(), session.id);
  }
  res.json(sessionSummary(db.prepare('SELECT * FROM live_sessions WHERE id = ?').get(session.id)));
});

// Export CSV des ventes d'un live
app.get('/api/lives/:id/export.csv', (req, res) => {
  const session = db.prepare('SELECT * FROM live_sessions WHERE id = ?').get(Number(req.params.id));
  if (!session) return res.status(404).json({ error: 'Live introuvable' });
  const sales = sessionSales.all(session.id).reverse();
  const esc = (v) => {
    const s = String(v ?? '');
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const PAYMENT_FR = { paid: 'payé', pending: 'en attente', failed: 'échec' };
  const feeCfg = getFees(session.platform);
  const estFees = (price) =>
    price > 0 ? (price * (feeCfg.commission + feeCfg.processing)) / 100 + feeCfg.fixed : 0;
  const lines = sales.map((m) => {
    const eff = m.sold_price != null ? m.sold_price : m.product_price;
    const net = m.net_amount != null ? m.net_amount : eff - (m.fees != null ? m.fees : estFees(eff));
    const margin = m.cancelled ? '' : (net - m.product_cost).toFixed(2);
    return [
      m.sale_no ? `Vue à l'écran #${m.sale_no}` : '',
      new Date(m.created_at).toLocaleString('fr-FR'),
      m.product_sku, m.product_name,
      m.product_price,
      m.sold_price != null ? m.sold_price : '',
      m.fees != null ? m.fees : '',
      m.net_amount != null ? m.net_amount : '',
      margin,
      m.payment_status ? PAYMENT_FR[m.payment_status] || m.payment_status : '',
      m.cancelled ? 'annulée' : m.is_gift ? 'cadeau' : '',
    ].map(esc).join(';');
  });
  const extraLines = sessionExtras.all(session.id).map((x) =>
    [
      x.ref, '', '', x.label, '', x.sold_price ?? '', '', x.net_amount ?? '',
      x.net_amount != null ? Number(x.net_amount).toFixed(2) : '',
      PAYMENT_FR[x.payment_status] || x.payment_status, '',
    ].map(esc).join(';')
  );
  const date = new Date(session.started_at).toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="live-${session.platform}-${date}.csv"`);
  res.send('﻿' + ['Référence;Heure;SKU;Produit;Prix catalogue;Prix vendu;Frais;Gains nets;Marge;Paiement;Statut', ...lines, ...extraLines].join('\n'));
});

// ---------------------------------------------------------------------------
// Import du rapport de ventes de la plateforme (CSV Whatnot / TikTok)
// Chaque ligne du rapport est associée à la vente enregistrée dans l'app
// grâce à son numéro (#1, #2…) — on y récupère le prix de vente réel et
// les frais, pour calculer la marge.
// ---------------------------------------------------------------------------
const REPORT_PATTERNS = {
  sale_no: /^#$|^#?\s*(n°|no\b|num[ée]ro|order|commande|vente|sale|listing|placement)/i,
  name: /(produit|product|nom|name|titre|title|listing|article|description)/i,
  sold_price: /(prix de vente|prix vendu|^prix$|total de la commande|sold ?price|sale ?price|final ?price|sous.total|subtotal|price|montant)/i,
  net_amount: /(gains? nets?|statut? du gain|gains?|earn|net|payout|revers|vers[ée])/i,
  payment_status: /(statut.*(paiement|commande)|paiement|payment|pay[ée]|status)/i,
  fees: /(frais de traitement|commission|frais|fee)/i,
};

// Statut de paiement normalisé depuis le texte de la plateforme
function parsePaymentStatus(raw) {
  const s = String(raw || '').toLowerCase();
  if (/(échec|echec|échou|echou|fail|annul|cancel|refus|rembours|refund|impay|non pay)/.test(s)) return 'failed';
  if (/(attente|pending|processing|en cours|à venir|a venir|hold)/.test(s)) return 'pending';
  return 'paid';
}

// Classification d'une ligne du rapport selon sa référence :
// « Vue à l'écran #8 » → vente enregistrée dans l'app (mode live) ;
// « Give abonné #1 » / « Give acheteur #2 » → give ;
// « iPad 8 #1 » / autre → produit référencé dans la boutique de la plateforme.
// Un numéro seul (« #8 » ou « 8 ») est traité comme « Vue à l'écran ».
function classifyRef(raw) {
  const str = String(raw ?? '').trim();
  const s = str.toLowerCase();
  const numMatch = str.match(/#\s*(\d+)/);
  const num = numMatch ? parseInt(numMatch[1], 10) : /^\d+$/.test(str) ? parseInt(str, 10) : null;
  if (/vue\s*[àa]\s*l|screen|flash/.test(s) || /^#?\s*\d+$/.test(str)) return { type: 'screen', num };
  if (/give|giveaway|cadeau/.test(s)) {
    return { type: /achet|buyer|client/.test(s) ? 'give_buyer' : 'give_sub', num };
  }
  return { type: 'boutique', num };
}

function guessReportMapping(headers, rows = []) {
  const mapping = {};
  const used = new Set();
  // La colonne « référence de vente » est détectée par son contenu : c'est
  // celle dont les valeurs contiennent un numéro « #N » (Vue à l'écran #8,
  // Give abonné #1…). Plus fiable que le nom de la colonne, qui varie.
  let bestRef = null;
  let bestScore = 0;
  for (const h of headers) {
    const score = rows.filter((r) => /#\s*\d+/.test(String(r[h]))).length;
    if (score > bestScore) {
      bestScore = score;
      bestRef = h;
    }
  }
  if (bestRef && bestScore >= Math.max(1, rows.length / 2)) {
    mapping.sale_no = bestRef;
    used.add(bestRef);
  }
  for (const [field, re] of Object.entries(REPORT_PATTERNS)) {
    if (mapping[field]) continue;
    for (const h of headers) {
      if (used.has(h)) continue;
      if (re.test(String(h).trim())) {
        mapping[field] = h;
        used.add(h);
        break;
      }
    }
  }
  return mapping;
}

app.post('/api/lives/:id/report/preview', uploadImport.single('file'), (req, res) => {
  const session = db.prepare('SELECT * FROM live_sessions WHERE id = ?').get(Number(req.params.id));
  if (!session) return res.status(404).json({ error: 'Live introuvable' });
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu' });
  let workbook;
  try {
    workbook = XLSX.read(req.file.buffer, { type: 'buffer', codepage: 65001, raw: true });
  } catch (e) {
    return res.status(400).json({ error: 'Fichier illisible : format Excel ou CSV attendu' });
  }
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  if (!rows.length) return res.status(400).json({ error: 'Le fichier est vide' });
  const headers = Object.keys(rows[0]);
  const importId = crypto.randomBytes(8).toString('hex');
  pendingImports.set(importId, { rows, headers, expires: Date.now() + 30 * 60 * 1000 });
  res.json({
    importId,
    headers,
    rowCount: rows.length,
    preview: rows.slice(0, 5),
    mapping: guessReportMapping(headers, rows.slice(0, 20)),
  });
});

app.post('/api/lives/:id/report/commit', (req, res) => {
  const session = db.prepare('SELECT * FROM live_sessions WHERE id = ?').get(Number(req.params.id));
  if (!session) return res.status(404).json({ error: 'Live introuvable' });
  const { importId, mapping = {} } = req.body || {};
  const pending = pendingImports.get(importId);
  if (!pending) return res.status(410).json({ error: 'Import expiré, merci de renvoyer le fichier' });
  if (!mapping.sale_no || !mapping.sold_price) {
    return res.status(400).json({ error: 'Associez les colonnes Numéro / référence de vente et Prix de vente' });
  }

  // Seules les ventes « Vue à l'écran » (pas les cadeaux) sont associées aux
  // ventes enregistrées dans l'app
  const sales = db
    .prepare('SELECT id, sale_no FROM movements WHERE session_id = ? AND delta < 0 AND sale_no IS NOT NULL AND is_gift = 0')
    .all(session.id);
  const byNo = new Map(sales.map((s) => [s.sale_no, s.id]));

  let matched = 0;
  let skipped = 0;
  let extras = 0;
  const unmatched = [];
  withTransaction(() => {
    // ré-import : on remplace les lignes hors « Vue à l'écran » précédentes
    db.prepare('DELETE FROM live_extras WHERE session_id = ?').run(session.id);
    const upd = db.prepare('UPDATE movements SET sold_price = ?, fees = ?, net_amount = ?, payment_status = ? WHERE id = ?');
    const insExtra = db.prepare(
      `INSERT INTO live_extras (session_id, kind, ref, label, sold_price, net_amount, payment_status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const row of pending.rows) {
      const rawRef = row[mapping.sale_no];
      const { type, num } = classifyRef(rawRef);
      const price = toNum(row[mapping.sold_price]);
      const net = mapping.net_amount ? toNum(row[mapping.net_amount]) : null;
      const fees = mapping.fees ? toNum(row[mapping.fees]) : null;
      // le statut peut être dans sa propre colonne, sinon on le détecte dans
      // le texte de la colonne gains (ex : « en attente de paiement »)
      const statusSource = mapping.payment_status
        ? row[mapping.payment_status]
        : mapping.net_amount
          ? row[mapping.net_amount]
          : '';
      const status = parsePaymentStatus(statusSource);

      if (type === 'screen') {
        if (!Number.isFinite(num) || num == null || num <= 0) {
          skipped++;
          continue;
        }
        const movementId = byNo.get(num);
        if (!movementId) {
          unmatched.push(`#${num}`);
          continue;
        }
        upd.run(price, fees, net, status, movementId);
        matched++;
      } else {
        const label = mapping.name ? String(row[mapping.name]).trim() : '';
        insExtra.run(session.id, type, String(rawRef).trim(), label, price, net, status, now());
        extras++;
      }
    }
    db.prepare('UPDATE live_sessions SET report_imported_at = ?, validated_at = NULL WHERE id = ?').run(now(), session.id);
  });
  pendingImports.delete(importId);
  const fresh = db.prepare('SELECT * FROM live_sessions WHERE id = ?').get(session.id);
  const summary = sessionSummary(fresh);
  res.json({
    matched,
    skipped,
    extras,
    unmatched,
    unpaid: summary.unpaid,
    session: summary,
  });
});

app.get('/api/movements', (req, res) => {
  const rows = db
    .prepare(
      `SELECT m.*, p.name AS product_name, p.sku AS product_sku
       FROM movements m JOIN products p ON p.id = m.product_id
       ORDER BY m.id DESC LIMIT 200`
    )
    .all();
  res.json(rows);
});

// ---------------------------------------------------------------------------
// Import Excel / CSV
// ---------------------------------------------------------------------------
const pendingImports = new Map(); // importId -> { rows, headers, expires }

setInterval(() => {
  const t = Date.now();
  for (const [k, v] of pendingImports) if (v.expires < t) pendingImports.delete(k);
}, 60 * 1000).unref();

// Détection automatique des colonnes selon leur nom (français / anglais)
const FIELD_PATTERNS = {
  sku: /^(sku|ref|r[ée]f[ée]rence|code|barcode|ean|upc)/i,
  name: /^(nom|name|produit|product|titre|title|d[ée]signation|article|libell[ée])/i,
  category: /^(cat[ée]gorie|category|type|famille|collection)/i,
  price: /^(prix|price|prix de vente|pv|tarif|selling)/i,
  cost: /^(co[ûu]t|cost|prix d.achat|pa|achat|purchase)/i,
  min_stock: /(min|seuil|alerte|reorder)/i,
  stock: /^(stock|quantit[ée]|qte|qty|quantity|inventaire|inventory|disponible|available)/i,
};

function guessMapping(headers) {
  const mapping = {};
  const used = new Set();
  for (const [field, re] of Object.entries(FIELD_PATTERNS)) {
    for (const h of headers) {
      if (used.has(h)) continue;
      if (re.test(String(h).trim())) {
        mapping[field] = h;
        used.add(h);
        break;
      }
    }
  }
  return mapping;
}

app.post('/api/import/preview', uploadImport.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu' });
  let workbook;
  try {
    // raw: true — évite que "21,50" (virgule décimale) soit lu comme 2150 dans les CSV
    workbook = XLSX.read(req.file.buffer, { type: 'buffer', codepage: 65001, raw: true });
  } catch (e) {
    return res.status(400).json({ error: 'Fichier illisible : format Excel ou CSV attendu' });
  }
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  if (!rows.length) return res.status(400).json({ error: 'Le fichier est vide' });
  const headers = Object.keys(rows[0]);
  const importId = crypto.randomBytes(8).toString('hex');
  pendingImports.set(importId, { rows, headers, expires: Date.now() + 30 * 60 * 1000 });
  res.json({
    importId,
    headers,
    rowCount: rows.length,
    preview: rows.slice(0, 5),
    mapping: guessMapping(headers),
  });
});

const toInt = (v) => {
  const n = parseInt(String(v).replace(',', '.'), 10);
  return Number.isFinite(n) ? Math.max(0, n) : 0;
};
const toNum = (v) => {
  const n = parseFloat(String(v).replace(/[^\d.,-]/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
};

// { importId, mapping: { name: "Nom", sku: "Ref", stock: "Stock", ... }, mode: "set"|"add" }
app.post('/api/import/commit', (req, res) => {
  const { importId, mapping = {}, mode = 'set' } = req.body || {};
  const pending = pendingImports.get(importId);
  if (!pending) return res.status(410).json({ error: 'Import expiré, merci de renvoyer le fichier' });
  if (!mapping.name && !mapping.sku) {
    return res.status(400).json({ error: 'Associez au moins la colonne Nom ou SKU' });
  }

  const findBySku = db.prepare('SELECT * FROM products WHERE sku = ?');
  const findByName = db.prepare('SELECT * FROM products WHERE name = ? COLLATE NOCASE');
  const insert = db.prepare(
    `INSERT INTO products (sku, name, category, price, cost, photo, stock, min_stock, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, ?)`
  );

  let created = 0;
  let updated = 0;
  let skipped = 0;

  const run = () => withTransaction(() => {
    for (const row of pending.rows) {
      const get = (field) => (mapping[field] != null && mapping[field] !== '' ? row[mapping[field]] : '');
      const sku = String(get('sku')).trim() || null;
      const name = String(get('name')).trim();
      if (!sku && !name) {
        skipped++;
        continue;
      }

      const stockVal = mapping.stock ? toInt(get('stock')) : 0;
      const existing = (sku && findBySku.get(sku)) || (name && findByName.get(name)) || null;
      const ts = now();

      if (existing) {
        const sets = [];
        const vals = [];
        if (name && name !== existing.name) { sets.push('name = ?'); vals.push(name); }
        if (sku && sku !== existing.sku) { sets.push('sku = ?'); vals.push(sku); }
        if (mapping.category) { sets.push('category = ?'); vals.push(String(get('category')).trim()); }
        if (mapping.price) { sets.push('price = ?'); vals.push(toNum(get('price'))); }
        if (mapping.cost) { sets.push('cost = ?'); vals.push(toNum(get('cost'))); }
        if (mapping.min_stock) { sets.push('min_stock = ?'); vals.push(toInt(get('min_stock'))); }

        if (mapping.stock) {
          const newVal = mode === 'add' ? existing.stock + stockVal : stockVal;
          if (newVal !== existing.stock) {
            sets.push('stock = ?');
            vals.push(newVal);
            logMovement(existing.id, 'adjust', newVal - existing.stock, newVal, 'Import fichier');
          }
        }
        if (sets.length) {
          sets.push('updated_at = ?');
          vals.push(ts, existing.id);
          db.prepare(`UPDATE products SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
        }
        updated++;
      } else {
        const info = insert.run(
          sku, name || sku, String(get('category')).trim(),
          toNum(get('price')), toNum(get('cost')),
          stockVal, toInt(get('min_stock')), ts, ts
        );
        if (stockVal > 0) logMovement(info.lastInsertRowid, 'adjust', stockVal, stockVal, 'Import fichier');
        created++;
      }
    }
  });

  try {
    run();
  } catch (e) {
    return res.status(500).json({ error: `Erreur pendant l'import : ${e.message}` });
  }
  pendingImports.delete(importId);
  res.json({ created, updated, skipped });
});

// ---------------------------------------------------------------------------
// Export CSV
// ---------------------------------------------------------------------------
app.get('/api/export.csv', (req, res) => {
  const rows = db.prepare('SELECT * FROM products ORDER BY name COLLATE NOCASE').all();
  const header = 'SKU;Nom;Catégorie;Prix;Coût;Stock;Seuil alerte';
  const esc = (v) => {
    const s = String(v ?? '');
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = rows.map((p) =>
    [p.sku, p.name, p.category, p.price, p.cost, p.stock, p.min_stock].map(esc).join(';')
  );
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="stock-wowmart.csv"');
  res.send('﻿' + [header, ...lines].join('\n'));
});

// Gestion d'erreurs (multer, etc.)
app.use((err, req, res, next) => {
  res.status(400).json({ error: err.message || 'Erreur inattendue' });
});

app.listen(PORT, () => {
  console.log(`WowMart Stock démarré sur http://localhost:${PORT}`);
});
