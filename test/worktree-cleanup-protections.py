"""Worktree cleanup recovery and caller-safety tests."""

import errno
import fcntl
import importlib.util
import json
import os
import unittest
import uuid
from pathlib import Path
from unittest import mock

FIXTURE_SPEC = importlib.util.spec_from_file_location(
    "worktree_cleanup_fixture", Path(__file__).with_name("worktree-cleanup-fixture.py")
)
FIXTURE = importlib.util.module_from_spec(FIXTURE_SPEC)
FIXTURE_SPEC.loader.exec_module(FIXTURE)
CleanupFixture = FIXTURE.CleanupFixture
MODULE = FIXTURE.MODULE


class CleanupTests(CleanupFixture, unittest.TestCase):
    def test_symlink_root_and_nested_registered_worktrees(self):
        moved = self.root / "moved"
        self.worktree.rename(moved)
        self.worktree.symlink_to(moved, target_is_directory=True)
        plan = self.preview()
        self.assertIn("Symlink worktree root", plan["rows"][1]["reason"])
        self.worktree.unlink()
        moved.rename(self.worktree)
        nested = self.worktree / "nested"
        self.git(self.repo, "worktree", "add", "-qb", "nested", str(nested))
        plan = self.preview()
        self.assertIn("Nested registered worktree", plan["rows"][1]["reason"])
        self.assertEqual(plan["counts"]["eligible"], 0)

    def test_split_index_preserved_and_verified(self):
        self.git(self.worktree, "update-index", "--split-index")
        plan = self.preview()
        done = self.apply(plan)
        self.assertEqual(done["counts"]["removed"], 1, done)
        backup = Path(done["rows"][0]["backup"])
        manifest = json.loads((backup / "manifest.json").read_text())
        names = list(manifest["snapshot"]["metadata"])
        self.assertTrue(any("sharedindex." in name for name in names))
        for name, record in manifest["snapshot"]["metadata"].items():
            self.assertEqual(MODULE.digest_file(backup / "git-metadata" / name), record["sha256"])

    def test_reactivation_before_deletion_retains_verified_archive(self):
        plan = self.preview()

        def reactivate(number):
            if number == 3:
                self.current["threads"][0]["archived"] = False

        done = self.apply(plan, before_context=reactivate)
        self.assertEqual(done["counts"]["backedUp"], 1)
        self.assertEqual(done["counts"]["removed"], 0)
        self.assertTrue(self.worktree.exists())
        self.assertTrue((Path(done["rows"][0]["backup"]) / "manifest.json").exists())

    def test_archive_verification_failure_retains_worktree(self):
        plan = self.preview()

        def corrupt(number):
            if number == 3:
                archive = next((self.state / "archives").glob("*/*/files.tar.gz"))
                archive.write_bytes(b"corrupt")

        done = self.apply(plan, before_context=corrupt)
        self.assertEqual(done["counts"]["removed"], 0)
        self.assertTrue(self.worktree.exists())

    def test_busy_lease_prevents_recovery_and_owner_checks_fail_closed(self):
        jobs = self.state / "jobs"
        jobs.mkdir(mode=0o700)
        dead = {
            "job": str(uuid.uuid4()),
            "status": "running",
            "owner": {"pid": 999999999, "startTicks": "1"},
        }
        unknown = {"job": str(uuid.uuid4()), "status": "running", "owner": {"pid": os.getpid()}}
        reused = {
            "job": str(uuid.uuid4()),
            "status": "queued",
            "owner": {"pid": os.getpid(), "startTicks": "0"},
        }
        for record in (dead, unknown, reused):
            (jobs / (record["job"] + ".json")).write_text(json.dumps(record))
        with open(self.state / "lease", "a+") as lease:
            fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
            busy = self.preview()
            self.assertEqual(busy["status"], "failed")
            self.assertIn("busy", busy["next"])
            self.assertFalse((self.state / "plans").exists())
            self.assertEqual(
                json.loads((jobs / (dead["job"] + ".json")).read_text())["status"], "running"
            )
        self.assertEqual(self.preview()["status"], "complete")
        self.assertEqual(
            json.loads((jobs / (dead["job"] + ".json")).read_text())["status"], "incomplete"
        )
        self.assertEqual(
            json.loads((jobs / (reused["job"] + ".json")).read_text())["status"], "incomplete"
        )
        self.assertEqual(
            json.loads((jobs / (unknown["job"] + ".json")).read_text())["status"], "running"
        )
        with mock.patch("pathlib.Path.read_text", side_effect=PermissionError()):
            self.assertFalse(MODULE.owner_dead({"pid": os.getpid(), "startTicks": "1"}))

    def test_eof_after_backup_retains_sources_and_archive(self):
        plan = self.preview()
        done = self.apply(plan, disconnect_on_context=3)
        self.assertEqual(done["counts"]["removed"], 0)
        self.assertEqual(done["counts"]["backedUp"], 1)
        self.assertTrue(self.worktree.exists())
        self.assertTrue((Path(done["rows"][0]["backup"]) / "manifest.json").exists())
        self.assertEqual(done["rows"][0]["reason"], "Caller context disconnected")

    def test_safe_snapshot_failure_reasons_hide_paths_and_raw_errors(self):
        os.mkfifo(self.worktree / "private-credential-name")
        plan = self.preview()
        self.assertEqual(plan["counts"]["eligible"], 0)
        self.assertEqual(plan["rows"][1]["reason"], "Unsupported special file")
        self.assertNotIn("private-credential-name", json.dumps(plan))
        error = PermissionError(errno.EACCES, "sensitive error text", "/private/path")
        self.assertEqual(MODULE.safe_failure(error), "Permission denied during protection check")
        self.assertEqual(
            MODULE.safe_failure(ValueError("sensitive text")), "Snapshot protection check failed"
        )

    def test_unreadable_same_user_process_fails_closed(self):
        process = mock.Mock()
        process.name = str(os.getpid() + 1)
        process.stat.return_value.st_uid = os.getuid()
        with (
            mock.patch.object(MODULE.Path, "iterdir", return_value=[process]),
            mock.patch.object(
                MODULE, "process_references", side_effect=PermissionError(errno.EACCES, "blocked")
            ),
        ):
            with self.assertRaises(PermissionError):
                MODULE.active_process_paths()
        plan = self.preview(fail_process_scan=True)
        self.assertEqual(plan["counts"]["eligible"], 0)
        self.assertEqual(plan["rows"][1]["reason"], "Same-user process inspection failed")
        self.assertTrue(self.worktree.exists())

    def test_path_traversal_tampering_and_caller_restrictions(self):
        plan = self.preview()
        for fields in [
            {"plan": "../escape", "paths": [str(self.worktree)]},
            {"plan": plan["plan"], "paths": [str(self.repo)]},
            {"plan": plan["plan"], "paths": [str(self.worktree) + "/../old"]},
            {
                "plan": plan["plan"],
                "paths": [str(self.worktree)],
                "caller": {"id": "caller", "issueRun": True},
            },
            {"plan": plan["plan"], "paths": [str(self.worktree)], "caller": {"id": "missing"}},
        ]:
            done = self.run_job("apply", **fields)
            self.assertEqual(done["status"], "failed")
            self.assertTrue(self.worktree.exists())

    def test_ownership_context_indexes_many_paths_once(self):
        roots = [f"/benchmark/worktree-{position}" for position in range(67)]
        records = [{"path": root, "locked": False} for root in roots]
        entries = [
            {
                "kind": "create",
                "path": f"{roots[0]}/missing/..",
                "thread": "owner",
            }
        ]
        entries.extend({"kind": "create", "path": root, "thread": "owner"} for root in roots[1:])
        descendant_creator = {
            "kind": "create",
            "path": f"{roots[0]}/nested",
            "thread": "descendant",
        }
        parent_use = {"kind": "use", "path": "/benchmark", "thread": "caller"}
        entries.extend((descendant_creator, parent_use))
        for position in range(41_264 - len(entries)):
            root = roots[position % len(roots)]
            entries.append(
                {
                    "kind": "use",
                    "path": f"{root}/files/{position}",
                    "thread": "owner",
                }
            )
        current = {
            "threads": [
                {"id": "owner", "archived": True, "cwd": "/benchmark/old"},
                {"id": "caller", "archived": False, "cwd": "/benchmark"},
            ],
            "evidence": {"stale": False, "version": "fresh", "entries": entries},
        }
        with mock.patch.object(MODULE, "canonical", wraps=MODULE.canonical) as canonicalize:
            ownership = MODULE.prepare_ownership_context(records, current)
            calls_after_prepare = canonicalize.call_count
            for root in roots:
                MODULE.evidence_reasons(root, ownership)
                MODULE.thread_reasons(root, {"id": "caller"}, ownership)
            self.assertEqual(canonicalize.call_count, calls_after_prepare)
        unique_paths = {entry["path"] for entry in entries}
        self.assertEqual(len(unique_paths), 41_264)
        self.assertLessEqual(calls_after_prepare, len(unique_paths) + 2 + len(roots))
        self.assertEqual(MODULE.creator_ids(roots[0], ownership), ["owner"])
        self.assertIn(descendant_creator, ownership["entries"][roots[0]])
        self.assertNotIn(parent_use, ownership["entries"][roots[0]])
        self.assertEqual(
            MODULE.thread_reasons(roots[0], {"id": "caller"}, ownership),
            [],
            "A generic parent cwd does not imply use of descendant worktrees",
        )


if __name__ == "__main__":
    unittest.main()
