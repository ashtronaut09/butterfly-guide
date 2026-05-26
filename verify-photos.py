#!/usr/bin/env python3
"""
verify-photos.py
─────────────────
Verifies that each extracted specimen photo matches the image in the
original XLSX, using the same positional mapping as extract-photos.py:

    collection.json[i]  ←→  XLSX drawing row (i + 1)  (0-indexed in XML)

For every specimen that has a photo in data/specimen-photos/:
  - Re-extracts the raw bytes from the XLSX at the expected row
  - Compares them byte-for-byte with the saved file
  - Reports any mismatch, missing, or extra photos

Exit code: 0 if all photos verify, 1 if any mismatch found.
"""

import json
import os
import sys
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

# ── Paths ─────────────────────────────────────────────────────────────────────

XLSX_PATH       = Path('/Users/ashley/Downloads/Butterfly Purchases.xlsx')
COLLECTION_JSON = Path('data/collection.json')
PHOTOS_DIR      = Path('data/specimen-photos')
MANIFEST_PATH   = PHOTOS_DIR / 'manifest.json'

# ── XML Namespaces ────────────────────────────────────────────────────────────

NS_XDR = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing'
NS_A   = 'http://schemas.openxmlformats.org/drawingml/2006/main'
NS_R   = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

# ─────────────────────────────────────────────────────────────────────────────

def parse_rels(zf):
    rels_xml = zf.read('xl/drawings/_rels/drawing1.xml.rels')
    root = ET.fromstring(rels_xml)
    rid_to_path = {}
    for rel in root:
        rid    = rel.get('Id')
        target = rel.get('Target')
        if rid and target:
            if target.startswith('../media/'):
                normalised = 'xl/media/' + target[len('../media/'):]
            else:
                normalised = 'xl/' + target.lstrip('./').lstrip('/')
            rid_to_path[rid] = normalised
    return rid_to_path


def parse_drawing(zf, rid_to_path):
    drawing_xml = zf.read('xl/drawings/drawing1.xml')
    root = ET.fromstring(drawing_xml)
    anchors = root.findall(f'{{{NS_XDR}}}twoCellAnchor')
    row_to_target = {}
    for anchor in anchors:
        row_el = anchor.find(f'{{{NS_XDR}}}from/{{{NS_XDR}}}row')
        blip   = anchor.find(f'.//{{{NS_A}}}blip')
        if row_el is None or blip is None:
            continue
        row = int(row_el.text)
        rid = blip.get(f'{{{NS_R}}}embed')
        if row not in row_to_target:
            target = rid_to_path.get(rid, '')
            if target:
                row_to_target[row] = target
    return row_to_target


def ext_from_path(path):
    return path.rsplit('.', 1)[-1].lower() if '.' in path else ''


