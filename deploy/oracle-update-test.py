"""Run the real state machine with disposable directories and controlled host effects."""
import contextlib
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

spec = importlib.util.spec_from_file_location("oracle_runner", Path(__file__).with_name("oracle-update.py"))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class Host(m.Runner):
    def __init__(self, base, *, fault=None, fresh=False, check_only=False, image=None):
        app, release = base / "app", base / "release"
        app.mkdir(); release.mkdir()
        (app / ".env.self-host").write_text("UIMORI_PUBLIC_ORIGIN=https://example.test\nUIMORI_IMAGE=sha256:old\nUIMORI_DATA_VOLUME=old\n")
        args = SimpleNamespace(app_dir=str(app), release_dir=str(release), commit="a" * 40,
            build_id="b" * 64, dist_hash=None, fresh=fresh, check_only=check_only,
            image=image, expected_origin="https://example.test", source_ref="main")
        super().__init__(args)
        self.events = []
        self.fault = fault
        self.live_image = "sha256:old"
        self.live_volume = "old"
        self.closed = False
        self.reason = None
        self.head = "c" * 40

    def run(self, *args, cwd=None, **kwargs):
        self.events.append(args[:2])
        if args[:2] == ("git", "status"): return ""
        if args[:2] == ("git", "rev-parse"):
            return self.args.commit if cwd or args[-1] == "FETCH_HEAD" else self.head
        if args[:2] == ("git", "fetch"):
            assert args[-1] == self.args.commit, "must fetch pinned SHA, never floating main"
        if args[:2] == ("git", "ls-remote"):
            raise AssertionError("advancing main must not invalidate an in-progress pinned release")
        if args[:2] == ("git", "checkout"): self.head = args[-1]
        return ""

    def inspect(self):
        return {"HostConfig": {"PortBindings": {"4310/tcp": [{"HostIp": "127.0.0.1", "HostPort": "4310"}]}},
            "State": {"Health": {"Status": "healthy"}}, "Image": self.live_image,
            "Mounts": [{"Destination": "/data", "Type": "volume", "Name": self.live_volume}],
            "Config": {"Env": ["UIMORI_PUBLIC_ORIGIN=https://example.test"]}}

    def routing(self): return {"stable": True}

    def compose(self, *args, **kwargs):
        self.events.append(("compose", args[0]))
        values = m.environment_values(self.env.read_text())
        if args[0] == "config":
            return json.dumps({"services": {"app": {"image": values["UIMORI_IMAGE"],
                "environment": {"UIMORI_PUBLIC_ORIGIN": "https://example.test"}}},
                "volumes": {"data": {"name": values["UIMORI_DATA_VOLUME"]}}})
        if args[0] == "up":
            assert self.closed, "candidate must not accept user writes during validation"
            self.live_image = values["UIMORI_IMAGE"]
            self.live_volume = values["UIMORI_DATA_VOLUME"]
            if self.fault == "switch": raise RuntimeError("injected switch failure")
        return ""

    def docker(self, *args, **kwargs):
        self.events.append(("docker", args[0]))
        if args[0] == "build" and self.fault == "build": raise RuntimeError("build failed")
        if args[:2] == ("image", "inspect"):
            return json.dumps([{"Id": "sha256:old" if args[-1] == "sha256:old" else "sha256:new",
                "Config": {"Labels": {"io.uimori.managed": "true", "org.opencontainers.image.revision":
                    "wrong" if self.fault == "labels" else self.args.commit}}}])
        if args[0] == "compose":
            self.live_image = "sha256:old"; self.live_volume = "old"
        return ""

    def new_volume(self, suffix, temporary=True): return "isolated-" + suffix

    def probe(self, volume=None):
        self.events.append(("probe", bool(volume)))
        if volume and self.fault == "compatibility": raise RuntimeError("incompatible schema")
        return {"status": "PASS", "identity": {"distHash": "d" * 64}, "database": {"columns": {}}}

    def data(self, action, volume, target=None, **kwargs):
        self.events.append(("data", action))
        if action == "backup":
            if self.fault == "backup": raise RuntimeError("backup failed")
            (self.private / "data" / "uimori.sqlite").write_text("synthetic stopped backup")
            return {"integrity": "ok"}
        if action == "maintenance": return {"status": "closed" if self.closed else "open", "reason": self.reason}
        if action == "close-maintenance": self.closed = True; self.reason = self.owner
        if action == "audit": return {"integrity": "ok"}
        return {}

    def control(self, action, image=None):
        self.events.append(("control", action))
        if action == "close": self.closed = True; self.reason = self.owner
        if action == "smoke":
            assert self.closed
            return {"status": "FAIL" if self.fault == "smoke" else "PASS"}
        if action == "open":
            self.closed = False
            if self.fault == "reopen": raise RuntimeError("open response lost")
        return {"status": "closed" if self.closed else "open", "reason": self.reason, "forcedClosed": False,
            "activeWork": 1 if self.fault == "busy" and self.closed else 0}

    def wait_healthy(self, image, volume):
        self.events.append(("healthy", image))
        if self.fault == "health" and image == "sha256:new": raise RuntimeError("unhealthy candidate")
        assert self.live_image == image and self.live_volume == volume


