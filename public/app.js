/* WowMart Stock — interface
   Stock unique partagé entre les canaux : une vente en ligne, en boutique
   ou en live décompte du même total ; le canal sert à tracer la vente.
   Le mode live enregistre chaque vente horodatée dans une session datée. */

const $ = (sel) => document.querySelector(sel);

// Logo TikTok officiel (SVG local) utilisé partout à la place d'un emoji
const TIKTOK_ICON = '<img src="img/tiktok.svg" class="ico-tiktok" alt="">';
const SALE_CHANNELS = [
  { key: 'online', label: '🌐 En ligne', text: 'En ligne', icon: '🌐' },
  { key: 'store', label: '🏬 Boutique', text: 'Boutique', icon: '🏬' },
  { key: 'tiktok', label: `${TIKTOK_ICON} TikTok`, text: 'TikTok', icon: TIKTOK_ICON },
  { key: 'whatnot', label: '🟡 Whatnot', text: 'Whatnot', icon: '🟡' },
];
const CHANNEL_LABELS = {
  online: '🌐 En ligne',
  store: '🏬 Boutique',
  tiktok: `${TIKTOK_ICON} TikTok`,
  whatnot: '🟡 Whatnot',
  live: '🎥 Live',
  adjust: '🔧 Ajustement',
  return: '↩ Retour',
};
const PLATFORM_LABELS = { tiktok: `${TIKTOK_ICON} TikTok`, whatnot: '🟡 Whatnot' };
const MAPPING_FIELDS = [
  { key: 'sku', label: 'SKU / Référence' },
  { key: 'barcode', label: 'Code-barres (EAN)' },
  { key: 'variant_group', label: 'Groupe de variantes' },
  { key: 'brand', label: 'Marque' },
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
  if (res.status === 401 && data.auth_required) {
    showLogin();
    throw new Error('Connexion requise');
  }
  if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
  return data;
}

// ---------------------------------------------------------------------------
// Connexion (quand un mot de passe est défini)
// ---------------------------------------------------------------------------
function showLogin() {
  $('#loginOverlay').hidden = false;
  setTimeout(() => $('#loginPassword').focus(), 100);
}

document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#loginError').hidden = true;
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: $('#loginPassword').value }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Connexion impossible');
    location.reload();
  } catch (err) {
    $('#loginError').textContent = err.message;
    $('#loginError').hidden = false;
    $('#loginPassword').value = '';
    $('#loginPassword').focus();
  }
});

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
    if (btn.dataset.tab === 'import') loadBackup();
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
let hasGoogleKey = false; // API Google Custom Search (photos web)
let googleCx = '';

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
    $('#autoReport').checked = !!s.auto_report;
    hasGoogleKey = !!s.has_google_key;
    googleCx = s.google_cse_cx || '';
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

// Prix hors taxes à partir du prix TTC stocké et du taux de TVA configuré
const priceHt = (ttc) => ttc / (1 + vatRate / 100);

function productTags(p) {
  return `
    ${p.brand ? `<span class="tag tag-brand" title="Marque">${escapeHtml(p.brand)}</span>` : ''}
    ${p.category ? `<span class="tag tag-cat" title="Catégorie">${escapeHtml(p.category)}</span>` : ''}`;
}

function priceBlock(p) {
  if (!p.price) return '';
  return `
  <div class="price-block" title="Prix de vente conseillé — TVA ${vatRate} %">
    <span class="price-caption">Prix de vente conseillé</span>
    <span class="price-ht">${euro(priceHt(p.price))} <small>HT</small></span>
    <span class="price-ttc">${euro(p.price)} TTC</span>
  </div>`;
}

