const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const XLSX = require('xlsx');
const Anthropic = require('@anthropic-ai/sdk');

const PORT = process.env.PORT || 3000;
console.log('WowMart Stock — démarrage…');
const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Base de données
// ---------------------------------------------------------------------------
// SQLite intégré à Node.js (>= 22.5) : aucune compilation nécessaire
const DB_PATH = path.join(DATA_DIR, 'stock.db');
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');

// ---------------------------------------------------------------------------
// Secret local : sert à chiffrer la clé API dans la base et à signer les
// sessions. Stocké dans data/.secret (hors git, hors sauvegardes) : une
// sauvegarde volée sur iCloud/Dropbox ne permet donc PAS de lire la clé API.
// ---------------------------------------------------------------------------
const SECRET_PATH = path.join(DATA_DIR, '.secret');
let APP_SECRET;
if (fs.existsSync(SECRET_PATH)) {
  APP_SECRET = Buffer.from(fs.readFileSync(SECRET_PATH, 'utf8').trim(), 'hex');
} else {
  APP_SECRET = crypto.randomBytes(32);
  fs.writeFileSync(SECRET_PATH, APP_SECRET.toString('hex'), { mode: 0o600 });
}
if (APP_SECRET.length !== 32) {
  console.error('data/.secret corrompu — supprimez-le pour en générer un nouveau (la clé API devra être resaisie)');
  process.exit(1);
}

