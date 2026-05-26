#!/usr/bin/env python3
"""
build-standalone.py — Bundles the Butterfly Collection Manager into a single
self-contained HTML file that works via file:// without a local server.

Usage:
    python3 build-standalone.py

Output: butterfly-collection-standalone.html
"""

import base64
import json
import os
import re
import ssl
import time
import urllib.request

import datetime

# ── Paths ─────────────────────────────────────────────────────────────────────

BASE_DIR      = os.path.dirname(os.path.abspath(__file__))
OUT_DIR       = os.path.join(BASE_DIR, 'butterfly-collection-export')
BUILD_DATE    = datetime.date.today().isoformat()
OUT_FILE      = os.path.join(OUT_DIR, f'butterfly-collection-{BUILD_DATE}.html')
OUT_PHOTOS_JS = os.path.join(OUT_DIR, 'photos.js')
OUT_PHOTOS_DIR= os.path.join(OUT_DIR, 'photos')
CDN_CACHE_DIR = os.path.join(BASE_DIR, 'data', 'cdn-cache')

JS_FILES = [
    os.path.join(BASE_DIR, 'js', 'db.js'),
    os.path.join(BASE_DIR, 'js', 'photos.js'),
    os.path.join(BASE_DIR, 'js', 'photo-seeder.js'),
    os.path.join(BASE_DIR, 'js', 'labels.js'),
    os.path.join(BASE_DIR, 'js', 'export-html.js'),
    os.path.join(BASE_DIR, 'js', 'change-tracker.js'),
    os.path.join(BASE_DIR, 'js', 'collection-app.js'),
]

CSS_FILE      = os.path.join(BASE_DIR, 'css', 'collection.css')
SEED_DATA     = os.path.join(BASE_DIR, 'data', 'collection.json')
PHOTOS_DIR    = os.path.join(BASE_DIR, 'data', 'specimen-photos')
MANIFEST_FILE = os.path.join(PHOTOS_DIR, 'manifest.json')

CDN_LIBS = {
    'jspdf.umd.min.js': 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
    'jszip.min.js':     'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
}

# ── Helpers ────────────────────────────────────────────────────────────────────

def ensure_dir(path):
    os.makedirs(path, exist_ok=True)


def fetch_or_cache(filename, url):
    """Downloads a CDN file to cdn-cache/ if not already cached."""
    ensure_dir(CDN_CACHE_DIR)
    cached = os.path.join(CDN_CACHE_DIR, filename)
    if os.path.exists(cached):
        print(f'  [cdn] Using cached {filename}')
        with open(cached, 'r', encoding='utf-8') as f:
            return f.read()
    print(f'  [cdn] Downloading {filename} from {url}')
    # macOS Python 3.x often lacks the system CA bundle; use an unverified
    # context.  CDN content is integrity-checked at the application level.
    ctx = ssl._create_unverified_context()
    with urllib.request.urlopen(url, timeout=60, context=ctx) as resp:
        content = resp.read().decode('utf-8')
    with open(cached, 'w', encoding='utf-8') as f:
        f.write(content)
    print(f'  [cdn] Cached to {cached}')
    return content