def main():
    if not XLSX_PATH.exists():
        print(f'ERROR: xlsx not found at {XLSX_PATH}', file=sys.stderr)
        sys.exit(1)

    print(f'Loading collection.json …')
    with open(COLLECTION_JSON, 'r', encoding='utf-8') as f:
        collection = json.load(f)
    print(f'  {len(collection):,} specimens')

    print(f'Loading manifest.json …')
    with open(MANIFEST_PATH, 'r', encoding='utf-8') as f:
        manifest = json.load(f)
    manifest_by_id = {e['specimenId']: e for e in manifest}
    print(f'  {len(manifest):,} manifest entries')

    print(f'\nOpening {XLSX_PATH.name} …')
    with zipfile.ZipFile(XLSX_PATH, 'r') as zf:
        rid_to_path   = parse_rels(zf)
        row_to_target = parse_drawing(zf, rid_to_path)
        print(f'  {len(row_to_target):,} row → image mappings in XLSX')

        # ── Verify each specimen ──────────────────────────────────────────────

        ok         = 0
        mismatches = []
        skipped    = []   # no photo on disk (EMF or no image in XLSX)
        extra      = []   # photo on disk but no XLSX image at that row

        print(f'\nVerifying {len(collection):,} specimens …\n')

        for idx, specimen in enumerate(collection):
            sid         = specimen['id']
            name        = specimen.get('english_name') or specimen.get('latin_name') or '(unnamed)'
            drawing_row = idx + 1   # collection[0] → drawing row 1

            xlsx_target = row_to_target.get(drawing_row)
            on_disk     = manifest_by_id.get(sid)

            # Neither XLSX nor disk has a photo — fine
            if not xlsx_target and not on_disk:
                continue

            # XLSX has no image for this row but we have one on disk
            if not xlsx_target and on_disk:
                extra.append((idx, sid, name, on_disk['filename']))
                continue

            # Skip EMF (not extractable to disk)
            xlsx_ext = ext_from_path(xlsx_target)
            if xlsx_ext == 'emf':
                if on_disk:
                    extra.append((idx, sid, name, on_disk['filename']))
                continue

            # XLSX has image but nothing on disk — record as skipped
            if not on_disk:
                skipped.append((idx, sid, name, drawing_row, xlsx_target))
                continue

            # Both exist — compare bytes
            disk_path = PHOTOS_DIR / on_disk['filename']
            if not disk_path.exists():
                skipped.append((idx, sid, name, drawing_row, xlsx_target))
                continue

            try:
                xlsx_bytes = zf.read(xlsx_target)
                disk_bytes = disk_path.read_bytes()
            except Exception as e:
                mismatches.append({
                    'idx': idx, 'sid': sid, 'name': name,
                    'reason': f'read error: {e}',
                    'xlsx_target': xlsx_target,
                    'disk_file': on_disk['filename'],
                })
                continue

            if xlsx_bytes == disk_bytes:
                ok += 1
                if ok % 200 == 0:
                    print(f'  … verified {ok} so far')
            else:
                mismatches.append({
                    'idx':         idx,
                    'sid':         sid,
                    'name':        name,
                    'reason':      'bytes differ',
                    'xlsx_target': xlsx_target,
                    'disk_file':   on_disk['filename'],
                    'xlsx_size':   len(xlsx_bytes),
                    'disk_size':   len(disk_bytes),
                })

    # ── Report ────────────────────────────────────────────────────────────────

    print()
    print('═' * 60)
    print('  VERIFICATION REPORT')
    print('═' * 60)
    print(f'  ✓ Verified (byte-perfect) : {ok:,}')
    print(f'  ✗ Mismatches              : {len(mismatches):,}')
    print(f'  ⚠ On disk, not in XLSX    : {len(extra):,}')
    print(f'  ⚠ In XLSX, not on disk    : {len(skipped):,}')
    print('═' * 60)

    if mismatches:
        print(f'\n── MISMATCHES ({len(mismatches)}) ──────────────────────────────')
        for m in mismatches:
            print(f'\n  collection[{m["idx"]}]  {m["name"]}')
            print(f'    specimen id : {m["sid"]}')
            print(f'    XLSX image  : {m["xlsx_target"]}', end='')
            if 'xlsx_size' in m:
                print(f'  ({m["xlsx_size"]:,} bytes)', end='')
            print()
            print(f'    disk file   : {m["disk_file"]}', end='')
            if 'disk_size' in m:
                print(f'  ({m["disk_size"]:,} bytes)', end='')
            print()
            print(f'    reason      : {m["reason"]}')

    if extra:
        print(f'\n── ON DISK BUT NOT IN XLSX ({len(extra)}) ──────────────────')
        for idx, sid, name, filename in extra:
            print(f'  collection[{idx}]  {name}  →  {filename}')

    if skipped:
        print(f'\n── IN XLSX BUT NOT ON DISK ({len(skipped)}) ──────────────────')
        for idx, sid, name, row, target in skipped:
            print(f'  collection[{idx}]  row={row}  {name}  ←  {target}')

    if not mismatches:
        print('\nAll photos verified ✓')
        sys.exit(0)
    else:
        print(f'\n{len(mismatches)} mismatch(es) found — photos may be incorrectly mapped.')
        sys.exit(1)


if __name__ == '__main__':
    main()
