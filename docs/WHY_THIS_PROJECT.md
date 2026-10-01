# Why OmniAction OS exists

## The claim we are *not* making

We do **not** claim nobody has built something similar. That claim cannot be proved,
and a repository that opens with it is either naive or lying.

Existing projects overlap substantially with parts of this vision:

| Project | What it already does | Where it differs from us |
|---|---|---|
| [OpenHands](https://github.com/OpenHands/OpenHands) | Self-hosted agent control center, automation across local/VM/cloud backends, an "Agent Control Plane" for enterprise | Optimised for *coding* agents in sandboxes. We are not a coding sandbox; we are an action layer for general business/creator workflows (email, calendar, CRM, content, files). |
| Pincer | Multi-channel agents with hundreds of tools | Tool breadth over execution safety. Our differentiator is the permission/verify/audit path, not the tool count. |
| Kora | Multi-channel agents, memory, sandboxed execution | Memory + chat first. We put a *deterministic plan* between intent and action. |
| ClawSocial | Agents and humans as first-class social users | Social graph focus. We are connector- and permission-centric. |
| TropaTT | CRM, projects, chat, automation, large MCP surface | Broad suite. Our claim is narrower and deeper on one thing: **every action is previewed, permissioned, executed idempotently, verified externally, and journalled.** |
| selfhost-ai | Bundles AI, workflow and infrastructure services | Deployment-focused. No universal action contract. |

**Conclusion of the gap check:** the *category* is crowded. The specific combination —
preview → permission capsule → idempotent execution → external verification →
append-only journal — is where we build, and where we must be measurably better
rather than merely present.

## The actual problem

Every tool in a stack can *do* something. Almost none of them can answer the three
questions an auditor, a manager, or a cautious user actually asks:

1. **What exactly are you about to do, and where?**
2. **What permission did I give, for how long, and what does it cost?**
3. **Did it actually happen — or did the tool just return 200?**

The gap is not execution. It is **accountability around execution.** Most systems
optimise for *doing the thing*. Very few treat "show me exactly what you did, prove
it happened, and let me revoke it" as a first-class product feature rather than a
logging afterthought.

## What we build that is genuinely ours

Seven architectural commitments. Each is testable; each is a place where a
competitor would plausibly do something weaker.

### 1. Capability Graph as the single routing surface

```
connector → capability → operation → required scopes → risk level → verifier
```

Not a flat list of tools. Every route an action can take is a typed edge with
declared scopes and a named verifier. When a new connector is added it must
register into this graph or it does not exist — there is no second, undeclared
path to an external side effect. This makes "what can this system possibly do,
and what would it need permission for" a query rather than a code audit.

### 2. Permission Capsule

A permission grant is not `scopes: ["write"]`. It is a **scoped, time-boxed,
revocable object** with an expiry and a reason. A capsule can be granted for
"send email to this one address until Friday", not "access the mailbox forever".
Capsules are recorded, and execution refuses to run without a live one.

### 3. Dry-run / plan preview is mandatory, not optional

For every non-trivial action the system produces a **plan** before it executes: the
steps, the connectors, the scopes required, the estimated external cost, and which
steps are irreversible. There is no path that executes a multi-step plan without
the user having seen it. If we cannot produce a plan, we do not execute.

### 4. Verifier loop — trust the state, not the response

An action returning `200 OK` is not evidence. Each operation declares a
**verifier** that reads back the external state and confirms the intended change
is present. The journal records `claimed` vs `verified` separately. An action that
executes but cannot be verified is a distinct, visible failure mode — not a
success.

### 5. Compensation / undo as metadata

For operations with a native inverse, the graph declares it. For those without,
the system produces **recovery instructions** rather than pretending undo exists.
"Undo" is never a hardcoded assumption; it is declared data.

### 6. Portable workflow packs

Automations export and import as versioned, signed JSON bundles. A workflow is a
portable artifact, not trapped inside one workspace. Signing means an imported
pack's provenance is verifiable.

### 7. Cost/privacy-aware model routing

The model router chooses a provider by **configurable policy** — privacy, cost,
latency, context length, tool support, availability — not by hardcoded vendor. The
same action can run locally or hosted depending on what the user is willing to
accept. Cost is shown when the provider exposes pricing; when it does not, we
label it **unknown** rather than guessing.

## Honest design rules we hold ourselves to

- **No faked integrations.** If an API or permission is unavailable, the connector
  is marked unavailable with the real prerequisite named. We do not ship a demo
  that pretends to send email.
- **Pricing mode is data, not marketing.** Every connector stores a machine-readable
  mode: `free` / `self-hosted` / `BYO` / `paid` / `unknown`. `unknown` is a valid,
  honest answer. We never label something free to make it sound good.
- **No paywall, rate-limit, CAPTCHA or ToS bypass.** Ever. A connector that cannot
  act legally is documented as read-only or absent.
- **Permissions enforced server-side.** Hiding a button is not access control.

## Non-goals

- We are not a chatbot with 100 buttons bolted on.
- We do not promise universal access to every platform.
- We do not sync private data without explicit, per-source consent.
- We do not replace your CRM or your mailbox. We operate on them, under permission.

## How we will know this is real

The vertical slice is the proof. A user connects one read-only source, asks a
question, gets a plan with evidence, approves it, the action executes, the system
verifies the external state, and the audit page shows the evidence trail and a
screenshot. If that flow does not work end to end on a clean machine, this document
is aspirational and the repository should say so.