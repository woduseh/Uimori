"""Conservative Uimori-owned retention. No volume, builder-cache or global prune operations."""
import json
import math
from pathlib import Path
import re
import shutil
import subprocess
import sys

MANAGER = "uimori-oracle-v2"
KEEP_FAILURES = 5


def receipts(root):
    root = Path(root)
    records, unknown = [], []
    if root.resolve() != root:
        raise RuntimeError("Release root is an alias")
    for directory in root.iterdir():
        if not directory.is_dir() or directory.is_symlink():
            unknown.append(str(directory)); continue
        file = directory / "oracle-summary.json"
        try:
            if file.resolve() != file:
                raise ValueError("aliased receipt")
            record = json.loads(file.read_text())
            if record.get("managedBy") != MANAGER or record.get("report") != str(file):
                raise ValueError("unowned receipt")
            records.append((directory, record))
        except (OSError, ValueError, RuntimeError):
            unknown.append(str(directory))
    return records, unknown


def terminal(record):
    finished = record.get("finishedAt")
    return (isinstance(finished, (int, float)) and math.isfinite(finished) and finished > 0
            and record.get("status") in ("PASS", "FAIL")
            and record.get("cleanup", {}).get("status") == "PASS"
            and record.get("writes") in ("OPEN", "UNCHANGED")
            and record.get("rollback") in ("PASS", "NOT_NEEDED"))


def plan_gc(root, live, containers, images):
    records, unknown = receipts(root)
    successful = [(directory, record) for directory, record in records
                  if terminal(record) and record["status"] == "PASS" and not record.get("checkOnly")
                  and record.get("writes") == "OPEN" and record.get("image") == live["Image"]]
    if not successful:
        raise RuntimeError("Current image has no managed successful recovery receipt; nothing may be deleted")
    current_dir, current = max(successful, key=lambda item: item[1]["finishedAt"])
    if live.get("State", {}).get("Health", {}).get("Status") != "healthy":
        raise RuntimeError("Current application is not healthy")
    volumes = [mount.get("Name") for mount in live.get("Mounts", []) if mount.get("Destination") == "/data"]
    if volumes != [current.get("volume")]:
        raise RuntimeError("Current data volume differs from recovery receipt")
    if current.get("backup", {}).get("integrity") != "ok" or current.get("smoke", {}).get("status") != "PASS":
        raise RuntimeError("Recovery backup and HTTPS success are not confirmed")
    for file in [current_dir / "private" / "environment", current_dir / "private" / "data" / "uimori.sqlite"]:
        if not file.is_file() or file.resolve() != file:
            raise RuntimeError("Complete recovery files must exist without aliases")
    image_ids = {image["Id"] for image in images}
    protected_images = {container["Image"] for container in containers}
    protected_images.update([current["image"], current["previousImage"]])
    if not {current["image"], current["previousImage"]}.issubset(image_ids):
        raise RuntimeError("The current and previous recovery images must both exist")
    # Interrupted releases may still need their pinned images for recovery.
    for _, record in records:
        if not terminal(record):
            protected_images.update(value for key in ("image", "previousImage") if (value := record.get(key)))
    safe = [(directory, record) for directory, record in records if terminal(record)]
    failures = sorted([(directory, record) for directory, record in safe if record["status"] == "FAIL"],
                      key=lambda item: item[1]["finishedAt"], reverse=True)
    keep = {current_dir, *(directory for directory, _ in failures[:KEEP_FAILURES])}
    protected_directories = [str(directory) for directory, record in records if not terminal(record) or directory in keep]
    remove_dirs = [str(directory) for directory, _ in safe if directory not in keep]
    remove_images = []
    for image in images:
        labels = image.get("Config", {}).get("Labels", {}) or {}
        tags = image.get("RepoTags") or []
        if (image["Id"] not in protected_images and labels.get("io.uimori.managed") == "true"
                and re.fullmatch(r"[0-9a-f]{40}", labels.get("org.opencontainers.image.revision", ""))
                and all(re.fullmatch(r"uimori:candidate-[0-9a-f]{40}", tag) for tag in tags)):
            remove_images.append(image["Id"])
    return {"status": "PLAN", "recovery": str(current_dir), "images": sorted(set(remove_images)),
            "directories": sorted(remove_dirs), "protectedImages": sorted(protected_images),
            "protectedDirectories": sorted(protected_directories), "unknownDirectories": sorted(unknown)}


def apply_plan(plan, root, docker, remove=shutil.rmtree):
    warnings, removed = [], {"images": [], "directories": []}
    for image in plan["images"]:
        try:
            docker("image", "rm", image)  # No --force: newly referenced images cannot be removed.
            removed["images"].append(image)
        except Exception as error:
            warnings.append("Image cleanup failed: " + image + " (" + type(error).__name__ + ")")
    for name in plan["directories"]:
        directory = Path(name)
        try:
            if directory.parent != Path(root) or directory.resolve() != directory:
                raise RuntimeError("Cleanup path escaped release root")
            records, _ = receipts(root)
            record = next((record for candidate, record in records if candidate == directory), None)
            if not record or not terminal(record):
                raise RuntimeError("Release ownership or state changed")
            remove(directory)
            removed["directories"].append(name)
        except Exception as error:
            warnings.append("Release cleanup failed: " + name + " (" + type(error).__name__ + ")")
    return {**plan, "status": "WARN" if warnings else "PASS", "removed": removed, "warnings": warnings}


def collect_garbage(app, root, docker, *, apply=False, remove=shutil.rmtree):
    try:
        container_ids = docker("ps", "-aq").split()
        containers = json.loads(docker("inspect", *container_ids)) if container_ids else []
        live = next((container for container in containers if container.get("Name") == "/uimori-app-1"), None)
        if live is None:
            raise RuntimeError("Live Uimori container missing")
        image_ids = docker("image", "ls", "-aq", "--no-trunc").split()
        images = json.loads(docker("image", "inspect", *sorted(set(image_ids)))) if image_ids else []
        plan = plan_gc(root, live, containers, images)
        return apply_plan(plan, root, docker, remove=remove) if apply else plan
    except Exception as error:
        return {"status": "WARN" if apply else "PLAN", "images": [], "directories": [],
                "warnings": [str(error)], "removed": {"images": [], "directories": []}}


if __name__ == "__main__":
    # The controller exposes preview only. Real cleanup runs under the deployment lock.
    import fcntl
    app, root = sys.argv[1:3]
    def docker(*args):
        result = subprocess.run(["sudo", "-n", "docker", *args], capture_output=True, text=True, timeout=30)
        if result.returncode: raise RuntimeError("Docker inventory failed")
        return result.stdout.strip()
    with (Path(app).parent / "deploy.lock").open("r") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        print(json.dumps(collect_garbage(app, Path(root), docker)))
