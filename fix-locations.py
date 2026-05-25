#!/usr/bin/env python3
"""
fix-locations.py — Clean up location fields in collection.json.

Extracts proper place names from location fields that contain entire
descriptions, notes, or concatenated text. Operates as a separate
post-processing step after import-xlsx.py.

Key fixes:
  - Long locations (>60 chars) → extract place name from beginning
  - Purely descriptive text → move to description field, location = null
  - Postal codes → strip them
  - Concatenated text (e.g. "FranceScolitandides...") → split
  - Normalize "Czech Rep" → "Czech Republic", etc.
  - Move description-like material to description field

Usage:
  python3 fix-locations.py

Output:
  Writes cleaned data back to data/collection.json
  Prints a report of all changes made.
"""

import json
import os
import re
import sys
from pathlib import Path

# ── Paths ──────────────────────────────────────────────────────────────────
DATA_DIR = Path(__file__).parent / "data"
COLLECTION_JSON = DATA_DIR / "collection.json"

# ─── KNOWN LOCATION TOKENS ────────────────────────────────────────────────
# These are words/phrases that unambiguously indicate a geographic location
# when they appear at the start of a location string.

COUNTRIES = {
    "france", "spain", "italy", "poland", "greece", "germany",
    "switzerland", "austria", "croatia", "hungary", "romania", "bulgaria",
    "uk", "russia", "sweden", "china", "japan", "turkey",
    "morocco", "algeria", "macedonia", "slovakia", "slovenia",
    "czech", "serbia", "bosnia", "albania", "portugal",
    "netherlands", "belgium", "england", "scotland", "wales", "ireland",
    "norway", "finland", "denmark", "lithuania", "latvia", "estonia",
    "ukraine", "moldova", "armenia", "georgia", "azerbaijan",
    "kazakhstan", "mongolia", "kyrgyzstan", "tajikistan",
    "turkmenistan", "uzbekistan", "afghanistan", "pakistan",
    "india", "nepal", "bhutan", "myanmar", "thailand", "vietnam",
    "laos", "cambodia", "indonesia", "philippines",
    "andorra", "monaco", "liechtenstein", "luxembourg", "malta",
    "taiwan", "korea", "africa", "europe", "asia", "america",
    "siberia", "transbaical",
}

# Regions / larger areas (treated as valid location anchors)
REGIONS = {
    "alps", "pyrenees", "caucasus", "ural", "altai", "himalayas",
    "iberian", "balkan", "carpathian", "anatolia",
    "sicily", "sardinia", "corsica", "crete", "cyprus", "rhodes",
    "majorca", "menorca", "ibiza", "canary", "azores", "madeira",
    "man",  # Isle of Man
    "wight",  # Isle of Wight
}

# UK counties / districts (frequently appear with "UK")
UK_COUNTIES = {
    "surrey", "hampshire", "sussex", "devon", "cornwall",
    "somerset", "dorset", "kent", "essex", "suffolk", "norfolk",
    "bucks", "oxon", "northants", "warks", "wilts", "gloucs",
    "cambs", "beds", "herts", "middx", "yorks", "lancs",
    "notts", "derby", "staffs", "shrops", "worcs", "herefs",
    "salop", "berks", "hunts", "rutland",
    "cuckfield", "folkstone", "kildare",
    "winchester", "royston", "barnsley", "painswick",
    "blean", "southampton", "swanage",
    "cotswolds", "chilterns", "new",  # "New Forest"
}

# Geographic modifiers that can appear between a compass direction and a region
GEO_MODIFIERS = {
    "french", "swiss", "italian", "austrian", "german", "spanish",
    "european", "asian", "african",
}

# Compass-direction prefixes that combine with country/region
COMPASS_DIRECTIONS = {
    "northern", "southern", "eastern", "western", "central",
    "south", "north", "east", "west",
    "south east", "south west", "north east", "north west",
    "south-eastern", "south-western", "north-eastern", "north-western",
    "se", "sw", "ne", "nw",
    "southeastern", "southwestern", "northeastern", "northwestern",
    "northeast", "northwest", "southeast", "southwest",
    "north-east", "north-west", "south-east", "south-west",
    "south eastern", "south western", "north eastern", "north western",
}

