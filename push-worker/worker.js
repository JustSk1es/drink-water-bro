// Drink Water Bro — push server (Cloudflare Worker)
// Free tier: stores push subscriptions in KV, cron-sends reminders.
//
// Setup (see PUSH-SETUP.md):
//   wrangler kv:namespace create SUBSCRIPTIONS   -> put id in wrangler.toml
//   wrangler secret put VAPID_PRIVATE            -> paste the private scalar
//   wrangler deploy

const VAPID_PUBLIC = "BB4143OHSrvRPIxHbFh0D6lKIhftIyRQWLjn_LsjNF6NFwxPnKZw5Prv0sPHEaKRrnbuVfNCQvg-TXvxUOJCpI4";
const VAPID_SUBJECT = "mailto:stanleyjebaretnam@example.com"; // change to your real email

// ---------- tiny Web Push (aes128gcm) implementation ----------

const b64uToBuf = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
const b64u = (buf) => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const concat = (...arrs) => {
  const total = arrs.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
};
const utf8 = (s) => new TextEncoder().encode(s);

async function hkdf(salt, ikm, info, len) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info }, key, len * 8);
  return new Uint8Array(bits);
}

// jose jwe a128gcm header builder for VAPID auth token
async function vapidToken(endpoint, vapidPrivB64u, vapidPubB64u) {
  const aud = new URL(endpoint).origin;
  const header = { typ: "JWT", alg: "ES256", kid: vapidPubB64u };
  const claims = { aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: VAPID_SUBJECT };
  const h = b64u(utf8(JSON.stringify(header)));
  const c = b64u(utf8(JSON.stringify(claims)));
  const signingInput = utf8(`${h}.${c}`);

  // import raw ECDSA P-256 private scalar as JWK
  const pubRaw = b64uToBuf(vapidPubB64u);
  const x = pubRaw.slice(1, 33), y = pubRaw.slice(33, 65);
  const d = b64uToBuf(vapidPrivB64u);
  const jwk = { kty: "EC", crv: "P-256", x: b64u(x), y: b64u(y), d: b64u(d) };
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  // WebCrypto ECDSA already returns raw r||s (64 bytes) — no DER conversion needed
  const rawSig = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, key, signingInput));
  return `${h}.${c}.${b64u(rawSig)}`;
}

function derToRaw(der) {
  // ECDSA signature: SEQUENCE { INTEGER r, INTEGER s } — normalize to 32 bytes each
  let idx = 2;
  const readInt = () => {
    const len = der[idx + 1];
    let v = der.slice(idx + 2, idx + 2 + len);
    idx += 2 + len;
    if (v.length > 32) v = v.slice(v.length - 32);
    const out = new Uint8Array(32);
    out.set(v, 32 - v.length);
    return out;
  };
  const r = readInt();
  const s = readInt();
  return concat(r, s);
}

// aes128gcm content encryption (RFC 8291)
async function encryptPayload(subscription, payloadJson) {
  const uaPublic = b64uToBuf(subscription.keys.p256dh);
  const authSecret = b64uToBuf(subscription.keys.auth);

  // ephemeral server key
  const serverKeys = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const serverPubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", serverKeys.publicKey));

  const sharedBits = await crypto.subtle.deriveBits(
    { name: "ECDH", public: await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []) },
    serverKeys.privateKey, 256);
  const sharedSecret = new Uint8Array(sharedBits);

  // HKDF per RFC 8291
  const ikm = await hkdf(authSecret, sharedSecret, utf8("WebPush: info\x00" + b64u(uaPublic) + "\x00" + b64u(serverPubRaw)), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, utf8("Content-Encoding: aes128gcm\x00"), 16);
  const nonce = await hkdf(salt, ikm, utf8("Content-Encoding: nonce\x00"), 12);

  // payload + 1-byte padding delimiter
  const plaintext = concat(utf8(JSON.stringify(payloadJson)), new Uint8Array([2]));
  const enc = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, 
    await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]), plaintext));

  // aes128gcm header: salt(16) rs(4) idlen(1) keyid(65)
  const header = concat(salt,
    new Uint8Array([0x00, 0x01, 0x00, 0x00]), // rs = 65536
    new Uint8Array([serverPubRaw.length]), serverPubRaw);

  return concat(header, enc);
}

async function sendPush(subscription, payloadJson, vapidPrivB64u) {
  const body = await encryptPayload(subscription, payloadJson);
  const token = await vapidToken(subscription.endpoint, vapidPrivB64u, VAPID_PUBLIC);
  const headers = {
    "TTL": "86400",
    "Urgency": "normal",
    "Content-Type": "application/octet-stream",
    "Content-Encoding": "aes128gcm",
    "Authorization": `vapid t=${await token}, k=${VAPID_PUBLIC}`
  };
  const resp = await fetch(subscription.endpoint, { method: "POST", body, headers });
  return resp.status;
}

// ---------- API ----------

