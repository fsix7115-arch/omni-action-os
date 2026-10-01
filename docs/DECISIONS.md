# Architecture decisions and trade-offs

Each entry records what was decided, why, what was rejected, and what it costs us.
This file grows — every non-obvious decision belongs here.

---

## ADR-001: One language for the vertical slice, not a polyglot monorepo

**Status:** Accepted

**Decision:** The first vertical slice is a single Next.js/TypeScript application
with FastAPI-style HTTP handlers. No separate Python service yet.

**Why:** The build guide recommends FastAPI + Next.js, which is a reasonable target
*at scale*. But a two-language system doubles the local setup surface, doubles the
doctor checks, and doubles the failure modes — all before a single action has
executed. The guide's own first vertical slice is small; the split should arrive
when there is real pressure for it (heavy ML inference, a separate worker
runtime), not on day one.

**Rejected:** FastAPI backend + Next.js frontend from the start. Rejected for the
slice; revisit when a connector genuinely needs Python-only tooling.

**Cost:** If we later split, the API boundary is already HTTP + JSON, so the
extraction is mechanical. We accept some rework in exchange for a first working
slice in hours rather than days.

---

## ADR-002: Postgres is the target, SQLite is the default local profile

**Status:** Accepted

**Decision:** Prisma with a SQLite default for local development, PostgreSQL as the
documented production profile.

**Why:** The guide's "Profile A: Local Lite" wants SQLite; "Profile B: Local Pro"
wants Postgres. Two databases means the local path has zero setup, which is what
makes a new user able to run this in five minutes.

**Known constraint:** Prisma's datasource provider is a build-time constant. Moving
between SQLite and Postgres is a provider change plus a migration, not a runtime
env swap. This must be documented honestly in `docs/COMPATIBILITY.md` rather than
implied to be seamless.

**Rejected:** Postgres-only. Rejected because it makes the local quickstart require
a running database server — the single biggest reason clones get abandoned.

---

## ADR-003: Every connector declares a machine-readable pricing mode

**Status:** Accepted

**Decision:** Each capability carries `pricingMode ∈ {free, self-hosted, byo, paid,
unknown}` as data, plus auth method, required scopes, rate limits, data touched,
official docs URL, a health check and a named verifier.

**Why:** "Free" as a marketing label is the most common dishonesty in the AI tooling
space. Making it a field in the graph means the UI cannot accidentally overstate
cost, and `unknown` is an honest permitted answer.

**Rejected:** A single global "all connectors are free" banner. Rejected because it
is a lie for roughly every real SaaS connector.

---

## ADR-004: Permissions are time-boxed, revocable objects — not flags

**Status:** Accepted

**Decision:** A permission grant is a `PermissionCapsule` with granted scopes, an
expiry, an optional subject restriction, a reason, and a revocation path. Execution
requires a live capsule.

**Why:** `scopes: ["write"]` on a user record cannot express "just this one email,
until Friday". It also cannot be revoked without editing user records, which is a
bad audit story. Capsules are the unit of consent, of expiry, and of revocation.

**Rejected:** Boolean flags on a user, or OAuth scopes as the sole permission model.
OAuth scopes are about *what the integration may do*, not about *what this user
approved for this task*. Both are needed; OAuth scopes are upstream of the capsule.

---

## ADR-005: The verifier is declared per operation, and it is mandatory

**Status:** Accepted

**Decision:** Every operation in the capability graph names a verifier that reads
back external state. The journal stores `claimed` and `verified` as separate facts.
An unverified execution is a first-class failure state.

**Why:** An action that returns HTTP 200 has not proven it happened. This is the
difference between a demo and a tool someone can let near real data. Making the
verifier a required field in the graph means you cannot register an operation
without committing to how you will check it.

**Rejected:** Treating non-2xx as failure. Rejected — that is exactly the assumption
that produces confidently wrong audit trails.

---

## ADR-006: Plans are data, generated before execution, never implicit

**Status:** Accepted

**Decision:** A multi-step action compiles to a `Plan` of `PlanStep`s before anything
runs. Execution takes a plan id. There is no "just do it" path for non-trivial
actions.

**Why:** Preview is the trust mechanism. If the plan is derived at execution time
from a model, the user approved something different from what ran. Compiling the
plan first makes the approved artifact the executed artifact.

**Rejected:** Executing with a per-step confirmation dialog. It still shows the
plan, but it permits partial execution and makes the audit trail fragmented.

---

## ADR-007: No silent skipping. Unknown means unknown.

**Status:** Accepted

**Decision:** When a step cannot be verified because a credential is unavailable, we
ship a deterministic mock for automated tests **and** an explicit manual live-test
checklist marked *unverified*. We never report a feature as working on the strength
of a mock.

**Why:** The single biggest trust failure in this category is a README that says
"works" about something that was only ever exercised against a fake. If we build
that habit in from phase one, the repository will not develop it.

**Cost:** More explicit caveats in the docs. Accepted — a documented gap is worth
more than a silent one.

---

## ADR-008: Local-first, no required external API key to run the demo

**Status:** Accepted

**Decision:** The demo path works fully offline with a mock/local provider. Real
providers are BYO-key and optional.

**Why:** A repository whose quickstart requires someone else's API key is a
repository most people never run. The governance and verification logic — which is
the actual product — does not need a model to be exercised.

**Rejected:** Requiring an OpenAI key for the quickstart. Rejected for adoption;
the offline demo is the primary path.

---

## ADR-009: Overlap with agentforge-compliance-hub is documented, not hidden

**Status:** Accepted

**Decision:** We share a brand with `agentforge-compliance-hub` and reimplement
similar primitives (append-only journal, approval flow, plan preview, dry-run). This
is stated plainly in that repository's README and ours.

**Why:** Two related projects from one author will be compared. Hiding the overlap
invites a worse version of the same discovery. The implementations are genuinely
different — that project hashes an audit chain over *agent actions*; we verify
*external side effects* — but the honest framing is that the patterns are shared.

---

## Open questions

- **Graph layer:** Do we need a real property-graph engine, or is a relational
  edges table sufficient for the slice? Leaning relational for now; revisit if
  traversal depth or provenance queries become the bottleneck.
- **Sync conflict policy:** Deterministic last-write-wins is wrong in general. We
  defer the full policy until we have two connectors that actually disagree.
- **Extract the Python service:** Only when a connector needs it.