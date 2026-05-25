import { loadData, getFilterOptions, filterSpecies } from './data-loader.js';

// ── State ──────────────────────────────────────────────────────────────
const state = {
  filters: { family: [], color: [], size: [], pattern: [], flight: [], habitat: [], region: [] },
  search: '',
  sort: 'common',
  view: 'grid',
  groupBy: null,
  allSpecies: [],
  filtered: [],
  openDropdown: null,
};

// ── DOM refs ────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const grid          = $('grid');
const loading       = $('loading');
const resultCount   = $('result-count');
const searchInput   = $('search');
const activeFilters = $('active-filters');
const modalOverlay  = $('modal-overlay');
const modal         = $('modal');
const modalClose    = $('modal-close');

// ── Filter config ────────────────────────────────────────────────────────
const FILTER_LABELS = {
  family:  'Family',
  color:   'Color',
  size:    'Size',
  pattern: 'Pattern',
  flight:  'Season',
  habitat: 'Habitat',
  region:  'Region',
};

const DISPLAY_LABELS = {
  // size
  'tiny':       'Tiny (< 25mm)',
  'small':      'Small (25–35mm)',
  'medium':     'Medium (35–55mm)',
  'large':      'Large (55–75mm)',
  'very-large': 'Very Large (75mm+)',
  // flight
  'spring': 'Spring',
  'summer': 'Summer',
  'autumn': 'Autumn',
  'winter': 'Winter',
  // habitat
  'woodland':  'Woodland',
  'meadow':    'Meadow',
  'grassland': 'Grassland',
  'mountain':  'Mountain',
  'wetland':   'Wetland',
  'garden':    'Garden',
  'coast':     'Coast',
  // region
  'northern': 'Northern Europe',
  'western':  'Western Europe',
  'central':  'Central Europe',
  'southern': 'Southern Europe',
  'eastern':  'Eastern Europe',
  // pattern
  'eyespots':   'Eyespots',
  'spotted':    'Spotted',
  'striped':    'Striped',
  'checkered':  'Checkered',
  'iridescent': 'Iridescent',
  'tailed':     'Tailed',
  'plain':      'Plain',
  // colors (capitalize)
};

function displayLabel(key) {
  return DISPLAY_LABELS[key] || key.charAt(0).toUpperCase() + key.slice(1);
}

const STATUS_LABELS = {
  'LC':  'Least Concern',
  'NT':  'Near Threatened',
  'VU':  'Vulnerable',
  'EN':  'Endangered',
  'CR':  'Critically Endangered',
  'EX':  'Extinct',
  'EW':  'Extinct in Wild',
  'DD':  'Data Deficient',
};

// ── Init ────────────────────────────────────────────────────────────────
async function init() {
  try {
    state.allSpecies = await loadData();
    loading.style.display = 'none';
    buildFilterBar();
    readUrlState();
    render();
  } catch (e) {
    loading.innerHTML = `<span style="color:#c0392b">Failed to load species data. Run fetch-data.py first.<br><small>${e.message}</small></span>`;
  }
}

// ── URL state ────────────────────────────────────────────────────────────
function readUrlState() {
  const hash = location.hash.slice(1);
  if (!hash) return;
  const params = new URLSearchParams(hash);
  for (const axis of Object.keys(state.filters)) {
    const v = params.get(axis);
    if (v) state.filters[axis] = v.split(',').filter(Boolean);
  }
  if (params.get('q'))    state.search  = params.get('q');
  if (params.get('sort')) state.sort    = params.get('sort');
  if (params.get('view')) state.view    = params.get('view');
  if (params.get('group'))state.groupBy = params.get('group') || null;
}

function updateUrlState() {
  const params = new URLSearchParams();
  for (const [axis, vals] of Object.entries(state.filters)) {
    if (vals.length) params.set(axis, vals.join(','));
  }
  if (state.search)  params.set('q', state.search);
  if (state.sort !== 'common') params.set('sort', state.sort);
  if (state.view !== 'grid')   params.set('view', state.view);
  if (state.groupBy) params.set('group', state.groupBy);
  history.replaceState(null, '', '#' + params.toString());
}

