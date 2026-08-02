const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const XLSX = require('xlsx');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Base de données
// ---------------------------------------------------------------------------
const db = new Database(path.join(DATA_DIR, 'stock.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT UNIQUE,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  price REAL NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  photo TEXT NOT NULL DEFAULT '',
  stock_online INTEGER NOT NULL DEFAULT 0,
  stock_store INTEGER NOT NULL DEFAULT 0,
  stock_live INTEGER NOT NULL DEFAULT 0,
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
  created_at TEXT NOT NULL
);
`);

const CHANNELS = { online: 'stock_online', store: 'stock_store', live: 'stock_live' };

const now = () => new Date().toISOString();

function logMovement(productId, channel, delta, stockAfter, reason) {
  db.prepare(
    `INSERT INTO movements (product_id, channel, delta, stock_after, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(productId, channel, delta, stockAfter, reason || '', now());
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
    stock_online: Math.max(0, parseInt(body.stock_online, 10) || 0),
    stock_store: Math.max(0, parseInt(body.stock_store, 10) || 0),
    stock_live: Math.max(0, parseInt(body.stock_live, 10) || 0),
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
      `INSERT INTO products (sku, name, category, price, cost, photo,
        stock_online, stock_store, stock_live, min_stock, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(p.sku, p.name, p.category, p.price, p.cost, photo,
      p.stock_online, p.stock_store, p.stock_live, p.min_stock, ts, ts);
  const id = info.lastInsertRowid;
  for (const [channel, col] of Object.entries(CHANNELS)) {
    if (p[col] > 0) logMovement(id, channel, p[col], p[col], 'Création du produit');
  }
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

  for (const [channel, col] of Object.entries(CHANNELS)) {
    const delta = p[col] - existing[col];
    if (delta !== 0) logMovement(id, channel, delta, p[col], 'Modification manuelle');
  }

  db.prepare(
    `UPDATE products SET sku=?, name=?, category=?, price=?, cost=?, photo=?,
       stock_online=?, stock_store=?, stock_live=?, min_stock=?, updated_at=?
     WHERE id=?`
  ).run(p.sku, p.name, p.category, p.price, p.cost, photo,
    p.stock_online, p.stock_store, p.stock_live, p.min_stock, now(), id);
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

// Ajustement rapide du stock : { channel: "online"|"store"|"live", delta: -1, reason: "vente" }
app.post('/api/products/:id/stock', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Produit introuvable' });
  const channel = req.body.channel;
  const col = CHANNELS[channel];
  if (!col) return res.status(400).json({ error: 'Canal invalide (online, store ou live)' });
  const delta = parseInt(req.body.delta, 10);
  if (!Number.isFinite(delta) || delta === 0) {
    return res.status(400).json({ error: 'Quantité invalide' });
  }
  const after = Math.max(0, existing[col] + delta);
  const realDelta = after - existing[col];
  if (realDelta === 0) return res.json(existing);
  db.prepare(`UPDATE products SET ${col} = ?, updated_at = ? WHERE id = ?`).run(after, now(), id);
  logMovement(id, channel, realDelta, after, req.body.reason || 'Ajustement rapide');
  res.json(db.prepare('SELECT * FROM products WHERE id = ?').get(id));
});

// ---------------------------------------------------------------------------
// Statistiques + mouvements
// ---------------------------------------------------------------------------
app.get('/api/stats', (req, res) => {
  const s = db
    .prepare(
      `SELECT COUNT(*) AS products,
              COALESCE(SUM(stock_online),0) AS online,
              COALESCE(SUM(stock_store),0) AS store,
              COALESCE(SUM(stock_live),0) AS live,
              COALESCE(SUM((stock_online+stock_store+stock_live)*price),0) AS value
       FROM products`
    )
    .get();
  const low = db
    .prepare(
      `SELECT COUNT(*) AS n FROM products
       WHERE (stock_online + stock_store + stock_live) <= min_stock AND min_stock > 0`
    )
    .get();
  res.json({ ...s, low: low.n });
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
  stock_online: /(en ligne|online|web|site|shopify|e-?commerce|e-?shop)/i,
  stock_store: /(boutique|magasin|physique|store|shop\b)/i,
  stock_live: /(live|tiktok|whatnot)/i,
  min_stock: /(min|seuil|alerte|reorder)/i,
  stock_total: /^(stock|quantit[ée]|qte|qty|quantity|inventaire|inventory|disponible|available)$/i,
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

// { importId, mapping: { name: "Nom", sku: "Ref", ... }, target: ["store","online","live"], mode: "set"|"add" }
// target : un ou plusieurs canaux — la colonne « Stock » unique est appliquée à chacun
app.post('/api/import/commit', (req, res) => {
  const { importId, mapping = {}, target = 'store', mode = 'set' } = req.body || {};
  const pending = pendingImports.get(importId);
  if (!pending) return res.status(410).json({ error: 'Import expiré, merci de renvoyer le fichier' });
  if (!mapping.name && !mapping.sku) {
    return res.status(400).json({ error: 'Associez au moins la colonne Nom ou SKU' });
  }
  const targetCols = (Array.isArray(target) ? target : [target])
    .map((t) => CHANNELS[t])
    .filter(Boolean);
  if (!targetCols.length) targetCols.push('stock_store');

  const findBySku = db.prepare('SELECT * FROM products WHERE sku = ?');
  const findByName = db.prepare('SELECT * FROM products WHERE name = ? COLLATE NOCASE');
  const insert = db.prepare(
    `INSERT INTO products (sku, name, category, price, cost, photo,
       stock_online, stock_store, stock_live, min_stock, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?)`
  );

  let created = 0;
  let updated = 0;
  let skipped = 0;

  const run = db.transaction(() => {
    for (const row of pending.rows) {
      const get = (field) => (mapping[field] != null && mapping[field] !== '' ? row[mapping[field]] : '');
      const sku = String(get('sku')).trim() || null;
      const name = String(get('name')).trim();
      if (!sku && !name) {
        skipped++;
        continue;
      }

      const stocks = { stock_online: 0, stock_store: 0, stock_live: 0 };
      let hasChannelCols = false;
      for (const col of ['stock_online', 'stock_store', 'stock_live']) {
        if (mapping[col]) {
          stocks[col] = toInt(get(col));
          hasChannelCols = true;
        }
      }
      if (!hasChannelCols && mapping.stock_total) {
        const qty = toInt(get('stock_total'));
        for (const col of targetCols) stocks[col] = qty;
      }

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

        for (const [channel, col] of Object.entries(CHANNELS)) {
          const touched = mapping[col] || (!hasChannelCols && mapping.stock_total && targetCols.includes(col));
          if (!touched) continue;
          const newVal = mode === 'add' ? existing[col] + stocks[col] : stocks[col];
          if (newVal !== existing[col]) {
            sets.push(`${col} = ?`);
            vals.push(newVal);
            logMovement(existing.id, channel, newVal - existing[col], newVal, 'Import fichier');
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
          stocks.stock_online, stocks.stock_store, stocks.stock_live,
          toInt(get('min_stock')), ts, ts
        );
        for (const [channel, col] of Object.entries(CHANNELS)) {
          if (stocks[col] > 0) logMovement(info.lastInsertRowid, channel, stocks[col], stocks[col], 'Import fichier');
        }
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
  const header = 'SKU;Nom;Catégorie;Prix;Coût;Stock en ligne;Stock boutique;Stock live;Stock total;Seuil alerte';
  const esc = (v) => {
    const s = String(v ?? '');
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = rows.map((p) =>
    [p.sku, p.name, p.category, p.price, p.cost, p.stock_online, p.stock_store, p.stock_live,
      p.stock_online + p.stock_store + p.stock_live, p.min_stock].map(esc).join(';')
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
