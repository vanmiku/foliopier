function sniffDelim(text) {
  // Prefer the delimiter that gives the header and data the same width.
  // An ambiguous header (including a header-only file) defaults to comma.
  const sample = text.slice(0, 64 * 1024);
  let best = ',', bestRatio = -1, bestMatches = 0;
  for (const delimiter of [',', ';', '\t', '|']) {
    const { rows, invalidAt } = parseRows(sample, { delimiter, strict: true, rowLimit: 21, partial: sample.length < text.length });
    const [header, ...records] = rows.filter(row => row.length > 1 || row[0] !== '');
    if (!header || header.length < 2) continue;
    const matches = records.filter(row => row.length === header.length).length;
    const ratio = matches ? matches / (records.length + Number(Boolean(invalidAt))) : 0;
    if (ratio > bestRatio || (ratio === bestRatio && matches > bestMatches)) {
      best = delimiter;
      bestRatio = ratio;
      bestMatches = matches;
    }
  }
  return best;
}

export function csvRows(text, { tsv = false, strict = false } = {}) {
  text = text.replace(/^\uFEFF/, '');
  const hint = /^sep=([,;\t|])(?:\r\n|\r|\n)/i.exec(text);
  if (hint) text = text.slice(hint[0].length);
  const delimiter = tsv ? '\t' : hint?.[1] || sniffDelim(text);
  return parseRows(text, { delimiter, strict });
}

function parseRows(text, { delimiter, strict, rowLimit = 5002, partial = false }) {
  const rows = [];
  let row = [], field = '', quoted = false, closed = false, started = false;
  const pushField = () => { row.push(field); field = ''; closed = false; started = false; };
  const malformed = () => ({ rows, invalidAt: rows.length + 1, limit: false });
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') { field += '"'; i++; }
      else { quoted = false; closed = true; }
    } else if (c === delimiter) pushField();
    else if (c === '\r' || c === '\n') {
      pushField();
      rows.push(row);
      row = [];
      if (rows.length >= rowLimit) return { rows, limit: true };
      if (c === '\r' && text[i + 1] === '\n') i++;
    } else if (strict && (closed || (c === '"' && started))) return malformed();
    else if (c === '"' && !field) { quoted = true; started = true; }
    else { field += c; started = true; }
  }
  if (!partial) {
    if (strict && quoted) return malformed();
    if (started || closed || row.length) { pushField(); rows.push(row); }
  }
  return { rows, limit: rows.length > 5001 };
}
