// Daily News Brief — portal + PWA backend. Zero npm dependencies (Node >= 22.13).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { open } = require('./lib/db');
const md = require('./lib/markdown');
const webpush = require('./lib/webpush');

// ---------- config ----------
loadDotEnv(path.join(__dirname, '.env'));
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const INGEST_API_KEY = process.env.INGEST_API_KEY || '';
const PREMIUM_PATTERN = new RegExp(process.env.PREMIUM_SECTIONS || 'market|stock', 'i');
const PREMIUM_PRICE_PAISE = Number(process.env.PREMIUM_PRICE_PAISE || 9900); // ₹99 / month
const PREMIUM_DAYS = Number(process.env.PREMIUM_DAYS || 30);
const RZP_KEY = process.env.RAZORPAY_KEY_ID || '';
const RZP_SECRET = process.env.RAZORPAY_KEY_SECRET || '';
const SECURE_COOKIES = process.env.SECURE_COOKIES === 'true';
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';
const PUBLIC_DIR = path.join(__dirname, 'public');

// Set by init(): database, session secret, push keys.
let db, SECRET, vapid;

// PNG app icons are drawn in code (lib/icons.js) and written out on first start.
function ensureIcons() {
  try {
    const { ICONS, draw } = require('./lib/icons');
    const dir = path.join(PUBLIC_DIR, 'icons');
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, [size, maskable]] of Object.entries(ICONS)) {
      const f = path.join(dir, name);
      if (!fs.existsSync(f)) fs.writeFileSync(f, draw(size, maskable));
    }
  } catch (e) { console.warn('Could not write app icons:', e.message); }
}

// ---------- helpers ----------
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)(\s+#.*)?\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function checkPassword(pw, stored) {
  const [, saltHex, hashHex] = String(stored).split('$');
  if (!saltHex || !hashHex) return false;
  const hash = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64);
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}
function signToken(obj) {
  const body = Buffer.from(JSON.stringify(obj)).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function verifyToken(tok) {
  const [body, sig] = String(tok || '').split('.');
  if (!body || !sig) return null;
  const good = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if (good.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(good), Buffer.from(sig))) return null;
  const obj = JSON.parse(Buffer.from(body, 'base64url').toString());
  return obj.exp > Date.now() ? obj : null;
}
function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function setSession(res, userId) {
  const tok = signToken({ uid: userId, exp: Date.now() + 30 * 864e5 });
  res.setHeader('Set-Cookie', `sid=${tok}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${30 * 86400}${SECURE_COOKIES ? '; Secure' : ''}`);
}
async function currentUser(req) {
  if (req._user !== undefined) return req._user;
  const t = verifyToken(cookies(req).sid);
  let u = t ? await db.get('SELECT * FROM users WHERE id = ?', [t.uid]) : null;
  if (u && u.tier === 'premium' && u.premium_until && new Date(u.premium_until) < new Date()) {
    await db.run("UPDATE users SET tier = 'free' WHERE id = ?", [u.id]);
    u = { ...u, tier: 'free' };
  }
  req._user = u || null;
  return req._user;
}
const userById = (id) => db.get('SELECT * FROM users WHERE id = ?', [id]);
const publicUser = (u) => u && ({ id: u.id, email: u.email, name: u.name, role: u.role, tier: u.tier, premium_until: u.premium_until });

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
function send(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}
async function readJson(req, limit = 1_000_000) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > limit) throw new HttpError(413, 'Body too large'); chunks.push(c); }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new HttpError(400, 'Invalid JSON'); }
}
const requireUser = async (req) => { const u = await currentUser(req); if (!u) throw new HttpError(401, 'Please log in'); return u; };
const requireAdmin = async (req) => { const u = await requireUser(req); if (u.role !== 'admin') throw new HttpError(403, 'Admins only'); return u; };
const isPremium = (u) => !!u && (u.tier === 'premium' || u.role === 'admin');

// Simple in-memory rate limit for auth endpoints.
const hits = new Map();
function rateLimit(req, key, max = 20, windowMs = 15 * 60_000) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
  const k = `${key}:${ip}`; const now = Date.now();
  const arr = (hits.get(k) || []).filter((t) => now - t < windowMs);
  arr.push(now); hits.set(k, arr);
  if (arr.length > max) throw new HttpError(429, 'Too many attempts, try again later');
}

