/* WowMart Stock — interface
   Stock unique partagé entre les canaux : une vente en ligne, en boutique
   ou en live décompte du même total ; le canal sert à tracer la vente.
   Le mode live enregistre chaque vente horodatée dans une session datée. */

const $ = (sel) => document.querySelector(sel);

// Logo TikTok officiel (SVG local) utilisé partout à la place d'un emoji
const TIKTOK_ICON = '<img src="img/tiktok.svg" class="ico-tiktok" alt="">';
const SALE_CHANNELS = [
  { key: 'online', label: '🌐 En ligne', text: 'En ligne' },
  { key: 'store', label: '🏬 Boutique', text: 'Boutique' },
  { key: 'tiktok', label: `${TIKTOK_ICON} TikTok`, text: 'TikTok' },
  { key: 'whatnot', label: '🟡 Whatnot', text: 'Whatnot' },
];
const CHANNEL_LABELS = {
  online: '🌐 En ligne',
  store: '🏬 Boutique',
  tiktok: `${TIKTOK_ICON} TikTok`,
  whatnot: '🟡 Whatnot',
  live: '🎥 Live',
  adjust: '🔧 Ajustement',
};
const PLATFORM_LABELS = { tiktok: `${TIKTOK_ICON} TikTok`, whatnot: '🟡 Whatnot' };
const MAPPING_FIELDS = [
  { key: 'sku', label: 'SKU / Référence' },
  { key: 'barcode', label: 'Code-barres (EAN)' },
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
let vatRate = 20; // taux de TVA (%), modifiable dans l'onglet Lives
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
    if (btn.dataset.tab === 'stats') loadStatsPage();
  });
});

// ---------------------------------------------------------------------------
// Statistiques
// ---------------------------------------------------------------------------
async function loadStats() {
  const s = await api('/api/stats');
  const checkTile =
    s.lives_to_check > 0
      ? `<div class="stat alert clickable" onclick="document.querySelector('[data-tab=lives]').click()" title="Voir les lives à vérifier">
           <div class="value">${s.lives_to_check}</div><div class="label">🔴 Live(s) à vérifier</div>
         </div>`
      : '';
  $('#stats').innerHTML = `
    ${checkTile}
    <div class="stat"><div class="value">${s.products}</div><div class="label">Produits</div></div>
    <div class="stat"><div class="value">${s.stock}</div><div class="label">📦 Stock total</div></div>
    <div class="stat"><div class="value">${euro(s.value)}</div><div class="label">Valeur du stock</div></div>
    <div class="stat"><div class="value">${s.sales.online}</div><div class="label">🌐 En ligne (30 j)</div></div>
    <div class="stat"><div class="value">${s.sales.store}</div><div class="label">🏬 Boutique (30 j)</div></div>
    <div class="stat"><div class="value">${s.sales.tiktok}</div><div class="label">${TIKTOK_ICON} TikTok (30 j)</div></div>
    <div class="stat"><div class="value">${s.sales.whatnot}</div><div class="label">🟡 Whatnot (30 j)</div></div>
    <div class="stat ${s.low > 0 ? 'alert' : ''}"><div class="value">${s.low}</div><div class="label">⚠ Stock bas</div></div>`;
}

// ---------------------------------------------------------------------------
// Réglages : taux de TVA + barème de frais des plateformes
// ---------------------------------------------------------------------------
let platformFees = {
  whatnot: { commission: 6.67, processing: 2.42, fixed: 0.25 },
  tiktok: { commission: 0, processing: 0, fixed: 0 },
};
let hasApiKey = false; // clé API Anthropic configurée (analyse des photos)
let visionModel = 'claude-opus-5';

function fillFeesInputs() {
  $('#feeWnComm').value = platformFees.whatnot.commission;
  $('#feeWnProc').value = platformFees.whatnot.processing;
  $('#feeWnFixed').value = platformFees.whatnot.fixed;
  $('#feeTtComm').value = platformFees.tiktok.commission;
  $('#feeTtProc').value = platformFees.tiktok.processing;
  $('#feeTtFixed').value = platformFees.tiktok.fixed;
}

