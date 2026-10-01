#!/usr/bin/env python3
"""
Environment doctor for OmniAction OS.

Run this BEFORE installing anything. It reports PASS / WARN / FAIL for each
requirement so you know what is missing instead of discovering it as a
mysterious build error forty minutes in.

    python3 scripts/doctor.py
    python3 scripts/doctor.py --json     # machine-readable, for CI
    python3 scripts/doctor.py --strict   # treat WARN as failure

Design rules:
  - Read-only. This script never installs, writes or modifies anything.
  - Exit 0 on success, 1 if any check FAILs (or, with --strict, any WARN).
  - Every version reported is the version actually detected on this machine.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import re
import shutil
import socket
import subprocess
import sys
from dataclasses import asdict, dataclass, field

# --------------------------------------------------------------------------
# What we require. These are the tested baselines, not "latest forever" —
# docs/COMPATIBILITY.md records what was actually exercised.
# --------------------------------------------------------------------------

MIN_NODE = (20, 0, 0)
MIN_PYTHON = (3, 10, 0)
MIN_NODE_LTS = (24, 0, 0)  # recommended, not required
MIN_POSTGRES_MAJOR = 15
MIN_DOCKER_MAJOR = 20

PORTS_IN_USE = [3000, 5432, 6379, 8000, 9000]

DISK_WARN_PCT = 90       # disk more than this full is a WARN
DISK_FAIL_FREE_GB = 1.0  # under this much free, installing will fail
RAM_WARN_GB = 2.0        # below this the stack will thrash

PASS, WARN, FAIL = "PASS", "WARN", "FAIL"

@dataclass
class Check:
    name: str
    status: str
    detail: str = ""
    found: str | None = None
    required: str | None = None
    hint: str | None = None

@dataclass
class Report:
    checks: list[Check] = field(default_factory=list)
    profile: str = "unknown"
    notes: list[str] = field(default_factory=list)

    def add(self, *a, **kw) -> None:
        self.checks.append(Check(*a, **kw))

    def count(self, status: str) -> int:
        return sum(1 for c in self.checks if c.status == status)

    def installed(self, name: str) -> bool:
        """True if the tool exists at all, regardless of why it did not PASS.

        A WARN here means two very different things: "installed but newer than
        our baseline" versus "not installed". Only the first counts as present
        when choosing a profile, so this checks `found` rather than status.
        """
        for c in self.checks:
            if c.name == name:
                return c.found is not None
        return False

    @property
    def worst(self) -> str:
        if self.count(FAIL):
            return FAIL
        if self.count(WARN):
            return WARN
        return PASS


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------

def run(cmd: list[str], timeout: int = 10) -> tuple[int, str]:
    """Run a command, return (exit_code, combined_output). Never raises."""
    try:
        p = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout,
            # Keep the child from inheriting a broken terminal on Windows.
            errors="replace",
        )
        return p.returncode, (p.stdout or "") + (p.stderr or "")
    except FileNotFoundError:
        return 127, ""
    except subprocess.TimeoutExpired:
        return 124, ""
    except OSError as e:
        return 1, str(e)


def parse_version(text: str) -> tuple[int, ...] | None:
    """Pull the first dotted numeric version out of arbitrary tool output."""
    m = re.search(r"(\d+(?:\.\d+){1,3})", text)
    if not m:
        return None
    try:
        return tuple(int(p) for p in m.group(1).split("."))
    except ValueError:
        return None


def port_free(port: int) -> bool:
    """True if nothing is listening. We connect, rather than bind."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.35)
        return s.connect_ex(("127.0.0.1", port)) != 0


def gnu_to_bytes(human: str) -> int:
    m = re.match(r"([\d.]+)\s*([KMGTP]?)", human.strip())
    if not m:
        return 0
    val, unit = float(m.group(1)), m.group(2).upper()
    mult = {"": 1, "K": 1024, "M": 1024**2, "G": 1024**3,
            "T": 1024**4, "P": 1024**5}[unit]
    return int(val * mult)


# --------------------------------------------------------------------------
# individual checks
# --------------------------------------------------------------------------

def check_os(r: Report) -> None:
    system, release = platform.system(), platform.release()
    machine = platform.machine()
    if system in ("Linux", "Darwin"):
        r.add("operating system", PASS, f"{system} {release} ({machine})")
    elif system == "Windows":
        # Docker Desktop needs WSL2 on Windows 10/11. Flag the unsupported case
        # the build guide calls out, rather than failing obscurely later.
        try:
            major = int(platform.version().split('.')[0])
        except (ValueError, IndexError):
            major = 0
        if major < 10:
            r.add("operating system", WARN,
                  f"Windows {major} — Docker Desktop needs Windows 10/11 + WSL 2",
                  hint="Use this machine as a browser client and run the server elsewhere.")
        else:
            r.add("operating system", PASS, f"Windows {major} ({machine})",
                  hint="Docker Desktop also needs WSL 2 enabled.")
    else:
        r.add("operating system", WARN, f"unrecognised platform {system!r}")

    if machine not in ("x86_64", "amd64", "arm64", "aarch64"):
        r.add("cpu architecture", WARN, f"unusual: {machine}",
              hint="We test x86_64 and arm64.")
    else:
        r.add("cpu architecture", PASS, machine)