function productCard(p) {
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
          <div class="product-tags">${productTags(p)}</div>
          <div class="product-sku">${escapeHtml(p.sku || '')}${p.barcode ? ` · <span class="product-barcode" title="Code-barres">∥ ${escapeHtml(p.barcode)}</span>` : ''}${p.sold_30d ? ` · <span title="Ventes des 30 derniers jours">🔥 ${p.sold_30d} vendus/30 j</span>` : ''}</div>
        </div>
      </div>
      ${isLow(p) ? '<span class="badge-low">⚠ Stock bas</span>' : ''}
      <div class="stock-row big">
        <span class="chan">📦 Stock</span>
        <button onclick="adjust(${p.id}, -1)" title="Retirer 1 (correction)">−</button>
        <span class="qty ${p.stock <= 0 ? 'zero' : ''}">${p.stock}</span>
        <button onclick="adjust(${p.id}, 1)" title="Ajouter 1 (réassort)">+</button>
      </div>
      <div class="sale-row">${saleButtons}</div>
      <div class="card-footer">
        <button class="btn" onclick="openEdit(${p.id})">✏ Modifier</button>
        ${priceBlock(p)}
      </div>
    </div>
  </div>`;
}

// Nom de la variante sans le préfixe du groupe (« T-shirt logo — M » → « M »)
function variantLabel(p) {
  const g = p.variant_group.toLowerCase();
  let label = p.name;
  if (label.toLowerCase().startsWith(g)) label = label.slice(p.variant_group.length);
  label = label.replace(/^[\s—–\-·:,/]+/, '');
  return label || p.name;
}

function variantGroupCard(group, items) {
  const total = items.reduce((s, p) => s + p.stock, 0);
  const anyLow = items.some(isLow);
  const withPhoto = items.find((p) => p.photo);
  const photo = withPhoto
    ? `<img class="product-photo" src="${escapeHtml(withPhoto.photo)}" alt="" loading="lazy">`
    : `<div class="product-photo placeholder">📷</div>`;
  const prices = [...new Set(items.map((p) => p.price))];
  const priceTxt =
    prices.length === 1
      ? `${euro(priceHt(prices[0]))} <small>HT</small><span class="price-ttc">${euro(prices[0])} TTC</span>`
      : `${euro(priceHt(Math.min(...prices)))}–${euro(priceHt(Math.max(...prices)))} <small>HT</small>
         <span class="price-ttc">${euro(Math.min(...prices))}–${euro(Math.max(...prices))} TTC</span>`;
  const rows = items
    .map(
      (v) => `<div class="variant-row ${isLow(v) ? 'low' : ''}">
      <span class="variant-name" onclick="openEdit(${v.id})" title="${escapeHtml(v.name)}${v.sku ? ' · ' + escapeHtml(v.sku) : ''} — cliquer pour modifier">${escapeHtml(variantLabel(v))}${isLow(v) ? ' ⚠' : ''}</span>
      <button onclick="adjust(${v.id}, -1)" title="Retirer 1 (correction)">−</button>
      <span class="qty ${v.stock <= 0 ? 'zero' : ''}">${v.stock}</span>
      <button onclick="adjust(${v.id}, 1)" title="Ajouter 1 (réassort)">+</button>
      <span class="variant-sales">${SALE_CHANNELS.map(
        (c) => `<button class="sale-btn mini" onclick="sell(${v.id}, '${c.key}')" ${v.stock <= 0 ? 'disabled' : ''}
          title="Vendre 1 ${escapeHtml(variantLabel(v))} (${c.text})">${c.icon}</button>`
      ).join('')}</span>
    </div>`
    )
    .join('');
  return `
  <div class="product-card group-card ${anyLow ? 'low' : ''}">
    ${photo}
    <div class="product-body">
      <div class="product-head">
        <div>
          <div class="product-name">${escapeHtml(group)}</div>
          <div class="product-tags">${productTags(items[0])}</div>
          <div class="product-sku">${items.length} variantes · 📦 ${total} au total</div>
        </div>
        <div class="product-price">${priceTxt}</div>
      </div>
      ${anyLow ? '<span class="badge-low">⚠ Stock bas sur une variante</span>' : ''}
      <div class="variant-list">${rows}</div>
    </div>
  </div>`;
}

// Alimente les listes déroulantes Marque / Catégorie (en conservant la sélection)
function fillFilterOptions() {
  const fill = (sel, values, label) => {
    const current = sel.value;
    sel.innerHTML =
      `<option value="">${label}</option>` +
      values.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
    if (values.includes(current)) sel.value = current;
  };
  fill($('#filterBrand'), [...new Set(products.map((p) => p.brand).filter(Boolean))].sort((a, b) => a.localeCompare(b)), 'Toutes les marques');
  fill($('#filterCategory'), [...new Set(products.map((p) => p.category).filter(Boolean))].sort((a, b) => a.localeCompare(b)), 'Toutes les catégories');
}

const SORTS = {
  name: (a, b) => a.name.localeCompare(b.name),
  best: (a, b) => (b.sold_30d || 0) - (a.sold_30d || 0) || a.name.localeCompare(b.name),
  price_desc: (a, b) => b.price - a.price,
  price_asc: (a, b) => a.price - b.price,
  stock_asc: (a, b) => a.stock - b.stock,
  stock_desc: (a, b) => b.stock - a.stock,
};

function renderProducts() {
  const lowOnly = $('#lowOnly').checked;
  const brand = $('#filterBrand').value;
  const cat = $('#filterCategory').value;
  fillFilterOptions();
  let list = products.filter(
    (p) => (!lowOnly || isLow(p)) && (!brand || p.brand === brand) && (!cat || p.category === cat)
  );
  list = [...list].sort(SORTS[$('#sortBy').value] || SORTS.name);
  $('#emptyMsg').hidden = list.length > 0;

  // Regroupe les variantes (même variant_group) en une seule carte, à la
  // position de la première variante rencontrée
  const entries = [];
  const groupIndex = new Map();
  for (const p of list) {
    if (p.variant_group) {
      if (groupIndex.has(p.variant_group)) {
        groupIndex.get(p.variant_group).items.push(p);
      } else {
        const entry = { group: p.variant_group, items: [p] };
        groupIndex.set(p.variant_group, entry);
        entries.push(entry);
      }
    } else {
      entries.push({ single: p });
    }
  }
  $('#productList').innerHTML = entries
    .map((e) => (e.single ? productCard(e.single) : variantGroupCard(e.group, e.items)))
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
$('#filterBrand').addEventListener('change', renderProducts);
$('#filterCategory').addEventListener('change', renderProducts);
$('#sortBy').addEventListener('change', renderProducts);

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
          (p.brand || '').toLowerCase().includes(q) ||
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
let giftLiveId = null; // live ciblé depuis le détail (null = live en cours)

window.openGiftPicker = (saleNo, liveId = null) => {
  giftForSaleNo = saleNo;
  giftLiveId = liveId;
  $('#giftTitle').textContent = `🎁 Ajouter un cadeau à la vente #${saleNo}`;
  $('#giftSearch').value = '';
  renderGiftResults();
  $('#giftModal').hidden = false;
  setTimeout(() => $('#giftSearch').focus(), 100);
};

