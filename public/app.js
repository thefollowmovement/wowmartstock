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
    sale_no: m.sale_no,
    product_id: m.product_id,
    name: m.product_name,
    sku: m.product_sku,
    price: m.is_gift ? 0 : m.product_price,
    is_gift: !!m.is_gift,
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
  return {
    items: valid.filter((s) => !s.is_gift).length,
    gifts: valid.filter((s) => s.is_gift).length,
    revenue: valid.reduce((sum, s) => sum + (Number(s.price) || 0), 0),
  };
}

function updateLiveCounters() {
  const t = liveTotals();
  $('#liveCounters').textContent =
    `${t.items} vente(s)${t.gifts ? ` · ${t.gifts} 🎁` : ''} · ${euro(t.revenue)}`;
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
      sale_no: result.sale_no,
      product_id: id,
      name: p.name,
      sku: p.sku,
      price: p.price,
      is_gift: false,
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

// Journal du live : chaque vente avec, en dessous, ses cadeaux (🎁) rattachés
function renderLiveSales() {
  const saleLine = (s) => `
      <div class="live-sale ${s.cancelled ? 'cancelled' : ''}">
        ${s.cancelled ? '<span class="live-gift-spacer"></span>'
          : `<button class="live-gift-btn" onclick="openGiftPicker(${s.sale_no})" title="Ajouter un cadeau à la vente #${s.sale_no}">🎁</button>`}
        <span class="live-sale-no">${s.sale_no ? '#' + s.sale_no : ''}</span>
        <span class="live-sale-time">${timeFr(s.time)}</span>
        <span class="live-sale-name">${escapeHtml(s.name)}${s.sku ? ` <small>(${escapeHtml(s.sku)})</small>` : ''}</span>
        <span class="live-sale-price">${euro(s.price)}</span>
        ${s.cancelled
          ? '<span class="live-sale-undone">annulée</span>'
          : `<button class="live-sale-undo" onclick="liveUndo(${s.movement_id})" title="Annuler cette vente">↩</button>`}
      </div>`;
  const giftLine = (g) => `
      <div class="live-sale gift ${g.cancelled ? 'cancelled' : ''}">
        <span class="live-gift-spacer"></span>
        <span class="live-sale-no gift">🎁</span>
        <span class="live-sale-name">${escapeHtml(g.name)}${g.sku ? ` <small>(${escapeHtml(g.sku)})</small>` : ''}</span>
        <span class="live-sale-price offert">offert</span>
        ${g.cancelled
          ? '<span class="live-sale-undone">annulé</span>'
          : `<button class="live-sale-undo" onclick="liveUndo(${g.movement_id})" title="Annuler ce cadeau">↩</button>`}
      </div>`;
  const sales = liveSalesLog.filter((s) => !s.is_gift);
  $('#liveSales').innerHTML = sales.length
    ? sales
        .map(
          (s) =>
            saleLine(s) +
            liveSalesLog
              .filter((g) => g.is_gift && g.sale_no === s.sale_no)
              .map(giftLine)
              .join('')
        )
        .join('')
    : '<p class="empty small-pad">Les ventes apparaîtront ici,<br>horodatées à la seconde.</p>';
}

window.liveUndo = async (movementId) => {
  const sale = liveSalesLog.find((s) => s.movement_id === movementId);
  if (!sale || sale.cancelled) return;
  try {
    const result = await api(`/api/movements/${movementId}/cancel`, { method: 'POST' });
    sale.cancelled = true;
    updateLocalProduct(result.product);
    renderProducts();
    renderLiveResults();
    renderLiveSales();
    updateLiveCounters();
    loadStats();
    toast(sale.is_gift ? 'Cadeau annulé, stock restauré' : 'Vente annulée, stock restauré');
  } catch (e) {
    toast(e.message, true);
  }
};

// ---------------------------------------------------------------------------
// Sélecteur de cadeau (🎁 rattaché à une vente du live)
// ---------------------------------------------------------------------------
let giftForSaleNo = null;

window.openGiftPicker = (saleNo) => {
  giftForSaleNo = saleNo;
  $('#giftTitle').textContent = `🎁 Ajouter un cadeau à la vente #${saleNo}`;
  $('#giftSearch').value = '';
  renderGiftResults();
  $('#giftModal').hidden = false;
  setTimeout(() => $('#giftSearch').focus(), 100);
};

function closeGiftPicker() {
  giftForSaleNo = null;
  $('#giftModal').hidden = true;
  if (liveSession) setTimeout(() => $('#liveSearch').focus(), 100);
}

$('#btnCloseGift').addEventListener('click', closeGiftPicker);
$('#giftModal').addEventListener('click', (e) => {
  if (e.target === $('#giftModal')) closeGiftPicker();
});
$('#giftSearch').addEventListener('input', () => renderGiftResults());

function renderGiftResults() {
  const q = $('#giftSearch').value.trim().toLowerCase();
  const list = (q
    ? products.filter(
        (p) =>
          (p.sku || '').toLowerCase().includes(q) ||
          p.name.toLowerCase().includes(q) ||
          (p.category || '').toLowerCase().includes(q)
      )
    : products
  ).filter((p) => p.stock > 0);
  $('#giftResults').innerHTML = list.length
    ? list
        .map((p) => {
          const photo = p.photo
            ? `<img src="${escapeHtml(p.photo)}" alt="" loading="lazy">`
            : '<div class="live-noimg">📷</div>';
          return `
        <button class="live-product" onclick="giveGift(${p.id})">
          ${photo}
          <span class="live-product-info">
            <span class="live-product-name">${escapeHtml(p.name)}</span>
            <span class="live-product-sku">${escapeHtml(p.sku || '')}</span>
          </span>
          <span class="live-product-side">
            <span class="live-product-stock">Stock : ${p.stock}</span>
            <span class="live-product-action gift">OFFRIR 🎁</span>
          </span>
        </button>`;
        })
        .join('')
    : '<p class="empty small-pad">Aucun produit en stock ne correspond</p>';
}

window.giveGift = async (productId) => {
  if (!liveSession || giftForSaleNo == null) return;
  const p = products.find((x) => x.id === productId);
  try {
    const result = await api(`/api/lives/${liveSession.id}/gift`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sale_no: giftForSaleNo, product_id: productId }),
    });
    updateLocalProduct(result.product);
    liveSalesLog.unshift({
      movement_id: result.movement_id,
      sale_no: result.sale_no,
      product_id: productId,
      name: p.name,
      sku: p.sku,
      price: 0,
      is_gift: true,
      time: new Date().toISOString(),
      cancelled: false,
    });
    renderProducts();
    renderLiveResults();
    renderGiftResults();
    renderLiveSales();
    updateLiveCounters();
    loadStats();
    toast(`🎁 ${p.name} ajouté à la vente #${giftForSaleNo}`);
    // le sélecteur reste ouvert pour ajouter un autre cadeau à la même vente
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
        <div class="stat"><div class="value">${session.items}${session.gifts ? ` <small>+ ${session.gifts} 🎁</small>` : ''}</div><div class="label">Articles vendus${session.gifts ? ' + cadeaux' : ''}</div></div>
        <div class="stat"><div class="value">${euro(session.revenue)}</div><div class="label">Chiffre d'affaires</div></div>
      </div>
      <p class="muted">💡 Importez ensuite le rapport CSV de la plateforme depuis l'onglet <strong>Lives</strong> → Détail, pour récupérer les prix de vente réels et calculer votre marge.</p>
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
        <td>${l.items}${l.gifts ? ` <small>+ ${l.gifts} 🎁</small>` : ''}</td>
        <td>${euro(l.revenue)}</td>
        <td>${l.reported > 0 ? euro(l.margin) : '<span class="muted-cell">—</span>'}</td>
        <td><button class="btn small" onclick="showLiveDetail(${l.id})">Détail</button></td>
      </tr>`;
        })
        .join('')
    : '<tr><td colspan="7">Aucun live pour l\'instant — cliquez sur « 🔴 Lancer un live » pour commencer</td></tr>';
}

// Marge d'une vente : prix vendu réel (rapport plateforme) sinon prix
// catalogue, moins les frais et le coût d'achat
const saleMargin = (m) =>
  (m.sold_price != null ? m.sold_price : m.product_price) - (m.fees || 0) - m.product_cost;

window.showLiveDetail = async (id) => {
  try {
    const l = await api(`/api/lives/${id}`);
    const valid = l.sales.filter((m) => !m.cancelled);

    // Récap des produits vendus (agrégé) — les cadeaux sur une ligne à part
    const byProduct = new Map();
    for (const m of valid) {
      const key = `${m.product_id}-${m.is_gift ? 'gift' : 'sale'}`;
      const e = byProduct.get(key) || {
        name: m.product_name, sku: m.product_sku, isGift: !!m.is_gift, qty: 0, total: 0, margin: 0,
      };
      e.qty += 1;
      e.total += m.sold_price != null ? m.sold_price : m.product_price;
      e.margin += saleMargin(m);
      byProduct.set(key, e);
    }
    const productRows = [...byProduct.values()]
      .sort((a, b) => (a.isGift !== b.isGift ? a.isGift - b.isGift : b.qty - a.qty))
      .map(
        (e) => `<tr>
        <td>${e.isGift ? '🎁 ' : ''}${escapeHtml(e.name)}${e.sku ? ` <span class="product-sku">(${escapeHtml(e.sku)})</span>` : ''}</td>
        <td>${e.qty}</td>
        <td>${e.isGift ? '<span class="muted-cell">offert</span>' : euro(e.total)}</td>
        <td class="${e.margin >= 0 ? 'delta-pos' : 'delta-neg'}">${euro(e.margin)}</td>
      </tr>`
      )
      .join('');

    const rows = l.sales.length
      ? l.sales
          .map((m) => {
            const margin = saleMargin(m);
            return `<tr class="${m.cancelled ? 'row-cancelled' : ''}">
          <td><strong>${m.is_gift ? '🎁 ' : ''}${m.sale_no ? '#' + m.sale_no : ''}</strong></td>
          <td>${timeFr(m.created_at)}</td>
          <td>${escapeHtml(m.product_name)}${m.product_sku ? ` <span class="product-sku">(${escapeHtml(m.product_sku)})</span>` : ''}</td>
          <td>${euro(m.product_price)}</td>
          <td>${m.is_gift ? '<span class="muted-cell">offert</span>' : m.sold_price != null ? `<strong>${euro(m.sold_price)}</strong>` : '<span class="muted-cell">—</span>'}</td>
          <td>${m.fees != null && !m.is_gift ? euro(m.fees) : '<span class="muted-cell">—</span>'}</td>
          <td class="${margin >= 0 ? 'delta-pos' : 'delta-neg'}">${m.cancelled ? '' : euro(margin)}</td>
          <td>${m.cancelled ? (m.is_gift ? 'annulé' : 'annulée') : m.is_gift ? 'cadeau' : 'vendue'}</td>
        </tr>`;
          })
          .join('')
      : '<tr><td colspan="8">Aucune vente pendant ce live</td></tr>';

    $('#liveDetail').innerHTML = `
      <h3>${PLATFORM_LABELS[l.platform]} — ${dateFr(l.started_at)}</h3>
      <div class="recap-grid wide">
        <div class="stat"><div class="value">${l.items}</div><div class="label">Articles vendus</div></div>
        <div class="stat"><div class="value">${l.gifts}</div><div class="label">🎁 Cadeaux offerts</div></div>
        <div class="stat"><div class="value">${euro(l.revenue)}</div><div class="label">Chiffre d'affaires${l.reported > 0 ? ' (réel)' : ' (catalogue)'}</div></div>
        <div class="stat"><div class="value">${euro(l.margin)}</div><div class="label">Marge estimée</div></div>
        <div class="stat"><div class="value">${l.reported}/${l.items}</div><div class="label">Ventes associées au rapport</div></div>
      </div>

      <div class="report-import">
        <strong>📄 Rapport de la plateforme</strong>
        <p class="muted small">Importez le CSV des ventes exporté depuis ${PLATFORM_LABELS[l.platform]} :
          chaque ligne est associée à la vente correspondante grâce à son numéro (#1, #2…),
          pour récupérer le prix de vente réel et calculer votre marge.</p>
        <button class="btn primary" onclick="document.getElementById('reportFile').click()">Choisir le fichier CSV</button>
        <input type="file" id="reportFile" accept=".csv,.xlsx,.xls,.tsv" hidden onchange="previewReport(${l.id}, this.files[0])">
        <div id="reportConfig" hidden></div>
        <div id="reportResult" hidden></div>
      </div>

      ${productRows ? `
      <h4>Produits vendus</h4>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Produit</th><th>Quantité</th><th>Total</th><th>Marge</th></tr></thead>
          <tbody>${productRows}</tbody>
        </table>
      </div>` : ''}

      <h4>Toutes les ventes <a class="export-link" href="/api/lives/${l.id}/export.csv">⬇ Exporter en CSV</a></h4>
      <div class="table-wrap">
        <table>
          <thead><tr><th>N°</th><th>Heure</th><th>Produit</th><th>Prix catalogue</th><th>Prix vendu</th><th>Frais</th><th>Marge</th><th>Statut</th></tr></thead>
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
// Import du rapport de ventes de la plateforme (dans le détail d'un live)
// ---------------------------------------------------------------------------
const REPORT_FIELDS = [
  { key: 'sale_no', label: 'Numéro de vente (#)' },
  { key: 'sold_price', label: 'Prix de vente' },
  { key: 'fees', label: 'Frais / commission (optionnel)' },
];
let currentReport = null; // { liveId, importId, headers, ... }

window.previewReport = async (liveId, file) => {
  if (!file) return;
  const fd = new FormData();
  fd.set('file', file);
  try {
    const data = await api(`/api/lives/${liveId}/report/preview`, { method: 'POST', body: fd });
    currentReport = { ...data, liveId };
    const selects = REPORT_FIELDS.map((f) => {
      const options = ['<option value="">— Ignorer —</option>']
        .concat(
          data.headers.map(
            (h) => `<option value="${escapeHtml(h)}" ${data.mapping[f.key] === h ? 'selected' : ''}>${escapeHtml(h)}</option>`
          )
        )
        .join('');
      return `<label>${f.label}<select data-report-field="${f.key}">${options}</select></label>`;
    }).join('');
    const previewHead = data.headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('');
    const previewBody = data.preview
      .map((row) => `<tr>${data.headers.map((h) => `<td>${escapeHtml(row[h])}</td>`).join('')}</tr>`)
      .join('');
    document.getElementById('reportConfig').innerHTML = `
      <p><strong>📄 ${escapeHtml(file.name)}</strong> — ${data.rowCount} ligne(s)</p>
      <div class="mapping-grid">${selects}</div>
      <div class="table-wrap"><table><thead><tr>${previewHead}</tr></thead><tbody>${previewBody}</tbody></table></div>
      <div class="actions">
        <button class="btn primary" onclick="commitReport()">Associer les ventes</button>
      </div>`;
    document.getElementById('reportConfig').hidden = false;
    document.getElementById('reportResult').hidden = true;
  } catch (e) {
    toast(e.message, true);
  }
};

window.commitReport = async () => {
  if (!currentReport) return;
  const mapping = {};
  document.querySelectorAll('[data-report-field]').forEach((sel) => {
    if (sel.value) mapping[sel.dataset.reportField] = sel.value;
  });
  try {
    const result = await api(`/api/lives/${currentReport.liveId}/report/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ importId: currentReport.importId, mapping }),
    });
    const liveId = currentReport.liveId;
    currentReport = null;
    let msg = `✅ ${result.matched} vente(s) associée(s)`;
    if (result.unmatched.length) {
      msg += ` — non trouvées dans ce live : ${result.unmatched.slice(0, 10).join(', ')}${result.unmatched.length > 10 ? '…' : ''}`;
    }
    if (result.skipped) msg += ` · ${result.skipped} ligne(s) sans numéro ignorée(s)`;
    toast(msg);
    await loadLives();
    await showLiveDetail(liveId);
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