# Words that, when starting a location, indicate it's purely descriptive
# (not a location at all)
DESCRIPTIVE_STARTS = {
    "another", "collection", "magnificent", "our", "this", "that",
    "these", "those", "other", "many", "two", "some", "several",
    "there", "here", "where", "which", "stock", "a", "an", "the",
    "by", "in", "at", "on", "from", "with", "for", "but",
    "peninsular", "europe", "butterfly",
}

# Abbreviated compass directions for cleanup
ABBREV_COMPASS = {
    "se": "SE", "sw": "SW", "ne": "NE", "nw": "NW",
}

# UK county abbreviations for expansion
UK_COUNTY_ABBREV = {
    "northants": "Northamptonshire",
    "warwicks": "Warwickshire",
    "warwick": "Warwickshire",
    "worcs": "Worcestershire",
    "staffs": "Staffordshire",
    "gloucs": "Gloucestershire",
    "herefs": "Herefordshire",
    "salop": "Shropshire",
    "notts": "Nottinghamshire",
    "derby": "Derbyshire",
    "yorks": "Yorkshire",
    "lancs": "Lancashire",
    "cambs": "Cambridgeshire",
    "beds": "Bedfordshire",
    "herts": "Hertfordshire",
    "middx": "Middlesex",
    "hunts": "Huntingdonshire",
    "bucks": "Buckinghamshire",
    "oxon": "Oxfordshire",
    "wilts": "Wiltshire",
    "berks": "Berkshire",
    "glouces": "Gloucestershire",
    "worcester": "Worcestershire",
    "leics": "Leicestershire",
}


def load_collection(path):
    """Load the JSON collection."""
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    return data


def save_collection(data, path):
    """Write the JSON collection."""
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    print(f"✅ Saved {len(data)} specimens to {path}")


# ══════════════════════════════════════════════════════════════════════════
#  HELPER: Recognizing location tokens
# ══════════════════════════════════════════════════════════════════════════


def _clean_word(word):
    """Lowercase and strip trailing punctuation."""
    return word.lower().rstrip(".,;:!?")


def is_known_token(word):
    """Check if a word (lowercased) is a known location token."""
    w = _clean_word(word)
    return w in COUNTRIES or w in REGIONS or w in UK_COUNTIES


def extend_location_prefix(words, prefix_len):
    """Try to extend a recognized location prefix with more location words.
    
    E.g., if prefix is "south east" (prefix_len=2), check if following
    words like "French", "Alps", etc. should be included.
    Returns the extended prefix length.
    """
    n = len(words)
    i = prefix_len
    
    # Extend through geographic modifiers (e.g., "French")
    while i < n and _clean_word(words[i]) in GEO_MODIFIERS:
        i += 1
    
    # Extend through region names (e.g., "Alps", "Pyrenees")
    while i < n and (is_known_token(words[i])):
        i += 1
    
    # Also try to consume "and" + similar region combinations
    # e.g., "Central & Eastern Spain" 
    if i < n and _clean_word(words[i]) in ("&", "and"):
        conj = i
        i += 1
        # Check if followed by a compass direction + country
        remaining_words = words[i:]
        sub_len = is_known_location_prefix(remaining_words)
        if sub_len > 0:
            i += sub_len
        else:
            i = conj  # Don't consume the conjunction
    
    return i