// ── Filter bar ─────────────────────────────────────────────────────────
function buildFilterBar() {
  const bar = $('filter-bar');
  bar.innerHTML = '';
  const options = getFilterOptions();

  for (const axis of Object.keys(FILTER_LABELS)) {
    const opts = options[axis] || [];
    const group = document.createElement('div');
    group.className = 'filter-group';
    group.dataset.axis = axis;

    const btn = document.createElement('button');
    btn.className = 'filter-btn';
    btn.dataset.axis = axis;
    btn.innerHTML = `${FILTER_LABELS[axis]} <span class="chevron">▾</span>`;
    btn.addEventListener('click', e => { e.stopPropagation(); toggleDropdown(axis); });

    const dropdown = document.createElement('div');
    dropdown.className = 'filter-dropdown';
    dropdown.id = `dd-${axis}`;

    for (const opt of opts) {
      const item = document.createElement('div');
      item.className = 'filter-option';
      item.dataset.axis = axis;
      item.dataset.value = opt;
      item.innerHTML = `
        <span class="check">${state.filters[axis].includes(opt) ? '✓' : ''}</span>
        <span>${displayLabel(opt)}</span>
        <span class="option-count" data-axis="${axis}" data-val="${opt}"></span>
      `;
      item.addEventListener('click', e => { e.stopPropagation(); toggleFilter(axis, opt); });
      dropdown.appendChild(item);
    }

    group.appendChild(btn);
    group.appendChild(dropdown);
    bar.appendChild(group);
  }
}

function toggleDropdown(axis) {
  if (state.openDropdown === axis) {
    closeDropdown();
    return;
  }
  closeDropdown();
  state.openDropdown = axis;
  document.querySelector(`[data-axis="${axis}"].filter-btn`)?.classList.add('open');
  document.getElementById(`dd-${axis}`)?.classList.add('open');
}

function closeDropdown() {
  if (state.openDropdown) {
    document.querySelector(`[data-axis="${state.openDropdown}"].filter-btn`)?.classList.remove('open');
    document.getElementById(`dd-${state.openDropdown}`)?.classList.remove('open');
    state.openDropdown = null;
  }
}

document.addEventListener('click', closeDropdown);

function toggleFilter(axis, value) {
  const arr = state.filters[axis];
  const idx = arr.indexOf(value);
  if (idx === -1) arr.push(value);
  else arr.splice(idx, 1);
  render();
}

function updateFilterUI() {
  // Active state on buttons
  for (const axis of Object.keys(FILTER_LABELS)) {
    const btn = document.querySelector(`[data-axis="${axis}"].filter-btn`);
    if (btn) btn.classList.toggle('active', state.filters[axis].length > 0);
  }

  // Checkboxes
  document.querySelectorAll('.filter-option').forEach(item => {
    const { axis, value } = item.dataset;
    const selected = state.filters[axis]?.includes(value);
    item.classList.toggle('selected', selected);
    item.querySelector('.check').textContent = selected ? '✓' : '';
  });

  // Active filter chips
  activeFilters.innerHTML = '';
  for (const [axis, vals] of Object.entries(state.filters)) {
    for (const val of vals) {
      const chip = document.createElement('div');
      chip.className = 'chip';
      chip.innerHTML = `<span>${FILTER_LABELS[axis]}: ${displayLabel(val)}</span><button aria-label="Remove">×</button>`;
      chip.querySelector('button').addEventListener('click', () => toggleFilter(axis, val));
      activeFilters.appendChild(chip);
    }
  }
}

function updateCounts(filtered) {
  // Count per option based on current filtered set
  const countMap = {};
  for (const sp of filtered) {
    const t = sp.tags || {};
    addCount(countMap, 'family', sp.family);
    for (const c of t.colors || [])       addCount(countMap, 'color', c);
    addCount(countMap, 'size', t.size);
    for (const p of t.patterns || [])     addCount(countMap, 'pattern', p);
    for (const f of t.flight_period || []) addCount(countMap, 'flight', f);
    for (const h of t.habitat || [])      addCount(countMap, 'habitat', h);
    for (const r of t.region || [])       addCount(countMap, 'region', r);
  }

  document.querySelectorAll('.option-count').forEach(el => {
    const key = `${el.dataset.axis}:${el.dataset.val}`;
    el.textContent = countMap[key] ? `(${countMap[key]})` : '';
  });
}

function addCount(map, axis, val) {
  if (!val) return;
  const key = `${axis}:${val}`;
  map[key] = (map[key] || 0) + 1;
}

