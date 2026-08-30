// The subscription store (#37).
//
// A subscription is not a secret, but the SET of them is the only thing here
// worth protecting: it is a list of devices belonging to real people. The VAPID
// keypair, by contrast, authenticates us to a push service and encrypts
// nothing — someone holding it can only push to endpoints they already have.
// So this file, not push.js, is where the care goes.

/** Longest endpoint we will store. Real ones are ~200 chars; this is slack, not a target. */
const MAX_ENDPOINT = 1024;

/**
 * KV key for a subscription. Keyed by a hash of the endpoint rather than the
 * endpoint itself so that re-subscribing the same device OVERWRITES rather than
 * accumulating — a browser hands back the same endpoint, and a store keyed by
 * anything else would grow a duplicate on every visit.
 *
 * Hashed rather than raw because the raw endpoint contains a per-device
 * identifier and KV keys turn up in logs and dashboards that the values do not.
 */
export async function subscriptionKey(endpoint, subtle = crypto.subtle) {
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  return "sub:" + [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Accept only what we can actually push to.
 *
 * The keys are validated even though a payload-less push never uses them:
 * storing a subscription without them means the day we add encryption, every
 * subscription taken before that day is quietly unusable, and the only symptom
 * is some devices not being notified.
 */
export function validateSubscription(input) {
  if (!input || typeof input !== "object") return { ok: false, error: "not an object" };
  const { endpoint, keys } = input;
  if (typeof endpoint !== "string" || endpoint.length === 0) return { ok: false, error: "missing endpoint" };
  if (endpoint.length > MAX_ENDPOINT) return { ok: false, error: "endpoint too long" };
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return { ok: false, error: "endpoint is not a URL" };
  }
  // https only. A push service is always https, and accepting anything else
  // would let a subscribe call point this Worker's sender at an arbitrary host.
  if (url.protocol !== "https:") return { ok: false, error: "endpoint must be https" };
  if (!keys || typeof keys !== "object") return { ok: false, error: "missing keys" };
  if (typeof keys.p256dh !== "string" || typeof keys.auth !== "string") {
    return { ok: false, error: "missing keys.p256dh or keys.auth" };
  }
  return { ok: true, value: { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } } };
}

/** Store one subscription. Idempotent: same device, same key, one record. */
export async function putSubscription(kv, subscription, now = Date.now) {
  const key = await subscriptionKey(subscription.endpoint);
  await kv.put(key, JSON.stringify({ ...subscription, created_at: new Date(now()).toISOString() }));
  return key;
}

/** Every stored subscription. Paginates, because KV list() is capped per call. */
export async function listSubscriptions(kv) {
  const out = [];
  let cursor;
  do {
    const page = await kv.list({ prefix: "sub:", cursor });
    for (const { name } of page.keys) {
      const raw = await kv.get(name);
      if (!raw) continue;
      try {
        out.push({ key: name, ...JSON.parse(raw) });
      } catch {
        // A record we cannot parse is a record we can never push to or prune by
        // endpoint, so it is dropped here rather than left to fail every send.
        await kv.delete(name);
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

export async function deleteSubscription(kv, key) {
  await kv.delete(key);
}