async function loadSettings() {
  try {
    const s = await api('/api/settings');
    vatRate = s.vat_rate;
    $('#vatRate').value = vatRate;
    if (s.fees) platformFees = s.fees;
    hasApiKey = !!s.has_api_key;
    if (s.vision_model) visionModel = s.vision_model;
    fillFeesInputs();
  } catch (e) {
    /* valeurs par défaut conservées */
  }
}

$('#vatRate').addEventListener('change', async () => {
  try {
    const s = await api('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vat_rate: parseFloat($('#vatRate').value) }),
    });
    vatRate = s.vat_rate;
    toast(`Taux de TVA enregistré : ${vatRate} %`);
  } catch (e) {
    toast(e.message, true);
  }
});

$('#btnSaveFees').addEventListener('click', async () => {
  try {
    const s = await api('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fees: {
          whatnot: {
            commission: parseFloat($('#feeWnComm').value),
            processing: parseFloat($('#feeWnProc').value),
            fixed: parseFloat($('#feeWnFixed').value),
          },
          tiktok: {
            commission: parseFloat($('#feeTtComm').value),
            processing: parseFloat($('#feeTtProc').value),
            fixed: parseFloat($('#feeTtFixed').value),
          },
        },
      }),
    });
    platformFees = s.fees;
    toast('Frais des plateformes enregistrés');
    loadLives();
  } catch (e) {
    toast(e.message, true);
  }
});

const httc = (ttc) => ttc / (1 + vatRate / 100); // TTC → HT

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
             title="Vendre 1 (${c.text})">${c.label}</button>`
      ).join('');
      return `
      <div class="product-card ${isLow(p) ? 'low' : ''}">
        ${photo}
        <div class="product-body">
          <div class="product-head">
            <div>
              <div class="product-name">${escapeHtml(p.name)}</div>
              <div class="product-sku">${escapeHtml(p.sku || '')}${p.category ? ' · ' + escapeHtml(p.category) : ''}${p.barcode ? ` · <span class="product-barcode" title="Code-barres">∥ ${escapeHtml(p.barcode)}</span>` : ''}</div>
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
  $('#livePlatformBadge').innerHTML = PLATFORM_LABELS[session.platform] || escapeHtml(session.platform);
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
          (p.barcode || '').includes(q) ||
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
          (p.barcode || '').includes(q) ||
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
        <div class="stat"><div class="value">${euro(session.margin)}</div><div class="label">Marge nette estimée (frais déduits)</div></div>
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
// Statut de vérification d'un live :
// en cours → 🔴 / pas de rapport importé → ⚠ rouge / rapport importé mais
// non validé → 🟠 à valider / validé → ✅
function liveStatus(l) {
  if (!l.ended_at) return { label: '<span class="live-ongoing">🔴 en cours</span>', cls: '' };
  if (!l.report_imported_at) {
    return { label: '<span class="status-badge missing">⚠ Rapport à importer</span>', cls: 'row-missing-report' };
  }
  if (!l.validated_at) {
    const unpaidTxt = l.unpaid > 0 ? ` · ${l.unpaid} non réglé(s)` : '';
    return { label: `<span class="status-badge tovalidate">🟠 À valider${unpaidTxt}</span>`, cls: 'row-tovalidate' };
  }
  return { label: '<span class="status-badge validated">✅ Validé</span>', cls: '' };
}

async function loadLives() {
  const lives = await api('/api/lives');
  $('#liveDetail').hidden = true;
  $('#livesTable tbody').innerHTML = lives.length
    ? lives
        .map((l) => {
          const dur = l.ended_at
            ? `${Math.round((new Date(l.ended_at) - new Date(l.started_at)) / 60000)} min`
            : '<span class="live-ongoing">🔴 en cours</span>';
          const st = liveStatus(l);
          return `<tr class="${st.cls}">
        <td>${dateFr(l.started_at)}</td>
        <td>${PLATFORM_LABELS[l.platform] || l.platform}</td>
        <td>${dur}</td>
        <td>${l.items}${l.gifts ? ` <small>+ ${l.gifts} 🎁</small>` : ''}${l.extras ? ` <small>+ ${l.extras} hors écran</small>` : ''}</td>
        <td>${euro(l.revenue)}</td>
        <td>${l.reported > 0 ? euro(l.margin) : '<span class="muted-cell">—</span>'}</td>
        <td>${st.label}</td>
        <td><button class="btn small" onclick="showLiveDetail(${l.id})">Détail</button></td>
      </tr>`;
        })
        .join('')
    : '<tr><td colspan="8">Aucun live pour l\'instant — cliquez sur « 🔴 Lancer un live » pour commencer</td></tr>';
}