def is_known_location_prefix(words):
    """Check if the first few words form a known location prefix.
    
    Returns the number of words that constitute the location prefix, or 0.
    Extends to include geographic modifiers and features.
    """
    if not words:
        return 0
    
    # Check multi-word compass directions first (e.g., "south east")
    for prefix_len in range(min(3, len(words)), 0, -1):
        prefix = " ".join(_clean_word(w) for w in words[:prefix_len])
        
        if prefix in COMPASS_DIRECTIONS:
            # Extend through GEO_MODIFIERS and regions
            return extend_location_prefix(words, prefix_len)
    
    # Check single word: known location token
    if is_known_token(words[0]):
        extended = extend_location_prefix(words, 1)
        return extended
    
    # Check single word compass direction followed by a location
    w1 = _clean_word(words[0])
    if w1 in ("northern", "southern", "eastern", "western", "central",
              "north", "south", "east", "west"):
        if len(words) >= 2:
            w2 = _clean_word(words[1])
            if is_known_token(w2) or w2 in GEO_MODIFIERS:
                return extend_location_prefix(words, 2)
    
    # Handle "Isle of X"
    if len(words) >= 3 and _clean_word(words[0]) == "isle" and _clean_word(words[1]) == "of":
        if is_known_token(words[2]):
            return extend_location_prefix(words, 3)
    
    # Handle "South of X"
    if len(words) >= 3 and _clean_word(words[0]) == "south" and _clean_word(words[1]) == "of":
        if is_known_token(words[2]):
            return extend_location_prefix(words, 3)
    
    # Handle "X UK" or "X France" pattern (town/area + country)
    if len(words) >= 2:
        w2 = _clean_word(words[1])
        if w2 in ("uk", "france", "spain", "italy", "poland", "greece", "germany"):
            if is_known_token(words[0]):
                return extend_location_prefix(words, 2)
    
    return 0


# ══════════════════════════════════════════════════════════════════════════
#  CLEANUP FUNCTIONS
# ══════════════════════════════════════════════════════════════════════════


def normalize_compass_prefix(text):
    """Normalize compass direction prefix to standard form.
    
    "south east poland" → "SE Poland"
    "south-eastern france" → "SE France"
    "northern spain" → "Northern Spain"
    """
    words = text.split()
    if not words:
        return text
    
    # Map of multi-word compass variants to short form
    compass_map = {
        "south east": "SE", "south west": "SW",
        "north east": "NE", "north west": "NW",
        "south-east": "SE", "south-west": "SW",
        "north-east": "NE", "north-west": "NW",
        "southeast": "SE", "southwest": "SW",
        "northeast": "NE", "northwest": "NW",
        "south eastern": "SE", "south western": "SW",
        "north eastern": "NE", "north western": "NW",
        "south-eastern": "SE", "south-western": "SW",
        "north-eastern": "NE", "north-western": "NW",
        "southeastern": "SE", "southwestern": "SW",
        "northeastern": "NE", "northwestern": "NW",
    }
    
    # Check 2-word compass
    if len(words) >= 2:
        pair = " ".join(words[:2]).lower()
        if pair in compass_map:
            new_prefix = compass_map[pair]
            rest = " ".join(words[2:])
            if rest and rest[0].islower():
                rest = rest[0].upper() + rest[1:]
            return f"{new_prefix} {rest}"
    
    # Check 1-word compass (northern/southern etc.)
    single_cap = {
        "northern": "Northern", "southern": "Southern",
        "eastern": "Eastern", "western": "Western",
        "central": "Central",
    }
    first_word_lower = words[0].lower()
    if first_word_lower in single_cap:
        words[0] = single_cap[first_word_lower]
        return " ".join(words)
    
    # Check abbreviated compass (se, sw, ne, nw)
    if first_word_lower in ABBREV_COMPASS and len(words) >= 2:
        words[0] = ABBREV_COMPASS[first_word_lower]
        if words[1][0].islower():
            words[1] = words[1][0].upper() + words[1][1:]
        return " ".join(words)
    
    return text


def strip_postal_code(text):
    """Strip French 5-digit postal codes from the beginning."""
    m = re.match(r"^(\d{5})\s*,?\s*(.*)$", text)
    if m:
        return m.group(2).strip(), m.group(1)
    return text, None


