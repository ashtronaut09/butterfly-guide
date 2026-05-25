#!/usr/bin/env python3
"""
Second pass of location data cleanup in butterfly collection JSON.

Fixes specific known-bad entries and does a general scan for
non-location data (bred, caught, bought, fake, specimen, photo, pic is)
mixed into the location field.
"""

import json
import re
import sys
from copy import deepcopy

DATA_FILE = "data/collection.json"

# ---------------------------------------------------------------------------
# Specific known-bad entries — exact old_location -> (new_location, rest_to_append)
# ---------------------------------------------------------------------------
SPECIFIC_FIXES = [
    # 1
    (
        "Wittlesea Mere 1840 I'm pretty certain this is fake. Bought when I was still learning",
        "Wittlesea Mere",
        "1840 I'm pretty certain this is fake. Bought when I was still learning",
    ),
    # 2
    (
        "? Bred",
        None,
        "Bred",
    ),
    # 3
    (
        "Canary Islands, bred, Bolton, Lancashire",
        "Canary Islands",
        "bred, Bolton, Lancashire",
    ),
    # 4
    (
        "Cumbria (Bred Geof Wotherspoon6-6-1995)",
        "Cumbria",
        "Bred Geof Wotherspoon 6-6-1995",
    ),
    # 5
    (
        "(Bred Stanley Baker) Norfolk Broads",
        "Norfolk Broads",
        "Bred Stanley Baker",
    ),
    # 6
    (
        "Hants bred 30/7/2014",
        "Hants",
        "bred 30/7/2014",
    ),
    # 7
    (
        "Oxfordshire UK Bred Craib June 1989",
        "Oxfordshire, UK",
        "Bred Craib June 1989",
    ),
    # 8
    (
        "White Down Surrey and a Type male from The South Downs 1950",
        "White Down, Surrey",
        "and a Type male from The South Downs 1950",
    ),
    # 9
    (
        "Tenerife and two males from Gomera all by H.G.Allcard",
        "Tenerife",
        "and two males from Gomera all by H.G.Allcard",
    ),
    # 10
    (
        "Les Andrivaux. Very unusual flight in 28th Aug 2013",
        "Les Andrivaux",
        "Very unusual flight in 28th Aug 2013",
    ),
    # 11
    (
        "Triest Italian Alps? (cept triest isnt in the alps?",
        "Trieste",
        "Note: cept triest isnt in the alps?",
    ),
    # 12
    (
        "Hereford and Kent 1914 &1915 by L E Newman",
        "Hereford and Kent",
        "1914 & 1915 by L E Newman",
    ),
]

# This entry must NOT be changed
KEEP_AS_IS = "Sheep's Head peninsula, South West Co Cork, Eire"

# ---------------------------------------------------------------------------
# General scan: trigger words for non-location content
# ---------------------------------------------------------------------------
TRIGGER_PATTERN = re.compile(
    r'\b(bred|caught|bought|fake|specimen|photo|pic\s+is)\b',
    re.IGNORECASE,
)


def append_to_description(existing, text_to_add):
    """Append text_to_add to existing description with '; ' separator."""
    if existing and existing.strip():
        return existing.strip() + "; " + text_to_add
    return text_to_add


def main():
    with open(DATA_FILE, "r", encoding="utf-8") as f:
        collection = json.load(f)

    changes = []
    errors = []
    skipped_valid = False

    for entry in collection:
        old_location = entry.get("location")
        if not old_location or not isinstance(old_location, str):
            continue

        loc_stripped = old_location.strip()

        # --- Skip valid locations ---
        if loc_stripped == KEEP_AS_IS:
            skipped_valid = True
            continue

        # --- Phase 1: Check specific known-bad entries ---
        matched_specific = False
        for (bad_loc, new_loc, desc_extra) in SPECIFIC_FIXES:
            if loc_stripped == bad_loc:
                old_desc = entry.get("description")
                new_desc = append_to_description(old_desc, desc_extra)

                # Build the change record
                change_record = {
                    "id": entry.get("id", "???"),
                    "english_name": entry.get("english_name", "???"),
                    "old_location": old_location,
                    "new_location": new_loc,
                    "old_description": old_desc,
                    "new_description": new_desc,
                }

                entry["location"] = new_loc
                entry["description"] = new_desc
                changes.append(change_record)
                matched_specific = True
                break

        if matched_specific:
            continue

        # --- Phase 2: General scan for trigger keywords ---
        match = TRIGGER_PATTERN.search(loc_stripped)
        if match:
            trigger_index = match.start()
            # Everything before the trigger word is the place name
            place_part = loc_stripped[:trigger_index].strip().rstrip(",").strip()
            rest_part = loc_stripped[trigger_index:].strip()

            # If place_part is empty or just punctuation, set location to null
            if not place_part or re.match(r'^[\s\?\(\)\[\]\.]+$', place_part):
                new_loc = None
            else:
                new_loc = place_part

            old_desc = entry.get("description")
            new_desc = append_to_description(old_desc, rest_part)

            change_record = {
                "id": entry.get("id", "???"),
                "english_name": entry.get("english_name", "???"),
                "old_location": old_location,
                "new_location": new_loc,
                "old_description": old_desc,
                "new_description": new_desc,
            }

            entry["location"] = new_loc
            entry["description"] = new_desc
            changes.append(change_record)

    # --- Save back ---
    with open(DATA_FILE, "w", encoding="utf-8") as f:
        json.dump(collection, f, indent=2, ensure_ascii=False)
        f.write("\n")

    # --- Report ---
    print("=" * 72)
    print("  LOCATION CLEANUP — SECOND PASS REPORT")
    print("=" * 72)

    if skipped_valid:
        print(f"\n  ✓ Skipped (valid location): \"{KEEP_AS_IS}\"")

    if not changes:
        print("\n  No changes were made.")
        return

    print(f"\n  Total changes: {len(changes)}\n")

    for i, c in enumerate(changes, 1):
        print(f"  --- Change {i} ---")
        print(f"  ID:       {c['id']}")
        print(f"  Species:  {c['english_name']}")
        print(f"  Location: {c['old_location']!r}")
        print(f"         → {c['new_location']!r}")
        print(f"  Desc:     {c['old_description']!r}")
        print(f"         → {c['new_description']!r}")
        print()

    if errors:
        print(f"\n  WARNING: {len(errors)} error(s) occurred:")
        for e in errors:
            print(f"    - {e}")

    print("  Done.")


if __name__ == "__main__":
    main()
