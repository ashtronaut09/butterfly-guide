#!/usr/bin/env python3
"""
Normalize location data in butterfly collection JSON.
- Fixes typos in location field
- Adds location_country field for filtering
- Maintains original location for detail view
"""

import json
import re
from pathlib import Path
from collections import Counter

# Define typo fixes (applied to location field itself)
# Use word boundaries to avoid partial replacements
TYPO_FIXES = {
    r"\bMoreco\b": "Morocco",
    r"\bCzeck Republic\b": "Czech Republic",  # Already correct, but handle variants
    r"\bCzeck\b": "Czech Republic",
    r"\bSwitzealand\b": "Switzerland",
    r"\bSwitzeland\b": "Switzerland",
    r"\bItally\b": "Italy",
    r"\bJordon\b": "Jordan",
    r"\bSlovienia\b": "Slovenia",
    r"\bSlovacia\b": "Slovakia",
    r"\bSlovakia\b": "Slovakia",  # No fix needed
    r"\bAutstria\b": "Austria",
    r"\bAutria\b": "Austria",
    r"\bIrelanc\b": "Ireland",
    r"\bCoratia\b": "Croatia",
    r"\bUkrain\b": "Ukraine",
    r"\bYougoslavia\b": "Yugoslavia",
    r"\bYujoslavia\b": "Yugoslavia",
    r"\bKirgizstan\b": "Kyrgyzstan",
    r"\bMorroco\b": "Morocco",
    r"\bMorecco\b": "Morocco",
    r"\bMorrocco\b": "Morocco",
    r"\bFance\b": "France",
}

