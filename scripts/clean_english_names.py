#!/usr/bin/env python3
"""
Clean up english_name fields in collection.json.

Extracts description/story text from english_name and moves it to notes.
Only names that contain non-name text (sentences, descriptions, collector details, etc.)
are modified. Already-clean names are left unchanged.
"""

import json
import re
from pathlib import Path

DATA_FILE = Path(__file__).parent.parent / "data" / "collection.json"


# Words that typically start a description sentence (not form names)
SENTENCE_STARTERS = {
    # Pronouns/demonstratives
    'this', 'these', 'that', 'those', 'it', 'they', 'its', 'their',
    # Prepositions starting phrases
    'in', 'on', 'at', 'by', 'with', 'from', 'to', 'for', 'of', 'as',
    # Articles
    'a', 'an', 'the',
    # Adverbs starting descriptions
    'generally', 'usually', 'often', 'sometimes', 'rarely', 'seldom',
    'very', 'fairly', 'reasonably', 'extremely', 'quite', 'mostly',
    'now', 'here', 'there', 'also', 'however', 'although', 'though',
    # Adjectives starting rarity descriptions
    'common', 'uncommon', 'rare', 'widespread', 'local', 'endemic',
    'found', 'ranging', 'occurring', 'distributed', 'present',
    'beautiful', 'stunning', 'lovely', 'superb', 'fine', 'good', 'mint',
    # Nouns starting species descriptions
    'species', 'subspecies', 'sub-species', 'butterfly', 'butterflies',
    'specimen', 'specimens',
    # Quantities
    'both', 'each', 'all', 'some', 'many', 'most', 'few', 'no',
    'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
    'pair', 'male', 'female', 'males', 'females',
    # Verbs
    'caught', 'collected', 'captured', 'taken', 'bred', 'reared',
    'set', 'hatched', 'emerged', 'pupated',
    'not', 'plus', 'includes', 'including',
    # Time references
    'first', 'second', 'late', 'early',
    'summer', 'spring', 'autumn', 'winter',
    'july', 'june', 'august', 'september', 'october',
    'ex', 'bred',
    # Geography
    'southern', 'northern', 'eastern', 'western', 'central', 'south', 'north', 'east', 'west',
    'europe', 'european', 'mediterranean', 'alpine', 'alps', 'pyrenees',
    'reasonably', 'fairly', 'mostly', 'normally', 'typically',
    'asymmetrical', 'stunning', 'unique',
}

# Words that are form/aberration names (not descriptions)
FORM_NAME_WORDS = {
    # Aberration/form names from the data
    'arcuata', 'sulphurea', 'funebris', 'crassipuncta', 'antipluripuncta',
    'prognovscii', 'caeca', 'postcaeca', 'transiens', 'helice', 'albino',
    'obsoleta', 'obsolete', 'elongata', 'discoelongata', 'basielongata',
    'antidiscoelongata',
    # Subspecies/locality names
    'caelestissima', 'mariscolore', 'eutyphron', 'conjuncta', 'insubrica',
    'hypochionus', 'meridionalis', 'santateresae', 'kricheldorfii',
    'celadussa', 'boris', 'manleyi', 'asterias', 'gorganus',
    'hippocrates', 'britannicus', 'chlorodippe', 'leucomelas', 'cataleuca',
    'rondoui', 'cypricola', 'xiphioides', 'xiphia', 'virginiensis',
    'lachesis', 'lycaon', 'pandrose', 'alberganus',
    'semeles', 'ferula', 'jasius', 'tithonus', 'malvoides',
    'athalia', 'aurina', 'diamine', 'elbana', 'coridon',
    'asturiensis', 'damon', 'ripartii', 'agenjoi', 'amandus',
    'charonia', 'paphia', 'niobe', 'c-album', 'hutchinsoni',
    'frigga', 'freyja', 'virgaureae', 'dispar', 'batavus',
    'phlaeas', 'cardui', 'urticae', 'polychloros',
    'prorsa', 'levana', 'triangularis',
    'cerisyi', 'polyxena', 'podalirius',
    # Additional form-related terms
    'pale', 'dark', 'bright', 'larger', 'smaller',
    # Month names that could be part of form designations
    'july', 'august', 'september',
}


