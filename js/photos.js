/**
 * photos.js — Photo management module for Butterfly Collection Manager
 *
 * Uses a SEPARATE IndexedDB database (ButterflyPhotos, v1) to avoid version
 * conflicts with the existing ButterflyCollection database. Photos are stored
 * as blobs — NOT file references — so the app works locally via file:// or
 * local server without a backend.
 *
 * Database: ButterflyPhotos  v1
 * Store:    photos  (keyPath: id)
 * Index:    specimenId
 */

// ── Database constants ────────────────────────────────────────────────────────

const DB_NAME    = 'ButterflyPhotos';
const DB_VERSION = 1;
const STORE      = 'photos';

let _db = null;

// ══════════════════════════════════════════════════════════════════════════════
//  Database initialisation
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Ensures the "photos" object store exists in the ButterflyPhotos database.
 * Safe to call multiple times — reuses the cached connection.
 * Must be called before any other function in this module.
 *
 * @returns {Promise<IDBDatabase>}
 */
export async function initPhotoDB() {
  if (_db) return _db;

  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('specimenId', 'specimenId', { unique: false });
      }
    };

    req.onsuccess = (e) => {
      _db = e.target.result;

      // If another tab opens a higher version, close this connection
      _db.onversionchange = () => {
        _db.close();
        _db = null;
      };

      resolve(_db);
    };

    req.onerror = () => reject(req.error);
  });
}

// ══════════════════════════════════════════════════════════════════════════════
//  Internal helpers
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Returns a transaction + object store from the photo DB.
 * @param {'readonly'|'readwrite'} mode
 * @returns {IDBObjectStore}
 */
