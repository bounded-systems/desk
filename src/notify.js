// The fan-out: everything stored, one push each, prune what is gone (#37).
//
// This is where the two halves meet, and it is deliberately the only place that
// deletes. push.js decides what a status MEANS; subscriptions.js knows how to
// remove one; neither can prune on its own, so there is exactly one line in the
// codebase that can empty the store and it is guarded by `outcome === "gone"`.

import { authorizationsByAudience, audienceFor, sendPush } from "./push.js";
import { deleteSubscription, listSubscriptions } from "./subscriptions.js";

/**
 * Notify every subscribed device.
 *
 * Returns a census rather than a boolean, because "sent 0 of 0" and "sent 0 of
 * 12" are different facts and a caller that cannot tell them apart will report
 * the second as success. Same rule the board's own projection learned the hard
 * way (`.github-private`#809): an empty denominator is not a clean result.
 */
export async function notifyAll(kv, vapid, fetchImpl = fetch) {
  const subs = await listSubscriptions(kv);
  if (subs.length === 0) return { total: 0, sent: 0, pruned: 0, retry: 0, failed: 0 };

  const auths = await authorizationsByAudience(subs.map((s) => s.endpoint), vapid);
  const census = { total: subs.length, sent: 0, pruned: 0, retry: 0, failed: 0 };

  for (const sub of subs) {
    const authorization = auths.get(audienceFor(sub.endpoint));
    let outcome;
    try {
      ({ outcome } = await sendPush(sub.endpoint, authorization, fetchImpl));
    } catch {
      // A transport failure is not evidence the subscription is dead — the
      // network is the thing that failed, and pruning on it would delete
      // devices for being offline at the wrong moment.
      census.retry++;
      continue;
    }
    if (outcome === "gone") {
      await deleteSubscription(kv, sub.key);
      census.pruned++;
    } else if (outcome === "ok") census.sent++;
    else if (outcome === "retry") census.retry++;
    else census.failed++;
  }
  return census;
}
