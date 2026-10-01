feat: phase 2 - one verified vertical slice, end to end

connect -> ask -> plan (dry run) -> approve -> execute -> verify -> journal,
against a real filesystem, with a browser UI and an HTTP API.

The whole slice is real, not scaffolding. A file is actually written and
actually read back; a plan is actually compiled from each operation's dry run;
a permission is actually checked server-side before any I/O happens.

Three design decisions carry it:

- Dry run before approval. Each operation declares whether it supports one, and
  the risk line names the irreversible part before the user approves anything.
- Permissions are server-side. The request body carries a justification for a
  grant but never a grant; the capsule is minted in the route handler.
- Verification is mandatory. RejectsInBandVerifier names and tests the
  anti-pattern of agreeing with the provider you are auditing, and is refused
  for destructive effects.

Four bugs found and fixed while building:

- connector operations were object literals typed as Operation, so `this` was
  the operation rather than the connector and resolveInsideSandbox did not
  exist. Replaced with an explicit closure over the connector.
- the sandbox root was hardcoded to a path inside the repo, so the test suite
  would have written into the working tree. Now resolved per call, honouring
  OMNI_SANDBOX.
- a leftover sync planObjective wrapper that threw at runtime on any call.
  Removed; only the async version remains.
- a `require` inside an ESM module in the journal verifier. Now a static import.

Verified:
- typecheck clean
- 27 tests pass, exercising the real filesystem with no mocked I/O boundary
- production build clean, 3 routes
- live run against next start: plan preview -> approve -> execute -> verify,
  journal of 4 entries with the SHA-256 chain intact, file present on disk with
  the exact bytes written
- path escape, /etc/passwd, empty justification and an unpermitted capability
  are all refused
- 19 doctor tests still pass

Known and stated in the README: plans and the journal are in-memory, so a
restart clears them. Durable storage is gate G6.