/**
 * labels.js — PDF label generator for Butterfly Collection Manager
 *
 * Generates two styles of pinned-specimen labels with text wrapping:
 *
 *   Title label  — 30mm × 8mm base, grows up to 12mm for wrapped text
 *     Line 1: English name + sex symbol  (bold, centered)
 *     Line 2: Latin name                 (italic, centered)
 *     Black border, 0.3 mm stroke
 *
 *   Details label — 15mm × 15mm base, grows up to 18mm for wrapped text
 *     Location / Altitude / Date / Collector  (centered, lines omitted if null)
 *     Black border, 0.3 mm stroke
 *
 * Uses jsPDF's built-in text wrapping (maxWidth / splitTextToSize) instead of
 * manual truncation with ellipsis. Labels can grow slightly in height when
 * text wraps, ensuring all content is visible.
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
const GUTTER   = 1;     // gap between labels    mm

// Title label
const TL_W      = 30;    // mm
const TL_H_BASE = 8;     // base height mm
const TL_H_MAX  = 12;    // max height mm when text wraps

// Details label
const DL_W      = 15;    // mm
const DL_H_BASE = 13;    // base height mm
const DL_H_MAX  = 16;    // max height mm when text wraps

// Columns per page — derived from constants
const TL_COLS  = Math.floor((PAGE_W - 2 * MARGIN_H) / (TL_W + GUTTER)); // 6
const DL_COLS  = Math.floor((PAGE_W - 2 * MARGIN_H) / (DL_W + GUTTER)); // 11

const PT_TO_MM = 0.3528;  // 1 pt ≈ 0.3528 mm

// ── Text cleanup ──────────────────────────────────────────────────────────

/**
 * Collapses "s p a c e d" text (single letters separated by spaces) into
 * normal words. E.g. "B r i s t o l" → "Bristol".
 */
function cleanSpacedText(str) {
  if (!str) return str;
  return str.replace(/(?:^|(?<=\s))([A-Za-z]) (?:[A-Za-z] )*[A-Za-z](?=\s|$)/g, (match) => {
    const chars = match.split(' ');
    if (chars.every(c => c.length === 1)) return chars.join('');
    return match;
  });
}

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
 * Measures how tall wrapped text will be in mm at a given font size.
 * Uses doc.splitTextToSize() to find the line count.
 *
 * @param {object} doc       jsPDF instance
 * @param {string} text      text to measure
 * @param {number} maxWidth  max width in mm
 * @param {number} fontSize  font size in pt
 * @returns {{ lines: string[], totalHeight: number, lineH: number }}
 */
function measureWrappedHeight(doc, text, maxWidth, fontSize) {
  doc.setFontSize(fontSize);
  const lines = doc.splitTextToSize(text, maxWidth);
  const lineH = fontSize * PT_TO_MM * 1.2; // line-height ~1.2
  return { lines, totalHeight: lines.length * lineH, lineH };
}

/**
 * Finds the largest font size at which `text` fits within `maxWidth` ×
 * `maxHeight` with wrapping. Steps down from `startSize` to `minSize` in
 * 0.5 pt increments.
 *
 * @param {object} doc        jsPDF instance
 * @param {string} text       text to fit
 * @param {number} maxWidth   max width in mm
 * @param {number} maxHeight  max height in mm
 * @param {number} startSize  starting font size in pt
 * @param {number} minSize    minimum font size in pt
 * @param {string} fontStyle  'normal' | 'bold' | 'italic'
 * @returns {{ fontSize: number, lines: string[], totalHeight: number, lineH: number }}
 */
function fitWrappedText(doc, text, maxWidth, maxHeight, startSize, minSize, fontStyle = 'normal') {
  doc.setFont('helvetica', fontStyle);

  for (let size = startSize; size >= minSize; size -= 0.5) {
    const result = measureWrappedHeight(doc, text, maxWidth, size);
    if (result.totalHeight <= maxHeight) {
      return { fontSize: size, ...result };
    }
  }

  // At minimum size, return whatever we get (content may clip slightly)
  const result = measureWrappedHeight(doc, text, maxWidth, minSize);
  return { fontSize: minSize, ...result };
}

// ── Label drawing ──────────────────────────────────────────────────────────

/**
 * Draws a single Title label at (x, y) — top-left corner in mm.
 * Text wraps with maxWidth; label height grows as needed up to TL_H_MAX.
 *
 * @param {object} doc       jsPDF instance
 * @param {number} x         left edge mm
 * @param {number} y         top edge mm
 * @param {object} specimen  raw data record
 * @returns {number} actual label height used (mm)
 */
