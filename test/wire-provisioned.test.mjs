// The transform that binds desk to its store (#39). A mis-edit here reads
// downstream as "nobody has subscribed", so it is tested against the real file.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { wire } from "../scripts/wire-provisioned.mjs";

const ARGS = { kvId: "abc123", vapidPublic: "BTestPublicKey", vapidSubject: "mailto:desk@bounded.tools" };
const strip = (s) => s.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
const parse = (s) => JSON.parse(strip(s));

test("the real wrangler.jsonc still parses, and gains both bindings", () => {
  const out = wire(fs.readFileSync("wrangler.jsonc", "utf8"), ARGS);
  const cfg = parse(out);
  assert.deepEqual(cfg.kv_namespaces, [{ binding: "SUBSCRIPTIONS", id: "abc123" }]);
  assert.equal(cfg.vars.VAPID_PUBLIC_KEY, "BTestPublicKey");
  assert.equal(cfg.vars.VAPID_SUBJECT, "mailto:desk@bounded.tools");
});

test("nothing that was already there is lost", () => {
  const before = parse(fs.readFileSync("wrangler.jsonc", "utf8"));
  const after = parse(wire(fs.readFileSync("wrangler.jsonc", "utf8"), ARGS));
  assert.equal(after.name, before.name);
  assert.equal(after.main, before.main);
  assert.equal(after.routes.length, before.routes.length, "all four hosts survive");
  for (const k of Object.keys(before.vars)) {
    assert.equal(after.vars[k], before.vars[k], `var ${k} survives`);
  }
});

test("the 'not yet declared' note is removed, so no comment contradicts the config", () => {
  const source = `{
  "name": "bounded-desk",

  // ── NOT YET DECLARED: the subscription store and the VAPID keypair (#37) ──
  //
  // Both need account access this repo's CI does not have.
  //   1. wrangler kv namespace create SUBSCRIPTIONS

  "vars": {
    "DESK_LIMIT": "25"
  }
}`;
  const out = wire(source, ARGS);
  assert.ok(!out.includes("NOT YET DECLARED"), "the stale note must go");
  assert.ok(!out.includes("need account access"), "and its whole body with it");
  assert.equal(parse(out).vars.DESK_LIMIT, "25");
});

test("a config without the note is wired anyway", () => {
  const source = '{\n  "name": "x",\n\n  "vars": {\n    "A": "1"\n  }\n}';
  const cfg = parse(wire(source, ARGS));
  assert.equal(cfg.kv_namespaces[0].id, "abc123");
  assert.equal(cfg.vars.A, "1");
});

test("a config with no vars block is refused rather than silently half-written", () => {
  assert.throws(() => wire('{\n  "name": "x"\n}', ARGS), /could not find the "vars" block/);
});

test("the note is not removed when it sits BELOW the vars block", () => {
  // Range deletion is only safe forwards; a note after `vars` would otherwise
  // delete a negative span or eat real config.
  const source = '{\n  "vars": {\n    "A": "1"\n  },\n  // ── NOT YET DECLARED: something else ──\n  "z": 1\n}';
  const out = wire(source, ARGS);
  assert.ok(out.includes("NOT YET DECLARED"), "an unrelated note below stays");
  assert.equal(parse(out).z, 1);
});

test("wiring an already-wired config is refused, not applied twice", () => {
  // JSON takes the LAST duplicate key, so a second pass would parse fine and
  // leave a dead binding above the live one — correct-looking, and wrong.
  const once = wire(fs.readFileSync("wrangler.jsonc", "utf8"), ARGS);
  assert.throws(() => wire(once, ARGS), /already wired/);
});