function closeGiftPicker() {
  const fromDetail = giftLiveId;
  giftForSaleNo = null;
  giftLiveId = null;
  $('#giftModal').hidden = true;
  if (fromDetail) {
    // Cadeau(x) ajouté(s) depuis le détail d'un live : on rafraîchit l'affichage
    loadLives().then(() => showLiveDetail(fromDetail));
  } else if (liveSession) {
    setTimeout(() => $('#liveSearch').focus(), 100);
  }
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
  const targetLiveId = giftLiveId || (liveSession && liveSession.id);
  if (!targetLiveId || giftForSaleNo == null) return;
  const p = products.find((x) => x.id === productId);
  try {
    const result = await api(`/api/lives/${targetLiveId}/gift`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sale_no: giftForSaleNo, product_id: productId }),
    });
    updateLocalProduct(result.product);
    if (!giftLiveId) {
      // Cadeau pendant le live en cours : mise à jour du journal à l'écran
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
      renderLiveResults();
      renderLiveSales();
      updateLiveCounters();
    }
    renderProducts();
    renderGiftResults();
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
    document.querySelector('#recapModal h2').textContent = '🏁 Live terminé !';
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
  refunded: '<span class="pay-badge failed">↩ remboursé</span>',
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
    const valid = l.sales.filter((m) => !m.cancelled && m.payment_status !== 'refunded');

    // Récap des produits vendus (agrégé) — les cadeaux sur une ligne à part
    const byProduct = new Map();
    for (const m of valid) {
      const key = `${m.product_id}-${m.is_gift ? 'gift' : 'sale'}`;
      const e = byProduct.get(key) || {
        name: m.product_name, sku: m.product_sku, isGift: !!m.is_gift, qty: 0, total: 0, margin: 0,
      };
      e.qty += 1;
      e.total += m.sold_price != null ? m.sold_price : m.product_price;
      e.margin += saleMargin(m) - (m.shipping_cost || 0);
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
            const refunded = m.payment_status === 'refunded';
            const margin = saleMargin(m) - (m.shipping_cost || 0);
            const failed = m.payment_status === 'failed' && !m.cancelled;
            return `<tr class="${m.cancelled ? 'row-cancelled' : ''} ${failed || refunded ? 'row-unpaid' : ''}">
          <td>${!m.is_gift && !m.cancelled && m.sale_no
            ? `<button class="live-gift-btn" onclick="openGiftPicker(${m.sale_no}, ${l.id})" title="Ajouter un cadeau à la vente #${m.sale_no}">🎁</button>`
            : ''}<strong>${m.is_gift ? '🎁 ' : ''}${m.sale_no ? '#' + m.sale_no : ''}</strong></td>
          <td>${timeFr(m.created_at)}</td>
          <td>${m.photo ? `<a href="${escapeHtml(m.photo)}" target="_blank" rel="noopener"><img class="sale-photo-thumb" src="${escapeHtml(m.photo)}" alt=""></a> ` : ''}${escapeHtml(m.product_name)}${m.product_sku ? ` <span class="product-sku">(${escapeHtml(m.product_sku)})</span>` : ''}</td>
          <td>${euro(m.product_price)}</td>
          <td>${m.is_gift ? '<span class="muted-cell">offert</span>' : m.sold_price != null ? `<strong>${euro(m.sold_price)}</strong>` : '<span class="muted-cell">—</span>'}</td>
          <td>${m.is_gift
            ? '<span class="muted-cell">—</span>'
            : saleNetIsEstimated(m)
              ? `<span class="muted-cell" title="Estimation avec le barème de frais — importez le rapport pour la valeur exacte">≈ ${euro(saleNet(m))}</span>`
              : `<strong>${euro(saleNet(m))}</strong>`}</td>
          <td>${m.is_gift || m.cancelled || refunded
            ? '<span class="muted-cell">—</span>'
            : `<input class="ship-input" type="number" step="any" min="0" value="${m.shipping_cost != null ? m.shipping_cost : ''}"
                 placeholder="0" title="Frais d'envoi et d'emballage payés par vous pour cette vente (déduits de la marge)"
                 onchange="setShipping(${m.id}, ${l.id}, this.value)">`}</td>
          <td class="${margin >= 0 ? 'delta-pos' : 'delta-neg'}">${m.cancelled || failed || refunded ? '' : euro(margin)}</td>
          <td>${m.payment_status && !m.is_gift ? PAYMENT_LABELS[m.payment_status] || m.payment_status : '<span class="muted-cell">—</span>'}</td>
          <td>${m.cancelled
            ? (m.is_gift ? 'annulé' : 'annulée')
            : refunded
              ? 'retour fait'
              : m.is_gift
                ? 'cadeau'
                : failed
                  ? `<button class="btn small" onclick="liveRestock(${m.id}, ${l.id})" title="Annuler la vente et remettre l'article en stock">↩ Restock</button>`
                  : `vendue <button class="btn small ghost-mini" onclick="returnLiveSale(${m.id}, ${l.id})" title="Retour / remboursement : l'article revient en stock, la vente est retirée du CA et de la marge">↩</button>`}</td>
        </tr>`;
          })
          .join('')
      : '<tr><td colspan="10">Aucune vente pendant ce live</td></tr>';

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
      <h3>${PLATFORM_LABELS[l.platform]} — ${dateFr(l.started_at)}
        ${l.ended_at ? `<button class="btn small" onclick="editLive(${l.id})" title="Changer la plateforme, la date ou les horaires — les heures des ventes suivent le décalage">✏ Modifier ce live</button>` : ''}</h3>
      ${statusBlock}
      <div class="recap-grid wide">
        <div class="stat"><div class="value">${l.items}</div><div class="label">Articles vendus</div></div>
        <div class="stat"><div class="value">${l.gifts}</div><div class="label">🎁 Cadeaux offerts</div></div>
        <div class="stat"><div class="value">${euro(l.revenue)}</div><div class="label">CA TTC${l.reported > 0 ? ' (réel)' : ' (catalogue)'}</div></div>
        <div class="stat"><div class="value">${euro(ht)}</div><div class="label">CA HT</div></div>
        <div class="stat"><div class="value">${euro(l.revenue - ht)}</div><div class="label">TVA collectée (${vatRate} %)</div></div>
        <div class="stat"><div class="value">${euro(l.margin)}</div><div class="label">Marge nette estimée${l.shipping > 0 ? ` (envoi −${euro(l.shipping)})` : ''}</div></div>
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
        <p class="muted small">Vous avez les photos des produits vendus avec leur étiquette #numéro ?
          <button class="btn small" onclick="openPhotoSales(${l.id})">📸 Importer les photos de ce live</button></p>
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
          <thead><tr><th>N°</th><th>Heure</th><th>Produit</th><th>Prix catalogue</th><th>Prix vendu</th><th>Gains nets</th><th title="Frais d'envoi et d'emballage payés par vous, déduits de la marge">📮 Envoi</th><th>Marge</th><th>Paiement</th><th>Statut</th></tr></thead>
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

// Frais d'envoi d'une vente (saisis dans le détail du live)
window.setShipping = async (movementId, liveId, value) => {
  try {
    await api(`/api/movements/${movementId}/shipping`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shipping_cost: value === '' ? null : value }),
    });
    toast('📮 Frais d\'envoi enregistrés');
    await loadLives();
    await showLiveDetail(liveId);
  } catch (e) {
    toast(e.message, true);
  }
};