def check_git(r: Report) -> None:
    if not shutil.which("git"):
        r.add("git", FAIL, "not found", hint="https://git-scm.com/downloads")
        return
    code, out = run(["git", "--version"])
    v = parse_version(out)
    r.add("git", PASS if v else WARN, out.strip() or "found but no version",
          found=str(v) if v else None)


def check_node(r: Report) -> None:
    if not shutil.which("node"):
        r.add("node", WARN, "not found",
              hint="Optional for the local-lite profile; required for the web UI.",
              required=f">= {MIN_NODE_LTS[0]} LTS recommended")
        return
    code, out = run(["node", "--version"])
    v = parse_version(out)
    if not v:
        r.add("node", WARN, out.strip())
        return
    if v < MIN_NODE:
        status = FAIL
        hint = f"Node {MIN_NODE[0]}+ required"
    elif v[0] > MIN_NODE_LTS[0]:
        status = WARN
        hint = (f"Node {v[0]} is newer than the tested baseline "
                f"({MIN_NODE_LTS[0]} LTS). Usually fine, but not what we test.")
    elif v < MIN_NODE_LTS:
        status = PASS
        hint = None
    else:
        status = PASS
        hint = None
    r.add("node", status, f"v{v[0]}.{v[1]}.{v[2]}" if len(v) > 2 else str(v),
          found=f"{v[0]}.{v[1]}", required=f">={MIN_NODE[0]} (24 LTS recommended)",
          hint=hint)


def check_python(r: Report) -> None:
    v = sys.version_info[:3]
    if v < MIN_PYTHON:
        r.add("python", FAIL, f"{v[0]}.{v[1]}.{v[2]}",
              hint=f"Python {MIN_PYTHON[0]}+ required")
    else:
        r.add("python", PASS, f"{v[0]}.{v[1]}.{v[2]}",
              found=f"{v[0]}.{v[1]}", required=f">={MIN_PYTHON[0]}")


def check_package_manager(r: Report) -> None:
    found = [n for n in ("pnpm", "npm", "yarn") if shutil.which(n)]
    if not found:
        r.add("package manager", WARN, "none found (node installed without npm?)")
        return
    name = found[0]
    code, out = run([name, "--version"])
    r.add("package manager", PASS, f"{name} {out.strip()[:40]}", found=out.strip()[:20])


def check_docker(r: Report) -> None:
    if not shutil.which("docker"):
        r.add("docker", WARN, "not found",
              hint="Optional. Required only for the docker profile.",
              required=f">= {MIN_DOCKER_MAJOR}")
        return
    code, out = run(["docker", "--version"])
    if code != 0:
        r.add("docker", WARN, "installed but `docker --version` failed — daemon may be down",
              hint="Start Docker Desktop (or `sudo systemctl start docker`) and re-run.")
        return
    v = parse_version(out)
    status = PASS if v and v[0] >= MIN_DOCKER_MAJOR else WARN
    r.add("docker", status, out.strip(), found=str(v[0]) if v else None,
          required=f">={MIN_DOCKER_MAJOR}",
          hint=None if status == PASS else "Older Docker may not support our compose features.")


def check_postgres_client(r: Report) -> None:
    if not shutil.which("psql"):
        r.add("postgres client", WARN, "psql not found",
              hint="Optional locally. Required to inspect the production database.")
        return
    code, out = run(["psql", "--version"])
    v = parse_version(out)
    status = PASS if v and v[0] >= MIN_POSTGRES_MAJOR else WARN
    r.add("postgres client", status, out.strip(), found=str(v[0]) if v else None,
          required=f">= {MIN_POSTGRES_MAJOR} (18 recommended)")


def check_browser(r: Report) -> None:
    """Playwright browsers are needed for screenshots and E2E, not for running."""
    cache = os.path.expanduser("~/.cache/ms-playwright")
    if os.path.isdir(cache) and any(
        d.startswith(("chromium", "firefox", "webkit")) for d in os.listdir(cache)
    ):
        r.add("playwright browsers", PASS, f"installed under {cache}")
        return
    if shutil.which("playwright"):
        r.add("playwright browsers", WARN, "playwright on PATH but no browser cache",
              hint="Run: npx playwright install chromium")
        return
    r.add("playwright browsers", WARN, "not installed",
          hint="Needed for screenshots and E2E: npx playwright install chromium")


def check_ports(r: Report) -> None:
    busy = [p for p in PORTS_IN_USE if not port_free(p)]
    if busy:
        r.add("ports", WARN, "in use: " + ", ".join(map(str, busy)),
              hint="Free them, or pick different ports in .env.")
    else:
        r.add("ports", PASS, ", ".join(map(str, PORTS_IN_USE)) + " all free")


