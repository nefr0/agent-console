"""Private NDJSON worktree cleanup worker. No shell, hooks, or inherited Git settings."""

import errno
import fcntl
import hashlib
import json
import os
import re
import select
import shutil
import stat
import subprocess
import sys
import tarfile
import uuid
from pathlib import Path

os.umask(0o077)
IDENTIFIER = re.compile(r"^[a-f0-9-]{36}$")
ROW_LIMIT = 40


def emit(kind, **fields):
    print(json.dumps({"type": kind, **fields}, ensure_ascii=True), flush=True)


def context():
    request = str(uuid.uuid4())
    emit("context", requestId=request)
    line = sys.stdin.readline()
    if not line:
        raise ValueError("Caller context disconnected")
    result = json.loads(line)
    if result.get("requestId") != request:
        raise ValueError("Invalid context response")
    return result


def ensure_connected():
    readable, _, _ = select.select([sys.stdin], [], [], 0)
    if readable:
        raise ValueError("Caller context disconnected")


def safe_failure(error):
    safe_literals = {
        "Unsupported file type",
        "Unsupported special file",
        "Symlinked Git metadata",
        "Git metadata locked",
        "File changed while hashing",
        "Git protection check failed",
        "Caller context disconnected",
        "Worktree changed since preview",
        "Worktree protection changed before removal",
        "Apply requires a live interactive caller",
        "Archive verification failed",
        "Archive checksum changed",
        "Backup manifest changed",
        "Git metadata verification failed",
        "Worktree changed while archiving",
    }
    if isinstance(error, (ValueError, RuntimeError)) and str(error) in safe_literals:
        return str(error)
    if isinstance(error, OSError):
        reasons = {
            errno.EACCES: "Permission denied during protection check",
            errno.EPERM: "Permission denied during protection check",
            errno.ENOENT: "Path changed or unavailable during protection check",
            errno.ENOTDIR: "Path changed or unavailable during protection check",
            errno.ELOOP: "Path changed or unavailable during protection check",
            errno.ENOSPC: "Insufficient storage for protection check",
            errno.EDQUOT: "Insufficient storage for protection check",
            errno.EMFILE: "Too many open files during protection check",
            errno.ENFILE: "Too many open files during protection check",
        }
        return reasons.get(error.errno, "Snapshot protection check failed")
    return "Snapshot protection check failed"