def is_form_name_word(word: str) -> bool:
    """Check if a word looks like a form/aberration/technical name (not description)."""
    w = word.strip('.,;:()[]!?"\'')
    wl = w.lower()
    if not wl:
        return False
    if wl in FORM_NAME_WORDS:
        return True
    # Latin morphological endings (common in taxonomic form names)
    latin_ending = any(wl.endswith(e) for e in ('a', 'i', 'us', 'um', 'e', 'is', 'ax', 'ix', 'ex', 'ans', 'ens', 'ata', 'ina', 'ula', 'ica', 'iae', 'ii', 'ae'))
    if latin_ending and len(wl) >= 4 and wl[0].isalpha():
        return True
    # Common butterfly group words
    if wl in {'blue', 'brown', 'white', 'fritillary', 'copper', 'skipper',
              'swallowtail', 'admiral', 'marbled', 'ringlet', 'heath',
              'argus', 'satyr', 'nymph', 'checkerspot', 'emperor',
              'tortoiseshell', 'comma', 'clouded', 'brimstone',
              'dart', 'dwarf', 'double'}:
        return True
    return False


def is_sentence_start(text: str) -> bool:
    """
    Determine if text is the start of a description sentence.
    
    Returns True if text begins a descriptive phrase (not a form name).
    Returns False if text is a form/aberration name or butterfly designation.
    """
    if not text or not text.strip():
        return False
    
    first_word = text.split()[0].strip('.,;:()[]!?"\'')
    first_lower = first_word.lower()
    
    if not first_lower:
        return False
    
    # If it starts with a non-alpha character like "+", it's description
    if first_word and not first_word[0].isalpha():
        return True
    
    # Known form name → only description if it has many words with a verb
    if is_form_name_word(first_word):
        words = text.split()
        # If 5+ words AND contains a verb → could be both form name + description
        # e.g., "Crassipuncta This male specimen is set underside"
        if len(words) >= 4:
            lower_text = text.lower()
            for verb in (' is ', ' are ', ' was ', ' were ', ' has ', ' have '):
                if verb in lower_text:
                    return True
        return False
    
    # Known sentence starter → description
    if first_lower in SENTENCE_STARTERS:
        return True
    
    # Single capitalized word not in our lists → be cautious
    words = text.split()
    if len(words) == 1:
        # Single word is likely form name if capitalized
        # BUT known place names/locations are descriptions
        locations = {'france', 'spain', 'italy', 'greece', 'portugal', 'switzerland',
                     'england', 'scotland', 'ireland', 'wales', 'germany', 'austria',
                     'europe', 'alps', 'pyrenees', 'pale', 'dark', 'bright'}
        if first_lower in locations:
            return True
        # Check if it looks like a description word (English word, not Latin name)
        if len(first_word) >= 4 and first_lower not in FORM_NAME_WORDS:
            # If it's an English word (common suffixes) → likely description
            eng_suffixes = ('ing', 'tion', 'sion', 'ment', 'ness', 'ity', 'ful', 'ous', 'ive')
            if any(first_lower.endswith(s) for s in eng_suffixes):
                return True
        return False
    
    # Multiple words - check for verb patterns that indicate a sentence
    if len(words) >= 3:
        second_third = ' '.join(words[1:3]).lower()
        if any(v in second_third for v in (' is', ' are', ' was', ' were', ' has', ' have', ' been')):
            return True
    
    # Starts with lowercase → likely form continuation
    if first_word[0].islower():
        return False
    
    # Default: if it's a capitalized single word followed by more text, 
    # and the second word is a sentence starter word → description
    if len(words) >= 2 and words[1].lower() in SENTENCE_STARTERS:
        return True
    
    return False


