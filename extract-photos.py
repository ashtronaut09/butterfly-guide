#!/usr/bin/env python3
"""
extract-photos.py
─────────────────
Extracts embedded images from "Butterfly Purchases.xlsx" and writes them to
data/specimen-photos/{specimen-id}.{ext}.

Opens the xlsx as a raw zipfile (NOT openpyxl) so no embedded formats are
dropped.  EMF images are skipped because browsers cannot display them.

Mapping:
  collection.json[i]  ←→  xlsx data row (i + 2)  ←→  drawing XML row (i + 1)
  (row in drawing XML is 0-indexed; row 0 = header xlsx row 1)

Also writes data/specimen-photos/manifest.json for the browser photo seeder.
"""

import json
import os
import shutil
import sys
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

# ── Paths ─────────────────────────────────────────────────────────────────────

XLSX_PATH       = Path('/Users/ashley/Downloads/Butterfly Purchases.xlsx')
COLLECTION_JSON = Path('data/collection.json')
OUTPUT_DIR      = Path('data/specimen-photos')
MANIFEST_PATH   = OUTPUT_DIR / 'manifest.json'

# ── XML Namespaces ────────────────────────────────────────────────────────────

NS_XDR = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing'
NS_A   = 'http://schemas.openxmlformats.org/drawingml/2006/main'
NS_R   = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

# ── MIME type map ─────────────────────────────────────────────────────────────

MIME = {
    'png':  'image/png',
    'jpeg': 'image/jpeg',
    'jpg':  'image/jpeg',
    'gif':  'image/gif',
    'emf':  'image/x-emf',   # unsupported in browser — will be skipped
}

# ─────────────────────────────────────────────────────────────────────────────

def load_collection(path: Path) -> list:
    with open(path, 'r', encoding='utf-8') as f:
        return json.load(f)


def parse_rels(zf: zipfile.ZipFile) -> dict:
    """Returns {rId: 'xl/media/imageNNN.ext'} mapping."""
    rels_xml = zf.read('xl/drawings/_rels/drawing1.xml.rels')
    root     = ET.fromstring(rels_xml)
    rid_to_path = {}
    for rel in root:
        rid    = rel.get('Id')           # plain attribute — no namespace prefix
        target = rel.get('Target')       # '../media/imageNNN.ext'
        if rid and target:
            # Normalise target: '../media/image1.png' → 'xl/media/image1.png'
            normalised = 'xl/' + target.lstrip('./').lstrip('/')
            # Handle '../media/' → 'xl/media/'
            if target.startswith('../media/'):
                normalised = 'xl/media/' + target[len('../media/'):]
            rid_to_path[rid] = normalised
    return rid_to_path


def parse_drawing(zf: zipfile.ZipFile, rid_to_path: dict) -> dict:
    """
    Returns {row_0indexed: 'xl/media/imageNNN.ext'} mapping.
    row is 0-indexed (row 1 = first data row = collection[0]).
    Only the first anchor per row is kept (handles 18 shared-image rows).
    """
    drawing_xml = zf.read('xl/drawings/drawing1.xml')
    root        = ET.fromstring(drawing_xml)

    anchors = root.findall(f'{{{NS_XDR}}}twoCellAnchor')
    row_to_target = {}

    for anchor in anchors:
        row_el = anchor.find(f'{{{NS_XDR}}}from/{{{NS_XDR}}}row')
        blip   = anchor.find(f'.//{{{NS_A}}}blip')
        if row_el is None or blip is None:
            continue

        row = int(row_el.text)                          # 0-indexed
        rid = blip.get(f'{{{NS_R}}}embed')

        if row in row_to_target:                        # first anchor wins
            continue

        target = rid_to_path.get(rid, '')
        if target:
            row_to_target[row] = target

    return row_to_target


def ext_from_path(path: str) -> str:
    return path.rsplit('.', 1)[-1].lower() if '.' in path else ''


