// Dependency-free Web Push sender: VAPID (RFC 8292) + aes128gcm payload encryption (RFC 8291).
const crypto = require('crypto');

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(s, 'base64url');

// Push (VAPID) keys: from env vars if set, otherwise generated once and kept in the database.
async function loadOrCreateVapid(db) {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return fromEnv(process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
  }
  const saved = await db.getSetting('vapid');
  if (saved) { const j = JSON.parse(saved); return fromEnv(j.publicKey, j.privateKey); }
  const keys = generateKeys();
  await db.setSetting('vapid', JSON.stringify(keys));
  return fromEnv(keys.publicKey, keys.privateKey);
}

function generateKeys() {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  const pub = Buffer.concat([Buffer.from([4]), fromB64u(jwk.x), fromB64u(jwk.y)]);
  return { publicKey: b64u(pub), privateKey: jwk.d };
}

function fromEnv(publicKeyB64u, privateKeyB64u) {
  const pub = fromB64u(publicKeyB64u);
  const key = crypto.createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', d: privateKeyB64u, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) },
    format: 'jwk',
  });
  return { publicKey: publicKeyB64u, keyObject: key };
}

function vapidHeader(endpoint, vapid, subject) {
  const aud = new URL(endpoint).origin;
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const payload = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject }));
  const unsigned = `${header}.${payload}`;
  const sig = crypto.sign('sha256', Buffer.from(unsigned), { key: vapid.keyObject, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${unsigned}.${b64u(sig)}, k=${vapid.publicKey}`;
}

// Encrypt a payload for one subscription (keys.p256dh, keys.auth). Optional fixed salt/keys for tests.
function encrypt(payload, keys, opts = {}) {
  const uaPublic = fromB64u(keys.p256dh);
  const authSecret = fromB64u(keys.auth);
  const ecdh = crypto.createECDH('prime256v1');
  if (opts.asPrivate) ecdh.setPrivateKey(opts.asPrivate); else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const salt = opts.salt || crypto.randomBytes(16);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

  const plaintext = Buffer.concat([Buffer.from(payload), Buffer.from([2])]);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);

  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, ct]);
}

async function send(subscription, payload, vapid, subject) {
  const body = encrypt(typeof payload === 'string' ? payload : JSON.stringify(payload), subscription.keys);
  const res = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      Authorization: vapidHeader(subscription.endpoint, vapid, subject),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '86400',
      Urgency: 'normal',
    },
    body,
  });
  return { status: res.status, ok: res.ok, gone: res.status === 404 || res.status === 410 };
}

module.exports = { loadOrCreateVapid, generateKeys, fromEnv, encrypt, send, vapidHeader };
