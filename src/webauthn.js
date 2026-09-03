// THE VENDORED VERIFIER, AND THE ONLY DOOR TO IT.
//
// `src/vendor/webauthn.mjs` is a BYTE-FOR-BYTE copy of
// bounded-systems/infra → cloudflare/keeper/src/webauthn.mjs, digest recorded in
// `src/vendor/webauthn.pin.json` and checked by test/vendor-pin.test.mjs.
//
// WHY VENDORED RATHER THAN REWRITTEN. Desk needs the same six checks the keeper
// makes — clientData type, challenge bytes, origin, rpIdHash, UP/UV, signature —
// and a second implementation of them is the two-parallel-systems defect in the
// worst possible place: security code where two copies drift silently and the
// stale one keeps passing its own tests. The file has zero imports and is
// already parameterised by `origin` and `rpId`, so it runs here unmodified.
//
// WHY THE COPY IS UNTOUCHED AND THIS WRAPPER EXISTS. The pin is over BYTES, so
// a provenance header added to the copy would make it un-comparable with the
// file it came from — the pin would then prove only that desk had not edited
// desk's own variant. So the provenance lives here, one hop away, and the copy
// stays diffable against infra with `cmp`.
//
// LOGIC CHANGES BELONG UPSTREAM. Do not edit the vendored file. If a check is
// wrong or missing, that is an infra PR against the keeper's copy, followed by a
// re-vendor here (copy, re-pin, re-run the conformance suite). Editing it here
// would silently fork the org's relying-party code.
//
// AND THE GAP, PLAINLY: the pin catches an edit made HERE. Nothing catches an
// edit made THERE — measured 2026-09-03, no workflow in infra mentions this file,
// so a change to the keeper's own verifier goes red nowhere and desk keeps
// running the old bytes. A reconciliation lane in infra would close it; it does
// not exist yet, and src/vendor/webauthn.pin.json says so rather than implying
// otherwise.
//
// NOT re-exported: nothing but the two ceremony verifiers and the codec is used
// by desk, and a narrower surface is one fewer thing a later caller can reach
// for by accident.
export { b64url, verifyAssertion, verifyRegistration } from "./vendor/webauthn.mjs";
