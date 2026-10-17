"""Read-only recovery inspection; never starts or replays a deployment."""
import fcntl
import json
from pathlib import Path
import subprocess
import sys


def inspect(app, releases, run_id=""):
    warnings = []

    def run(*args):
        result = subprocess.run(args, capture_output=True, text=True, timeout=15, cwd=app)
        if result.returncode:
            # Command arguments here are fixed inspection commands; their output may be private.
            raise RuntimeError("Command failed: " + " ".join(args) + " (exit " + str(result.returncode) + ")")
        return result.stdout.strip()

    def read(name, action):
        try:
            return action()
        except Exception as error:
            detail = str(error) if isinstance(error, RuntimeError) else type(error).__name__
            warnings.append(name + ": " + detail)
            return None

    def container():
        state = json.loads(run("sudo", "-n", "docker", "inspect", "uimori-app-1"))[0]
        return {"status": state["State"]["Status"], "health": state["State"].get("Health", {}).get("Status"),
                "image": state["Image"], "dataVolumes": [m.get("Name") for m in state["Mounts"] if m["Destination"] == "/data"]}

    def lock_busy():
        lock_path = Path(app).parent / "deploy.lock"
        if lock_path.exists():
            with lock_path.open("r") as lock:
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    return True
        return False

    def release():
        root = Path(releases).resolve()
        directories = [root / run_id] if run_id else sorted(root.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True)
        for directory in directories:
            if directory.is_symlink() or directory.parent != root:
                continue
            file = directory / "oracle-summary.json"
            if file.is_file() and not file.is_symlink():
                # A corrupt latest receipt is unknown, not permission to substitute an older success.
                return json.loads(file.read_text())
        return None

    result = {"status": "STATUS", "lockBusy": read("lockBusy", lock_busy),
              "checkout": read("checkout", lambda: run("git", "rev-parse", "HEAD")),
              "dirty": read("dirty", lambda: bool(run("git", "status", "--porcelain"))),
              "container": read("container", container), "release": read("release", release)}
    if warnings:
        result.update(status="WARN", warnings=warnings)
    return result


if __name__ == "__main__":
    # Transport succeeds when a structured partial result is available. The controller prints it
    # and uses WARN as a nonzero exit, preserving independent recovery evidence for the operator.
    print(json.dumps(inspect(*sys.argv[1:])))