function drawTitleLabel(doc, x, y, specimen) {
  const PADDING_H = 1.0;  // horizontal inner padding mm
  const PADDING_V = 0.5;  // vertical inner padding   mm
  const innerW    = TL_W - 2 * PADDING_H;
  const maxInnerH = TL_H_MAX - 2 * PADDING_V;

  // Build text - convert Unicode sex symbols to ASCII for PDF compatibility
  const sexText = specimen.sex ? specimen.sex.replace(/♂/g, 'M').replace(/♀/g, 'F') : '';
  const nameText  = [specimen.english_name || '(Unnamed)', sexText].filter(Boolean).join(' ');
  const latinText = specimen.latin_name || '';

  // Fit name (bold) — give it up to 60% of vertical space
  const name     = fitWrappedText(doc, nameText, innerW, maxInnerH * 0.6, 5.5, 3, 'bold');

  // Fit latin (italic) — use remaining space below name
  const remainH  = Math.max(2, maxInnerH - name.totalHeight - 0.3);
  const latin    = latinText
    ? fitWrappedText(doc, latinText, innerW, remainH, 5, 3, 'italic')
    : null;

  // Calculate actual label height
  const contentH = name.totalHeight + (latin ? 0.3 + latin.totalHeight : 0);
  const labelH   = Math.max(TL_H_BASE, contentH + 2 * PADDING_V);

  // Border
  doc.setDrawColor(0, 0, 0);
  doc.setLineWidth(0.3);
  doc.rect(x, y, TL_W, labelH);

  // Center content block vertically within the label
  const startY = y + (labelH - contentH) / 2;
  const cx     = x + TL_W / 2;

  // Draw name (bold)
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(name.fontSize);
  name.lines.forEach((line, i) => {
    doc.text(line, cx, startY + name.lineH * (i + 0.8), { align: 'center', charSpace: -0.1 });
  });

  // Draw latin (italic) below name
  if (latin) {
    const latinY = startY + name.totalHeight + 0.3;
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(latin.fontSize);
    latin.lines.forEach((line, i) => {
      doc.text(line, cx, latinY + latin.lineH * (i + 0.8), { align: 'center', charSpace: -0.1 });
    });
  }

  return labelH;
}

/**
 * Draws a single Details label at (x, y) — top-left corner in mm.
 * Each data line wraps independently; label height grows up to DL_H_MAX.
 *
 * @param {object} doc       jsPDF instance
 * @param {number} x         left edge mm
 * @param {number} y         top edge mm
 * @param {object} specimen  raw data record
 * @returns {number} actual label height used (mm)
 */
function drawDetailsLabel(doc, x, y, specimen) {
  const PADDING_H = 0.8;  // horizontal inner padding mm
  const PADDING_V = 0.5;  // vertical inner padding   mm
  const innerW    = DL_W - 2 * PADDING_H;
  const maxInnerH = DL_H_MAX - 2 * PADDING_V;

  // Build content lines — omit nulls / empties
  const textLines = [];

  if (specimen.location) {
    textLines.push(specimen.location);
  }
  if (specimen.altitude_m != null) {
    textLines.push(`Alt ${specimen.altitude_m}m`);
  }
  const dateFmt = formatDate(specimen.date_bought);
  if (dateFmt) {
    textLines.push(dateFmt);
  }
  // Collector: only if explicitly set, never default
  if (specimen.collector != null && specimen.collector !== '') {
    textLines.push(specimen.collector);
  }

  // Clean up spaced-out text on all lines
  for (let i = 0; i < textLines.length; i++) {
    textLines[i] = cleanSpacedText(textLines[i]);
  }

  // No content — draw border at base height and return
  if (textLines.length === 0) {
    doc.setDrawColor(0, 0, 0);
    doc.setLineWidth(0.3);
    doc.rect(x, y, DL_W, DL_H_BASE);
    return DL_H_BASE;
  }

  // Each line gets an equal share of the available vertical space
  const perLineMax  = maxInnerH / textLines.length;
  const lineGap     = 0.4; // mm between wrapped line blocks

  const fitted = textLines.map(text =>
    fitWrappedText(doc, text, innerW, perLineMax, 4.5, 3, 'normal')
  );

  const contentH = fitted.reduce((sum, f) => sum + f.totalHeight, 0) + (fitted.length - 1) * lineGap;
  const labelH   = Math.max(DL_H_BASE, contentH + 2 * PADDING_V);

  // Border
  doc.setDrawColor(0, 0, 0);
  doc.setLineWidth(0.3);
  doc.rect(x, y, DL_W, labelH);

  // Center content block vertically within the label
  const cx  = x + DL_W / 2;
  let curY  = y + (labelH - contentH) / 2;

  fitted.forEach((f) => {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(f.fontSize);
    f.lines.forEach((line, i) => {
      doc.text(line, cx, curY + f.lineH * (i + 0.8), { align: 'center', charSpace: -0.1 });
    });
    curY += f.totalHeight + lineGap;
  });

  return labelH;
}

