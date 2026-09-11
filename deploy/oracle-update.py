"""Single-host release runner. No migration and no implicit fresh-data fallback."""
import argparse
import contextlib
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time
from urllib.parse import urlsplit


def arguments(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("commit", "build-id", "dist-hash", "release-dir"):
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--app-dir", default="/opt/uimori/app")
    parser.add_argument("--fresh", action="store_true")
    parser.add_argument("--image")
    parser.add_argument("--check-only", action="store_true")
    parser.add_argument("--expected-origin")
    args = parser.parse_args(argv)
    for name, length in (("commit", 40), ("build_id", 64), ("dist_hash", 64)):
        if not re.fullmatch("[0-9a-f]{" + str(length) + "}", getattr(args, name)):
            parser.error("Invalid " + name)
    release = Path(args.release_dir)
    if not release.is_absolute() or release.parent != Path("/opt/uimori/releases") or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", release.name):
        parser.error("release-dir must be an immediate child of /opt/uimori/releases")
    if not Path(args.app_dir).is_absolute():
        parser.error("app-dir must be absolute")
    if args.image and (args.image.startswith("-") or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_./:@-]*", args.image)):
        parser.error("Invalid image reference")
    if args.expected_origin:
        origin = urlsplit(args.expected_origin)
        if origin.scheme != "https" or not origin.hostname or origin.path or origin.query or origin.fragment or origin.username or origin.password:
            parser.error("expected-origin must be an HTTPS origin without a path")
    return args


OWNED_ENV = {"UIMORI_IMAGE", "UIMORI_IMAGE_TAG", "UIMORI_DATA_VOLUME"}


def environment_values(text):
    values = {}
    for line in text.splitlines():
        match = re.fullmatch(r"\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)", line)
        if match:
            value = match[2].strip()
            if len(value) > 1 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            values[match[1]] = value
    return values


def update_environment(text, image, volume):
    lines = [line for line in text.splitlines() if not re.match(r"\s*(?:" + "|".join(sorted(OWNED_ENV)) + r")=", line)]
    return "\n".join(lines + ["UIMORI_IMAGE=" + image, "UIMORI_DATA_VOLUME=" + volume]) + "\n"


def protected_environment(text):
    return hashlib.sha256("\n".join(line for line in text.splitlines() if not re.match(r"\s*(?:" + "|".join(sorted(OWNED_ENV)) + r")=", line)).encode()).hexdigest()


def validate_columns(expected, actual):
    """Require candidate columns semantically; allow extra historical columns."""
    missing = [table + "." + column for table, columns in expected.items()
               for column, shape in columns.items() if actual.get(table, {}).get(column) != shape]
    if missing:
        raise RuntimeError("Database columns incompatible with fresh candidate: " + ", ".join(missing[:20]) + ". Explicit --fresh is required to discard incompatible app data.")
    return {"status": "PASS", "tables": len(expected), "columns": sum(len(columns) for columns in expected.values())}


class Runner:
    def __init__(self, args):
        self.args = args
        self.app = Path(args.app_dir)
        self.release = Path(args.release_dir)
        self.scripts = Path(__file__).resolve().parent.parent / "scripts"
        self.candidate = self.release / "candidate"
        self.env = self.app / ".env.self-host"
        self.private = self.release / "private"
        self.stopped = False
        self.backed_up = False
        self.checked_out = False
        self.candidate_started = False
        self.temporary_volumes = []
        self.probe_containers = []
        self.summary = {"status": "RUNNING", "commit": args.commit, "buildId": args.build_id, "distHash": args.dist_hash, "mode": "fresh" if args.fresh else "update", "checkOnly": args.check_only, "stages": [], "rollback": "NOT_NEEDED"}

    def persist(self):
        self.summary["report"] = str(self.release / "oracle-summary.json")
        temporary = self.release / "oracle-summary.tmp"
        temporary.write_text(json.dumps(self.summary, indent=2) + "\n")
        temporary.replace(self.summary["report"])

    @contextlib.contextmanager
    def stage(self, name):
        item = {"name": name, "status": "RUNNING", "startedAt": time.time()}
        self.summary["stages"].append(item)
        self.persist()
        print("ORACLE_STAGE " + name, flush=True)
        try:
            yield
            item["status"] = "PASS"
        except BaseException:
            item["status"] = "FAIL"
            raise
        finally:
            item["durationMs"] = round((time.time() - item["startedAt"]) * 1000)
            self.persist()

    def run(self, *command, cwd=None, timeout=120):
        # Command output can contain credentials (compose config); never echo it on errors.
        result = subprocess.run(command, cwd=cwd or self.app, capture_output=True, text=True, timeout=timeout)
        if result.returncode:
            if self.private.exists():
                log = self.private / "command-error.log"
                log.write_text(result.stdout + "\n" + result.stderr)
                os.chmod(log, 0o600)
                self.summary["diagnosticLog"] = str(log)
            raise RuntimeError("Command failed: " + " ".join(command[:3]) + " (exit " + str(result.returncode) + ")")
        return result.stdout.strip()

    def docker(self, *args, **kwargs):
        return self.run("sudo", "-n", "docker", *args, **kwargs)

    def compose(self, *args, cwd=None):
        # --env-file supplies interpolation values; service env_file paths separately
        # resolve against the project directory. Candidate worktrees contain no secrets.
        # Image building uses docker build with the explicit candidate path, not Compose.
        return self.docker("compose", "--project-directory", str(self.app), "--env-file", str(self.env), "-f", str((cwd or self.app) / "compose.tailscale.yaml"), *args, cwd=cwd)

    def inspect(self):
        return json.loads(self.docker("inspect", "uimori-app-1"))[0]

    def routing(self):
        return json.loads(self.run("sudo", "-n", "tailscale", "serve", "status", "--json"))

    def verify_binding(self, app):
        if app["HostConfig"]["PortBindings"] != {"4310/tcp": [{"HostIp": "127.0.0.1", "HostPort": "4310"}]}:
            raise RuntimeError("Application must bind only 127.0.0.1:4310")

    def volume(self, app):
        mounts = [mount for mount in app["Mounts"] if mount["Destination"] == "/data"]
        if len(mounts) != 1 or mounts[0]["Type"] != "volume":
            raise RuntimeError("Expected one named /data volume")
        return mounts[0]["Name"]

    def data(self, action, volume, target=None, image=None):
        mounts = ["--mount", "type=volume,src=" + volume + ",dst=/data", "--mount", "type=bind,src=" + str(self.scripts) + ",dst=/runner,readonly"]
        if target:
            kind, source = target
            mounts += ["--mount", "type=" + kind + ",src=" + source + ",dst=/backup"]
        paths = ["/backup", "/data"] if action == "restore" else ["/data", "/backup"]
        return json.loads(self.docker("run", "--rm", "--network", "none", "--read-only", "--user", "0", "--tmpfs", "/tmp", *mounts, image or self.old_image, "node", "/runner/oracle-data.mjs", action, *paths))

    def new_volume(self, suffix, temporary=True):
        name = "uimori_" + self.release.name.replace(".", "_") + "_" + suffix
        existing = self.docker("volume", "ls", "--format", "{{.Name}}").splitlines()
        if name in existing:
            raise RuntimeError("Release volume already exists; use a new release directory")
        self.docker("volume", "create", name)
        if temporary:
            self.temporary_volumes.append(name)
        return name

    def probe(self, volume=None):
        name = "uimori-probe-" + self.release.name + ("-copy" if volume else "-fresh")
        self.probe_containers.append(name)
        data = ["--mount", "type=volume,src=" + volume + ",dst=/data"] if volume else ["--tmpfs", "/data:uid=1000,gid=1000"]
        return json.loads(self.docker("run", "--rm", "--name", name, "--network", "none", "--read-only", "--tmpfs", "/tmp", *data, "--mount", "type=bind,src=" + str(self.scripts) + ",dst=/runner,readonly", "-e", "EXPECTED_BUILD=" + self.args.build_id, "-e", "EXPECTED_DIST=" + self.args.dist_hash, self.image, "node", "/runner/oracle-image-probe.mjs", timeout=60))

    def write_env(self, text):
        temporary = self.env.with_suffix(".oracle-tmp")
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w") as file:
            file.write(text)
        temporary.replace(self.env)

    def wait_healthy(self, image, volume):
        for _ in range(45):
            app = self.inspect()
            if app["State"].get("Health", {}).get("Status") == "healthy":
                self.verify_binding(app)
                if app["Image"] != image or self.volume(app) != volume:
                    raise RuntimeError("Running image or volume differs from pinned deployment")
                return
            time.sleep(2)
        raise RuntimeError("Application did not become healthy within 90 seconds")

    def remote_commit(self):
        if self.run("git", "ls-remote", "--exit-code", "origin", "refs/heads/main").split()[0] != self.args.commit:
            raise RuntimeError("origin/main changed; verify the new commit before deploying")

    def execute(self):
        with self.stage("preflight"):
            if self.app.resolve() != self.app or self.release.resolve() != self.release:
                raise RuntimeError("Symlink deployment paths refused")
            if self.run("git", "status", "--porcelain"):
                raise RuntimeError("Production checkout must be clean")
            self.previous = self.run("git", "rev-parse", "HEAD")
            live = self.inspect()
            self.verify_binding(live)
            if live["State"].get("Health", {}).get("Status") != "healthy":
                raise RuntimeError("Current application is not healthy")
            self.old_image = live["Image"]
            self.old_volume = self.volume(live)
            self.old_env = self.env.read_text()
            self.old_config = json.loads(self.compose("config", "--format", "json"))
            configured_image = self.old_config["services"]["app"]["image"]
            if json.loads(self.docker("image", "inspect", configured_image))[0]["Id"] != self.old_image:
                raise RuntimeError("Configured image differs from running image")
            origin = self.old_config["services"]["app"]["environment"]["NR_PUBLIC_ORIGIN"]
            if self.args.expected_origin and origin != self.args.expected_origin:
                raise RuntimeError("Production origin differs from --expected-origin")
            if self.old_config["volumes"]["data"]["name"] != self.old_volume:
                raise RuntimeError("Configured data volume differs from running volume")
            live_env = dict(entry.split("=", 1) for entry in live["Config"]["Env"] if "=" in entry)
            if live_env.get("NR_PUBLIC_ORIGIN") != origin:
                raise RuntimeError("Configured origin differs from running application")
            self.summary["publicOrigin"] = origin
            self.old_routing = self.routing()
            self.private.mkdir(mode=0o700)
            (self.private / "environment").write_text(self.old_env)
            os.chmod(self.private / "environment", 0o600)
            self.summary.update(previousCommit=self.previous, previousImage=self.old_image, previousVolume=self.old_volume)
            self.data("inspect", self.old_volume)
            self.old_credentials = self.data("credential-digest", self.old_volume)
            self.remote_commit()
        with self.stage("candidate"):
            self.run("git", "fetch", "origin", "main")
            if self.run("git", "rev-parse", "origin/main") != self.args.commit:
                raise RuntimeError("Fetched commit mismatch")
            self.run("git", "worktree", "add", "--detach", str(self.candidate), self.args.commit)
            if self.run("git", "rev-parse", "HEAD", cwd=self.candidate) != self.args.commit or self.run("git", "status", "--porcelain", cwd=self.candidate):
                raise RuntimeError("Candidate checkout mismatch")
            image_ref = self.args.image or "uimori:candidate-" + self.args.commit
            if not self.args.image:
                codex = self.old_config["services"]["app"].get("build", {}).get("args", {}).get("UIMORI_CODEX_VERSION", "") or ""
                self.docker("build", "--build-arg", "UIMORI_CODEX_VERSION=" + codex, "--tag", image_ref, str(self.candidate), timeout=900)
            if self.args.image:
                try:
                    self.docker("image", "inspect", image_ref)
                except RuntimeError:
                    self.docker("pull", image_ref, timeout=600)
            self.image = json.loads(self.docker("image", "inspect", image_ref))[0]["Id"]
            self.summary["image"] = self.image
        with self.stage("fresh-image-probe"):
            self.summary["freshProbe"] = self.probe()
            self.expected_columns = self.summary["freshProbe"]["database"].pop("columns")
        if not self.args.fresh:
            with self.stage("compatibility-probe"):
                copy = self.new_volume("probe")
                self.data("snapshot", self.old_volume, ("volume", copy))
                try:
                    self.summary["compatibilityProbe"] = self.probe(copy)
                    actual = self.summary["compatibilityProbe"]["database"].pop("columns")
                    self.summary["compatibilityProbe"]["columns"] = validate_columns(self.expected_columns, actual)
                except Exception as error:
                    raise RuntimeError(str(error) + " Existing database is incompatible with the candidate image. Review the probe failure or explicitly rerun with --fresh (discards app data/settings and retains credentials).") from error
        with self.stage("ready-to-switch"):
            self.compose("config", "--quiet", cwd=self.candidate)
            self.remote_commit()
            if self.env.read_text() != self.old_env or self.routing() != self.old_routing or self.inspect()["Image"] != self.old_image:
                raise RuntimeError("Live environment changed during candidate verification")
            self.data("inspect", self.old_volume)
        if self.args.check_only:
            self.summary["status"] = "PASS"
            return
        with self.stage("stop-and-backup"):
            self.stopped = True
            self.compose("stop", "app")
            self.data("inspect", self.old_volume)
            if self.args.fresh:
                self.volume_name = self.new_volume("data", temporary=False)
                self.summary["volume"] = self.volume_name
                self.summary["credentials"] = self.data("credentials", self.old_volume, ("volume", self.volume_name))
            else:
                self.volume_name = self.old_volume
                backup = self.private / "data"
                backup.mkdir(mode=0o700)
                self.data("backup", self.old_volume, ("bind", str(backup)))
                self.backed_up = True
            self.summary["volume"] = self.volume_name
        with self.stage("switch"):
            self.checked_out = True
            self.run("git", "checkout", "--detach", self.args.commit)
            self.write_env(update_environment(self.old_env, self.image, self.volume_name))
            # Config contains secrets; capture and validate locally without logging it.
            config = json.loads(self.compose("config", "--format", "json"))
            if config["services"]["app"]["image"] != self.image:
                raise RuntimeError("Compose must support the pinned UIMORI_IMAGE reference")
            self.candidate_started = True
            self.compose("up", "-d", "--no-build", "app")
        with self.stage("health"):
            self.wait_healthy(self.image, self.volume_name)
            self.summary["database"] = self.data("audit", self.volume_name, image=self.image)
            if self.data("credential-digest", self.volume_name, image=self.image) != self.old_credentials:
                raise RuntimeError("Stored credentials changed during deployment")
            if protected_environment(self.env.read_text()) != protected_environment(self.old_env) or self.routing() != self.old_routing:
                raise RuntimeError("Protected environment or Tailscale routing changed")
            self.remote_commit()
        self.summary["status"] = "PASS"

    def rollback(self):
        if not self.stopped:
            return
        self.summary["rollback"] = "RUNNING"
        with self.stage("rollback"):
            if self.candidate_started:
                # Do not overwrite work submitted by a user after the new app became available.
                self.data("inspect", self.volume_name, image=self.image)
                self.compose("stop", "app")
                self.data("inspect", self.volume_name, image=self.image)
            if self.backed_up and self.candidate_started:
                self.data("restore", self.old_volume, ("bind", str(self.private / "data")))
            if self.checked_out:
                self.run("git", "checkout", "--detach", self.previous)
            self.write_env(self.old_env)
            # Older Compose may only understand tags; a private override pins the old image.
            override = self.private / "rollback.json"
            override.write_text(json.dumps({"services": {"app": {"image": self.old_image}}}))
            self.docker("compose", "--env-file", str(self.env), "-f", str(self.app / "compose.tailscale.yaml"), "-f", str(override), "up", "-d", "--no-build", "app")
            self.wait_healthy(self.old_image, self.old_volume)
            if self.env.read_text() != self.old_env or self.routing() != self.old_routing:
                raise RuntimeError("Rollback environment or routing verification failed")
            self.summary["rollback"] = "PASS"

    def cleanup(self):
        errors = []
        try:
            remaining_containers = set(self.docker("ps", "-a", "--format", "{{.Names}}").splitlines())
        except Exception:
            remaining_containers = set()
            errors.append("probe-container inventory")
        for container in self.probe_containers:
            if container not in remaining_containers:
                continue  # Successful --rm probes have already disappeared.
            try:
                self.docker("rm", "-f", container)
            except Exception:
                errors.append(container)
        for volume in self.temporary_volumes:
            try:
                self.docker("volume", "rm", volume)
            except Exception:
                errors.append(volume)
        if self.candidate.exists():
            try:
                self.run("git", "worktree", "remove", str(self.candidate))
            except Exception:
                errors.append(str(self.candidate))
        self.summary["cleanup"] = {"status": "FAIL" if errors else "PASS", "remaining": errors}


def main():
    import fcntl  # Linux host only; module helpers remain testable on Windows.
    args = arguments()
    release = Path(args.release_dir)
    if not release.is_dir() or release.is_symlink() or (release / "oracle-summary.json").exists():
        raise RuntimeError("Stage files in a new release directory before running")
    with open("/opt/uimori/deploy.lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        runner = Runner(args)
        def interrupted(signum, _frame):
            raise RuntimeError("Interrupted by signal " + str(signum))
        signal.signal(signal.SIGTERM, interrupted)
        signal.signal(signal.SIGINT, interrupted)
        code = 0
        try:
            runner.execute()
        except BaseException as error:
            code = 1
            runner.summary.update(status="FAIL", error=str(error))
            try:
                runner.rollback()
            except BaseException as rollback_error:
                runner.summary.update(rollback="FAIL", rollbackError=str(rollback_error))
        finally:
            runner.cleanup()
            if runner.summary["cleanup"]["status"] != "PASS":
                runner.summary["status"] = "FAIL"
                code = 1
            runner.persist()
            print("ORACLE_REPORT " + runner.summary["report"], flush=True)
            print("ORACLE_SUMMARY " + json.dumps(runner.summary), flush=True)
        return code


if __name__ == "__main__":
    sys.exit(main())