// ---------- brief data ----------
const getSections = (briefId) => db.all('SELECT * FROM sections WHERE brief_id = ? ORDER BY position', [briefId]);
async function briefForReader(brief, user) {
  const premium = isPremium(user);
  return {
    id: brief.id, title: brief.title, date: brief.brief_date, published_at: brief.published_at,
    sections: (await getSections(brief.id)).map((s) => (s.premium && !premium
      ? { heading: s.heading, premium: true, locked: true, teaser: md.teaser(s.body_md.split('\n').filter((l) => !/^\s*\|/.test(l)).join('\n'), 70) }
      : { heading: s.heading, premium: !!s.premium, locked: false, html: md.render(s.body_md) })),
  };
}
async function saveSections(briefId, sections) {
  await db.run('DELETE FROM sections WHERE brief_id = ?', [briefId]);
  for (const [i, s] of sections.entries()) {
    await db.run('INSERT INTO sections (brief_id, position, heading, body_md, premium) VALUES (?, ?, ?, ?, ?)',
      [briefId, i, String(s.heading || 'Untitled').slice(0, 200), String(s.body_md || ''), s.premium ? 1 : 0]);
  }
}
async function createBrief({ title, date, markdown, sections, source }) {
  let secs = sections;
  let t = title;
  if (!secs && markdown) { const split = md.splitSections(markdown, PREMIUM_PATTERN); secs = split.sections; t = t || split.title; }
  if (!Array.isArray(secs) || !secs.length) throw new HttpError(400, 'Provide "markdown" or a non-empty "sections" array');
  const d = /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? date : new Date().toISOString().slice(0, 10);
  const r = await db.run('INSERT INTO briefs (title, brief_date, source) VALUES (?, ?, ?)', [String(t || `News brief — ${d}`).slice(0, 200), d, source]);
  const id = r.lastInsertRowid;
  await saveSections(id, secs.map((s) => ({ ...s, premium: s.premium ?? PREMIUM_PATTERN.test(s.heading || '') })));
  return id;
}

async function notifyAll(brief) {
  const subs = await db.all('SELECT * FROM push_subscriptions');
  const heads = (await getSections(brief.id)).map((s) => s.heading).join(' · ');
  const payload = JSON.stringify({ title: brief.title, body: md.teaser(heads, 120), url: `/#/brief/${brief.id}` });
  let sent = 0, removed = 0, failed = 0;
  await Promise.all(subs.map(async (s) => {
    try {
      const r = await webpush.send({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, vapid, VAPID_SUBJECT);
      if (r.ok) sent++; else if (r.gone) { await db.run('DELETE FROM push_subscriptions WHERE id = ?', [s.id]); removed++; } else failed++;
    } catch { failed++; }
  }));
  return { total: subs.length, sent, removed, failed };
}

// ---------- routes ----------
const routes = [];
const route = (method, pattern, handler) => routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), handler });

route('GET', '/api/health', () => ({ ok: true, db: db.kind }));
route('GET', '/api/config', () => ({
  premiumPricePaise: PREMIUM_PRICE_PAISE, premiumDays: PREMIUM_DAYS,
  payments: RZP_KEY ? 'razorpay' : 'demo', vapidPublicKey: vapid.publicKey,
}));

// Auth
route('POST', '/api/auth/register', async (req, res) => {
  rateLimit(req, 'register', 10);
  const { name = '', email = '', password = '' } = await readJson(req);
  const e = String(email).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new HttpError(400, 'Enter a valid email');
  if (String(password).length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  if (await db.get('SELECT 1 AS x FROM users WHERE email = ?', [e])) throw new HttpError(409, 'That email is already registered');
  const r = await db.run('INSERT INTO users (email, name, password_hash) VALUES (?, ?, ?)', [e, String(name).trim().slice(0, 80), hashPassword(String(password))]);
  setSession(res, r.lastInsertRowid);
  return { user: publicUser(await userById(r.lastInsertRowid)) };
});
route('POST', '/api/auth/login', async (req, res) => {
  rateLimit(req, 'login', 20);
  const { email = '', password = '' } = await readJson(req);
  const u = await db.get('SELECT * FROM users WHERE email = ?', [String(email).trim().toLowerCase()]);
  if (!u || !checkPassword(String(password), u.password_hash)) throw new HttpError(401, 'Wrong email or password');
  setSession(res, u.id);
  return { user: publicUser(u) };
});
route('POST', '/api/auth/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0');
  return { ok: true };
});
route('GET', '/api/me', async (req) => ({ user: publicUser(await currentUser(req)) }));