// Marge d'une vente : gains nets de la plateforme si importés, sinon
// estimation avec le barème de frais (commission % + traitement % + fixe €)
let detailFees = { commission: 0, processing: 0, fixed: 0 }; // frais du live affiché
const estPlatformFees = (price) =>
  price > 0 ? (price * (detailFees.commission + detailFees.processing)) / 100 + detailFees.fixed : 0;
const saleNet = (m) => {
  if (m.net_amount != null) return m.net_amount;
  const eff = m.sold_price != null ? m.sold_price : m.product_price;
  return eff - (m.fees != null ? m.fees : estPlatformFees(eff));
};
const saleMargin = (m) => saleNet(m) - m.product_cost;
const saleNetIsEstimated = (m) => m.net_amount == null && m.fees == null;

const PAYMENT_LABELS = {
  paid: '<span class="pay-badge paid">payé</span>',
  pending: '<span class="pay-badge pending">⏳ en attente</span>',
  failed: '<span class="pay-badge failed">⚠ échec</span>',
};
const EXTRA_KIND_LABELS = {
  give_sub: '🎁 Give abonné',
  give_buyer: '🎁 Give acheteur',
  boutique: '🏪 Produit boutique',
  order: '📦 Commande boutique',
};

window.showLiveDetail = async (id) => {
  try {
    const l = await api(`/api/lives/${id}`);
    if (l.fee_config) detailFees = l.fee_config;
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
            const failed = m.payment_status === 'failed' && !m.cancelled;
            return `<tr class="${m.cancelled ? 'row-cancelled' : ''} ${failed ? 'row-unpaid' : ''}">
          <td><strong>${m.is_gift ? '🎁 ' : ''}${m.sale_no ? '#' + m.sale_no : ''}</strong></td>
          <td>${timeFr(m.created_at)}</td>
          <td>${m.photo ? `<a href="${escapeHtml(m.photo)}" target="_blank" rel="noopener"><img class="sale-photo-thumb" src="${escapeHtml(m.photo)}" alt=""></a> ` : ''}${escapeHtml(m.product_name)}${m.product_sku ? ` <span class="product-sku">(${escapeHtml(m.product_sku)})</span>` : ''}</td>
          <td>${euro(m.product_price)}</td>
          <td>${m.is_gift ? '<span class="muted-cell">offert</span>' : m.sold_price != null ? `<strong>${euro(m.sold_price)}</strong>` : '<span class="muted-cell">—</span>'}</td>
          <td>${m.is_gift
            ? '<span class="muted-cell">—</span>'
            : saleNetIsEstimated(m)
              ? `<span class="muted-cell" title="Estimation avec le barème de frais — importez le rapport pour la valeur exacte">≈ ${euro(saleNet(m))}</span>`
              : `<strong>${euro(saleNet(m))}</strong>`}</td>
          <td class="${margin >= 0 ? 'delta-pos' : 'delta-neg'}">${m.cancelled || failed ? '' : euro(margin)}</td>
          <td>${m.payment_status && !m.is_gift ? PAYMENT_LABELS[m.payment_status] || m.payment_status : '<span class="muted-cell">—</span>'}</td>
          <td>${m.cancelled
            ? (m.is_gift ? 'annulé' : 'annulée')
            : m.is_gift
              ? 'cadeau'
              : failed
                ? `<button class="btn small" onclick="liveRestock(${m.id}, ${l.id})" title="Annuler la vente et remettre l'article en stock">↩ Restock</button>`
                : 'vendue'}</td>
        </tr>`;
          })
          .join('')
      : '<tr><td colspan="9">Aucune vente pendant ce live</td></tr>';

    // Lignes hors « Vue à l'écran » : gives et produits boutique de la plateforme
    const extraRows = (l.extra_lines || [])
      .map(
        (x) => `<tr class="${x.payment_status === 'failed' ? 'row-unpaid' : ''}">
        <td>${EXTRA_KIND_LABELS[x.kind] || x.kind}</td>
        <td>${escapeHtml(x.ref)}</td>
        <td>${escapeHtml(x.label)}</td>
        <td>${x.sold_price != null ? euro(x.sold_price) : '<span class="muted-cell">—</span>'}</td>
        <td>${x.net_amount != null ? euro(x.net_amount) : '<span class="muted-cell">—</span>'}</td>
        <td>${PAYMENT_LABELS[x.payment_status] || x.payment_status}</td>
      </tr>`
      )
      .join('');

    // Bandeau d'état : rapport manquant → alerte rouge ; importé mais non
    // validé → étape de vérification ; validé → confirmation
    let statusBlock = '';
    if (l.ended_at && !l.report_imported_at) {
      statusBlock = `<div class="verify-banner missing">
        ⚠ <strong>Rapport de la plateforme non importé.</strong>
        Importez le CSV des ventes ci-dessous pour vérifier les paiements et calculer vos gains réels.
      </div>`;
    } else if (l.ended_at && !l.validated_at) {
      const problems = [
        ...l.sales.filter((m) => !m.cancelled && !m.is_gift && (m.payment_status === 'failed' || m.payment_status === 'pending')),
      ];
      const extraProblems = (l.extra_lines || []).filter((x) => x.payment_status === 'failed' || x.payment_status === 'pending');
      const problemList = [
        ...problems.map(
          (m) => `<li>${PAYMENT_LABELS[m.payment_status]} — Vue à l'écran <strong>#${m.sale_no}</strong> ${escapeHtml(m.product_name)}
            (${euro(m.sold_price != null ? m.sold_price : m.product_price)})
            ${m.payment_status === 'failed' ? `<button class="btn small" onclick="liveRestock(${m.id}, ${l.id})">↩ Restock</button>` : ''}</li>`
        ),
        ...extraProblems.map(
          (x) => `<li>${PAYMENT_LABELS[x.payment_status]} — ${escapeHtml(x.ref)} ${escapeHtml(x.label)}
            (${x.sold_price != null ? euro(x.sold_price) : '?'})</li>`
        ),
      ].join('');
      statusBlock = `<div class="verify-panel">
        <strong>🟠 Étape de vérification</strong>
        ${problemList
          ? `<p class="muted small">Ventes non réglées détectées dans le rapport — vérifiez-les avant de valider.
             « Restock » annule la vente et remet l'article en stock (elle est déjà exclue du CA et de la marge).</p>
             <ul class="verify-list">${problemList}</ul>`
          : '<p class="muted small">Aucun problème de paiement détecté dans le rapport. Vous pouvez valider ce live.</p>'}
        <button class="btn success-btn" onclick="validateLive(${l.id})">✅ Valider ce live</button>
      </div>`;
    } else if (l.validated_at) {
      statusBlock = `<div class="verify-banner validated">✅ Live vérifié et validé le ${dateFr(l.validated_at)}</div>`;
    }

    const ht = httc(l.revenue);
    $('#liveDetail').innerHTML = `
      <h3>${PLATFORM_LABELS[l.platform]} — ${dateFr(l.started_at)}</h3>
      ${statusBlock}
      <div class="recap-grid wide">
        <div class="stat"><div class="value">${l.items}</div><div class="label">Articles vendus</div></div>
        <div class="stat"><div class="value">${l.gifts}</div><div class="label">🎁 Cadeaux offerts</div></div>
        <div class="stat"><div class="value">${euro(l.revenue)}</div><div class="label">CA TTC${l.reported > 0 ? ' (réel)' : ' (catalogue)'}</div></div>
        <div class="stat"><div class="value">${euro(ht)}</div><div class="label">CA HT</div></div>
        <div class="stat"><div class="value">${euro(l.revenue - ht)}</div><div class="label">TVA collectée (${vatRate} %)</div></div>
        <div class="stat"><div class="value">${euro(l.margin)}</div><div class="label">Marge nette estimée</div></div>
        <div class="stat ${l.unpaid > 0 ? 'alert' : ''}"><div class="value">${l.unpaid}</div><div class="label">⚠ Non réglée(s)</div></div>
        <div class="stat"><div class="value">${l.reported}/${l.items}</div><div class="label">Ventes associées au rapport</div></div>
      </div>

      <div class="report-import">
        <strong>📄 Rapport de la plateforme</strong>
        <p class="muted small">Importez le CSV des ventes exporté depuis ${PLATFORM_LABELS[l.platform]}.
          Les lignes « Vue à l'écran #1, #2… » sont associées à vos ventes enregistrées pendant le live ;
          les gives (abonné / acheteur) et les produits référencés dans la boutique sont ajoutés à part,
          chacun ayant sa propre numérotation.</p>
        <button class="btn primary" onclick="document.getElementById('reportFile').click()">Choisir le fichier CSV</button>
        <input type="file" id="reportFile" accept=".csv,.xlsx,.xls,.tsv" hidden onchange="previewReport(${l.id}, this.files[0])">
        <div id="reportConfig" hidden></div>
        <div id="reportResult" hidden></div>
      </div>

      <div class="report-import photos-import">
        <strong>📸 Ventes par photos</strong>
        <p class="muted small">Pendant le live, vous photographiez chaque produit vendu avec son étiquette
          <strong>#numéro</strong>. Importez toutes les photos d'un coup : l'IA lit le numéro de vente et identifie
          le produit dans votre catalogue, vous vérifiez, puis les ventes sont créées (stock décompté, photo conservée).</p>
        <details class="api-key-setup" ${hasApiKey ? '' : 'open'}>
          <summary>🔑 Clé API Anthropic ${hasApiKey ? '— configurée ✓' : '— requise pour l\'analyse'}</summary>
          <p class="muted small">Créez une clé sur <a href="https://console.anthropic.com" target="_blank" rel="noopener">console.anthropic.com</a>
            (API Keys), puis collez-la ici. Elle est stockée uniquement dans votre base locale.</p>
          <div class="key-row">
            <input type="password" id="apiKeyInput" placeholder="sk-ant-…" autocomplete="off">
            <button class="btn primary" onclick="saveApiKey(${l.id})">Enregistrer</button>
          </div>
        </details>
        <div class="photos-actions">
          <label class="muted small">Modèle d'analyse :
            <select id="visionModel" onchange="saveVisionModel(this.value)">
              <option value="claude-opus-5" ${visionModel === 'claude-opus-5' ? 'selected' : ''}>Claude Opus 5 — précis (≈ 2-3 c€ / photo)</option>
              <option value="claude-haiku-4-5" ${visionModel === 'claude-haiku-4-5' ? 'selected' : ''}>Claude Haiku 4.5 — économique (≈ 0,3 c€ / photo)</option>
            </select>
          </label>
          <button class="btn primary" onclick="document.getElementById('livePhotos').click()" ${hasApiKey ? '' : 'disabled title="Enregistrez d\'abord votre clé API"'}>
            📸 Choisir les photos
          </button>
          <input type="file" id="livePhotos" accept="image/*" multiple hidden onchange="analyzeLivePhotos(${l.id}, this.files)">
        </div>
        <div id="photoProgress" class="photo-progress" hidden></div>
        <div id="photoReview" hidden></div>
      </div>

      ${productRows ? `
      <h4>Produits vendus (Vue à l'écran)</h4>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Produit</th><th>Quantité</th><th>Total</th><th>Marge</th></tr></thead>
          <tbody>${productRows}</tbody>
        </table>
      </div>` : ''}

      <h4>Ventes « Vue à l'écran » <a class="export-link" href="/api/lives/${l.id}/export.csv">⬇ Exporter en CSV</a></h4>
      <div class="table-wrap">
        <table>
          <thead><tr><th>N°</th><th>Heure</th><th>Produit</th><th>Prix catalogue</th><th>Prix vendu</th><th>Gains nets</th><th>Marge</th><th>Paiement</th><th>Statut</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>

      ${extraRows ? `
      <h4>Autres ventes du live (gives, produits boutique)</h4>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Type</th><th>Référence</th><th>Produit</th><th>Prix</th><th>Gains nets</th><th>Paiement</th></tr></thead>
          <tbody>${extraRows}</tbody>
        </table>
      </div>` : ''}`;
    $('#liveDetail').hidden = false;
    $('#liveDetail').scrollIntoView({ behavior: 'smooth' });
  } catch (e) {
    toast(e.message, true);
  }
};