def split_at_period(text: str) -> tuple:
    """
    Split text at '. ' where the text after the period is a description sentence.
    Form/aberration names after periods are kept as part of the name.
    
    Returns (name_part, description_part).
    """
    if '. ' not in text:
        return text, ''
    
    parts = re.split(r'(\.\s+)', text)
    name_bits = []
    desc_bits = []
    in_desc = False
    
    i = 0
    while i < len(parts):
        part = parts[i]
        if re.match(r'\.\s+$', part) and i + 1 < len(parts):
            next_text = parts[i + 1].strip()
            
            if is_sentence_start(next_text):
                in_desc = True
                desc_bits.append(part)
                desc_bits.append(parts[i + 1])
            else:
                # Form name - keep it, but clean up ". " to " "
                if not in_desc:
                    name_bits.append(' ')
                    name_bits.append(parts[i + 1])
                else:
                    desc_bits.append(part)
                    desc_bits.append(parts[i + 1])
            i += 2
        else:
            if not in_desc:
                name_bits.append(part)
            else:
                desc_bits.append(part)
            i += 1
    
    result_name = ''.join(name_bits).strip()
    result_desc = ''.join(desc_bits).strip()
    
    # Clean up: remove ". " artifacts from name (replace with space)
    result_name = re.sub(r'\s*\.\s+', ' ', result_name).strip()
    result_name = re.sub(r'\s+', ' ', result_name).strip()
    
    return result_name, result_desc