async function endpointKey(endpoint) {
  const digest = await crypto.subtle.digest("SHA-256", utf8(endpoint));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/subscribe") {
      const sub = await request.json();
      if (!sub.endpoint || !sub.keys) {
        return new Response("bad subscription", { status: 400, headers: cors });
      }
      const key = await endpointKey(sub.endpoint);
      // also store the user's per-day schedule summary + timezone for push payload
      const sched = sub.schedule || {};
      const tzOffsetMin = Number.isFinite(sub.tzOffsetMin) ? sub.tzOffsetMin : 480; // default UTC+8
      const deviceName = (typeof sub.deviceName === "string" && sub.deviceName.trim())
        ? sub.deviceName.trim().slice(0, 60) : null;
      const platform = sub.endpoint.includes("web.push.apple.com") ? "Apple" : "Android/Chrome";
      const record = { sub, schedule: sched, tzOffsetMin, platform, deviceName, added: new Date().toISOString() };

      // Cleanup: keep only one subscription per device. The app identifies a
      // device by a random deviceId it stores in localStorage, so re-enabling
      // on the same device replaces its old subscription instead of piling up.
      if (typeof sub.deviceId === "string" && sub.deviceId) {
        const list = await env.SUBSCRIPTIONS.list();
        for (const k of list.keys) {
          if (k.name.includes(":")) continue; // skip dedupe markers
          if (k.name === key) continue;
          const oldRaw = await env.SUBSCRIPTIONS.get(k.name);
          if (!oldRaw) continue;
          try {
            const old = JSON.parse(oldRaw);
            if (old.deviceId === sub.deviceId) {
              await env.SUBSCRIPTIONS.delete(k.name);
            }
          } catch (e) { /* skip malformed */ }
        }
      }

      await env.SUBSCRIPTIONS.put(key, JSON.stringify(record));
      return new Response(JSON.stringify({ ok: true }), { headers: cors });
    }

    if (request.method === "DELETE" && url.pathname === "/subscribe") {
      const sub = await request.json();
      const key = await endpointKey(sub.endpoint);
      await env.SUBSCRIPTIONS.delete(key);
      return new Response(JSON.stringify({ ok: true }), { headers: cors });
    }

    if (request.method === "GET" && url.pathname === "/debugtoken") {
      // Diagnostic: return the VAPID token so its signature can be validated offline.
      const token = await vapidToken("https://web.push.apple.com/X", env.VAPID_PRIVATE, VAPID_PUBLIC);
      return new Response(token, { headers: cors });
    }

    if (request.method === "POST" && url.pathname === "/testsend") {
      // Diagnostic: send a test push to every stored subscription right now.
      const vapidPriv = env.VAPID_PRIVATE;
      if (!vapidPriv) return new Response("VAPID_PRIVATE not set", { status: 500, headers: cors });
      const results = [];
      const list = await env.SUBSCRIPTIONS.list();
      for (const k of list.keys) {
        if (k.name.includes(":")) continue; // skip dedupe markers
        const raw = await env.SUBSCRIPTIONS.get(k.name);
        if (!raw) continue;
        const rec = JSON.parse(raw);
        const status = await sendPush(rec.sub,
          { title: "💧 Drink Water Bro — test!", body: "Push is working. Stay hydrated!" },
          vapidPriv);
        results.push({ key: k.name.slice(0, 8), status });
        if (status === 404 || status === 410) await env.SUBSCRIPTIONS.delete(k.name);
      }
      return new Response(JSON.stringify({ results }), { headers: cors });
    }

    return new Response("Drink Water Bro push server 💧", { headers: cors });
  },

  // Cron trigger: runs every 15 minutes, sends any due reminders.
  // Subscriptions store { sub, schedule: { Mon: {wake, sleep}, ... } }.
  async scheduled(event, env, ctx) {
    const vapidPriv = env.VAPID_PRIVATE;
    if (!vapidPriv) return;
    const now = new Date();
    const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const day = dayNames[now.getUTCDay()];
    const nowMins = now.getUTCHours() * 60 + now.getUTCMinutes();

    const list = await env.SUBSCRIPTIONS.list();
    for (const k of list.keys) {
      const raw = await env.SUBSCRIPTIONS.get(k.name);
      if (!raw) continue;
      const rec = JSON.parse(raw);
      // Work out the user's local day/time from their stored UTC offset
      const localNow = new Date(now.getTime() + rec.tzOffsetMin * 60000);
      const day = dayNames[localNow.getUTCDay()];
      const nowMins = localNow.getUTCHours() * 60 + localNow.getUTCMinutes();
      const sched = rec.schedule || {};
      const s = sched[day];
      if (!s || !s.wake || !s.sleep) continue;
      const toMin = (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + (m || 0); };
      const wake = toMin(s.wake);
      let sleep = toMin(s.sleep);
      if (sleep <= wake) sleep += 1440;
      // reminders at wake+45min through sleep-45min, count = min(10, max(4, round(hours/1.5)))
      const hours = (sleep - wake) / 60;
      const sips = Math.min(10, Math.max(4, Math.round(hours / 1.5)));
      let due = false;
      for (let i = 0; i < sips; i++) {
        const t = Math.round(wake + 45 + (i * (sleep - wake - 90)) / (sips - 1 || 1)) % 1440;
        if (nowMins >= t && nowMins < t + 15) { due = true; break; }
      }
      if (!due) continue;
      const firedKey = `${k.name}:${day}:${localNow.toISOString().slice(0, 13)}`;
      if (await env.SUBSCRIPTIONS.get(firedKey)) continue; // already sent this window
      const status = await sendPush(rec.sub,
        { title: "💧 Time to drink water!", body: "Stay hydrated, bro — " + day + " reminder." },
        vapidPriv);
      // remember send attempt (dedupe) for a day
      if (status === 201 || status === 200) {
        await env.SUBSCRIPTIONS.put(firedKey, JSON.stringify({ sent: now.toISOString() }),
          { expirationTtl: 86400 });
      } else if (status === 404 || status === 410) {
        // subscription expired — clean up
        await env.SUBSCRIPTIONS.delete(k.name);
        await env.SUBSCRIPTIONS.delete(firedKey);
      }
    }
  }
};
