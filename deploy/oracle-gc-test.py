"""Retention tests use disposable directories and in-memory Docker inventory only."""
import importlib.util
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("oracle_gc", Path(__file__).with_name("oracle_gc.py"))
gc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gc)


def image(name, *, managed=True, tags=None, labels=None, created=None):
    return {"Id": name, "Config": {"Labels": {"io.uimori.managed": "true" if managed else "false",
        "org.opencontainers.image.revision": "a" * 40, **(labels or {})}},
        "RepoTags": ["uimori:candidate-" + "a" * 40] if tags is None else tags,
        **({"Created": created} if created else {})}


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

    def test_tagged_managed_uimori_images_beyond_candidate_names_are_collected(self):
        self.images.append(image("old-tagged", tags=["uimori:release-0.9"]))
        self.images.append(image("other-registry", tags=["registry.example/uimori:legacy"]))
        plan = self.plan()
        self.assertIn("old-tagged", plan["images"])
        self.assertNotIn("other-registry", plan["images"])

    def test_intermediate_uimori_layers_require_label_age_and_no_container(self):
        old = (datetime.now(timezone.utc) - timedelta(days=4)).isoformat()
        fresh = datetime.now(timezone.utc).isoformat()
        self.images.extend([
            image("old-stage", managed=False, tags=[], labels={"io.uimori.build-layer": "true"}, created=old),
            image("fresh-stage", managed=False, tags=[], labels={"io.uimori.build-layer": "true"}, created=fresh),
            image("unowned-stage", managed=False, tags=[], created=old),
            image("container-stage", managed=False, tags=[], labels={"io.uimori.build-layer": "true"}, created=old),
        ])
        self.containers.append({"Image": "container-stage"})
        plan = self.plan()
        self.assertIn("old-stage", plan["images"])
        self.assertNotIn("fresh-stage", plan["images"])
        self.assertNotIn("unowned-stage", plan["images"])
        self.assertNotIn("container-stage", plan["images"])

    def test_workspace_keeps_active_and_most_recent_unused_candidate(self):
        old = (datetime.now(timezone.utc) - timedelta(days=35)).isoformat()
        newer = (datetime.now(timezone.utc) - timedelta(days=10)).isoformat()
        self.containers.append({"Name": "/tia-workspace-workspace-1",
                                "Image": "tia-workspace", "State": {"Running": True, "Health": {"Status": "healthy"}}})
        self.images.extend([
            image("ws-old", managed=False, tags=["sisters-workspace-candidate:1.0.4"], created=old),
            image("ws-previous", managed=False, tags=["sisters-workspace-candidate:1.1.1"], created=newer),
            image("ws-thirdparty", managed=False, tags=["another-repository:old"], created=old),
        ])
        plan = self.plan()
        self.assertIn("ws-old", plan["images"])
        self.assertNotIn("ws-previous", plan["images"])
        self.assertIn("ws-previous", plan["protectedImages"])
        self.assertNotIn("ws-thirdparty", plan["images"])
        self.assertNotIn("tia-workspace", plan["images"])

    def test_explicit_workspace_previous_wins_and_recent_builds_are_spared(self):
        old = (datetime.now(timezone.utc) - timedelta(days=40)).isoformat()
        fresh = datetime.now(timezone.utc).isoformat()
        self.containers.append({"Name": "/tia-workspace-workspace-1",
                                "Image": "tia-workspace", "State": {"Running": True, "Health": {"Status": "healthy"}}})
        self.images.extend([
            image("ws-prev", managed=False, tags=[gc.WORKSPACE_ROLLBACK_TAG], created=old),
            image("ws-old", managed=False, tags=["tia-workspace-candidate:1.0.4"], created=old),
            image("ws-new", managed=False, tags=["sisters-workspace-candidate:1.2.0"], created=fresh),
        ])
        plan = self.plan()
        self.assertIn("ws-prev", plan["protectedImages"])
        self.assertNotIn("ws-prev", plan["images"])
        self.assertNotIn("ws-new", plan["images"])
        self.assertIn("ws-old", plan["images"])
        self.containers.remove(self.containers[-1])
        self.assertNotIn("ws-old", self.plan()["images"], "No running Workspace means no cross-service cleanup")

    def test_workspace_ambiguous_previous_fails_closed(self):
        old = (datetime.now(timezone.utc) - timedelta(days=40)).isoformat()
        self.containers.append({"Name": "/tia-workspace-workspace-1",
                                "Image": "tia-workspace", "State": {"Running": True, "Health": {"Status": "healthy"}}})
        self.images.extend([
            image("ws-old", managed=False, tags=["sisters-workspace-candidate:1.0"], created=old),
            image("ws-no-date", managed=False, tags=["sisters-workspace-candidate:1.1"]),
        ])
        self.assertNotIn("ws-old", self.plan()["images"])
        self.images[-1]["Created"] = old
        self.images[-1]["RepoTags"] = [gc.WORKSPACE_ROLLBACK_TAG]
        self.assertIn("ws-old", self.plan()["images"])
        self.containers[-1]["State"]["Health"]["Status"] = "unhealthy"
        self.assertNotIn("ws-old", self.plan()["images"])

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
            if args[:2] == ("image", "rm"):
                self.images = [item for item in self.images if item["Id"] != args[-1]]
                return ""
            if args == ("image", "ls", "-aq", "--no-trunc"):
                return "\n".join(item["Id"] for item in self.images)
            raise AssertionError(args)
        outcome = gc.apply_plan(self.plan(), self.root, docker)
        self.assertEqual(outcome["status"], "PASS")
        self.assertEqual(calls, [
            ("image", "rm", "obsolete"),
            ("image", "ls", "-aq", "--no-trunc"),
        ])
        self.assertFalse(obsolete.exists())
        self.assertTrue((self.current / "private/data/uimori.sqlite").is_file())
        next_plan = self.plan()
        self.assertEqual(next_plan["images"], [])
        self.assertEqual(next_plan["directories"], [])

    def test_multi_tagged_workspace_image_untags_exact_refs_without_force(self):
        self.containers.append({"Name": "/tia-workspace-workspace-1", "Image": "tia-workspace",
                                "State": {"Running": True, "Health": {"Status": "healthy"}}})
        from datetime import datetime, timedelta, timezone
        stamp = (datetime.now(timezone.utc) - timedelta(days=40)).isoformat()
        target = image("ws-old", managed=False, tags=["sisters-workspace-candidate:old",
                        "tia-workspace-local:old"], created=stamp)
        previous = image("ws-previous", managed=False,
                         tags=[gc.WORKSPACE_ROLLBACK_TAG], created=stamp)
        self.images.extend([target, previous])
        seen = []
        def docker(*args):
            seen.append(args)
            if args[:2] == ("image", "inspect"):
                tag = args[2]
                matches = [item for item in self.images if tag in item.get("RepoTags", [])]
                return json.dumps(matches)
            if args[:2] == ("image", "rm"):
                tag = args[2]
                if tag == "obsolete":
                    self.images = [item for item in self.images if item["Id"] != "obsolete"]
                else:
                    target["RepoTags"].remove(tag)
                    if not target["RepoTags"]:
                        self.images.remove(target)
                return ""
            if args == ("image", "ls", "-aq", "--no-trunc"):
                return "\n".join(item["Id"] for item in self.images)
            raise AssertionError(args)
        plan = self.plan()
        self.assertEqual(plan["imageTags"]["ws-old"],
                         ["sisters-workspace-candidate:old", "tia-workspace-local:old"])
        result = gc.apply_plan(plan, self.root, docker)
        self.assertEqual(result["status"], "PASS", result)
        self.assertIn("ws-old", result["removed"]["images"])
        self.assertEqual([call for call in seen if call[:2] == ("image", "rm") and call[2] != "obsolete"], [
            ("image", "rm", "sisters-workspace-candidate:old"),
            ("image", "rm", "tia-workspace-local:old"),
        ])
        self.assertIn(previous, self.images)

    def test_multi_tagged_image_rebound_tag_refuses_all_removal(self):
        plan = {"images": ["old"], "imageTags": {"old": ["uimori:old", "uimori:old-alias"]},
                "directories": []}
        calls = []
        def docker(*args):
            calls.append(args)
            if args[:2] == ("image", "inspect"):
                return json.dumps([{"Id": "other" if args[2] == "uimori:old-alias" else "old"}])
            if args == ("image", "ls", "-aq", "--no-trunc"):
                return "old"
            raise AssertionError("Unexpected mutation: " + repr(args))
        outcome = gc.apply_plan(plan, self.root, docker)
        self.assertEqual(outcome["status"], "WARN")
        self.assertFalse(any(call[:2] == ("image", "rm") for call in calls))
        self.assertEqual(outcome["removed"]["images"], [])

    def test_cascading_docker_reclamation_is_success_not_a_stale_plan_warning(self):
        self.images.extend([image("obsolete-a"), image("obsolete-b")])
        plan = {"images": ["obsolete-a", "obsolete-b"], "directories": []}
        calls = []
        def docker(*args):
            calls.append(args)
            if args == ("image", "rm", "obsolete-a"):
                self.images = [item for item in self.images
                               if item["Id"] not in {"obsolete-a", "obsolete-b"}]
                return ""
            if args == ("image", "ls", "-aq", "--no-trunc"):
                return "\n".join(item["Id"] for item in self.images)
            raise AssertionError(args)
        outcome = gc.apply_plan(plan, self.root, docker)
        self.assertEqual(outcome["status"], "PASS")
        self.assertEqual(outcome["removed"]["images"], ["obsolete-a", "obsolete-b"])
        self.assertEqual(outcome["warnings"], [])
        self.assertEqual(calls, [
            ("image", "rm", "obsolete-a"),
            ("image", "ls", "-aq", "--no-trunc"),
        ])

    def test_missing_image_after_failed_rm_is_reclaimed_but_present_image_warns(self):
        self.images.extend([image("gone"), image("busy")])
        plan = {"images": ["gone", "busy"], "directories": []}
        def docker(*args):
            if args == ("image", "rm", "gone"):
                self.images = [item for item in self.images if item["Id"] != "gone"]
                raise RuntimeError("No such image")
            if args == ("image", "rm", "busy"):
                raise RuntimeError("image is referenced")
            if args == ("image", "ls", "-aq", "--no-trunc"):
                return "\n".join(item["Id"] for item in self.images)
            raise AssertionError(args)
        outcome = gc.apply_plan(plan, self.root, docker)
        self.assertEqual(outcome["status"], "WARN")
        self.assertIn("gone", outcome["removed"]["images"])
        self.assertEqual(len(outcome["warnings"]), 1)
        self.assertIn("busy", outcome["warnings"][0])
        self.assertIn("image still exists", outcome["warnings"][0])

    def test_cleanup_errors_are_warnings_and_new_active_state_prevents_removal(self):
        obsolete = self.record("obsolete", 10)
        plan = self.plan()
        record = json.loads((obsolete / "oracle-summary.json").read_text())
        record["status"] = "RUNNING"
        (obsolete / "oracle-summary.json").write_text(json.dumps(record))
        def unavailable(*args):
            if args == ("image", "ls", "-aq", "--no-trunc"):
                return "\n".join(item["Id"] for item in self.images)
            raise OSError("image in use")
        outcome = gc.apply_plan(plan, self.root, unavailable)
        self.assertEqual(outcome["status"], "WARN")
        self.assertTrue(obsolete.exists())
        self.assertEqual(outcome["removed"], {"images": [], "directories": []})

    def test_arbitrary_directory_in_a_plan_is_rejected(self):
        alien = self.root.parent / "do-not-delete"; alien.mkdir()
        outcome = gc.apply_plan({"images": [], "directories": [str(alien)]}, self.root, lambda *_: "")
        self.assertEqual(outcome["status"], "WARN")
        self.assertTrue(alien.exists())

    def test_inventory_failure_is_an_incomplete_preview_not_an_empty_success(self):
        calls = []
        def unavailable(*args):
            calls.append(args)
            raise RuntimeError("Docker inventory failed")
        result = gc.collect_garbage("/unused", self.root, unavailable)
        self.assertEqual(result["status"], "WARN")
        self.assertEqual(result["warnings"], ["Docker inventory failed"])
        self.assertEqual(result["images"], [])
        self.assertEqual(result["directories"], [])
        self.assertEqual(calls, [("ps", "-aq")])
        self.assertTrue(self.current.exists())

    def test_no_managed_successful_receipt_means_no_gc(self):
        record = json.loads((self.current / "oracle-summary.json").read_text())
        record["managedBy"] = "old"
        (self.current / "oracle-summary.json").write_text(json.dumps(record))
        with self.assertRaisesRegex(RuntimeError, "no managed successful"): self.plan()


if __name__ == "__main__":
    unittest.main()