def strip_imports_exports(code, filename):
    """
    Removes ES module import/export syntax for inline (non-module) use.
    Returns (transformed_code, list_of_exported_names).

    - Removes all `import { ... } from '...'` lines (single and multi-line).
    - Captures exported names before stripping the `export` keyword.
    - Strips the `export` keyword from `export function`, `export async function`,
      and `export const` declarations.
    - Does NOT touch identifiers that merely contain 'export' (e.g. exportJSON).
    """
    # ── 1. Remove multi-line imports ─────────────────────────────────────────
    # Handles: import { foo,\n  bar } from './file.js';
    code = re.sub(
        r'^\s*import\s*\{[^}]*\}\s*from\s*[\'"][^\'"]+[\'"]\s*;?\s*$',
        '',
        code,
        flags=re.MULTILINE
    )
    # Handles import that spans lines: import {\n  foo,\n  bar\n} from '...'
    code = re.sub(
        r'import\s*\{[^}]*\}\s*from\s*[\'"][^\'"]+[\'"]\s*;?',
        '',
        code,
        flags=re.DOTALL
    )

    # ── 2. Capture exported names before stripping ───────────────────────────
    exported_names = []

    # Match: export function NAME, export async function NAME, export const NAME
    for m in re.finditer(r'\bexport\s+(?:async\s+)?(function|const)\s+(\w+)', code):
        exported_names.append(m.group(2))

    # ── 3. Strip `export` keyword only from declarations ─────────────────────
    # Match 'export ' followed by function/async/const (word boundary ensures
    # we don't touch exportJSON, exportPDF, etc.)
    code = re.sub(
        r'\bexport\s+(async\s+function|function|const)\b',
        r'\1',
        code
    )

    return code, exported_names


def transform_db_js(code):
    """
    In seedFromJSON, replaces the bare fetch block with a window.__SEED_DATA
    fallback so the standalone file doesn't need a server.
    """
    old_fetch = '''\
  // 2. Fetch the seed file
  let records;
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
    records = await resp.json();
  } catch (err) {
    console.warn('[db] seedFromJSON: could not load seed file —', err.message);
    return { seeded: false, count: 0 };
  }'''

    new_fetch = '''\
  // 2. Load seed data — prefer embedded window.__SEED_DATA in standalone mode
  let records;
  if (window.__SEED_DATA) {
    records = window.__SEED_DATA;
  } else {
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      records = await resp.json();
    } catch (err) {
      console.warn('[db] seedFromJSON: could not load seed file —', err.message);
      return { seeded: false, count: 0 };
    }
  }'''

    if old_fetch not in code:
        print('  [WARN] db.js: expected fetch block not found — skipping transform')
        return code
    return code.replace(old_fetch, new_fetch)


def transform_photo_seeder_js(code):
    """
    In seedPhotos, replaces the manifest fetch and photo fetch blocks with
    window.__PHOTO_MANIFEST / window.__PHOTO_DATA fallbacks.
    """
    # ── Manifest fetch ────────────────────────────────────────────────────────
    old_manifest = '''\
  // ── 2. Fetch manifest ─────────────────────────────────────────────────────
  let manifest;
  try {
    const res = await fetch(MANIFEST_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    manifest = await res.json();
  } catch (err) {
    console.error('[photo-seeder] Failed to fetch manifest:', err);
    return { seeded: 0, skipped: 0, failed: 0 };
  }'''

    new_manifest = '''\
  // ── 2. Load manifest — prefer embedded window.__PHOTO_MANIFEST in standalone mode
  let manifest;
  if (window.__PHOTO_MANIFEST) {
    manifest = window.__PHOTO_MANIFEST;
  } else {
    try {
      const res = await fetch(MANIFEST_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      manifest = await res.json();
    } catch (err) {
      console.error('[photo-seeder] Failed to fetch manifest:', err);
      return { seeded: 0, skipped: 0, failed: 0 };
    }
  }'''

    if old_manifest not in code:
        print('  [WARN] photo-seeder.js: expected manifest fetch block not found — skipping')
    else:
        code = code.replace(old_manifest, new_manifest)

    # ── Photo fetch ───────────────────────────────────────────────────────────
    old_photo_fetch = '''\
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
    }'''

    new_photo_fetch = '''\
    // Fetch image — value in window.__PHOTO_DATA may be either a base64
    // data URI (legacy embedded mode) or a relative path like "photos/X.jpg"
    // pointing to a sibling folder next to the HTML file.
    let blob;
    const photoKey = manifest[i].specimenId;
    const photoSource = window.__PHOTO_DATA ? window.__PHOTO_DATA[photoKey] : null;
    try {
      if (photoSource && photoSource.startsWith('data:')) {
        const commaIdx = photoSource.indexOf(',');
        const meta = photoSource.slice(0, commaIdx);
        const b64  = photoSource.slice(commaIdx + 1);
        const binStr = atob(b64);
        const bytes = new Uint8Array(binStr.length);
        for (let j = 0; j < binStr.length; j++) bytes[j] = binStr.charCodeAt(j);
        const blobType = (meta.match(/data:([^;]+)/) || [])[1] || mimeType;
        blob = new Blob([bytes], { type: blobType });
      } else {
        // Either a relative path from __PHOTO_DATA, or fall back to manifest filename
        const url = photoSource || (PHOTOS_BASE + filename);
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
        blob = await res.blob();
      }
    } catch (fetchErr) {
      console.warn(`[photo-seeder] Fetch failed for ${filename}:`, fetchErr);
      failed++;
      onProgress(seeded + skipped + failed, total);
      continue;
    }'''

    if old_photo_fetch not in code:
        print('  [WARN] photo-seeder.js: expected photo fetch block not found — skipping')
    else:
        code = code.replace(old_photo_fetch, new_photo_fetch)

    return code