// Valider un live après vérification
window.validateLive = async (id) => {
  try {
    await api(`/api/lives/${id}/validate`, { method: 'POST' });
    toast('✅ Live validé');
    await loadLives();
    await showLiveDetail(id);
    loadStats();
  } catch (e) {
    toast(e.message, true);
  }
};

// Annuler une vente non payée depuis le détail (l'article revient en stock)
window.liveRestock = async (movementId, liveId) => {
  if (!confirm('Annuler cette vente non payée et remettre l\'article en stock ?')) return;
  try {
    await api(`/api/movements/${movementId}/cancel`, { method: 'POST' });
    toast('Vente annulée, article remis en stock');
    await loadLives();
    await showLiveDetail(liveId);
    loadProducts();
  } catch (e) {
    toast(e.message, true);
  }
};

// ---------------------------------------------------------------------------
// Import du rapport de ventes de la plateforme (dans le détail d'un live)
// ---------------------------------------------------------------------------
const REPORT_FIELDS = [
  { key: 'sale_no', label: 'Référence de vente (ex : Vue à l\'écran #8)' },
  { key: 'name', label: 'Nom du produit (optionnel)' },
  { key: 'sold_price', label: 'Prix de vente (TTC)' },
  { key: 'net_amount', label: 'Gains nets (« Statut du gains »)' },
  { key: 'payment_status', label: 'Statut du paiement (optionnel)' },
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
    let msg = `✅ ${result.matched} vente(s) « Vue à l'écran » associée(s)`;
    if (result.extras) msg += ` · ${result.extras} ligne(s) hors écran (gives, boutique)`;
    if (result.unpaid) msg += ` · ⚠ ${result.unpaid} non réglée(s) à vérifier`;
    if (result.unmatched.length) {
      msg += ` — numéros introuvables : ${result.unmatched.slice(0, 10).join(', ')}${result.unmatched.length > 10 ? '…' : ''}`;
    }
    if (result.skipped) msg += ` · ${result.skipped} ligne(s) sans numéro ignorée(s)`;
    toast(msg);
    await loadLives();
    await showLiveDetail(liveId);
    loadStats();
  } catch (e) {
    toast(e.message, true);
  }
};