def check_disk(r: Report) -> None:
    try:
        du = shutil.disk_usage(os.getcwd())
    except OSError as e:
        r.add("disk space", WARN, f"could not read: {e}")
        return
    free_gb = du.free / 1024**3
    used_pct = 100 * du.used / du.total
    detail = f"{free_gb:.1f} GB free, {used_pct:.0f}% used on {os.getcwd()}"
    if free_gb < DISK_FAIL_FREE_GB:
        r.add("disk space", FAIL, detail,
              hint="Installs will fail. Free space and re-run.")
    elif used_pct > DISK_WARN_PCT:
        r.add("disk space", WARN, detail,
              hint="Over 90% full. Docker images and node_modules are large.")
    else:
        r.add("disk space", PASS, detail)


def check_memory(r: Report) -> None:
    try:
        with open("/proc/meminfo") as f:
            for line in f:
                if line.startswith("MemAvailable:"):
                    avail_gb = int(line.split()[1]) / 1024**2
                    break
            else:
                raise KeyError
    except (OSError, ValueError, KeyError):
        r.add("memory", WARN, "could not read (not Linux)")
        return
    if avail_gb < RAM_WARN_GB:
        r.add("memory", WARN, f"{avail_gb:.1f} GB available",
              hint="Below 2 GB the full stack will thrash. Use the local-lite profile.")
    else:
        r.add("memory", PASS, f"{avail_gb:.1f} GB available")


def check_ports_conflict_hint(r: Report) -> None:
    """Warn if something is already bound to our expected dev port."""
    if not port_free(3000):
        r.notes.append(
            "Port 3000 is busy. The dev server will pick another port, or set PORT in .env."
        )


def pick_profile(r: Report) -> str:
    """Recommend a deployment profile from what we actually detected.

    Presence of a tool is what matters here, not whether it scored PASS — a
    Node that is merely newer than our baseline is still perfectly usable, and
    recommending the browser-only profile to someone who has Node installed
    would send them somewhere they do not need to go.
    """
    if r.count(FAIL) > 0:
        return "none — fix the FAIL rows first"

    if not r.installed("node"):
        return "E — browser client only (run the server elsewhere)"

    # docker compose brings its own postgres and redis, so a missing local psql
    # does not block the local-pro profile.
    if r.installed("docker"):
        return "B — local pro (postgres + redis + worker, via docker compose)"
    return "A — local lite (sqlite, one process)"


# --------------------------------------------------------------------------
# output
# --------------------------------------------------------------------------

ICON = {PASS: "PASS", WARN: "WARN", FAIL: "FAIL"}


def render(r: Report) -> None:
    width = max((len(c.name) for c in r.checks), default=10)
    print()
    print("OmniAction OS — environment doctor")
    print("=" * 72)
    for c in r.checks:
        print(f"  {ICON[c.status]:4}  {c.name.ljust(width)}  {c.detail}")
        if c.hint:
            print(f"        {'':{width}}    -> {c.hint}")
    print("=" * 72)
    print(f"  {r.count(PASS)} pass, {r.count(WARN)} warn, {r.count(FAIL)} fail")
    print(f"  recommended profile: {r.profile}")
    for n in r.notes:
        print(f"  note: {n}")
    print()
    if r.count(FAIL):
        print("  Fix the FAIL rows before installing anything.")
    elif r.count(WARN):
        print("  WARN rows are not blockers — read the hints before you start.")
    else:
        print("  Environment looks good. Next: cp .env.example .env && npm install")
    print()


def main() -> int:
    ap = argparse.ArgumentParser(description="OmniAction OS environment doctor")
    ap.add_argument("--json", action="store_true", help="emit JSON instead of text")
    ap.add_argument("--strict", action="store_true", help="treat WARN as failure")
    ap.add_argument("--out", help="also write the report to this path")
    args = ap.parse_args()

    r = Report()
    check_os(r)
    check_disk(r)
    check_memory(r)
    check_git(r)
    check_node(r)
    check_python(r)
    check_package_manager(r)
    check_docker(r)
    check_postgres_client(r)
    check_browser(r)
    check_ports(r)
    check_ports_conflict_hint(r)
    r.profile = pick_profile(r)

    if args.json:
        payload = {
            "overall": r.worst,
            "profile": r.profile,
            "counts": {s: r.count(s) for s in (PASS, WARN, FAIL)},
            "checks": [asdict(c) for c in r.checks],
            "notes": r.notes,
        }
        text = json.dumps(payload, indent=2)
        print(text)
    else:
        render(r)

    if args.out:
        os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
        with open(args.out, "w") as f:
            f.write(json.dumps(
                {"overall": r.worst, "profile": r.profile,
                 "checks": [asdict(c) for c in r.checks]},
                indent=2))

    if r.count(FAIL):
        return 1
    if args.strict and r.count(WARN):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())