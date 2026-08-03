/* WowMart Stock — interface
   Stock unique partagé entre les canaux : une vente en ligne, en boutique
   ou en live décompte du même total ; le canal sert à tracer la vente.
   Le mode live enregistre chaque vente horodatée dans une session datée. */

const $ = (sel) => document.querySelector(sel);

const SALE_CHANNELS = [
  { key: 'online', label: '🌐 En ligne' },
  { key: 'store', label: '🏬 Boutique' },
  { key: 'tiktok', label: '🎵 TikTok' },
  { key: 'whatnot', label: '🟡 Whatnot' },
];
const CHANNEL_LABELS = {
  online: '🌐 En ligne',
  store: '🏬 Boutique',
  tiktok: '🎵 TikTok',
  whatnot: '🟡 Whatnot',
  live: '🎥 Live',
  adjust: '🔧 Ajustement',
};
const PLATFORM_LABELS = { tiktok: '🎵 TikTok', whatnot: '🟡 Whatnot' };
const MAPPING_FIELDS = [
  { key: 'sku', label: 'SKU / Référence' },
  { key: 'name', label: 'Nom du produit' },
  { key: 'category', label: 'Catégorie' },
  { key: 'price', label: 'Prix de vente' },
  { key: 'cost', label: "Coût d'achat" },
  { key: 'stock', label: 'Stock' },
  { key: 'min_stock', label: "Seuil d'alerte" },
];

let products = [];
let editingId = null;
let photoFile = null;
let currentImport = null;
let liveSession = null; // session en cours { id, platform, started_at, ... }
let liveSalesLog = []; // [{ movement_id, product_id, name, sku, price, time, cancelled }]
let liveTimerInterval = null;

// ---------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------
let toastTimer;
function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast' + (isError ? ' error' : '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3500);
}

async function api(url, options = {}) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
  return data;
}

const euro = (n) => Number(n).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });
const isLow = (p) => p.min_stock > 0 && p.stock <= p.min_stock;
const timeFr = (iso) => new Date(iso).toLocaleTimeString('fr-FR');
const dateFr = (iso) => new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function updateLocalProduct(product) {
  const i = products.findIndex((p) => p.id === product.id);
  if (i >= 0) products[i] = product;
}

// ---------------------------------------------------------------------------
// Onglets
// ---------------------------------------------------------------------------
document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.tab-panel').forEach((p) => (p.hidden = true));
    $(`#tab-${btn.dataset.tab}`).hidden = false;
    if (btn.dataset.tab === 'movements') loadMovements();
    if (btn.dataset.tab === 'lives') loadLives();
  });
});

// ---------------------------------------------------------------------------
// Statistiques
// ---------------------------------------------------------------------------
async function loadStats() {
  const s = await api('/api/stats');
  $('#stats').innerHTML = `
    <div class="stat"><div class="value">${s.products}</div><div class="label">Produits</div></div>
    <div class="stat"><div class="value">${s.stock}</div><div class="label">📦 Stock total</div></div>
    <div class="stat"><div class="value">${euro(s.value)}</div><div class="label">Valeur du stock</div></div>
    <div class="stat"><div class="value">${s.sales.online}</div><div class="label">🌐 En ligne (30 j)</div></div>
    <div class="stat"><div class="value">${s.sales.store}</div><div class="label">🏬 Boutique (30 j)</div></div>
    <div class="stat"><div class="value">${s.sales.tiktok}</div><div class="label">🎵 TikTok (30 j)</div></div>
    <div class="stat"><div class="value">${s.sales.whatnot}</div><div class="label">🟡 Whatnot (30 j)</div></div>
    <div class="stat ${s.low > 0 ? 'alert' : ''}"><div class="value">${s.low}</div><div class="label">⚠ Stock bas</div></div>`;
}

// ---------------------------------------------------------------------------
// Produits
// ---------------------------------------------------------------------------
async function loadProducts() {
  const search = $('#search').value.trim();
  products = await api('/api/products' + (search ? `?search=${encodeURIComponent(search)}` : ''));
  renderProducts();
  loadStats();
}