// ---------------------------------------------------------------------------
// Onglet Statistiques : top ventes/marges, réassort, rapport IA
// ---------------------------------------------------------------------------
let statsData = null;
const CHANNEL_SHORT = { online: '🌐', store: '🏬', tiktok: TIKTOK_ICON, whatnot: '🟡' };

async function loadStatsPage() {
  try {
    const days = $('#statsDays').value;
    statsData = await api(`/api/statistics?days=${encodeURIComponent(days)}`);
    renderStatsTable();
    renderOrderTable();
    renderLastAiReport();
  } catch (e) {
    toast(e.message, true);
  }
}

$('#statsDays').addEventListener('change', loadStatsPage);
$('#statsChannel').addEventListener('change', renderStatsTable);

function renderStatsTable() {
  if (!statsData) return;
  const channel = $('#statsChannel').value;
  // avec un filtre plateforme, on classe sur les chiffres de cette plateforme
  const list = statsData.products
    .map((p) => {
      const src = channel ? p.channels[channel] : p;
      if (!src || !src.qty) return null;
      return { ...p, fQty: src.qty, fRevenue: src.revenue, fMargin: src.margin };
    })
    .filter(Boolean)
    .sort((a, b) => b.fMargin - a.fMargin);

  $('#statsTable tbody').innerHTML = list.length
    ? list
        .map((p, i) => {
          const perUnit = p.fQty ? p.fMargin / p.fQty : 0;
          const breakdown = Object.entries(p.channels)
            .map(([c, v]) => `${CHANNEL_SHORT[c] || c} ${v.qty}`)
            .join(' · ');
          return `<tr>
        <td><strong>${i + 1}</strong></td>
        <td>${escapeHtml(p.name)}${p.sku ? ` <span class="product-sku">(${escapeHtml(p.sku)})</span>` : ''}</td>
        <td>${p.fQty}</td>
        <td>${euro(p.fRevenue)}</td>
        <td class="${p.fMargin >= 0 ? 'delta-pos' : 'delta-neg'}"><strong>${euro(p.fMargin)}</strong></td>
        <td class="${perUnit >= 0 ? 'delta-pos' : 'delta-neg'}">${euro(perUnit)}</td>
        <td class="muted-cell">${breakdown}</td>
      </tr>`;
        })
        .join('')
    : '<tr><td colspan="7">Aucune vente sur cette période' + (channel ? ' pour cette plateforme' : '') + '</td></tr>';
}