def find_first_description_trigger(text: str) -> tuple:
    """
    Find the first position in text where a description starts.
    Returns (split_index, trigger_type) or (-1, '') if no trigger found.
    The split_index is the position where description starts.
    """
    if not text:
        return -1, ''
    
    # Strategy: try all triggers and find the one that appears earliest
    candidates = []
    
    # Trigger type 1: " species is/are/has", " butterfly is/are", " specimen is/was", etc.
    break_phrases = [
        r'\s+species\s+(?:is|are|has|have)\b',
        r'\s+butterfly\s+(?:is|are)\b',
        r'\s+butterflies\s+are\b',
        r'\s+specimen\s+(?:is|was)\b',
        r'\s+specimens\s+(?:are|were)\b',
    ]
    for pat in break_phrases:
        m = re.search(pat, text, re.IGNORECASE)
        if m:
            candidates.append((m.start(), 'phrase'))
    
    # Trigger type 2: "Found in/at/on/only", "Endemic to", etc.
    desc_starters = [
        r'\s+Found\s+(?:in|at|on|only)\b',
        r'\s+Endemic\s+to\b',
        r'\s+Generally\s+common\b',
        r'\s+Common\s+(?:in|throughout)\b',
        r'\s+Widespread\s+in\b',
        r'\s+Uncommon\s+in\b',
        r'\s+Ranging\b',
        r'\s+Species\s+widespread\b',
        r'\s+Reasonably\s+common\b',
        r'\s+Fairly\s+common\b',
        r'\s+Very\s+(?:local|rare|common)\b',
        r'\s+Not\s+a\s+rare\b',
        r'\s+Extremely\s+local\b',
        r'\s+Collected\s+[A-Z][a-z]+\s+\d{5}\b',
        r'\s+Collected\s+by\b',
    ]
    for pat in desc_starters:
        m = re.search(pat, text, re.IGNORECASE)
        if m and m.start() > 0:
            candidates.append((m.start(), 'desc_start'))
    
    # Trigger type 3: " rare in Europe", " common in Europe" (no period separation)
    desc_phrases_continuous = [
        r'\b(?:rare|common|uncommon|local|endemic|widespread)\s+in\s+(?:Europe|the|southern|northern|eastern|western|central|most)\b',
        r'\b(?:rare|local|endemic)\s+(?:in|to)\s+',
    ]
    for pat in desc_phrases_continuous:
        m = re.search(pat, text, re.IGNORECASE)
        if m and m.start() > 3:  # at least some name before it
            candidates.append((m.start(), 'desc_continuous'))
    
    # Trigger type 4: "This species/butterfly/specimen" or "These specimens"
    this_patterns = [
        r'\bThis\s+(?:species|butterfly|specimen|form|female|male|one)\b',
        r'\bThese\s+(?:specimens?|are)\b',
        r'\bThis\s+(?:is|one|female|male)\s+',
        r'\bCommon\s+species\b',
    ]
    for pat in this_patterns:
        m = re.search(pat, text)
        if m and m.start() > 0:
            candidates.append((m.start(), 'this_that'))
    
    # Trigger type 5: "This superb/beautiful/lovely/stunning" 
    m = re.search(r'\bThis\s+(?:superb|beautiful|lovely|stunning|fine)\b', text)
    if m and m.start() > 0:
        candidates.append((m.start(), 'this_adj'))
    
    # Trigger type 6: "pair and a male", "two males", etc  
    m = re.search(r'\b(?:pair\s+and\s+a|one\s+pair|two\s+males?|three\s+males?)\s+(?:male|female|fairly|of|from|in|common|ex)\b', text, re.IGNORECASE)
    if m and m.start() > 0:
        candidates.append((m.start(), 'quantity'))
    
    # Trigger type 7: comma + "caught/collected/taken/bred/captured/rare"
    for word in ['caught', 'collected', 'taken', 'bred', 'captured', 'rare', 'the', 'a', 'an', 'this', 'these']:
        m = re.search(r',\s+' + word + r'\b', text, re.IGNORECASE)
        if m and m.start() > 5:
            candidates.append((m.start(), 'comma_' + word))
            break  # only the first matching comma
    
    # Trigger type 8: " is an example" 
    m = re.search(r',\s+is\s+an\s+(?:example|aberr)', text, re.IGNORECASE)
    if m and m.start() > 0:
        candidates.append((m.start(), 'is_example'))
    
    # Trigger type 9: colon + known collector  
    m = re.search(r'\s*:\s*(?:J\.\s*W\.\s*Tutt|L\.\s*D\.\s*Young|C\.\s*Greenwood|O\.\s*A\.\s*Alexander)', text)
    if m and m.start() > 0:
        candidates.append((m.start(), 'collector_colon'))
    
    # Trigger type 10: " [mf] [Name] at [location]" - collector w/sex marker
    m = re.search(r'\s+[mf]\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\s+at\s+', text)
    if m and m.start() > 0:
        candidates.append((m.start(), 'mf_at'))
    
    # Trigger type 11: " [mf] This" 
    m = re.search(r'\s+[mf]\s+This\s+(?:superb|lovely|beautiful|stunning|fine|blue|brown|white|female|male|specimen)', text, re.IGNORECASE)
    if m and m.start() > 0:
        candidates.append((m.start(), 'mf_this'))
    
    # Trigger type 12: Numbers like "2 1 female" (quantity)
    m = re.search(r'\s+\d+\s+\d+\s+(?:female|male|late|spring|summer|autumn|winter)\b', text, re.IGNORECASE)
    if m and m.start() > 0:
        candidates.append((m.start(), 'qty_nums'))
    
    # Trigger type 12b: "stunning female/example" description  
    for adj in ['stunning', 'beautiful', 'lovely', 'superb']:
        for noun in ['female', 'male', 'example', 'specimen', 'pair']:
            pat = r'\s+' + adj + r'\s+' + noun + r'\b'
            m = re.search(pat, text, re.IGNORECASE)
            if m and m.start() > 0:
                candidates.append((m.start(), 'adj_noun'))
                break
        if any(c[0] == m.start() for c in candidates if c[1] == 'adj_noun'):
            break
    
    # Trigger type 13: "Very small" / "Very rare" standalone
    m = re.search(r'\s+Very\s+(?:small|rare|common|local|uncommon|difficult)\b', text, re.IGNORECASE)
    if m and m.start() > 0:
        candidates.append((m.start(), 'very_adj'))
    
    # Trigger type 14: "Asymmetrical with" / description-like word combinations
    m = re.search(r'\s+Asymmetrical\s+with\b', text, re.IGNORECASE)
    if m and m.start() > 0:
        candidates.append((m.start(), 'asymmetrical'))
    
    # Trigger type 15: dash + collector initials
    m = re.search(r'\s*[\u2013-]\s*[A-Z]\.\s*[A-Z]\.?\s+[A-Z][a-z]+', text)
    if m and m.start() > 0:
        # Only if there's a clear name before it
        before = text[:m.start()].strip()
        if before and len(before) >= 6:
            candidates.append((m.start(), 'dash_collector'))
    
    # Trigger type 16: "dash + L. W. Newman" etc
    m = re.search(r'\s*[\u2013-]\s*[A-Z]\.\s+[A-Z][a-z]+\s+A\s+', text)
    if m and m.start() > 0:
        candidates.append((m.start(), 'dash_collector2'))
    
    # Trigger type 16b: "Mostly/Mainly Greek Islands" style description
    m = re.search(r'\s+(?:mostly|mainly|primarily)\s+(?:Greek|in|from|found)\b', text, re.IGNORECASE)
    if m and m.start() > 0:
        candidates.append((m.start(), 'mostly_phrase'))
    
    # Trigger type 16c: "Pieris" at end after description (leftover Latin name start)
    # "Canary Large White stunning female... Pieris" -> "Canary Large White"
    m = re.search(r'\s+[A-Z][a-z]+\s+stunning\s+female', text)
    if m and m.start() > 0:
        candidates.append((m.start(), 'name_stunning'))
    # Trigger type 16d: date-like patterns followed by description
    # "Northern Brown Argus 19/7 but no other data but this species only comes"
    m = re.search(r'\s+\d{1,2}/\d{1,2}\s+but\s+no\s+other\s+data\b', text)
    if m and m.start() > 0:
        candidates.append((m.start(), 'date_desc'))
    
    # Trigger type 17: "+f" or "+m" description start  
    m = re.search(r'\s*\.\s*\+[mf]\s+', text)
    if m:
        candidates.append((m.start(), 'plus_sex'))
    
    # Trigger type 18: "Numbers X Latin name" - quantities with Latin
    m = re.search(r'\s+\d+\s*[Xx]\s+[A-Z][a-z]+\s+[a-z]+\s+', text)
    if m and m.start() > 0:
        candidates.append((m.start(), 'qty_x_latin'))
    
    if not candidates:
        return -1, ''
    
    # Return the earliest trigger
    best = min(candidates, key=lambda c: c[0])
    return best