function renderProducts() {
  const lowOnly = $('#lowOnly').checked;
  const list = lowOnly ? products.filter(isLow) : products;
  $('#emptyMsg').hidden = list.length > 0;
  $('#productList').innerHTML = list
    .map((p) => {
      const photo = p.photo
        ? `<img class="product-photo" src="${escapeHtml(p.photo)}" alt="" loading="lazy" onclick="openEdit(${p.id})">`
        : `<div class="product-photo placeholder" onclick="openEdit(${p.id})">📷</div>`;
      const saleButtons = SALE_CHANNELS.map(
        (c) =>
          `<button class="sale-btn" onclick="sell(${p.id}, '${c.key}')" ${p.stock <= 0 ? 'disabled' : ''}
             title="Vendre 1 (${c.label})">${c.label}</button>`
      ).join('');
      return `
      <div class="product-card ${isLow(p) ? 'low' : ''}">
        ${photo}
        <div class="product-body">
          <div class="product-head">
            <div>
              <div class="product-name">${escapeHtml(p.name)}</div>
              <div class="product-sku">${escapeHtml(p.sku || '')}${p.category ? ' · ' + escapeHtml(p.category) : ''}</div>
            </div>
            <div class="product-price">${euro(p.price)}</div>
          </div>
          ${isLow(p) ? '<span class="badge-low">⚠ Stock bas</span>' : ''}
          <div class="stock-row big">
            <span class="chan">📦 Stock</span>
            <button onclick="adjust(${p.id}, -1)" title="Retirer 1 (correction)">−</button>
            <span class="qty ${p.stock <= 0 ? 'zero' : ''}">${p.stock}</span>
            <button onclick="adjust(${p.id}, 1)" title="Ajouter 1 (réassort)">+</button>
          </div>
          <div class="sale-row">${saleButtons}</div>
          <div class="card-actions">
            <button class="btn" onclick="openEdit(${p.id})">✏ Modifier</button>
          </div>
        </div>
      </div>`;
    })
    .join('');
}

