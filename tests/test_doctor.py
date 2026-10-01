"""
Tests for the environment doctor.

The doctor is the first thing a new user runs, and it runs on machines we do
not control. That makes it the highest-risk piece of code in the repository by
usage: a wrong answer here sends someone down the wrong path before they have
written a line of their own code.

These tests cover the pure helpers (version parsing, port detection, disk
parsing, profile selection) and one end-to-end invocation. They need no
network and no elevated permissions.

Run:  python3 -m pytest tests/test_doctor.py -v
"""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOCTOR = ROOT / "scripts" / "doctor.py"

# Load the doctor as a module. It lives outside the package tree, so a plain
# import would not find it.
_spec = importlib.util.spec_from_file_location("doctor", DOCTOR)
doctor = importlib.util.module_from_spec(_spec)
assert _spec and _spec.loader
# dataclasses resolves type hints by looking the defining module up in
# sys.modules. Without this registration, @dataclass fails with
# "AttributeError: 'NoneType' object has no attribute '__dict__'".
sys.modules["doctor"] = doctor
_spec.loader.exec_module(doctor)


class TestVersionParsing(unittest.TestCase):
    """The doctor must not misread a version and invent a PASS."""

    def test_common_shapes(self):
        cases = {
            "v20.11.0": (20, 11, 0),
            "v24.2.1": (24, 2, 1),
            "3.14.7": (3, 14, 7),
            "git version 2.43.0": (2, 43, 0),
            "npm 11.19.0": (11, 19, 0),
            "Docker version 29.8.1-1, build 4b1a2c": (29, 8, 1),
            "psql (PostgreSQL) 18.6 (Ubuntu)": (18, 6),
        }
        for text, want in cases.items():
            with self.subTest(text=text):
                self.assertEqual(doctor.parse_version(text), want)

    def test_returns_none_when_absent(self):
        for text in ("not a version", "", "unknown", "no digits here"):
            with self.subTest(text=text):
                self.assertIsNone(doctor.parse_version(text))

    def test_single_digit_is_not_a_version(self):
        # "python3" would otherwise parse as (3,) and pass the minimum check.
        self.assertIsNone(doctor.parse_version("python3"))


class TestDiskParsing(unittest.TestCase):
    def test_units(self):
        cases = {
            "1K": 1024,
            "1M": 1024**2,
            "1G": 1024**3,
            "1T": 1024**4,
            "512": 512,
            "1.5G": int(1.5 * 1024**3),
        }
        for text, want in cases.items():
            with self.subTest(text=text):
                self.assertEqual(doctor.gnu_to_bytes(text), want)

    def test_garbage_is_zero(self):
        self.assertEqual(doctor.gnu_to_bytes("not a size"), 0)
        self.assertEqual(doctor.gnu_to_bytes(""), 0)


class TestPortDetection(unittest.TestCase):
    def test_unused_high_port_is_free(self):
        # Pick a port in the ephemeral range so we never collide with a real
        # service the way PORT_IN_USE would.
        self.assertTrue(doctor.port_free(45123))

    def test_socket_open_is_not_free(self):
        import socket
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.bind(("127.0.0.1", 0))
        s.listen(1)
        try:
            self.assertFalse(doctor.port_free(s.getsockname()[1]))
        finally:
            s.close()