class OracleTransitions(unittest.TestCase):
    @contextlib.contextmanager
    def host(self, **options):
        with tempfile.TemporaryDirectory() as temp:
            yield Host(Path(temp).resolve(), **options)

    def fail_and_rollback(self, host):
        with self.assertRaises(RuntimeError): host.execute()
        host.rollback()

    def test_update_orders_backup_closed_validation_and_reopen(self):
        with self.host() as host:
            host.execute()
            self.assertEqual(host.summary["status"], "PASS")
            self.assertEqual(host.summary["writes"], "OPEN")
            self.assertEqual(host.live_image, "sha256:new")
            self.assertLess(host.events.index(("control", "close")), host.events.index(("data", "backup")))
            self.assertLess(host.events.index(("data", "backup")), host.events.index(("compose", "up")))
            self.assertLess(host.events.index(("control", "smoke")), host.events.index(("control", "open")))
            self.assertEqual(host.events.count(("docker", "build")), 1)

    def test_check_only_never_closes_stops_or_changes_application(self):
        with self.host(check_only=True) as host:
            host.execute()
            self.assertEqual(host.summary["status"], "PASS")
            self.assertEqual(host.live_image, "sha256:old")
            for event in [("control", "close"), ("data", "backup"), ("compose", "stop"), ("control", "smoke")]:
                self.assertNotIn(event, host.events)

    def test_prebuilt_image_is_not_rebuilt(self):
        with self.host(check_only=True, image="sha256:new") as host:
            host.execute()
            self.assertNotIn(("docker", "build"), host.events)

    def test_prepare_failures_leave_live_application_untouched(self):
        for fault in ["build", "labels", "compatibility"]:
            with self.subTest(fault=fault), self.host(fault=fault) as host:
                self.fail_and_rollback(host)
                self.assertFalse(host.closed)
                self.assertNotIn(("compose", "stop"), host.events)
                self.assertEqual(host.live_image, "sha256:old")

    def test_backup_failure_restarts_old_image_without_restoring_incomplete_backup(self):
        with self.host(fault="backup") as host:
            self.fail_and_rollback(host)
            self.assertEqual(host.summary["rollback"], "PASS")
            self.assertFalse(host.closed)
            self.assertNotIn(("data", "restore"), host.events)

    def test_switch_health_and_https_failure_restore_before_accepting_writes(self):
        for fault in ["switch", "health", "smoke"]:
            with self.subTest(fault=fault), self.host(fault=fault) as host:
                self.fail_and_rollback(host)
                self.assertEqual(host.live_image, "sha256:old")
                self.assertEqual(host.summary["rollback"], "PASS")
                self.assertFalse(host.closed)
                self.assertIn(("data", "restore"), host.events)

    def test_unconfirmed_reopen_never_restores_database(self):
        with self.host(fault="reopen") as host:
            self.fail_and_rollback(host)
            self.assertEqual(host.summary["rollback"], "REFUSED_AFTER_REOPEN")
            self.assertEqual(host.live_image, "sha256:new")
            self.assertNotIn(("data", "restore"), host.events)

    def test_busy_drain_restores_admission_without_cancelling_or_stopping(self):
        original = m.time.sleep
        m.time.sleep = lambda _: None
        try:
            with self.host(fault="busy") as host:
                self.fail_and_rollback(host)
                self.assertFalse(host.closed)
                self.assertNotIn(("compose", "stop"), host.events)
                self.assertNotIn(("data", "restore"), host.events)
        finally: m.time.sleep = original

    def test_fresh_boot_is_closed_before_switch_and_preserves_old_volume(self):
        with self.host(fresh=True) as host:
            host.execute()
            self.assertEqual(host.live_volume, "isolated-data")
            self.assertIn(("data", "close-maintenance"), host.events)
            self.assertEqual(host.old_volume, "old")
        with self.host(fresh=True, fault="smoke") as host:
            self.fail_and_rollback(host)
            self.assertEqual(host.live_volume, "old")
            self.assertNotIn(("data", "restore"), host.events)

    def test_foreign_or_open_gate_prevents_restore(self):
        with self.host(fault="smoke") as host:
            with self.assertRaises(RuntimeError): host.execute()
            host.reason = "another operator"
            with self.assertRaises(RuntimeError): host.rollback()
            self.assertNotIn(("data", "restore"), host.events)

    def test_retention_failure_cannot_undo_successful_deployment(self):
        with self.host() as host:
            host.execute()
            def failure(): raise OSError("injected cleanup failure")
            host.retire = failure
            host.finish()
            self.assertEqual(host.summary["status"], "PASS")
            self.assertEqual(host.summary["writes"], "OPEN")
            self.assertEqual(host.summary["retention"]["status"], "WARN")
            self.assertNotIn(("data", "restore"), host.events)

    def test_temporary_cleanup_warning_is_separate_and_check_only_never_retires(self):
        with self.host() as host:
            host.execute()
            def cleanup(): host.summary["cleanup"] = {"status": "FAIL", "remaining": ["probe"]}
            host.cleanup = cleanup
            host.retire = lambda: {"status": "WARN", "warnings": ["unresolved cleanup"]}
            host.finish()
            self.assertEqual(host.summary["status"], "PASS")
            self.assertEqual(host.summary["cleanup"]["status"], "WARN")
        with self.host(check_only=True) as host:
            host.execute()
            def unexpected(): raise AssertionError("check-only must not garbage collect")
            host.retire = unexpected
            host.finish()
            self.assertNotIn("retention", host.summary)


if __name__ == "__main__":
    unittest.main()
