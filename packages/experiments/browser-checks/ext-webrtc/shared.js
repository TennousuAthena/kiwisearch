// Shared by the service worker and the offscreen document: which WebCrypto primitives the sync design needs are available here.
async function cryptoProbe() {
  const out = {};
  const one = new Uint8Array([1, 2, 3]);
  try {
    const k = await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
    const sig = await crypto.subtle.sign({ name: 'Ed25519' }, k.privateKey, one);
    out.ed25519 = await crypto.subtle.verify({ name: 'Ed25519' }, k.publicKey, sig, one);
  } catch (e) { out.ed25519 = String(e); }
  try {
    const a = await crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits']);
    const b = await crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits']);
    const ab = new Uint8Array(await crypto.subtle.deriveBits({ name: 'X25519', public: b.publicKey }, a.privateKey, 256));
    const ba = new Uint8Array(await crypto.subtle.deriveBits({ name: 'X25519', public: a.publicKey }, b.privateKey, 256));
    out.x25519 = ab.every((v, i) => v === ba[i]);
  } catch (e) { out.x25519 = String(e); }
  try {
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const ikm = await crypto.subtle.importKey('raw', seed, 'HKDF', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: new TextEncoder().encode('kiwi-sync/v1/data') }, ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: one }, key, one);
    const pt = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: one }, key, ct));
    out.hkdfAesGcm = pt.length === 3 && pt[2] === 3;
    // A non-extractable key survives a round trip through IndexedDB (structured clone) and still decrypts.
    await idbPut('probe-key', key);
    const back = await idbGet('probe-key');
    const pt2 = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: one }, back, ct));
    out.nonExtractableKeyInIndexedDb = pt2[2] === 3 && back.extractable === false;
  } catch (e) { out.hkdfAesGcm = out.hkdfAesGcm ?? String(e); out.nonExtractableKeyInIndexedDb = String(e); }
  return out;
}

function idb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('webrtc-probe', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function idbGet(key) {
  const db = await idb();
  return new Promise((resolve, reject) => { const q = db.transaction('kv').objectStore('kv').get(key); q.onsuccess = () => resolve(q.result); q.onerror = () => reject(q.error); });
}
async function idbPut(key, value) {
  const db = await idb();
  return new Promise((resolve, reject) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(value, key); t.oncomplete = () => resolve(); t.onerror = () => reject(t.error); });
}
