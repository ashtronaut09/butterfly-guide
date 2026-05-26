# Butterfly Collection Export

## Export Options

The Butterfly Collection Manager offers two export formats:

### 1. Export HTML (Recommended for Sharing)

**Button:** "Export HTML"

Creates a **standalone HTML file** that can be opened on any computer with a web browser.

**Features:**
- Self-contained: no external dependencies
- Embedded thumbnails as base64 data URIs
- Search, filter, and sort functionality
- Table and grid view modes
- Works offline
- Can be shared via email, USB drive, cloud storage, etc.

**Use cases:**
- Sharing your collection with friends or colleagues
- Viewing on a different computer
- Creating a backup for archival purposes
- Publishing online

**File size:** Larger (includes embedded images), typically 5-20 MB depending on collection size.

### 2. Export ZIP (Full Backup)

**Button:** "Export ZIP"

Creates a complete backup with full-resolution photos and structured data.

**Features:**
- Full specimen data in JSON format
- All photos at original resolution
- Organized folder structure
- Can be re-imported into the collection manager

**Use cases:**
- Complete backup before making major changes
- Transferring the entire collection with high-res photos
- Archival storage

**File size:** Larger (includes full-resolution photos).

## How to Use Exported HTML

1. Click "Export HTML" button in the collection manager
2. Save the `.html` file to your computer
3. To open:
   - **Windows:** Double-click the file, or right-click → Open with → Browser
   - **Mac:** Double-click the file, or drag onto a browser icon
   - **Linux:** Right-click → Open with → Browser
4. The collection will open in your browser with full search/filter functionality

## Limitations of HTML Export

- **Read-only:** Cannot add, edit, or delete specimens
- **Thumbnails only:** Full-resolution photos are not included (to keep file size manageable)
- **No label generation:** PDF label export is not available in the standalone file
- **No photo upload:** The export is a snapshot at the time of creation

To make changes, use the full collection manager and export again.

## Sharing Best Practices

- **Email:** Good for small collections (< 100 specimens). Compress the HTML file to a ZIP if it's large.
- **Cloud storage:** Upload to Google Drive, Dropbox, etc. and share the link.
- **USB drive:** Copy the HTML file directly.
- **Website:** Upload to any web host - no server-side processing required.

## Privacy Note

The exported HTML file contains all specimen data that was in your collection at export time. Review the content before sharing publicly if you have sensitive information (prices, personal notes, etc.).