// ── Page layout ────────────────────────────────────────────────────────────

/**
 * Lays out labels row by row, allowing each label to report its actual height.
 * When a row is complete, Y advances by the tallest label in that row plus
 * gutter. Starts a new page when the next row would exceed the page bottom.
 *
 * @param {object}   doc         jsPDF instance
 * @param {object[]} specimens   array of specimen records
 * @param {function} drawFn      function(doc, x, y, specimen) → height mm
 * @param {number}   labelW      label width mm (used for column spacing)
 * @param {number}   baseLabelH  minimum label height mm (used for page-break check)
 * @param {number}   cols        number of columns per page
 * @param {number}   startY      optional starting Y position (default: MARGIN_V)
 * @returns {number} final Y position after all labels (for next section)
 */
function layoutLabels(doc, specimens, drawFn, labelW, baseLabelH, cols, startY = MARGIN_V) {
  let pageX   = MARGIN_H;
  let pageY   = startY;
  let colIdx  = 0;
  let rowMaxH = 0;

  specimens.forEach((specimen, i) => {
    // Before drawing the first label of a new row, check if a page break is needed
    if (i > 0 && colIdx === 0 && pageY + baseLabelH > PAGE_H - MARGIN_V) {
      doc.addPage();
      pageY  = MARGIN_V;
      colIdx = 0;
      // pageX is already MARGIN_H, rowMaxH is 0
    }

    // Draw the label and capture its actual height
    const h = drawFn(doc, pageX, pageY, specimen);
    rowMaxH = Math.max(rowMaxH, h);

    colIdx++;

    if (colIdx >= cols) {
      // Row complete — advance Y for the next row
      pageY  += rowMaxH + GUTTER;
      pageX   = MARGIN_H;
      colIdx  = 0;
      rowMaxH = 0;
    } else {
      pageX += labelW + GUTTER;
    }
  });

  // Return final Y position (current row Y + remaining row height if incomplete row)
  return pageY + rowMaxH;
}

// ── PDF generation ─────────────────────────────────────────────────────────

/**
 * Generates a print-ready A4 PDF containing:
 *   1. All title  labels (30mm × 8-12mm) for the selected specimens
 *   2. All details labels (15mm × 15-18mm) for the selected specimens
 *
 * Text wraps within each label using jsPDF's maxWidth support.
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
  const titleEndY = layoutLabels(doc, specimens, drawTitleLabel, TL_W, TL_H_BASE, TL_COLS);

  // ── Details labels (start after title labels with some spacing) ───────────
  const detailsStartY = titleEndY + 10; // 10mm gap between sections
  
  // Check if we need a new page for details labels
  if (detailsStartY + DL_H_BASE > PAGE_H - MARGIN_V) {
    doc.addPage();
    layoutLabels(doc, specimens, drawDetailsLabel, DL_W, DL_H_BASE, DL_COLS);
  } else {
    layoutLabels(doc, specimens, drawDetailsLabel, DL_W, DL_H_BASE, DL_COLS, detailsStartY);
  }

  // ── Save (manual blob download for Firefox compatibility) ──────────────────
  const today    = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const filename = `labels-${today}.pdf`;
  const blob     = doc.output('blob');
  const url      = URL.createObjectURL(blob);
  const a        = document.createElement('a');
  a.href    = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 500);
}

// ── Preview helper ─────────────────────────────────────────────────────────

/**
 * Returns a human-readable description of how many labels will be generated
 * and approximately how many pages they will span.
 *
 * Example: "12 title labels + 12 details labels across ~2 pages"
 *
 * Since labels now have variable heights (text wrapping can grow labels),
 * the page count is an estimate based on ~120 labels per page.
 *
 * @param {object[]} specimens
 * @returns {string}
 */
export function generatePreview(specimens) {
  if (!specimens || specimens.length === 0) {
    return '0 title labels + 0 details labels across 0 pages';
  }

  const n = specimens.length;

  // Estimate: with wrapping, ~120 labels fit per page for each label type
  const titlePages   = Math.ceil(n / 120);
  const detailsPages = Math.ceil(n / 120);
  const totalPages   = titlePages + detailsPages;

  return `${n} title label${n === 1 ? '' : 's'} + ${n} details label${n === 1 ? '' : 's'} across ~${totalPages} page${totalPages === 1 ? '' : 's'}`;
}
