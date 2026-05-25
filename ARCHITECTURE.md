# European Butterfly Guide — Architecture & Build Plan

## Goal
A static website that serves as a visual identification and reference tool for European butterfly collectors. ~488 species with photos, spec cards, and multi-axis filtering (family, color, size, region, flight period).

## Project Structure

```
butterfly-guide/
├── ARCHITECTURE.md          # This file
├── fetch-data.py            # Data fetching script (Phase 1)
├── enrich-data.py           # Tag/metadata enrichment (Phase 2)
├── data/
│   └── species.json         # Final enriched dataset
├── index.html               # Single-page app
├── css/
│   └── styles.css
├── js/
│   ├── app.js               # Main app logic, filtering, rendering
│   └── data-loader.js       # Loads and indexes species.json
└── images/                  # Downloaded species thumbnails (medium res)
    └── {taxon_id}.jpg
```

## Phase 1: Data Fetching (`fetch-data.py`)

### Source: iNaturalist API v1 (no auth required, rate limit ~1 req/sec)

#### Step 1: Get all European butterfly species
- Endpoint: `GET /v1/observations/species_counts`
- Params: `taxon_id=47224` (Papilionoidea), `place_id=97391` (Europe), `quality_grade=research`, `per_page=200`
- Paginate with `page=1,2,3` until all results collected
- This returns basic taxon info + default photo for each species

#### Step 2: Enrich with full taxon data
- Endpoint: `GET /v1/taxa/{id1},{id2},{id3},...`
- Batch up to 30 taxon IDs per request
- This gives: `ancestors` (for family name), `conservation_statuses`, `wikipedia_summary`, `taxon_photos`

#### Step 3: Download images
- From each taxon's `default_photo.url`, replace `square.jpg` with `medium.jpg`
- Download to `images/{taxon_id}.jpg`
- Respect rate limiting — add 0.5s delay between downloads
- Log any failures, don't abort on individual image errors

#### Output: `data/species-raw.json`
Array of objects:
```json
{
  "id": 52592,
  "scientific_name": "Pararge aegeria",
  "common_name": "Speckled Wood",
  "family": "Nymphalidae",
  "subfamily": "Satyrinae",
  "ancestors": ["Animalia", "Arthropoda", "Insecta", "Lepidoptera", "Papilionoidea", "Nymphalidae", "Satyrinae", "Pararge"],
  "image_url": "https://inaturalist-open-data.s3.amazonaws.com/photos/102255693/medium.jpg",
  "image_local": "images/52592.jpg",
  "image_attribution": "Felipe Hidalgo",
  "image_license": "cc-by-nc",
  "conservation_status": "LC",
  "wikipedia_summary": "The speckled wood is a...",
  "wikipedia_url": "http://en.wikipedia.org/wiki/Speckled_wood_(butterfly)",
  "observation_count": 128821,
  "inaturalist_url": "https://www.inaturalist.org/taxa/52592"
}
```

### Implementation notes for fetch-data.py
- Use `requests` library (stdlib `urllib` as fallback)
- Add 1-second delay between API calls
- Save raw API responses to `data/api-cache/` so re-runs don't re-fetch
- Print progress: `[142/488] Fetching Pararge aegeria...`
- Extract family name from ancestors array (find the ancestor with rank "family")

## Phase 2: Tag Enrichment (`enrich-data.py`)

This script reads `data/species-raw.json` and adds tags for filtering.

### Color tags
Derive from known family/species color associations. Use this lookup table:

```python
FAMILY_COLORS = {
    "Lycaenidae": ["blue", "brown", "copper"],    # Blues, coppers, hairstreaks
    "Pieridae": ["white", "yellow", "orange"],      # Whites and yellows
    "Nymphalidae": ["orange", "brown", "black"],    # Varied, but mostly warm tones
    "Papilionidae": ["yellow", "black", "blue"],    # Swallowtails
    "Hesperiidae": ["brown", "orange"],             # Skippers
    "Riodinidae": ["brown", "orange"],              # Metalmarks
}
```

Also apply species-specific overrides for well-known species:
```python
SPECIES_COLORS = {
    "Vanessa atalanta": ["red", "black", "white"],       # Red Admiral
    "Inachis io": ["red", "blue", "black"],              # Peacock — eyespots
    "Gonepteryx rhamni": ["yellow"],                     # Brimstone
    "Pieris brassicae": ["white", "black"],              # Large White
    "Polyommatus icarus": ["blue"],                      # Common Blue
    "Argynnis paphia": ["orange", "black"],              # Silver-washed Fritillary
    "Papilio machaon": ["yellow", "black", "blue"],      # Swallowtail
    "Anthocharis cardamines": ["white", "orange"],        # Orange Tip
    "Lycaena phlaeas": ["orange", "copper", "brown"],    # Small Copper
    "Melanargia galathea": ["black", "white"],           # Marbled White
    "Apatura iris": ["purple", "black", "white"],        # Purple Emperor
    "Celastrina argiolus": ["blue", "white"],            # Holly Blue
    "Colias croceus": ["orange", "yellow"],              # Clouded Yellow
    "Limenitis camilla": ["black", "white"],             # White Admiral
    "Zerynthia polyxena": ["yellow", "black", "red"],    # Southern Festoon
}
```

