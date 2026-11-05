// Checks supabase/functions/push/webpush.mjs against the standard: the RFC 8291 example message,
// and the widely used web-push / http_ece libraries in both directions. Run: node tests/webpush.mjs
import { createRequire } from 'node:module';
import { encryptPayload, vapidHeader, sendPush, generateVapidKeys, b64u } from '../supabase/functions/push/webpush.mjs';

const require = createRequire(import.meta.url);
const ece = require('http_ece');
const webpush = require('web-push');
const crypto = globalThis.crypto;
let failures = 0;
const ok = (c, m) => { console.log(`${c ? '  ✓' : '  ✗'} ${m}`); if (!c) failures++; };
const enc = new TextEncoder(), dec = new TextDecoder();

console.log('\n▶ RFC 8291 example (Appendix A)');
const A = {
  plaintext: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24',
  as_public: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  as_private: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  auth_secret: 'BTBZMqHH6r4Tts7J_aSIgg',
  ua_public: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  ua_private: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};
const asPub = b64u.decode(A.as_public);
const asKeyPair = {
  publicKey: await crypto.subtle.importKey('raw', asPub, { name: 'ECDH', namedCurve: 'P-256' }, true, []),
  privateKey: await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', d: A.as_private, x: b64u.encode(asPub.slice(1, 33)), y: b64u.encode(asPub.slice(33)) },
    { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']),
};
const body = await encryptPayload(b64u.decode(A.plaintext), b64u.decode(A.ua_public), b64u.decode(A.auth_secret), { asKeyPair, salt: b64u.decode(A.salt) });
ok(b64u.encode(body) === A.body, 'encryption matches the RFC example byte for byte');

console.log('\n▶ against the web-push / http_ece libraries');
const ua = require('node:crypto').createECDH('prime256v1'); ua.generateKeys();
const auth = crypto.getRandomValues(new Uint8Array(16));
const msg = JSON.stringify({ title: '⏰ Reminder', body: 'Take the cake out 🎂' });
const mine = await encryptPayload(enc.encode(msg), new Uint8Array(ua.getPublicKey()), auth);
const opened = ece.decrypt(Buffer.from(mine), { version: 'aes128gcm', privateKey: ua, dh: undefined, authSecret: Buffer.from(auth) });
ok(opened.toString() === msg, 'http_ece decrypts what we encrypt');
const theirs = webpush.generateRequestDetails({ endpoint: 'https://push.example/x', keys: { p256dh: b64u.encode(ua.getPublicKey()), auth: b64u.encode(auth) } }, msg,
  { vapidDetails: { subject: 'https://example.com/', ...webpush.generateVAPIDKeys() } });
const theirsOpened = ece.decrypt(theirs.body, { version: 'aes128gcm', privateKey: ua, authSecret: Buffer.from(auth) });
ok(theirsOpened.toString() === msg, '(sanity) the library reads its own messages the same way');

console.log('\n▶ VAPID');
const keys = await generateVapidKeys();
ok(b64u.decode(keys.publicKey).length === 65 && b64u.decode(keys.privateKey).length === 32, 'key pair in the usual web-push format');
const libKeys = webpush.generateVAPIDKeys();
const hdr = await vapidHeader('https://fcm.googleapis.com/fcm/send/abc', { ...libKeys, subject: 'https://akashv182004.github.io/hustl/' });
const [, jwt, k] = hdr.match(/^vapid t=([^,]+), k=(.+)$/);
const [h, c, s] = jwt.split('.');
const claims = JSON.parse(dec.decode(b64u.decode(c)));
ok(k === libKeys.publicKey && claims.aud === 'https://fcm.googleapis.com' && claims.sub.startsWith('https://') && claims.exp > Date.now() / 1000, 'header names the push service, the contact and an expiry');
const pubKey = await crypto.subtle.importKey('raw', b64u.decode(libKeys.publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
ok(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pubKey, b64u.decode(s), enc.encode(h + '.' + c)), 'signature verifies with the public key (ES256)');

console.log('\n▶ sending');
let sent = null;
const fakeFetch = async (url, init) => { sent = { url, init }; return { status: 201 }; };
const r = await sendPush({ endpoint: 'https://push.example/abc', p256dh: b64u.encode(ua.getPublicKey()), auth: b64u.encode(auth) }, { hi: 1 }, { ...libKeys, subject: 'https://x.example/' }, { fetchFn: fakeFetch });
ok(r.status === 201 && !r.gone && sent.init.headers['Content-Encoding'] === 'aes128gcm' && sent.init.headers.TTL === '3600', 'POSTs an encrypted aes128gcm message with TTL and VAPID');
ok(JSON.parse(ece.decrypt(Buffer.from(sent.init.body), { version: 'aes128gcm', privateKey: ua, authSecret: Buffer.from(auth) }).toString()).hi === 1, 'the receiving browser can read it');
const gone = await sendPush({ endpoint: 'https://push.example/old', p256dh: b64u.encode(ua.getPublicKey()), auth: b64u.encode(auth) }, {}, { ...libKeys, subject: 'https://x.example/' }, { fetchFn: async () => ({ status: 410 }) });
ok(gone.gone, 'a subscription the push service says is gone is reported, so it can be removed');

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