def fix_concatenated_text(text):
    """Fix concatenated text like 'FranceScolitandides...' or 'UKDifficult label...'.
    
    IMPORTANT: Only splits when a known location word is immediately followed
    by a GENUINE uppercase letter (not via case-insensitive matching).
    
    Returns (clean_text, extracted_rest) where extracted_rest is text that
    was concatenated to a location word and should be moved to description.
    """
    if not text:
        return text, None
    
    # Sort countries by length descending to match longest first
    # Don't match "uk" if it would split words like "Ukraine"
    # Only check for countries that could reasonably appear as concatenation
    concat_candidates = sorted(
        [c for c in COUNTRIES if len(c) >= 2],
        key=len, reverse=True
    )
    
    for country in concat_candidates:
        # Must match at start of text
        if not text.lower().startswith(country):
            continue
        
        prefix = text[:len(country)]
        rest = text[len(country):]
        
        # rest must be non-empty and must start with a letter
        if not rest or not rest[0].isalpha():
            continue
        
        # The character AFTER the country name must be a genuine uppercase letter
        # ("FranceMélitaea" → 'M' is uppercase → split)
        # ("Ukraine" → 'r' is lowercase → don't split)
        # ("UKDifficult" → 'D' is uppercase → split)
        if not rest[0].isupper():
            continue
        
        # Also make sure the result is reasonable:
        # If the country is "uk" and the rest starts with a vowel or known
        # word continuation, be extra careful.
        if country.lower() == "uk":
            # "Ukraine", "Ukrainian" etc → don't split
            if rest.lower().startswith(('r', 'ra')):
                continue
        
        # "Austrian" → "Austria"+"n" - don't split if only 1 char follows
        # and the country is the start of another word
        if len(rest) == 1 and rest[0].isalpha():
            continue
        
        return prefix.strip(), rest.strip()
    
    return text, None


def normalize_punctuation_spacing(text):
    """Insert missing spaces after periods, colons, etc. followed by letters.
    
    "SE France.This" → "SE France. This"
    "Not rare...France" → "Not rare... France" (handles ellipsis too)
    """
    # Add space after period/colon/ellipsis followed immediately by a letter
    text = re.sub(r'\.(?=[A-Za-zÀ-ÖØ-öø-ÿ])', '. ', text)
    text = re.sub(r'\:(?=[A-Za-zÀ-ÖØ-öø-ÿ])', ': ', text)
    text = re.sub(r'\.\.\.(?=[A-Za-zÀ-ÖØ-öø-ÿ])', '... ', text)
    # Clean up any double spaces created
    text = re.sub(r'  +', ' ', text)
    return text


def split_mixed_location(text):
    """Split mixed "Location. Description" or "Location Description" patterns.
    
    For all entries (not just long ones), check if the text starts with a
    recognized location prefix followed by description-like text.
    
    Returns (location, description_material) or (text, None) if no split.
    """
    if not text:
        return text, None
    
    text = normalize_punctuation_spacing(text)
    words = text.split()
    if not words:
        return text, None
    
    # Check for period-separated pattern: "Croatia. Female ab white"
    # or "North Africa. These are from..."
    m = re.match(r"^(.*?[.])\s+", text)
    if m:
        first_sentence = m.group(1).strip().rstrip(".").strip()
        rest = text[m.end():].strip()
        if first_sentence and rest:
            sent_words = first_sentence.split()
            prefix_len = is_known_location_prefix(sent_words)
            if prefix_len > 0 and prefix_len == len(sent_words):
                # Entire first sentence is a location → split
                return first_sentence, rest
    
    # Check for "X Description" (no period) where X is a known location
    # and what follows is clearly description (not just a location continuation)
    prefix_len = is_known_location_prefix(words)
    if 0 < prefix_len < len(words):
        loc_part = " ".join(words[:prefix_len])
        rest = " ".join(words[prefix_len:])
        
        if rest:
            rest_first = rest.lower().split()[0] if rest.split() else ""
            
            # Description keywords that clearly indicate non-location text
            desc_triggers = {"female", "abs", "ab", "aberration", "sp", "unique",
                             "this", "the", "were", "are", "and", "i'm", "bought",
                             "these", "they", "it", "species", "quite", "very",
                             "does", "not", "tiny", "ex", "with", "all"}
            if rest_first in desc_triggers:
                return loc_part, rest
            
            # If rest starts with lowercase, check if it's a location
            # continuation (French/Italian/ Spanish preposition) or description
            if rest[0].islower():
                # Location continuations: "de France", "del Norte", "du Sud" etc.
                # These are part of a location, not description
                location_continuations = {"de", "del", "della", "delle", "degli",
                                          "du", "des", "la", "le", "les",
                                          "di", "da", "el", "los", "las", "al"}
                if rest_first not in location_continuations:
                    # Also skip if the rest contains known location words
                    # like "France", "Spain" — it's likely a location continuation
                    rest_words = rest.split()
                    has_country = any(w.lower().rstrip(".,;") in COUNTRIES for w in rest_words)
                    if not has_country:
                        return loc_part, rest
    
    return text, None