### Size tags
Assign based on family averages (wingspan in mm):

| Tag | Wingspan | Typical families |
|-----|----------|-----------------|
| `tiny` | < 25mm | Some Lycaenidae, Hesperiidae |
| `small` | 25-35mm | Most Lycaenidae, small Pieridae |
| `medium` | 35-55mm | Most Nymphalidae, Pieridae |
| `large` | 55-75mm | Large Nymphalidae, Papilionidae |
| `very-large` | > 75mm | Papilio, Iphiclides |

Use family-based defaults, with species-specific overrides for known outliers.

### Pattern tags
Assign based on subfamily/tribe:
- `eyespots` — Satyrinae (browns, ringlets, meadow browns)
- `spotted` — Melitaeini (fritillaries), some Lycaenidae
- `striped` — Pieridae, some Hesperiidae
- `checkered` — Melanargia, some Hesperiidae
- `iridescent` — Apatura, Lycaenidae (structural color)
- `tailed` — Papilionidae, some Lycaenidae (Cupido)
- `plain` — fallback

### Flight period
Map by family/subfamily averages:
- `spring` (Mar-May), `summer` (Jun-Aug), `autumn` (Sep-Nov)
- Most get `["spring", "summer"]` or `["summer"]`
- Apply known overrides: Gonepteryx = `["spring", "summer", "autumn"]` (hibernator), etc.

### Habitat tags
- `woodland`, `meadow`, `grassland`, `mountain`, `wetland`, `garden`, `coast`
- Map from subfamily where possible, default to `["meadow", "grassland"]`

### Region tags
- `northern` (Scandinavia, Baltics), `western` (UK, France, Benelux), `central` (Germany, Alps, Poland), `southern` (Mediterranean), `eastern` (Balkans, Eastern Europe)
- Default to `["western", "central", "southern"]` for most species
- Override for known endemics/restricted species

### Output: `data/species.json`
Same as raw but with added fields:
```json
{
  "...all raw fields...",
  "tags": {
    "colors": ["orange", "black"],
    "size": "medium",
    "wingspan_category": "35-55mm",
    "patterns": ["spotted"],
    "flight_period": ["summer"],
    "habitat": ["meadow", "grassland"],
    "region": ["western", "central", "southern"]
  }
}
```

## Phase 3: Website (`index.html` + `css/` + `js/`)

### Layout (single page, no framework, no build step)

```
┌─────────────────────────────────────────────────────────┐
│  🦋 European Butterfly Guide              [search box]  │
├─────────────────────────────────────────────────────────┤
│ Filters (horizontal bar, collapsible on mobile):        │
│ [Family ▼] [Color ▼] [Size ▼] [Pattern ▼]              │
│ [Flight Period ▼] [Habitat ▼] [Region ▼]               │
│ Active filters shown as dismissable chips below bar     │
│ "Showing 142 of 488 species"                            │
├─────────────────────────────────────────────────────────┤
│ Sort: [Alphabetical] [Family] [Size] [Observation count]│
├─────────────────────────────────────────────────────────┤
│  ┌──────────┐  ┌──────────┐  ┌──────────┐              │
│  │  [image]  │  │  [image]  │  │  [image]  │             │
│  │ Common    │  │ Common    │  │ Common    │             │
│  │ Name      │  │ Name      │  │ Name      │             │
│  │ Sci. name │  │ Sci. name │  │ Sci. name │             │
│  │ Family    │  │ Family    │  │ Family    │             │
│  │ [tags]    │  │ [tags]    │  │ [tags]    │             │
│  └──────────┘  └──────────┘  └──────────┘              │
│  (responsive grid: 4 cols desktop, 2 tablet, 1 mobile) │
│                                                         │
│  ... more cards ...                                     │
│                                                         │
│  [Load more] or virtual scroll                          │
└─────────────────────────────────────────────────────────┘
```

### Card design (collapsed state — shown in grid)
- Species image (from `images/{id}.jpg`, fallback to iNaturalist URL)
- Common name (bold)
- Scientific name (italic)
- Family pill
- 2-3 most relevant tag pills (color, size)

### Card design (expanded state — click/tap to expand)
Full spec card appears as a modal or inline expansion:

