/**
 * collection-app.js — Butterfly Collection Manager
 *
 * Full WP3 implementation: card grid, detail panel, inline editing,
 * search (debounced, accent-insensitive), filter (supplier/sex/location/
 * price-range), sort, add/delete specimen, URL-hash state, stats.
 *
 * Vanilla ES module — no frameworks, no build step.
 */

import { openDB, getAllSpecimens, putSpecimen, deleteSpecimen,
         searchSpecimens, getStats, seedFromJSON, exportJSON, importJSON } from './db.js';
import { initPhotoDB, renderPhotoGallery, getCardThumbnailURL } from './photos.js';
import { generateLabelsPDF, generatePreview } from './labels.js';
import { seedPhotos } from './photo-seeder.js';

// ── App state ──────────────────────────────────────────────────────────────

/** Full list loaded from IndexedDB. */
let specimens = [];

/** Subset after search + filter + sort. */
let filteredSpecimens = [];

/** IDs of cards checked for label generation. */
let selectedIds = new Set();

/** ID of the specimen currently shown in the detail panel (null = closed). */
let currentSpecimenId = null;

/**
 * Active filter values.
 * supplier / sex / location are arrays (OR within each, AND across).
 * priceMin / priceMax are numbers or null.
 */
let activeFilters = {
  supplier: [],
  sex:      [],
  location: [],
  priceMin: null,
  priceMax: null,
};

/** Current sort key. */
let currentSort = 'english_name';

/** Whether the app is in "select for labels" mode. */
let labelSelectMode = false;

/** Current view mode: 'table' or 'grid'. */
let currentView = 'table';

// ── DOM refs ────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

const specimenGrid  = $('specimen-grid');
const detailPanel   = $('detail-panel');
const searchInput   = $('collection-search');
const specimenCount = $('specimen-count');
const statusBar     = $('status-bar');
const toastEl       = $('toast');

// ── Init ────────────────────────────────────────────────────────────────────

/**
 * Application bootstrap. Called on DOMContentLoaded.
 * Opens the DB, seeds from collection.json if empty, restores URL state,
 * then renders.
 */
async function init() {
  try {
    showStatus('Opening database…');
    await openDB();
    await initPhotoDB();

    showStatus('Checking for seed data…');
    await seedFromJSON('data/collection.json', (loaded, total) => {
      showStatus(`Seeding… ${loaded} / ${total}`);
    });

    specimens = await getAllSpecimens();

    // Restore URL hash state before first render
    restoreHashState();

    filteredSpecimens = applyFilters(specimens);
    sortSpecimens();

    await updateStats();
    buildFilterOptions();
    updateStickyOffsets();
    renderView();
    renderFilterChips();
    showStatus(`${specimens.length} specimens loaded`);

    // Seed photos in the background — don't block the UI
    seedPhotosInBackground();
  } catch (err) {
    console.error('[app] init failed:', err);
    showStatus(`Error: ${err.message}`, 'error');
  }
}

/**
 * Seeds specimen photos from data/specimen-photos/ into IndexedDB in the
 * background so the user can browse the table immediately.
 * After seeding, re-renders the view to show newly-imported thumbnails.
 */
async function seedPhotosInBackground() {
  try {
    const result = await seedPhotos((loaded, total) => {
      showStatus(`Importing photos: ${loaded} / ${total}`);
    });
    if (result.seeded > 0) {
      showStatus(`${result.seeded} photos imported — refreshing thumbnails…`);
      // Re-render to show the newly imported thumbnails
      renderView();
      showStatus(`${specimens.length} specimens loaded`);
    }
  } catch (err) {
    console.error('[app] photo seeding failed:', err);
    showStatus('Photo import failed — see console');
  }
}

// ── Stats ────────────────────────────────────────────────────────────────────

/**
 * Fetches stats from the DB and updates the specimen count badge.
 */
async function updateStats() {
  const stats = await getStats();
  updateSpecimenCountDisplay(stats.total);
}

// ── URL hash state ───────────────────────────────────────────────────────────

/**
 * Serialises current search query, active filters, and sort key to the URL
 * hash so the view is bookmarkable / shareable.
 * Format: #q=...&sort=...&supplier=...&sex=...&location=...&pmin=...&pmax=...
 */
function pushHashState() {
  const params = new URLSearchParams();

  const q = searchInput ? searchInput.value.trim() : '';
  if (q)                           params.set('q',        q);
  if (currentSort !== 'english_name') params.set('sort',  currentSort);
  if (currentView !== 'table')     params.set('view',     currentView);
  if (activeFilters.supplier.length)  params.set('supplier', activeFilters.supplier.join('|'));
  if (activeFilters.sex.length)       params.set('sex',      activeFilters.sex.join('|'));
  if (activeFilters.location.length)  params.set('location', activeFilters.location.join('|'));
  if (activeFilters.priceMin != null) params.set('pmin',  String(activeFilters.priceMin));
  if (activeFilters.priceMax != null) params.set('pmax',  String(activeFilters.priceMax));

  const hash = params.toString();
  // Use replaceState equivalent — history.replaceState is not available on
  // file:// origins in some browsers, so we fall back to location.hash
  try {
    history.replaceState(null, '', hash ? '#' + hash : location.pathname + location.search);
  } catch (_) {
    location.hash = hash;
  }
}

/**
 * Reads URL hash and restores search, filters, and sort state.
 * Called once at startup, before first render.
 */
