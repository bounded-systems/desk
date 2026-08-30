// A KV stand-in shared by the store and fan-out suites. Its one non-obvious
// behaviour is that list() PAGES, because the real one does and code that
// forgets reads only the first page.
/** A KV stand-in with the one behaviour that matters: list() pages. */
export function fakeKv(pageSize = 1000) {
  const map = new Map();
  return {
    map,
    async put(k, v) { map.set(k, v); },
    async get(k) { return map.has(k) ? map.get(k) : null; },
    async delete(k) { map.delete(k); },
    async list({ prefix = "", cursor } = {}) {
      const all = [...map.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const slice = all.slice(start, start + pageSize);
      const end = start + slice.length;
      return {
        keys: slice.map((name) => ({ name })),
        list_complete: end >= all.length,
        cursor: String(end),
      };
    },
  };
}
