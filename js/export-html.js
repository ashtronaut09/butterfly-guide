/**
 * export-html.js — Save updated collection HTML
 *
 * Generates an updated index.html containing the current specimen data and
 * downloads it. Photos are NOT bundled — they live as files in the photos/
 * folder next to index.html and are referenced via relative paths.
 *
 * Two modes:
 *   Dev mode: fetches source files, transforms them, builds standalone HTML from scratch.
 *   Standalone mode: reads own page source, replaces data section.
 */

import { getAllSpecimens } from './db.js';

// CDN URLs for libraries to embed
const CDN_URLS = {
  jszip: 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
  jspdf: 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
};

// JS source files in dependency order
const JS_SOURCE_FILES = [
  'js/db.js',
  'js/photos.js',
  'js/photo-seeder.js',
  'js/labels.js',
  'js/export-html.js',
  'js/change-tracker.js',
  'js/collection-app.js',
];

/**
 * Exports the collection as a ZIP.
 * @param {function(string)} onStatus - progress callback
 */
export async function exportCollection(onStatus = () => {}) {
  if (typeof JSZip === 'undefined') {
    throw new Error('JSZip library not loaded');
  }

  // ── 1. Read current data from IndexedDB ───────────────────────────────
  onStatus('Reading specimens…');
  const specimens = await getAllSpecimens();
  const cleanSpecimens = specimens.map(s => {
    const c = { ...s };
    delete c._thumbnailDataUri;
    return c;
  });

  // ── 2. Build photo manifest + path map (no base64 encoding) ──────────
  // Photos live as real files in the photos/ folder next to index.html and
  // are referenced via relative file:// paths through <img src="…">. The
  // export only needs to record the path mapping; the bytes never enter
  // the browser. Originals the user removed are excluded.
  onStatus('Building photo manifest…');
  const deletedOriginals = (() => {
    try {
      const raw = localStorage.getItem('butterfly_deleted_originals');
      return new Set(raw ? JSON.parse(raw) : []);
    } catch (_) {
      return new Set();
    }
  })();
  const photoManifest = [];
  const photoDataMap = {};   // specimenId → "photos/{filename}"

  if (window.__PHOTO_MANIFEST) {
    for (const entry of window.__PHOTO_MANIFEST) {
      if (!deletedOriginals.has(entry.specimenId)) {
        photoManifest.push(entry);
      }
    }
  }
  if (window.__PHOTO_DATA) {
    for (const [sid, path] of Object.entries(window.__PHOTO_DATA)) {
      if (!deletedOriginals.has(sid)) {
        photoDataMap[sid] = path;
      }
    }
  }

  // ── 3. Build the standalone HTML ──────────────────────────────────────
  let html;

  if (window.__SEED_DATA) {
    // ── STANDALONE MODE: self-replicate ──────────────────────────────────
    onStatus('Rebuilding from current page…');
    const pageSource = '<!DOCTYPE html>\n<html lang="en">' +
      document.documentElement.innerHTML + '</html>';

    const dataBlock = buildDataBlock(cleanSpecimens, photoManifest, photoDataMap);

    const startMarker = '<!-- __DATA_START__ -->';
    const endMarker = '<!-- __DATA_END__ -->';
    const startIdx = pageSource.indexOf(startMarker);
    const endIdx = pageSource.indexOf(endMarker);

    if (startIdx === -1 || endIdx === -1) {
      throw new Error('Data markers not found in page source');
    }

    html = pageSource.substring(0, startIdx) +
      dataBlock +
      pageSource.substring(endIdx + endMarker.length);

  } else {
    // ── DEV MODE: build from source files ───────────────────────────────
    onStatus('Fetching source files…');
    html = await buildFromSource(onStatus, cleanSpecimens, photoManifest, photoDataMap);
  }

  // ── 4. Trigger download of the updated index.html ────────────────────
  // Photos remain in the existing photos/ folder on disk — we only ship the
  // small HTML. The user saves it over the previous index.html.
  onStatus('Preparing download…');
  const htmlBlob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(htmlBlob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'index.html';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);

  onStatus(`Saved — ${specimens.length} specimens`);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildDataBlock(specimens, manifest, photoData) {
  // Use concatenation for closing tags to avoid breaking the HTML parser
  // when this code is itself inlined inside a <script> tag
  const S = '<' + '/script>';
  return '<!-- __DATA_START__ -->\n  <script>\n' +
    '    window.__SEED_DATA = ' + JSON.stringify(specimens) + ';\n' +
    '    window.__PHOTO_MANIFEST = ' + JSON.stringify(manifest) + ';\n' +
    '    window.__PHOTO_DATA = ' + JSON.stringify(photoData) + ';\n' +
    '  ' + S + '\n  <!-- __DATA_END__ -->';
}

// ── Dev mode: build standalone HTML from source ─────────────────────────────

async function buildFromSource(onStatus, specimens, photoManifest, photoDataMap) {
  // 1. Fetch CSS
  onStatus('Fetching CSS…');
  const css = await fetchText('css/collection.css');

  // 2. Fetch and transform JS source files
  onStatus('Fetching JavaScript…');
  const jsChunks = [];
  for (const path of JS_SOURCE_FILES) {
    const fname = path.split('/').pop();
    let code = await fetchText(path);
    code = stripImportsExports(code);

    if (fname === 'db.js') code = patchSeedFromJSON(code);
    if (fname === 'photo-seeder.js') code = patchPhotoSeeder(code);

    jsChunks.push(`/* ── ${fname} ── */\n${code.trim()}`);
  }
  const appJS = jsChunks.join('\n\n');

  // 3. Fetch CDN libraries
  onStatus('Fetching libraries…');
  const jszipLib = await fetchText(CDN_URLS.jszip);
  const jspdfLib = await fetchText(CDN_URLS.jspdf);

  // 4. Build body HTML from collection.html
  onStatus('Building HTML…');
  const collectionHTML = await fetchText('collection.html');
  const bodyHTML = extractBodyHTML(collectionHTML);

  // 5. Assemble
  const dataBlock = buildDataBlock(specimens, photoManifest, photoDataMap);

  // Use concatenation for closing tags to avoid breaking the HTML parser
  // when this code is itself inlined inside a <script> tag
  const S = '<' + '/script>';
  const B = '<' + '/body>';
  return '<!DOCTYPE html>\n<html lang="en">\n<head>\n' +
    '  <meta charset="UTF-8">\n' +
    '  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
    '  <title>Butterfly Collection<' + '/title>\n' +
    '  <style>\n' + css + '\n  </style>\n' +
    '</head>\n<body>\n\n' +
    bodyHTML + '\n\n  ' +
    dataBlock + '\n\n' +
    '  <script>\n    /* === JSZip === */\n    ' + jszipLib + '\n  ' + S + '\n\n' +
    '  <script>\n    /* === jsPDF === */\n    ' + jspdfLib + '\n  ' + S + '\n\n' +
    '  <script>\n    /* === Application Code === */\n    ' + appJS + '\n  ' + S + '\n\n' +
    B + '\n</html>';
}

async function fetchText(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to fetch ${url}: HTTP ${resp.status}`);
  return resp.text();
}

/**
 * Strips ES module import/export syntax and wraps in an IIFE to avoid
 * scope collisions when all modules are concatenated. Exported names
 * are hoisted to window so cross-module calls still work.
 */
function stripImportsExports(code) {
  // Remove imports
  code = code.replace(/import\s*\{[^}]*\}\s*from\s*['"][^'"]+['"]\s*;?/gs, '');

  // Capture exported names before stripping
  const exportedNames = [];
  const exportRe = /\bexport\s+(?:async\s+)?(?:function|const)\s+(\w+)/g;
  let m;
  while ((m = exportRe.exec(code)) !== null) {
    exportedNames.push(m[1]);
  }

  // Strip export keyword from declarations
  code = code.replace(/\bexport\s+(async\s+function|function|const)\b/g, '$1');

  // Wrap in IIFE and hoist exports to window
  const hoists = exportedNames.map(n => `  window.${n} = ${n};`).join('\n');
  code = '(function() {\n' + code.trim() + '\n\n  // Exports\n' + hoists + '\n})();';

  return code;
}

/**
 * Patches db.js seedFromJSON to check window.__SEED_DATA before fetching.
 */
function patchSeedFromJSON(code) {
  const oldFetch = `  // 2. Fetch the seed file
  let records;
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(\`HTTP \${resp.status} fetching \${url}\`);
    records = await resp.json();
  } catch (err) {
    console.warn('[db] seedFromJSON: could not load seed file —', err.message);
    return { seeded: false, count: 0 };
  }`;

  const newFetch = `  // 2. Load seed data — prefer embedded window.__SEED_DATA in standalone mode
  let records;
  if (window.__SEED_DATA) {
    records = window.__SEED_DATA;
  } else {
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(\`HTTP \${resp.status}\`);
      records = await resp.json();
    } catch (err) {
      console.warn('[db] seedFromJSON: could not load seed file —', err.message);
      return { seeded: false, count: 0 };
    }
  }`;

  if (code.includes(oldFetch)) {
    return code.replace(oldFetch, newFetch);
  }
  console.warn('[export] Could not find seedFromJSON fetch block to patch');
  return code;
}

/**
 * Patches photo-seeder.js to check window.__PHOTO_MANIFEST and window.__PHOTO_DATA.
 */
function patchPhotoSeeder(code) {
  // Patch manifest fetch
  const oldManifest = `  // ── 2. Fetch manifest ─────────────────────────────────────────────────────
  let manifest;
  try {
    const res = await fetch(MANIFEST_URL);
    if (!res.ok) throw new Error(\`HTTP \${res.status}\`);
    manifest = await res.json();
  } catch (err) {
    console.error('[photo-seeder] Failed to fetch manifest:', err);
    return { seeded: 0, skipped: 0, failed: 0 };
  }`;

  const newManifest = `  // ── 2. Load manifest — prefer embedded window.__PHOTO_MANIFEST in standalone mode
  let manifest;
  if (window.__PHOTO_MANIFEST) {
    manifest = window.__PHOTO_MANIFEST;
  } else {
    try {
      const res = await fetch(MANIFEST_URL);
      if (!res.ok) throw new Error(\`HTTP \${res.status}\`);
      manifest = await res.json();
    } catch (err) {
      console.error('[photo-seeder] Failed to fetch manifest:', err);
      return { seeded: 0, skipped: 0, failed: 0 };
    }
  }`;

  if (code.includes(oldManifest)) {
    code = code.replace(oldManifest, newManifest);
  } else {
    console.warn('[export] Could not find photo-seeder manifest fetch block to patch');
  }

  // Patch photo fetch
  const oldPhotoFetch = `    // Fetch image
    let blob;
    try {
      const res = await fetch(PHOTOS_BASE + filename);
      if (!res.ok) throw new Error(\`HTTP \${res.status} fetching \${filename}\`);
      blob = await res.blob();
    } catch (fetchErr) {
      console.warn(\`[photo-seeder] Fetch failed for \${filename}:\`, fetchErr);
      failed++;
      onProgress(seeded + skipped + failed, total);
      continue;
    }`;

  const newPhotoFetch = `    // Fetch image — prefer embedded data URI in standalone mode
    let blob;
    const photoKey = manifest[i].specimenId;
    if (window.__PHOTO_DATA && window.__PHOTO_DATA[photoKey]) {
      const dataUri = window.__PHOTO_DATA[photoKey];
      const resp = await fetch(dataUri);
      blob = await resp.blob();
    } else {
      try {
        const res = await fetch(PHOTOS_BASE + filename);
        if (!res.ok) throw new Error(\`HTTP \${res.status} fetching \${filename}\`);
        blob = await res.blob();
      } catch (fetchErr) {
        console.warn(\`[photo-seeder] Fetch failed for \${filename}:\`, fetchErr);
        failed++;
        onProgress(seeded + skipped + failed, total);
        continue;
      }
    }`;

  if (code.includes(oldPhotoFetch)) {
    code = code.replace(oldPhotoFetch, newPhotoFetch);
  } else {
    console.warn('[export] Could not find photo-seeder photo fetch block to patch');
  }

  return code;
}

/**
 * Extracts body content from collection.html, stripping script/link tags
 * and the import button.
 */
function extractBodyHTML(html) {
  // Extract body
  const bodyMatch = html.match(/<body>([\s\S]*?)<\/body>/);  // eslint-disable-line
  if (!bodyMatch) throw new Error('Could not find <body> in collection.html');
  let body = bodyMatch[1];

  // Remove all <script> tags (use concatenation to avoid breaking the HTML parser
  // when this code is itself inlined inside a <script> tag)
  body = body.replace(new RegExp('<script[\\s\\S]*?<' + '/script>', 'g'), '');
  body = body.replace(new RegExp('<script[^>]*/>', 'g'), '');

  // Remove <link rel="stylesheet"> (CSS is inlined)
  body = body.replace(new RegExp('<link[^>]+rel=["\']stylesheet["\'][^>]*>', 'g'), '');

  // Remove import button + hidden file input (if still present)
  body = body.replace(new RegExp('<button[^>]+id=["\']btn-import["\'][^>]*>[\\s\\S]*?<' + '/button>', 'g'), '');
  body = body.replace(new RegExp('<input[^>]+id=["\']import-file-input["\'][^>]*>', 'g'), '');

  // Remove HTML comments about scripts/modules
  body = body.replace(/<!--\s*(?:App modules|JSZip|jsPDF|Scripts)[^-]*-->/g, '');

  return body.trim();
}