function restoreHashState() {
  const raw = location.hash.replace(/^#/, '');
  if (!raw) return;

  let params;
  try {
    params = new URLSearchParams(raw);
  } catch (_) {
    return;
  }

  if (params.has('q') && searchInput) {
    searchInput.value = params.get('q');
  }

  if (params.has('sort')) {
    currentSort = params.get('sort');
    const sortEl = $('sort-select');
    if (sortEl) sortEl.value = currentSort;
  }

  if (params.has('view')) {
    const v = params.get('view');
    if (v === 'grid' || v === 'table') {
      currentView = v;
      // Sync toggle button UI
      document.querySelectorAll('.view-btn').forEach(b => {
        b.classList.toggle('view-btn--active', b.dataset.view === currentView);
      });
    }
  }

  if (params.has('supplier'))
    activeFilters.supplier = params.get('supplier').split('|').filter(Boolean);
  if (params.has('sex'))
    activeFilters.sex      = params.get('sex').split('|').filter(Boolean);
  if (params.has('location'))
    activeFilters.location = params.get('location').split('|').filter(Boolean);

  const pmin = params.get('pmin');
  const pmax = params.get('pmax');
  if (pmin !== null) {
    activeFilters.priceMin = parseFloat(pmin);
    const el = $('filter-price-min');
    if (el) el.value = pmin;
  }
  if (pmax !== null) {
    activeFilters.priceMax = parseFloat(pmax);
    const el = $('filter-price-max');
    if (el) el.value = pmax;
  }
}

// ── Filter option builder ─────────────────────────────────────────────────────

/**
 * Builds the <option> lists for supplier, sex, and location dropdowns
 * from the current full `specimens` array.
 */
function buildFilterOptions() {
  // Supplier: use username as key when available, fall back to name
  const supplierKeys = [...new Set(
    specimens.map(s => s.supplier_username || s.supplier_name).filter(Boolean)
  )].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

  const sexValues     = [...new Set(specimens.map(s => s.sex).filter(Boolean))].sort();
  const locationValues = [...new Set(specimens.map(s => s.location).filter(Boolean))]
                          .sort((a, b) => a.localeCompare(b));

  populateSelect('filter-supplier', supplierKeys, 'All Suppliers');
  populateSelect('filter-sex',      sexValues,    'All Sexes');
  populateSelect('filter-location', locationValues, 'All Locations');

  // Restore multi-select state from activeFilters
  syncSelectToFilter('filter-supplier', activeFilters.supplier);
  syncSelectToFilter('filter-sex',      activeFilters.sex);
  syncSelectToFilter('filter-location', activeFilters.location);
}

/** Fills a <select> element with option values; prepends a blank "all" option. */
function populateSelect(id, values, allLabel) {
  const el = $(id);
  if (!el) return;
  el.innerHTML = `<option value="">${allLabel}</option>` +
    values.map(v => `<option value="${escHtml(v)}">${escHtml(v)}</option>`).join('');
}

/**
 * Sets the selected option in a <select> to match the first value in an array.
 * (Single-select; multi-select chips are handled separately.)
 */
function syncSelectToFilter(id, values) {
  const el = $(id);
  if (!el || !values.length) return;
  el.value = values[0] || '';
}

// ── Grid rendering ────────────────────────────────────────────────────────────

/**
 * Renders the specimen card grid from `filteredSpecimens`.
 * Uses a DocumentFragment for one DOM write. Attaches an IntersectionObserver
 * for lazy-loading images if any card has a photo.
 */
function renderGrid() {
  if (!specimenGrid) return;
  specimenGrid.innerHTML = '';

  if (filteredSpecimens.length === 0) {
    specimenGrid.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🦋</div>
        <h3>No specimens found</h3>
        <p>Try adjusting your search or filters, or add a new specimen.</p>
      </div>`;
    return;
  }

  const frag = document.createDocumentFragment();
  const lazyImgs = [];

  for (const s of filteredSpecimens) {
    const card = makeCard(s);
    frag.appendChild(card);

    // Collect lazy images for the observer
    const img = card.querySelector('img.card-photo[data-lazy-src]');
    if (img) lazyImgs.push(img);
  }

  specimenGrid.appendChild(frag);

  // Attach IntersectionObserver for lazy photo loading
  if (lazyImgs.length && 'IntersectionObserver' in window) {
    const observer = new IntersectionObserver((entries, obs) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          const img = entry.target;
          img.src = img.dataset.lazySrc;
          img.removeAttribute('data-lazy-src');
          obs.unobserve(img);
        }
      }
    }, { rootMargin: '200px' });

    for (const img of lazyImgs) observer.observe(img);
  }

  // Load IndexedDB thumbnails for cards that still show the placeholder
  loadCardThumbnails();
}

/**
 * Builds a single specimen card element.
 *
 * Sex is stored as the actual symbol (♂, ♀, ♂♀) in the data.
 * Price badge shows £X.XX unless price_is_collected is true.
 *
 * @param {Object} s — specimen record
 * @returns {HTMLElement}
 */
function makeCard(s) {
  const card = document.createElement('div');
  card.className = 'specimen-card';
  card.dataset.id = s.id;
  card.setAttribute('role', 'listitem');

  if (selectedIds.has(s.id)) card.classList.add('selected');

  // Sex symbol — data already stores ♂ / ♀ / ♂♀; just display it directly
  const sexSym = s.sex || '';

  // Price display
  let priceHtml = '';
  if (s.price_is_collected) {
    priceHtml = `<span class="price-badge price-badge--collected">collected</span>`;
  } else if (s.price != null && s.price !== '') {
    const cur = s.currency || '£';
    priceHtml = `<span class="price-badge">${escHtml(cur)}${Number(s.price).toFixed(2)}</span>`;
  }

  // Photo area
  let photoHtml;
  if (s.photo_url) {
    // True lazy: use data-lazy-src, real src = blank
    photoHtml = `<img class="card-photo" data-lazy-src="${escHtml(s.photo_url)}"
      src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"
      alt="${escHtml(s.english_name || s.latin_name || '')}" loading="lazy">`;
  } else {
    photoHtml = `<div class="card-photo card-photo--placeholder" aria-hidden="true">🦋</div>`;
  }

  // Supplier: prefer username as short identifier, fall back to name
  const supplierDisplay = s.supplier_username || s.supplier_name || '';

  card.innerHTML = `
    <div class="card-photo-wrap">
      ${photoHtml}
      ${priceHtml}
      ${sexSym ? `<span class="sex-symbol" aria-label="${escHtml(sexSym)}">${escHtml(sexSym)}</span>` : ''}
      <label class="card-select-overlay" title="Select for label">
        <input type="checkbox" class="card-checkbox" data-id="${s.id}"
          ${selectedIds.has(s.id) ? 'checked' : ''} tabindex="-1"
          aria-label="Select ${escHtml(s.english_name || s.latin_name || 'specimen')} for label">
        <span class="card-checkbox-visual"></span>
      </label>
    </div>
    <div class="card-body">
      <div class="card-common">${escHtml(s.english_name || '(Unnamed)')}</div>
      <div class="card-latin">${escHtml(s.latin_name || '')}</div>
      ${supplierDisplay ? `<div class="card-supplier">${escHtml(supplierDisplay)}</div>` : ''}
    </div>
  `;

  // Open detail panel on card click (but not on checkbox interaction)
  card.addEventListener('click', e => {
    if (e.target.closest('.card-select-overlay')) return;
    renderDetailPanel(s.id);
  });

  // Checkbox toggles label selection
  const cb = card.querySelector('.card-checkbox');
  cb.addEventListener('change', e => {
    e.stopPropagation();
    toggleLabelSelection(s.id, cb.checked);
  });

  return card;
}

// ── View dispatcher ──────────────────────────────────────────────────────────

/**
 * Dispatches to the correct renderer based on `currentView`.
 */
function renderView() {
  if (currentView === 'table') renderTable();
  else renderGrid();
}

// ── Date formatting helper ────────────────────────────────────────────────────

/**
 * Converts an ISO YYYY-MM-DD date string to the display format DD.MM.YYYY.
 * Returns '–' for missing or non-conforming values.
 * @param {string} iso
 * @returns {string}
 */
function formatDateDisplay(iso) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '–';
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

// ── Table rendering ──────────────────────────────────────────────────────────

/**
 * Renders a spreadsheet-style <table> into #specimen-grid.
 * Replaces the grid CSS mode via a class toggle.
 */
function renderTable() {
  if (!specimenGrid) return;
  specimenGrid.innerHTML = '';
  specimenGrid.classList.add('specimen-grid--table');

  if (filteredSpecimens.length === 0) {
    specimenGrid.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🦋</div>
        <h3>No specimens found</h3>
        <p>Try adjusting your search or filters, or add a new specimen.</p>
      </div>`;
    return;
  }

  // Determine sort arrow for each sortable column
  const sortArrow = (colKey) => {
    if (currentSort === colKey) return ' ▾';
    // price has two keys: price_asc / price_desc
    if (colKey === 'price_asc' && currentSort === 'price_desc') return ' ▴';
    if (colKey === 'date_acquired' && currentSort === 'date_oldest') return ' ▴';
    return '';
  };

  const activeCls = (colKey) => {
    if (currentSort === colKey) return ' sort-active';
    if (colKey === 'price_asc' && (currentSort === 'price_asc' || currentSort === 'price_desc')) return ' sort-active';
    if (colKey === 'date_acquired' && (currentSort === 'date_acquired' || currentSort === 'date_oldest')) return ' sort-active';
    return '';
  };

  const table = document.createElement('table');
  table.className = 'specimen-table';
  table.setAttribute('role', 'grid');

  table.innerHTML = `
    <thead>
      <tr>
        <th class="col-select"><input type="checkbox" id="select-all" title="Select all" aria-label="Select all"></th>
        <th class="col-photo">Photo</th>
        <th class="col-name sortable${activeCls('english_name')}" data-sort="english_name">Name${sortArrow('english_name')}</th>
        <th class="col-latin sortable${activeCls('latin_name')}" data-sort="latin_name">Latin Name${sortArrow('latin_name')}</th>
        <th class="col-supplier sortable${activeCls('supplier_name')}" data-sort="supplier_name">Supplier${sortArrow('supplier_name')}</th>
        <th class="col-price sortable${activeCls('price_asc')}" data-sort="price_asc">Price${sortArrow('price_asc')}</th>
        <th class="col-location sortable${activeCls('location')}" data-sort="location">Location${sortArrow('location')}</th>
        <th class="col-date sortable${activeCls('date_acquired')}" data-sort="date_acquired">Date${sortArrow('date_acquired')}</th>
        <th class="col-desc">Description</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;

  const tbody = table.querySelector('tbody');
  const frag = document.createDocumentFragment();
  for (const s of filteredSpecimens) {
    frag.appendChild(makeTableRow(s));
  }
  tbody.appendChild(frag);

  specimenGrid.appendChild(table);

  // Wire sortable column headers
  table.querySelectorAll('th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.sort;
      let newSort = col;
      // Toggle price direction
      if (col === 'price_asc') {
        newSort = (currentSort === 'price_asc') ? 'price_desc' : 'price_asc';
      }
      // Toggle date direction
      if (col === 'date_acquired') {
        newSort = (currentSort === 'date_acquired') ? 'date_oldest' : 'date_acquired';
      }
      // Toggle alpha columns
      if (col !== 'price_asc' && col !== 'date_acquired' && currentSort === col) {
        // For alpha sorts, re-click does nothing special (single direction),
        // but we keep the same key to show the indicator
        newSort = col;
      }
      handleSort(newSort);
    });
  });

  // Wire select-all checkbox
  const selectAll = table.querySelector('#select-all');
  if (selectAll) {
    // Reflect current selection state
    const allSelected = filteredSpecimens.length > 0 &&
      filteredSpecimens.every(s => selectedIds.has(s.id));
    selectAll.checked = allSelected;
    selectAll.indeterminate = !allSelected && filteredSpecimens.some(s => selectedIds.has(s.id));

    selectAll.addEventListener('change', () => {
      if (selectAll.checked) {
        filteredSpecimens.forEach(s => selectedIds.add(s.id));
      } else {
        filteredSpecimens.forEach(s => selectedIds.delete(s.id));
      }
      // Re-render rows to reflect new selection state
      renderTable();
      updateLabelButtonState();
    });
  }

  // Attach inline editing to all editable cells
  table.querySelectorAll('.editable').forEach(el => {
    makeEditable(el, el.dataset.field, el.dataset.id, el.dataset.type || 'text');
  });

  // Load thumbnails asynchronously after the table is in the DOM
  loadTableThumbnails();
}

/**
 * Builds a single <tr> for one specimen in table view.
 * @param {Object} s — specimen record
 * @returns {HTMLTableRowElement}
 */
function makeTableRow(s) {
  const tr = document.createElement('tr');
  tr.dataset.id = s.id;
  if (selectedIds.has(s.id)) tr.classList.add('selected');

  // Price display
  let priceText;
  if (s.price_is_collected) {
    priceText = 'collected';
  } else if (s.price != null && s.price !== '') {
    const cur = s.currency || '£';
    priceText = `${escHtml(cur)}${Number(s.price).toFixed(2)}`;
  } else {
    priceText = '–';
  }

  const sexSym = s.sex ? `<span class="sex-sym">${escHtml(s.sex)}</span>` : '';
  const supplierDisplay = escHtml(s.supplier_username || s.supplier_name || '–');
  const locationDisplay = escHtml(s.location || '–');
  const descDisplay = escHtml((s.description || '').slice(0, 80) + ((s.description || '').length > 80 ? '…' : '')) || '–';
  const dateDisplay = formatDateDisplay(s.date_bought || s.date_received || '');

  tr.innerHTML = `
    <td class="col-select">
      <input type="checkbox" class="row-checkbox" data-id="${s.id}"
             ${selectedIds.has(s.id) ? 'checked' : ''}
             aria-label="Select ${escHtml(s.english_name || s.latin_name || 'specimen')}">
    </td>
    <td class="col-photo">
      <div class="table-thumb" data-specimen-id="${s.id}">🦋</div>
    </td>
    <td class="col-name editable" data-field="english_name" data-id="${s.id}" data-type="text">
      ${escHtml(s.english_name || '(Unnamed)')}${sexSym}
    </td>
    <td class="col-latin editable" data-field="latin_name" data-id="${s.id}" data-type="text">
      <em>${escHtml(s.latin_name || '–')}</em>
    </td>
    <td class="col-supplier editable" data-field="supplier_username" data-id="${s.id}" data-type="text">
      ${supplierDisplay}
    </td>
    <td class="col-price editable" data-field="price" data-id="${s.id}" data-type="price">
      ${priceText}
    </td>
    <td class="col-location editable" data-field="location" data-id="${s.id}" data-type="text" title="${escHtml(s.location || '')}">
      ${locationDisplay}
    </td>
    <td class="col-date editable" data-field="date_bought" data-id="${s.id}" data-type="date">
      ${dateDisplay}
    </td>
    <td class="col-desc editable" data-field="description" data-id="${s.id}" data-type="text">
      ${descDisplay}
    </td>
  `;

  // Row click → open detail panel (except on checkbox or an actively-editing cell)
  tr.addEventListener('click', e => {
    if (e.target.closest('.row-checkbox') || e.target.closest('.editing')) return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
    renderDetailPanel(s.id);
  });

  // Checkbox toggles label selection
  const cb = tr.querySelector('.row-checkbox');
  if (cb) {
    cb.addEventListener('change', e => {
      e.stopPropagation();
      toggleLabelSelection(s.id, cb.checked);
      tr.classList.toggle('selected', cb.checked);
      // Keep select-all in sync
      const selectAll = specimenGrid?.querySelector('#select-all');
      if (selectAll) {
        const allSelected = filteredSpecimens.every(s2 => selectedIds.has(s2.id));
        const anySelected = filteredSpecimens.some(s2 => selectedIds.has(s2.id));
        selectAll.checked = allSelected;
        selectAll.indeterminate = !allSelected && anySelected;
      }
    });
  }

  return tr;
}

// ── Thumbnail loaders ─────────────────────────────────────────────────────────

/**
 * After the table is rendered, asynchronously fills in thumbnail images for
 * every visible row. Cells that have no photo keep the 🦋 placeholder.
 */
async function loadTableThumbnails() {
  const thumbCells = specimenGrid.querySelectorAll('.table-thumb[data-specimen-id]');
  for (const cell of thumbCells) {
    const id = cell.dataset.specimenId;
    try {
      const url = await getCardThumbnailURL(id);
      if (url) {
        cell.innerHTML = `<img src="${url}" alt="" loading="lazy">`;
      }
    } catch (_) { /* keep placeholder */ }
  }
}

/**
 * After the grid is rendered, asynchronously replaces card placeholder divs
 * with real thumbnail images from IndexedDB.
 */
async function loadCardThumbnails() {
  const photoWraps = specimenGrid.querySelectorAll('.card-photo--placeholder');
  for (const placeholder of photoWraps) {
    const card = placeholder.closest('.specimen-card');
    if (!card) continue;
    const id = card.dataset.id;
    try {
      const url = await getCardThumbnailURL(id);
      if (url) {
        const img = document.createElement('img');
        img.className = 'card-photo';
        img.src = url;
        img.alt = '';
        img.loading = 'lazy';
        placeholder.replaceWith(img);
      }
    } catch (_) { /* keep placeholder */ }
  }
}

// ── Detail panel ─────────────────────────────────────────────────────────────

/**
 * Renders the slide-in detail panel for a given specimen ID.
 * All displayed text fields get the `.editable` class for inline editing.
 * Organises fields into logical sections mirroring the data schema.
 *
 * @param {string|number} id
 */
async function renderDetailPanel(id) {
  const s = specimens.find(sp => sp.id === id);
  if (!s) return;

  currentSpecimenId = id;

  if (!detailPanel) return;

  // Price display for detail panel
  let priceDisplay;
  if (s.price_is_collected) {
    priceDisplay = 'collected';
  } else if (s.price != null && s.price !== '') {
    priceDisplay = `${s.currency || '£'}${Number(s.price).toFixed(2)}`;
  } else {
    priceDisplay = '–';
  }

  detailPanel.innerHTML = `
    <div class="detail-header">
      <button class="detail-close" id="detail-close" aria-label="Close panel">✕</button>
      <button class="btn btn-danger detail-delete-btn" id="detail-delete"
              title="Delete this specimen" aria-label="Delete specimen">🗑</button>
      <h2 class="detail-title editable" data-field="english_name" data-id="${s.id}"
          data-type="text">${escHtml(s.english_name || 'Unnamed')}</h2>
      <div class="detail-latin editable" data-field="latin_name" data-id="${s.id}"
           data-type="text" style="font-style:italic">${escHtml(s.latin_name || '')}</div>
    </div>

    <div class="detail-photo-wrap" id="photo-gallery-area">
    </div>

    <!-- ── Collection details ── -->
    <div class="detail-section">
      <div class="detail-section-title">Collection</div>
      <div class="detail-fields">

        <div class="detail-row">
          <span class="detail-label">Sex</span>
          <span class="detail-value editable" data-field="sex" data-id="${s.id}"
                data-type="sex">${escHtml(s.sex || '–')}</span>
        </div>

        <div class="detail-row">
          <span class="detail-label">Location</span>
          <span class="detail-value editable" data-field="location" data-id="${s.id}"
                data-type="text">${escHtml(s.location || '–')}</span>
        </div>

        <div class="detail-row">
          <span class="detail-label">Altitude</span>
          <span class="detail-value editable" data-field="altitude_m" data-id="${s.id}"
                data-type="altitude">${s.altitude_m != null ? escHtml(String(s.altitude_m)) + ' m' : '–'}</span>
        </div>

        <div class="detail-row">
          <span class="detail-label">Collector</span>
          <span class="detail-value editable" data-field="collector" data-id="${s.id}"
                data-type="text">${escHtml(s.collector || '–')}</span>
        </div>

        <div class="detail-row">
          <span class="detail-label">Date bought</span>
          <span class="detail-value editable" data-field="date_bought" data-id="${s.id}"
                data-type="date">${escHtml(s.date_bought || '–')}</span>
        </div>

        <div class="detail-row">
          <span class="detail-label">Date sent</span>
          <span class="detail-value editable" data-field="date_sent" data-id="${s.id}"
                data-type="date">${escHtml(s.date_sent || '–')}</span>
        </div>

        <div class="detail-row">
          <span class="detail-label">Date received</span>
          <span class="detail-value editable" data-field="date_received" data-id="${s.id}"
                data-type="date">${escHtml(s.date_received || '–')}</span>
        </div>

      </div>
    </div>

    <!-- ── Supplier ── -->
    <div class="detail-section">
      <div class="detail-section-title">Supplier</div>
      <div class="detail-fields">

        <div class="detail-row">
          <span class="detail-label">Username</span>
          <span class="detail-value editable" data-field="supplier_username" data-id="${s.id}"
                data-type="text">${escHtml(s.supplier_username || '–')}</span>
        </div>

        <div class="detail-row">
          <span class="detail-label">Name</span>
          <span class="detail-value editable" data-field="supplier_name" data-id="${s.id}"
                data-type="text">${escHtml(s.supplier_name || '–')}</span>
        </div>

        <div class="detail-row detail-row--full">
          <span class="detail-label">Address</span>
          <span class="detail-value editable detail-notes" data-field="supplier_address"
                data-id="${s.id}" data-type="textarea">${escHtml(s.supplier_address || '–')}</span>
        </div>

      </div>
    </div>

    <!-- ── Commercial ── -->
    <div class="detail-section">
      <div class="detail-section-title">Commercial</div>
      <div class="detail-fields">

        <div class="detail-row">
          <span class="detail-label">Price</span>
          <span class="detail-value editable" data-field="price" data-id="${s.id}"
                data-type="price">${escHtml(priceDisplay)}</span>
        </div>

        <div class="detail-row">
          <span class="detail-label">Currency</span>
          <span class="detail-value editable" data-field="currency" data-id="${s.id}"
                data-type="text">${escHtml(s.currency || '£')}</span>
        </div>

        <div class="detail-row">
          <span class="detail-label">Cat. number</span>
          <span class="detail-value editable" data-field="cat_number" data-id="${s.id}"
                data-type="text">${escHtml(s.cat_number || '–')}</span>
        </div>

      </div>
    </div>

    <!-- ── Notes ── -->
    <div class="detail-section">
      <div class="detail-section-title">Notes</div>
      <div class="detail-fields">

        <div class="detail-row detail-row--full">
          <span class="detail-label">Description</span>
          <span class="detail-value editable detail-notes" data-field="description"
                data-id="${s.id}" data-type="textarea">${escHtml(s.description || '–')}</span>
        </div>

        <div class="detail-row detail-row--full">
          <span class="detail-label">Notes</span>
          <span class="detail-value editable detail-notes" data-field="notes"
                data-id="${s.id}" data-type="textarea">${escHtml(s.notes || '–')}</span>
        </div>

        <div class="detail-row detail-row--full">
          <span class="detail-label">Setting board</span>
          <span class="detail-value editable detail-notes" data-field="setting_board"
                data-id="${s.id}" data-type="textarea">${escHtml(s.setting_board || '–')}</span>
        </div>

      </div>
    </div>

    <div class="detail-actions">
      <button class="btn btn-primary" id="detail-generate-label">Generate Label</button>
    </div>
  `;

  // Render photo gallery
  const galleryArea = $('photo-gallery-area');
  if (galleryArea) renderPhotoGallery(s.id, galleryArea);

  // Wire up close button
  $('detail-close').addEventListener('click', closeDetailPanel);

  // Wire up delete (trash icon in header)
  $('detail-delete').addEventListener('click', async () => {
    if (!confirm(`Delete "${s.english_name || s.latin_name || 'this specimen'}"?\nThis cannot be undone.`)) return;
    try {
      await deleteSpecimen(s.id);
      specimens = await getAllSpecimens();
      applyFiltersAndSort();
      closeDetailPanel();
      await updateStats();
      showToast('Specimen deleted');
    } catch (err) {
      console.error('[app] deleteSpecimen failed:', err);
      showToast('Delete failed — see console', 'error');
    }
  });

  // Wire up inline editing for all .editable elements
  detailPanel.querySelectorAll('.editable').forEach(el => {
    makeEditable(el, el.dataset.field, el.dataset.id, el.dataset.type || 'text');
  });

  // Wire up label generation for this single specimen
  $('detail-generate-label').addEventListener('click', () => {
    generateLabelsPDF([s]);
    showToast(`Label PDF generated for "${s.english_name}"`);
  });

  // Update aria-hidden state
  detailPanel.setAttribute('aria-hidden', 'false');

  // Slide panel open
  detailPanel.classList.add('open');
  document.body.classList.add('panel-open');
}

/** Closes the detail panel and clears the current selection. */
function closeDetailPanel() {
  if (!detailPanel) return;
  detailPanel.classList.remove('open');
  detailPanel.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('panel-open');
  currentSpecimenId = null;
}

// ── Inline editing ────────────────────────────────────────────────────────────

/**
 * Attaches inline-edit behaviour to an `.editable` element.
 *
 * Supported `fieldType` values:
 *   'text'     → <input type="text">
 *   'textarea' → <textarea>
 *   'date'     → <input type="date">
 *   'altitude' → <input type="number"> with "m" suffix
 *   'sex'      → <select> with ♂ / ♀ / ♂♀ / blank options
 *   'price'    → <input type="number step="0.01"> + "Collected" checkbox
 *
 * Commit: blur or Enter (single-line), Ctrl/Cmd+Enter (textarea).
 * Cancel: Escape restores original text without saving.
 * After commit: saves to IndexedDB, flashes .edit-saved, refreshes grid card.
 *
 * @param {HTMLElement}   element
 * @param {string}        field        — specimen property key
 * @param {string|number} specimenId
 * @param {string}        [fieldType]  — see above; default 'text'
 */
function makeEditable(element, field, specimenId, fieldType = 'text') {
  element.addEventListener('click', function onEditClick(e) {
    e.stopPropagation();
    if (element.classList.contains('editing')) return;

    const specimen = specimens.find(s => String(s.id) === String(specimenId));
    if (!specimen) return;

    element.classList.add('editing');
    element.removeEventListener('click', onEditClick);

    // ── Build the input control ──────────────────────────────────────────────
    let inputEl;
    let getNewValue;   // () → the value to write back to the specimen
    let extraEl = null; // optional sibling element (e.g. "Collected" checkbox wrapper)

    if (fieldType === 'sex') {
      // Drop-down with Unicode sex symbols matching the actual data values
      inputEl = document.createElement('select');
      inputEl.className = 'edit-input';
      [['', '(unknown)'], ['♂', '♂ Male'], ['♀', '♀ Female'], ['♂♀', '♂♀ Pair']]
        .forEach(([val, label]) => {
          const opt = document.createElement('option');
          opt.value = val;
          opt.textContent = label;
          if ((specimen[field] || '') === val) opt.selected = true;
          inputEl.appendChild(opt);
        });
      getNewValue = () => inputEl.value;

    } else if (fieldType === 'price') {
      // Number input + "Collected" checkbox
      const wrapper = document.createElement('span');
      wrapper.style.cssText = 'display:inline-flex;align-items:center;gap:8px;';

      inputEl = document.createElement('input');
      inputEl.type = 'number';
      inputEl.step = '0.01';
      inputEl.min  = '0';
      inputEl.className = 'edit-input';
      inputEl.style.width = '80px';
      inputEl.value = (specimen.price != null && !specimen.price_is_collected)
        ? String(specimen.price) : '';

      const cbLabel = document.createElement('label');
      cbLabel.style.cssText = 'font-size:0.8em;display:inline-flex;align-items:center;gap:4px;cursor:pointer;';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!specimen.price_is_collected;
      cb.style.cursor = 'pointer';
      cbLabel.appendChild(cb);
      cbLabel.appendChild(document.createTextNode(' Collected'));
      extraEl = cbLabel;

      wrapper.appendChild(inputEl);
      wrapper.appendChild(cbLabel);

      // Disable/enable price input when checkbox changes
      cb.addEventListener('change', () => {
        inputEl.disabled = cb.checked;
      });
      if (cb.checked) inputEl.disabled = true;

      getNewValue = () => ({
        price:             cb.checked ? null : (inputEl.value !== '' ? parseFloat(inputEl.value) : null),
        price_is_collected: cb.checked,
      });

      // We'll set element content to the wrapper
      element.textContent = '';
      element.appendChild(wrapper);
      inputEl.focus();
      inputEl.select();

      attachSaveCancel();
      return; // handled separately because of wrapper

    } else if (fieldType === 'textarea') {
      inputEl = document.createElement('textarea');
      inputEl.className = 'edit-input';
      inputEl.rows = 3;
      const raw = specimen[field];
      inputEl.value = (raw != null && raw !== '' && raw !== '–') ? raw : '';
      getNewValue = () => inputEl.value.trim();

    } else if (fieldType === 'date') {
      inputEl = document.createElement('input');
      inputEl.type = 'date';
      inputEl.className = 'edit-input';
      const raw = specimen[field];
      // Only set value if it looks like YYYY-MM-DD
      inputEl.value = (raw && /^\d{4}-\d{2}-\d{2}$/.test(raw)) ? raw : '';
      getNewValue = () => inputEl.value || null;

    } else if (fieldType === 'altitude') {
      const wrapper = document.createElement('span');
      wrapper.style.cssText = 'display:inline-flex;align-items:center;gap:4px;';
      inputEl = document.createElement('input');
      inputEl.type = 'number';
      inputEl.min  = '0';
      inputEl.className = 'edit-input';
      inputEl.style.width = '70px';
      inputEl.value = specimen[field] != null ? String(specimen[field]) : '';
      const suffix = document.createElement('span');
      suffix.textContent = 'm';
      suffix.style.fontSize = '0.85em';
      wrapper.appendChild(inputEl);
      wrapper.appendChild(suffix);
      getNewValue = () => inputEl.value !== '' ? parseFloat(inputEl.value) : null;

      element.textContent = '';
      element.appendChild(wrapper);
      inputEl.focus();
      inputEl.select();

      attachSaveCancel();
      return;

    } else {
      // Default: plain text input
      inputEl = document.createElement('input');
      inputEl.type = 'text';
      inputEl.className = 'edit-input';
      const raw = specimen[field];
      inputEl.value = (raw != null && raw !== '' && raw !== '–') ? String(raw) : '';
      getNewValue = () => inputEl.value.trim();
    }

    // For non-wrapper types, replace element contents
    element.textContent = '';
    element.appendChild(inputEl);
    inputEl.focus();
    if (inputEl.select) inputEl.select();

    attachSaveCancel();

    // ── Inner helpers ────────────────────────────────────────────────────────

    function attachSaveCancel() {
      const originalDisplay = formatFieldDisplay(specimen, field);

      async function commitEdit() {
        // Prevent double-fire from blur + Enter
        inputEl.removeEventListener('blur', commitEdit);

        let newValue;
        try {
          newValue = getNewValue();
        } catch (_) {
          newValue = null;
        }

        // Apply to in-memory record
        if (fieldType === 'price' && typeof newValue === 'object' && newValue !== null) {
          specimen.price = newValue.price;
          specimen.price_is_collected = newValue.price_is_collected;
        } else {
          specimen[field] = newValue !== '' ? newValue : null;
        }

        // Persist
        try {
          await putSpecimen(specimen);
        } catch (err) {
          console.error('[app] putSpecimen failed:', err);
          showToast('Save failed — see console', 'error');
        }

        // Update display
        element.classList.remove('editing');
        element.textContent = formatFieldDisplay(specimen, field);

        // Flash confirmation
        element.classList.add('edit-saved');
        setTimeout(() => element.classList.remove('edit-saved'), 600);

        // Re-attach click handler
        element.addEventListener('click', onEditClick);

        // Sync the grid card
        refreshCard(specimenId);

        // Update filter options & stats if name/supplier changed
        if (['english_name', 'latin_name', 'supplier_name', 'supplier_username',
             'location', 'sex'].includes(field)) {
          buildFilterOptions();
          applyFiltersAndSort();
        }

        showToast(`${fieldLabel(field)} saved`);
        pushHashState();
      }

      function cancelEdit() {
        inputEl.removeEventListener('blur', commitEdit);
        element.classList.remove('editing');
        element.textContent = originalDisplay;
        element.addEventListener('click', onEditClick);
      }

      inputEl.addEventListener('blur', commitEdit);

      if (fieldType === 'textarea') {
        inputEl.addEventListener('keydown', evt => {
          if (evt.key === 'Escape') {
            evt.preventDefault();
            cancelEdit();
          }
          if (evt.key === 'Enter' && (evt.ctrlKey || evt.metaKey)) {
            evt.preventDefault();
            inputEl.blur();
          }
        });
      } else if (fieldType === 'sex') {
        // select: commit on change, cancel on Escape
        inputEl.addEventListener('change', () => inputEl.blur());
        inputEl.addEventListener('keydown', evt => {
          if (evt.key === 'Escape') { evt.preventDefault(); cancelEdit(); }
        });
      } else {
        inputEl.addEventListener('keydown', evt => {
          if (evt.key === 'Enter') {
            evt.preventDefault();
            inputEl.blur();
          }
          if (evt.key === 'Escape') {
            evt.preventDefault();
            cancelEdit();
          }
        });
      }

      // Tab: commit and move to next editable
      inputEl.addEventListener('keydown', evt => {
        if (evt.key === 'Tab') {
          evt.preventDefault();
          const editables = [...detailPanel.querySelectorAll('.editable')];
          const idx = editables.indexOf(element);
          const next = editables[evt.shiftKey ? idx - 1 : idx + 1];
          inputEl.blur(); // commits
          if (next) setTimeout(() => next.click(), 50);
        }
      });
    }
  });
}

/**
 * Returns the formatted display string for a field, used to restore
 * the element's text after editing or on cancel.
 */
function formatFieldDisplay(specimen, field) {
  switch (field) {
    case 'price': {
      if (specimen.price_is_collected) return 'collected';
      if (specimen.price != null && specimen.price !== '')
        return `${specimen.currency || '£'}${Number(specimen.price).toFixed(2)}`;
      return '–';
    }
    case 'altitude_m':
      return specimen.altitude_m != null ? `${specimen.altitude_m} m` : '–';
    default: {
      const v = specimen[field];
      return (v != null && v !== '') ? String(v) : '–';
    }
  }
}

/** Refreshes a single card (grid view) or row (table view) without re-rendering everything. */
function refreshCard(id) {
  const s = specimens.find(sp => String(sp.id) === String(id));
  if (!s) return;

  // Refresh card in grid view
  const card = specimenGrid?.querySelector(`.specimen-card[data-id="${id}"]`);
  if (card) {
    const newCard = makeCard(s);
    card.replaceWith(newCard);
    return;
  }

  // Refresh row in table view
  const row = specimenGrid?.querySelector(`tr[data-id="${id}"]`);
  if (row) {
    const newRow = makeTableRow(s);
    row.replaceWith(newRow);
    // Re-attach inline editing
    newRow.querySelectorAll('.editable').forEach(el => {
      makeEditable(el, el.dataset.field, el.dataset.id, el.dataset.type || 'text');
    });
  }
}

// ── Search ─────────────────────────────────────────────────────────────────────

/**
 * Normalises a string for accent-insensitive search:
 * lowercases and strips combining diacritical marks via NFD decomposition.
 * @param {string} str
 * @returns {string}
 */
function normalise(str) {
  return String(str)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/**
 * Returns true if `specimen` matches `normQuery` in any of the key text fields.
 * @param {Object} specimen
 * @param {string} normQuery — already normalised query string
 * @returns {boolean}
 */
function specimenMatchesQuery(specimen, normQuery) {
  const SEARCH_FIELDS = [
    'english_name', 'latin_name', 'description', 'location',
    'supplier_name', 'supplier_username', 'notes', 'setting_board',
    'collector', 'cat_number',
  ];
  return SEARCH_FIELDS.some(f => {
    const v = specimen[f];
    if (v == null) return false;
    return normalise(String(v)).includes(normQuery);
  });
}

/**
 * Called by the debounced search input handler.
 * Updates `filteredSpecimens` and re-renders.
 * @param {string} query
 */
function handleSearch(query) {
  const q = normalise(query.trim());

  let base = q ? specimens.filter(s => specimenMatchesQuery(s, q)) : specimens;
  filteredSpecimens = applyFilters(base);
  sortSpecimens();
  renderView();
  updateSpecimenCountDisplay();
  pushHashState();
}

// ── Filter ────────────────────────────────────────────────────────────────────

/**
 * Applies the current `activeFilters` to a list of specimens.
 * AND logic between categories, OR within each category.
 *
 * Supplier filter matches against supplier_username OR supplier_name.
 * Price range filters are inclusive.
 *
 * @param {Object[]} list
 * @returns {Object[]}
 */
function applyFilters(list) {
  return list.filter(s => {
    // Supplier: match username or name
    if (activeFilters.supplier.length) {
      const matches = activeFilters.supplier.some(v =>
        v === s.supplier_username || v === s.supplier_name
      );
      if (!matches) return false;
    }

    // Sex
    if (activeFilters.sex.length && !activeFilters.sex.includes(s.sex)) {
      return false;
    }

    // Location
    if (activeFilters.location.length && !activeFilters.location.includes(s.location)) {
      return false;
    }

    // Price range (collected specimens count as price=0 for range purposes)
    const effectivePrice = s.price_is_collected ? 0 : (s.price ?? null);

    if (activeFilters.priceMin != null && effectivePrice != null) {
      if (effectivePrice < activeFilters.priceMin) return false;
    }
    if (activeFilters.priceMax != null && effectivePrice != null) {
      if (effectivePrice > activeFilters.priceMax) return false;
    }

    return true;
  });
}

/**
 * Reads current filter dropdown values and/or an explicit override, then
 * rebuilds `activeFilters` and triggers a re-render.
 *
 * @param {Object} [overrides] — optional { supplier, sex, location, priceMin, priceMax }
 */
function handleFilter(overrides) {
  if (overrides) {
    activeFilters = { ...activeFilters, ...overrides };
  } else {
    // Read single-select dropdowns
    activeFilters.supplier = valueFromSelect('filter-supplier');
    activeFilters.sex      = valueFromSelect('filter-sex');
    activeFilters.location = valueFromSelect('filter-location');

    // Read price range inputs
    const pmin = $('filter-price-min');
    const pmax = $('filter-price-max');
    activeFilters.priceMin = pmin && pmin.value !== '' ? parseFloat(pmin.value) : null;
    activeFilters.priceMax = pmax && pmax.value !== '' ? parseFloat(pmax.value) : null;
  }

  applyFiltersAndSort();
  renderFilterChips();
  pushHashState();
}

/** Reads a <select> value and wraps it in an array (empty if "all" selected). */
function valueFromSelect(id) {
  const el  = $(id);
  const val = el ? el.value : '';
  return val ? [val] : [];
}

/** Re-runs filters + sort then re-renders. Called after any state change. */
function applyFiltersAndSort() {
  const q = searchInput ? normalise(searchInput.value.trim()) : '';
  let base = q ? specimens.filter(s => specimenMatchesQuery(s, q)) : specimens;
  filteredSpecimens = applyFilters(base);
  sortSpecimens();
  renderView();
  updateSpecimenCountDisplay();
}

// ── Filter chips ──────────────────────────────────────────────────────────────

/**
 * Renders dismissible "active filter" chips in #filter-chips.
 * Each chip has a × button that removes that filter value.
 */
function renderFilterChips() {
  const container = $('filter-chips');
  if (!container) return;

  const chips = [];

  for (const sup of activeFilters.supplier) {
    chips.push({ label: `Supplier: ${sup}`, remove: () => {
      activeFilters.supplier = activeFilters.supplier.filter(v => v !== sup);
      syncSelectToFilter('filter-supplier', activeFilters.supplier);
      if (!activeFilters.supplier.length) {
        const el = $('filter-supplier');
        if (el) el.value = '';
      }
      applyFiltersAndSort();
      renderFilterChips();
      pushHashState();
    }});
  }

  for (const sex of activeFilters.sex) {
    chips.push({ label: `Sex: ${sex}`, remove: () => {
      activeFilters.sex = activeFilters.sex.filter(v => v !== sex);
      if (!activeFilters.sex.length) {
        const el = $('filter-sex');
        if (el) el.value = '';
      }
      applyFiltersAndSort();
      renderFilterChips();
      pushHashState();
    }});
  }

  for (const loc of activeFilters.location) {
    chips.push({ label: `Location: ${loc}`, remove: () => {
      activeFilters.location = activeFilters.location.filter(v => v !== loc);
      if (!activeFilters.location.length) {
        const el = $('filter-location');
        if (el) el.value = '';
      }
      applyFiltersAndSort();
      renderFilterChips();
      pushHashState();
    }});
  }

  if (activeFilters.priceMin != null) {
    chips.push({ label: `Price ≥ £${activeFilters.priceMin.toFixed(2)}`, remove: () => {
      activeFilters.priceMin = null;
      const el = $('filter-price-min');
      if (el) el.value = '';
      applyFiltersAndSort();
      renderFilterChips();
      pushHashState();
    }});
  }

  if (activeFilters.priceMax != null) {
    chips.push({ label: `Price ≤ £${activeFilters.priceMax.toFixed(2)}`, remove: () => {
      activeFilters.priceMax = null;
      const el = $('filter-price-max');
      if (el) el.value = '';
      applyFiltersAndSort();
      renderFilterChips();
      pushHashState();
    }});
  }

  if (chips.length === 0) {
    container.innerHTML = '';
    container.hidden = true;
    return;
  }

  container.hidden = false;
  container.innerHTML = '';

  for (const chip of chips) {
    const span = document.createElement('span');
    span.className = 'filter-chip';
    span.textContent = chip.label;

    const btn = document.createElement('button');
    btn.className = 'filter-chip-remove';
    btn.setAttribute('aria-label', `Remove filter: ${chip.label}`);
    btn.textContent = '×';
    btn.addEventListener('click', () => chip.remove());

    span.appendChild(btn);
    container.appendChild(span);
  }

  // "Clear all" button
  if (chips.length > 1) {
    const clearBtn = document.createElement('button');
    clearBtn.className = 'filter-chip filter-chip--clear';
    clearBtn.textContent = 'Clear all';
    clearBtn.addEventListener('click', () => {
      activeFilters = { supplier: [], sex: [], location: [], priceMin: null, priceMax: null };
      ['filter-supplier', 'filter-sex', 'filter-location'].forEach(id => {
        const el = $(id);
        if (el) el.value = '';
      });
      ['filter-price-min', 'filter-price-max'].forEach(id => {
        const el = $(id);
        if (el) el.value = '';
      });
      applyFiltersAndSort();
      renderFilterChips();
      pushHashState();
    });
    container.appendChild(clearBtn);
  }
}

// ── Sort ──────────────────────────────────────────────────────────────────────

/**
 * Updates `currentSort` and re-renders.
 * @param {string} sortKey
 */
function handleSort(sortKey) {
  currentSort = sortKey;
  applyFiltersAndSort();
  pushHashState();
}

/** Sorts `filteredSpecimens` in-place according to `currentSort`. */
function sortSpecimens() {
  filteredSpecimens.sort((a, b) => {
    switch (currentSort) {
      case 'latin_name':
        return (a.latin_name || '').localeCompare(b.latin_name || '');
      case 'supplier_name':
        return ((a.supplier_username || a.supplier_name) || '').localeCompare(
               (b.supplier_username || b.supplier_name) || '');
      case 'price_asc': {
        const pa = a.price_is_collected ? 0 : (a.price ?? Infinity);
        const pb = b.price_is_collected ? 0 : (b.price ?? Infinity);
        return pa - pb;
      }
      case 'price_desc': {
        const pa = a.price_is_collected ? 0 : (a.price ?? -Infinity);
        const pb = b.price_is_collected ? 0 : (b.price ?? -Infinity);
        return pb - pa;
      }
      case 'date_acquired':
        // Sort by most recent date_bought, then date_received
        return (b.date_bought || b.date_received || '').localeCompare(
               a.date_bought || a.date_received || '');
      case 'date_oldest':
        return (a.date_bought || a.date_received || '').localeCompare(
               b.date_bought || b.date_received || '');
      case 'english_name':
      default:
        return (a.english_name || '').localeCompare(b.english_name || '');
    }
  });
}

// ── Label selection ───────────────────────────────────────────────────────────

/**
 * Toggles whether a specimen ID is in the label selection set.
 * @param {string|number} id
 * @param {boolean}       selected
 */
function toggleLabelSelection(id, selected) {
  if (selected) selectedIds.add(id);
  else          selectedIds.delete(id);

  updateLabelButtonState();
}

/** Updates the Generate Labels button badge with selection count. */
function updateLabelButtonState() {
  const btn = $('btn-generate-labels');
  if (!btn) return;
  const n = selectedIds.size;
  btn.textContent = n > 0 ? `Generate Labels (${n})` : 'Generate Labels';
  btn.classList.toggle('has-selection', n > 0);
}

// ── Add specimen ──────────────────────────────────────────────────────────────

/**
 * Creates a blank new specimen record and opens it in the detail panel.
 * Uses a UUID-like ID prefixed with "sp_" + timestamp + random.
 */
async function addSpecimen() {
  const id = `sp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const newSpecimen = {
    id,
    english_name:        '',
    latin_name:          '',
    sex:                 '',
    description:         null,
    location:            '',
    altitude_m:          null,
    supplier_username:   '',
    supplier_name:       '',
    supplier_address:    null,
    price:               null,
    price_is_collected:  false,
    currency:            '£',
    date_bought:         '',
    date_sent:           '',
    date_received:       '',
    setting_board:       null,
    cat_number:          null,
    collector:           null,
    photos:              [],
    notes:               null,
  };

  try {
    await putSpecimen(newSpecimen);
    specimens = await getAllSpecimens();
    applyFiltersAndSort();
    await updateStats();
    renderDetailPanel(newSpecimen.id);
    showToast('New specimen added — fill in the details');

    // Auto-focus the english_name field after panel opens
    setTimeout(() => {
      const nameEl = detailPanel?.querySelector('[data-field="english_name"]');
      if (nameEl) nameEl.click();
    }, 300);
  } catch (err) {
    console.error('[app] addSpecimen failed:', err);
    showToast('Could not create specimen — see console', 'error');
  }
}

// ── Label generation ──────────────────────────────────────────────────────────

/**
 * Generates printable labels for the selected specimens.
 * Full jsPDF implementation is deferred to WP4.
 */
function generateLabels() {
  let selected;
  if (selectedIds.size === 0) {
    if (!confirm(`No specimens selected.\n\nGenerate labels for all ${filteredSpecimens.length} visible specimens?`)) return;
    selected = filteredSpecimens;
  } else {
    selected = specimens.filter(s => selectedIds.has(s.id));
  }
  const preview = generatePreview(selected);
  generateLabelsPDF(selected);
  showToast(`PDF downloaded — ${preview}`);
}

// ── Status bar ────────────────────────────────────────────────────────────────

/**
 * Updates the specimen count display.
 * @param {number} [total] — if omitted, uses specimens.length
 */
function updateSpecimenCountDisplay(total) {
  if (!specimenCount) return;
  const t = total ?? specimens.length;
  const shown = filteredSpecimens.length;
  specimenCount.textContent = shown === t
    ? `${t} specimen${t !== 1 ? 's' : ''}`
    : `Showing ${shown} of ${t} specimens`;
}

/** Shows a message in the status bar. @param {'info'|'error'} [type] */
/**
 * Measures the actual rendered heights of the header and toolbar,
 * then sets CSS custom properties so sticky elements stack correctly.
 */
function updateStickyOffsets() {
  const header = document.querySelector('.app-header');
  const toolbar = document.querySelector('.toolbar');
  if (!header || !toolbar) return;
  const headerH = header.offsetHeight;
  const toolbarH = toolbar.offsetHeight;
  const root = document.documentElement;
  root.style.setProperty('--header-h', headerH + 'px');
  root.style.setProperty('--header-toolbar-h', (headerH + toolbarH) + 'px');
}

function showStatus(message, type = 'info') {
  if (!statusBar) return;
  statusBar.textContent = message;
  statusBar.className   = `status-bar status-bar--${type}`;
}

// ── Toast notifications ───────────────────────────────────────────────────────

let _toastTimer = null;

/**
 * Shows a brief toast notification.
 * @param {string} message
 * @param {'info'|'error'} [type]
 */
function showToast(message, type = 'info') {
  if (!toastEl) return;
  clearTimeout(_toastTimer);
  toastEl.textContent = message;
  toastEl.className   = `toast toast--${type} toast--visible`;
  _toastTimer = setTimeout(() => toastEl.classList.remove('toast--visible'), 2800);
}

// ── Export / Import ────────────────────────────────────────────────────

async function handleExport() {
  try {
    const json = await exportJSON();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `butterfly-collection-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Collection exported');
  } catch (err) {
    console.error('[app] export failed:', err);
    showToast('Export failed — see console', 'error');
  }
}

async function handleImport(file) {
  if (!file) return;
  if (!confirm('This will REPLACE your entire collection. Are you sure?')) return;
  try {
    const text = await file.text();
    const count = await importJSON(text);
    specimens = await getAllSpecimens();
    applyFiltersAndSort();
    await updateStats();
    buildFilterOptions();
    closeDetailPanel();
    showToast(`Imported ${count} specimens`);
  } catch (err) {
    console.error('[app] import failed:', err);
    showToast('Import failed — see console', 'error');
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

/** HTML-escapes a string to prevent XSS. */
function escHtml(str) {
  return (str ?? '').toString()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Maps a field key to a human-readable label for toast messages. */
function fieldLabel(field) {
  const labels = {
    english_name:      'Name',
    latin_name:        'Latin name',
    sex:               'Sex',
    description:       'Description',
    location:          'Location',
    altitude_m:        'Altitude',
    supplier_username: 'Supplier username',
    supplier_name:     'Supplier name',
    supplier_address:  'Supplier address',
    price:             'Price',
    price_is_collected:'Collected status',
    currency:          'Currency',
    date_bought:       'Date bought',
    date_sent:         'Date sent',
    date_received:     'Date received',
    setting_board:     'Setting board',
    cat_number:        'Catalogue number',
    collector:         'Collector',
    notes:             'Notes',
  };
  return labels[field] || field;
}

// ── Event wiring ──────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  init();

  // Recalculate sticky offsets on resize (header height may change)
  window.addEventListener('resize', updateStickyOffsets);

  // Search — debounced 200 ms
  let searchTimer;
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => handleSearch(searchInput.value), 200);
    });
  }

  // Filter dropdowns (single-select)
  ['filter-supplier', 'filter-sex', 'filter-location'].forEach(id => {
    const el = $(id);
    if (el) el.addEventListener('change', () => handleFilter());
  });

  // Price range inputs — debounced 300ms
  let priceTimer;
  ['filter-price-min', 'filter-price-max'].forEach(id => {
    const el = $(id);
    if (el) {
      el.addEventListener('input', () => {
        clearTimeout(priceTimer);
        priceTimer = setTimeout(() => handleFilter(), 300);
      });
    }
  });

  // Sort dropdown
  const sortEl = $('sort-select');
  if (sortEl) sortEl.addEventListener('change', e => handleSort(e.target.value));

  // Add Specimen button
  const addBtn = $('btn-add-specimen');
  if (addBtn) addBtn.addEventListener('click', addSpecimen);

  // Generate Labels button
  const labelsBtn = $('btn-generate-labels');
  if (labelsBtn) labelsBtn.addEventListener('click', generateLabels);

  // Export button
  const exportBtn = $('btn-export');
  if (exportBtn) exportBtn.addEventListener('click', handleExport);

  // Import button + hidden file input
  const importBtn = $('btn-import');
  const importInput = $('import-file-input');
  if (importBtn && importInput) {
    importBtn.addEventListener('click', () => importInput.click());
    importInput.addEventListener('change', () => {
      if (importInput.files.length) handleImport(importInput.files[0]);
      importInput.value = '';
    });
  }

  // View toggle buttons
  document.querySelectorAll('.view-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.view;
      if (view === currentView) return;
      currentView = view;
      document.querySelectorAll('.view-btn').forEach(b => b.classList.remove('view-btn--active'));
      btn.classList.add('view-btn--active');
      renderView();
      pushHashState();
    });
  });

  // Close detail panel when clicking the backdrop (outside panel, not on a card or table row)
  document.addEventListener('click', e => {
    if (detailPanel && detailPanel.classList.contains('open')) {
      if (!detailPanel.contains(e.target) &&
          !e.target.closest('.specimen-card') &&
          !e.target.closest('tr[data-id]')) {
        closeDetailPanel();
      }
    }
  });

  // Keyboard: Escape closes detail panel (when not in an edit field)
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !e.target.classList.contains('edit-input')) {
      closeDetailPanel();
    }
  });
});