def extract_location_from_long(text):
    """Try to extract a location from a long (>60 chars) text.
    
    Returns (location, description_material) where description_material
    is the text to move to the description field.
    
    If no clear location can be extracted, returns (None, text).
    """
    # Pre-process: ensure spacing after punctuation
    text = normalize_punctuation_spacing(text)
    
    words = text.split()
    if not words:
        return None, text
    
    first_word = _clean_word(words[0])
    
    # ── Step 1: Purely descriptive starts → not a location ─────────────
    if first_word in DESCRIPTIVE_STARTS:
        return None, text
    
    # ── Step 2: Check for "X. Description" pattern ─────────────────────
    # If first sentence ends with period and looks like a location
    m = re.match(r"^([^.!?]+[.!?])\s+", text)
    if m:
        first_sentence = m.group(1).strip().rstrip(".!?").strip()
        sent_words = first_sentence.split()
        rest = text[m.end():].strip()
        
        prefix_len = is_known_location_prefix(sent_words)
        if prefix_len > 0:
            if prefix_len == len(sent_words):
                # Entire first sentence is a location
                return first_sentence, rest
            else:
                # First part of sentence is location, rest of sentence is description
                loc_part = " ".join(sent_words[:prefix_len])
                rest_of_sent = " ".join(sent_words[prefix_len:])
                full_rest = (rest_of_sent + " " + rest).strip()
                return loc_part, full_rest
    
    # ── Step 3: Check for "X Description" (no period separation) ───────
    # "Swanage UK This male..." "Croatia This is..."
    prefix_len = is_known_location_prefix(words)
    if prefix_len > 0:
        loc_part = " ".join(words[:prefix_len])
        rest = " ".join(words[prefix_len:])
        if rest:
            return loc_part, rest
        else:
            return text, None
    
    # ── Step 4: Check for "X and description" where X is a country ─────
    # "France and were caught..." → "France" + description
    if len(words) >= 2:
        w2 = _clean_word(words[1])
        if first_word in COUNTRIES and w2 in ("and", "were", "are", "this", "these", "the"):
            return words[0], " ".join(words[1:])
        
        # "Poland. I am glad..." (period attached to Poland)
        if first_word.rstrip(".").lower() in COUNTRIES and words[0].endswith("."):
            clean_loc = words[0].rstrip(".")
            return clean_loc, " ".join(words[1:])
    
    # ── Step 5: Check for "Corsica 2009..." → "Corsica" ────────────────
    if len(words) >= 2 and first_word in COUNTRIES | REGIONS:
        w2 = _clean_word(words[1])
        if w2.isdigit():
            return words[0], " ".join(words[1:])
    
    # ── Step 6: If text starts with lowercase, not a compass direction ──
    if text[0].islower() and _clean_word(words[0]) not in COMPASS_DIRECTIONS:
        if not is_known_token(words[0]):
            return None, text
    
    # If nothing else worked, check if we can extract a location from end
    suffix_loc, prefix_desc = extract_location_suffix(text)
    if suffix_loc:
        return suffix_loc, prefix_desc
    
    return None, text