// ── Render ──────────────────────────────────────────────────────────────
function render() {
  const result = filterSpecies({
    ...state.filters,
    search:  state.search,
    sort:    state.sort,
    groupBy: state.view === 'grouped' ? (state.groupBy || 'family') : null,
  });

  const flatList = result.flat || result.grouped?.flatMap(([, items]) => items) || [];
  state.filtered = flatList;
  resultCount.textContent = `Showing ${flatList.length} of ${state.allSpecies.length} species`;

  updateFilterUI();
  updateCounts(flatList);
  updateUrlState();
  renderGrid(result);
  updateViewBtns();
}

function renderGrid(result) {
  grid.innerHTML = '';

  if (result.flat) {
    if (!result.flat.length) {
      grid.innerHTML = `<div id="empty-state" style="display:block;grid-column:1/-1;text-align:center;padding:60px 20px;color:var(--text-muted)">
        <h3>No species found</h3><p>Try adjusting your filters or search term.</p></div>`;
      return;
    }
    result.flat.forEach(sp => grid.appendChild(makeCard(sp)));
    return;
  }

  if (result.grouped) {
    if (!result.grouped.length) {
      grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:60px 20px;color:var(--text-muted)"><h3>No species found</h3></div>`;
      return;
    }
    for (const [groupKey, items] of result.grouped) {
      const heading = document.createElement('div');
      heading.className = 'group-heading';
      heading.textContent = `${displayLabel(groupKey)} (${items.length})`;
      grid.appendChild(heading);
      items.forEach(sp => grid.appendChild(makeCard(sp)));
    }
  }
}

function makeCard(sp) {
  const card = document.createElement('div');
  card.className = 'card';
  card.dataset.id = sp.id;

  const t = sp.tags || {};
  const colorTags = (t.colors || []).slice(0, 2).map(c =>
    `<span class="tag tag-${c}">${displayLabel(c)}</span>`
  ).join('');
  const sizePill = t.size ? `<span class="tag tag-size">${displayLabel(t.size)}</span>` : '';

  const imgSrc = sp.image_url || sp.image_local;
  const imgMedium = imgSrc ? imgSrc.replace('/large.jpg', '/medium.jpg') : '';
  const imgEl = imgSrc
    ? `<img class="card-img" src="${imgSrc}" alt="${escHtml(sp.common_name)}" loading="lazy" onerror="if(this.src.includes('/large.')){this.src=this.src.replace('/large.jpg','/medium.jpg')}else{this.style.display='none';this.nextElementSibling.style.display='flex'}">`
    : '';
  const imgFallback = `<div class="card-img no-image" style="display:${imgSrc ? 'none' : 'flex'}">🦋</div>`;

  card.innerHTML = `
    ${imgEl}${imgFallback}
    <div class="card-body">
      <div class="card-common">${escHtml(sp.common_name || sp.scientific_name)}</div>
      <div class="card-sci">${escHtml(sp.scientific_name)}</div>
      <span class="card-family">${escHtml(sp.family)}</span>
      <div class="tags">${colorTags}${sizePill}</div>
    </div>
  `;

  card.addEventListener('click', () => openModal(sp));
  return card;
}