// Retour / remboursement d'une vente de live
window.returnLiveSale = async (movementId, liveId) => {
  if (!confirm('Enregistrer un retour ? L’article revient en stock et la vente est retirée du chiffre d’affaires et de la marge.')) return;
  try {
    await api(`/api/movements/${movementId}/return`, { method: 'POST' });
    toast('↩ Retour enregistré, article remis en stock');
    await loadLives();
    await showLiveDetail(liveId);
    loadProducts();
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
    loadLiveSlots();
  } catch (e) {
    toast(e.message, true);
  }
}

$('#statsDays').addEventListener('change', loadStatsPage);
$('#statsChannel').addEventListener('change', renderStatsTable);
$('#slotPlatform').addEventListener('change', loadLiveSlots);

// ---- Meilleurs créneaux de live ----
const DOW_FR = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];

function slotBars(rows, labelOf, valueOf, subOf) {
  const max = Math.max(...rows.map(valueOf), 0.01);
  return rows
    .map((r) => {
      const v = valueOf(r);
      return `<div class="slot-bar-row">
      <span class="slot-label">${labelOf(r)}</span>
      <div class="slot-bar-track"><div class="slot-bar" style="width:${Math.max(3, (v / max) * 100)}%"></div></div>
      <span class="slot-value">${euro(v)}<small>${subOf(r)}</small></span>
    </div>`;
    })
    .join('');
}

async function loadLiveSlots() {
  try {
    const platform = $('#slotPlatform').value;
    const data = await api(`/api/statistics/lives${platform ? `?platform=${platform}` : ''}`);
    if (!data.total_lives) {
      $('#liveSlots').innerHTML = '<p class="empty">Pas encore de live terminé avec des ventes — les statistiques apparaîtront ici.</p>';
      return;
    }
    const weekdays = [...data.by_weekday].sort((a, b) => b.revenue / b.lives - a.revenue / a.lives);
    const hours = [...data.by_hour].sort((a, b) => b.revenue / b.lives - a.revenue / a.lives);
    const curveMax = Math.max(...data.curve.map((c) => c.avg), 0.01);
    $('#liveSlots').innerHTML = `
      <div class="slots-grid">
        <div>
          <h4>📅 CA moyen par jour de live</h4>
          ${slotBars(weekdays, (w) => DOW_FR[w.dow], (w) => w.revenue / w.lives, (w) => `${w.lives} live(s) · marge ${euro(w.margin / w.lives)}`)}
        </div>
        <div>
          <h4>🕐 CA moyen par heure de début</h4>
          ${slotBars(hours, (h) => `${String(h.hour).padStart(2, '0')} h`, (h) => h.revenue / h.lives, (h) => `${h.lives} live(s)`)}
        </div>
      </div>
      <h4>⏱ Rythme des ventes pendant le live <span class="muted small">(CA moyen par tranche de 15 min — repérez le moment où ça s'essouffle)</span></h4>
      <div class="slot-curve">
        ${data.curve
          .map(
            (c) => `<div class="slot-col" title="${c.from}–${c.to} min : ${euro(c.avg)} en moyenne (${c.lives} live(s) concernés)">
            <div class="slot-col-bar" style="height:${Math.max(4, (c.avg / curveMax) * 100)}%"></div>
            <span class="slot-col-label">${c.from}′</span>
          </div>`
          )
          .join('')}
      </div>
      <p class="muted small">Basé sur ${data.total_lives} live(s) terminé(s). Le meilleur créneau combine un bon CA moyen et assez de lives pour être fiable.</p>`;
  } catch (e) {
    $('#liveSlots').innerHTML = `<p class="empty">${escapeHtml(e.message)}</p>`;
  }
}

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
  $('#aiReportInfo').textContent = `Dernier rapport : ${dateFr(r.generated_at)}${r.auto ? ' (généré automatiquement)' : ''}`;
  $('#aiReport').innerHTML = mdToHtml(r.report);
  $('#aiReport').hidden = false;
}

$('#autoReport').addEventListener('change', async (e) => {
  try {
    await api('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ auto_report: e.target.checked }),
    });
    toast(e.target.checked
      ? '🤖 Rapport automatique activé — généré chaque matin après 7 h (app ouverte)'
      : 'Rapport automatique désactivé');
  } catch (err) {
    toast(err.message, true);
  }
});

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