def extract_location_suffix(text):
    """Check if a long descriptive text ends with a clear location marker.
    
    For example: "SE Europe to Iran... These are from Greece" → "Greece"
    "Europe to Japan... These are from France" → "France"
    
    Returns (location, rest) or (None, text).
    """
    # Check for "These are from X" at the end
    m = re.search(r"These are from\s+(\w+(?:\s+\w+){0,3})$", text, re.IGNORECASE)
    if m:
        loc_candidate = m.group(1)
        loc_words = loc_candidate.split()
        prefix_len = is_known_location_prefix(loc_words)
        if prefix_len > 0:
            loc = " ".join(loc_words[:prefix_len])
            rest = text[:m.start()].strip()
            rest = re.sub(r"\.\.\.?\s*$", "", rest).strip()
            return loc, rest
        # Also check if the word itself is a country
        if _clean_word(loc_words[0]) in COUNTRIES:
            rest = text[:m.start()].strip()
            rest = re.sub(r"\.\.\.?\s*$", "", rest).strip()
            return loc_words[0].rstrip(".,;"), rest
    
    # Check for "from X" at the end (conservative: only if X is a known place)
    m = re.search(r"from\s+(\w+(?:\s+\w+){0,2})\s*$", text, re.IGNORECASE)
    if m:
        loc_candidate = m.group(1)
        loc_words = loc_candidate.split()
        prefix_len = is_known_location_prefix(loc_words)
        if prefix_len > 0:
            loc = " ".join(loc_words[:prefix_len])
            rest = text[:m.start()].strip()
            rest = re.sub(r"\bfrom\s*$", "", rest).strip()
            rest = re.sub(r"[,.;]+\s*$", "", rest).strip()
            return loc, rest
    
    return None, text


def is_purely_descriptive(text):
    """Check if the entire text is purely descriptive (not a location at all).
    
    Returns True if the text has no recognizable location content.
    """
    if not text:
        return True
    
    words = text.split()
    if not words:
        return True
    
    first_word = _clean_word(words[0])
    
    # Known non-location starters
    if first_word in DESCRIPTIVE_STARTS:
        return True
    
    # Text starting with lowercase that doesn't match a known location pattern
    if text[0].islower():
        prefix_len = is_known_location_prefix(words)
        if prefix_len == 0:
            return True
    
    # Specific non-location patterns
    text_lower = text.lower()
    
    # "meillon 64 france" — a specific address-like entry, not a proper location
    if re.match(r'^meillon\s+\d+\s+france', text_lower):
        return True
    
    # "otztat untergurgl" — questionable location
    if text_lower.startswith('otztat'):
        return True
    
    return False


def normalize_location_variants(text):
    """Normalize common location name variants."""
    if not text:
        return text
    
    cleaned = text.strip()
    
    # "Czech Rep" → "Czech Republic"
    cleaned = re.sub(r'\bCzech\s+Rep\b', 'Czech Republic', cleaned)
    cleaned = re.sub(r'\bCzech\s+Rebuplic\b', 'Czech Republic', cleaned)
    cleaned = re.sub(r'\bCzech\s+Rebublic\b', 'Czech Republic', cleaned)
    
    # "Czech &Slovakia" → "Czech Republic & Slovakia"
    # "Czech & Slovakia" → "Czech Republic & Slovakia"
    cleaned = re.sub(r'\bCzech\s*&+\s*Slovakia\b', 'Czech Republic & Slovakia', cleaned)
    
    # "Rakousko (Czech for Austria)" → "Austria"
    if re.match(r'^Rakousko\s*\(Czech for Austria\)\s*$', cleaned, re.IGNORECASE):
        return "Austria"
    
    # "Rakousko" alone → "Austria" (Czech for Austria)
    if cleaned.lower().strip() == "rakousko":
        return "Austria"
    
    # Capitalize single-word country names
    words = cleaned.split()
    if len(words) == 1:
        w = words[0]
        if w.lower() in COUNTRIES or w.lower() in REGIONS:
            cap = w[0].upper() + w[1:]
            return cap
    
    # Capitalize UK places: "winchester UK" → "Winchester, UK"
    if len(words) >= 2 and words[-1].upper() == "UK":
        place_part = " ".join(words[:-1])
        if place_part and place_part[0].islower():
            # Capitalize the first letter
            place_part = place_part[0].upper() + place_part[1:]
        # Add comma before UK if not present
        if not place_part.endswith(","):
            cleaned = f"{place_part}, UK"
        else:
            cleaned = f"{place_part} UK"
    
    # "Bolton uk" → "Bolton, UK"
    if len(words) >= 2 and words[-1].lower() == "uk":
        place_part = " ".join(words[:-1])
        if place_part[0].islower():
            place_part = place_part[0].upper() + place_part[1:]
        cleaned = f"{place_part}, UK"
    
    # Expand UK county abbreviations
    for abbrev, full in UK_COUNTY_ABBREV.items():
        # Match as a whole word (not as part of another word)
        pattern = re.compile(r'\b' + re.escape(abbrev) + r'\b', re.IGNORECASE)
        if pattern.search(cleaned):
            cleaned = pattern.sub(full, cleaned)
            break  # Only expand one abbreviation per entry
    
    return cleaned


