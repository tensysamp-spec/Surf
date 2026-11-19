// Minimal RFC 4180 CSV reading and writing, for password import/export.
// Handles quoted fields with commas, doubled quotes and line breaks, CRLF, and a BOM.

function parse(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  // Blank lines aren't records
  return rows.filter((r) => r.length > 1 || r[0] !== '');
}

// Rows of objects keyed by the (lower-cased, trimmed) header names
function parseRecords(text) {
  const [header, ...rows] = parse(text);
  if (!header) return [];
  const keys = header.map((h) => h.trim().toLowerCase());
  return rows.map((r) => Object.fromEntries(keys.map((k, i) => [k, r[i] ?? ''])));
}

const quote = (value) => {
  const s = String(value ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function stringify(rows) {
  return rows.map((r) => r.map(quote).join(',')).join('\n') + '\n';
}

module.exports = { parse, parseRecords, stringify };