# Define country mappings (location patterns -> country)
COUNTRY_MAPPINGS = {
    # France variants
    "France": "France",
    "SE France": "France",
    "SW France": "France",
    "southern France": "France",
    "South of France": "France",
    "French Alps": "France",
    "French Alp": "France",
    "Corsica": "France",
    "Chancelade": "France",
    "Les Andrivaux": "France",
    "south east French Alps": "France",
    "French Pyrenees": "France",
    "France & Morocco": "France",
    "Spanish Pyreneese": "Spain",
    "Spanish Pyrenease": "Spain",
    
    # Spain variants
    "Spain": "Spain",
    "Granada Spain": "Spain",
    "Spain (Andalucia)": "Spain",
    "Central & Eastern Spain": "Spain",
    "northern Spain": "Spain",
    "Sierra de la Sagra Spain": "Spain",
    "Aragon Spain": "Spain",
    "Spanish stock": "Spain",
    "Andalucia": "Spain",
    "Majorca": "Spain",
    
    # UK variants
    "UK": "UK",
    "Hampshire, UK": "UK",
    "Barnsley, UK": "UK",
    "Northamptonshire, UK": "UK",
    "Swanage UK": "UK",
    "Dorset": "UK",
    "Berkshire": "UK",
    "Cumbria": "UK",
    "Scotland": "UK",
    "Kent": "UK",
    "Surrey": "UK",
    "Sussex": "UK",
    "Norfolk": "UK",
    "Oxfordshire": "UK",
    "Cornwall": "UK",
    "England": "UK",
    "Essex": "UK",
    "Hants": "UK",
    "Hants England": "UK",
    "Lewis England": "UK",
    "Lewis": "UK",
    "Wales": "UK",
    "South Wales": "UK",
    "Shropshire": "UK",
    "Isle of White": "UK",
    "Isle of Man": "UK",
    "Dorking, Surrey": "UK",
    "Eartham, Sussex": "UK",
    "White Down, Surrey": "UK",
    "Berkshire and Heyshot": "UK",
    "Norfolk Broads": "UK",
    "New Forrest": "UK",
    "Wittlesea Mere": "UK",
    "Witherslack Scotland": "UK",
    "Kincardineshire Scotland": "UK",
    "Gloucester": "UK",
    "Royston": "UK",
    "Worth Matravers": "UK",
    "Cumberland": "UK",
    "Prees heath Shropshire with data": "UK",
    "Essex and Kent 1919-60": "UK",
    "Hereford and Kent": "UK",
    "Hants 15/10/90": "UK",
    
    # Greece variants
    "Greece": "Greece",
    "Northern Greece": "Greece",
    "NE Greece": "Greece",
    "Crete": "Greece",
    "Lasithi Crete": "Greece",
    "Crete (endemit)": "Greece",
    "Crete (Endemit)": "Greece",
    "Samos": "Greece",
    
    # Poland variants
    "Poland": "Poland",
    "Southern Poland": "Poland",
    
    # Italy variants
    "Italy": "Italy",
    "southern Italy": "Italy",
    "Northern Italy": "Italy",
    "Italian Alps": "Italy",
    "Sardinia": "Italy",
    "Sicily": "Italy",
    "Elba": "Italy",
    "Trieste": "Italy",
    "Umbria Italy": "Italy",
    "N. Italy": "Italy",
    
    # Czech Republic variants
    "Czech Republic": "Czech Republic",
    "Bohemia": "Czech Republic",
    "Bohemia & Slovakia": "Czech Republic",
    "Czech Republic & Slovakia": "Czech Republic",
    "Borohradek Bohemia": "Czech Republic",
    
    # Slovakia variants
    "Slovakia": "Slovakia",
    "Kusin Slovakia": "Slovakia",
    
    # Bulgaria variants
    "Bulgaria": "Bulgaria",
    "SW Bulgaria": "Bulgaria",
    "South Western Bulgaria": "Bulgaria",
    
    # Canary Islands variants
    "Canary Isles": "Canary Islands",
    "Canaries": "Canary Islands",
    "Tenerife": "Canary Islands",
    "Tenerife Is": "Canary Islands",
    "Gomera Island": "Canary Islands",
    "La Gomera, Canary Isles": "Canary Islands",
    
    # Portugal variants
    "Azores": "Portugal",
    "Madeira": "Portugal",
    "Portugal": "Portugal",
    
    # Other countries
    "Alps": "Alps",
    "central Europe": "Central Europe",
    "Central Europe": "Central Europe",
    "SE Europe": "Central Europe",
    "southern Europe": "Southern Europe",
    "North Africa": "North Africa",
    "Atlas Mountains": "Morocco",
    "Siberia": "Russia",
    "Tuva": "Russia",
    "Yakutia": "Russia",
    "West Caucasus": "Russia",
    "Crimea": "Ukraine",
    "Cyprus": "Cyprus",
    "Cyprus 2010": "Cyprus",
    "Turkey": "Turkey",
    "Switzerland": "Switzerland",
    "Zermatt Switzerland": "Switzerland",
    "Valais Switzerland": "Switzerland",
    "Swiss Alps": "Switzerland",
    "Western Alps": "Alps",
    "Austria": "Austria",
    "Austria Tyrol": "Austria",
    "Germany": "Germany",
    "Baden Wutemberg": "Germany",
    "Berlin": "Germany",
    "Andora": "Andorra",
    "Andorra": "Andorra",
    "Croatia": "Croatia",
    "Northwesteern Croatia": "Croatia",
    "Hungary": "Hungary",
    "Romania": "Romania",
    "Slovenia": "Slovenia",
    "Serbia": "Serbia",
    "Montenegro": "Montenegro",
    "Bosnia-Herzegovina": "Bosnia-Herzegovina",
    "Bosnia Hercegovia": "Bosnia-Herzegovina",
    "Yugoslavia": "Yugoslavia",
    "Yugoslavia 1998": "Yugoslavia",
    "Yugoslavia/Slovenia": "Yugoslavia",
    "Macedonia": "Macedonia",
    "Armenia": "Armenia",
    "Armenian Republic": "Armenia",
    "Russia": "Russia",
    "Sweden": "Sweden",
    "Nordschweden": "Sweden",
    "Abisko": "Sweden",
    "Finland": "Finland",
    "Denmark": "Denmark",
    "Norway": "Norway",
    "Belgium": "Belgium",
    "Netherlands": "Netherlands",
    "Kyrgyzstan": "Kyrgyzstan",
    "Iran": "Iran",
    "Malta": "Malta",
    "Malta 1989": "Malta",
    "Madagascar": "Madagascar",
    "South Africa": "South Africa",
    "Ireland": "Ireland",
    "Eire": "Ireland",
    "Sheep's Head peninsula, South West Co Cork, Eire": "Ireland",
    "Co Galway, Eire": "Ireland",
    "China": "China",
    "Japan": "Japan",
    "Peru": "Peru",
    "USA": "USA",
    "Gulmarg": "India",
    "Isonzo River Gorizia Italian alps": "Italy",
}

# List of known country names (for substring matching)
KNOWN_COUNTRIES = {
    "France", "Spain", "UK", "Greece", "Poland", "Italy", "Czech Republic",
    "Slovakia", "Bulgaria", "Portugal", "Germany", "Cyprus", "Russia", "Ukraine",
    "Switzerland", "Austria", "Sweden", "Norway", "Denmark", "Belgium",
    "Netherlands", "Corsica", "Morocco", "Turkey", "USA", "Canada", "Australia",
    "Japan", "China", "India", "Brazil", "Mexico", "Argentina", "Croatia",
    "Hungary", "Romania", "Slovenia", "Serbia", "Montenegro", "Bosnia",
    "Macedonia", "Armenia", "Kyrgyzstan", "Iran", "Ireland", "Malta",
    "Madagascar", "South Africa", "Peru", "Andorra", "Estonia",
}

