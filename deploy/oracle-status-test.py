"""Recovery inspection tests use disposable receipts and synthetic process responses."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

# Windows has no flock; the fixture only models this read-only lock probe.
if sys.platform == "win32":
    sys.modules["fcntl"] = SimpleNamespace(LOCK_EX=1, LOCK_NB=2, flock=lambda *_: None)
spec = importlib.util.spec_from_file_location("oracle_status", Path(__file__).with_name("oracle-status.py"))
status = importlib.util.module_from_spec(spec)
spec.loader.exec_module(status)


class RecoveryInspection(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.app = self.root / "app"; self.app.mkdir()
        self.releases = self.root / "releases"; self.releases.mkdir()
        self.release = self.releases / "run"; self.release.mkdir()
        self.receipt = {"status": "RUNNING", "writes": "REOPENING", "commit": "a" * 40}
        (self.release / "oracle-summary.json").write_text(json.dumps(self.receipt))
        (self.root / "deploy.lock").write_text("")
        self.calls = []
        self.container_failure = False
        self.state = {"Image": "sha256:current", "State": {"Status": "running", "Health": {"Status": "healthy"}},
                      "Mounts": [{"Destination": "/data", "Name": "user-data"}]}

    def command(self, args, **kwargs):
        self.calls.append(tuple(args))
        if args == ("sudo", "-n", "docker", "inspect", "uimori-app-1"):
            if self.container_failure:
                return subprocess.CompletedProcess(args, 1, "private stdout", "private stderr")
            output = json.dumps([self.state])
        elif args == ("git", "rev-parse", "HEAD"):
            output = "a" * 40
        elif args == ("git", "status", "--porcelain"):
            output = ""
        else:
            raise AssertionError(args)
        return subprocess.CompletedProcess(args, 0, output, "")

    def inspect(self, run_id=""):
        with patch.object(status.subprocess, "run", self.command):
            return status.inspect(str(self.app), str(self.releases), run_id)

    def test_container_failure_preserves_independent_recovery_evidence(self):
        self.container_failure = True
        result = self.inspect("run")
        self.assertEqual(result["status"], "WARN")
        self.assertIsNone(result["container"])
        self.assertEqual(result["release"], self.receipt)
        self.assertEqual(result["checkout"], "a" * 40)
        self.assertIs(result["dirty"], False)
        self.assertIs(result["lockBusy"], False)
        self.assertTrue(any("container" in warning for warning in result["warnings"]))
        self.assertNotIn("private", json.dumps(result))

    def test_corrupt_receipt_does_not_hide_the_live_container_or_git_state(self):
        (self.release / "oracle-summary.json").write_text("{private invalid receipt")
        older = self.releases / "older"; older.mkdir()
        (older / "oracle-summary.json").write_text(json.dumps({"status": "PASS"}))
        os.utime(older, (100, 100)); os.utime(self.release, (200, 200))
        result = self.inspect()
        self.assertEqual(result["status"], "WARN")
        self.assertIsNone(result["release"])
        self.assertEqual(result["container"]["image"], "sha256:current")
        self.assertEqual(result["checkout"], "a" * 40)
        self.assertTrue(any("release" in warning for warning in result["warnings"]))
        self.assertNotIn("private", json.dumps(result))

    def test_success_and_missing_requested_run_keep_the_existing_contract(self):
        result = self.inspect("run")
        self.assertEqual(result, {"status": "STATUS", "lockBusy": False, "checkout": "a" * 40,
            "dirty": False, "container": {"status": "running", "health": "healthy",
            "image": "sha256:current", "dataVolumes": ["user-data"]}, "release": self.receipt})
        missing = self.inspect("does-not-exist")
        self.assertEqual(missing["status"], "STATUS")
        self.assertIsNone(missing["release"])


if __name__ == "__main__":
    unittest.main()
