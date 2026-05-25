#!/usr/bin/env python3
"""
Phase 2: Enrich species-raw.json with tags for filtering.
Outputs data/species.json
"""

import json
from pathlib import Path

DATA_DIR = Path("data")

FAMILY_COLORS = {
    "Lycaenidae":   ["blue", "brown", "copper"],
    "Pieridae":     ["white", "yellow", "orange"],
    "Nymphalidae":  ["orange", "brown", "black"],
    "Papilionidae": ["yellow", "black", "blue"],
    "Hesperiidae":  ["brown", "orange"],
    "Riodinidae":   ["brown", "orange"],
    "Zygaenidae":   ["red", "black"],
}

SPECIES_COLORS = {
    "Vanessa atalanta":        ["red", "black", "white"],
    "Vanessa cardui":          ["orange", "black", "white"],
    "Inachis io":              ["red", "blue", "black"],
    "Aglais io":               ["red", "blue", "black"],
    "Aglais urticae":          ["orange", "black", "yellow"],
    "Gonepteryx rhamni":       ["yellow", "green"],
    "Gonepteryx cleopatra":    ["yellow", "orange"],
    "Pieris brassicae":        ["white", "black"],
    "Pieris rapae":            ["white", "black"],
    "Pieris napi":             ["white", "black"],
    "Polyommatus icarus":      ["blue", "brown"],
    "Lysandra bellargus":      ["blue"],
    "Lysandra coridon":        ["blue", "brown"],
    "Argynnis paphia":         ["orange", "black"],
    "Argynnis aglaja":         ["orange", "black"],
    "Papilio machaon":         ["yellow", "black", "blue"],
    "Iphiclides podalirius":   ["white", "black", "blue"],
    "Anthocharis cardamines":  ["white", "orange"],
    "Lycaena phlaeas":         ["orange", "copper", "brown"],
    "Lycaena dispar":          ["orange", "copper"],
    "Melanargia galathea":     ["black", "white"],
    "Apatura iris":            ["purple", "black", "white"],
    "Apatura ilia":            ["orange", "black", "white"],
    "Celastrina argiolus":     ["blue", "white"],
    "Colias croceus":          ["orange", "yellow"],
    "Colias hyale":            ["yellow", "white"],
    "Limenitis camilla":       ["black", "white"],
    "Limenitis reducta":       ["black", "white"],
    "Nymphalis antiopa":       ["brown", "yellow", "black"],
    "Nymphalis polychloros":   ["orange", "black"],
    "Araschnia levana":        ["orange", "black", "white"],
    "Boloria selene":          ["orange", "black"],
    "Euphydryas aurinia":      ["orange", "brown", "black"],
    "Melitaea cinxia":         ["orange", "black"],
    "Melitaea didyma":         ["orange", "black"],
    "Pararge aegeria":         ["brown", "orange", "white"],
    "Maniola jurtina":         ["brown", "orange"],
    "Pyronia tithonus":        ["orange", "brown"],
    "Aphantopus hyperantus":   ["brown"],
    "Coenonympha pamphilus":   ["orange", "brown"],
    "Coenonympha tullia":      ["orange", "brown"],
    "Hipparchia semele":       ["brown", "orange"],
    "Erebia aethiops":         ["brown", "orange"],
    "Satyrium w-album":        ["brown"],
    "Callophrys rubi":         ["green", "brown"],
    "Thecla betulae":          ["brown", "orange"],
    "Plebejus argus":          ["blue", "brown"],
    "Aricia agestis":          ["brown", "orange"],
    "Cupido minimus":          ["blue", "brown"],
    "Leptidea sinapis":        ["white"],
    "Zerynthia polyxena":      ["yellow", "black", "red"],
    "Parnassius apollo":       ["white", "red", "black"],
    "Parnassius mnemosyne":    ["white", "black"],
    "Hamearis lucina":         ["brown", "orange"],
}

SUBFAMILY_PATTERNS = {
    "Satyrinae":    ["eyespots"],
    "Melitaeinae":  ["spotted"],
    "Argynninae":   ["spotted"],
    "Polyommatinae":["spotted"],
    "Pierinae":     ["plain"],
    "Coliadinae":   ["plain"],
    "Papilioninae": ["tailed"],
    "Parnassiinae": ["spotted"],
    "Hesperiinae":  ["plain"],
    "Pyrginae":     ["checkered"],
    "Apaturinae":   ["iridescent"],
    "Limenitidinae":["striped"],
    "Nymphalinae":  ["spotted"],
    "Lycaeninae":   ["iridescent"],
    "Theclinae":    ["iridescent"],
}

