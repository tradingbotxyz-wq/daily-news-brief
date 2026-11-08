const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-'));
process.env.DATA_DIR = dir;
const fakeTurso = process.env.TEST_BACKEND === 'turso' ? require('./fake-turso') : null;
process.env.INGEST_API_KEY = 'test-ingest-key-123';
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'admin-pass-123';
const { server, init } = require('../server');
const md = require('../lib/markdown');
const webpush = require('../lib/webpush');

let base;
before(async () => {
  if (fakeTurso) { const url = await fakeTurso.start('test-token'); process.env.TURSO_DATABASE_URL = url; process.env.TURSO_AUTH_TOKEN = 'test-token'; }
  await init(); await new Promise((r) => server.listen(0, r)); base = `http://127.0.0.1:${server.address().port}`; });
after(() => { server.close(); if (fakeTurso) fakeTurso.stop(); fs.rmSync(dir, { recursive: true, force: true }); });

test('uses the expected database backend', async () => {
  const r = await fetch(base + '/api/health').then((x) => x.json());
  assert.equal(r.db, fakeTurso ? 'Turso' : 'local file');
});

function client() {
  let cookie = '';
  return async (p, opts = {}) => {
    const res = await fetch(base + p, {
      method: opts.method || 'GET',
      headers: { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(opts.headers || {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: res.status, data: await res.json().catch(() => null) };
  };
}

test('free reader sees premium sections locked; premium unlocks them', async () => {
  const c = client();
  let r = await c('/api/briefs/latest');
  assert.equal(r.status, 200);
  const locked = r.data.brief.sections.filter((s) => s.locked);
  assert.ok(locked.length >= 1, 'markets sections should be locked for anonymous readers');
  assert.ok(locked.every((s) => !s.html), 'locked sections must not leak HTML');

  r = await c('/api/auth/register', { method: 'POST', body: { name: 'Asha', email: 'asha@test.local', password: 'password1' } });
  assert.equal(r.status, 200); assert.equal(r.data.user.tier, 'free');
  r = await c('/api/billing/order', { method: 'POST' });
  assert.equal(r.data.mode, 'demo'); assert.equal(r.data.user.tier, 'premium');
  r = await c('/api/briefs/latest');
  assert.ok(r.data.brief.sections.every((s) => !s.locked));
});

test('auth validation and wrong password', async () => {
  const c = client();
  assert.equal((await c('/api/auth/register', { method: 'POST', body: { email: 'bad', password: 'password1' } })).status, 400);
  assert.equal((await c('/api/auth/register', { method: 'POST', body: { email: 'x@y.co', password: 'short' } })).status, 400);
  assert.equal((await c('/api/auth/login', { method: 'POST', body: { email: 'admin@test.local', password: 'nope' } })).status, 401);
});

test('ingest creates a draft that only appears after admin publishes', async () => {
  const c = client();
  const bad = await c('/api/ingest', { method: 'POST', headers: { Authorization: 'Bearer wrong' }, body: { markdown: '## A\nx' } });
  assert.equal(bad.status, 401);
  const r = await c('/api/ingest', {
    method: 'POST', headers: { Authorization: 'Bearer test-ingest-key-123' },
    body: { date: '2026-11-08', markdown: '# News brief — 8 Nov\n\n## Local\n- Item one\n\n## Markets\n| A | B |\n|---|---|\n| 1 | 2 |' },
  });
  assert.equal(r.status, 200); assert.equal(r.data.status, 'draft');
  const id = r.data.id;
  assert.equal((await c(`/api/briefs/${id}`)).status, 404, 'drafts are hidden from readers');

  const u = client();
  await u('/api/auth/register', { method: 'POST', body: { email: 'reader@test.local', password: 'password1' } });
  assert.equal((await u(`/api/admin/briefs/${id}`)).status, 403, 'subscribers cannot use admin API');

  const a = client();
  assert.equal((await a('/api/auth/login', { method: 'POST', body: { email: 'admin@test.local', password: 'admin-pass-123' } })).status, 200);
  const ed = await a(`/api/admin/briefs/${id}`);
  assert.equal(ed.data.brief.title, 'News brief — 8 Nov');
  assert.deepEqual(ed.data.brief.sections.map((s) => [s.heading, s.premium]), [['Local', false], ['Markets', true]]);
  const pub = await a(`/api/admin/briefs/${id}/publish`, { method: 'POST', body: { notify: true } });
  assert.equal(pub.status, 200); assert.equal(pub.data.push.total, 0);
  const latest = await c('/api/briefs/latest');
  assert.equal(latest.data.brief.id, id);
  assert.equal(latest.data.brief.sections[1].locked, true);
});

test('cross-origin POSTs are refused (CSRF guard)', async () => {
  const c = client();
  const r = await c('/api/auth/login', { method: 'POST', headers: { Origin: 'https://evil.example' }, body: { email: 'a@b.c', password: 'x' } });
  assert.equal(r.status, 403);
});

test('static file path traversal is blocked', async () => {
  const res = await fetch(base + '/..%2fserver.js');
  assert.equal(res.status, 404);
  assert.equal((await fetch(base + '/manifest.webmanifest')).status, 200);
});

test('markdown renderer escapes HTML and only links http(s)', () => {
  const html = md.render('<script>alert(1)</script>\n\n[x](javascript:alert(1)) [ok](https://a.com)\n\n- **b** *i*');
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('href="javascript'));
  assert.ok(html.includes('href="https://a.com"'));
  assert.ok(html.includes('<strong>b</strong>') && html.includes('<em>i</em>'));
});

test('web push payload decrypts per RFC 8291 (simulated browser)', () => {
  const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
  const auth = crypto.randomBytes(16);
  const keys = { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') };
  const body = webpush.encrypt('{"title":"Hi"}', keys);
  // Browser side
  const salt = body.subarray(0, 16); const idlen = body[20]; const asPub = body.subarray(21, 21 + idlen); const ct = body.subarray(21 + idlen);
  assert.equal(body.readUInt32BE(16), 4096);
  const shared = ua.computeSecret(asPub);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, auth, Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPub]), 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce); d.setAuthTag(ct.subarray(-16));
  const pt = Buffer.concat([d.update(ct.subarray(0, -16)), d.final()]);
  assert.equal(pt.at(-1), 2); assert.equal(pt.subarray(0, -1).toString(), '{"title":"Hi"}');
});

test('VAPID JWT verifies with the public key', () => {
  const kp = webpush.generateKeys();
  const vapid = webpush.fromEnv(kp.publicKey, kp.privateKey);
  const h = webpush.vapidHeader('https://fcm.googleapis.com/fcm/send/abc', vapid, 'mailto:x@y.z');
  const [, t, k] = h.match(/^vapid t=([^,]+), k=(.+)$/);
  const [hd, pl, sig] = t.split('.');
  assert.equal(JSON.parse(Buffer.from(pl, 'base64url')).aud, 'https://fcm.googleapis.com');
  const pub = Buffer.from(k, 'base64url');
  const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(`${hd}.${pl}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')));
});

test('admin can delete a brief; settings persist secrets', async () => {
  const a = client();
  await a('/api/auth/login', { method: 'POST', body: { email: 'admin@test.local', password: 'admin-pass-123' } });
  const { data } = await a('/api/admin/briefs', { method: 'POST', body: { markdown: '## One\n- a' } });
  assert.equal((await a(`/api/admin/briefs/${data.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await a(`/api/admin/briefs/${data.id}`)).status, 404);
  const cfg = (await a('/api/config')).data;
  assert.match(cfg.vapidPublicKey, /^[A-Za-z0-9_-]{87}$/);
});