async function moveStock(id, channel, delta, reason, sessionId = null) {
  const result = await api(`/api/products/${id}/stock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, delta, reason, session_id: sessionId }),
  });
  updateLocalProduct(result.product);
  renderProducts();
  loadStats();
  return result;
}

// Vente : décompte 1 du stock partagé, en traçant le canal
window.sell = (id, channel) => moveStock(id, channel, -1, 'Vente').catch((e) => toast(e.message, true));
// Réassort / correction manuelle
window.adjust = (id, delta) => moveStock(id, 'adjust', delta).catch((e) => toast(e.message, true));

let searchTimer;
$('#search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadProducts, 250);
});
$('#lowOnly').addEventListener('change', renderProducts);

// ---------------------------------------------------------------------------
// MODE LIVE
// ---------------------------------------------------------------------------
$('#btnStartLive').addEventListener('click', () => {
  $('#platformModal').hidden = false;
});
$('#btnClosePlatform').addEventListener('click', () => {
  $('#platformModal').hidden = true;
});
$('#platformModal').addEventListener('click', (e) => {
  if (e.target === $('#platformModal')) $('#platformModal').hidden = true;
});

document.querySelectorAll('.platform-btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    try {
      const session = await api('/api/lives', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: btn.dataset.platform }),
      });
      $('#platformModal').hidden = true;
      openLiveMode(session, []);
    } catch (e) {
      toast(e.message, true);
    }
  });
});

function openLiveMode(session, sales) {
  liveSession = session;
  liveSalesLog = sales.map((m) => ({
    movement_id: m.id,
    product_id: m.product_id,
    name: m.product_name,
    sku: m.product_sku,
    price: m.product_price,
    time: m.created_at,
    cancelled: !!m.cancelled,
  }));
  $('#livePlatformBadge').textContent = PLATFORM_LABELS[session.platform] || session.platform;
  $('#liveOverlay').hidden = false;
  $('#liveSearch').value = '';
  document.body.classList.add('no-scroll');
  renderLiveResults();
  renderLiveSales();
  updateLiveCounters();
  clearInterval(liveTimerInterval);
  liveTimerInterval = setInterval(updateLiveTimer, 1000);
  updateLiveTimer();
  setTimeout(() => $('#liveSearch').focus(), 100);
}

function updateLiveTimer() {
  if (!liveSession) return;
  const sec = Math.max(0, Math.floor((Date.now() - new Date(liveSession.started_at).getTime()) / 1000));
  const h = Math.floor(sec / 3600);
  const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
  const s = String(sec % 60).padStart(2, '0');
  $('#liveTimer').textContent = h > 0 ? `${h}:${m}:${s}` : `${m}:${s}`;
}

function liveTotals() {
  const valid = liveSalesLog.filter((s) => !s.cancelled);
  return { items: valid.length, revenue: valid.reduce((sum, s) => sum + (Number(s.price) || 0), 0) };
}

function updateLiveCounters() {
  const t = liveTotals();
  $('#liveCounters').textContent = `${t.items} vente(s) · ${euro(t.revenue)}`;
}

// Recherche rapide par référence ou nom (insensible à la casse)
function renderLiveResults() {
  const q = $('#liveSearch').value.trim().toLowerCase();
  const list = q
    ? products.filter(
        (p) =>
          (p.sku || '').toLowerCase().includes(q) ||
          p.name.toLowerCase().includes(q) ||
          (p.category || '').toLowerCase().includes(q)
      )
    : products;
  $('#liveResults').innerHTML = list.length
    ? list
        .map((p) => {
          const photo = p.photo
            ? `<img src="${escapeHtml(p.photo)}" alt="" loading="lazy">`
            : '<div class="live-noimg">📷</div>';
          return `
        <button class="live-product ${p.stock <= 0 ? 'out' : ''}" onclick="liveSell(${p.id})" ${p.stock <= 0 ? 'disabled' : ''}>
          ${photo}
          <span class="live-product-info">
            <span class="live-product-name">${escapeHtml(p.name)}</span>
            <span class="live-product-sku">${escapeHtml(p.sku || '')}</span>
          </span>
          <span class="live-product-side">
            <span class="live-product-price">${euro(p.price)}</span>
            <span class="live-product-stock ${p.stock <= 0 ? 'zero' : ''}">${p.stock <= 0 ? 'Épuisé' : 'Stock : ' + p.stock}</span>
            <span class="live-product-action">${p.stock <= 0 ? '—' : 'VENDU ✔'}</span>
          </span>
        </button>`;
        })
        .join('')
    : '<p class="empty">Aucun produit ne correspond à cette recherche</p>';
}

$('#liveSearch').addEventListener('input', renderLiveResults);

window.liveSell = async (id) => {
  if (!liveSession) return;
  const p = products.find((x) => x.id === id);
  try {
    const result = await moveStock(id, liveSession.platform, -1, 'Vente live', liveSession.id);
    liveSalesLog.unshift({
      movement_id: result.movement_id,
      product_id: id,
      name: p.name,
      sku: p.sku,
      price: p.price,
      time: new Date().toISOString(),
      cancelled: false,
    });
    renderLiveResults();
    renderLiveSales();
    updateLiveCounters();
    // on garde la recherche prête pour le produit suivant
    $('#liveSearch').select();
  } catch (e) {
    toast(e.message, true);
  }
};

function renderLiveSales() {
  $('#liveSales').innerHTML = liveSalesLog.length
    ? liveSalesLog
        .map(
          (s, i) => `
      <div class="live-sale ${s.cancelled ? 'cancelled' : ''}">
        <span class="live-sale-time">${timeFr(s.time)}</span>
        <span class="live-sale-name">${escapeHtml(s.name)}${s.sku ? ` <small>(${escapeHtml(s.sku)})</small>` : ''}</span>
        <span class="live-sale-price">${euro(s.price)}</span>
        ${s.cancelled
          ? '<span class="live-sale-undone">annulée</span>'
          : `<button class="live-sale-undo" onclick="liveUndo(${i})" title="Annuler cette vente">↩</button>`}
      </div>`
        )
        .join('')
    : '<p class="empty small-pad">Les ventes apparaîtront ici,<br>horodatées à la seconde.</p>';
}

window.liveUndo = async (index) => {
  const sale = liveSalesLog[index];
  if (!sale || sale.cancelled || !sale.movement_id) return;
  try {
    const result = await api(`/api/movements/${sale.movement_id}/cancel`, { method: 'POST' });
    sale.cancelled = true;
    updateLocalProduct(result.product);
    renderProducts();
    renderLiveResults();
    renderLiveSales();
    updateLiveCounters();
    loadStats();
    toast('Vente annulée, stock restauré');
  } catch (e) {
    toast(e.message, true);
  }
};

$('#btnEndLive').addEventListener('click', async () => {
  if (!liveSession) return;
  const t = liveTotals();
  if (t.items > 0 && !confirm(`Terminer le live ? (${t.items} vente(s) enregistrée(s))`)) return;
  try {
    const session = await api(`/api/lives/${liveSession.id}/end`, { method: 'POST' });
    closeLiveMode();
    const dur = session.ended_at
      ? Math.round((new Date(session.ended_at) - new Date(session.started_at)) / 60000)
      : 0;
    $('#recapContent').innerHTML = `
      <div class="recap-grid">
        <div class="stat"><div class="value">${PLATFORM_LABELS[session.platform]}</div><div class="label">Plateforme</div></div>
        <div class="stat"><div class="value">${dur} min</div><div class="label">Durée</div></div>
        <div class="stat"><div class="value">${session.items}</div><div class="label">Articles vendus</div></div>
        <div class="stat"><div class="value">${euro(session.revenue)}</div><div class="label">Chiffre d'affaires</div></div>
      </div>
      <p><a class="btn" href="/api/lives/${session.id}/export.csv">⬇ Exporter les ventes de ce live (CSV)</a></p>`;
    $('#recapModal').hidden = false;
  } catch (e) {
    toast(e.message, true);
  }
});

function closeLiveMode() {
  liveSession = null;
  liveSalesLog = [];
  clearInterval(liveTimerInterval);
  $('#liveOverlay').hidden = true;
  document.body.classList.remove('no-scroll');
  loadProducts();
}

$('#btnCloseRecap').addEventListener('click', () => {
  $('#recapModal').hidden = true;
});

// Reprise d'un live en cours après rechargement de la page
async function resumeActiveLive() {
  try {
    const active = await api('/api/lives/active');
    if (active) {
      openLiveMode(active, active.sales || []);
      toast('Live en cours repris');
    }
  } catch (e) {
    /* pas bloquant */
  }
}

// ---------------------------------------------------------------------------
// Onglet Lives (historique des sessions)
// ---------------------------------------------------------------------------
async function loadLives() {
  const lives = await api('/api/lives');
  $('#liveDetail').hidden = true;
  $('#livesTable tbody').innerHTML = lives.length
    ? lives
        .map((l) => {
          const dur = l.ended_at
            ? `${Math.round((new Date(l.ended_at) - new Date(l.started_at)) / 60000)} min`
            : '<span class="live-ongoing">🔴 en cours</span>';
          return `<tr>
        <td>${dateFr(l.started_at)}</td>
        <td>${PLATFORM_LABELS[l.platform] || l.platform}</td>
        <td>${dur}</td>
        <td>${l.items}</td>
        <td>${euro(l.revenue)}</td>
        <td><button class="btn small" onclick="showLiveDetail(${l.id})">Détail</button></td>
      </tr>`;
        })
        .join('')
    : '<tr><td colspan="6">Aucun live pour l\'instant — cliquez sur « 🔴 Lancer un live » pour commencer</td></tr>';
}

window.showLiveDetail = async (id) => {
  try {
    const l = await api(`/api/lives/${id}`);
    const rows = l.sales.length
      ? l.sales
          .map(
            (m) => `<tr class="${m.cancelled ? 'row-cancelled' : ''}">
          <td>${timeFr(m.created_at)}</td>
          <td>${escapeHtml(m.product_name)}${m.product_sku ? ` <span class="product-sku">(${escapeHtml(m.product_sku)})</span>` : ''}</td>
          <td>${euro(m.product_price)}</td>
          <td>${m.cancelled ? 'annulée' : 'vendue'}</td>
        </tr>`
          )
          .join('')
      : '<tr><td colspan="4">Aucune vente pendant ce live</td></tr>';
    $('#liveDetail').innerHTML = `
      <h3>${PLATFORM_LABELS[l.platform]} — ${dateFr(l.started_at)}</h3>
      <p class="muted">${l.items} article(s) vendu(s) · ${euro(l.revenue)}
        · <a href="/api/lives/${l.id}/export.csv">⬇ Exporter en CSV</a></p>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Heure</th><th>Produit</th><th>Prix</th><th>Statut</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
    $('#liveDetail').hidden = false;
    $('#liveDetail').scrollIntoView({ behavior: 'smooth' });
  } catch (e) {
    toast(e.message, true);
  }
};

