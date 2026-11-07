// Minimal, safe Markdown -> HTML renderer (no dependencies).
// Supports: ###/#### headings, paragraphs, - / * / 1. lists, tables, **bold**, *italic*,
// `code`, [links](https://...), > quotes, --- rules. All input is HTML-escaped first.

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function inline(text) {
  let s = esc(text);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_, t, u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  return s;
}

function render(md) {
  const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;
  const isTableRow = (l) => /^\s*\|.*\|\s*$/.test(l);
  const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    let m;
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) {
      const level = Math.min(6, m[1].length + 1); // # -> h2 ... keep page h1 for the title
      out.push(`<h${level}>${inline(m[2])}</h${level}>`); i++; continue;
    }
    if (/^\s*(---|\*\*\*)\s*$/.test(line)) { out.push('<hr>'); i++; continue; }

    if (isTableRow(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const head = cells(line); i += 2;
      const rows = [];
      while (i < lines.length && isTableRow(lines[i])) { rows.push(cells(lines[i])); i++; }
      out.push('<div class="table-wrap"><table><thead><tr>' +
        head.map((h) => `<th>${inline(h)}</th>`).join('') + '</tr></thead><tbody>' +
        rows.map((r) => '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') +
        '</tbody></table></div>');
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, '')); i++;
      }
      out.push('<ul>' + items.map((t) => `<li>${inline(t)}</li>`).join('') + '</ul>');
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, '')); i++;
      }
      out.push('<ol>' + items.map((t) => `<li>${inline(t)}</li>`).join('') + '</ol>');
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      const q = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { q.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      out.push(`<blockquote>${inline(q.join(' '))}</blockquote>`);
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() &&
      !/^(#{1,4})\s|^\s*[-*]\s+|^\s*\d+[.)]\s+|^\s*>|^\s*(---|\*\*\*)\s*$/.test(lines[i]) &&
      !isTableRow(lines[i])) { para.push(lines[i].trim()); i++; }
    out.push(`<p>${inline(para.join(' '))}</p>`);
  }
  return out.join('\n');
}

// Plain-text teaser (first ~160 chars) for locked premium sections and notifications.
function teaser(md, n = 160) {
  const t = String(md || '')
    .replace(/\|/g, ' ').replace(/[#*`>_-]+/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n).replace(/\s\S*$/, '') + '…' : t;
}

// Split a whole brief written in Markdown into sections at each "## " heading.
function splitSections(markdown, premiumPattern) {
  const re = premiumPattern instanceof RegExp ? premiumPattern : new RegExp(premiumPattern || 'market|stock', 'i');
  const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
  const sections = [];
  let title = null;
  let cur = null;
  for (const line of lines) {
    const h1 = line.match(/^#\s+(.*)$/);
    const h2 = line.match(/^##\s+(.*)$/);
    if (h1 && !title && !cur) { title = h1[1].trim(); continue; }
    if (h2) {
      cur = { heading: h2[1].trim(), body_md: '', premium: re.test(h2[1]) };
      sections.push(cur);
      continue;
    }
    if (!cur) { if (!line.trim()) continue; cur = { heading: 'Overview', body_md: '', premium: false }; sections.push(cur); }
    cur.body_md += line + '\n';
  }
  sections.forEach((s) => { s.body_md = s.body_md.trim(); });
  return { title, sections: sections.filter((s) => s.body_md || s.heading) };
}

module.exports = { render, teaser, splitSections, esc };