class TestProfileSelection(unittest.TestCase):
    """The recommended profile must follow what is present, not what passed.

    A Node that is newer than our tested baseline still works; recommending the
    browser-only profile to someone with Node installed would be actively wrong.
    """

    @staticmethod
    def _report(*rows):
        """Build a report. `found` defaults to a truthy marker so that a
        PASS/WARN row counts as an installed tool, matching what the real
        checks record. Pass ("docker", WARN, None) to model "not installed".
        """
        r = doctor.Report()
        for row in rows:
            name, status, found = (list(row) + ["1.0"])[:3]
            r.add(name, status, found=found)
        return r

    def test_no_failures_means_a_profile(self):
        r = self._report(("node", doctor.PASS))
        r.profile = doctor.pick_profile(r)
        self.assertTrue(r.profile.startswith("A"))

    def test_fail_blocks_everything(self):
        r = self._report(("node", doctor.PASS), ("git", doctor.FAIL))
        r.profile = doctor.pick_profile(r)
        self.assertIn("none", r.profile)

    def test_docker_upgrades_to_pro(self):
        r = self._report(("node", doctor.PASS), ("docker", doctor.PASS))
        r.profile = doctor.pick_profile(r)
        self.assertTrue(r.profile.startswith("B"))

    def test_missing_docker_gives_lite(self):
        # docker WARN with no `found` means "not installed", not "too new".
        r = self._report(("node", doctor.PASS), ("docker", doctor.WARN, None))
        r.profile = doctor.pick_profile(r)
        self.assertTrue(r.profile.startswith("A"))

    def test_warned_node_still_counts_as_present(self):
        # Node 26 vs the 24 LTS baseline produces WARN. The user still has Node.
        r = self._report(("node", doctor.WARN), ("docker", doctor.WARN, None))
        r.profile = doctor.pick_profile(r)
        self.assertNotIn("browser client", r.profile)

    def test_no_node_means_browser_client(self):
        r = self._report(("git", doctor.PASS), ("node", doctor.WARN, None))
        r.profile = doctor.pick_profile(r)
        self.assertIn("browser client", r.profile)


class TestReport(unittest.TestCase):
    def test_worst_status_priority(self):
        r = doctor.Report()
        self.assertEqual(r.worst, doctor.PASS)
        r.add("a", doctor.WARN)
        self.assertEqual(r.worst, doctor.WARN)
        r.add("b", doctor.FAIL)
        self.assertEqual(r.worst, doctor.FAIL)

    def test_counts(self):
        r = doctor.Report()
        for s in (doctor.PASS, doctor.PASS, doctor.WARN, doctor.FAIL):
            r.add("x", s)
        self.assertEqual(r.count(doctor.PASS), 2)
        self.assertEqual(r.count(doctor.WARN), 1)
        self.assertEqual(r.count(doctor.FAIL), 1)


class TestDoctorEndToEnd(unittest.TestCase):
    """Actually run it, because the point of a doctor is that it runs."""

    def test_runs_and_emits_valid_json(self):
        p = subprocess.run(
            [sys.executable, str(DOCTOR), "--json"],
            capture_output=True, text=True, timeout=120,
        )
        self.assertEqual(p.returncode, 0, p.stderr)
        payload = json.loads(p.stdout)

        self.assertIn(payload["overall"], ("PASS", "WARN", "FAIL"))
        self.assertTrue(payload["profile"])
        self.assertGreater(len(payload["checks"]), 8)

        names = {c["name"] for c in payload["checks"]}
        for required in ("operating system", "git", "python", "disk space"):
            self.assertIn(required, names)

        # Every check must carry a status and a human-readable detail.
        for c in payload["checks"]:
            self.assertIn(c["status"], ("PASS", "WARN", "FAIL"), c)
            self.assertTrue(c["detail"], c)

    def test_shell_wrapper_matches_python_entrypoint(self):
        sh = ROOT / "scripts" / "doctor.sh"
        self.assertTrue(sh.exists())
        p = subprocess.run(
            ["bash", str(sh), "--json"], capture_output=True, text=True, timeout=120,
        )
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn("profile", json.loads(p.stdout))

    def test_writes_report_file_when_asked(self):
        out = ROOT / "reports" / "test-environment.json"
        p = subprocess.run(
            [sys.executable, str(DOCTOR), "--json", "--out", str(out)],
            capture_output=True, text=True, timeout=120,
        )
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertTrue(out.exists())
        with open(out) as f:
            self.assertIn("checks", json.load(f))
        out.unlink()

    def test_is_read_only(self):
        """The doctor must never modify the machine it inspects."""
        before = sorted(os.listdir(ROOT))
        subprocess.run(
            [sys.executable, str(DOCTOR)], capture_output=True, timeout=120,
        )
        self.assertEqual(sorted(os.listdir(ROOT)), before)


if __name__ == "__main__":
    unittest.main(verbosity=2)