function getStore(mode = 'readonly') {
  const db = _db;
  if (!db) throw new Error('Photo DB not open — call initPhotoDB() first');
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

/** Generates a unique photo ID string. */
function generateId() {
  return `photo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ══════════════════════════════════════════════════════════════════════════════
//  Thumbnail creation
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Creates a JPEG thumbnail from an image blob using an offscreen <canvas>.
 *
 * @param {Blob}  blob           — source image blob (File or Blob)
 * @param {number} [maxWidth=300] — maximum width in pixels; height scales
 *                                   proportionally
 * @returns {Promise<Blob>}       — JPEG blob at quality 0.8
 */
export async function createThumbnail(blob, maxWidth = 300) {
  if (!blob || !(blob instanceof Blob)) {
    throw new TypeError('createThumbnail: expected a Blob');
  }

  const url = URL.createObjectURL(blob);

  try {
    // Load the image into an <img> element so we can read its dimensions
    const img = await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload  = () => resolve(image);
      image.onerror = () => reject(new Error('Failed to decode image for thumbnail'));
      image.src     = url;
    });

    // Calculate dimensions preserving aspect ratio
    const scale = maxWidth / img.width;
    const w     = maxWidth;
    const h     = Math.round(img.height * scale) || 1; // guard against 0

    const canvas = document.createElement('canvas');
    canvas.width  = w;
    canvas.height = h;

    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not obtain canvas 2D context');

    ctx.drawImage(img, 0, 0, w, h);

    return await new Promise((resolve, reject) => {
      canvas.toBlob((out) => {
        if (out) resolve(out);
        else reject(new Error('canvas.toBlob returned null — unsupported format or tainted canvas'));
      }, 'image/jpeg', 0.8);
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  Object URL helpers
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Creates an object URL from a photo record's full-size blob.
 *
 * ⚠️ The caller **must** call `URL.revokeObjectURL(url)` when the URL is no
 *    longer needed (usually when the image is removed from the DOM or replaced).
 *
 * @param {Object} photoRecord  — must have a `blob` property
 * @returns {string}  object URL, or empty string if blob is missing
 */
export function getPhotoURL(photoRecord) {
  if (!photoRecord) return '';
  // If this is an embedded photo (standalone mode), return the data URI directly
  if (photoRecord._embeddedDataUri) return photoRecord._embeddedDataUri;
  if (!photoRecord.blob) return '';
  return URL.createObjectURL(photoRecord.blob);
}

/**
 * Creates an object URL from a photo record's thumbnail blob.
 *
 * ⚠️ The caller **must** call `URL.revokeObjectURL(url)` when no longer needed.
 *
 * @param {Object} photoRecord  — must have a `thumbnailBlob` property
 * @returns {string}  object URL, or empty string if thumbnail is missing
 */
export function getThumbnailURL(photoRecord) {
  if (!photoRecord || !photoRecord.thumbnailBlob) return '';
  return URL.createObjectURL(photoRecord.thumbnailBlob);
}

// ══════════════════════════════════════════════════════════════════════════════
//  CRUD operations
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Adds a photo (File object from an <input type="file">) to the database.
 * Automatically generates a thumbnail and stores it alongside the original.
 *
 * @param {string} specimenId  — ID of the parent specimen
 * @param {File}   file        — image file from the user's file picker
 * @returns {Promise<Object>}  — the stored photo record
 */
export async function addPhoto(specimenId, file) {
  if (!specimenId) throw new Error('addPhoto: specimenId is required');
  if (!file || !(file instanceof File)) {
    throw new TypeError('addPhoto: expected a File object');
  }

  // Generate thumbnail first (may throw on corrupt images)
  const thumbnailBlob = await createThumbnail(file);

  const photo = {
    id:            generateId(),
    specimenId,
    blob:          file,
    filename:      file.name,
    caption:       '',
    isPrimary:     false,
    addedDate:     new Date().toISOString(),
    mimeType:      file.type || 'image/jpeg',
    thumbnailBlob,
  };

  await reqPromise(getStore('readwrite').add(photo));
  return photo;
}

/**
 * Returns all photo records for a specimen, sorted by addedDate descending
 * (newest first).
 *
 * @param {string} specimenId
 * @returns {Promise<Object[]>}
 */
export async function getPhotos(specimenId) {
  if (!specimenId) return [];

  try {
    const records = await reqPromise(
      getStore('readonly').index('specimenId').getAll(specimenId)
    );

    // Sort newest-first
    records.sort((a, b) => new Date(b.addedDate) - new Date(a.addedDate));

    return records;
  } catch (err) {
    console.warn('[photos] getPhotos error:', err);
    return [];
  }
}

/**
 * Returns the primary photo for a specimen, or the first photo if none is
 * explicitly marked as primary, or null if the specimen has no photos.
 *
 * @param {string} specimenId
 * @returns {Promise<Object|null>}
 */
export async function getPrimaryPhoto(specimenId) {
  const photos = await getPhotos(specimenId);
  if (photos.length === 0) {
    // Fallback: check embedded photo data (standalone mode)
    if (window.__PHOTO_DATA && window.__PHOTO_DATA[specimenId]) {
      return {
        id: `embedded_${specimenId}`,
        specimenId,
        blob: null,
        thumbnailBlob: null,
        isPrimary: true,
        mimeType: 'image/jpeg',
        _embeddedDataUri: window.__PHOTO_DATA[specimenId],
      };
    }
    return null;
  }

  return photos.find(p => p.isPrimary) || photos[0];
}

/**
 * Deletes a photo record by its ID.
 *
 * @param {string} photoId
 * @returns {Promise<void>}
 */
export async function deletePhoto(photoId) {
  if (!photoId) throw new Error('deletePhoto: photoId is required');
  await reqPromise(getStore('readwrite').delete(photoId));
}

/**
 * Marks one photo as the primary photo for a specimen, unmarking any other
 * photo that was previously primary.
 *
 * Uses a single readwrite transaction for atomicity — reads all photos for
 * the specimen, updates the relevant records in one pass.
 *
 * @param {string} photoId     — the photo to promote
 * @param {string} specimenId  — scoping specimen
 * @returns {Promise<void>}
 */
export async function setPrimary(photoId, specimenId) {
  if (!photoId || !specimenId) {
    throw new Error('setPrimary: photoId and specimenId are required');
  }

  const photos = await getPhotos(specimenId);
  const db     = _db;
  const tx     = db.transaction(STORE, 'readwrite');
  const store  = tx.objectStore(STORE);

  for (const photo of photos) {
    if (photo.id === photoId) {
      photo.isPrimary = true;
      store.put(photo);
    } else if (photo.isPrimary) {
      photo.isPrimary = false;
      store.put(photo);
    }
  }

  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

/**
 * Updates the caption text on a photo record.
 *
 * @param {string} photoId
 * @param {string} caption   — new caption text (empty string clears it)
 * @returns {Promise<void>}
 */
export async function updateCaption(photoId, caption) {
  if (!photoId) throw new Error('updateCaption: photoId is required');

  const store = getStore('readwrite');
  const photo = await reqPromise(store.get(photoId));
  if (!photo) throw new Error(`Photo not found: ${photoId}`);

  photo.caption = caption || '';
  await reqPromise(store.put(photo));
}

// ══════════════════════════════════════════════════════════════════════════════
//  Card thumbnail helper
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Returns an object URL for the primary thumbnail of a specimen, or null if
 * the specimen has no photos.
 *
 * ⚠️ The caller **must** revoke the returned URL via `URL.revokeObjectURL()`
 *    once the image is no longer displayed.
 *
 * @param {string} specimenId
 * @returns {Promise<string|null>}
 */
export async function getCardThumbnailURL(specimenId) {
  try {
    const primary = await getPrimaryPhoto(specimenId);
    if (primary && primary.thumbnailBlob) return getThumbnailURL(primary);
    // Fallback: check embedded photo data (standalone mode)
    if (window.__PHOTO_DATA && window.__PHOTO_DATA[specimenId]) {
      return window.__PHOTO_DATA[specimenId]; // data URI string
    }
    return null;
  } catch (err) {
    console.warn('[photos] getCardThumbnailURL error:', err);
    return null;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  Gallery rendering (for the detail panel)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Object URL registry keyed by container element (WeakMap).
 *
 * We use a WeakMap so that when the container element is garbage collected the
 * set of URLs can also be collected.  The `revokeAllForContainer()` call at
 * the start of each `renderPhotoGallery` invocation ensures stale URLs are
 * cleaned up before new ones are created.
 *
 * @type {WeakMap<HTMLElement, Set<string>>}
 */
const _urlRegistry = new WeakMap();

/**
 * Registers an object URL for lifecycle tracking under a container.
 * @param {HTMLElement} container
 * @param {string} url
 */
function registerURL(container, url) {
  if (!_urlRegistry.has(container)) {
    _urlRegistry.set(container, new Set());
  }
  _urlRegistry.get(container).add(url);
}

/**
 * Revokes every tracked object URL for a given container and clears the set.
 * @param {HTMLElement} container
 */
function revokeAllForContainer(container) {
  const urls = _urlRegistry.get(container);
  if (urls) {
    for (const url of urls) {
      try { URL.revokeObjectURL(url); } catch (_) { /* ignore */ }
    }
    urls.clear();
  }
}

// ── Lightbox state ────────────────────────────────────────────────────────────

/** @type {{ overlay: HTMLElement, url: string }|null} */
let _lightbox = null;

/** @type {EventListener|null} */
let _lightboxKeyHandler = null;

/**
 * Opens a full-size lightbox overlay for a given photo record.
 * The overlay is appended to `document.body`.
 *
 * @param {Object} photo       — photo record with `blob` property
 * @param {string} specimenId  — used for context (not currently displayed)
 */
function openLightbox(photo) {
  closeLightbox(); // ensure only one lightbox at a time

  const overlay = document.createElement('div');
  overlay.className = 'lightbox';

  const url = getPhotoURL(photo);

  const content = document.createElement('div');
  content.className = 'lightbox-content';

  const img = document.createElement('img');
  img.className = 'lightbox-img';
  img.src    = url;
  img.alt    = photo.caption || 'Butterfly photo';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'lightbox-close';
  closeBtn.type  = 'button';
  closeBtn.innerHTML = '✕';
  closeBtn.setAttribute('aria-label', 'Close lightbox');

  content.appendChild(img);
  content.appendChild(closeBtn);

  if (photo.caption) {
    const cap = document.createElement('div');
    cap.className = 'lightbox-caption';
    cap.textContent = photo.caption;
    content.appendChild(cap);
  }

  overlay.appendChild(content);
  document.body.appendChild(overlay);

  // Stash for cleanup
  _lightbox = { overlay, url };

  // Trigger CSS transition on next frame
  requestAnimationFrame(() => overlay.classList.add('lightbox--open'));

  // Close handlers
  const close = () => closeLightbox();

  closeBtn.addEventListener('click', close);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  _lightboxKeyHandler = (e) => {
    if (e.key === 'Escape') close();
  };
  document.addEventListener('keydown', _lightboxKeyHandler);
}

/**
 * Closes the lightbox overlay and revokes its object URL.
 * Safe to call when no lightbox is open.
 */
function closeLightbox() {
  if (_lightbox) {
    URL.revokeObjectURL(_lightbox.url);
    _lightbox.overlay.remove();

    if (_lightboxKeyHandler) {
      document.removeEventListener('keydown', _lightboxKeyHandler);
      _lightboxKeyHandler = null;
    }

    _lightbox = null;
  }
}

// ── Toast helper (self-contained) ─────────────────────────────────────────────

/**
 * Displays a brief toast notification using the app's existing toast element
 * if available, or creates a minimal fallback.
 *
 * Uses its own timer stored on the element to avoid conflicting with the
 * app's toast timer.
 *
 * @param {string} message
 * @param {'info'|'error'} [type='info']
 */
function showToast(message, type = 'info') {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    el.setAttribute('role', 'alert');
    el.setAttribute('aria-live', 'assertive');
    el.setAttribute('aria-atomic', 'true');
    document.body.appendChild(el);
  }

  if (el._photosTimer) clearTimeout(el._photosTimer);

  el.textContent = message;
  el.className   = `toast toast--${type} toast--visible`;
  el._photosTimer = setTimeout(() => el.classList.remove('toast--visible'), 2800);
}

// ── Main render function ──────────────────────────────────────────────────────

/**
 * Renders a photo gallery (thumbnails + controls + lightbox) into a container.
 *
 * The gallery owns its object URLs and cleans them up on every re-render.
 * Call this function whenever the detail panel opens or a specimen changes.
 *
 * **Usage in the detail panel:**
 * ```js
 * // Inside renderDetailPanel(), after setting innerHTML:
 * const galleryContainer = document.getElementById('photo-gallery-area');
 * renderPhotoGallery(specimen.id, galleryContainer);
 * ```
 *
 * @param {string}      specimenId
 * @param {HTMLElement} containerElement  — must be in the DOM for lightbox
 */
export function renderPhotoGallery(specimenId, containerElement) {
  if (!containerElement) {
    console.warn('[photos] renderPhotoGallery: no container element provided');
    return;
  }

  // Close any open lightbox whose URL may be about to become stale
  closeLightbox();

  // Revoke old URLs previously registered for this container
  revokeAllForContainer(containerElement);

  // Remove previous gallery content (if any)
  const existing = containerElement.querySelector('.photo-gallery');
  if (existing) existing.remove();

  // ── Build gallery structure ────────────────────────────────────────────
  const gallery = document.createElement('div');
  gallery.className = 'photo-gallery';

  const grid = document.createElement('div');
  grid.className = 'photo-gallery-grid';
  gallery.appendChild(grid);

  // Add-photo button area
  const addWrap = document.createElement('div');
  addWrap.className = 'photo-add-wrap';

  const addBtn = document.createElement('button');
  addBtn.className = 'photo-add-btn btn btn-secondary';
  addBtn.type = 'button';
  addBtn.textContent = '+ Add Photos';
  addWrap.appendChild(addBtn);

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.multiple = true;
  fileInput.accept = 'image/*';
  fileInput.style.display = 'none';
  addWrap.appendChild(fileInput);

  gallery.appendChild(addWrap);
  containerElement.appendChild(gallery);

  // ── Load and render photos ─────────────────────────────────────────────
  loadGallery();

  // ── Event: open file picker ────────────────────────────────────────────
  addBtn.addEventListener('click', () => fileInput.click());

  // ── Event: add photo(s) ───────────────────────────────────────────────
  fileInput.addEventListener('change', async () => {
    const files = Array.from(fileInput.files || []);
    if (files.length === 0) return;

    addBtn.disabled = true;
    addBtn.textContent = 'Uploading\u2026';

    let added = 0;
    try {
      for (const file of files) {
        await addPhoto(specimenId, file);
        added++;
      }
      showToast(`${added} photo${added !== 1 ? 's' : ''} added`);
      // Re-render the gallery to show the new thumbnails
      renderPhotoGallery(specimenId, containerElement);
    } catch (err) {
      console.error('[photos] add failed:', err);
      showToast(`Failed to add photo${added > 0 ? ' (partial)' : ''}`, 'error');
    } finally {
      addBtn.disabled = false;
      addBtn.textContent = '+ Add Photos';
      fileInput.value = '';
    }
  });

  // ── Load photos from DB and build thumbnails ──────────────────────────
  async function loadGallery() {
    try {
      const photos = await getPhotos(specimenId);
      grid.innerHTML = '';

      if (photos.length === 0) {
        grid.innerHTML =
          '<div class="photo-gallery-empty">No photos yet. Click &ldquo;+ Add Photos&rdquo; to upload.</div>';
        return;
      }

      for (const photo of photos) {
        const item = document.createElement('div');
        item.className = 'photo-thumb';
        if (photo.isPrimary) item.classList.add('photo-thumb--primary');

        // Thumbnail image
        const thumbUrl = getThumbnailURL(photo);
        registerURL(containerElement, thumbUrl);

        const img = document.createElement('img');
        img.className = 'photo-thumb-img';
        img.src   = thumbUrl;
        img.alt   = photo.caption || 'Butterfly photo';
        img.loading = 'lazy';
        item.appendChild(img);

        // Star button (set as primary)
        const starBtn = document.createElement('button');
        starBtn.className = 'photo-star';
        starBtn.type  = 'button';
        starBtn.title = photo.isPrimary ? 'Primary photo' : 'Set as primary';
        starBtn.innerHTML = photo.isPrimary ? '\u2605' : '\u2606'; // ★ / ☆
        starBtn.setAttribute('aria-label', 'Set as primary photo');
        item.appendChild(starBtn);

        // Delete button
        const delBtn = document.createElement('button');
        delBtn.className = 'photo-delete';
        delBtn.type  = 'button';
        delBtn.title = 'Delete photo';
        delBtn.innerHTML = '\u2715'; // ✕
        delBtn.setAttribute('aria-label', 'Delete photo');
        item.appendChild(delBtn);

        // Caption (if present)
        if (photo.caption) {
          const cap = document.createElement('div');
          cap.className = 'photo-caption';
          cap.textContent = photo.caption;
          item.appendChild(cap);
        }

        // ── Event: thumbnail click → lightbox ──────────────────────────
        img.addEventListener('click', () => openLightbox(photo));

        // ── Event: set as primary ──────────────────────────────────────
        starBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          try {
            await setPrimary(photo.id, specimenId);
            renderPhotoGallery(specimenId, containerElement);
          } catch (err) {
            console.error('[photos] setPrimary failed:', err);
            showToast('Failed to set primary photo', 'error');
          }
        });

        // ── Event: delete photo ────────────────────────────────────────
        delBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (!confirm('Delete this photo? This cannot be undone.')) return;
          try {
            await deletePhoto(photo.id);
            renderPhotoGallery(specimenId, containerElement);
          } catch (err) {
            console.error('[photos] delete failed:', err);
            showToast('Failed to delete photo', 'error');
          }
        });

        grid.appendChild(item);
      }
    } catch (err) {
      console.error('[photos] loadGallery error:', err);
      grid.innerHTML =
        '<div class="photo-gallery-empty photo-gallery-error">Failed to load photos.</div>';
    }
  }
}
