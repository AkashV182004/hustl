// Web Push with nothing but WebCrypto (works in Supabase Edge Functions / Deno and in Node 20+):
// message encryption per RFC 8291 (aes128gcm) and the VAPID signature per RFC 8292.
const enc = new TextEncoder();

export const b64u = {
  encode(bytes) {
    let s = '';
    for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  decode(str) {
    const s = atob(String(str).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(str).length + 3) % 4));
    return Uint8Array.from(s, c => c.charCodeAt(0));
  },
};

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
};

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}

/** Encrypt a push message for one browser subscription (RFC 8291). Returns the request body. */
export async function encryptPayload(plaintext, uaPublic, authSecret, { asKeyPair, salt } = {}) {
  asKeyPair ||= await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  salt ||= crypto.getRandomValues(new Uint8Array(16));
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', asKeyPair.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asKeyPair.privateKey, 256));

  const ikm = await hkdf(authSecret, shared, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const record = concat(plaintext, new Uint8Array([2]));   // one record, so it is also the last (delimiter 0x02)
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, record));

  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, ciphertext);
}

// VAPID keys use the usual web-push format: public = 65-byte uncompressed point, private = 32-byte d (base64url).
function privateJwk(publicKey, privateKey) {
  const pub = b64u.decode(publicKey);
  return { kty: 'EC', crv: 'P-256', d: privateKey, x: b64u.encode(pub.slice(1, 33)), y: b64u.encode(pub.slice(33, 65)), ext: true };
}

/** The Authorization header for a push service (RFC 8292). subject: a mailto: or https: contact. */
export async function vapidHeader(endpoint, { publicKey, privateKey, subject }, ttlSeconds = 12 * 3600) {
  const header = b64u.encode(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u.encode(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + ttlSeconds, sub: subject })));
  const key = await crypto.subtle.importKey('jwk', privateJwk(publicKey, privateKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(header + '.' + claims)));
  return `vapid t=${header}.${claims}.${b64u.encode(sig)}, k=${publicKey}`;
}

/** Send one push. Returns { status, gone } — gone means the subscription no longer exists (delete it). */
export async function sendPush(sub, data, vapid, { ttl = 3600, urgency = 'high', fetchFn = fetch } = {}) {
  const body = await encryptPayload(enc.encode(JSON.stringify(data)), b64u.decode(sub.p256dh), b64u.decode(sub.auth));
  const res = await fetchFn(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidHeader(sub.endpoint, vapid),
      'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream',
      TTL: String(ttl), Urgency: urgency,
    },
    body,
  });
  return { status: res.status, gone: res.status === 404 || res.status === 410 };
}

/** A fresh VAPID key pair (base64url, web-push format). */
export async function generateVapidKeys() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  return { publicKey: b64u.encode(pub), privateKey: jwk.d };
}
