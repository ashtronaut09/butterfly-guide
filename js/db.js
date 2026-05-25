/**
 * db.js — IndexedDB wrapper for Butterfly Collection Manager
 *
 * Database: ButterflyCollection  v1
 * Store:    specimens  (keyPath: id)
 * Indexes:  english_name, latin_name, supplier_name, location, sex, price
 */

const DB_NAME    = 'ButterflyCollection';
const DB_VERSION = 1;
const STORE      = 'specimens';

let _db = null;

// ── Open / upgrade ──────────────────────────────────────────────────────────

/**
 * Opens (or upgrades) the ButterflyCollection IndexedDB database.
 * Safe to call multiple times — reuses the cached connection.
 * @returns {Promise<IDBDatabase>}
 */
export function openDB() {
  if (_db) return Promise.resolve(_db);

  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const db    = e.target.result;
      const store = db.createObjectStore(STORE, { keyPath: 'id' });

      // Indexes used by filter dropdowns and sort operations
      store.createIndex('english_name',  'english_name',  { unique: false });
      store.createIndex('latin_name',    'latin_name',    { unique: false });
      store.createIndex('supplier_name', 'supplier_name', { unique: false });
      store.createIndex('location',      'location',      { unique: false });
      store.createIndex('sex',           'sex',           { unique: false });
      store.createIndex('price',         'price',         { unique: false });
    };

    req.onsuccess = (e) => {
      _db = e.target.result;

      // Handle connection being invalidated if the tab is stale
      _db.onversionchange = () => {
        _db.close();
        _db = null;
      };

      resolve(_db);
    };

    req.onerror = () => reject(req.error);
  });
}

// ── Internal helper ──────────────────────────────────────────────────────────

/**
 * Returns a transaction + object store in one call.
 * @param {'readonly'|'readwrite'} mode
 */
function getStore(mode = 'readonly') {
  const db = _db;
  if (!db) throw new Error('DB not open — call openDB() first');
  const tx = db.transaction(STORE, mode);
  return tx.objectStore(STORE);
}

/** Wraps an IDBRequest in a Promise. */
function reqPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

/**
 * Returns all specimens sorted alphabetically by english_name.
 * @returns {Promise<Object[]>}
 */
export async function getAllSpecimens() {
  const store = getStore('readonly');
  const idx   = store.index('english_name');
  return reqPromise(idx.getAll());
}

/**
 * Returns a single specimen by its id, or undefined if not found.
 * @param {string|number} id
 * @returns {Promise<Object|undefined>}
 */
export async function getSpecimen(id) {
  return reqPromise(getStore('readonly').get(id));
}

/**
 * Inserts or updates a specimen (upsert via IDB put).
 * The specimen object must include an `id` field.
 * @param {Object} specimen
 * @returns {Promise<string|number>}  resolves to the stored key
 */
export async function putSpecimen(specimen) {
  return reqPromise(getStore('readwrite').put(specimen));
}

/**
 * Deletes a specimen by id. No-op if the id does not exist.
 * @param {string|number} id
 * @returns {Promise<void>}
 */
export async function deleteSpecimen(id) {
  return reqPromise(getStore('readwrite').delete(id));
}

// ── Search ────────────────────────────────────────────────────────────────────

/**
 * Full-text search across all text fields of every specimen.
 * Scans english_name, latin_name, supplier_name, location, sex, notes, and
 * any other string-valued top-level fields.
 *
 * @param {string} query  — case-insensitive substring match
 * @returns {Promise<Object[]>}
 */
export async function searchSpecimens(query) {
  if (!query || !query.trim()) return getAllSpecimens();

  const q   = query.trim().toLowerCase();
  const all = await getAllSpecimens();

  return all.filter(s => {
    // Collect every string value on the specimen and search them all
    return Object.values(s).some(v => {
      if (typeof v === 'string') return v.toLowerCase().includes(q);
      if (typeof v === 'number') return String(v).includes(q);
      return false;
    });
  });
}

// ── Import / Export ───────────────────────────────────────────────────────────

/**
 * Serialises the entire collection as a JSON string.
 * @returns {Promise<string>}
 */
export async function exportJSON() {
  const all = await getAllSpecimens();
  return JSON.stringify(all, null, 2);
}

/**
 * Clears the entire specimens store and replaces it with the records
 * contained in the provided JSON string.
 *
 * @param {string} jsonString  — must be a JSON array of specimen objects
 * @returns {Promise<number>}  — count of records imported
 */
export async function importJSON(jsonString) {
  const records = JSON.parse(jsonString);
  if (!Array.isArray(records)) throw new TypeError('JSON must be an array of specimen objects');

  const db  = _db;
  const tx  = db.transaction(STORE, 'readwrite');
  const st  = tx.objectStore(STORE);

  // Clear existing data first
  await reqPromise(st.clear());

  // Batch insert
  for (const rec of records) {
    st.put(rec); // fire-and-forget inside the same transaction
  }

  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(records.length);
    tx.onerror    = () => reject(tx.error);
  });
}

// ── Stats ─────────────────────────────────────────────────────────────────────

/**
 * Returns summary counts for the status bar.
 * @returns {Promise<{ total: number, suppliers: number, locations: number }>}
 */
export async function getStats() {
  const all       = await getAllSpecimens();
  const suppliers = new Set(all.map(s => s.supplier_name).filter(Boolean));
  const locations = new Set(all.map(s => s.location).filter(Boolean));

  return {
    total:     all.length,
    suppliers: suppliers.size,
    locations: locations.size,
  };
}

// ── Seed ──────────────────────────────────────────────────────────────────────

/**
 * Fetches `url`, parses it as JSON, and seeds the DB if it is currently empty.
 * Skips entirely if there are already records (idempotent).
 *
 * Progress is reported via an optional callback:
 *   onProgress(loaded: number, total: number)
 *
 * @param {string}   url
 * @param {Function} [onProgress]  — called with (loaded, total) after each batch
 * @returns {Promise<{ seeded: boolean, count: number }>}
 */
export async function seedFromJSON(url, onProgress) {
  // 1. Check if the store already has records — never overwrite existing data
  const existing = await reqPromise(getStore('readonly').count());
  if (existing > 0) {
    return { seeded: false, count: existing };
  }

  // 2. Fetch the seed file
  let records;
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
    records = await resp.json();
  } catch (err) {
    console.warn('[db] seedFromJSON: could not load seed file —', err.message);
    return { seeded: false, count: 0 };
  }

  if (!Array.isArray(records) || records.length === 0) {
    console.warn('[db] seedFromJSON: seed file is empty or not an array');
    return { seeded: false, count: 0 };
  }

  // 3. Insert in batches of 100 so progress callbacks feel responsive
  const BATCH = 100;
  let loaded  = 0;

  for (let i = 0; i < records.length; i += BATCH) {
    const chunk = records.slice(i, i + BATCH);
    const db    = _db;
    const tx    = db.transaction(STORE, 'readwrite');
    const st    = tx.objectStore(STORE);

    for (const rec of chunk) st.put(rec);

    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror    = () => reject(tx.error);
    });

    loaded += chunk.length;
    if (typeof onProgress === 'function') onProgress(loaded, records.length);
  }

  console.log(`[db] seeded ${loaded} specimens from ${url}`);
  return { seeded: true, count: loaded };
}
