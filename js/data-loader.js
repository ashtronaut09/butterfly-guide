// Loads species.json and builds indexes for fast filtering
let allSpecies = [];

const indexes = {
  byFamily: {},
  byColor: {},
  bySize: {},
  byPattern: {},
  byFlight: {},
  byHabitat: {},
  byRegion: {},
};

export async function loadData() {
  const res = await fetch('data/species.json');
  if (!res.ok) throw new Error(`Failed to load species data: ${res.status}`);
  allSpecies = await res.json();
  buildIndexes();
  return allSpecies;
}

function buildIndexes() {
  for (const [key] of Object.entries(indexes)) {
    indexes[key] = {};
  }

  for (const sp of allSpecies) {
    const t = sp.tags || {};

    addToIndex(indexes.byFamily, sp.family, sp.id);

    for (const c of t.colors || []) addToIndex(indexes.byColor, c, sp.id);
    if (t.size) addToIndex(indexes.bySize, t.size, sp.id);
    for (const p of t.patterns || []) addToIndex(indexes.byPattern, p, sp.id);
    for (const f of t.flight_period || []) addToIndex(indexes.byFlight, f, sp.id);
    for (const h of t.habitat || []) addToIndex(indexes.byHabitat, h, sp.id);
    for (const r of t.region || []) addToIndex(indexes.byRegion, r, sp.id);
  }
}

function addToIndex(index, key, id) {
  if (!index[key]) index[key] = new Set();
  index[key].add(id);
}

export function getFilterOptions() {
  return {
    family:  sortedKeys(indexes.byFamily),
    color:   sortedKeys(indexes.byColor),
    size:    ['tiny', 'small', 'medium', 'large', 'very-large'],
    pattern: sortedKeys(indexes.byPattern),
    flight:  ['spring', 'summer', 'autumn', 'winter'],
    habitat: sortedKeys(indexes.byHabitat),
    region:  ['northern', 'western', 'central', 'southern', 'eastern'],
  };
}

function sortedKeys(index) {
  return Object.keys(index).sort();
}

export function getCountsFor(axis) {
  return indexes[`by${capitalize(axis)}`] || {};
}

function capitalize(s) {
  // map filter axis names to index names
  const map = { family: 'Family', color: 'Color', size: 'Size', pattern: 'Pattern', flight: 'Flight', habitat: 'Habitat', region: 'Region' };
  return map[s] || s;
}

export function filterSpecies({ family, color, size, pattern, flight, habitat, region, search, sort, groupBy }) {
  let results = allSpecies;

  // Text search
  if (search) {
    const q = search.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    results = results.filter(sp => {
      const common = (sp.common_name || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
      const sci    = (sp.scientific_name || '').toLowerCase();
      const fam    = (sp.family || '').toLowerCase();
      return common.includes(q) || sci.includes(q) || fam.includes(q);
    });
  }

  // Multi-select filters — within category: OR; across categories: AND
  if (family?.length)  results = results.filter(sp => family.includes(sp.family));
  if (color?.length)   results = results.filter(sp => (sp.tags?.colors || []).some(c => color.includes(c)));
  if (size?.length)    results = results.filter(sp => size.includes(sp.tags?.size));
  if (pattern?.length) results = results.filter(sp => (sp.tags?.patterns || []).some(p => pattern.includes(p)));
  if (flight?.length)  results = results.filter(sp => (sp.tags?.flight_period || []).some(f => flight.includes(f)));
  if (habitat?.length) results = results.filter(sp => (sp.tags?.habitat || []).some(h => habitat.includes(h)));
  if (region?.length)  results = results.filter(sp => (sp.tags?.region || []).some(r => region.includes(r)));

  // Sort
  const sizeOrder = { tiny: 0, small: 1, medium: 2, large: 3, 'very-large': 4 };
  results = [...results].sort((a, b) => {
    switch (sort) {
      case 'common':   return (a.common_name || '').localeCompare(b.common_name || '');
      case 'sci':      return a.scientific_name.localeCompare(b.scientific_name);
      case 'family':   return a.family.localeCompare(b.family) || (a.common_name || '').localeCompare(b.common_name || '');
      case 'size-asc': return (sizeOrder[a.tags?.size] || 0) - (sizeOrder[b.tags?.size] || 0);
      case 'size-desc':return (sizeOrder[b.tags?.size] || 0) - (sizeOrder[a.tags?.size] || 0);
      case 'obs':      return (b.observation_count || 0) - (a.observation_count || 0);
      default:         return (a.common_name || '').localeCompare(b.common_name || '');
    }
  });

  // Group
  if (groupBy) {
    return groupResults(results, groupBy);
  }

  return { flat: results };
}

function groupResults(results, groupBy) {
  const groups = {};
  for (const sp of results) {
    let keys = [];
    switch (groupBy) {
      case 'family':  keys = [sp.family || 'Unknown']; break;
      case 'color':   keys = sp.tags?.colors?.slice(0, 1) || ['Other']; break;
      case 'size':    keys = [sp.tags?.size || 'unknown']; break;
      case 'pattern': keys = sp.tags?.patterns?.slice(0, 1) || ['Other']; break;
      case 'habitat': keys = sp.tags?.habitat?.slice(0, 1) || ['Other']; break;
      default:        keys = [sp.family || 'Unknown'];
    }
    for (const key of keys) {
      if (!groups[key]) groups[key] = [];
      groups[key].push(sp);
    }
  }
  return { grouped: Object.entries(groups).sort(([a], [b]) => a.localeCompare(b)) };
}
