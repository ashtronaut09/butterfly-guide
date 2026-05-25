/**
 * labels.js — PDF label generator for Butterfly Collection Manager
 *
 * Generates two styles of pinned-specimen labels:
 *
 *   Title label  — 30mm × 8mm
 *     Line 1: English name + sex symbol  (bold, centered)
 *     Line 2: Latin name                 (italic, centered)
 *     Black border, 0.3 mm stroke
 *
 *   Details label — 15mm × 15mm
 *     Location / Altitude / Date / Collector  (centered, lines omitted if null)
 *     Black border, 0.3 mm stroke
 *
 * Public API
 * ──────────
 *   generateLabelsPDF(specimens)  — builds & downloads 'labels-YYYY-MM-DD.pdf'
 *   generatePreview(specimens)    — returns human-readable description string
 *
 * jsPDF is expected on window.jspdf (loaded from CDN before this module runs).
 */

// ── Page / label constants ─────────────────────────────────────────────────

const PAGE_W   = 210;   // A4 width  mm
const PAGE_H   = 297;   // A4 height mm

const MARGIN_H = 6;     // left & right margin mm
const MARGIN_V = 10;    // top & bottom margin  mm
const GUTTER   = 3;     // gap between labels    mm

// Title label dimensions
const TL_W     = 30;    // mm
const TL_H     = 8;     // mm

// Details label dimensions
const DL_W     = 15;    // mm
const DL_H     = 15;    // mm

// Labels per page — derived from constants
const TL_COLS  = Math.floor((PAGE_W - 2 * MARGIN_H) / (TL_W + GUTTER)); // 6
const TL_ROWS  = Math.floor((PAGE_H - 2 * MARGIN_V) / (TL_H + GUTTER)); // 25
const TL_PER_PAGE = TL_COLS * TL_ROWS;                                   // 150

const DL_COLS  = Math.floor((PAGE_W - 2 * MARGIN_H) / (DL_W + GUTTER)); // 11
const DL_ROWS  = Math.floor((PAGE_H - 2 * MARGIN_V) / (DL_H + GUTTER)); // 15
const DL_PER_PAGE = DL_COLS * DL_ROWS;                                   // 165

// ── Date helpers ───────────────────────────────────────────────────────────

/**
 * Converts ISO date "YYYY-MM-DD" → "DD.MM.YYYY".
 * Returns null if the input is falsy or can't be parsed.
 * @param {string|null|undefined} iso
 * @returns {string|null}
 */
function formatDate(iso) {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  return `${m[3]}.${m[2]}.${m[1]}`;
}

// ── Text-fit helpers ───────────────────────────────────────────────────────

/**
 * Truncates `text` with an ellipsis until it fits within `maxWidth` mm,
 * measuring with jsPDF's getTextWidth(). Tries reducing font size by one
 * point first (down to `minSize`), then falls back to character truncation.
 *
 * Returns { text, fontSize } — caller must apply doc.setFontSize(fontSize).
 *
 * @param {object} doc        jsPDF instance
 * @param {string} text
 * @param {number} maxWidth   mm
 * @param {number} fontSize   starting pt size
 * @param {number} minSize    minimum pt size before truncation kicks in
 * @returns {{ text: string, fontSize: number }}
 */
function fitText(doc, text, maxWidth, fontSize, minSize = 4) {
  // Step 1 — try a slightly smaller font size first
  let size = fontSize;
  doc.setFontSize(size);
  if (doc.getTextWidth(text) <= maxWidth) return { text, fontSize: size };

  const reduced = Math.max(minSize, size - 1);
  doc.setFontSize(reduced);
  if (doc.getTextWidth(text) <= maxWidth) return { text, fontSize: reduced };

  // Step 2 — truncate with ellipsis at the reduced size
  let truncated = text;
  while (truncated.length > 1 && doc.getTextWidth(truncated + '…') > maxWidth) {
    truncated = truncated.slice(0, -1);
  }
  return { text: truncated + '…', fontSize: reduced };
}