// ---------------------------------------------------------------------------
// Modale produit (ajout / édition)
// ---------------------------------------------------------------------------
const modal = $('#modal');
const form = $('#productForm');

function openModal() {
  modal.hidden = false;
  form.name.focus();
}
function closeModal() {
  modal.hidden = true;
  form.reset();
  editingId = null;
  photoFile = null;
  $('#photoPreview').hidden = true;
  $('#photoPreview').src = '';
  $('#photoHint').hidden = false;
  $('#btnDelete').hidden = true;
}

$('#btnAdd').addEventListener('click', () => {
  $('#modalTitle').textContent = 'Nouveau produit';
  openModal();
});
$('#btnCloseModal').addEventListener('click', closeModal);
modal.addEventListener('click', (e) => {
  if (e.target === modal) closeModal();
});

window.openEdit = (id) => {
  const p = products.find((x) => x.id === id);
  if (!p) return;
  editingId = id;
  $('#modalTitle').textContent = 'Modifier le produit';
  form.name.value = p.name;
  form.sku.value = p.sku || '';
  form.category.value = p.category;
  form.price.value = p.price;
  form.cost.value = p.cost;
  form.stock.value = p.stock;
  form.min_stock.value = p.min_stock;
  if (p.photo) {
    $('#photoPreview').src = p.photo;
    $('#photoPreview').hidden = false;
    $('#photoHint').hidden = true;
  }
  $('#btnDelete').hidden = false;
  openModal();
};