function renderOrderTable() {
  if (!statsData) return;
  $('#orderTable tbody').innerHTML = statsData.to_order.length
    ? statsData.to_order
        .map(
          (p) => `<tr class="row-missing-report">
        <td>${escapeHtml(p.name)}${p.sku ? ` <span class="product-sku">(${escapeHtml(p.sku)})</span>` : ''}</td>
        <td class="delta-neg"><strong>${p.stock}</strong></td>
        <td>${p.min_stock}</td>
        <td>${p.sold_30d}</td>
        <td><strong>${p.suggested}</strong></td>
      </tr>`
        )
        .join('')
    : '<tr><td colspan="5">✅ Aucun produit sous son seuil — rien à commander aujourd\'hui</td></tr>';
}

// Rendu Markdown minimal pour le rapport IA (titres, gras, listes)
function mdToHtml(md) {
  let h = escapeHtml(md);
  h = h.replace(/^#{1,3} (.*)$/gm, '<h3>$1</h3>');
  h = h.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/^[-*] (.*)$/gm, '<li>$1</li>');
  h = h.replace(/(<li>[\s\S]*?<\/li>\n?)+/g, (m) => `<ul>${m}</ul>`);
  h = h.replace(/\n{2,}/g, '</p><p>');
  return `<p>${h}</p>`;
}

