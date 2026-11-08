// Test double for Turso's HTTP API (Hrana v2 pipeline), backed by an in-memory SQLite database.
// Lets the test suite exercise the Turso client code without network access.
const http = require('http');
const { DatabaseSync } = require('node:sqlite');

let srv;
function start(token) {
  const db = new DatabaseSync(':memory:');
  const decode = (v) => (v.type === 'null' ? null : v.type === 'integer' ? Number(v.value) : v.type === 'float' ? Number(v.value) : v.value);
  const encode = (v) => (v === null || v === undefined ? { type: 'null' }
    : typeof v === 'number' || typeof v === 'bigint' ? (Number.isInteger(Number(v)) ? { type: 'integer', value: String(v) } : { type: 'float', value: Number(v) })
    : { type: 'text', value: String(v) });
  srv = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v2/pipeline') { res.writeHead(404); return res.end(); }
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); return res.end('unauthorized'); }
    let body = ''; for await (const c of req) body += c;
    const { requests } = JSON.parse(body);
    const results = requests.map((r) => {
      if (r.type === 'close') return { type: 'ok', response: { type: 'close' } };
      try {
        const stmt = db.prepare(r.stmt.sql);
        const args = (r.stmt.args || []).map(decode);
        if (/^\s*(select|with|pragma)/i.test(r.stmt.sql)) {
          const rows = stmt.all(...args);
          const cols = stmt.columns ? stmt.columns().map((c) => c.name) : Object.keys(rows[0] || {});
          return { type: 'ok', response: { type: 'execute', result: { cols: cols.map((name) => ({ name, decltype: null })), rows: rows.map((row) => cols.map((c) => encode(row[c]))), affected_row_count: 0, last_insert_rowid: null } } };
        }
        const info = stmt.run(...args);
        return { type: 'ok', response: { type: 'execute', result: { cols: [], rows: [], affected_row_count: Number(info.changes), last_insert_rowid: String(info.lastInsertRowid) } } };
      } catch (e) {
        return { type: 'error', error: { message: e.message, code: 'SQLITE_ERROR' } };
      }
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ baton: null, base_url: null, results }));
  });
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok(`http://127.0.0.1:${srv.address().port}`)));
}
const stop = () => srv && srv.close();
module.exports = { start, stop };