// Photo : clic + glisser-déposer
const photoDrop = $('#photoDrop');
const photoInput = $('#photoInput');
photoDrop.addEventListener('click', () => photoInput.click());
photoInput.addEventListener('change', () => setPhoto(photoInput.files[0]));
photoDrop.addEventListener('dragover', (e) => {
  e.preventDefault();
  photoDrop.classList.add('over');
});
photoDrop.addEventListener('dragleave', () => photoDrop.classList.remove('over'));
photoDrop.addEventListener('drop', (e) => {
  e.preventDefault();
  photoDrop.classList.remove('over');
  setPhoto(e.dataTransfer.files[0]);
});

function setPhoto(file) {
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    toast('Le fichier doit être une image', true);
    return;
  }
  photoFile = file;
  const reader = new FileReader();
  reader.onload = () => {
    $('#photoPreview').src = reader.result;
    $('#photoPreview').hidden = false;
    $('#photoHint').hidden = true;
  };
  reader.readAsDataURL(file);
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(form);
  if (photoFile) fd.set('photo', photoFile);
  $('#btnSave').disabled = true;
  try {
    if (editingId) {
      await api(`/api/products/${editingId}`, { method: 'PUT', body: fd });
      toast('Produit mis à jour ✔');
    } else {
      await api('/api/products', { method: 'POST', body: fd });
      toast('Produit ajouté ✔');
    }
    closeModal();
    loadProducts();
  } catch (err) {
    toast(err.message, true);
  } finally {
    $('#btnSave').disabled = false;
  }
});

$('#btnDelete').addEventListener('click', async () => {
  if (!editingId) return;
  const p = products.find((x) => x.id === editingId);
  if (!confirm(`Supprimer définitivement « ${p?.name} » ?`)) return;
  try {
    await api(`/api/products/${editingId}`, { method: 'DELETE' });
    toast('Produit supprimé');
    closeModal();
    loadProducts();
  } catch (err) {
    toast(err.message, true);
  }
});

