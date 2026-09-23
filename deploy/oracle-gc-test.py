"""Retention tests use disposable directories and in-memory Docker inventory only."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("oracle_gc", Path(__file__).with_name("oracle_gc.py"))
gc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gc)


def image(name, *, managed=True, tags=None):
    return {"Id": name, "Config": {"Labels": {"io.uimori.managed": "true" if managed else "false",
        "org.opencontainers.image.revision": "a" * 40}},
        "RepoTags": ["uimori:candidate-" + "a" * 40] if tags is None else tags}


class GarbageCollection(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve() / "releases"
        self.root.mkdir()
        self.live = {"Name": "/uimori-app-1", "Image": "current", "State": {"Health": {"Status": "healthy"}},
            "Mounts": [{"Destination": "/data", "Name": "live-data"}]}
        self.containers = [self.live, {"Image": "pocketrisu"}, {"Image": "tia-workspace"}, {"Image": "stopped-app"}]
        self.images = [image(name) for name in ["current", "previous", "obsolete", "stopped-app"]]
        self.images += [image("pocketrisu", managed=False), image("tia-workspace", managed=False),
            image("registry-image", tags=["my-registry/uimori:keep"])]
        self.current = self.record("current", 100, image="current", previousImage="previous")
        for file in [self.current / "private/environment", self.current / "private/data/uimori.sqlite"]:
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text("synthetic recovery fixture")

    def record(self, name, time, **changes):
        directory = self.root / name
        directory.mkdir()
        record = {"managedBy": gc.MANAGER, "status": "PASS", "finishedAt": time,
            "report": str(directory / "oracle-summary.json"), "cleanup": {"status": "PASS"},
            "writes": "OPEN", "rollback": "NOT_NEEDED", "image": "obsolete", "volume": "live-data",
            "backup": {"integrity": "ok"}, "smoke": {"status": "PASS"}, **changes}
        (directory / "oracle-summary.json").write_text(json.dumps(record))
        return directory

    def plan(self):
        return gc.plan_gc(self.root, self.live, self.containers, self.images)

    def test_current_and_previous_recovery_pair_and_unrelated_containers_are_protected(self):
        obsolete = self.record("obsolete", 10)
        result = self.plan()
        self.assertEqual(result["images"], ["obsolete"])
        self.assertEqual(result["directories"], [str(obsolete)])
        self.assertIn("previous", result["protectedImages"])
        self.assertIn("stopped-app", result["protectedImages"])
        self.assertEqual(result["recovery"], str(self.current))
        self.assertTrue(obsolete.exists(), "preview cannot remove files")

    def test_five_failure_records_and_interrupted_images_remain_available(self):
        for index in range(7): self.record("failure-" + str(index), index + 10, status="FAIL", rollback="PASS")
        interrupted = self.record("interrupted", None, status="RUNNING", image="uncertain", previousImage="uncertain-old")
        self.images.extend([image("uncertain"), image("uncertain-old")])
        result = self.plan()
        self.assertEqual(result["directories"], [str(self.root / "failure-0"), str(self.root / "failure-1")])
        self.assertIn(str(interrupted), result["protectedDirectories"])
        self.assertNotIn("uncertain", result["images"])
        self.assertNotIn("uncertain-old", result["images"])

    def test_unmanaged_and_symlink_directories_are_not_adopted_for_cleanup(self):
        unowned = self.record("old-runner", 1, managedBy="older-runner")
        alien = self.root / "unrelated"; alien.mkdir()
        result = self.plan()
        self.assertIn(str(unowned), result["unknownDirectories"])
        self.assertIn(str(alien), result["unknownDirectories"])
        self.assertFalse(result["directories"])

    def test_incomplete_backup_missing_image_bad_volume_or_unhealthy_app_blocks_deletion(self):
        file = self.current / "private/data/uimori.sqlite"
        file.unlink()
        with self.assertRaisesRegex(RuntimeError, "recovery files"): self.plan()
        file.write_text("synthetic backup")
        previous = self.images.pop(1)
        with self.assertRaisesRegex(RuntimeError, "images must both"): self.plan()
        self.images.insert(1, previous)
        self.live["Mounts"][0]["Name"] = "different-data"
        with self.assertRaisesRegex(RuntimeError, "data volume"): self.plan()
        self.live["Mounts"][0]["Name"] = "live-data"
        self.live["State"]["Health"]["Status"] = "unhealthy"
        with self.assertRaisesRegex(RuntimeError, "not healthy"): self.plan()

    def test_apply_only_uses_explicit_unforced_image_removal_and_is_repeatable(self):
        obsolete = self.record("obsolete", 10)
        calls = []
        def docker(*args):
            calls.append(args)
            self.images = [item for item in self.images if item["Id"] != args[-1]]
        outcome = gc.apply_plan(self.plan(), self.root, docker)
        self.assertEqual(outcome["status"], "PASS")
        self.assertEqual(calls, [("image", "rm", "obsolete")])
        self.assertFalse(obsolete.exists())
        self.assertTrue((self.current / "private/data/uimori.sqlite").is_file())
        next_plan = self.plan()
        self.assertEqual(next_plan["images"], [])
        self.assertEqual(next_plan["directories"], [])

    def test_cleanup_errors_are_warnings_and_new_active_state_prevents_removal(self):
        obsolete = self.record("obsolete", 10)
        plan = self.plan()
        record = json.loads((obsolete / "oracle-summary.json").read_text())
        record["status"] = "RUNNING"
        (obsolete / "oracle-summary.json").write_text(json.dumps(record))
        def unavailable(*_): raise OSError("image in use")
        outcome = gc.apply_plan(plan, self.root, unavailable)
        self.assertEqual(outcome["status"], "WARN")
        self.assertTrue(obsolete.exists())
        self.assertEqual(outcome["removed"], {"images": [], "directories": []})

    def test_arbitrary_directory_in_a_plan_is_rejected(self):
        alien = self.root.parent / "do-not-delete"; alien.mkdir()
        outcome = gc.apply_plan({"images": [], "directories": [str(alien)]}, self.root, lambda *_: "")
        self.assertEqual(outcome["status"], "WARN")
        self.assertTrue(alien.exists())

    def test_no_managed_successful_receipt_means_no_gc(self):
        record = json.loads((self.current / "oracle-summary.json").read_text())
        record["managedBy"] = "old"
        (self.current / "oracle-summary.json").write_text(json.dumps(record))
        with self.assertRaisesRegex(RuntimeError, "no managed successful"): self.plan()


if __name__ == "__main__":
    unittest.main()
