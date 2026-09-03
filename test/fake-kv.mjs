// A KV stand-in shared by the store, fan-out and login suites. Its one
// non-obvious behaviour is that list() PAGES, because the real one does and code
// that forgets reads only the first page.
//
// IT ALSO COUNTS, since desk#65. There were two fakes with disjoint
// capabilities — this one paged and could not count, worker.test.mjs's kvStub
// counted and could not page — and the login suite needs both: paging to see a
// credential on a second page, counting to prove the admission check re-reads
// the store on EVERY request rather than memoising it. Counting was merged into
// this one rather than paging into the other because a counter is inert
// (nothing reads it unless a test does) while paging changes what list()
// returns, and kvStub's callers pin its shape.
//
// IT CARRIES LIST METADATA, since desk#65's review: liveCredentials skips a get
// for a key whose metadata says the record is not live, and a fake whose list()
// dropped metadata would make that skip untestable — and would report every
// credential as unindexed, which is the fail-open side of the filter.
//
// IT DOES NOT EXPIRE. Neither fake ever has. Every claim about a TTL here is a
// clock-argument test plus a captured put options bag; "KV will drop it" is not
// an assertion this harness can make.
/** A KV stand-in with the two behaviours that matter: list() pages, and reads are counted. */
export function fakeKv(pageSize = 1000) {
  const map = new Map();
  const meta = new Map();
  const counts = { get: 0, list: 0, put: 0, delete: 0 };
  return {
    map,
    meta,
    counts,
    async put(k, v, opts = {}) { counts.put++; map.set(k, v); if (opts.metadata === undefined) meta.delete(k); else meta.set(k, opts.metadata); },
    async get(k) { counts.get++; return map.has(k) ? map.get(k) : null; },
    async delete(k) { counts.delete++; map.delete(k); meta.delete(k); },
    async list({ prefix = "", cursor } = {}) {
      counts.list++;
      const all = [...map.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const slice = all.slice(start, start + pageSize);
      const end = start + slice.length;
      return {
        keys: slice.map((name) => (meta.has(name) ? { name, metadata: meta.get(name) } : { name })),
        list_complete: end >= all.length,
        cursor: String(end),
      };
    },
  };
}