FAMILY_PATTERNS = {
    "Papilionidae": ["tailed"],
    "Hesperiidae":  ["plain"],
    "Pieridae":     ["plain"],
}

SPECIES_PATTERNS = {
    "Melanargia galathea":  ["checkered"],
    "Apatura iris":         ["iridescent"],
    "Apatura ilia":         ["iridescent"],
    "Callophrys rubi":      ["plain"],
    "Parnassius apollo":    ["spotted"],
    "Parnassius mnemosyne": ["spotted"],
    "Iphiclides podalirius":["striped", "tailed"],
    "Araschnia levana":     ["checkered"],
}

SUBFAMILY_SIZE = {
    "Satyrinae":     "medium",
    "Melitaeinae":   "small",
    "Argynninae":    "large",
    "Polyommatinae": "small",
    "Pierinae":      "medium",
    "Coliadinae":    "medium",
    "Papilioninae":  "very-large",
    "Parnassiinae":  "large",
    "Hesperiinae":   "small",
    "Pyrginae":      "small",
    "Apaturinae":    "large",
    "Limenitidinae": "medium",
    "Nymphalinae":   "medium",
    "Lycaeninae":    "small",
    "Theclinae":     "small",
}

FAMILY_SIZE = {
    "Papilionidae": "very-large",
    "Hesperiidae":  "small",
    "Pieridae":     "medium",
    "Lycaenidae":   "small",
    "Nymphalidae":  "medium",
    "Riodinidae":   "small",
}

SPECIES_SIZE = {
    "Papilio machaon":       "very-large",
    "Iphiclides podalirius": "very-large",
    "Parnassius apollo":     "large",
    "Apatura iris":          "large",
    "Argynnis paphia":       "large",
    "Nymphalis antiopa":     "large",
    "Inachis io":            "medium",
    "Aglais io":             "medium",
    "Vanessa atalanta":      "medium",
    "Gonepteryx rhamni":     "medium",
    "Cupido minimus":        "tiny",
    "Leptidea sinapis":      "small",
    "Callophrys rubi":       "small",
}

SIZE_LABELS = {
    "tiny":      "< 25mm",
    "small":     "25–35mm",
    "medium":    "35–55mm",
    "large":     "55–75mm",
    "very-large":"75mm+",
}

FAMILY_FLIGHT = {
    "Papilionidae": ["spring", "summer"],
    "Pieridae":     ["spring", "summer", "autumn"],
    "Lycaenidae":   ["spring", "summer"],
    "Nymphalidae":  ["spring", "summer", "autumn"],
    "Hesperiidae":  ["spring", "summer"],
    "Riodinidae":   ["spring", "summer"],
}

SPECIES_FLIGHT = {
    "Gonepteryx rhamni":    ["spring", "summer", "autumn"],
    "Gonepteryx cleopatra": ["spring", "summer", "autumn"],
    "Nymphalis antiopa":    ["summer", "autumn", "spring"],
    "Vanessa atalanta":     ["spring", "summer", "autumn"],
    "Vanessa cardui":       ["spring", "summer", "autumn"],
    "Inachis io":           ["spring", "summer", "autumn"],
    "Aglais io":            ["spring", "summer", "autumn"],
    "Aglais urticae":       ["spring", "summer", "autumn"],
    "Anthocharis cardamines":["spring"],
    "Leptidea sinapis":     ["spring", "summer"],
    "Erebia aethiops":      ["summer"],
    "Parnassius apollo":    ["summer"],
    "Aricia agestis":       ["spring", "summer"],
}

FAMILY_HABITAT = {
    "Papilionidae": ["meadow", "grassland"],
    "Pieridae":     ["meadow", "grassland", "garden"],
    "Lycaenidae":   ["grassland", "meadow"],
    "Nymphalidae":  ["woodland", "meadow", "garden"],
    "Hesperiidae":  ["grassland", "meadow"],
    "Riodinidae":   ["woodland"],
}