def truncate_after_location(text):
    """Clean up a location string — trim trailing punctuation and whitespace."""
    text = text.strip().rstrip(".,;:!?")
    text = re.sub(r"\s+", " ", text).strip()
    return text


# ══════════════════════════════════════════════════════════════════════════
#  MAIN CLEANUP
# ══════════════════════════════════════════════════════════════════════════

def clean_specimen_location(specimen):
    """Clean the location field of a single specimen.
    
    Returns (cleaned_location, description_to_add, changes_made).
    """
    orig_location = specimen.get("location")
    if not orig_location:
        return None, None, None
    
    orig_desc = specimen.get("description") or ""
    
    location = orig_location
    desc_addition = None
    changes = []
    
    # ═══ Step 1: Fix concatenated text ═══════════════════════════════════
    fixed_loc, extracted = fix_concatenated_text(location)
    if extracted:
        changes.append(f"concatenated text split: '{location}' → '{fixed_loc}' + description text")
        location = fixed_loc
        if desc_addition:
            desc_addition = extracted + " " + desc_addition
        else:
            desc_addition = extracted
    
    if not location:
        return None, desc_addition, changes
    
    # ═══ Step 2: Strip postal codes ══════════════════════════════════════
    stripped_loc, postal = strip_postal_code(location)
    if postal:
        changes.append(f"postal code removed: '{postal}'")
        location = stripped_loc
    
    # ═══ Step 3: Normalize common variants ═══════════════════════════════
    normalized_loc = normalize_location_variants(location)
    if normalized_loc != location:
        changes.append(f"normalized: '{location}' → '{normalized_loc}'")
        location = normalized_loc
    
    # ═══ Step 4: Handle long / mixed locations ═══════════════════════════
    if location and len(location) > 60:
        extracted_loc, extracted_desc = extract_location_from_long(location)
        
        if extracted_loc:
            if extracted_desc:
                changes.append(
                    f"extracted location from long text ({len(location)} chars): "
                    f"'{location[:50]}...' → loc='{extracted_loc}' (trimmed rest → desc)"
                )
                location = truncate_after_location(extracted_loc)
                if desc_addition:
                    desc_addition = extracted_desc + " " + desc_addition
                else:
                    desc_addition = extracted_desc
            else:
                location = truncate_after_location(extracted_loc)
        else:
            # No clear location — move entire text to description
            if is_purely_descriptive(location):
                changes.append(
                    f"moved entirely to description (no location): "
                    f"'{location[:60]}...'"
                )
                if desc_addition:
                    desc_addition = location + " " + desc_addition
                else:
                    desc_addition = location
                location = None
            else:
                # Borderline case — leave as-is (conservative)
                pass
    
    # ═══ Step 5: Handle shorter locations that are clearly wrong ════════
    if location and len(location) <= 60:
        if is_purely_descriptive(location):
            changes.append(
                f"moved entirely to description: '{location}'"
            )
            if desc_addition:
                desc_addition = location + " " + desc_addition
            else:
                desc_addition = location
            location = None
    
    # ═══ Step 6: Split "Location. Description" patterns for all entries ══
    if location:
        split_loc, split_desc = split_mixed_location(location)
        if split_desc:
            orig_for_msg = location
            changes.append(
                f"split mixed location: '{orig_for_msg}' → loc='{split_loc}' + desc"
            )
            location = split_loc
            if desc_addition:
                desc_addition = split_desc + " " + desc_addition
            else:
                desc_addition = split_desc
    
    return location, desc_addition, changes