// ── Modal ───────────────────────────────────────────────────────────────
function openModal(sp) {
  const t = sp.tags || {};
  const imgSrc = sp.image_url || sp.image_local || '';

  const modalImg = modal.querySelector('#modal-img');
  if (imgSrc) {
    modalImg.src = imgSrc;
    modalImg.alt = sp.common_name;
    modalImg.style.display = 'block';
    modalImg.onerror = () => {
      if (modalImg.src.includes('/large.')) {
        modalImg.src = modalImg.src.replace('/large.jpg', '/medium.jpg');
      } else {
        modalImg.style.display = 'none';
      }
    };
  } else {
    modalImg.style.display = 'none';
  }

  const statusCode = sp.conservation_status || '';
  const statusLabel = STATUS_LABELS[statusCode] || statusCode || 'Unknown';
  const statusClass = statusCode ? `tag-status-${statusCode.toLowerCase()}` : '';

  const allTags = [
    ...(t.colors || []).map(c => `<span class="tag tag-${c}">${displayLabel(c)}</span>`),
    t.size ? `<span class="tag tag-size">${displayLabel(t.size)}${t.size_label ? ' · ' + t.size_label : ''}</span>` : '',
    ...(t.patterns || []).map(p => `<span class="tag tag-pattern">${displayLabel(p)}</span>`),
    ...(t.habitat || []).map(h => `<span class="tag tag-habitat">${displayLabel(h)}</span>`),
    ...(t.flight_period || []).map(f => `<span class="tag tag-flight">${displayLabel(f)}</span>`),
    ...(t.region || []).map(r => `<span class="tag tag-region">${displayLabel(r)}</span>`),
  ].filter(Boolean).join('');

  const wikiLink = sp.wikipedia_url
    ? `<a href="${sp.wikipedia_url}" target="_blank" rel="noopener" class="modal-links-a link-wiki">Wikipedia ↗</a>` : '';
  const inatLink = `<a href="${sp.inaturalist_url}" target="_blank" rel="noopener" class="modal-links-a link-inat">iNaturalist ↗</a>`;

  modal.querySelector('#modal-body').innerHTML = `
    <div class="modal-common">${escHtml(sp.common_name || sp.scientific_name)}</div>
    <div class="modal-sci">${escHtml(sp.scientific_name)}</div>

    <div class="spec-grid">
      <span class="spec-label">Family</span>
      <span class="spec-value">${escHtml(sp.family)}${sp.subfamily ? ' › ' + escHtml(sp.subfamily) : ''}</span>

      <span class="spec-label">Wingspan</span>
      <span class="spec-value">${t.size_label || '–'} · ${displayLabel(t.size || '–')}</span>

      <span class="spec-label">Flight season</span>
      <span class="spec-value">${(t.flight_period || []).map(displayLabel).join(', ') || '–'}</span>

      <span class="spec-label">Habitat</span>
      <span class="spec-value">${(t.habitat || []).map(displayLabel).join(', ') || '–'}</span>

      <span class="spec-label">Range</span>
      <span class="spec-value">${(t.region || []).map(displayLabel).join(', ') || '–'}</span>

      <span class="spec-label">Conservation</span>
      <span class="spec-value"><span class="tag ${statusClass}">${escHtml(statusLabel)}</span></span>

      <span class="spec-label">Observations</span>
      <span class="spec-value">${sp.observation_count?.toLocaleString() || '–'} on iNaturalist</span>
    </div>

    <div class="modal-tags">${allTags}</div>
    <div style="font-size:0.72rem;color:var(--text-light);margin-top:-6px">Colors refer to upperside wing markings — photos may show underside</div>

    ${sp.wikipedia_summary ? `<div class="modal-summary">${escHtml(stripHtml(sp.wikipedia_summary))}</div>` : ''}

    <div class="modal-links">${inatLink}${wikiLink}</div>

    ${sp.image_attribution
      ? `<div class="modal-attribution">📷 ${escHtml(cleanAttribution(sp.image_attribution))}${sp.image_license ? ' · ' + escHtml(sp.image_license.toUpperCase()) : ''}</div>`
      : ''}
  `;

  modalOverlay.classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeModal() {
  modalOverlay.classList.remove('open');
  document.body.style.overflow = '';
}

modalClose.addEventListener('click', closeModal);
modalOverlay.addEventListener('click', e => { if (e.target === modalOverlay) closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

// ── Search ───────────────────────────────────────────────────────────────
let searchTimeout;
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    state.search = searchInput.value.trim();
    render();
  }, 200);
});

// ── Sort & view controls ─────────────────────────────────────────────────
$('sort-select').addEventListener('change', e => {
  state.sort = e.target.value;
  render();
});

$('groupby-select').addEventListener('change', e => {
  state.groupBy = e.target.value;
  render();
});

document.querySelectorAll('.view-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    state.view = btn.dataset.view;
    document.querySelector('.groupby-wrap').classList.toggle('visible', state.view === 'grouped');
    render();
  });
});

function updateViewBtns() {
  document.querySelectorAll('.view-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === state.view);
  });
}

// ── Util ─────────────────────────────────────────────────────────────────
function escHtml(str) {
  return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function cleanAttribution(str) {
  // iNaturalist attribution strings are like "(c) Name, some rights reserved (CC BY), uploaded by Name"
  // Extract just the photographer name
  const match = (str || '').match(/^\(c\)\s+(.+?),\s+(?:some rights|all rights|no rights)/i);
  if (match) return match[1].trim();
  // Fallback: strip "(c)" prefix and trailing license text
  return str.replace(/^\(c\)\s*/i, '').replace(/,?\s*some rights reserved.*$/i, '').trim();
}

function stripHtml(str) {
  return (str || '').replace(/<[^>]*>/g, '').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&').replace(/&quot;/g,'"').trim();
}

// ── Start ─────────────────────────────────────────────────────────────────
init();