window.saveApiKey = async () => {
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
    refreshPhotoSalesUi();
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

// ---- Créer un live passé / modifier un live existant ----
let editingLiveId = null; // null = création

const timeFrShort = (iso) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

function openLiveEditor(live = null) {
  editingLiveId = live ? live.id : null;
  $('#liveEditTitle').textContent = live ? '✏ Modifier ce live' : '➕ Ajouter un live passé';
  $('#liveEditHint').hidden = !!live;
  $('#leplatform').value = live ? live.platform : 'tiktok';
  $('#leDate').value = (live ? new Date(live.started_at) : new Date()).toLocaleDateString('sv-SE');
  $('#leStart').value = live ? timeFrShort(live.started_at) : '20:00';
  $('#leEnd').value = live && live.ended_at ? timeFrShort(live.ended_at) : '22:00';
  $('#liveEditModal').hidden = false;
}

$('#btnAddPastLive').addEventListener('click', () => openLiveEditor());
$('#btnCloseLiveEdit').addEventListener('click', () => { $('#liveEditModal').hidden = true; });

window.editLive = async (id) => {
  try {
    openLiveEditor(await api(`/api/lives/${id}`));
  } catch (e) {
    toast(e.message, true);
  }
};

$('#btnLiveEditSave').addEventListener('click', async () => {
  const date = $('#leDate').value;
  const start = $('#leStart').value;
  const end = $('#leEnd').value;
  if (!date || !start || !end) return toast('Renseignez la date et les horaires', true);
  const started = new Date(`${date}T${start}`);
  let ended = new Date(`${date}T${end}`);
  if (ended <= started) ended = new Date(ended.getTime() + 24 * 3600 * 1000); // fin après minuit
  const body = {
    platform: $('#leplatform').value,
    started_at: started.toISOString(),
    ended_at: ended.toISOString(),
  };
  try {
    const live = editingLiveId
      ? await api(`/api/lives/${editingLiveId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      : await api('/api/lives', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
    $('#liveEditModal').hidden = true;
    toast(editingLiveId ? '✏ Live modifié' : `✅ Live du ${dateFr(live.started_at)} créé`);
    await loadLives();
    await showLiveDetail(live.id);
    loadStats();
  } catch (e) {
    toast(e.message, true);
  }
});

// ---- Modale « Ventes par photos » : choix / création du live, puis analyse ----
let psLives = []; // lives proposés dans le sélecteur

function refreshPhotoSalesUi() {
  const setup = $('#psKeySetup');
  setup.querySelector('summary').textContent = hasApiKey
    ? '🔑 Clé API Anthropic — configurée ✓'
    : '🔑 Clé API Anthropic — requise pour l’analyse';
  setup.open = !hasApiKey;
  $('#btnPsPhotos').disabled = !hasApiKey;
  $('#btnPsPhotos').title = hasApiKey ? '' : 'Enregistrez d’abord votre clé API';
  $('#visionModel').value = visionModel;
}

window.openPhotoSales = async (preselectId = null) => {
  try {
    psLives = (await api('/api/lives')).filter((l) => l.ended_at).slice(0, 30);
  } catch (e) {
    psLives = [];
  }
  $('#psLive').innerHTML = psLives.length
    ? psLives
        .map(
          (l) => `<option value="${l.id}" ${preselectId === l.id ? 'selected' : ''}>
            ${dateFr(l.started_at)} — ${l.platform === 'tiktok' ? 'TikTok' : 'Whatnot'} (${l.items} article${l.items > 1 ? 's' : ''})
          </option>`
        )
        .join('')
    : '<option value="">— aucun live : créez-le ci-contre —</option>';
  $('#psCreate').hidden = psLives.length > 0;
  $('#psDate').value = new Date().toLocaleDateString('sv-SE');
  $('#photoReview').hidden = true;
  $('#photoProgress').hidden = true;
  photoAnalysis = null;
  refreshPhotoSalesUi();
  $('#photoSalesModal').hidden = false;
};

$('#btnPhotoSales').addEventListener('click', () => openPhotoSales());
$('#btnClosePhotoSales').addEventListener('click', () => { $('#photoSalesModal').hidden = true; });
$('#btnPsNewLive').addEventListener('click', () => { $('#psCreate').hidden = !$('#psCreate').hidden; });

// Création d'un live passé (oublié) avec sa vraie date et ses horaires
$('#btnPsCreateLive').addEventListener('click', async () => {
  const date = $('#psDate').value;
  const start = $('#psStart').value;
  const end = $('#psEnd').value;
  if (!date || !start || !end) return toast('Renseignez la date et les horaires', true);
  // Un live peut finir après minuit : si l'heure de fin est avant celle de
  // début, elle est comptée le lendemain
  const started = new Date(`${date}T${start}`);
  let ended = new Date(`${date}T${end}`);
  if (ended <= started) ended = new Date(ended.getTime() + 24 * 3600 * 1000);
  try {
    const live = await api('/api/lives', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        platform: $('#psPlatform').value,
        started_at: started.toISOString(),
        ended_at: ended.toISOString(),
      }),
    });
    toast(`✅ Live du ${dateFr(live.started_at)} créé`);
    await loadLives();
    await openPhotoSales(live.id);
  } catch (e) {
    toast(e.message, true);
  }
});

$('#btnPsPhotos').addEventListener('click', () => {
  if (!Number($('#psLive').value)) return toast('Choisissez ou créez d’abord le live concerné', true);
  $('#livePhotos').click();
});
$('#livePhotos').addEventListener('change', function () {
  const liveId = Number($('#psLive').value);
  if (liveId) analyzeLivePhotos(liveId, this.files);
});

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
    $('#photoSalesModal').hidden = true;
    await loadProducts();
    await loadLives();
    document.querySelector('[data-tab=lives]').click();
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
  // Suggestions basées sur l'existant (groupes de variantes, marques, catégories)
  const datalist = (id, values) => {
    $(id).innerHTML = [...new Set(values.filter(Boolean))].map((v) => `<option value="${escapeHtml(v)}">`).join('');
  };
  datalist('#variantGroups', products.map((p) => p.variant_group));
  datalist('#brandList', products.map((p) => p.brand));
  datalist('#categoryList', products.map((p) => p.category));
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
  form.variant_group.value = p.variant_group || '';
  form.brand.value = p.brand || '';
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
let movPage = 1;

async function loadMovements() {
  const params = new URLSearchParams();
  const q = $('#movSearch').value.trim();
  if (q) params.set('q', q);
  if ($('#movChannel').value) params.set('channel', $('#movChannel').value);
  if ($('#movDays').value) params.set('days', $('#movDays').value);
  params.set('page', movPage);
  const data = await api('/api/movements?' + params);
  movPage = data.page;
  $('#movPageInfo').textContent = data.total
    ? `Page ${data.page} / ${data.pages} — ${data.total} mouvement(s)`
    : '';
  $('#movPrev').disabled = data.page <= 1;
  $('#movNext').disabled = data.page >= data.pages;
  const canReturn = (m) =>
    m.delta < 0 && !m.cancelled && !m.is_gift &&
    !['adjust', 'return'].includes(m.channel) && m.payment_status !== 'refunded';
  $('#movementsTable tbody').innerHTML = data.rows.length
    ? data.rows
        .map(
          (m) => `<tr class="${m.cancelled ? 'row-cancelled' : ''}">
        <td>${dateFr(m.created_at)}</td>
        <td>${escapeHtml(m.product_name)}${m.product_sku ? ` <span class="product-sku">(${escapeHtml(m.product_sku)})</span>` : ''}</td>
        <td>${CHANNEL_LABELS[m.channel] || m.channel}${m.sale_no ? ` <span class="product-sku">#${m.sale_no}</span>` : ''}</td>
        <td class="${m.delta > 0 ? 'delta-pos' : 'delta-neg'}">${m.delta > 0 ? '+' : ''}${m.delta}</td>
        <td>${m.stock_after}</td>
        <td>${escapeHtml(m.reason)}${m.payment_status === 'refunded' ? ' <span class="pay-badge failed">↩ remboursé</span>' : ''}</td>
        <td>${canReturn(m) ? `<button class="btn small" onclick="returnSale(${m.id})" title="Retour / remboursement : l'article revient en stock, la vente est retirée du CA et de la marge">↩ Retour</button>` : ''}</td>
      </tr>`
        )
        .join('')
    : '<tr><td colspan="7">Aucun mouvement trouvé</td></tr>';
}

window.returnSale = async (id) => {
  if (!confirm('Enregistrer un retour ? L’article revient en stock et la vente est retirée du chiffre d’affaires et de la marge.')) return;
  try {
    await api(`/api/movements/${id}/return`, { method: 'POST' });
    toast('↩ Retour enregistré, article remis en stock');
    loadMovements();
    loadProducts();
  } catch (e) {
    toast(e.message, true);
  }
};

let movSearchTimer;
$('#movSearch').addEventListener('input', () => {
  clearTimeout(movSearchTimer);
  movSearchTimer = setTimeout(() => { movPage = 1; loadMovements(); }, 250);
});
$('#movChannel').addEventListener('change', () => { movPage = 1; loadMovements(); });
$('#movDays').addEventListener('change', () => { movPage = 1; loadMovements(); });
$('#movPrev').addEventListener('click', () => { movPage--; loadMovements(); });
$('#movNext').addEventListener('click', () => { movPage++; loadMovements(); });

// ---------------------------------------------------------------------------
// Sauvegarde automatique (dossier au choix, quotidienne, restauration)
// ---------------------------------------------------------------------------
function renderBackup(data) {
  $('#backupDir').value = data.dir || '';
  $('#backupStatus').innerHTML = data.dir
    ? data.last_backup
      ? `✅ Dernière sauvegarde : <strong>${dateFr(data.last_backup)}</strong>`
      : '⏳ Première sauvegarde dans quelques secondes…'
    : '⚠ Aucun dossier configuré : <strong>vos données ne sont pas sauvegardées</strong>.';
  $('#backupList').innerHTML = data.backups && data.backups.length
    ? `<div class="table-wrap"><table>
        <thead><tr><th>Sauvegarde</th><th>Base</th><th></th></tr></thead>
        <tbody>${data.backups
          .map(
            (b) => `<tr>
          <td>📁 ${escapeHtml(b.date)}</td>
          <td>${(b.size / 1024).toFixed(0)} Ko</td>
          <td><button class="btn small" onclick="restoreBackup('${escapeHtml(b.name)}')" title="Remplace la base et les photos actuelles par cette sauvegarde">↩ Restaurer</button></td>
        </tr>`
          )
          .join('')}</tbody></table></div>`
    : '';
}

async function loadBackup() {
  try {
    renderBackup(await api('/api/backup'));
  } catch (e) {
    /* pas bloquant */
  }
  loadSecurity();
}

// ---- Carte « Protection par mot de passe » ----
async function loadSecurity() {
  try {
    const st = await fetch('/api/auth/status').then((r) => r.json());
    $('#secStatus').innerHTML = st.protected
      ? '✅ L\'application est <strong>protégée par un mot de passe</strong>. Votre clé API est chiffrée dans la base.'
      : '⚠ Aucun mot de passe : toute personne pouvant ouvrir cette page a accès à tout.';
    $('#secCurrentWrap').hidden = !st.protected;
    $('#btnLogout').hidden = !st.protected;
  } catch (e) {
    /* pas bloquant */
  }
}

$('#btnSavePassword').addEventListener('click', async () => {
  const newPass = $('#secNew').value;
  if (!newPass && !confirm('Retirer la protection par mot de passe ?')) return;
  try {
    const r = await api('/api/auth/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current_password: $('#secCurrent').value, new_password: newPass }),
    });
    $('#secCurrent').value = '';
    $('#secNew').value = '';
    toast(r.protected ? '🔒 Mot de passe enregistré — les autres appareils devront se reconnecter' : 'Protection retirée');
    loadSecurity();
  } catch (e) {
    toast(e.message, true);
  }
});

$('#btnLogout').addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  location.reload();
});

$('#btnSaveBackupDir').addEventListener('click', async () => {
  try {
    const data = await api('/api/backup', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir: $('#backupDir').value.trim() }),
    });
    renderBackup(data);
    toast(data.dir ? '💾 Dossier de sauvegarde enregistré' : 'Sauvegarde désactivée');
  } catch (e) {
    toast(e.message, true);
  }
});

$('#btnBackupNow').addEventListener('click', async () => {
  const btn = $('#btnBackupNow');
  btn.disabled = true;
  try {
    await api('/api/backup/run', { method: 'POST' });
    await loadBackup();
    toast('💾 Sauvegarde effectuée');
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
  }
});

window.restoreBackup = async (name) => {
  if (!confirm(`Restaurer la sauvegarde du ${name.replace('sauvegarde-', '')} ?\n\nVos données ACTUELLES (base + photos) seront remplacées par cette sauvegarde. L'application s'arrêtera ensuite : relancez-la avec npm start.`)) return;
  try {
    const r = await api('/api/backup/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    document.body.innerHTML = `<div class="restore-done"><h1>✅ ${escapeHtml(r.message)}</h1>
      <p>Retournez dans le Terminal et relancez <code>npm start</code>, puis rechargez cette page.</p></div>`;
  } catch (e) {
    toast(e.message, true);
  }
};

// ---------------------------------------------------------------------------
// Photos depuis le web : recherche marque + référence + nom, validation
// par l'utilisateur, puis téléchargement des images choisies
// ---------------------------------------------------------------------------
const wpChoices = new Map(); // product_id -> url choisie (absent = ignoré)
let wpSearching = false;
let wpProducts = []; // liste COMPLÈTE (indépendante du filtre de recherche en cours)

function wpEngineStatus() {
  if (hasGoogleKey && googleCx) {
    $('#wpEngineStatus').innerHTML = '<span class="delta-pos">API Google officielle ✓</span>';
    $('#wpEngineSetup').open = false;
  } else {
    $('#wpEngineStatus').innerHTML = '<span class="delta-neg">non configuré — résultats peu fiables (Bing/DuckDuckGo)</span>';
    $('#wpEngineSetup').open = true;
  }
  $('#wpGoogleCx').value = googleCx;
}

$('#btnWebPhotos').addEventListener('click', async () => {
  wpChoices.clear();
  $('#wpResults').innerHTML = '';
  $('#wpProgress').hidden = true;
  $('#btnWpApply').hidden = true;
  $('#wpCount').textContent = '';
  try {
    wpProducts = await api('/api/products');
  } catch (e) {
    wpProducts = products;
  }
  const missing = wpProducts.filter((p) => !p.photo).length;
  $('#wpInfo').textContent = `${missing} produit(s) sans photo sur ${wpProducts.length}.`;
  wpEngineStatus();
  $('#webPhotosModal').hidden = false;
});

$('#btnWpSaveEngine').addEventListener('click', async () => {
  const key = $('#wpGoogleKey').value.trim();
  const cx = $('#wpGoogleCx').value.trim();
  try {
    const s = await api('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...(key ? { google_cse_key: key } : {}), google_cse_cx: cx }),
    });
    hasGoogleKey = !!s.has_google_key;
    googleCx = s.google_cse_cx || '';
    $('#wpGoogleKey').value = '';
    wpEngineStatus();
    toast(hasGoogleKey && googleCx ? '✅ API Google configurée' : 'Configuration enregistrée (incomplète)');
  } catch (e) {
    toast(e.message, true);
  }
});
$('#btnCloseWebPhotos').addEventListener('click', () => {
  $('#webPhotosModal').hidden = true;
  wpSearching = false;
});

function wpUpdateCount() {
  $('#wpCount').textContent = `${wpChoices.size} photo(s) sélectionnée(s)`;
  $('#btnWpApply').hidden = wpChoices.size === 0;
}

window.wpSelect = (id, url, el) => {
  const row = el.closest('.wp-row');
  row.querySelectorAll('.wp-thumb').forEach((t) => t.classList.remove('selected'));
  if (url) {
    wpChoices.set(id, url);
    el.classList.add('selected');
  } else {
    wpChoices.delete(id);
  }
  wpUpdateCount();
};

$('#btnWpSearch').addEventListener('click', async () => {
  if (wpSearching) return;
  const includeExisting = $('#wpIncludeExisting').checked;
  const targets = wpProducts.filter((p) => includeExisting || !p.photo);
  if (!targets.length) return toast('Tous les produits ont déjà une photo 🎉');
  wpSearching = true;
  $('#btnWpSearch').disabled = true;
  $('#wpResults').innerHTML = '';
  wpChoices.clear();
  wpUpdateCount();
  const progress = $('#wpProgress');
  progress.hidden = false;
  let done = 0;
  try {
    for (let i = 0; i < targets.length && wpSearching; i += 6) {
      const batch = targets.slice(i, i + 6);
      progress.textContent = `🔎 Recherche ${done + 1}–${Math.min(done + batch.length, targets.length)} sur ${targets.length}…`;
      const data = await api('/api/photos/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: batch.map((p) => p.id) }),
      });
      for (const r of data.results) {
        const p = wpProducts.find((x) => x.id === r.id);
        if (!p) continue;
        const thumbs = r.candidates
          .map(
            (c, idx) => `<img class="wp-thumb ${idx === 0 ? 'selected' : ''}" src="${escapeHtml(c.thumb)}"
              loading="lazy" referrerpolicy="no-referrer" alt=""
              onerror="this.remove()"
              onclick="wpSelect(${r.id}, '${escapeHtml(c.full).replace(/'/g, '&#39;')}', this)">`
          )
          .join('');
        if (r.candidates.length) wpChoices.set(r.id, r.candidates[0].full);
        $('#wpResults').insertAdjacentHTML(
          'beforeend',
          `<div class="wp-row">
            <div class="wp-product">
              <strong>${escapeHtml(p.name)}</strong>
              <span class="product-sku">${escapeHtml(p.category || '')} ${escapeHtml(p.sku || '')}</span>
              ${r.error ? `<span class="pay-badge failed">⚠ ${escapeHtml(r.error)}</span>` : ''}
              ${!r.error && !r.candidates.length ? '<span class="muted small">aucune image trouvée</span>' : ''}
            </div>
            <div class="wp-thumbs">${thumbs}
              ${r.candidates.length ? `<button class="wp-skip" title="Ignorer ce produit" onclick="wpSelect(${r.id}, null, this)">🚫</button>` : ''}
            </div>
          </div>`
        );
      }
      done += batch.length;
      wpUpdateCount();
      // Erreur globale du moteur (quota Google, clé invalide…) : on arrête
      // au lieu de répéter la même erreur sur chaque produit
      const errs = data.results.filter((r) => r.error);
      if (errs.length === data.results.length && errs.length && /google|quota/i.test(errs[0].error)) {
        toast(errs[0].error, true);
        break;
      }
    }
  } catch (e) {
    toast(e.message, true);
  }
  progress.textContent = wpSearching ? '✅ Recherche terminée — vérifiez les images puis validez.' : '';
  wpSearching = false;
  $('#btnWpSearch').disabled = false;
});

$('#btnWpApply').addEventListener('click', async () => {
  const choices = [...wpChoices].map(([id, url]) => ({ id, url }));
  if (!choices.length) return;
  const btn = $('#btnWpApply');
  btn.disabled = true;
  const progress = $('#wpProgress');
  progress.hidden = false;
  let assigned = 0;
  const failed = [];
  try {
    for (let i = 0; i < choices.length; i += 15) {
      progress.textContent = `⬇ Téléchargement ${i + 1}–${Math.min(i + 15, choices.length)} sur ${choices.length}…`;
      const r = await api('/api/photos/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ choices: choices.slice(i, i + 15) }),
      });
      assigned += r.assigned;
      failed.push(...r.failed);
    }
    let msg = `🖼 ${assigned} photo(s) assignée(s)`;
    if (failed.length) msg += ` — ${failed.length} échec(s) : ${failed.slice(0, 3).map((f) => f.name).join(', ')}${failed.length > 3 ? '…' : ''}`;
    toast(msg, failed.length > 0 && assigned === 0);
    $('#webPhotosModal').hidden = true;
    await loadProducts();
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
    progress.hidden = true;
  }
});

// ---------------------------------------------------------------------------
// Mode inventaire : comptage physique (saisie ou scan de codes-barres),
// puis recalage du stock avec rapport des écarts
// ---------------------------------------------------------------------------
const invCounts = new Map(); // product_id -> quantité comptée

function openInventory() {
  invCounts.clear();
  $('#invSearch').value = '';
  renderInventory();
  $('#inventoryModal').hidden = false;
  $('#invSearch').focus();
}

function renderInventory() {
  const q = $('#invSearch').value.trim().toLowerCase();
  const list = q
    ? products.filter(
        (p) =>
          (p.sku || '').toLowerCase().includes(q) ||
          (p.barcode || '').includes(q) ||
          p.name.toLowerCase().includes(q) ||
          (p.category || '').toLowerCase().includes(q)
      )
    : products;
  $('#invList').innerHTML = list.length
    ? list
        .map((p) => {
          const counted = invCounts.get(p.id);
          const done = counted !== undefined;
          const diff = done ? counted - p.stock : 0;
          return `<div class="inv-row ${done ? 'counted' : ''}">
        ${p.photo ? `<img class="inv-photo" src="${escapeHtml(p.photo)}" alt="">` : '<div class="inv-photo placeholder">📷</div>'}
        <div class="inv-info">
          <strong>${escapeHtml(p.name)}</strong>
          <span class="product-sku">${escapeHtml(p.sku || '')}${p.barcode ? ` · ∥ ${escapeHtml(p.barcode)}` : ''}</span>
        </div>
        <span class="inv-stock" title="Stock théorique dans l'app">app : ${p.stock}</span>
        <input class="inv-input" type="number" min="0" inputmode="numeric" placeholder="—"
          value="${done ? counted : ''}" onchange="invSet(${p.id}, this.value)">
        ${done ? `<span class="inv-diff ${diff === 0 ? 'ok' : 'ko'}">${diff === 0 ? '✓' : (diff > 0 ? '+' : '') + diff}</span>` : '<span class="inv-diff"></span>'}
      </div>`;
        })
        .join('')
    : '<p class="empty">Aucun produit ne correspond</p>';
  $('#invCount').textContent = invCounts.size
    ? `${invCounts.size} produit(s) compté(s) · ${[...invCounts].filter(([id, c]) => {
        const p = products.find((x) => x.id === id);
        return p && c !== p.stock;
      }).length} écart(s)`
    : 'Aucun produit compté pour l’instant';
}

window.invSet = (id, value) => {
  if (value === '') invCounts.delete(id);
  else invCounts.set(id, Math.max(0, parseInt(value, 10) || 0));
  renderInventory();
};

// Scan douchette : le code tapé + Entrée → +1 au comptage du produit
$('#invSearch').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const q = $('#invSearch').value.trim().toLowerCase();
  if (!q) return;
  const exact = products.find(
    (p) => (p.barcode || '').toLowerCase() === q || (p.sku || '').toLowerCase() === q
  );
  const candidates = exact
    ? [exact]
    : products.filter(
        (p) =>
          (p.sku || '').toLowerCase().includes(q) ||
          (p.barcode || '').includes(q) ||
          p.name.toLowerCase().includes(q)
      );
  if (candidates.length === 1) {
    const p = candidates[0];
    invCounts.set(p.id, (invCounts.get(p.id) || 0) + 1);
    $('#invSearch').value = '';
    renderInventory();
    toast(`📋 ${p.name} : ${invCounts.get(p.id)} compté(s)`);
  } else if (!candidates.length) {
    toast('Aucun produit ne correspond à ce code', true);
  } else {
    toast('Plusieurs produits correspondent — précisez', true);
  }
});
$('#invSearch').addEventListener('input', renderInventory);

$('#btnInventory').addEventListener('click', openInventory);
$('#btnCloseInventory').addEventListener('click', () => { $('#inventoryModal').hidden = true; });

$('#btnCommitInventory').addEventListener('click', async () => {
  if (!invCounts.size) return toast('Comptez au moins un produit', true);
  const gaps = [...invCounts].filter(([id, c]) => {
    const p = products.find((x) => x.id === id);
    return p && c !== p.stock;
  }).length;
  if (!confirm(`Valider l'inventaire ? ${invCounts.size} produit(s) compté(s), ${gaps} écart(s) — le stock sera recalé sur vos comptages.`)) return;
  try {
    const result = await api('/api/inventory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ counts: [...invCounts].map(([id, counted]) => ({ id, counted })) }),
    });
    $('#inventoryModal').hidden = true;
    await loadProducts();
    const rows = result.discrepancies
      .map(
        (d) => `<tr>
        <td>${escapeHtml(d.name)}${d.sku ? ` <span class="product-sku">(${escapeHtml(d.sku)})</span>` : ''}</td>
        <td>${d.before}</td><td>${d.counted}</td>
        <td class="${d.diff > 0 ? 'delta-pos' : 'delta-neg'}">${d.diff > 0 ? '+' : ''}${d.diff}</td>
      </tr>`
      )
      .join('');
    $('#recapContent').innerHTML = `
      <p><strong>${result.counted}</strong> produit(s) compté(s) — <strong>${result.adjusted}</strong> écart(s) corrigé(s).</p>
      ${rows
        ? `<div class="table-wrap"><table>
            <thead><tr><th>Produit</th><th>Avant</th><th>Compté</th><th>Écart</th></tr></thead>
            <tbody>${rows}</tbody></table></div>`
        : '<p>🎉 Aucun écart : votre stock était juste !</p>'}
      <p class="muted small">Les écarts sont tracés dans l'Historique (motif « Inventaire »).</p>`;
    document.querySelector('#recapModal h2').textContent = '📋 Inventaire terminé';
    $('#recapModal').hidden = false;
  } catch (e) {
    toast(e.message, true);
  }
});

// ---------------------------------------------------------------------------
// Démarrage : si un mot de passe est défini et la session absente/expirée,
// l'écran de connexion s'affiche avant de charger quoi que ce soit
(async () => {
  try {
    const st = await fetch('/api/auth/status').then((r) => r.json());
    if (st.protected && !st.authenticated) {
      showLogin();
      return;
    }
  } catch (e) {
    /* serveur injoignable : les appels suivants afficheront l'erreur */
  }
  loadSettings();
  loadProducts().then(resumeActiveLive);
})();
