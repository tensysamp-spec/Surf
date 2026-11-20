// Writes the Annotate PDF view's marks into a new PDF with pdf-lib. Marks arrive already in
// each page's PDF coordinates (see toPdfMarks in src/pdf-annotate.js), so this file only draws.

const { PDFDocument, StandardFonts, LineCapStyle, LineJoinStyle, BlendMode, rgb, degrees, setLineJoin } = require('pdf-lib');

function color(hex) {
  const n = parseInt(String(hex).replace('#', ''), 16) || 0;
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

// The standard fonts only know WinAnsi; anything else would make pdf-lib throw
function encodable(font, text) {
  const known = new Set(font.getCharacterSet());
  return [...text].map((ch) => (known.has(ch.codePointAt(0)) ? ch : '?')).join('');
}

function dataUrlBytes(dataUrl) {
  return Uint8Array.from(atob(dataUrl.split(',')[1] || ''), (c) => c.charCodeAt(0));
}

// marks: [{ page, type, ... }] — see toPdfMarks for each type's fields
async function exportPdf(bytes, marks) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const pages = doc.getPages();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const images = new Map(); // the same signature is embedded once

  for (const mark of marks) {
    const page = pages[mark.page];
    if (!page) continue;
    if (mark.type === 'highlight') {
      for (const r of mark.rects) {
        page.drawRectangle({ x: r.x, y: r.y, width: r.w, height: r.h, color: color(mark.color), opacity: 0.4, blendMode: BlendMode.Multiply });
      }
    } else if (mark.type === 'ink') {
      // One path per stroke; pdf-lib's SVG paths run y-down from (x, y), hence the minus
      const d = mark.points.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)} ${(-y).toFixed(2)}`).join(' ');
      const single = mark.points.length === 1 ? ` L${(mark.points[0][0] + 0.01).toFixed(2)} ${(-mark.points[0][1]).toFixed(2)}` : '';
      page.pushOperators(setLineJoin(LineJoinStyle.Round));
      page.drawSvgPath(d + single, { x: 0, y: 0, borderColor: color(mark.color), borderWidth: mark.width, borderLineCap: LineCapStyle.Round });
    } else if (mark.type === 'text') {
      for (const line of mark.lines) {
        if (!line.text.trim()) continue;
        page.drawText(encodable(font, line.text), { x: line.x, y: line.y, size: mark.size, font, color: color(mark.color), rotate: degrees(mark.rotate) });
      }
    } else if (mark.type === 'image') {
      let image = images.get(mark.src);
      if (!image) {
        image = await doc.embedPng(dataUrlBytes(mark.src));
        images.set(mark.src, image);
      }
      page.drawImage(image, { x: mark.x, y: mark.y, width: mark.w, height: mark.h, rotate: degrees(mark.rotate) });
    }
  }
  return doc.save();
}

module.exports = { exportPdf };
