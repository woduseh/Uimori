"""Read-only recovery inspection; never starts or replays a deployment."""
import fcntl
import json
from pathlib import Path
import subprocess
import sys


def inspect(app, releases, run_id=""):
    def run(*args):
        result = subprocess.run(args, capture_output=True, text=True, timeout=15, cwd=app)
        if result.returncode:
            raise RuntimeError("Status command failed: " + args[0])
        return result.stdout.strip()
    state = json.loads(run("sudo", "-n", "docker", "inspect", "uimori-app-1"))[0]
    lock_path = Path(app).parent / "deploy.lock"
    busy = False
    if lock_path.exists():
        with lock_path.open("r") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                busy = True
    root = Path(releases).resolve()
    directories = [root / run_id] if run_id else sorted(root.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True)
    receipt = None
    for directory in directories:
        if directory.is_symlink() or directory.parent != root:
            continue
        file = directory / "oracle-summary.json"
        if file.is_file() and not file.is_symlink():
            receipt = json.loads(file.read_text())
            break
    return {"status": "STATUS", "lockBusy": busy, "checkout": run("git", "rev-parse", "HEAD"),
            "dirty": bool(run("git", "status", "--porcelain")),
            "container": {"status": state["State"]["Status"], "health": state["State"].get("Health", {}).get("Status"),
                          "image": state["Image"], "dataVolumes": [m.get("Name") for m in state["Mounts"] if m["Destination"] == "/data"]},
            "release": receipt}


if __name__ == "__main__":
    print(json.dumps(inspect(*sys.argv[1:])))