```
┌────────────────────────────────────────────┐
│  [Large image]                    [✕ close]│
│                                            │
│  Speckled Wood                             │
│  Pararge aegeria                           │
│                                            │
│  Family:       Nymphalidae > Satyrinae     │
│  Wingspan:     35-55mm (medium)            │
│  Flight:       Apr — Sep                   │
│  Habitat:      Woodland, gardens           │
│  Range:        Western, Central, Southern  │
│  Conservation: Least Concern (LC)          │
│  Observations: 128,821 on iNaturalist      │
│                                            │
│  Tags: [brown] [eyespots] [medium]         │
│                                            │
│  "The speckled wood is a butterfly found   │
│  throughout the Palearctic..."             │
│                                            │
│  📷 Photo: Felipe Hidalgo (CC BY-NC)       │
│  🔗 iNaturalist  🔗 Wikipedia              │
└────────────────────────────────────────────┘
```

### Filter behavior
- All filters are multi-select dropdowns
- Filters within the same category are OR (selecting "blue" + "orange" shows species tagged with either)
- Filters across categories are AND (selecting color "blue" + size "small" shows species that are both)
- Text search matches common name, scientific name, and family
- URL hash updates with filter state so links are shareable: `#colors=blue,orange&size=small`
- Filter counts shown in dropdowns: "Blue (47)"

### Group-by mode
- Toggle between "Grid" and "Grouped" views
- Grouped view clusters cards under headings (by family, by color, by size)
- Within groups, cards are alphabetical
- User picks group-by axis from a dropdown: Family | Color | Size | Pattern

### Technical implementation (js/)

#### `data-loader.js`
- Fetch `data/species.json` on load
- Build indexes: by family, by each tag type
- Export filtered/sorted accessor functions

#### `app.js`
- Render filter bar with counts
- Render card grid using template literals (no framework)
- Handle filter changes → re-query indexes → re-render grid
- Handle card click → show expanded modal
- Handle search input → filter by name match
- Debounce search at 200ms
- Lazy-load images with `loading="lazy"` on img tags
- Update URL hash on filter change, read hash on page load

### CSS approach
- CSS Grid for the card layout
- CSS custom properties for theming (easy to adjust colors)
- No CSS framework — keep it lightweight
- Responsive breakpoints: 1200px (4 col), 768px (2 col), 480px (1 col)
- Cards have subtle hover shadow
- Tag pills are colored by type (blue for color tags, green for habitat, etc.)
- Modal uses backdrop blur
- Dark mode support via `prefers-color-scheme` media query

### Colors for tag pills
```css
/* Color tags get their actual color */
.tag-blue    { background: #4a90d9; color: white; }
.tag-orange  { background: #e8853d; color: white; }
.tag-white   { background: #f0f0f0; color: #333; border: 1px solid #ccc; }
.tag-yellow  { background: #f0d050; color: #333; }
.tag-red     { background: #d94a4a; color: white; }
.tag-brown   { background: #8b6914; color: white; }
.tag-black   { background: #333; color: white; }
.tag-purple  { background: #7b4dd9; color: white; }
.tag-copper  { background: #b87333; color: white; }
.tag-green   { background: #4a9; color: white; }

/* Other tag types */
.tag-size    { background: #e8e8e8; color: #333; }
.tag-pattern { background: #f5e6d3; color: #5a4020; }
.tag-habitat { background: #d3f5e6; color: #204a30; }
.tag-flight  { background: #d3e6f5; color: #203a5a; }
.tag-region  { background: #f5d3e6; color: #5a2040; }
```

## Phase 4: Polish & Testing

- Test all filters individually and in combination
- Verify all images load (report any 404s)
- Test on mobile viewport (responsive)
- Verify search works with partial matches, accented characters
- Check expanded card displays all fields correctly
- Ensure "Showing X of Y" count updates correctly
- Test URL hash sharing (copy URL, open in new tab → same filters applied)

## API Reference

### iNaturalist API (no auth needed)

**Species list:**
```
GET https://api.inaturalist.org/v1/observations/species_counts
  ?taxon_id=47224
  &place_id=97391
  &quality_grade=research
  &per_page=200
  &page={1,2,3}
```

**Taxon details (batch):**
```
GET https://api.inaturalist.org/v1/taxa/{id1},{id2},...,{id30}
```

**Photo URL sizes** (replace suffix in URL):
- `square.jpg` — 75x75
- `small.jpg` — 240px wide
- `medium.jpg` — 500px wide
- `large.jpg` — 1024px wide

### Rate limiting
- 1 request/second for API calls
- 0.5 second delay between image downloads
- Cache raw API responses to avoid re-fetching on reruns

## Image Attribution

All images from iNaturalist are Creative Commons licensed. Each image's license and attribution must be preserved. The expanded card must show:
- Photographer name
- License type (CC BY, CC BY-NC, CC BY-SA, etc.)
- Link to iNaturalist taxon page

## Dependencies

- Python 3.10+: `requests` (install with `pip install requests`)
- No JS dependencies — vanilla HTML/CSS/JS
- No build step — open `index.html` in a browser