def fix_typos(location):
    """Fix known typos in location field using regex word boundaries."""
    if location is None:
        return None
    
    for typo_pattern, correct in TYPO_FIXES.items():
        location = re.sub(typo_pattern, correct, location)
    
    return location

def extract_country(location):
    """
    Extract or derive location_country from location field.
    """
    if location is None or location.strip() == "":
        return None
    
    location = location.strip()
    
    # Remove trailing date/year patterns
    location_clean = re.sub(r'\s+\d{4}$', '', location)
    location_clean = re.sub(r'\s+\d{4}-\d{2}$', '', location_clean)
    location_clean = re.sub(r',\s*$', '', location_clean)  # Remove trailing comma
    
    # Check exact matches first (explicit mappings)
    if location_clean in COUNTRY_MAPPINGS:
        return COUNTRY_MAPPINGS[location_clean]
    if location in COUNTRY_MAPPINGS:
        return COUNTRY_MAPPINGS[location]
    
    # Check if location is a known country name
    if location_clean in KNOWN_COUNTRIES:
        return location_clean
    if location in KNOWN_COUNTRIES:
        return location
    
    # Try to extract country from composite locations (contains a known country)
    for country in sorted(KNOWN_COUNTRIES, key=len, reverse=True):
        if country in location_clean or country in location:
            # If exact mapping exists for this pattern, use it
            if location_clean in COUNTRY_MAPPINGS or location in COUNTRY_MAPPINGS:
                return COUNTRY_MAPPINGS.get(location_clean) or COUNTRY_MAPPINGS.get(location)
            # Return the country name found
            return country
    
    # Handle special patterns
    if "England" in location or "UK" in location or "Scotland" in location or "Wales" in location or "Isle" in location:
        return "UK"
    if "Alps" in location:
        return "Alps"
    if "Pyrenees" in location:
        # Check if Spanish or French
        if "Spanish" in location:
            return "Spain"
        if "French" in location:
            return "France"
        return "Pyrenees"
    if "Caucasus" in location:
        return "Russia"
    
    # If truly unknown, use location itself as fallback
    # This preserves detail while still providing a value
    return location


def normalize_collection():
    """Load, normalize, and save collection data."""
    collection_path = Path(__file__).parent / "data" / "collection.json"
    
    # Load collection
    print(f"Loading {collection_path}...")
    with open(collection_path, 'r', encoding='utf-8') as f:
        records = json.load(f)
    
    print(f"Processing {len(records)} records...")
    
    # Track statistics
    location_country_counts = Counter()
    unique_locations = set()
    changes = []
    
    # Process each record
    for record in records:
        location = record.get("location")
        
        # Special case: "Boulton from Cornwall stock"
        if location and "Boulton from Cornwall stock" in location:
            record["location"] = "Cornwall"
            if record.get("description") is None:
                record["description"] = "Boulton from Cornwall stock"
            else:
                record["description"] = f"Boulton from Cornwall stock; {record['description']}"
            location = "Cornwall"
        
        # Fix typos
        original_location = location
        location = fix_typos(location)
        if location != original_location and original_location is not None:
            record["location"] = location
            changes.append(f"Fixed typo: {original_location} -> {location}")
        
        # Extract country
        location_country = extract_country(location)
        record["location_country"] = location_country
        
        # Track
        if location:
            unique_locations.add(location)
        if location_country:
            location_country_counts[location_country] += 1
    
    # Save back
    print(f"\nSaving {collection_path}...")
    with open(collection_path, 'w', encoding='utf-8') as f:
        json.dump(records, f, ensure_ascii=False, indent=2)
    
    # Print summary
    print("\n" + "="*60)
    print("LOCATION_COUNTRY Summary (sorted by count, descending)")
    print("="*60)
    for country, count in location_country_counts.most_common():
        print(f"{country:35} | {count:4} records")
    
    print("\n" + "="*60)
    print(f"Total unique location_country values: {len(location_country_counts)}")
    print(f"Total unique locations (before country extraction): {len(unique_locations)}")
    print(f"Records with null location_country: {len([r for r in records if r.get('location_country') is None])}")
    
    if changes:
        print("\n" + "="*60)
        print(f"Typo fixes applied: {len(changes)}")
        print("="*60)
        for change in changes[:20]:  # Show first 20
            print(f"  {change}")
        if len(changes) > 20:
            print(f"  ... and {len(changes) - 20} more")


if __name__ == "__main__":
    normalize_collection()