// Reader
route('GET', '/api/briefs', async () => ({
  briefs: await db.all("SELECT id, title, brief_date AS date, published_at FROM briefs WHERE status = 'published' ORDER BY brief_date DESC, published_at DESC LIMIT 60"),
}));
route('GET', '/api/briefs/latest', async (req) => {
  const b = await db.get("SELECT * FROM briefs WHERE status = 'published' ORDER BY brief_date DESC, published_at DESC LIMIT 1");
  return { brief: b ? await briefForReader(b, await currentUser(req)) : null };
});
route('GET', '/api/briefs/:id', async (req, res, p) => {
  const b = await db.get("SELECT * FROM briefs WHERE id = ? AND status = 'published'", [Number(p.id)]);
  if (!b) throw new HttpError(404, 'Brief not found');
  return { brief: await briefForReader(b, await currentUser(req)) };
});

// Push subscriptions
route('POST', '/api/push/subscribe', async (req) => {
  const u = await requireUser(req);
  const { subscription: s } = await readJson(req);
  if (!s?.endpoint || !s?.keys?.p256dh || !s?.keys?.auth || !/^https:\/\//.test(s.endpoint)) throw new HttpError(400, 'Invalid subscription');
  await db.run(`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)
                ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`,
  [u.id, s.endpoint, s.keys.p256dh, s.keys.auth]);
  return { ok: true };
});
route('POST', '/api/push/unsubscribe', async (req) => {
  const u = await requireUser(req);
  const { endpoint } = await readJson(req);
  await db.run('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?', [String(endpoint || ''), u.id]);
  return { ok: true };
});

// Billing (Razorpay when keys are set, otherwise a clearly-labelled demo upgrade)
async function grantPremium(userId) {
  const until = new Date(Date.now() + PREMIUM_DAYS * 864e5).toISOString();
  await db.run("UPDATE users SET tier = 'premium', premium_until = ? WHERE id = ?", [until, userId]);
}
route('POST', '/api/billing/order', async (req) => {
  const u = await requireUser(req);
  if (!RZP_KEY) {
    await grantPremium(u.id);
    await db.run("INSERT INTO payments (user_id, provider, amount_paise, status) VALUES (?, 'demo', 0, 'demo-granted')", [u.id]);
    return { mode: 'demo', user: publicUser(await userById(u.id)) };
  }
  const r = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + Buffer.from(`${RZP_KEY}:${RZP_SECRET}`).toString('base64') },
    body: JSON.stringify({ amount: PREMIUM_PRICE_PAISE, currency: 'INR', receipt: `u${u.id}-${Date.now()}`, notes: { user_id: String(u.id) } }),
  });
  const order = await r.json();
  if (!r.ok) throw new HttpError(502, order?.error?.description || 'Payment provider error');
  await db.run("INSERT INTO payments (user_id, provider, order_id, amount_paise, status) VALUES (?, 'razorpay', ?, ?, 'created')", [u.id, order.id, PREMIUM_PRICE_PAISE]);
  return { mode: 'razorpay', keyId: RZP_KEY, order: { id: order.id, amount: order.amount, currency: order.currency }, user: publicUser(u) };
});
route('POST', '/api/billing/verify', async (req) => {
  const u = await requireUser(req);
  const { razorpay_order_id: oid, razorpay_payment_id: pid, razorpay_signature: sig } = await readJson(req);
  const row = await db.get("SELECT * FROM payments WHERE order_id = ? AND user_id = ? AND provider = 'razorpay'", [String(oid || ''), u.id]);
  if (!row || !RZP_SECRET) throw new HttpError(400, 'Unknown order');
  const expected = crypto.createHmac('sha256', RZP_SECRET).update(`${oid}|${pid}`).digest('hex');
  if (typeof sig !== 'string' || sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    throw new HttpError(400, 'Payment signature check failed');
  }
  await db.run("UPDATE payments SET payment_id = ?, status = 'paid' WHERE id = ?", [String(pid), row.id]);
  await grantPremium(u.id);
  return { ok: true, user: publicUser(await userById(u.id)) };
});
route('POST', '/api/billing/cancel', async (req) => {
  const u = await requireUser(req);
  if (RZP_KEY) throw new HttpError(400, 'Premium stays active until the end of the paid period');
  await db.run("UPDATE users SET tier = 'free', premium_until = NULL WHERE id = ?", [u.id]);
  return { user: publicUser(await userById(u.id)) };
});

