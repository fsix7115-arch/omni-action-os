# Contributing to OmniAction OS

## The rule that matters most

**One verified vertical slice at a time. Every phase ends with runnable evidence.**

Before a phase is done, it must produce: commands you ran, real test output, a
health check, and — for anything user-visible — a screenshot from the actual
running application. If you cannot produce that evidence, the phase is not done.
Write down what is missing instead.

Never mark an untested feature as complete. A README that says "works" about
something only ever exercised against a mock is the single biggest trust failure
in this category, and it is the reason this rule is the first line of this file.

## Local setup

```bash
git clone https://github.com/fsix7115-arch/omni-action-os.git
cd omni-action-os
./scripts/doctor.sh          # before installing anything
```

Then follow `QUICKSTART.md`.

## Before you open a pull request

```bash
python3 -m pytest tests/ -v   # must be 100% green
```

When the Next.js application lands, this becomes typecheck + unit + build + E2E,
and CI runs all of them.

## Rules for contributions

- **No faked integrations.** A connector that cannot reach its real API must say
  so, name the actual prerequisite, and be marked unavailable. Do not ship a
  placeholder that looks like it works.
- **Pricing mode is a field, not a label.** Every capability declares
  `free` / `self-hosted` / `byo` / `paid` / `unknown`. Never present a paid vendor
  as free.
- **Never bypass** a paywall, rate limit, CAPTCHA, anti-bot control, or platform
  terms. A connector that cannot act legally is read-only or absent.
- **Permissions are enforced server-side.** Hiding a button is not access control.
  Every mutation path goes through a permission check that can be tested.
- **The verifier is mandatory.** Do not register an operation in the capability
  graph without declaring how its outcome will be checked. "It returned 200" is
  not verification.
- **Keep commits small and meaningful.** One logical change per commit.

## Reporting a security issue

Do not open a public issue. Email the maintainer with reproduction steps.

## Code of conduct

Be direct and respectful. Critique the code, not the person. Assume good faith.

## License

By contributing you agree to license your work under the [MIT License](LICENSE).