def transform_collection_app_js(code):
    """
    No special transforms needed — import/export stripping is handled
    generically. The exportCollection function from export-html.js is
    available as a global since all modules are concatenated.
    """
    return code


def build_body_html():
    """
    Reads collection.html and returns just the body content, with:
    - The <link rel="stylesheet"> tag removed (CSS will be inlined)
    - All <script> tags removed (JS will be inlined)
    - The Export HTML button and its wrapping removed
    """
    with open(os.path.join(BASE_DIR, 'collection.html'), 'r', encoding='utf-8') as f:
        html = f.read()

    # Extract body content (everything between <body> and </body>)
    body_match = re.search(r'<body>(.*?)</body>', html, re.DOTALL)
    if not body_match:
        raise ValueError('Could not find <body>...</body> in collection.html')
    body = body_match.group(1)

    # Remove all <script ...> tags (both CDN and module)
    body = re.sub(r'\s*<script[^>]*>.*?</script>', '', body, flags=re.DOTALL)
    body = re.sub(r'\s*<script[^>]*/>', '', body)

    # Remove the Export HTML button (and its comment line if any)
    body = re.sub(
        r'\s*<button[^>]+id="btn-export-html"[^>]*>.*?</button>\s*',
        '\n\n  ',
        body,
        flags=re.DOTALL
    )

    # Remove the <!-- scripts --> comment block
    body = re.sub(r'\s*<!--\s*(?:App modules|JSZip|jsPDF)[^-]*-->', '', body)

    return body.strip()


def encode_photo(filepath, mime_type):
    """Reads a photo file and returns a base64 data URI."""
    with open(filepath, 'rb') as f:
        data = base64.b64encode(f.read()).decode('ascii')
    return f'data:{mime_type};base64,{data}'


# ── Main build ─────────────────────────────────────────────────────────────────

