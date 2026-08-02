/* WowMart Stock — interface
   Stock unique partagé entre les canaux : une vente en ligne, en boutique
   ou en live décompte du même total ; le canal sert à tracer la vente. */

const $ = (sel) => document.querySelector(sel);

const SALE_CHANNELS = [
  { key: 'online', label: '🌐 En ligne' },
  { key: 'store', label: '🏬 Boutique' },
  { key: 'live', label: '🎥 Live' },
];
const CHANNEL_LABELS = {
  online: '🌐 En ligne',
  store: '🏬 Boutique',
  live: '🎥 Live',
  adjust: '🔧 Ajustement',
};
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
const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------------------------------------------------------------------------
// Onglets
// ---------------------------------------------------------------------------
document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.tab-panel').forEach((p) => (p.hidden = true));
    $(`#tab-${btn.dataset.tab}`).hidden = false;
    if (btn.dataset.tab === 'movements') loadMovements();
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
    <div class="stat"><div class="value">${s.sales.online}</div><div class="label">🌐 Ventes en ligne (30 j)</div></div>
    <div class="stat"><div class="value">${s.sales.store}</div><div class="label">🏬 Ventes boutique (30 j)</div></div>
    <div class="stat"><div class="value">${s.sales.live}</div><div class="label">🎥 Ventes live (30 j)</div></div>
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
             title="Vendre 1 (${c.label})">${c.label} −1</button>`
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

async function moveStock(id, channel, delta, reason) {
  try {
    const updated = await api(`/api/products/${id}/stock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, delta, reason }),
    });
    const i = products.findIndex((p) => p.id === id);
    if (i >= 0) products[i] = updated;
    renderProducts();
    loadStats();
  } catch (e) {
    toast(e.message, true);
  }
}

// Vente : décompte 1 du stock partagé, en traçant le canal
window.sell = (id, channel) => moveStock(id, channel, -1, 'Vente');
// Réassort / correction manuelle
window.adjust = (id, delta) => moveStock(id, 'adjust', delta);

let searchTimer;
$('#search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadProducts, 250);
});
$('#lowOnly').addEventListener('change', renderProducts);

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
          (m) => `<tr>
        <td>${new Date(m.created_at).toLocaleString('fr-FR')}</td>
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
loadProducts();