SPECIES_HABITAT = {
    "Pararge aegeria":       ["woodland", "garden"],
    "Apatura iris":          ["woodland"],
    "Apatura ilia":          ["woodland"],
    "Limenitis camilla":     ["woodland"],
    "Limenitis reducta":     ["woodland"],
    "Callophrys rubi":       ["woodland", "grassland"],
    "Gonepteryx rhamni":     ["woodland", "garden", "meadow"],
    "Coenonympha tullia":    ["wetland", "grassland"],
    "Lycaena dispar":        ["wetland"],
    "Parnassius apollo":     ["mountain"],
    "Parnassius mnemosyne":  ["mountain", "woodland"],
    "Erebia aethiops":       ["mountain", "grassland"],
    "Hipparchia semele":     ["coast", "grassland"],
    "Polyommatus icarus":    ["meadow", "grassland"],
    "Pieris brassicae":      ["garden", "meadow"],
    "Pieris rapae":          ["garden", "meadow"],
    "Vanessa cardui":        ["garden", "meadow"],
    "Inachis io":            ["garden", "woodland", "meadow"],
    "Aglais io":             ["garden", "woodland", "meadow"],
}

SPECIES_REGION = {
    "Parnassius apollo":     ["central", "southern"],
    "Parnassius mnemosyne":  ["central", "northern"],
    "Zerynthia polyxena":    ["southern", "eastern"],
    "Lycaena dispar":        ["western", "central", "eastern"],
    "Apatura iris":          ["western", "central"],
    "Nymphalis antiopa":     ["northern", "central", "eastern"],
    "Erebia aethiops":       ["central", "northern"],
    "Melanargia galathea":   ["western", "central", "southern"],
    "Hipparchia semele":     ["western", "central", "southern"],
    "Limenitis camilla":     ["western", "central"],
    "Colias croceus":        ["southern", "western"],
    "Gonepteryx cleopatra":  ["southern"],
    "Iphiclides podalirius": ["southern", "central"],
    "Argynnis paphia":       ["western", "central", "southern"],
}

DEFAULT_REGION = ["western", "central", "southern"]


def get_colors(record):
    sci = record["scientific_name"]
    if sci in SPECIES_COLORS:
        return SPECIES_COLORS[sci]
    family = record.get("family", "")
    return FAMILY_COLORS.get(family, ["brown"])


def get_patterns(record):
    sci = record["scientific_name"]
    if sci in SPECIES_PATTERNS:
        return SPECIES_PATTERNS[sci]
    subfamily = record.get("subfamily", "")
    if subfamily in SUBFAMILY_PATTERNS:
        return SUBFAMILY_PATTERNS[subfamily]
    family = record.get("family", "")
    return FAMILY_PATTERNS.get(family, ["plain"])


def get_size(record):
    sci = record["scientific_name"]
    if sci in SPECIES_SIZE:
        return SPECIES_SIZE[sci]
    subfamily = record.get("subfamily", "")
    if subfamily in SUBFAMILY_SIZE:
        return SUBFAMILY_SIZE[subfamily]
    family = record.get("family", "")
    return FAMILY_SIZE.get(family, "medium")


def get_flight(record):
    sci = record["scientific_name"]
    if sci in SPECIES_FLIGHT:
        return SPECIES_FLIGHT[sci]
    family = record.get("family", "")
    return FAMILY_FLIGHT.get(family, ["spring", "summer"])


def get_habitat(record):
    sci = record["scientific_name"]
    if sci in SPECIES_HABITAT:
        return SPECIES_HABITAT[sci]
    family = record.get("family", "")
    return FAMILY_HABITAT.get(family, ["meadow", "grassland"])


def get_region(record):
    sci = record["scientific_name"]
    return SPECIES_REGION.get(sci, DEFAULT_REGION)


def main():
    raw_path = DATA_DIR / "species-raw.json"
    if not raw_path.exists():
        print(f"Error: {raw_path} not found. Run fetch-data.py first.")
        return

    with open(raw_path) as f:
        records = json.load(f)

    print(f"Enriching {len(records)} species...")

    for record in records:
        size = get_size(record)
        record["tags"] = {
            "colors":        get_colors(record),
            "size":          size,
            "size_label":    SIZE_LABELS.get(size, ""),
            "patterns":      get_patterns(record),
            "flight_period": get_flight(record),
            "habitat":       get_habitat(record),
            "region":        get_region(record),
        }

    out_path = DATA_DIR / "species.json"
    with open(out_path, "w") as f:
        json.dump(records, f, indent=2)

    print(f"Done. Saved {out_path}")

    # Print a sample
    sample = records[0]
    print(f"\nSample record: {sample['common_name']}")
    print(f"  Tags: {json.dumps(sample['tags'], indent=4)}")


if __name__ == "__main__":
    import os
    os.chdir(Path(__file__).parent)
    main()