def clean_name(name: str) -> tuple:
    """
    Given an english_name, split it into (clean_name, extracted_text).
    Returns (name, '') if already clean.
    """
    if not name:
        return name, ''
    
    original = name
    current = name
    extracted = []
    
    # ===== STEP 0: Pre-clean ALL-CAPS names =====
    # "PROVENCAL FRITILLARY" -> proper case
    words = current.split()
    all_upper = all(w.isupper() and len(w) > 1 for w in words if w.isalpha())
    if all_upper and len(words) >= 2:
        current = current.title()
        # Fix known patterns
        replacements = {
            'S ': 's ', 'S.': 's.', 'Mc': 'Mc',
            'Fritillary': 'Fritillary', 'Fritillarys': 'Fritillaries',
        }
    
    # ===== STEP 1: Remove trailing description fragments =====
    trailing = [
        (r'[,;.]?\s*These are\s*$', ''),
        (r'[,;.]?\s*These\s*$', ''),
        (r'[,;.]?\s*This is\s*$', ''),
        (r'[,;.]?\s*This one is\s*$', ''),
        (r'[,;.]?\s*This\s*$', ''),
        (r'[,;.]?\s*where this\s*$', ''),
        (r'[,;.]?\s*,?\s*though\s*$', ''),
    ]
    for pat, _ in trailing:
        m = re.search(pat, current)
        if m:
            trailing_text = m.group().strip().lstrip(',;.').strip()
            if trailing_text:
                extracted.append(trailing_text)
            current = re.sub(pat, '', current).rstrip(' ,.;:-')
            break
    
    # ===== STEP 2: Find the first description trigger =====
    split_idx, trigger_type = find_first_description_trigger(current)
    
    if split_idx > 0:
        # Check if the trigger is part of a known form name pattern
        # e.g., "species is" might actually be "sub-species is" where "sub-species" is a form name
        before_trigger = current[:split_idx].strip()
        after_trigger = current[split_idx:].strip()
        
        # Only split if before looks like a real name
        if before_trigger and after_trigger and len(before_trigger) >= 3:
            extracted.append(after_trigger)
            current = before_trigger
    
    # ===== STEP 3: Handle period-space-sentence splits (only if no trigger found above) =====
    name_part, desc_part = split_at_period(current)
    
    # Always apply the name clean-up from split_at_period, even if no desc
    if name_part != current:
        current = name_part
    
    if desc_part:
        # Check if desc_part starts with a form name followed by more description
        # e.g., "Crassipuncta This male specimen is set underside"
        # We want "Crassipuncta" in name, "This male specimen..." as description
        desc_words = desc_part.split()
        if len(desc_words) >= 3 and is_form_name_word(desc_words[0]):
            # Check if the second word starts a sentence
            second_word = desc_words[1].strip('.,;:()[]!?"\'')
            if second_word.lower() in SENTENCE_STARTERS or second_word[0].isupper():
                # Split: keep form name in current, rest goes to extracted
                form_name = desc_words[0]
                rest_desc = ' '.join(desc_words[1:])
                current = (current + ' ' + form_name).strip()
                if rest_desc:
                    extracted.append(rest_desc)
                # Skip the normal extraction below
                desc_part = ''
        
        if desc_part:
            extracted.append(desc_part)
            current = name_part
    
    # ===== STEP 4: Handle " [sex] Isle of Sark", " [f] Jon Young" type collector refs =====
    # These are patterns where after a name, there's "f/m [location/name]" followed by description
    # The "f" or "m" is a sex marker and not part of the core name
    
    # Pattern: "[name] f/m [Location]" where Location is a place (not a species name)
    irish_place = r'\s+[mf]\s+(?:Isle|Lake|Mount|Mt\.|St\.|Forest|River|Valley|Cape|Point|Port|Fort|Co\.|County|North|South|East|West)\b'
    m = re.search(irish_place, current, re.IGNORECASE)
    if m and m.start() > 0:
        before = current[:m.start()].strip()
        after = current[m.start():].strip()
        if before and after:
            extracted.append(after)
            current = before
    
    # Pattern: "[name] f/m This [adj]" - description starts after sex marker
    m = re.search(r'\s+[mf]\s+This\s+', current)
    if m and m.start() > 0:
        before = current[:m.start()].strip()
        after = current[m.start():].strip()
        if before and after:
            extracted.append(after)
            current = before
    
    # ===== STEP 5: Clean up remaining artifacts =====
    
    # Remove trailing sex markers that are artifacts (e.g., " M" or " F" at end)
    current = re.sub(r'\s*\.\s*[MF]\s*$', '', current).strip()
    # Also handle ".M" without space
    current = re.sub(r'\s*\.\s*[MF]\s*', ' ', current).strip()
    # Handle trailing "f" or "m" sex marker (single letter at end)
    current = re.sub(r'\s+[fm]\s*$', '', current).strip()
    # Handle trailing "f?" 
    current = re.sub(r'\s+f\?\s*$', '', current).strip()
    
    # Remove "Butterfly" when at end of name (extraneous padding word)  
    current = re.sub(r'\s*Butterfly\s*$', '', current).strip()
    # Remove "Butterfly" when followed by comma + description  
    current = re.sub(r'\bButterfly\b,\s+(?:this|the|a)\s+', ' ', current).strip()
    
    # Remove standalone sex markers " m " or " f " that are artifacts 
    # (sex info is already in the sex field)
    # But be careful: "f" or "m" might be part of form names like "f obscura"
    # Only remove when surrounded by spaces and NOT followed by a known form/aberration word
    # Pattern: " m " followed by capitalized word that looks like a form name
    current = re.sub(r'\s+[mf]\s+(?=[A-Z][a-z]{3,})', ' ', current).strip()
    # Also handle " m at end" pattern
    current = re.sub(r'\s+[mf]\s*$', '', current).strip()
    # Handle "m ." pattern  
    current = re.sub(r'\s+[mf]\s*\.\s+', ' ', current).strip()
    
    # Remove quantity patterns: "1X", "3 X", "2 X" etc
    current = re.sub(r'\s+\d+\s*[Xx]\s+', ' ', current).strip()
    
    # Remove "males", "females" leftover after quantity removal
    # (Only at end, and only single words)
    current = re.sub(r'\s+(?:males?|females?|specimens?)\s*$', '', current, flags=re.IGNORECASE).strip()
    
    # Fix double spaces
    current = re.sub(r'\s+', ' ', current).strip()
    
    # Remove trailing punctuation: periods, commas, semicolons, colons, dashes
    current = current.rstrip(' .,;:-')
    # Remove leading punctuation
    current = current.lstrip(' .,;:-')
    
    # ===== STEP 6: Final case fix =====
    # If name is still all-uppercase (or mostly), title-case it
    if current.isupper() and len(current) > 5:
        current = current.title()
    
    # ===== BUILD RESULT =====
    if not current or len(current) < 2:
        return original, ''
    
    if not extracted:
        return original, ''
    
    # Deduplicate and clean extracted text
    cleaned_extracted = []
    seen = set()
    for part in reversed(extracted):
        p = part.strip().lstrip('. ').strip()
        if p and p not in seen:
            is_subset = any(p in e and len(p) < len(e) for e in extracted if e != part)
            if not is_subset:
                cleaned_extracted.insert(0, p)
                seen.add(p)
    
    if not cleaned_extracted:
        return original, ''
    
    extracted_text = ' '.join(cleaned_extracted).strip(' ,.;')
    
    if extracted_text:
        return current, extracted_text
    
    return original, ''


