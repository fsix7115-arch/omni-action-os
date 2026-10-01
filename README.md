# OmniAction OS

**A universal AI action workspace: state an objective, see the plan, approve the
permissions, watch it execute, and get proof it actually happened.**

> **Status: Phase 0 + Phase 1 complete.** The design review and the environment
> doctor are done and tested. The core domain, connectors and execution engine
> are not built yet. See [Progress](#progress) for exactly what exists.

---

## The gap this fills

Every tool in your stack can *do* something. Almost none of them can answer the
three questions that actually matter:

1. **What exactly are you about to do, and where?**
2. **What permission did I give, for how long, and what does it cost?**
3. **Did it actually happen — or did the tool just return 200?**

The gap is not execution. It is **accountability around execution.** OmniAction is
built around that:

```
intent → plan → preview → permission → execute → verify → journal
```

The **verify** step is the one most systems skip. An action returning `200 OK` is
not evidence. Each operation declares a verifier that reads back external state,
and the journal stores *claimed* and *verified* as separate facts.

Full reasoning, including the open-source projects this overlaps with, is in
[docs/WHY_THIS_PROJECT.md](docs/WHY_THIS_PROJECT.md). Architecture decisions and
their costs are in [docs/DECISIONS.md](docs/DECISIONS.md).

---

## Quickstart

**Step 1 — check your machine before installing anything:**

```bash
git clone https://github.com/fsix7115-arch/omni-action-os.git
cd omni-action-os
./scripts/doctor.sh
```

The doctor prints `PASS` / `WARN` / `FAIL` per requirement, reports detected
versions against the tested baseline, checks free disk, RAM and port conflicts,
and recommends a deployment profile. It is **read-only** — it never installs or
modifies anything.

```
  PASS  operating system     Linux 6.8.0-1064-azure (x86_64)
  PASS  disk space           9.0 GB free, 65% used
  PASS  memory               11.9 GB available
  PASS  git                  git version 2.43.0
  WARN  node                 v26.7.0
                            -> Node 26 is newer than the tested baseline (24 LTS)
  PASS  python               3.14.7
  PASS  docker               Docker version 29.8.1
  WARN  postgres client      psql not found
  WARN  ports                in use: 3000

  9 pass, 3 warn, 0 fail
  recommended profile: B — local pro (postgres + redis + worker, via docker compose)
```

Options: `--json` for machine-readable output, `--strict` to treat warnings as
failures, `--out <path>` to save a dated report.

---

## Progress

Built, tested, verified:

| Phase | Status | Evidence |
|---|---|---|
| **0 — landscape & gap check** | done | `docs/WHY_THIS_PROJECT.md` — names the overlapping projects instead of claiming novelty |
| **0 — design review** | done | `docs/DECISIONS.md` — 9 ADRs with rejected alternatives and costs |
| **1 — environment doctor** | done | `scripts/doctor.py`, `scripts/doctor.sh` — 19 tests pass |

Not built yet: the Next.js app, the core domain schema, the capability graph, the
connector SDK, the permission capsule, the plan compiler, execution and the
verifier loop. **Nothing in this repository claims those work.**

Development follows one verified vertical slice at a time — connect one read-only
source, ask a question, get a plan, approve it, execute, verify externally, show
the audit trail — with real evidence at every gate.

---

## Principles we hold ourselves to

- **No faked integrations.** If an API or permission is unavailable, the connector
  is marked unavailable with the real prerequisite named.
- **Pricing mode is data, not marketing.** Every capability carries a
  machine-readable mode: `free` / `self-hosted` / `byo` / `paid` / `unknown`.
  `unknown` is a valid, honest answer.
- **No paywall, rate-limit or ToS bypass.** Ever.
- **Permissions are server-side.** Hiding a button is not access control.
- **Never silently skip a failed step.** If something cannot be verified without a
  credential, we ship a deterministic mock for CI *and* a manual live-test
  checklist marked unverified.
- **Unknown means unknown.** We never report a feature as working on the strength
  of a mock.

---

## Documentation

| File | What it covers |
|---|---|
| [docs/WHY_THIS_PROJECT.md](docs/WHY_THIS_PROJECT.md) | Overlap analysis and the seven architectural commitments |
| [docs/DECISIONS.md](docs/DECISIONS.md) | Architecture decisions, rejected alternatives, known costs |
| [scripts/doctor.py](scripts/doctor.py) | Environment doctor, read-only |
| [tests/test_doctor.py](tests/test_doctor.py) | Doctor test suite |

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The short version: one verified vertical
slice at a time, and every phase ends with runnable evidence — commands, test
output, health checks, screenshots.

## License

MIT — see [LICENSE](LICENSE).