def main():
    t0 = time.time()
    print('=' * 60)
    print('Butterfly Collection — Standalone HTML Builder')
    print('=' * 60)

    # ── 1. Load and transform JavaScript ─────────────────────────────────────
    print('\n[1/6] Processing JavaScript modules…')

    js_parts = []
    for filepath in JS_FILES:
        fname = os.path.basename(filepath)
        print(f'  Reading {fname}…')
        with open(filepath, 'r', encoding='utf-8') as f:
            code = f.read()

        # Strip import/export syntax and capture exported names
        code, exported_names = strip_imports_exports(code, fname)

        # File-specific transformations
        if fname == 'db.js':
            code = transform_db_js(code)
        elif fname == 'photo-seeder.js':
            code = transform_photo_seeder_js(code)
        elif fname == 'collection-app.js':
            code = transform_collection_app_js(code)

        # Wrap in IIFE to avoid scope collisions between modules.
        # Hoist exported functions/consts to window so other modules can call them.
        hoists = '\n'.join(f'  window.{name} = {name};' for name in exported_names)
        wrapped = f'/* ── {fname} ── */\n(function() {{\n{code.strip()}\n\n  // Exports\n{hoists}\n}})();'
        js_parts.append(wrapped)

    app_js = '\n\n'.join(js_parts)

    # Sanity check: no bare import/export declarations remain
    remaining_imports = re.findall(r'^\s*import\s+\{', app_js, re.MULTILINE)
    if remaining_imports:
        print(f'  [WARN] {len(remaining_imports)} import statement(s) still present!')
    remaining_exports = re.findall(r'\bexport\s+(function|const|async)', app_js)
    if remaining_exports:
        print(f'  [WARN] {len(remaining_exports)} export declaration(s) still present!')
    print(f'  JS assembled: {len(app_js):,} chars')

    # ── 2. Load CSS ───────────────────────────────────────────────────────────
    print('\n[2/6] Reading CSS…')
    with open(CSS_FILE, 'r', encoding='utf-8') as f:
        css = f.read()
    print(f'  CSS: {len(css):,} chars')

    # ── 3. Embed specimen data ─────────────────────────────────────────────────
    print('\n[3/6] Embedding specimen data…')
    with open(SEED_DATA, 'r', encoding='utf-8') as f:
        collection_data = f.read()
    specimen_count = collection_data.count('"id"')
    print(f'  collection.json: {len(collection_data):,} chars (~{specimen_count} records)')
    seed_data_js = f'window.__SEED_DATA = {collection_data.strip()};\n'

    # ── 4. Embed photo manifest ───────────────────────────────────────────────
    print('\n[4/6] Embedding photo manifest…')
    with open(MANIFEST_FILE, 'r', encoding='utf-8') as f:
        manifest_raw = f.read()
    manifest = json.loads(manifest_raw)
    print(f'  manifest.json: {len(manifest)} entries')
    photo_manifest_js = f'window.__PHOTO_MANIFEST = {json.dumps(manifest)};\n'

    # ── 5. Build photo path map (no base64 — photos load via file:// paths) ──
    print(f'\n[5/6] Building photo path map for {len(manifest)} photos…')
    photo_data = {}
    skipped_photos = 0
    for entry in manifest:
        specimen_id = entry['specimenId']
        filename    = entry['filename']
        photo_path  = os.path.join(PHOTOS_DIR, filename)

        if not os.path.exists(photo_path):
            print(f'  [WARN] Photo not found, skipping: {filename}')
            skipped_photos += 1
            continue

        # Reference the photo by relative path; <img src> works on file://
        photo_data[specimen_id] = f'photos/{filename}'

    if skipped_photos:
        print(f'  [WARN] {skipped_photos} photo(s) skipped (files missing)')
    print(f'  Photo paths: {len(photo_data)} entries')

    photo_data_js = 'window.__PHOTO_DATA = ' + json.dumps(photo_data) + ';\n'

    # ── 6. Fetch CDN libraries ─────────────────────────────────────────────────
    print('\n[6/6] Fetching CDN libraries…')
    cdn_scripts = {}
    for filename, url in CDN_LIBS.items():
        cdn_scripts[filename] = fetch_or_cache(filename, url)
    print(f'  CDN libs loaded: {", ".join(cdn_scripts.keys())}')

    # ── Assemble body HTML ─────────────────────────────────────────────────────
    print('\nAssembling body HTML from collection.html…')
    body_html = build_body_html()

    # ── Build the final HTML ───────────────────────────────────────────────────
    print('Building final HTML…')

    html_out = f'''<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Butterfly Collection</title>
  <style>
{css}
  </style>
</head>
<body>

{body_html}

  <!-- __DATA_START__ -->
  <script>
    /* === Specimen Data ({specimen_count} records) === */
    {seed_data_js}
    /* === Photo Manifest ({len(manifest)} entries) === */
    {photo_manifest_js}
    /* === Photo Paths ({len(photo_data)} entries) === */
    {photo_data_js}
  </script>
  <!-- __DATA_END__ -->

  <!-- ── JSZip ─────────────────────────────────────────────────────────── -->
  <script>
    /* === JSZip (minified) === */
    {cdn_scripts['jszip.min.js']}
  </script>

  <!-- ── jsPDF ─────────────────────────────────────────────────────────── -->
  <script>
    /* === jsPDF (minified) === */
    {cdn_scripts['jspdf.umd.min.js']}
  </script>

  <!-- ── Application Code ──────────────────────────────────────────────── -->
  <script>
    /* === Application Code === */
    {app_js}
  </script>

</body>
</html>'''

    # ── Write output ──────────────────────────────────────────────────────────
    ensure_dir(OUT_DIR)
    ensure_dir(OUT_PHOTOS_DIR)

    html_name = os.path.basename(OUT_FILE)
    print(f'\nWriting {OUT_FILE}…')
    with open(OUT_FILE, 'w', encoding='utf-8') as f:
        f.write(html_out)

    # Remove any stale photos.js from previous builds (the giant base64 bundle)
    if os.path.exists(OUT_PHOTOS_JS):
        os.remove(OUT_PHOTOS_JS)
        print(f'Removed legacy {OUT_PHOTOS_JS}')

    # Write actual photo files to photos/ folder — referenced by <img src>
    print(f'Writing {len(photo_data)} photo files to {OUT_PHOTOS_DIR}…')
    for entry in manifest:
        src = os.path.join(PHOTOS_DIR, entry['filename'])
        dst = os.path.join(OUT_PHOTOS_DIR, entry['filename'])
        if os.path.exists(src):
            import shutil
            shutil.copy2(src, dst)

    # ── Summary ───────────────────────────────────────────────────────────────
    elapsed   = time.time() - t0
    html_size = os.path.getsize(OUT_FILE)

    print('\n' + '=' * 60)
    print('Build complete!')
    print(f'  Output dir:  {OUT_DIR}')
    print(f'  {html_name}:  {html_size / 1_048_576:.1f} MB')
    print(f'  photos/:     {len(photo_data)} files')
    print(f'  Specimens:   {specimen_count}')
    print(f'  Time:        {elapsed:.1f}s')
    print('=' * 60)

    # ── Quick sanity checks ───────────────────────────────────────────────────
    print('\nRunning sanity checks…')
    checks_passed = 0
    checks_failed = 0

    def check(label, condition, detail=''):
        nonlocal checks_passed, checks_failed
        if condition:
            print(f'  ✓ {label}')
            checks_passed += 1
        else:
            print(f'  ✗ {label}' + (f' — {detail}' if detail else ''))
            checks_failed += 1

    check('window.__SEED_DATA present',     'window.__SEED_DATA' in html_out)
    check('window.__PHOTO_MANIFEST present','window.__PHOTO_MANIFEST' in html_out)
    check('window.__PHOTO_DATA inline in HTML', 'window.__PHOTO_DATA' in html_out)
    check('No legacy photos.js bundle',     not os.path.exists(OUT_PHOTOS_JS))
    check('No bare import statements',      not re.search(r'^\s*import\s+\{', html_out, re.MULTILINE))
    check('No export declarations',         not re.search(r'\bexport\s+(function|const|async)\b', html_out))
    check('No module script tags',          'type="module"' not in html_out)
    check('No external link/script tags',   '<link rel="stylesheet"' not in html_out and 'src="https://' not in html_out)
    check('jsPDF inline',                   'jsPDF' in html_out)
    check('JSZip inline',                   'JSZip' in html_out or 'jszip' in html_out.lower())
    check('DOMContentLoaded listener',      'DOMContentLoaded' in html_out)

    print(f'\n  {checks_passed} passed, {checks_failed} failed')
    if checks_failed:
        print('  [WARN] Some checks failed — review the output before distributing.')


if __name__ == '__main__':
    main()