def main():
    print("=" * 60)
    print("BUTTERFLY COLLECTION — LOCATION CLEANUP")
    print("=" * 60)
    
    # ── Load data ───────────────────────────────────────────────────────
    if not COLLECTION_JSON.exists():
        print(f"❌ File not found: {COLLECTION_JSON}")
        sys.exit(1)
    
    data = load_collection(COLLECTION_JSON)
    print(f"📂 Loaded {len(data)} specimens from {COLLECTION_JSON}")
    
    # ── Stats ───────────────────────────────────────────────────────────
    orig_with_location = sum(1 for s in data if s.get("location"))
    orig_with_desc = sum(1 for s in data if s.get("description"))
    print(f"   Specimens with location: {orig_with_location}")
    print(f"   Specimens with description: {orig_with_desc}")
    
    # ── Clean each specimen ──────────────────────────────────────────────
    changes = []
    desc_changes = []
    
    for i, specimen in enumerate(data):
        orig_location = specimen.get("location")
        orig_desc = specimen.get("description")
        
        if not orig_location:
            continue
        
        new_location, desc_addition, change_list = clean_specimen_location(specimen)
        
        if change_list:
            changes.append((i, orig_location, new_location, change_list, desc_addition))
        
        # Apply changes
        specimen["location"] = new_location
        
        if desc_addition:
            if orig_desc:
                specimen["description"] = f"{orig_desc}; {desc_addition}"
            else:
                specimen["description"] = desc_addition
            desc_changes.append((i, orig_desc, specimen["description"]))
    
    # ── Count change types ──────────────────────────────────────────────
    # Classify changes
    extracted_count = 0
    nullified_count = 0
    postal_count = 0
    concat_count = 0
    normalized_count = 0
    
    for _, _, _, cl, _ in changes:
        desc = str(cl)
        if any("extracted location" in c for c in cl):
            extracted_count += 1
        elif any("moved entirely" in c for c in cl):
            nullified_count += 1
        if any("postal code" in c for c in cl):
            postal_count += 1
        if any("concatenated" in c for c in cl):
            concat_count += 1
        if any("normalized" in c for c in cl):
            normalized_count += 1
    
    # ── Save ─────────────────────────────────────────────────────────────
    save_collection(data, COLLECTION_JSON)
    
    # ── Print report ────────────────────────────────────────────────────
    new_with_location = sum(1 for s in data if s.get("location"))
    new_with_desc = sum(1 for s in data if s.get("description"))
    
    print("\n" + "=" * 60)
    print("CLEANUP REPORT")
    print("=" * 60)
    print(f"   Total specimens processed:        {len(data)}")
    print(f"   Locations cleaned:                {len(changes)}")
    print(f"     • Extracted from long text:     {extracted_count}")
    print(f"     • Moved to description (null):  {nullified_count}")
    print(f"     • Postal codes stripped:        {postal_count}")
    print(f"     • Concatenated text fixed:      {concat_count}")
    print(f"     • Normalized variants:          {normalized_count}")
    print(f"   Descriptions updated:             {len(desc_changes)}")
    print()
    print(f"   Before: {orig_with_location} with location, {orig_with_desc} with description")
    print(f"   After:  {new_with_location} with location, {new_with_desc} with description")
    
    # ── Print all changes for review ────────────────────────────────────
    print("\n" + "=" * 60)
    print("ALL CHANGES (for review)")
    print("=" * 60)
    
    if not changes:
        print("   No changes were made.")
    else:
        for idx, orig, new, change_list, desc_add in changes:
            print(f"\n  [{idx}]")
            for change in change_list:
                print(f"    • {change}")
            if orig != new:
                print(f"      OLD: {repr(orig)}")
                print(f"      NEW: {repr(new)}")
    
    if desc_changes:
        print("\n── Description changes ──")
        for idx, old_desc, new_desc in desc_changes:
            print(f"\n  [{idx}]")
            print(f"      OLD: {repr(old_desc)}")
            print(f"      NEW: {repr(new_desc[:200])}{'...' if len(new_desc) > 200 else ''}")
    
    print("\n✅ Cleanup complete! Review the changes above.")
    print(f"   To revert: git checkout -- data/collection.json")


if __name__ == "__main__":
    main()