// Ingest (used by the Claude scheduled task) — creates a DRAFT for admin review.
route('POST', '/api/ingest', async (req) => {
  const auth = String(req.headers.authorization || '');
  const tok = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!INGEST_API_KEY || tok.length !== INGEST_API_KEY.length || !crypto.timingSafeEqual(Buffer.from(tok), Buffer.from(INGEST_API_KEY))) {
    throw new HttpError(401, 'Invalid ingest key');
  }
  const body = await readJson(req);
  const id = await createBrief({ ...body, source: 'claude' });
  return { id, status: 'draft', review_url: `${PUBLIC_URL}/admin.html#${id}` };
});

// Admin
route('GET', '/api/admin/stats', async (req) => {
  await requireAdmin(req);
  const n = async (sql) => (await db.get(sql)).n;
  return {
    users: await n("SELECT COUNT(*) AS n FROM users WHERE role = 'subscriber'"),
    premium: await n("SELECT COUNT(*) AS n FROM users WHERE tier = 'premium' AND role = 'subscriber'"),
    pushDevices: await n('SELECT COUNT(*) AS n FROM push_subscriptions'),
    drafts: await n("SELECT COUNT(*) AS n FROM briefs WHERE status = 'draft'"),
    published: await n("SELECT COUNT(*) AS n FROM briefs WHERE status = 'published'"),
  };
});
route('GET', '/api/admin/briefs', async (req) => {
  await requireAdmin(req);
  return { briefs: await db.all("SELECT id, title, brief_date AS date, status, source, created_at, published_at FROM briefs ORDER BY (status = 'draft') DESC, brief_date DESC, id DESC LIMIT 100") };
});
route('GET', '/api/admin/briefs/:id', async (req, res, p) => {
  await requireAdmin(req);
  const b = await db.get('SELECT * FROM briefs WHERE id = ?', [Number(p.id)]);
  if (!b) throw new HttpError(404, 'Not found');
  const sections = (await getSections(b.id)).map((s) => ({ heading: s.heading, body_md: s.body_md, premium: !!s.premium, html: md.render(s.body_md) }));
  return { brief: { id: b.id, title: b.title, date: b.brief_date, status: b.status, source: b.source, sections } };
});
route('POST', '/api/admin/briefs', async (req) => {
  await requireAdmin(req);
  const body = await readJson(req);
  return { id: await createBrief({ ...body, source: 'manual' }) };
});
route('PUT', '/api/admin/briefs/:id', async (req, res, p) => {
  await requireAdmin(req);
  const b = await db.get('SELECT * FROM briefs WHERE id = ?', [Number(p.id)]);
  if (!b) throw new HttpError(404, 'Not found');
  const { title, date, sections } = await readJson(req);
  if (!Array.isArray(sections) || !sections.length) throw new HttpError(400, 'At least one section is required');
  await db.run('UPDATE briefs SET title = ?, brief_date = ? WHERE id = ?', [String(title || b.title).slice(0, 200), /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? date : b.brief_date, b.id]);
  await saveSections(b.id, sections);
  return { ok: true };
});
route('POST', '/api/admin/briefs/:id/publish', async (req, res, p) => {
  await requireAdmin(req);
  const b = await db.get('SELECT * FROM briefs WHERE id = ?', [Number(p.id)]);
  if (!b) throw new HttpError(404, 'Not found');
  await db.run("UPDATE briefs SET status = 'published', published_at = datetime('now') WHERE id = ?", [b.id]);
  const { notify = true } = await readJson(req);
  const push = notify ? await notifyAll(b) : null;
  return { ok: true, push };
});
route('POST', '/api/admin/briefs/:id/unpublish', async (req, res, p) => {
  await requireAdmin(req);
  await db.run("UPDATE briefs SET status = 'draft', published_at = NULL WHERE id = ?", [Number(p.id)]);
  return { ok: true };
});
route('DELETE', '/api/admin/briefs/:id', async (req, res, p) => {
  await requireAdmin(req);
  await db.run('DELETE FROM sections WHERE brief_id = ?', [Number(p.id)]);
  await db.run('DELETE FROM briefs WHERE id = ?', [Number(p.id)]);
  return { ok: true };
});

