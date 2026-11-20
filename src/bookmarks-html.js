// bookmarks.html (the Netscape bookmark file every browser reads and writes): building one
// from the bookmark tree and reading one back. No Electron or app state, so it can be tested
// on its own; reading needs a DOMParser (the window's, or any standards-compliant one).

const escapeHtml = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const seconds = (time) => Math.round((time || Date.now()) / 1000);

function toNetscape(root) {
  const lines = [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<!-- This is an automatically generated file.',
    '     It will be read and overwritten.',
    '     DO NOT EDIT! -->',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Bookmarks</TITLE>',
    '<H1>Bookmarks</H1>',
  ];
  const dl = (folder, indent) => {
    lines.push(`${indent}<DL><p>`);
    for (const node of folder.children) {
      if (node.type === 'folder') {
        lines.push(`${indent}    <DT><H3 ADD_DATE="${seconds(node.added)}">${escapeHtml(node.title)}</H3>`);
        dl(node, indent + '    ');
      } else {
        lines.push(`${indent}    <DT><A HREF="${escapeHtml(node.url)}" ADD_DATE="${seconds(node.added)}">${escapeHtml(node.title)}</A>`);
      }
    }
    lines.push(`${indent}</DL><p>`);
  };
  dl(root, '');
  return lines.join('\n') + '\n';
}

// Parsed with DOMParser: an inert document (no scripts run, nothing loads)
// newFolder/newBookmark come from src/bookmarks.js, so parsed nodes get the usual ids and favicons
function fromNetscape(html, { newFolder, newBookmark }) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script, style').forEach((n) => n.remove()); // their text isn't a title
  let count = 0;
  // A folder's <DL> is inside its <DT>, right after it, or (Firefox, with a description)
  // inside the <DD> that follows it
  const folderList = (dt) => {
    const own = dt.querySelector(':scope > dl');
    if (own) return own;
    for (let next = dt.nextElementSibling; next && next.tagName !== 'DT'; next = next.nextElementSibling) {
      if (next.tagName === 'DL') return next;
      const nested = next.tagName === 'DD' && next.querySelector(':scope > dl');
      if (nested) return nested;
    }
    return null;
  };
  const readList = (dl) => {
    const out = [];
    // <DT>s sit directly in the <DL>, or inside the stray <p>s the format is full of
    const items = [...dl.children].flatMap((c) => (c.tagName === 'P' ? [...c.children] : [c])).filter((c) => c.tagName === 'DT');
    for (const dt of items) {
      const h3 = dt.querySelector(':scope > h3');
      const a = dt.querySelector(':scope > a');
      if (h3) {
        const folder = newFolder(h3.textContent.trim() || 'Folder');
        folder.open = false;
        const added = Number(h3.getAttribute('add_date'));
        if (added) folder.added = added * 1000;
        folder.children = readList(folderList(dt) || doc.createElement('dl'));
        out.push(folder);
      } else if (a && /^https?:/i.test(a.getAttribute('href') || '')) {
        const added = Number(a.getAttribute('add_date'));
        out.push(newBookmark({ title: a.textContent.trim(), url: a.getAttribute('href'), added: added ? added * 1000 : null }));
        count++;
      }
    }
    return out;
  };
  const top = doc.querySelector('dl');
  return { children: top ? readList(top) : [], count };
}

module.exports = { escapeHtml, toNetscape, fromNetscape };
