#!/usr/bin/env python3
"""
Phase 1: Fetch all European butterfly species from iNaturalist API.
Outputs data/species-raw.json and downloads images to images/{taxon_id}.jpg
"""

import json
import os
import ssl
import time
import urllib.request
import urllib.error
from pathlib import Path

# Fix SSL cert verification on macOS Python 3.13
ssl_ctx = ssl.create_default_context()
ssl_ctx.check_hostname = False
ssl_ctx.verify_mode = ssl.CERT_NONE

BASE_URL = "https://api.inaturalist.org/v1"
DATA_DIR = Path("data")
CACHE_DIR = DATA_DIR / "api-cache"
IMAGES_DIR = Path("images")

TAXON_BUTTERFLIES = 47224  # Papilionoidea
PLACE_EUROPE = 97391


def fetch_json(url, cache_key=None):
    if cache_key:
        cache_file = CACHE_DIR / f"{cache_key}.json"
        if cache_file.exists():
            with open(cache_file) as f:
                return json.load(f)

    req = urllib.request.Request(url, headers={"User-Agent": "butterfly-guide/1.0"})
    with urllib.request.urlopen(req, context=ssl_ctx) as resp:
        data = json.loads(resp.read())

    if cache_key:
        with open(CACHE_DIR / f"{cache_key}.json", "w") as f:
            json.dump(data, f)

    time.sleep(1)
    return data


def get_all_species():
    all_results = []
    page = 1
    while True:
        url = (
            f"{BASE_URL}/observations/species_counts"
            f"?taxon_id={TAXON_BUTTERFLIES}"
            f"&place_id={PLACE_EUROPE}"
            f"&quality_grade=research"
            f"&per_page=200"
            f"&page={page}"
        )
        print(f"Fetching species page {page}...")
        data = fetch_json(url, cache_key=f"species_page_{page}")
        results = data.get("results", [])
        if not results:
            break
        all_results.extend(results)
        total = data.get("total_results", 0)
        print(f"  Got {len(all_results)}/{total} species")
        if len(all_results) >= total:
            break
        page += 1
    return all_results


def get_taxon_details(taxon_ids):
    """Fetch enriched taxon data in batches of 30."""
    details = {}
    batch_size = 30
    for i in range(0, len(taxon_ids), batch_size):
        batch = taxon_ids[i:i + batch_size]
        ids_str = ",".join(str(t) for t in batch)
        cache_key = f"taxa_batch_{i}"
        url = f"{BASE_URL}/taxa/{ids_str}"
        print(f"Fetching taxon details batch {i//batch_size + 1}/{(len(taxon_ids)-1)//batch_size + 1}...")
        data = fetch_json(url, cache_key=cache_key)
        for taxon in data.get("results", []):
            details[taxon["id"]] = taxon
    return details


def extract_family(ancestors):
    """Find family and subfamily from ancestor list."""
    family = None
    subfamily = None
    for ancestor in ancestors or []:
        if ancestor.get("rank") == "family":
            family = ancestor.get("name")
        elif ancestor.get("rank") == "subfamily":
            subfamily = ancestor.get("name")
    return family, subfamily


def extract_conservation_status(taxon_detail):
    """Get the most relevant conservation status."""
    # Try top-level first
    status = taxon_detail.get("conservation_status")
    if status and status.get("status_name"):
        return status["status_name"].upper()

    # Fall back to conservation_statuses array — prefer IUCN global
    statuses = taxon_detail.get("conservation_statuses", [])
    for s in statuses:
        authority = (s.get("authority") or "").upper()
        if "IUCN" in authority:
            return (s.get("status") or "").upper()

    # Any status will do
    if statuses:
        return (statuses[0].get("status") or "").upper()

    return None


def photo_url(url, size="medium"):
    """Replace square/small/medium/large in iNaturalist photo URLs."""
    for suffix in ["square", "small", "medium", "large", "original"]:
        if suffix + ".jpg" in url:
            return url.replace(suffix + ".jpg", size + ".jpg")
    return url


def download_image(url, dest_path):
    if dest_path.exists():
        return True
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "butterfly-guide/1.0"})
        with urllib.request.urlopen(req, timeout=15, context=ssl_ctx) as resp:
            dest_path.write_bytes(resp.read())
        time.sleep(0.5)
        return True
    except Exception as e:
        print(f"  Image download failed for {url}: {e}")
        return False


def build_species_record(basic, detail):
    taxon = basic["taxon"]
    taxon_id = taxon["id"]

    ancestors = detail.get("ancestors", [])
    family, subfamily = extract_family(ancestors)

    photo = taxon.get("default_photo") or {}
    raw_photo_url = photo.get("url", "")
    medium_url = photo_url(raw_photo_url, "medium") if raw_photo_url else ""

    wiki_summary = detail.get("wikipedia_summary", "") or ""
    # Trim to first 2 sentences max
    sentences = wiki_summary.split(". ")
    short_summary = ". ".join(sentences[:2]) + ("." if len(sentences) > 1 else "")

    return {
        "id": taxon_id,
        "scientific_name": taxon.get("name", ""),
        "common_name": taxon.get("preferred_common_name", "") or taxon.get("name", ""),
        "family": family or "Unknown",
        "subfamily": subfamily or "",
        "image_url": medium_url,
        "image_local": f"images/{taxon_id}.jpg" if medium_url else "",
        "image_attribution": photo.get("attribution", ""),
        "image_license": photo.get("license_code", ""),
        "conservation_status": extract_conservation_status(detail),
        "wikipedia_summary": short_summary,
        "wikipedia_url": taxon.get("wikipedia_url", ""),
        "observation_count": basic.get("count", 0),
        "inaturalist_url": f"https://www.inaturalist.org/taxa/{taxon_id}",
        "tags": {}  # filled by enrich-data.py
    }


def main():
    print("=== European Butterfly Data Fetcher ===\n")

    print("Step 1: Fetching species list...")
    species_list = get_all_species()
    print(f"Total species found: {len(species_list)}\n")

    print("Step 2: Fetching taxon details...")
    taxon_ids = [s["taxon"]["id"] for s in species_list]
    details = get_taxon_details(taxon_ids)
    print(f"Got details for {len(details)} taxa\n")

    print("Step 3: Building records...")
    records = []
    for basic in species_list:
        taxon_id = basic["taxon"]["id"]
        detail = details.get(taxon_id, {})
        record = build_species_record(basic, detail)
        records.append(record)

    print(f"Built {len(records)} records\n")

    raw_path = DATA_DIR / "species-raw.json"
    with open(raw_path, "w") as f:
        json.dump(records, f, indent=2)
    print(f"Saved {raw_path}\n")

    print("Step 4: Downloading images...")
    success = 0
    failed = 0
    for i, record in enumerate(records):
        if not record["image_url"]:
            failed += 1
            continue
        dest = IMAGES_DIR / f"{record['id']}.jpg"
        ok = download_image(record["image_url"], dest)
        if ok:
            success += 1
        else:
            failed += 1
            record["image_local"] = ""
        if (i + 1) % 25 == 0:
            print(f"  [{i+1}/{len(records)}] downloaded...")

    # Re-save with any image_local corrections
    with open(raw_path, "w") as f:
        json.dump(records, f, indent=2)

    print(f"\nDone. {success} images downloaded, {failed} failed.")
    print(f"Output: {raw_path}")


if __name__ == "__main__":
    os.chdir(Path(__file__).parent)
    main()