// ── Label drawing ──────────────────────────────────────────────────────────

/**
 * Draws a single Title label at (x, y) — top-left corner in mm.
 *
 * @param {object} doc       jsPDF instance
 * @param {number} x
 * @param {number} y
 * @param {object} specimen  raw data record
 */
function drawTitleLabel(doc, x, y, specimen) {
  const PADDING_H = 1.0;  // horizontal inner padding mm
  const innerW    = TL_W - 2 * PADDING_H;

  // Border
  doc.setDrawColor(0, 0, 0);
  doc.setLineWidth(0.3);
  doc.rect(x, y, TL_W, TL_H);

  // ── Line 1: English name + sex symbol (bold) ──
  const nameRaw = [specimen.english_name || '(Unnamed)', specimen.sex || ''].filter(Boolean).join(' ');

  doc.setFont('helvetica', 'bold');
  const line1 = fitText(doc, nameRaw, innerW, 5.5, 4);
  doc.setFontSize(line1.fontSize);

  // ── Line 2: Latin name (italic) ──
  doc.setFont('helvetica', 'italic');
  const line2 = fitText(doc, specimen.latin_name || '', innerW, 5, 4);
  doc.setFontSize(line2.fontSize);

  // Vertical centering: two lines with a small gap
  // Approximate line height in mm: fontSize(pt) * 0.3528 ≈ pt → mm
  const ptToMm  = 0.3528;
  const lh1     = line1.fontSize * ptToMm;
  const lh2     = line2.fontSize * ptToMm;
  const lineGap = 0.5;  // mm between baselines of the two lines
  const blockH  = lh1 + lineGap + lh2;
  const startY  = y + (TL_H - blockH) / 2 + lh1;  // baseline of line 1

  const cx = x + TL_W / 2;  // horizontal centre

  // Draw line 1 (bold)
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(line1.fontSize);
  doc.text(line1.text, cx, startY, { align: 'center' });

  // Draw line 2 (italic)
  if (line2.text) {
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(line2.fontSize);
    doc.text(line2.text, cx, startY + lineGap + lh2, { align: 'center' });
  }
}

/**
 * Draws a single Details label at (x, y) — top-left corner in mm.
 *
 * @param {object} doc
 * @param {number} x
 * @param {number} y
 * @param {object} specimen
 */
function drawDetailsLabel(doc, x, y, specimen) {
  const FONT_SIZE  = 4.5;   // pt
  const PADDING_H  = 0.8;   // mm
  const innerW     = DL_W - 2 * PADDING_H;

  // Border
  doc.setDrawColor(0, 0, 0);
  doc.setLineWidth(0.3);
  doc.rect(x, y, DL_W, DL_H);

  // Build content lines — omit nulls/empties
  const lines = [];

  if (specimen.location) {
    lines.push(specimen.location);
  }
  if (specimen.altitude_m != null) {
    lines.push(`${specimen.altitude_m}m`);
  }
  const dateFmt = formatDate(specimen.date_bought);
  if (dateFmt) {
    lines.push(dateFmt);
  }
  // Collector: only if explicitly set, never default
  if (specimen.collector != null && specimen.collector !== '') {
    lines.push(specimen.collector);
  }

  if (lines.length === 0) return;  // border only, nothing to render

  // Measure each line and fit to width
  const ptToMm  = 0.3528;
  const lineH   = FONT_SIZE * ptToMm;
  const lineGap = 0.6;  // mm between lines

  const fittedLines = lines.map(raw => {
    doc.setFont('helvetica', 'normal');
    return fitText(doc, raw, innerW, FONT_SIZE, 3.5);
  });

  const blockH = fittedLines.length * lineH +
                 (fittedLines.length - 1) * lineGap;
  const startY = y + (DL_H - blockH) / 2 + lineH;  // baseline of first line

  const cx = x + DL_W / 2;

  fittedLines.forEach((fl, i) => {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(fl.fontSize);
    doc.text(fl.text, cx, startY + i * (lineH + lineGap), { align: 'center' });
  });
}