def durable_json(target, value):
    target = Path(target)
    temporary = target.with_suffix(target.suffix + ".tmp")
    with open(temporary, "w", encoding="utf-8") as output:
        os.fchmod(output.fileno(), 0o600)
        json.dump(value, output, ensure_ascii=True)
        output.write("\n")
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, target)
    descriptor = os.open(target.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def git(root, *arguments, optional=False):
    result = subprocess.run(
        [
            "/usr/bin/git",
            "--no-optional-locks",
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.untrackedCache=false",
            "-C",
            str(root),
            *arguments,
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        check=False,
        timeout=120,
    )
    if result.returncode and not optional:
        raise RuntimeError("Git protection check failed")
    return result.stdout if result.returncode == 0 else None


def registered(root):
    records = []
    current = None
    for field in git(root, "worktree", "list", "--porcelain", "-z").split(b"\0"):
        if field.startswith(b"worktree "):
            current = {"path": os.fsdecode(field[9:]), "locked": False}
            records.append(current)
        elif current is not None and field.startswith(b"locked"):
            current["locked"] = True
    if not records:
        raise ValueError("No registered worktrees")
    return records


def contains(parent, child):
    return child == parent or child.startswith(parent.rstrip(os.sep) + os.sep)


def canonical(value):
    return os.path.realpath(os.path.abspath(value))


def digest_file(filename):
    descriptor = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, "rb") as source:
        before = os.fstat(source.fileno())
        if not stat.S_ISREG(before.st_mode):
            raise ValueError("Unsupported file type")
        digest = hashlib.file_digest(source, "sha256").hexdigest()
        after = os.fstat(source.fileno())
        if (before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (
            after.st_ino,
            after.st_size,
            after.st_mtime_ns,
            after.st_ctime_ns,
        ):
            raise ValueError("File changed while hashing")
        return digest


def file_record(filename):
    metadata = os.lstat(filename)
    mode = stat.S_IMODE(metadata.st_mode)
    if stat.S_ISLNK(metadata.st_mode):
        return {"kind": "link", "mode": mode, "target": os.readlink(filename)}
    if stat.S_ISDIR(metadata.st_mode):
        return {"kind": "directory", "mode": mode}
    if stat.S_ISREG(metadata.st_mode):
        return {
            "kind": "file",
            "mode": mode,
            "size": metadata.st_size,
            "sha256": digest_file(filename),
        }
    raise ValueError("Unsupported special file")


def file_inventory(root):
    inventory = {}
    pending = [Path(root)]
    while pending:
        directory = pending.pop()
        with os.scandir(directory) as entries:
            for entry in sorted(entries, key=lambda entry: entry.name):
                relative = str(Path(entry.path).relative_to(root))
                if relative == ".git":
                    continue
                record = file_record(entry.path)
                inventory[relative] = record
                if record["kind"] == "directory":
                    pending.append(Path(entry.path))
    return inventory


def metadata_files(root):
    gitdir = Path(os.fsdecode(git(root, "rev-parse", "--absolute-git-dir")).strip())
    common = Path(
        os.fsdecode(git(root, "rev-parse", "--path-format=absolute", "--git-common-dir")).strip()
    )
    files = {"HEAD": gitdir / "HEAD"}
    if (gitdir / "index").exists():
        files["index"] = gitdir / "index"
    for directory, prefix in [(gitdir, "local"), (common, "common")]:
        for filename in directory.glob("sharedindex.*"):
            files[f"{prefix}-{filename.name}"] = filename
    if any(filename.is_symlink() for filename in files.values()):
        raise ValueError("Symlinked Git metadata")
    return gitdir, common, files


def snapshot(root):
    gitdir, common, files = metadata_files(root)
    if (gitdir / "index.lock").exists() or (gitdir / "HEAD.lock").exists():
        raise ValueError("Git metadata locked")
    return {
        "rootIdentity": [os.stat(root).st_dev, os.stat(root).st_ino],
        "registration": file_record(Path(root) / ".git"),
        "head": os.fsdecode(git(root, "rev-parse", "HEAD")).strip(),
        "branch": os.fsdecode(
            git(root, "symbolic-ref", "--quiet", "HEAD", optional=True) or b""
        ).strip(),
        "gitdir": str(gitdir),
        "common": str(common),
        "metadata": {name: file_record(filename) for name, filename in files.items()},
        "files": file_inventory(root),
    }


def validate_caller(caller, current):
    if not caller or caller.get("archived") or caller.get("issueRun"):
        raise ValueError("Apply requires a live interactive caller")
    thread = next(
        (thread for thread in current.get("threads", []) if thread.get("id") == caller.get("id")),
        None,
    )
    if not thread or thread.get("archived"):
        raise ValueError("Apply requires a live interactive caller")


def prepare_ownership_context(records, current):
    evidence = current.get("evidence", {})
    threads = {thread["id"]: thread for thread in current.get("threads", [])}
    context = {
        "stale": evidence.get("stale") or not evidence.get("version"),
        "threads": threads,
        "thread_cwds": {},
        "canonical_roots": {},
        "entries": {record["path"]: [] for record in records},
        "creators": {record["path"]: set() for record in records},
    }
    if context["stale"]:
        return context

    resolved = {}

    def resolve(value):
        if value not in resolved:
            resolved[value] = canonical(value)
        return resolved[value]

    roots = {}
    for record in records:
        root = record["path"]
        canonical_root = resolve(root)
        context["canonical_roots"][root] = canonical_root
        roots.setdefault(canonical_root, []).append(root)
    for thread_id, thread in threads.items():
        cwd = thread.get("cwd", "")
        context["thread_cwds"][thread_id] = resolve(cwd) if isinstance(cwd, str) and cwd else ""

    for entry in evidence.get("entries", []):
        evidence_path = entry.get("path") if isinstance(entry, dict) else None
        if not isinstance(evidence_path, str) or not os.path.isabs(evidence_path):
            continue
        canonical_path = resolve(evidence_path)
        parent = canonical_path
        while True:
            for root in roots.get(parent, []):
                context["entries"][root].append(entry)
                if (
                    entry.get("kind") == "create"
                    and canonical_path == context["canonical_roots"][root]
                ):
                    context["creators"][root].add(entry.get("thread", ""))
            if parent == os.path.dirname(parent):
                break
            parent = os.path.dirname(parent)
    return context


def creator_ids(root, ownership):
    return sorted(ownership["creators"].get(root, set()))


def evidence_reasons(root, ownership):
    threads = ownership["threads"]
    creators = creator_ids(root, ownership)
    reasons = []
    if not creators:
        reasons.append("No proven creator")
    if any(not threads.get(owner, {}).get("archived") for owner in creators):
        reasons.append("Creator unknown or active")
    for entry in ownership["entries"].get(root, []):
        owner = threads.get(entry.get("thread"), {})
        if entry.get("kind") in ("use", "ambiguous") and not owner.get("archived"):
            reasons.append("Active or unknown thread use")
    return reasons


def thread_reasons(root, caller, ownership):
    if ownership["stale"]:
        return ["Evidence unavailable or stale"]
    threads = ownership["threads"]
    reasons = evidence_reasons(root, ownership)
    active = [
        thread
        for thread in threads.values()
        if not thread.get("archived") or thread.get("id") == caller.get("id")
    ]
    canonical_root = ownership["canonical_roots"].get(root, root)
    for thread in active:
        cwd = ownership["thread_cwds"].get(thread["id"], "")
        if cwd and contains(canonical_root, cwd):
            reasons.append("Caller or active thread directory")
    return sorted(set(reasons))


def read_reference(reference):
    try:
        target = os.readlink(reference).removesuffix(" (deleted)")
        return canonical(target) if target.startswith("/") else None
    except OSError as error:
        if error.errno == errno.ENOENT:
            return None
        raise


def process_references(process):
    references = [process / "cwd", process / "exe", process / "root"]
    references.extend((process / "fd").iterdir())
    paths = {target for reference in references if (target := read_reference(reference))}
    with open(process / "maps", encoding="utf-8", errors="replace") as mappings:
        for line in mappings:
            fields = line.split(maxsplit=5)
            if len(fields) == 6 and fields[5].startswith("/"):
                paths.add(fields[5].strip().removesuffix(" (deleted)"))
    return paths


def active_process_paths():
    paths = set()
    for process in Path("/proc").iterdir():
        if not process.name.isdigit() or int(process.name) == os.getpid():
            continue
        try:
            if process.stat().st_uid == os.getuid():
                paths.update(process_references(process))
        except (FileNotFoundError, ProcessLookupError):
            continue
    return paths


def symlinks_in(root):
    pending = [Path(root)]
    while pending:
        directory = pending.pop()
        with os.scandir(directory) as entries:
            for entry in entries:
                if entry.name == ".git":
                    continue
                if entry.is_symlink():
                    yield canonical(entry.path)
                elif entry.is_dir(follow_symlinks=False):
                    pending.append(Path(entry.path))


def protection_inventory(records):
    """One traversal per registered checkout; never scan unrelated home directories."""
    try:
        links = [
            (record["path"], target) for record in records for target in symlinks_in(record["path"])
        ]
    except OSError:
        return {"error": "Registered worktree symlink inspection failed"}
    try:
        processes = active_process_paths()
    except OSError:
        return {"error": "Same-user process inspection failed"}
    return {"links": links, "processes": processes}


def protections(root, records, ownership, caller, inventory):
    reasons = thread_reasons(root, caller, ownership)
    paths = [record["path"] for record in records]
    if root not in paths:
        reasons.append("Worktree is no longer registered")
        return reasons
    if root == paths[0]:
        reasons.append("Canonical checkout")
    if canonical(root) != root or Path(root).is_symlink():
        reasons.append("Symlink worktree root")
    if any(record["path"] == root and record["locked"] for record in records):
        reasons.append("Locked worktree")
    if any(other != root and (contains(root, other) or contains(other, root)) for other in paths):
        reasons.append("Nested registered worktree")
    if reasons:
        return sorted(set(reasons))
    return inventory_reasons(root, inventory)


def inventory_reasons(root, inventory):
    reasons = []
    if inventory is None:
        return ["Shared-link or process protection check failed"]
    if inventory.get("error"):
        return [inventory["error"]]
    if any(contains(root, target) for target in inventory["processes"]):
        reasons.append("Process uses worktree")
    if any(
        owner != root and (contains(root, target) or contains(target, root))
        for owner, target in inventory["links"]
    ):
        reasons.append("External symlink references worktree")
    return reasons


def result_for(request):
    return {
        "job": request["job"],
        "action": request["action"],
        "status": "running",
        "counts": {
            "total": 0,
            "eligible": 0,
            "skipped": 0,
            "backedUp": 0,
            "removed": 0,
            "failed": 0,
        },
        "rows": [],
        "next": "Poll job status.",
    }


def publish(result, rows, report, final=False):
    durable_json(report, {**result, "rows": rows})
    result["report"] = str(report)
    result["rows"] = rows[:ROW_LIMIT]
    emit("result" if final else "progress", result=result)


def preview_next(current, eligible):
    evidence = current.get("evidence", {})
    if evidence.get("stale") or not evidence.get("version"):
        return "Evidence index is stale or unavailable. Wait for it to become ready, then run a new preview."
    if not eligible:
        return "No eligible worktrees. Inspect retained reasons in the private report."
    return "Apply this plan with explicitly selected eligible absolute paths."


def preview(request, current, result, report):
    repo = request.get("repo", "")
    if not isinstance(repo, str) or not os.path.isabs(repo):
        raise ValueError("Absolute repository required")
    records = registered(repo)
    ownership = prepare_ownership_context(records, current)
    plan_id = request["job"]
    plan = {"id": plan_id, "repo": records[0]["path"], "rows": [], "snapshots": {}, "creators": {}}
    try:
        inventory = protection_inventory(records)
    except Exception:
        inventory = None
    for record in records:
        root = record["path"]
        row = {"path": root, "eligible": False, "reason": "Protection check failed"}
        try:
            reasons = protections(root, records, ownership, request.get("caller", {}), inventory)
            if not reasons:
                plan["snapshots"][root] = snapshot(root)
                plan["creators"][root] = creator_ids(root, ownership)
                row["dirty"] = bool(git(root, "status", "--porcelain", "--untracked-files=all"))
            row.update(
                eligible=not reasons,
                reason="; ".join(reasons)
                if reasons
                else "All proven creators archived; protection checks passed",
            )
        except Exception as error:
            row["reason"] = safe_failure(error)
        plan["rows"].append(row)
    result["counts"].update(
        total=len(records),
        eligible=sum(row["eligible"] for row in plan["rows"]),
        skipped=sum(not row["eligible"] for row in plan["rows"]),
    )
    result.update(
        plan=plan_id,
        status="complete",
        next=preview_next(current, result["counts"]["eligible"]),
    )
    plan_file = Path(request["state"]) / "plans" / f"{plan_id}.json"
    descriptor = os.open(plan_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as output:
        json.dump(plan, output)
        output.flush()
        os.fsync(output.fileno())
    publish(result, plan["rows"], report, final=True)


def verify_archive(archive, expected):
    with tarfile.open(archive, "r:gz") as source:
        actual = {}
        for member in source:
            name = member.name
            record = {"mode": member.mode}
            if member.issym():
                record.update(kind="link", target=member.linkname)
            elif member.isdir():
                record.update(kind="directory")
            elif member.isfile() or member.islnk():
                stream = source.extractfile(member)
                if stream is None:
                    raise ValueError("Archive file unavailable")
                record.update(
                    kind="file",
                    size=member.size if member.isfile() else expected[name]["size"],
                    sha256=hashlib.file_digest(stream, "sha256").hexdigest(),
                )
            else:
                raise ValueError("Unexpected archive entry")
            actual[name] = record
        if actual != expected:
            raise ValueError("Archive verification failed")


def backup(root, original, directory, repo, job):
    directory.mkdir(mode=0o700)
    archive = directory / "files.tar.gz"
    with tarfile.open(archive, "x:gz", dereference=False) as output:
        for relative in sorted(original["files"]):
            output.add(Path(root) / relative, arcname=relative, recursive=False)
    os.chmod(archive, 0o600)
    verify_archive(archive, original["files"])
    if snapshot(root) != original:
        raise ValueError("Worktree changed while archiving")
    metadata = directory / "git-metadata"
    metadata.mkdir(mode=0o700)
    _, _, files = metadata_files(root)
    for name, filename in files.items():
        destination = metadata / name
        shutil.copyfile(filename, destination, follow_symlinks=False)
        os.chmod(destination, 0o600)
        if digest_file(destination) != original["metadata"][name]["sha256"]:
            raise ValueError("Git metadata verification failed")
    reference = f"refs/agent-console/worktree-recovery/{job}/{directory.name}"
    git(repo, "-c", "core.fsync=reference", "update-ref", reference, original["head"])
    manifest = {
        "path": root,
        "snapshot": original,
        "recoveryRef": reference,
        "archiveSha256": digest_file(archive),
        "removed": False,
    }
    durable_json(directory / "manifest.json", manifest)
    for filename in [archive, *metadata.iterdir(), metadata]:
        descriptor = os.open(filename, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    return manifest


def selected_paths(request, plan):
    selected = request.get("paths")
    if (
        not isinstance(selected, list)
        or not selected
        or any(not isinstance(root, str) for root in selected)
    ):
        raise ValueError("Explicit selected paths required")
    if len(selected) != len(set(selected)):
        raise ValueError("Duplicate selected paths")
    eligible = {row["path"] for row in plan["rows"] if row["eligible"]}
    if any(
        not os.path.isabs(root) or os.path.normpath(root) != root or root not in eligible
        for root in selected
    ):
        raise ValueError("Selected path not eligible in immutable plan")
    return selected


def refreshed_protections(request, plan, root):
    current = context()
    validate_caller(request.get("caller"), current)
    records = registered(plan["repo"])
    ownership = prepare_ownership_context(records, current)
    inventory = protection_inventory(records)
    reasons = protections(root, records, ownership, request["caller"], inventory)
    if creator_ids(root, ownership) != plan["creators"][root]:
        reasons.append("Creator evidence changed since preview")
    return reasons


def verify_preserved_metadata(directory, original, manifest):
    if json.loads((directory / "manifest.json").read_text()) != manifest:
        raise ValueError("Backup manifest changed")
    for name, record in original["metadata"].items():
        if digest_file(directory / "git-metadata" / name) != record["sha256"]:
            raise ValueError("Git metadata verification failed")


def verified_remove(request, plan, root, original, directory, manifest):
    verify_archive(directory / "files.tar.gz", original["files"])
    if digest_file(directory / "files.tar.gz") != manifest["archiveSha256"]:
        raise ValueError("Archive checksum changed")
    reasons = refreshed_protections(request, plan, root)
    if reasons or snapshot(root) != original:
        raise ValueError("Worktree protection changed before removal")
    if digest_file(directory / "files.tar.gz") != manifest["archiveSha256"]:
        raise ValueError("Archive checksum changed")
    verify_preserved_metadata(directory, original, manifest)
    ensure_connected()
    git(plan["repo"], "worktree", "remove", "--force", root)
    manifest["removed"] = True
    durable_json(directory / "manifest.json", manifest)


def apply_one(request, plan, root, position, result, rows, report, archive_root):
    row = {"path": root, "eligible": False, "reason": "Protection or backup verification failed"}
    try:
        reasons = refreshed_protections(request, plan, root)
        if reasons:
            row["reason"] = "; ".join(reasons)
            result["counts"]["skipped"] += 1
            return row
        original = plan["snapshots"][root]
        if snapshot(root) != original:
            raise ValueError("Worktree changed since preview")
        directory = archive_root / str(position)
        manifest = backup(root, original, directory, plan["repo"], request["job"])
        row["backup"] = str(directory)
        result["counts"]["backedUp"] += 1
        publish(result, [*rows, row], report)
        verified_remove(request, plan, root, original, directory, manifest)
        row.update(eligible=True, reason="Verified backup preserved; worktree removed")
        result["counts"]["removed"] += 1
    except Exception as error:
        row["reason"] = safe_failure(error)
        result["counts"]["failed"] += 1
    return row


def apply(request, current, result, report):
    validate_caller(request.get("caller"), current)
    plan_id = request.get("plan", "")
    if not isinstance(plan_id, str) or not IDENTIFIER.fullmatch(plan_id):
        raise ValueError("Invalid plan identifier")
    plan = json.loads((Path(request["state"]) / "plans" / f"{plan_id}.json").read_text())
    selected = selected_paths(request, plan)
    rows = []
    result["plan"] = plan_id
    result["counts"].update(total=len(selected), eligible=len(selected))
    archive_root = Path(request["state"]) / "archives" / request["job"]
    archive_root.mkdir(mode=0o700)
    for position, root in enumerate(selected):
        rows.append(apply_one(request, plan, root, position, result, rows, report, archive_root))
        publish(result, rows, report)
    result.update(
        status="incomplete" if result["counts"]["failed"] else "complete",
        next="Inspect private report and archive manifests for recovery. Branches and recovery references remain preserved.",
    )
    publish(result, rows, report, final=True)


def owner_dead(owner):
    if not isinstance(owner, dict):
        return False
    process_id = owner.get("pid")
    ticks = owner.get("startTicks")
    if (
        not isinstance(process_id, int)
        or process_id <= 0
        or not isinstance(ticks, str)
        or not ticks.isdigit()
    ):
        return False
    try:
        os.kill(process_id, 0)
        record = Path(f"/proc/{process_id}/stat").read_text()
        actual_ticks = record[record.rfind(")") + 2 :].split()[19]
        return actual_ticks != ticks
    except ProcessLookupError:
        return True
    except (OSError, IndexError):
        return False


def recover_dead_jobs(state, current_job):
    for filename in (state / "jobs").glob("*.json"):
        if not IDENTIFIER.fullmatch(filename.stem) or filename.stem == current_job:
            continue
        try:
            if filename.is_symlink() or filename.stat().st_size > 1024 * 1024:
                continue
            job = json.loads(filename.read_text())
            eligible = job.get("job") == filename.stem and job.get("status") in (
                "queued",
                "running",
            )
            if eligible and owner_dead(job.get("owner")):
                job.update(
                    status="incomplete",
                    next="Interrupted owner exited. Inspect private report and preserved archives before a new preview.",
                )
                durable_json(filename, job)
        except (OSError, ValueError, TypeError):
            continue


def execute(request, result):
    state = Path(request["state"])
    recover_dead_jobs(state, request["job"])
    for name in ("plans", "archives", "reports"):
        directory = state / name
        directory.mkdir(mode=0o700, exist_ok=True)
        os.chmod(directory, 0o700)
    report = state / "reports" / f"{request['job']}.json"
    try:
        current = context()
        if request["action"] == "preview":
            preview(request, current, result, report)
        elif request["action"] == "apply":
            apply(request, current, result, report)
        else:
            raise ValueError("Invalid cleanup action")
    except Exception as error:
        result.update(
            status="failed",
            next=safe_failure(error)
            + ". No further removals attempted. Inspect preserved archives before retrying.",
        )
        publish(result, result["rows"], report, final=True)


def main():
    request = json.loads(sys.stdin.readline())
    if not IDENTIFIER.fullmatch(request.get("job", "")):
        return
    result = result_for(request)
    descriptor = os.open(
        Path(request["state"]) / "lease", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600
    )
    try:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            result.update(
                status="failed",
                next="Cleanup worker busy. Existing worker retains the lease; no cleanup or recovery work performed.",
            )
            emit("result", result=result)
            return
        os.fchmod(descriptor, 0o600)
        execute(request, result)
    finally:
        os.close(descriptor)


if __name__ == "__main__":
    main()