function renderLastAiReport() {
  const r = statsData && statsData.last_report;
  if (!r || !r.report) return;
  $('#aiReportInfo').textContent = `Dernier rapport : ${dateFr(r.generated_at)}`;
  $('#aiReport').innerHTML = mdToHtml(r.report);
  $('#aiReport').hidden = false;
}

$('#btnAiReport').addEventListener('click', async () => {
  const btn = $('#btnAiReport');
  btn.disabled = true;
  $('#aiReportInfo').textContent = '🤖 Analyse de vos chiffres en cours… (jusqu\'à une minute)';
  try {
    const r = await api('/api/statistics/report', { method: 'POST' });
    $('#aiReport').innerHTML = mdToHtml(r.report);
    $('#aiReport').hidden = false;
    $('#aiReportInfo').textContent = `Rapport généré : ${dateFr(r.generated_at)}`;
    toast('✨ Rapport généré');
  } catch (e) {
    $('#aiReportInfo').textContent = '';
    toast(e.message, true);
  } finally {
    btn.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Ventes par photos : analyse des étiquettes #N par l'IA puis vérification
// ---------------------------------------------------------------------------
let photoAnalysis = null; // { liveId, results: [...] }

window.saveApiKey = async (liveId) => {
  const key = $('#apiKeyInput').value.trim();
  if (!key) {
    toast('Collez votre clé API (sk-ant-…)', true);
    return;
  }
  try {
    const s = await api('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ anthropic_api_key: key }),
    });
    hasApiKey = !!s.has_api_key;
    toast('🔑 Clé API enregistrée');
    showLiveDetail(liveId);
  } catch (e) {
    toast(e.message, true);
  }
};

window.saveVisionModel = async (model) => {
  try {
    const s = await api('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vision_model: model }),
    });
    visionModel = s.vision_model;
    toast(`Modèle d'analyse : ${visionModel}`);
  } catch (e) {
    toast(e.message, true);
  }
};

// Réduit la photo côté navigateur (max 1600 px, JPEG) : upload plus rapide
// et coût d'analyse réduit, sans perte de lisibilité de l'étiquette
async function resizePhoto(file, maxDim = 1600) {
  try {
    const img = await createImageBitmap(file);
    const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
    if (scale === 1 && file.size < 1.5 * 1024 * 1024) return file;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
    return blob || file;
  } catch (e) {
    return file; // format non géré par le navigateur : envoi tel quel
  }
}

window.analyzeLivePhotos = async (liveId, fileList) => {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  const progress = $('#photoProgress');
  progress.hidden = false;
  progress.textContent = `Préparation de ${files.length} photo(s)…`;
  try {
    const fd = new FormData();
    for (const f of files) {
      const resized = await resizePhoto(f);
      fd.append('photos', resized, f.name.replace(/\.[^.]+$/, '') + '.jpg');
    }
    progress.textContent = `🔎 Analyse de ${files.length} photo(s) par l'IA… (environ ${Math.ceil(files.length * 2)} s)`;
    const data = await api(`/api/lives/${liveId}/photos/analyze`, { method: 'POST', body: fd });
    photoAnalysis = { liveId, results: data.results };
    progress.hidden = true;
    renderPhotoReview();
  } catch (e) {
    progress.hidden = true;
    toast(e.message, true);
  } finally {
    const input = document.getElementById('livePhotos');
    if (input) input.value = '';
  }
};

function renderPhotoReview() {
  if (!photoAnalysis) return;
  const rows = photoAnalysis.results
    .map((r, i) => {
      const options = ['<option value="">— choisir le produit —</option>']
        .concat(
          products.map(
            (p) =>
              `<option value="${p.id}" ${r.best_match_id === p.id ? 'selected' : ''}>${escapeHtml(p.name)}${p.sku ? ` (${escapeHtml(p.sku)})` : ''} · stock ${p.stock}</option>`
          )
        )
        .join('');
      const ok = !r.error && r.sale_no && r.best_match_id;
      return `<tr class="${r.error ? 'row-unpaid' : ''}">
      <td><input type="checkbox" data-photo-row="${i}" ${ok ? 'checked' : ''} ${r.error ? 'disabled' : ''}></td>
      <td><a href="${escapeHtml(r.photo)}" target="_blank" rel="noopener"><img class="photo-thumb" src="${escapeHtml(r.photo)}" alt=""></a></td>
      <td><span class="photo-no-prefix">#</span><input type="number" min="1" class="photo-no" data-photo-no="${i}" value="${r.sale_no ?? ''}"></td>
      <td>${r.error ? `<span class="pay-badge failed">⚠ ${escapeHtml(r.error)}</span>` : escapeHtml(r.product_name)}</td>
      <td><select data-photo-product="${i}">${options}</select></td>
    </tr>`;
    })
    .join('');
  const detected = photoAnalysis.results.filter((r) => !r.error && r.sale_no).length;
  $('#photoReview').innerHTML = `
    <p class="muted small">✅ ${detected}/${photoAnalysis.results.length} photo(s) reconnue(s) —
      vérifiez les numéros et les produits, corrigez si besoin, puis validez.</p>
    <div class="table-wrap">
      <table>
        <thead><tr><th></th><th>Photo</th><th>N° de vente</th><th>Produit détecté</th><th>Produit du catalogue</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div class="actions">
      <button class="btn success-btn" onclick="commitPhotoSales()">✅ Créer les ventes sélectionnées</button>
    </div>`;
  $('#photoReview').hidden = false;
}

window.commitPhotoSales = async () => {
  if (!photoAnalysis) return;
  const sales = [];
  photoAnalysis.results.forEach((r, i) => {
    const check = document.querySelector(`[data-photo-row="${i}"]`);
    if (!check || !check.checked) return;
    const saleNo = parseInt(document.querySelector(`[data-photo-no="${i}"]`).value, 10);
    const productId = parseInt(document.querySelector(`[data-photo-product="${i}"]`).value, 10);
    if (!Number.isFinite(saleNo) || !Number.isFinite(productId)) return;
    sales.push({ product_id: productId, sale_no: saleNo, photo: r.photo });
  });
  if (!sales.length) {
    toast('Aucune ligne complète sélectionnée (numéro + produit requis)', true);
    return;
  }
  try {
    const result = await api(`/api/lives/${photoAnalysis.liveId}/photo-sales`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sales }),
    });
    let msg = `✅ ${result.created} vente(s) créée(s) depuis les photos`;
    if (result.skipped.length) msg += ` — ignorées : ${result.skipped.slice(0, 5).join(' · ')}${result.skipped.length > 5 ? '…' : ''}`;
    toast(msg);
    const liveId = photoAnalysis.liveId;
    photoAnalysis = null;
    await loadProducts();
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
  form.barcode.value = p.barcode || '';
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
loadSettings();
loadProducts().then(resumeActiveLive);