// ---------- static files ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { rel = '/'; }
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found');
  }
  const ext = path.extname(file);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': ext === '.html' || file.endsWith('sw.js') ? 'no-cache' : 'public, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
  });
  fs.createReadStream(file).pipe(res);
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (!url.pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    return serveStatic(req, res, url.pathname);
  }
  if (!db) return send(res, 503, { error: 'Starting up, try again in a moment' });
  // CSRF guard: state-changing cookie requests must come from our own origin.
  if (req.method !== 'GET' && url.pathname !== '/api/ingest') {
    const origin = req.headers.origin;
    try { if (origin && new URL(origin).host !== req.headers.host) return send(res, 403, { error: 'Bad origin' }); }
    catch { return send(res, 403, { error: 'Bad origin' }); }
  }
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = url.pathname.match(r.re);
    if (!m) continue;
    try {
      const data = await r.handler(req, res, m.groups || {}, url);
      return send(res, 200, data);
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) console.error(err);
      return send(res, status, { error: status === 500 ? 'Server error' : err.message });
    }
  }
  send(res, 404, { error: 'Not found' });
});

// ---------- startup: database, secrets, admin account, sample briefs ----------
async function init() {
  if (db) return;
  ensureIcons();
  if (!process.env.TURSO_DATABASE_URL) fs.mkdirSync(DATA_DIR, { recursive: true });
  const conn = await open(DATA_DIR);

  SECRET = process.env.SESSION_SECRET || (await conn.getSetting('session_secret'));
  if (!SECRET) { SECRET = crypto.randomBytes(32).toString('hex'); await conn.setSetting('session_secret', SECRET); }
  vapid = await webpush.loadOrCreateVapid(conn);

  const adminEmail = (process.env.ADMIN_EMAIL || 'admin@example.com').trim().toLowerCase();
  if (!(await conn.get("SELECT 1 AS x FROM users WHERE role = 'admin'"))) {
    const pw = process.env.ADMIN_PASSWORD || 'changeme123';
    await conn.run("INSERT INTO users (email, name, password_hash, role, tier) VALUES (?, 'Admin', ?, 'admin', 'premium')", [adminEmail, hashPassword(pw)]);
    console.log(`Created admin account ${adminEmail}${process.env.ADMIN_PASSWORD ? '' : ' with default password "changeme123" — set ADMIN_PASSWORD before going live!'}`);
  }
  db = conn;
  if (process.env.SEED_SAMPLE !== 'false' && !(await db.get('SELECT 1 AS x FROM briefs'))) {
    const seedDir = path.join(__dirname, 'seed');
    const pub = await createBrief({ markdown: fs.readFileSync(path.join(seedDir, 'markets-2026-11-07.md'), 'utf8'), date: '2026-11-07', source: 'claude' });
    await db.run("UPDATE briefs SET status = 'published', published_at = datetime('now') WHERE id = ?", [pub]);
    await createBrief({ markdown: fs.readFileSync(path.join(seedDir, 'news-2026-11-07.md'), 'utf8'), date: '2026-11-07', source: 'claude' });
    console.log('Seeded one published sample brief and one draft awaiting review.');
  }
  console.log(`Database: ${db.kind}`);
}

if (require.main === module) {
  init().then(() => {
    server.listen(PORT, () => console.log(`News portal running at ${PUBLIC_URL}  (admin: ${PUBLIC_URL}/admin.html)`));
  }).catch((e) => { console.error('Startup failed:', e.message); process.exit(1); });
}
module.exports = { server, init };