def main():
    print(f"Reading {DATA_FILE}...")
    with open(DATA_FILE, 'r', encoding='utf-8') as f:
        data = json.load(f)
    
    total = len(data)
    changes = []
    
    for idx, item in enumerate(data):
        orig = item.get('english_name', '')
        if not orig:
            continue
        
        clean, notes_text = clean_name(orig)
        
        if clean != orig and notes_text:
            item['english_name'] = clean
            
            existing_notes = item.get('notes')
            if existing_notes:
                # Avoid duplication if notes_text is already in existing notes
                if notes_text not in existing_notes:
                    sep = '. ' if existing_notes.rstrip() else ''
                    item['notes'] = existing_notes.rstrip('. ').strip() + '. ' + notes_text
            else:
                item['notes'] = notes_text
            
            changes.append((idx, orig, clean, notes_text))
    
    # Write
    print(f"\nWriting {len(data)} items back...")
    with open(DATA_FILE, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    
    # Report
    print(f"\n{'='*70}")
    print("CLEANUP REPORT")
    print(f"{'='*70}")
    print(f"Total items:               {total}")
    print(f"Items unchanged:           {total - len(changes)}")
    print(f"Items cleaned:             {len(changes)}")
    
    if changes:
        print(f"\n{'='*70}")
        print("CHANGES:")
        for idx, orig, clean, notes_text in changes:
            orig_short = orig[:100] + ('...' if len(orig) > 100 else '')
            notes_short = notes_text[:70] + ('...' if len(notes_text) > 70 else '')
            print(f"\n  [{idx}]")
            print(f"  OLD: {orig_short}")
            print(f"  NEW: {clean}")
            print(f"  -> notes: {notes_short}")
    
    print(f"\nDone. {len(changes)} items cleaned.")


if __name__ == '__main__':
    main()