// ---------------------------------------------------------------------------
// Import Excel / CSV
// ---------------------------------------------------------------------------
const dropzone = $('#dropzone');
const importFile = $('#importFile');
dropzone.addEventListener('click', () => importFile.click());
importFile.addEventListener('change', () => sendImportFile(importFile.files[0]));
dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.classList.add('over');
});
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('over'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('over');
  sendImportFile(e.dataTransfer.files[0]);
});

async function sendImportFile(file) {
  if (!file) return;
  $('#importResult').hidden = true;
  const fd = new FormData();
  fd.set('file', file);
  try {
    const data = await api('/api/import/preview', { method: 'POST', body: fd });
    currentImport = data;
    $('#importFileName').textContent = `📄 ${file.name} — ${data.rowCount} ligne(s)`;
    $('#importCount').textContent = `(${data.rowCount} lignes)`;
    renderMapping(data);
    renderPreview(data);
    $('#importConfig').hidden = false;
  } catch (e) {
    toast(e.message, true);
  } finally {
    importFile.value = '';
  }
}

function renderMapping(data) {
  $('#mappingGrid').innerHTML = MAPPING_FIELDS.map((f) => {
    const options = ['<option value="">— Ignorer —</option>']
      .concat(
        data.headers.map(
          (h) =>
            `<option value="${escapeHtml(h)}" ${data.mapping[f.key] === h ? 'selected' : ''}>${escapeHtml(h)}</option>`
        )
      )
      .join('');
    return `<label>${f.label}<select data-field="${f.key}">${options}</select></label>`;
  }).join('');
}

function renderPreview(data) {
  const head = `<thead><tr>${data.headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>`;
  const body = `<tbody>${data.preview
    .map((row) => `<tr>${data.headers.map((h) => `<td>${escapeHtml(row[h])}</td>`).join('')}</tr>`)
    .join('')}</tbody>`;
  $('#previewTable').innerHTML = head + body;
}

$('#btnCancelImport').addEventListener('click', () => {
  currentImport = null;
  $('#importConfig').hidden = true;
});

$('#btnCommitImport').addEventListener('click', async () => {
  if (!currentImport) return;
  const mapping = {};
  document.querySelectorAll('#mappingGrid select').forEach((sel) => {
    if (sel.value) mapping[sel.dataset.field] = sel.value;
  });
  $('#btnCommitImport').disabled = true;
  try {
    const result = await api('/api/import/commit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        importId: currentImport.importId,
        mapping,
        mode: $('#importMode').value,
      }),
    });
    $('#importConfig').hidden = true;
    currentImport = null;
    const r = $('#importResult');
    r.innerHTML = `<h3>✅ Import terminé</h3>
      <p>${result.created} produit(s) créé(s) · ${result.updated} mis à jour · ${result.skipped} ligne(s) ignorée(s)</p>`;
    r.hidden = false;
    loadProducts();
  } catch (e) {
    toast(e.message, true);
  } finally {
    $('#btnCommitImport').disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Historique des mouvements
// ---------------------------------------------------------------------------
async function loadMovements() {
  const rows = await api('/api/movements');
  $('#movementsTable tbody').innerHTML = rows.length
    ? rows
        .map(
          (m) => `<tr class="${m.cancelled ? 'row-cancelled' : ''}">
        <td>${dateFr(m.created_at)}</td>
        <td>${escapeHtml(m.product_name)}${m.product_sku ? ` <span class="product-sku">(${escapeHtml(m.product_sku)})</span>` : ''}</td>
        <td>${CHANNEL_LABELS[m.channel] || m.channel}</td>
        <td class="${m.delta > 0 ? 'delta-pos' : 'delta-neg'}">${m.delta > 0 ? '+' : ''}${m.delta}</td>
        <td>${m.stock_after}</td>
        <td>${escapeHtml(m.reason)}</td>
      </tr>`
        )
        .join('')
    : '<tr><td colspan="6">Aucun mouvement pour l\'instant</td></tr>';
}

// ---------------------------------------------------------------------------
loadProducts().then(resumeActiveLive);