// ── Page layout helpers ────────────────────────────────────────────────────

/**
 * Returns the top-left (x, y) position of a cell in a label grid.
 *
 * @param {number} index       0-based position within the current page
 * @param {number} cols        labels per row
 * @param {number} labelW      label width mm
 * @param {number} labelH      label height mm
 * @returns {{ x: number, y: number }}
 */
function cellPosition(index, cols, labelW, labelH) {
  const col = index % cols;
  const row = Math.floor(index / cols);
  return {
    x: MARGIN_H + col * (labelW + GUTTER),
    y: MARGIN_V + row * (labelH + GUTTER),
  };
}

// ── PDF generation ─────────────────────────────────────────────────────────

/**
 * Generates a print-ready A4 PDF containing:
 *   1. All title  labels (30mm × 8mm)  for the selected specimens
 *   2. All details labels (15mm × 15mm) for the selected specimens
 *
 * Triggers a browser download named 'labels-YYYY-MM-DD.pdf'.
 *
 * @param {object[]} specimens  — array of selected specimen records
 */
export function generateLabelsPDF(specimens) {
  if (!specimens || specimens.length === 0) return;

  if (!window.jspdf || typeof window.jspdf.jsPDF !== 'function') {
    console.error('[labels] jsPDF not loaded — check CDN script tag');
    alert('PDF library failed to load. Check your internet connection and reload.');
    return;
  }

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

  // ── Header text (page 1 only, very top) ───────────────────────────────────
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(5.5);
  doc.setTextColor(160, 160, 160);
  doc.text(
    'Print at 100% / Actual Size — Do not scale to fit',
    PAGE_W / 2,
    5,
    { align: 'center' }
  );
  doc.setTextColor(0, 0, 0);

  // ── Title labels ──────────────────────────────────────────────────────────
  specimens.forEach((specimen, i) => {
    const posInPage = i % TL_PER_PAGE;

    // New page needed (but not for the very first label — page 1 already exists)
    if (i > 0 && posInPage === 0) {
      doc.addPage();
    }

    const { x, y } = cellPosition(posInPage, TL_COLS, TL_W, TL_H);
    drawTitleLabel(doc, x, y, specimen);
  });

  // ── Details labels ────────────────────────────────────────────────────────
  specimens.forEach((specimen, i) => {
    const posInPage = i % DL_PER_PAGE;

    // Always add a new page before the first details label block
    if (posInPage === 0) {
      doc.addPage();
    }

    const { x, y } = cellPosition(posInPage, DL_COLS, DL_W, DL_H);
    drawDetailsLabel(doc, x, y, specimen);
  });

  // ── Save (manual blob download for Firefox compatibility) ──────────────────
  const today = new Date().toISOString().slice(0, 10);  // YYYY-MM-DD
  const filename = `labels-${today}.pdf`;
  const blob = doc.output('blob');
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 500);
}

// ── Preview helper ─────────────────────────────────────────────────────────

/**
 * Returns a human-readable description of how many labels will be generated
 * and how many pages they will span.
 *
 * Example: "12 title labels + 12 details labels across 2 pages"
 *
 * @param {object[]} specimens
 * @returns {string}
 */
export function generatePreview(specimens) {
  if (!specimens || specimens.length === 0) {
    return '0 title labels + 0 details labels across 0 pages';
  }

  const n = specimens.length;

  const titlePages   = Math.ceil(n / TL_PER_PAGE);
  const detailsPages = Math.ceil(n / DL_PER_PAGE);
  const totalPages   = titlePages + detailsPages;

  return `${n} title label${n === 1 ? '' : 's'} + ${n} details label${n === 1 ? '' : 's'} across ${totalPages} page${totalPages === 1 ? '' : 's'}`;
}
