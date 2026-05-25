/**
 * photo-seeder.js — Browser-side bulk photo seeder for Butterfly Collection Manager
 *
 * Runs once on first load to populate the ButterflyPhotos IndexedDB from the
 * pre-extracted images in data/specimen-photos/.
 *
 * Usage:
 *   import { seedPhotos } from './photo-seeder.js';
 *   await seedPhotos((loaded, total) => updateProgressBar(loaded, total));
 *
 * The function is idempotent: if the first specimen in the manifest already
 * has a photo in the DB the whole seed run is skipped.
 */

import { initPhotoDB, getPhotos } from './photos.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const MANIFEST_URL   = 'data/specimen-photos/manifest.json';
const PHOTOS_BASE    = 'data/specimen-photos/';
const THUMB_MAX_WIDTH = 300;
const THUMB_QUALITY   = 0.8;

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Generates a unique photo record ID.
 * @returns {string}
 */
function generateId() {
  return `photo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Creates a JPEG thumbnail Blob from a source Blob using an offscreen canvas.
 * Max width is THUMB_MAX_WIDTH px; height scales proportionally.
 *
 * @param {Blob}   blob
 * @param {string} mimeType  — source MIME type (used for decode hint)
 * @returns {Promise<Blob>}
 */
async function createThumbnail(blob, mimeType) {
  const url = URL.createObjectURL(blob);

  try {
    const img = await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload  = () => resolve(image);
      image.onerror = () => reject(new Error('Thumbnail decode failed'));
      image.src     = url;
    });

    const scale = img.width > THUMB_MAX_WIDTH
      ? THUMB_MAX_WIDTH / img.width
      : 1;                                    // don't upscale small images

    const w = Math.round(img.width  * scale) || 1;
    const h = Math.round(img.height * scale) || 1;

    const canvas = document.createElement('canvas');
    canvas.width  = w;
    canvas.height = h;

    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Cannot obtain canvas 2D context');
    ctx.drawImage(img, 0, 0, w, h);

    return await new Promise((resolve, reject) => {
      canvas.toBlob(
        (out) => (out ? resolve(out) : reject(new Error('canvas.toBlob returned null'))),
        'image/jpeg',
        THUMB_QUALITY
      );
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Wraps an IDBRequest in a Promise.
 * @param {IDBRequest} req
 * @returns {Promise<any>}
 */
function idbPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

/**
 * Adds a photo record directly to the ButterflyPhotos DB.
 * Avoids importing addPhoto() from photos.js because that function requires a
 * File object; here we already have raw Blobs.
 *
 * @param {IDBDatabase} db
 * @param {string}      specimenId
 * @param {Blob}        blob           full-size image blob
 * @param {Blob}        thumbnailBlob  JPEG thumbnail blob
 * @param {string}      filename       e.g. "abc123.png"
 * @param {string}      mimeType       e.g. "image/png"
 * @returns {Promise<void>}
 */
async function insertPhoto(db, specimenId, blob, thumbnailBlob, filename, mimeType) {
  const record = {
    id:            generateId(),
    specimenId,
    blob,
    filename,
    caption:       '',
    isPrimary:     true,           // seeded photo is the primary photo
    addedDate:     new Date().toISOString(),
    mimeType,
    thumbnailBlob,
  };

  const tx    = db.transaction('photos', 'readwrite');
  const store = tx.objectStore('photos');

  await idbPromise(store.add(record));
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Seeds the ButterflyPhotos IndexedDB from data/specimen-photos/.
 *
 * Idempotent: checks whether the first specimen in the manifest already has a
 * photo; if yes, the entire run is skipped immediately.
 *
 * For each manifest entry:
 *   1. Skip if the specimen already has a photo in the DB.
 *   2. Fetch the image file.
 *   3. Create a thumbnail via canvas.
 *   4. Store both blobs in the DB.
 *
 * @param {function(number, number): void} [onProgress]
 *   Called after each image is processed (loaded so far, total in manifest).
 *   Also called with (0, total) before processing begins.
 *
 * @returns {Promise<{seeded: number, skipped: number, failed: number}>}
 */
export async function seedPhotos(onProgress = () => {}) {
  // ── 1. Ensure the DB is open ──────────────────────────────────────────────
  const db = await initPhotoDB();

  // ── 2. Fetch manifest ─────────────────────────────────────────────────────
  let manifest;
  try {
    const res = await fetch(MANIFEST_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    manifest = await res.json();
  } catch (err) {
    console.error('[photo-seeder] Failed to fetch manifest:', err);
    return { seeded: 0, skipped: 0, failed: 0 };
  }

  if (!Array.isArray(manifest) || manifest.length === 0) {
    console.warn('[photo-seeder] Manifest is empty — nothing to seed.');
    return { seeded: 0, skipped: 0, failed: 0 };
  }

  // ── 3. Idempotency check — sample the first entry ────────────────────────
  const firstEntry  = manifest[0];
  const firstPhotos = await getPhotos(firstEntry.specimenId);
  if (firstPhotos.length > 0) {
    console.info('[photo-seeder] DB already seeded — skipping.');
    return { seeded: 0, skipped: manifest.length, failed: 0 };
  }

  const total = manifest.length;
  onProgress(0, total);

  let seeded  = 0;
  let skipped = 0;
  let failed  = 0;

  // ── 4. Process each manifest entry ───────────────────────────────────────
  for (let i = 0; i < manifest.length; i++) {
    const { specimenId, filename, mimeType } = manifest[i];

    // Per-entry idempotency: skip if this specimen already has a photo
    try {
      const existing = await getPhotos(specimenId);
      if (existing.length > 0) {
        skipped++;
        onProgress(seeded + skipped + failed, total);
        continue;
      }
    } catch (checkErr) {
      console.warn(`[photo-seeder] Could not check existing photos for ${specimenId}:`, checkErr);
      // Continue and attempt to seed anyway
    }

    // Fetch image
    let blob;
    try {
      const res = await fetch(PHOTOS_BASE + filename);
      if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${filename}`);
      blob = await res.blob();
    } catch (fetchErr) {
      console.warn(`[photo-seeder] Fetch failed for ${filename}:`, fetchErr);
      failed++;
      onProgress(seeded + skipped + failed, total);
      continue;
    }

    // Create thumbnail
    let thumbnailBlob;
    try {
      thumbnailBlob = await createThumbnail(blob, mimeType);
    } catch (thumbErr) {
      console.warn(`[photo-seeder] Thumbnail failed for ${filename}:`, thumbErr);
      // Store without thumbnail rather than skipping entirely
      thumbnailBlob = blob;
    }

    // Insert into DB
    try {
      await insertPhoto(db, specimenId, blob, thumbnailBlob, filename, mimeType);
      seeded++;
    } catch (dbErr) {
      console.warn(`[photo-seeder] DB insert failed for ${specimenId}:`, dbErr);
      failed++;
    }

    onProgress(seeded + skipped + failed, total);
  }

  console.info(
    `[photo-seeder] Done — seeded: ${seeded}, skipped: ${skipped}, failed: ${failed}`
  );

  return { seeded, skipped, failed };
}