def main():
    print(f'Opening {XLSX_PATH} …')
    if not XLSX_PATH.exists():
        print(f'ERROR: xlsx not found at {XLSX_PATH}', file=sys.stderr)
        sys.exit(1)

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    collection = load_collection(COLLECTION_JSON)
    print(f'Loaded {len(collection):,} specimens from collection.json')

    with zipfile.ZipFile(XLSX_PATH, 'r') as zf:
        print('Parsing relationship file …')
        rid_to_path = parse_rels(zf)
        print(f'  {len(rid_to_path):,} rId → path mappings')

        print('Parsing drawing XML …')
        row_to_target = parse_drawing(zf, rid_to_path)
        print(f'  {len(row_to_target):,} row → image mappings')

        # ── Extract ──────────────────────────────────────────────────────────

        extracted   = 0
        skipped_emf = 0
        skipped_missing = 0
        failed      = 0
        total_bytes = 0
        manifest    = []
        no_photo_specimens = []

        print(f'\nExtracting to {OUTPUT_DIR} …')

        for idx, specimen in enumerate(collection):
            specimen_id = specimen['id']
            # drawing XML row is 0-indexed; data starts at row 1 (header = row 0)
            drawing_row = idx + 1          # collection[0] → row 1
            target = row_to_target.get(drawing_row)

            # ── No image for this row ─────────────────────────────────────
            if not target:
                skipped_missing += 1
                no_photo_specimens.append((idx, drawing_row, specimen_id,
                                           specimen.get('latin_name', ''), 'no-image'))
                continue

            ext = ext_from_path(target)

            # ── Skip EMF ──────────────────────────────────────────────────
            if ext == 'emf':
                skipped_emf += 1
                no_photo_specimens.append((idx, drawing_row, specimen_id,
                                           specimen.get('latin_name', ''), 'emf'))
                continue

            # ── Copy image ────────────────────────────────────────────────
            dest_filename = f'{specimen_id}.{ext}'
            dest_path     = OUTPUT_DIR / dest_filename
            mime          = MIME.get(ext, 'image/jpeg')

            try:
                data = zf.read(target)
                dest_path.write_bytes(data)
                size = len(data)
                total_bytes += size
                extracted   += 1

                manifest.append({
                    'specimenId': specimen_id,
                    'filename':   dest_filename,
                    'mimeType':   mime,
                })

            except KeyError:
                print(f'  WARNING: zip entry not found: {target} (specimen {specimen_id})',
                      file=sys.stderr)
                failed += 1
                no_photo_specimens.append((idx, drawing_row, specimen_id,
                                           specimen.get('latin_name', ''), 'zip-missing'))
            except Exception as e:
                print(f'  ERROR extracting {target}: {e}', file=sys.stderr)
                failed += 1

        # ── Write manifest ────────────────────────────────────────────────
        MANIFEST_PATH.write_text(
            json.dumps(manifest, indent=2, ensure_ascii=False),
            encoding='utf-8'
        )

    # ── Summary ──────────────────────────────────────────────────────────────

    mb = total_bytes / 1_048_576
    print()
    print('═' * 60)
    print('  EXTRACTION SUMMARY')
    print('═' * 60)
    print(f'  Total specimens    : {len(collection):,}')
    print(f'  Images extracted   : {extracted:,}')
    print(f'  Skipped (EMF)      : {skipped_emf:,}   ← not browser-displayable')
    print(f'  Skipped (no image) : {skipped_missing:,}')
    print(f'  Failures           : {failed:,}')
    print(f'  Total size         : {mb:.1f} MB ({total_bytes:,} bytes)')
    print(f'  Manifest entries   : {len(manifest):,}')
    print(f'  Manifest path      : {MANIFEST_PATH}')
    print('═' * 60)

    if no_photo_specimens:
        print(f'\nSpecimens with no usable photo ({len(no_photo_specimens)}):')
        for idx, row, sid, name, reason in no_photo_specimens:
            short_id = sid[:8] + '…'
            print(f'  collection[{idx:4d}]  row={row:4d}  {short_id}  {reason:12s}  {name}')

    # Extension breakdown
    from collections import Counter
    ext_counts = Counter(
        e['filename'].rsplit('.', 1)[-1]
        for e in manifest
    )
    print(f'\nExtracted by format: {dict(ext_counts)}')


if __name__ == '__main__':
    main()