// Chiffrement AES-256-GCM des valeurs sensibles stockées en base
function encryptSecret(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', APP_SECRET, iv);
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return `enc:v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
}

function decryptSecret(stored) {
  if (!stored) return '';
  if (!stored.startsWith('enc:v1:')) return stored; // ancienne valeur en clair (migrée au démarrage)
  try {
    const [, , ivB, tagB, dataB] = stored.split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', APP_SECRET, Buffer.from(ivB, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB, 'base64')), decipher.final()]).toString('utf8');
  } catch (e) {
    // secret différent (base restaurée sur une autre machine) : clé illisible
    return '';
  }
}

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
  barcode TEXT NOT NULL DEFAULT '',
  variant_group TEXT NOT NULL DEFAULT '',
  brand TEXT NOT NULL DEFAULT '',
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
  if (!mcols.includes('photo')) db.exec('ALTER TABLE movements ADD COLUMN photo TEXT');
  // Frais d'expédition / emballage payés par le vendeur, par vente (déduits de la marge)
  if (!mcols.includes('shipping_cost')) db.exec('ALTER TABLE movements ADD COLUMN shipping_cost REAL');

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
  if (!cols.includes('barcode')) db.exec(`ALTER TABLE products ADD COLUMN barcode TEXT NOT NULL DEFAULT ''`);
  // Groupe de variantes : les produits partageant le même groupe (ex : « T-shirt
  // logo ») sont affichés regroupés, chaque variante gardant son stock et son SKU
  if (!cols.includes('variant_group')) db.exec(`ALTER TABLE products ADD COLUMN variant_group TEXT NOT NULL DEFAULT ''`);
  // Marque, distincte de la catégorie (ex : marque YESIDO, catégorie Chargeurs)
  if (!cols.includes('brand')) db.exec(`ALTER TABLE products ADD COLUMN brand TEXT NOT NULL DEFAULT ''`);
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
const CHANNEL_NAMES = {
  online: 'en ligne', store: 'boutique', tiktok: 'TikTok', whatnot: 'Whatnot', live: 'live',
};

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

// Photos de ventes prises pendant les lives (étiquette #N + produit)
const LIVE_PHOTOS_DIR = path.join(UPLOADS_DIR, 'live-photos');
fs.mkdirSync(LIVE_PHOTOS_DIR, { recursive: true });
const uploadLivePhotos = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, LIVE_PHOTOS_DIR),
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname) || '.jpg').toLowerCase();
      cb(null, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: 15 * 1024 * 1024, files: 40 },
  fileFilter: (req, file, cb) => {
    if (/^image\//.test(file.mimetype)) cb(null, true);
    else cb(new Error('Les fichiers doivent être des images'));
  },
});

const app = express();
app.disable('x-powered-by');
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});
// L'interface (HTML/CSS/JS, sans aucune donnée) reste servie librement :
// nécessaire pour afficher l'écran de connexion. Les données (/api) et les
// photos (/uploads) sont derrière l'authentification.
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Protection par mot de passe (optionnelle en local, indispensable sur un
// serveur). Session = cookie signé HMAC avec le secret local ; le hachage du
// mot de passe entre dans la signature, donc changer le mot de passe
// déconnecte toutes les sessions. Hachage scrypt (résistant au brute-force).
// ---------------------------------------------------------------------------
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [, saltHex, hashHex] = String(stored).split(':');
  if (!saltHex || !hashHex) return false;
  const hash = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 32, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}

const SESSION_DAYS = 30;
function sessionSignature(expires, passwordHash) {
  return crypto.createHmac('sha256', APP_SECRET).update(`session:${expires}:${passwordHash}`).digest('hex');
}

function makeSessionToken() {
  const expires = Date.now() + SESSION_DAYS * 24 * 3600 * 1000;
  return `${expires}.${sessionSignature(expires, getSetting('app_password', ''))}`;
}

function isValidSession(token) {
  const [expiresStr, sig] = String(token || '').split('.');
  const expires = Number(expiresStr);
  if (!Number.isFinite(expires) || expires < Date.now() || !sig) return false;
  const expected = sessionSignature(expires, getSetting('app_password', ''));
  return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return '';
}

function setSessionCookie(req, res) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `wm_session=${makeSessionToken()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 24 * 3600}${secure}`
  );
}

const isAuthenticated = (req) => isValidSession(readCookie(req, 'wm_session'));

// Anti brute-force : 8 essais par IP puis 10 minutes d'attente
const loginAttempts = new Map();
function loginAllowed(ip) {
  const e = loginAttempts.get(ip);
  if (!e || e.reset < Date.now()) return true;
  return e.count < 8;
}
function recordLoginFailure(ip) {
  const e = loginAttempts.get(ip);
  if (!e || e.reset < Date.now()) loginAttempts.set(ip, { count: 1, reset: Date.now() + 10 * 60 * 1000 });
  else e.count++;
}

app.get('/api/auth/status', (req, res) => {
  const protected_ = !!getSetting('app_password', '');
  res.json({ protected: protected_, authenticated: !protected_ || isAuthenticated(req) });
});

app.post('/api/auth/login', (req, res) => {
  const stored = getSetting('app_password', '');
  if (!stored) return res.json({ ok: true });
  const ip = req.ip || 'inconnue';
  if (!loginAllowed(ip)) {
    return res.status(429).json({ error: 'Trop d’essais — réessayez dans 10 minutes' });
  }
  if (!verifyPassword(String(req.body.password || ''), stored)) {
    recordLoginFailure(ip);
    return res.status(401).json({ error: 'Mot de passe incorrect' });
  }
  loginAttempts.delete(ip);
  setSessionCookie(req, res);
  res.json({ ok: true });
});

app.post('/api/auth/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'wm_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  res.json({ ok: true });
});

// Définir / changer / retirer le mot de passe. L'ancien mot de passe est
// exigé dès qu'il en existe un.
app.post('/api/auth/password', (req, res) => {
  const stored = getSetting('app_password', '');
  if (stored && !verifyPassword(String(req.body.current_password || ''), stored)) {
    return res.status(401).json({ error: 'Mot de passe actuel incorrect' });
  }
  const next = String(req.body.new_password || '');
  if (!next) {
    db.prepare('DELETE FROM settings WHERE key = ?').run('app_password');
    res.setHeader('Set-Cookie', 'wm_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
    return res.json({ ok: true, protected: false });
  }
  if (next.length < 8) return res.status(400).json({ error: 'Le mot de passe doit faire au moins 8 caractères' });
  setSetting('app_password', hashPassword(next));
  setSessionCookie(req, res); // reste connecté sur cet appareil, les autres sessions tombent
  res.json({ ok: true, protected: true });
});

// Tout le reste (/api/* et /uploads/*) exige une session valide dès qu'un
// mot de passe est défini
app.use((req, res, next) => {
  if (!getSetting('app_password', '')) return next();
  if (isAuthenticated(req)) return next();
  res.status(401).json({ error: 'Connexion requise', auth_required: true });
});

app.use('/uploads', express.static(UPLOADS_DIR));

// ---------------------------------------------------------------------------
// Produits
// ---------------------------------------------------------------------------
app.get('/api/products', (req, res) => {
  const search = (req.query.search || '').trim();
  // sold_30d permet le tri « meilleures ventes » côté interface
  const base = `
    SELECT p.*, COALESCE(s.qty, 0) AS sold_30d
    FROM products p
    LEFT JOIN (
      SELECT product_id, SUM(-delta) AS qty FROM movements
      WHERE delta < 0 AND cancelled = 0 AND is_gift = 0
        AND channel != 'adjust'
        AND COALESCE(payment_status, 'paid') NOT IN ('failed', 'refunded')
        AND created_at >= ?
      GROUP BY product_id
    ) s ON s.product_id = p.id`;
  const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  let rows;
  if (search) {
    const like = `%${search}%`;
    rows = db
      .prepare(
        `${base} WHERE p.name LIKE ? OR p.sku LIKE ? OR p.category LIKE ? OR p.barcode LIKE ? OR p.brand LIKE ?
         ORDER BY p.name COLLATE NOCASE`
      )
      .all(since, like, like, like, like, like);
  } else {
    rows = db.prepare(`${base} ORDER BY p.name COLLATE NOCASE`).all(since);
  }
  res.json(rows);
});

function readProductBody(body) {
  return {
    sku: (body.sku || '').trim() || null,
    barcode: (body.barcode || '').trim(),
    variant_group: (body.variant_group || '').trim(),
    brand: (body.brand || '').trim(),
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
      `INSERT INTO products (sku, barcode, variant_group, brand, name, category, price, cost, photo, stock, min_stock, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(p.sku, p.barcode, p.variant_group, p.brand, p.name, p.category, p.price, p.cost, photo, p.stock, p.min_stock, ts, ts);
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
    `UPDATE products SET sku=?, barcode=?, variant_group=?, brand=?, name=?, category=?, price=?, cost=?, photo=?, stock=?, min_stock=?, updated_at=?
     WHERE id=?`
  ).run(p.sku, p.barcode, p.variant_group, p.brand, p.name, p.category, p.price, p.cost, photo, p.stock, p.min_stock, now(), id);
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

// Retour / remboursement d'une vente : l'article revient en stock et la vente
// est exclue du CA et de la marge (payment_status = 'refunded'). Différent de
// l'annulation (mauvais clic) : le retour garde la trace de la vente.
app.post('/api/movements/:id/return', (req, res) => {
  const id = Number(req.params.id);
  const m = db.prepare('SELECT * FROM movements WHERE id = ?').get(id);
  if (!m) return res.status(404).json({ error: 'Mouvement introuvable' });
  if (m.delta >= 0 || ['adjust', 'return'].includes(m.channel)) {
    return res.status(400).json({ error: 'Seule une vente peut faire l’objet d’un retour' });
  }
  if (m.cancelled) return res.status(400).json({ error: 'Cette vente a été annulée' });
  if (m.payment_status === 'refunded') return res.status(400).json({ error: 'Retour déjà enregistré pour cette vente' });
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(m.product_id);
  if (!product) return res.status(404).json({ error: 'Produit introuvable' });
  const after = product.stock - m.delta;
  withTransaction(() => {
    db.prepare('UPDATE movements SET payment_status = ? WHERE id = ?').run('refunded', id);
    db.prepare('UPDATE products SET stock = ?, updated_at = ? WHERE id = ?').run(after, now(), m.product_id);
    logMovement(
      m.product_id, 'return', -m.delta, after,
      `Retour${m.sale_no ? ` vente #${m.sale_no}` : ''} (${CHANNEL_NAMES[m.channel] || m.channel})`
    );
  });
  res.json({ product: db.prepare('SELECT * FROM products WHERE id = ?').get(m.product_id) });
});

// Frais d'expédition / emballage d'une vente (payés par le vendeur, déduits de la marge)
app.patch('/api/movements/:id/shipping', (req, res) => {
  const id = Number(req.params.id);
  const m = db.prepare('SELECT * FROM movements WHERE id = ?').get(id);
  if (!m) return res.status(404).json({ error: 'Mouvement introuvable' });
  if (m.delta >= 0) return res.status(400).json({ error: 'Les frais d’envoi s’appliquent à une vente' });
  const raw = req.body.shipping_cost;
  const val = raw === null || raw === '' || raw === undefined ? null : Number(String(raw).replace(',', '.'));
  if (val !== null && (!Number.isFinite(val) || val < 0)) {
    return res.status(400).json({ error: 'Montant invalide' });
  }
  db.prepare('UPDATE movements SET shipping_cost = ? WHERE id = ?').run(val, id);
  res.json({ ok: true, shipping_cost: val });
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
// TikTok Shop : commission ~9 % relevée sur un règlement réel (1,54 € sur
// 16,99 €) ; les frais d'expédition sont généralement compensés par la
// participation du client, et la Promotion Smart est optionnelle.
const DEFAULT_FEES = {
  whatnot: { commission: 6.67, processing: 2.42, fixed: 0.25 },
  tiktok: { commission: 9, processing: 0, fixed: 0 },
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

// Clé API Anthropic pour l'analyse des photos de ventes (vision).
// Priorité à la variable d'environnement (recommandé sur un serveur),
// sinon la clé enregistrée dans l'app — chiffrée en base (AES-256-GCM).
function getAnthropicKey() {
  return process.env.ANTHROPIC_API_KEY || decryptSecret(getSetting('anthropic_api_key', '')) || '';
}

// Migration : une clé enregistrée en clair par une ancienne version est
// chiffrée au premier démarrage
{
  const stored = getSetting('anthropic_api_key', '');
  if (stored && !stored.startsWith('enc:v1:')) {
    setSetting('anthropic_api_key', encryptSecret(stored));
    console.log('Clé API existante chiffrée dans la base ✓');
  }
}

const VISION_MODELS = ['claude-opus-5', 'claude-haiku-4-5'];

app.get('/api/settings', (req, res) => {
  res.json({
    vat_rate: parseFloat(getSetting('vat_rate', '20')),
    fees: { whatnot: getFees('whatnot'), tiktok: getFees('tiktok') },
    has_api_key: !!getAnthropicKey(),
    vision_model: getSetting('vision_model', 'claude-opus-5'),
    auto_report: getSetting('auto_report', '0') === '1',
    has_google_key: !!getSetting('google_cse_key', ''),
    google_cse_cx: getSetting('google_cse_cx', ''),
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
  if (typeof req.body.anthropic_api_key === 'string') {
    const key = req.body.anthropic_api_key.trim();
    if (key) setSetting('anthropic_api_key', encryptSecret(key));
    else db.prepare('DELETE FROM settings WHERE key = ?').run('anthropic_api_key');
  }
  if (req.body.vision_model !== undefined) {
    if (!VISION_MODELS.includes(req.body.vision_model)) {
      return res.status(400).json({ error: 'Modèle invalide' });
    }
    setSetting('vision_model', req.body.vision_model);
  }
  if (req.body.auto_report !== undefined) {
    setSetting('auto_report', req.body.auto_report ? '1' : '0');
  }
  // API Google Custom Search (recherche d'images fiable) — clé chiffrée
  if (typeof req.body.google_cse_key === 'string') {
    const key = req.body.google_cse_key.trim();
    if (key) setSetting('google_cse_key', encryptSecret(key));
    else db.prepare('DELETE FROM settings WHERE key = ?').run('google_cse_key');
  }
  if (typeof req.body.google_cse_cx === 'string') {
    const cx = req.body.google_cse_cx.trim();
    if (cx) setSetting('google_cse_cx', cx);
    else db.prepare('DELETE FROM settings WHERE key = ?').run('google_cse_cx');
  }
  res.json({
    vat_rate: parseFloat(getSetting('vat_rate', '20')),
    fees: { whatnot: getFees('whatnot'), tiktok: getFees('tiktok') },
    has_api_key: !!getAnthropicKey(),
    vision_model: getSetting('vision_model', 'claude-opus-5'),
    auto_report: getSetting('auto_report', '0') === '1',
    has_google_key: !!getSetting('google_cse_key', ''),
    google_cse_cx: getSetting('google_cse_cx', ''),
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
          m.sale_no, m.sold_price, m.fees, m.is_gift, m.payment_status, m.net_amount, m.photo,
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
              COALESCE(SUM(CASE WHEN COALESCE(m.payment_status,'paid') NOT IN ('failed','refunded')
                THEN -m.delta * COALESCE(m.sold_price, p.price) ELSE 0 END),0) AS revenue,
              COALESCE(SUM(CASE WHEN COALESCE(m.payment_status,'paid') NOT IN ('failed','refunded')
                THEN -m.delta * (COALESCE(m.net_amount,
                  COALESCE(m.sold_price, p.price) - COALESCE(m.fees,
                    CASE WHEN COALESCE(m.sold_price, p.price) > 0
                      THEN COALESCE(m.sold_price, p.price) * ? + ? ELSE 0 END)) - p.cost)
                  - COALESCE(m.shipping_cost, 0)
                ELSE 0 END),0) AS margin,
              COALESCE(SUM(CASE WHEN COALESCE(m.payment_status,'paid') NOT IN ('failed','refunded')
                THEN COALESCE(m.shipping_cost, 0) ELSE 0 END),0) AS shipping,
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
    shipping: agg.shipping,
    reported: agg.reported,
    unpaid: agg.unpaid + extras.unpaid,
    extras: extras.n,
  };
}

// Démarrer un live : { platform: "tiktok"|"whatnot", name? }
// Avec started_at + ended_at : crée un live PASSÉ, déjà terminé (pour un live
// qu'on a oublié de lancer dans l'app — les ventes seront ajoutées après coup,
// par photos ou via le rapport de la plateforme).
app.post('/api/lives', (req, res) => {
  const platform = req.body.platform;
  if (!LIVE_PLATFORMS.includes(platform)) {
    return res.status(400).json({ error: 'Plateforme invalide (tiktok ou whatnot)' });
  }

  if (req.body.started_at) {
    const started = new Date(req.body.started_at);
    const ended = new Date(req.body.ended_at || NaN);
    if (Number.isNaN(started.getTime()) || Number.isNaN(ended.getTime())) {
      return res.status(400).json({ error: 'Dates invalides' });
    }
    if (ended <= started) return res.status(400).json({ error: 'La fin du live doit être après son début' });
    if (started > new Date()) return res.status(400).json({ error: 'La date de début doit être dans le passé' });
    const info = db
      .prepare('INSERT INTO live_sessions (platform, name, started_at, ended_at) VALUES (?, ?, ?, ?)')
      .run(platform, (req.body.name || '').trim(), started.toISOString(), ended.toISOString());
    return res
      .status(201)
      .json(sessionSummary(db.prepare('SELECT * FROM live_sessions WHERE id = ?').get(info.lastInsertRowid)));
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
    // Cadeau ajouté après le live : daté comme la vente à laquelle il est rattaché
    if (session.ended_at) {
      const saleTs = db
        .prepare('SELECT created_at FROM movements WHERE id = ?')
        .get(sale.id).created_at;
      db.prepare('UPDATE movements SET created_at = ? WHERE id = ?').run(saleTs, movementId);
    }
    // Un cadeau ajouté après coup change la marge : le live devra être re-validé
    if (session.validated_at) db.prepare('UPDATE live_sessions SET validated_at = NULL WHERE id = ?').run(session.id);
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
  const PAYMENT_FR = { paid: 'payé', pending: 'en attente', failed: 'échec', refunded: 'remboursé' };
  const feeCfg = getFees(session.platform);
  const estFees = (price) =>
    price > 0 ? (price * (feeCfg.commission + feeCfg.processing)) / 100 + feeCfg.fixed : 0;
  const lines = sales.map((m) => {
    const eff = m.sold_price != null ? m.sold_price : m.product_price;
    const net = m.net_amount != null ? m.net_amount : eff - (m.fees != null ? m.fees : estFees(eff));
    const margin = m.cancelled ? '' : (net - m.product_cost - (m.shipping_cost || 0)).toFixed(2);
    return [
      m.sale_no ? `Vue à l'écran #${m.sale_no}` : '',
      new Date(m.created_at).toLocaleString('fr-FR'),
      m.product_sku, m.product_name,
      m.product_price,
      m.sold_price != null ? m.sold_price : '',
      m.fees != null ? m.fees : '',
      m.net_amount != null ? m.net_amount : '',
      m.shipping_cost != null ? m.shipping_cost : '',
      margin,
      m.payment_status ? PAYMENT_FR[m.payment_status] || m.payment_status : '',
      m.cancelled ? 'annulée' : m.is_gift ? 'cadeau' : '',
    ].map(esc).join(';');
  });
  const extraLines = sessionExtras.all(session.id).map((x) =>
    [
      x.ref, '', '', x.label, '', x.sold_price ?? '', '', x.net_amount ?? '', '',
      x.net_amount != null ? Number(x.net_amount).toFixed(2) : '',
      PAYMENT_FR[x.payment_status] || x.payment_status, '',
    ].map(esc).join(';')
  );
  const date = new Date(session.started_at).toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="live-${session.platform}-${date}.csv"`);
  res.send('﻿' + ['Référence;Heure;SKU;Produit;Prix catalogue;Prix vendu;Frais;Gains nets;Frais envoi;Marge;Paiement;Statut', ...lines, ...extraLines].join('\n'));
});

// ---------------------------------------------------------------------------
// Import du rapport de ventes de la plateforme (CSV Whatnot / TikTok)
// Chaque ligne du rapport est associée à la vente enregistrée dans l'app
// grâce à son numéro (#1, #2…) — on y récupère le prix de vente réel et
// les frais, pour calculer la marge.
// ---------------------------------------------------------------------------
const REPORT_PATTERNS = {
  sale_no: /^#$|^id|^#?\s*(n°|no\b|num[ée]ro|order|commande|vente\b|sale\b|listing|placement|r[ée]f[ée]rence)/i,
  name: /(produit|product|nom|name|titre|title|listing|article|description)/i,
  sold_price: /(prix de vente|prix vendu|^prix$|total de la commande|ventes nettes|sold ?price|sale ?price|final ?price|sous.total|subtotal|price|montant(?! total du r))/i,
  net_amount: /(gains? nets?|statut? du gain|montant total du r[èe]glement|r[èe]glement|settlement|gains?|earn|net|payout|revers|vers[ée])/i,
  payment_status: /(statut.*(paiement|commande|r[èe]glement)|motifs? d.absence|paiement|payment|pay[ée]|status)/i,
  fees: /(frais de traitement|frais de commission|commission|frais|fee)/i,
};

// Statut de paiement normalisé depuis le texte de la plateforme
// (« Échec du paiement », « En attente de la livraison », « paid »…)
function parsePaymentStatus(raw) {
  const s = String(raw || '').toLowerCase();
  if (/(échec|echec|échou|echou|fail|annul|cancel|refus|rembours|refund|impay|non pay)/.test(s)) return 'failed';
  if (/(attente|pending|processing|en cours|à venir|a venir|hold|livraison)/.test(s)) return 'pending';
  return 'paid';
}

// Classification d'une ligne du rapport selon sa référence :
// « Vue à l'écran #8 » → vente enregistrée dans l'app (mode live) ;
// « Give abonné #1 » / « Give acheteur #2 » → give ;
// « iPad 8 #1 » / autre → produit référencé dans la boutique de la plateforme.
// Un numéro court seul (« #8 » ou « 8 ») est traité comme « Vue à l'écran » ;
// un numéro long (ID de commande TikTok, ex : 576930909311179742) est une
// commande boutique, jamais un numéro de vente à l'écran.
function classifyRef(raw) {
  const str = String(raw ?? '').trim();
  const s = str.toLowerCase();
  const numMatch = str.match(/#\s*(\d+)/);
  const digits = numMatch ? numMatch[1] : /^\d+$/.test(str) ? str : null;
  if (digits && digits.length >= 7) return { type: 'order', num: null };
  const num = digits ? parseInt(digits, 10) : null;
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
  const looksLikeRef = (v) => {
    const s = String(v).trim();
    return /#\s*\d+/.test(s) || /^\d{7,}$/.test(s); // « Vue à l'écran #8 » ou ID de commande long
  };
  for (const h of headers) {
    const score = rows.filter((r) => looksLikeRef(r[h])).length;
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

// Filtres : ?q=<produit/sku> &channel= &days= &page= (50 par page)
app.get('/api/movements', (req, res) => {
  const q = (req.query.q || '').trim();
  const channel = (req.query.channel || '').trim();
  const days = Number(req.query.days) || 0;
  const page = Math.max(1, Number(req.query.page) || 1);
  const PER_PAGE = 50;

  const where = [];
  const params = [];
  if (q) {
    where.push('(p.name LIKE ? OR p.sku LIKE ? OR p.barcode LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  if (channel === 'tiktok') {
    // Les anciennes ventes en live étaient enregistrées sous le canal « live »
    where.push(`m.channel IN ('tiktok', 'live')`);
  } else if (channel) {
    where.push('m.channel = ?');
    params.push(channel);
  }
  if (days > 0) {
    where.push('m.created_at >= ?');
    params.push(new Date(Date.now() - days * 86400e3).toISOString());
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = db
    .prepare(`SELECT COUNT(*) AS n FROM movements m JOIN products p ON p.id = m.product_id ${whereSql}`)
    .get(...params).n;
  const rows = db
    .prepare(
      `SELECT m.*, p.name AS product_name, p.sku AS product_sku
       FROM movements m JOIN products p ON p.id = m.product_id
       ${whereSql}
       ORDER BY m.id DESC LIMIT ? OFFSET ?`
    )
    .all(...params, PER_PAGE, (page - 1) * PER_PAGE);
  res.json({ rows, total, page, pages: Math.max(1, Math.ceil(total / PER_PAGE)) });
});

// ---------------------------------------------------------------------------
// Recherche de photos produits sur le web (marque + référence + nom).
// L'app propose plusieurs candidates par produit, l'utilisateur choisit,
// puis le serveur télécharge l'image choisie dans uploads/.
// Moteurs : Bing Images (HTML server-rendered), puis DuckDuckGo en secours.
// ---------------------------------------------------------------------------
const IMG_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

function fetchWithTimeout(url, options = {}, ms = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...options, signal: ctrl.signal }).finally(() => clearTimeout(t));
}

// Moteur principal : l'API officielle Google Custom Search (fiable, 100
// recherches gratuites par jour). Nécessite une clé API + un ID de moteur
// (cx), enregistrés dans la modale « Photos web ».
async function searchImagesGoogle(query) {
  const key = decryptSecret(getSetting('google_cse_key', ''));
  const cx = getSetting('google_cse_cx', '');
  if (!key || !cx) return null; // non configurée
  const url =
    `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(key)}&cx=${encodeURIComponent(cx)}` +
    `&q=${encodeURIComponent(query)}&searchType=image&num=6&safe=active&gl=fr&hl=fr`;
  const res = await fetchWithTimeout(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const reason = data.error && data.error.errors && data.error.errors[0] && data.error.errors[0].reason;
    if (res.status === 429 || reason === 'rateLimitExceeded' || reason === 'dailyLimitExceeded') {
      throw new Error('Quota Google gratuit atteint (100 recherches/jour) — réessayez demain');
    }
    if (res.status === 400 || res.status === 403) {
      throw new Error(`Google : clé API ou ID de moteur invalide (${(data.error && data.error.message) || res.status})`);
    }
    throw new Error(`Google HTTP ${res.status}`);
  }
  return (data.items || []).map((it) => ({
    full: it.link,
    thumb: (it.image && it.image.thumbnailLink) || it.link,
  }));
}

// Les URL d'images sont intégrées dans le HTML de Bing en JSON encodé
// (attribut m="{...murl...}" des vignettes) — pas besoin d'exécuter de JS.
// Bing sert parfois une page « tendances » aux robots : on la détecte pour ne
// pas renvoyer des images sans rapport avec la recherche.
async function searchImagesBing(query) {
  const res = await fetchWithTimeout(
    `https://www.bing.com/images/search?q=${encodeURIComponent(query)}&count=10&adlt=strict`,
    { headers: { 'User-Agent': IMG_UA, 'Accept-Language': 'fr-FR,fr;q=0.9' } }
  );
  if (!res.ok) throw new Error(`Bing HTTP ${res.status}`);
  const html = await res.text();
  if (!html.includes('iusc') || !/images\/search/.test(res.url || '')) {
    throw new Error('Bing a renvoyé une page inattendue (anti-robot)');
  }
  const out = [];
  const re = /class="iusc"[^>]*\sm="({[^"]+})"/g;
  let m;
  while ((m = re.exec(html)) && out.length < 6) {
    try {
      const obj = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
      if (obj.murl && /^https?:/i.test(obj.murl)) out.push({ full: obj.murl, thumb: obj.turl || obj.murl });
    } catch (e) {
      /* bloc non pertinent */
    }
  }
  return out;
}

async function searchImagesDdg(query) {
  const res1 = await fetchWithTimeout(
    `https://duckduckgo.com/?q=${encodeURIComponent(query)}&iax=images&ia=images`,
    { headers: { 'User-Agent': IMG_UA } }
  );
  const vqd = ((await res1.text()).match(/vqd=["']?([\d-]+)/) || [])[1];
  if (!vqd) throw new Error('jeton DuckDuckGo introuvable');
  const res2 = await fetchWithTimeout(
    `https://duckduckgo.com/i.js?l=fr-fr&o=json&q=${encodeURIComponent(query)}&vqd=${vqd}&p=1`,
    { headers: { 'User-Agent': IMG_UA, Referer: 'https://duckduckgo.com/' } }
  );
  if (!res2.ok) throw new Error(`DuckDuckGo HTTP ${res2.status}`);
  const data = await res2.json();
  return (data.results || []).slice(0, 6).map((r) => ({ full: r.image, thumb: r.thumbnail }));
}

async function searchProductImages(query) {
  // Mode test hors ligne (WM_FAKE_IMAGES=1) : candidates locales factices
  if (process.env.WM_FAKE_IMAGES) {
    return [1, 2, 3].map((i) => ({
      full: `http://localhost:${PORT}/img/tiktok.svg?fake=${i}`,
      thumb: `/img/tiktok.svg?fake=${i}`,
    }));
  }
  // 1. API Google officielle si configurée (fiable). Ses erreurs de quota ou
  //    de clé sont remontées telles quelles : pas de repli silencieux vers un
  //    moteur moins fiable.
  const google = await searchImagesGoogle(query);
  if (google !== null) return google;
  // 2. Sinon : Bing puis DuckDuckGo (scraping, fiabilité limitée)
  try {
    const bing = await searchImagesBing(query);
    if (bing.length) return bing;
  } catch (e) {
    /* on tente DuckDuckGo */
  }
  return searchImagesDdg(query);
}

// Recherche par lot : { ids: [productId, ...] } (10 max par appel)
app.post('/api/photos/search', async (req, res) => {
  const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).slice(0, 10).map(Number);
  if (!ids.length) return res.status(400).json({ error: 'Aucun produit demandé' });
  const results = [];
  for (const id of ids) {
    const p = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
    if (!p) continue;
    const query = [p.brand || p.category, p.sku, p.name].filter(Boolean).join(' ').slice(0, 90);
    try {
      results.push({ id: p.id, query, candidates: await searchProductImages(query), error: null });
    } catch (e) {
      results.push({ id: p.id, query, candidates: [], error: e.message });
    }
  }
  res.json({ results });
});

// Téléchargement des images choisies : { choices: [{ id, url }] }
const IMG_TYPES = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp',
  'image/gif': '.gif', 'image/svg+xml': '.svg', 'image/avif': '.avif',
};
app.post('/api/photos/apply', async (req, res) => {
  const choices = Array.isArray(req.body.choices) ? req.body.choices : [];
  if (!choices.length) return res.status(400).json({ error: 'Aucune image choisie' });
  let assigned = 0;
  const failed = [];
  for (const c of choices.slice(0, 30)) {
    const p = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(c.id));
    if (!p || !/^https?:\/\//i.test(String(c.url || ''))) continue;
    try {
      const r = await fetchWithTimeout(c.url, { headers: { 'User-Agent': IMG_UA } }, 20000);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const type = String(r.headers.get('content-type') || '').split(';')[0].trim();
      const ext = IMG_TYPES[type];
      if (!ext) throw new Error(`pas une image (${type || 'type inconnu'})`);
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 8 * 1024 * 1024) throw new Error('image trop lourde (> 8 Mo)');
      if (buf.length < 500) throw new Error('image vide');
      const filename = `web-${p.id}-${Date.now()}${ext}`;
      fs.writeFileSync(path.join(UPLOADS_DIR, filename), buf);
      if (p.photo) fs.unlink(path.join(UPLOADS_DIR, path.basename(p.photo)), () => {});
      db.prepare('UPDATE products SET photo = ?, updated_at = ? WHERE id = ?').run(`/uploads/${filename}`, now(), p.id);
      assigned++;
    } catch (e) {
      failed.push({ id: p.id, name: p.name, error: e.message });
    }
  }
  res.json({ assigned, failed });
});

// ---------------------------------------------------------------------------
// Inventaire physique : on envoie les quantités comptées, le stock est recalé
// et chaque écart est tracé dans l'historique. Seuls les produits comptés
// sont ajustés (inventaire partiel possible).
// ---------------------------------------------------------------------------
app.post('/api/inventory', (req, res) => {
  const counts = Array.isArray(req.body.counts) ? req.body.counts : [];
  if (!counts.length) return res.status(400).json({ error: 'Aucun produit compté' });
  const report = [];
  try {
    withTransaction(() => {
      for (const c of counts) {
        const counted = Math.max(0, parseInt(c.counted, 10) || 0);
        const p = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(c.id));
        if (!p) continue;
        const diff = counted - p.stock;
        report.push({ id: p.id, name: p.name, sku: p.sku, before: p.stock, counted, diff });
        if (diff !== 0) {
          db.prepare('UPDATE products SET stock = ?, updated_at = ? WHERE id = ?').run(counted, now(), p.id);
          logMovement(p.id, 'adjust', diff, counted, `Inventaire (écart ${diff > 0 ? '+' : ''}${diff})`);
        }
      }
    });
  } catch (e) {
    return res.status(500).json({ error: `Erreur pendant l'inventaire : ${e.message}` });
  }
  const discrepancies = report.filter((r) => r.diff !== 0);
  res.json({ counted: report.length, adjusted: discrepancies.length, discrepancies });
});

// ---------------------------------------------------------------------------
// Import Excel / CSV
// ---------------------------------------------------------------------------
const pendingImports = new Map(); // importId -> { rows, headers, expires }

setInterval(() => {
  const t = Date.now();
  for (const [k, v] of pendingImports) if (v.expires < t) pendingImports.delete(k);
}, 60 * 1000).unref();

// Détection automatique des colonnes selon leur nom (français / anglais).
// Chaque champ accepte plusieurs motifs, essayés dans l'ordre : le premier
// (précis) gagne sur le second (générique) — ex : « Prix de vente suggéré »
// est préféré à « Prix RMB » pour le prix de vente.
// barcode est testé avant sku : une colonne « Code barre » / « EAN » doit lui
// revenir, sinon le motif `code` du SKU la capturerait.
const FIELD_PATTERNS = {
  barcode: [/^(code.?barres?|barcode|ean|upc|gencod|gtin)/i],
  sku: [/^(sku|ref|r[ée]f[ée]rence|code)/i],
  variant_group: [/^(groupe|variante|parent|mod[èe]le|model)/i],
  brand: [/^(marque|brand|fabricant)/i],
  name: [/^(nom|name|produit(?!\s*€)|product|titre|title|d[ée]signation|article|libell[ée])/i],
  category: [/^(cat[ée]gorie|category|famille|collection)/i, /^type/i],
  price: [
    /^(prix de vente|pv\b|selling|tarif)/i,
    /^(prix|price)(?!\s*(rmb|du gramme|de l.envoi|d.achat|produit|ht\b|avec tva|ttc))/i,
  ],
  cost: [
    /^(co[ûu]t|cost|prix d.achat|pa\b|achat|purchase)/i,
    /^(prix avec tva|prix ttc|landed)/i,
    /^prix produit/i,
  ],
  min_stock: [/(min|seuil|alerte|reorder)/i],
  stock: [/^(stock|quantit[ée]|qte|qty|quantity|inventaire|inventory|disponible|available)/i],
};

function guessMapping(headers) {
  const mapping = {};
  const used = new Set();
  for (const [field, patterns] of Object.entries(FIELD_PATTERNS)) {
    outer: for (const re of patterns) {
      for (const h of headers) {
        if (used.has(h)) continue;
        if (re.test(String(h).trim())) {
          mapping[field] = h;
          used.add(h);
          break outer;
        }
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
  const findByBarcode = db.prepare(`SELECT * FROM products WHERE barcode = ? AND barcode != ''`);
  const findByName = db.prepare('SELECT * FROM products WHERE name = ? COLLATE NOCASE');
  const insert = db.prepare(
    `INSERT INTO products (sku, barcode, variant_group, brand, name, category, price, cost, photo, stock, min_stock, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?)`
  );

  let created = 0;
  let updated = 0;
  let skipped = 0;

  const run = () => withTransaction(() => {
    for (const row of pending.rows) {
      const get = (field) => (mapping[field] != null && mapping[field] !== '' ? row[mapping[field]] : '');
      const sku = String(get('sku')).trim() || null;
      const barcode = String(get('barcode')).trim();
      const name = String(get('name')).trim();
      if (!sku && !name) {
        skipped++;
        continue;
      }
      // Ligne d'annotation (ex : détail des couleurs « Noir - 84 » sous un
      // produit) : un libellé sans référence ni quantité, alors que le fichier
      // a bien des colonnes référence et quantité → on l'ignore
      if (mapping.sku && mapping.stock && !sku && !String(get('stock')).trim()) {
        skipped++;
        continue;
      }

      const stockVal = mapping.stock ? toInt(get('stock')) : 0;
      const existing =
        (sku && findBySku.get(sku)) || (barcode && findByBarcode.get(barcode)) || (name && findByName.get(name)) || null;
      const ts = now();

      if (existing) {
        const sets = [];
        const vals = [];
        if (name && name !== existing.name) { sets.push('name = ?'); vals.push(name); }
        if (sku && sku !== existing.sku) { sets.push('sku = ?'); vals.push(sku); }
        if (barcode && barcode !== existing.barcode) { sets.push('barcode = ?'); vals.push(barcode); }
        if (mapping.variant_group) { sets.push('variant_group = ?'); vals.push(String(get('variant_group')).trim()); }
        if (mapping.brand) {
          const brandVal = String(get('brand')).trim();
          sets.push('brand = ?');
          vals.push(brandVal);
          // Les anciens imports rangeaient la marque dans la catégorie : si la
          // catégorie existante est justement cette marque, on la libère
          if (brandVal && existing.category === brandVal && !mapping.category) {
            sets.push(`category = ''`);
          }
        }
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
          sku, barcode, String(get('variant_group')).trim(), String(get('brand')).trim(), name || sku, String(get('category')).trim(),
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
// Ventes par photos : pendant le live, chaque produit vendu est pris en photo
// avec une étiquette #N. Claude (vision) lit le numéro et identifie le produit
// dans le catalogue ; l'utilisateur vérifie puis valide la création des ventes.
// ---------------------------------------------------------------------------
const PHOTO_SCHEMA = {
  type: 'object',
  properties: {
    sale_no: { type: ['integer', 'null'] },
    product_name: { type: 'string' },
    catalog_sku: { type: ['string', 'null'] },
  },
  required: ['sale_no', 'product_name', 'catalog_sku'],
  additionalProperties: false,
};

const stripAccents = (s) =>
  String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ');

// Correspondance de secours par similarité de nom (si Claude n'a pas trouvé le SKU)
function fuzzyMatches(name, products) {
  const qTokens = new Set(stripAccents(name).split(/\s+/).filter((t) => t.length > 1));
  if (!qTokens.size) return [];
  return products
    .map((p) => {
      const pTokens = new Set(stripAccents(`${p.name} ${p.sku || ''}`).split(/\s+/).filter(Boolean));
      let common = 0;
      for (const t of qTokens) if (pTokens.has(t)) common++;
      return { id: p.id, name: p.name, sku: p.sku, stock: p.stock, score: common / qTokens.size };
    })
    .filter((m) => m.score > 0.3)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}

async function analyzePhoto(client, model, filePath, mimetype, catalogText) {
  const data = fs.readFileSync(filePath).toString('base64');
  const prompt = `Tu analyses la photo d'un produit vendu pendant un live de vente (TikTok / Whatnot).
Sur la photo, une étiquette (manuscrite ou imprimée) porte un numéro de vente commençant par # (exemple : #8).

Retourne :
- sale_no : le numéro de vente lu sur l'étiquette (le nombre après le #), ou null si aucune étiquette lisible ;
- product_name : le nom du produit visible sur la photo, aussi précis que possible (marque, modèle, couleur, taille…) ;
- catalog_sku : le SKU du produit correspondant dans le catalogue ci-dessous, ou null si aucun ne correspond clairement.

Catalogue de la boutique :
${catalogText}`;
  const request = {
    model,
    max_tokens: 1024,
    output_config: { format: { type: 'json_schema', schema: PHOTO_SCHEMA } },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mimetype || 'image/jpeg', data } },
          { type: 'text', text: prompt },
        ],
      },
    ],
  };
  // effort réduit le coût sur Opus ; le paramètre n'existe pas sur Haiku 4.5
  if (model.startsWith('claude-opus')) request.output_config.effort = 'low';
  const response = await client.messages.create(request);
  if (response.stop_reason === 'refusal') {
    throw new Error('Analyse refusée par le modèle pour cette photo');
  }
  const text = response.content.find((b) => b.type === 'text')?.text || '';
  return JSON.parse(text);
}

app.post('/api/lives/:id/photos/analyze', uploadLivePhotos.array('photos', 40), async (req, res) => {
  const session = db.prepare('SELECT * FROM live_sessions WHERE id = ?').get(Number(req.params.id));
  if (!session) return res.status(404).json({ error: 'Live introuvable' });
  if (!req.files || !req.files.length) return res.status(400).json({ error: 'Aucune photo reçue' });
  const apiKey = getAnthropicKey();
  if (!apiKey) {
    return res.status(400).json({
      error: 'Aucune clé API Anthropic configurée — enregistrez votre clé dans la section Photos du live',
    });
  }

  const products = db.prepare('SELECT id, sku, name, stock FROM products ORDER BY name COLLATE NOCASE').all();
  const catalogText = products
    .slice(0, 400)
    .map((p) => `- ${p.sku || '(sans SKU)'} : ${p.name}`)
    .join('\n');
  const client = new Anthropic({ apiKey });
  const model = getSetting('vision_model', 'claude-opus-5');

  // Analyse avec une concurrence limitée à 3 pour aller vite sans saturer
  const files = req.files;
  const results = new Array(files.length);
  let next = 0;
  async function worker() {
    while (next < files.length) {
      const i = next++;
      const f = files[i];
      const photoUrl = `/uploads/live-photos/${f.filename}`;
      try {
        const parsed = await analyzePhoto(client, model, f.path, f.mimetype, catalogText);
        let matches = [];
        if (parsed.catalog_sku) {
          const bySku = products.find((p) => (p.sku || '').toLowerCase() === String(parsed.catalog_sku).toLowerCase());
          if (bySku) matches.push({ id: bySku.id, name: bySku.name, sku: bySku.sku, stock: bySku.stock, score: 1 });
        }
        if (!matches.length) matches = fuzzyMatches(parsed.product_name, products);
        results[i] = {
          photo: photoUrl,
          sale_no: Number.isFinite(parsed.sale_no) ? parsed.sale_no : null,
          product_name: parsed.product_name || '',
          matches,
          best_match_id: matches.length ? matches[0].id : null,
          error: null,
        };
      } catch (e) {
        const msg =
          e.status === 401
            ? 'Clé API invalide — vérifiez-la dans les réglages'
            : e.status === 429
              ? 'Limite de requêtes API atteinte, réessayez dans une minute'
              : e.message || 'Analyse impossible';
        results[i] = { photo: photoUrl, sale_no: null, product_name: '', matches: [], best_match_id: null, error: msg };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, files.length) }, worker));
  res.json({ model, results });
});

// Création des ventes vérifiées : { sales: [{ product_id, sale_no, photo }] }
app.post('/api/lives/:id/photo-sales', (req, res) => {
  const session = db.prepare('SELECT * FROM live_sessions WHERE id = ?').get(Number(req.params.id));
  if (!session) return res.status(404).json({ error: 'Live introuvable' });
  const sales = Array.isArray(req.body.sales) ? req.body.sales : [];
  if (!sales.length) return res.status(400).json({ error: 'Aucune vente à créer' });

  const existingNos = new Set(
    db.prepare('SELECT sale_no FROM movements WHERE session_id = ? AND delta < 0 AND is_gift = 0 AND sale_no IS NOT NULL')
      .all(session.id)
      .map((r) => r.sale_no)
  );

  let created = 0;
  const skipped = [];
  withTransaction(() => {
    for (const s of sales) {
      const saleNo = parseInt(s.sale_no, 10);
      const product = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(s.product_id));
      if (!Number.isFinite(saleNo) || saleNo <= 0) {
        skipped.push('numéro de vente manquant');
        continue;
      }
      if (existingNos.has(saleNo)) {
        skipped.push(`#${saleNo} existe déjà dans ce live`);
        continue;
      }
      if (!product) {
        skipped.push(`#${saleNo} : produit introuvable`);
        continue;
      }
      if (product.stock <= 0) {
        skipped.push(`#${saleNo} ${product.name} : stock à zéro`);
        continue;
      }
      const after = product.stock - 1;
      db.prepare('UPDATE products SET stock = ?, updated_at = ? WHERE id = ?').run(after, now(), product.id);
      const movementId = logMovement(product.id, session.platform, -1, after, 'Vente live (photo)', session.id, saleNo);
      if (s.photo) db.prepare('UPDATE movements SET photo = ? WHERE id = ?').run(String(s.photo), movementId);
      // Live déjà terminé (ex : live passé créé après coup) : la vente est
      // datée dans la fenêtre du live (début + n° de vente en minutes,
      // approximation — l'ordre des numéros est respecté)
      if (session.ended_at) {
        const start = new Date(session.started_at).getTime();
        const end = new Date(session.ended_at).getTime();
        const ts = new Date(Math.min(start + saleNo * 60000, end)).toISOString();
        db.prepare('UPDATE movements SET created_at = ? WHERE id = ?').run(ts, movementId);
      }
      existingNos.add(saleNo);
      created++;
    }
    // de nouvelles ventes ont été ajoutées : le live devra être re-validé
    if (created > 0) db.prepare('UPDATE live_sessions SET validated_at = NULL WHERE id = ?').run(session.id);
  });
  res.json({ created, skipped, session: sessionSummary(db.prepare('SELECT * FROM live_sessions WHERE id = ?').get(session.id)) });
});

// ---------------------------------------------------------------------------
// Statistiques : meilleures ventes / marges par plateforme, liste de réassort
// et rapport de conseils généré par l'IA
// ---------------------------------------------------------------------------
const STAT_CHANNELS = ['online', 'store', 'tiktok', 'whatnot'];

function computeStatistics(days) {
  const since = Number.isFinite(days) && days > 0
    ? new Date(Date.now() - days * 24 * 3600 * 1000).toISOString()
    : '';
  const rows = db
    .prepare(
      `SELECT m.channel, m.delta, m.sold_price, m.fees, m.net_amount, m.shipping_cost,
              p.id AS pid, p.name, p.sku, p.price, p.cost, p.stock, p.min_stock
       FROM movements m JOIN products p ON p.id = m.product_id
       WHERE m.delta < 0 AND m.cancelled = 0 AND m.is_gift = 0
         AND COALESCE(m.payment_status,'paid') NOT IN ('failed','refunded')
         AND m.created_at >= ?`
    )
    .all(since);

  const feeCfg = { tiktok: getFees('tiktok'), whatnot: getFees('whatnot') };
  const netUnitOf = (r, channel) => {
    const eff = r.sold_price != null ? r.sold_price : r.price;
    if (r.net_amount != null) return r.net_amount;
    if (r.fees != null) return eff - r.fees;
    const f = feeCfg[channel];
    if (!f || eff <= 0) return eff;
    return eff - ((eff * (f.commission + f.processing)) / 100 + f.fixed);
  };

  const byProduct = new Map();
  for (const r of rows) {
    const channel = r.channel === 'live' ? 'tiktok' : r.channel;
    if (!STAT_CHANNELS.includes(channel)) continue;
    const qty = -r.delta;
    const eff = r.sold_price != null ? r.sold_price : r.price;
    const marginUnit = netUnitOf(r, channel) - r.cost;
    const shipping = r.shipping_cost || 0; // par vente, pas par unité
    const e = byProduct.get(r.pid) || {
      id: r.pid, name: r.name, sku: r.sku, price: r.price, cost: r.cost,
      stock: r.stock, qty: 0, revenue: 0, margin: 0, channels: {},
    };
    e.qty += qty;
    e.revenue += qty * eff;
    e.margin += qty * marginUnit - shipping;
    const c = e.channels[channel] || { qty: 0, revenue: 0, margin: 0 };
    c.qty += qty;
    c.revenue += qty * eff;
    c.margin += qty * marginUnit - shipping;
    e.channels[channel] = c;
    byProduct.set(r.pid, e);
  }

  // Réassort : produits sous leur seuil, quantité conseillée d'après les
  // ventes des 30 derniers jours
  const sold30 = new Map(
    db.prepare(
      `SELECT m.product_id AS pid, SUM(-m.delta) AS qty
       FROM movements m
       WHERE m.delta < 0 AND m.cancelled = 0 AND m.is_gift = 0 AND m.created_at >= ?
       GROUP BY m.product_id`
    )
      .all(new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString())
      .map((r) => [r.pid, r.qty])
  );
  const toOrder = db
    .prepare('SELECT * FROM products WHERE min_stock > 0 AND stock <= min_stock ORDER BY (min_stock - stock) DESC')
    .all()
    .map((p) => ({
      id: p.id, name: p.name, sku: p.sku, stock: p.stock, min_stock: p.min_stock,
      sold_30d: sold30.get(p.id) || 0,
      suggested: Math.max(p.min_stock * 2 - p.stock, (sold30.get(p.id) || 0) - p.stock, 1),
    }));

  return {
    products: [...byProduct.values()].sort((a, b) => b.margin - a.margin),
    to_order: toOrder,
  };
}

// Meilleurs créneaux de live : CA et marge par jour de la semaine et par
// heure de début, plus le rythme moyen des ventes au fil du live (par
// tranches de 15 min) pour voir quand le live s'essouffle.
app.get('/api/statistics/lives', (req, res) => {
  const platform = LIVE_PLATFORMS.includes(req.query.platform) ? req.query.platform : '';
  const sessions = db
    .prepare(`SELECT * FROM live_sessions WHERE ended_at IS NOT NULL ${platform ? 'AND platform = ?' : ''} ORDER BY id`)
    .all(...(platform ? [platform] : []))
    .map(sessionSummary)
    .filter((s) => s.items > 0);

  const byWeekday = Array.from({ length: 7 }, (_, dow) => ({ dow, lives: 0, revenue: 0, margin: 0 }));
  const byHour = new Map();
  for (const s of sessions) {
    const d = new Date(s.started_at);
    const w = byWeekday[d.getDay()];
    w.lives++;
    w.revenue += s.revenue;
    w.margin += s.margin;
    const h = d.getHours();
    const e = byHour.get(h) || { hour: h, lives: 0, revenue: 0, margin: 0 };
    e.lives++;
    e.revenue += s.revenue;
    e.margin += s.margin;
    byHour.set(h, e);
  }

  // Rythme : CA moyen par tranche de 15 min depuis le début du live
  // (moyenne sur les lives ayant duré au moins jusqu'à la tranche)
  const BUCKET_MIN = 15;
  const MAX_BUCKETS = 16; // 4 h
  const bucketRevenue = new Array(MAX_BUCKETS).fill(0);
  const bucketReached = new Array(MAX_BUCKETS).fill(0);
  const saleTimes = db.prepare(
    `SELECT m.created_at, COALESCE(m.sold_price, p.price) AS eff
     FROM movements m JOIN products p ON p.id = m.product_id
     WHERE m.session_id = ? AND m.delta < 0 AND m.cancelled = 0 AND m.is_gift = 0
       AND COALESCE(m.payment_status,'paid') NOT IN ('failed','refunded')`
  );
  for (const s of sessions) {
    const start = new Date(s.started_at).getTime();
    const durationMin = (new Date(s.ended_at).getTime() - start) / 60000;
    const reachedBuckets = Math.min(MAX_BUCKETS, Math.max(1, Math.ceil(durationMin / BUCKET_MIN)));
    for (let i = 0; i < reachedBuckets; i++) bucketReached[i]++;
    for (const m of saleTimes.all(s.id)) {
      const idx = Math.floor((new Date(m.created_at).getTime() - start) / 60000 / BUCKET_MIN);
      if (idx >= 0 && idx < MAX_BUCKETS) bucketRevenue[idx] += m.eff || 0;
    }
  }
  const curve = [];
  for (let i = 0; i < MAX_BUCKETS && bucketReached[i] > 0; i++) {
    curve.push({ from: i * BUCKET_MIN, to: (i + 1) * BUCKET_MIN, lives: bucketReached[i], avg: bucketRevenue[i] / bucketReached[i] });
  }

  res.json({
    total_lives: sessions.length,
    by_weekday: byWeekday.filter((w) => w.lives > 0),
    by_hour: [...byHour.values()].sort((a, b) => a.hour - b.hour),
    curve,
  });
});

app.get('/api/statistics', (req, res) => {
  const days = parseInt(req.query.days, 10);
  const stats = computeStatistics(Number.isFinite(days) ? days : 30);
  let lastReport = null;
  try {
    lastReport = JSON.parse(getSetting('last_ai_report', '') || 'null');
  } catch (e) {
    /* pas de rapport enregistré */
  }
  res.json({ ...stats, last_report: lastReport });
});

// Bon de commande fournisseur (CSV)
app.get('/api/statistics/order.csv', (req, res) => {
  const { to_order } = computeStatistics(30);
  const esc = (v) => {
    const s = String(v ?? '');
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = to_order.map((p) =>
    [p.sku, p.name, p.stock, p.min_stock, p.sold_30d, p.suggested].map(esc).join(';')
  );
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="bon-de-commande.csv"');
  res.send('﻿' + ['SKU;Produit;Stock actuel;Seuil;Vendus 30 j;Quantité à commander', ...lines].join('\n'));
});

// Rapport de conseils généré par Claude à partir des chiffres réels.
// Utilisé par le bouton de l'onglet Stats et par la génération automatique
// du matin. Lève une erreur avec un message français prêt à afficher.
async function generateAiReport({ auto = false } = {}) {
  const apiKey = getAnthropicKey();
  if (!apiKey) {
    throw new Error('Aucune clé API Anthropic configurée — enregistrez-la dans un détail de live (section Photos) ou via ANTHROPIC_API_KEY');
  }
  const stats = computeStatistics(30);
  if (!stats.products.length) {
    throw new Error('Pas encore assez de ventes sur les 30 derniers jours pour un rapport');
  }

  const chLabel = { online: 'en ligne', store: 'boutique', tiktok: 'TikTok', whatnot: 'Whatnot' };
  const productLines = stats.products.slice(0, 25).map((p) => {
    const channels = Object.entries(p.channels)
      .map(([c, v]) => `${chLabel[c]}: ${v.qty} vendus / ${v.margin.toFixed(0)}€ de marge`)
      .join(', ');
    return `- ${p.name}${p.sku ? ` (${p.sku})` : ''} : ${p.qty} vendus, CA ${p.revenue.toFixed(0)}€, marge nette totale ${p.margin.toFixed(0)}€ (soit ${(p.margin / p.qty).toFixed(2)}€/unité), stock restant ${p.stock} — ${channels}`;
  }).join('\n');
  const orderLines = stats.to_order.length
    ? stats.to_order.map((p) => `- ${p.name}${p.sku ? ` (${p.sku})` : ''} : stock ${p.stock} (seuil ${p.min_stock}), ${p.sold_30d} vendus en 30 j`).join('\n')
    : '(aucun produit sous son seuil)';

  const prompt = `Tu es le conseiller commercial d'une petite boutique française qui vend en ligne, en boutique physique et pendant des lives TikTok et Whatnot.

Voici les chiffres réels des 30 derniers jours (marges nettes : frais des plateformes déjà déduits) :

VENTES PAR PRODUIT :
${productLines}

PRODUITS SOUS LEUR SEUIL DE STOCK :
${orderLines}

Rédige un rapport court et actionnable en français, en Markdown, avec ces sections :
## 🏆 À mettre en avant — les produits qui rapportent vraiment (marge totale et marge/unité élevées), et sur quelles plateformes les pousser en priorité d'après leurs performances par canal.
## ⚠️ À ne plus pousser — les produits à gros volume mais faible marge (ex : beaucoup de ventes pour quelques euros de bénéfice) : dis clairement s'il faut monter le prix, les utiliser comme cadeaux/produits d'appel pendant les lives, ou arrêter.
## 📦 Réassort prioritaire — parmi les produits sous leur seuil, lesquels commander en premier (croiser marge et vitesse de vente).
## 💡 Idées concrètes — 2 ou 3 actions simples (bundles, prix, produit star du prochain live…).

Sois direct et concret, cite les chiffres, pas de blabla. Maximum 400 mots.`;

  const client = new Anthropic({ apiKey });
  const model = getSetting('vision_model', 'claude-opus-5');
  let response;
  try {
    response = await client.messages.create({
      model,
      max_tokens: 3000,
      messages: [{ role: 'user', content: prompt }],
    });
  } catch (e) {
    const msg =
      e.status === 401
        ? 'Clé API invalide — vérifiez-la'
        : e.status === 429
          ? 'Limite de requêtes API atteinte, réessayez dans une minute'
          : e.message || 'Génération impossible';
    throw new Error(msg);
  }
  if (response.stop_reason === 'refusal') {
    throw new Error('Le modèle a refusé de générer ce rapport, réessayez');
  }
  const report = response.content.find((b) => b.type === 'text')?.text || '';
  const payload = { report, generated_at: now(), model, auto };
  setSetting('last_ai_report', JSON.stringify(payload));
  return payload;
}

app.post('/api/statistics/report', async (req, res) => {
  try {
    res.json(await generateAiReport());
  } catch (e) {
    res.status(e.message.startsWith('Aucune clé') || e.message.startsWith('Pas encore') ? 400 : 500)
      .json({ error: e.message });
  }
});

// Génération automatique du matin : si l'option est activée, un rapport est
// généré une fois par jour dès que l'app tourne après 7 h (heure locale).
async function maybeAutoReport() {
  try {
    if (getSetting('auto_report', '0') !== '1') return;
    if (!getAnthropicKey()) return;
    const localDay = new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD local
    if (new Date().getHours() < 7) return;
    if (getSetting('last_auto_report_day', '') === localDay) return;
    setSetting('last_auto_report_day', localDay); // avant l'appel : pas de double génération si lenteur
    await generateAiReport({ auto: true });
    console.log(`Rapport IA automatique généré (${localDay})`);
  } catch (e) {
    console.error(`Rapport IA automatique impossible : ${e.message}`);
  }
}
setInterval(maybeAutoReport, 10 * 60 * 1000).unref();
setTimeout(maybeAutoReport, 15 * 1000).unref();

// ---------------------------------------------------------------------------
// Sauvegarde automatique : chaque jour, une copie cohérente de la base
// (VACUUM INTO) + les photos sont écrites dans le dossier choisi par
// l'utilisateur (iCloud Drive, Dropbox, disque externe…). 14 jours conservés.
// ---------------------------------------------------------------------------
const BACKUP_KEEP = 14;
const BACKUP_PREFIX = 'sauvegarde-';
const localDay = () => new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD local

function backupRoot() {
  const dir = getSetting('backup_dir', '');
  return dir ? path.join(dir, 'WowMart-sauvegardes') : '';
}

function listBackups() {
  const root = backupRoot();
  if (!root || !fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .filter((n) => n.startsWith(BACKUP_PREFIX) && fs.existsSync(path.join(root, n, 'stock.db')))
    .sort()
    .reverse()
    .map((n) => {
      const dbFile = path.join(root, n, 'stock.db');
      return { name: n, date: n.slice(BACKUP_PREFIX.length), size: fs.statSync(dbFile).size };
    });
}

function runBackup() {
  const root = backupRoot();
  if (!root) throw new Error('Aucun dossier de sauvegarde configuré');
  const target = path.join(root, `${BACKUP_PREFIX}${localDay()}`);
  fs.mkdirSync(target, { recursive: true });

  // Copie cohérente de la base, même en cours d'utilisation
  const dbCopy = path.join(target, 'stock.db');
  if (fs.existsSync(dbCopy)) fs.rmSync(dbCopy);
  db.exec(`VACUUM INTO '${dbCopy.replace(/'/g, "''")}'`);

  // Photos : copie incrémentale (les fichiers déjà copiés sont ignorés)
  if (fs.existsSync(UPLOADS_DIR)) {
    fs.cpSync(UPLOADS_DIR, path.join(target, 'uploads'), { recursive: true, force: false, errorOnExist: false });
  }

  // Rétention : on garde les 14 sauvegardes les plus récentes
  const all = fs
    .readdirSync(root)
    .filter((n) => n.startsWith(BACKUP_PREFIX))
    .sort()
    .reverse();
  for (const old of all.slice(BACKUP_KEEP)) {
    fs.rmSync(path.join(root, old), { recursive: true, force: true });
  }

  setSetting('last_backup', now());
  setSetting('last_backup_day', localDay());
  return { folder: target, backups: listBackups() };
}

app.get('/api/backup', (req, res) => {
  res.json({
    dir: getSetting('backup_dir', ''),
    last_backup: getSetting('last_backup', '') || null,
    backups: listBackups(),
  });
});

app.put('/api/backup', (req, res) => {
  const dir = String(req.body.dir || '').trim();
  if (!dir) {
    db.prepare('DELETE FROM settings WHERE key = ?').run('backup_dir');
    return res.json({ dir: '', last_backup: null, backups: [] });
  }
  if (!path.isAbsolute(dir)) {
    return res.status(400).json({ error: 'Indiquez un chemin absolu (ex : /Users/vous/Documents/Sauvegardes)' });
  }
  try {
    fs.mkdirSync(path.join(dir, 'WowMart-sauvegardes'), { recursive: true });
    const probe = path.join(dir, 'WowMart-sauvegardes', '.test-ecriture');
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe);
  } catch (e) {
    return res.status(400).json({ error: `Dossier inutilisable : ${e.message}` });
  }
  setSetting('backup_dir', dir);
  res.json({ dir, last_backup: getSetting('last_backup', '') || null, backups: listBackups() });
});

app.post('/api/backup/run', (req, res) => {
  try {
    const result = runBackup();
    res.json({ ok: true, last_backup: getSetting('last_backup'), backups: result.backups });
  } catch (e) {
    res.status(500).json({ error: `Sauvegarde impossible : ${e.message}` });
  }
});

// Restauration : la base et les photos sont remplacées par la sauvegarde,
// puis l'application s'arrête (elle doit être relancée avec npm start).
app.post('/api/backup/restore', (req, res) => {
  const name = String(req.body.name || '');
  if (!/^sauvegarde-\d{4}-\d{2}-\d{2}$/.test(name)) {
    return res.status(400).json({ error: 'Sauvegarde invalide' });
  }
  const source = path.join(backupRoot(), name);
  if (!fs.existsSync(path.join(source, 'stock.db'))) {
    return res.status(404).json({ error: 'Sauvegarde introuvable' });
  }
  try {
    db.close();
    for (const suffix of ['', '-wal', '-shm']) {
      const f = `${DB_PATH}${suffix}`;
      if (fs.existsSync(f)) fs.rmSync(f);
    }
    fs.copyFileSync(path.join(source, 'stock.db'), DB_PATH);
    const uploadsBackup = path.join(source, 'uploads');
    if (fs.existsSync(uploadsBackup)) {
      fs.cpSync(uploadsBackup, UPLOADS_DIR, { recursive: true, force: true });
    }
  } catch (e) {
    // La base est peut-être déjà fermée : on répond puis on s'arrête, la
    // sauvegarde source reste intacte pour réessayer après redémarrage.
    res.status(500).json({ error: `Restauration échouée : ${e.message} — relancez l'application et réessayez` });
    console.error(`Restauration échouée : ${e.message}`);
    setTimeout(() => process.exit(1), 400);
    return;
  }
  res.json({ ok: true, message: 'Sauvegarde restaurée — relancez l’application (npm start)' });
  console.log(`Sauvegarde ${name} restaurée — arrêt de l'application, relancez avec npm start`);
  setTimeout(() => process.exit(0), 400);
});

// Une sauvegarde par jour, dès que l'app tourne (vérification toutes les 30 min)
function maybeAutoBackup() {
  try {
    if (!getSetting('backup_dir', '')) return;
    if (getSetting('last_backup_day', '') === localDay()) return;
    runBackup();
    console.log(`Sauvegarde automatique effectuée (${localDay()})`);
  } catch (e) {
    console.error(`Sauvegarde automatique impossible : ${e.message}`);
  }
}
setInterval(maybeAutoBackup, 30 * 60 * 1000).unref();
setTimeout(maybeAutoBackup, 20 * 1000).unref();

// ---------------------------------------------------------------------------
// Export CSV
// ---------------------------------------------------------------------------
app.get('/api/export.csv', (req, res) => {
  const rows = db.prepare('SELECT * FROM products ORDER BY name COLLATE NOCASE').all();
  const header = 'SKU;Code barre;Nom;Marque;Groupe;Catégorie;Prix;Coût;Stock;Seuil alerte';
  const esc = (v) => {
    const s = String(v ?? '');
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = rows.map((p) =>
    [p.sku, p.barcode, p.name, p.brand, p.variant_group, p.category, p.price, p.cost, p.stock, p.min_stock].map(esc).join(';')
  );
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="stock-wowmart.csv"');
  res.send('﻿' + [header, ...lines].join('\n'));
});

// Gestion d'erreurs (multer, etc.)
app.use((err, req, res, next) => {
  res.status(400).json({ error: err.message || 'Erreur inattendue' });
});

const server = app.listen(PORT, () => {
  console.log(`✅ WowMart Stock démarré — ouvrez http://localhost:${PORT}`);
});
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`⚠ Le port ${PORT} est déjà utilisé : l'application tourne probablement déjà.`);
    console.error(`  → Essayez d'ouvrir http://localhost:${PORT} dans votre navigateur.`);
    console.error(`  → Sinon, fermez l'autre fenêtre Terminal qui la lance (ou tapez : pkill -f "node server.js"), puis relancez npm start.`);
    process.exit(1);
  }
  throw err;
});
