"""Worktree cleanup protection and snapshot tests."""

import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import tarfile
import unittest
from pathlib import Path

FIXTURE_SPEC = importlib.util.spec_from_file_location(
    "worktree_cleanup_fixture", Path(__file__).with_name("worktree-cleanup-fixture.py")
)
FIXTURE = importlib.util.module_from_spec(FIXTURE_SPEC)
FIXTURE_SPEC.loader.exec_module(FIXTURE)
CleanupFixture = FIXTURE.CleanupFixture
MODULE = FIXTURE.MODULE


class CleanupTests(CleanupFixture, unittest.TestCase):
    def test_dirty_binary_ignored_symlink_and_index_roundtrip(self):
        (self.worktree / "tracked").write_text("staged\n")
        self.git(self.worktree, "add", "tracked")
        (self.worktree / "tracked").write_text("dirty\n")
        (self.worktree / "ignored").write_bytes(b"\x00\xffignored")
        (self.worktree / "binary").write_bytes(bytes(range(256)))
        (self.worktree / "link").symlink_to("binary")
        outside = self.root / "outside"
        outside.write_text("preserve")
        (self.worktree / "outside-link").symlink_to(outside)
        expected = MODULE.snapshot(self.worktree)
        plan = self.preview()
        self.assertEqual(plan["counts"]["eligible"], 1, plan)
        done = self.apply(plan)
        self.assertEqual(done["counts"]["removed"], 1, done)
        self.assertFalse(self.worktree.exists())
        backup = Path(done["rows"][0]["backup"])
        manifest = json.loads((backup / "manifest.json").read_text())
        self.assertEqual(
            manifest["archiveSha256"],
            hashlib.sha256((backup / "files.tar.gz").read_bytes()).hexdigest(),
        )
        self.git(self.repo, "worktree", "add", "-q", str(self.worktree), "retained-branch")
        with tarfile.open(backup / "files.tar.gz") as archive:
            archive.extractall(self.worktree, filter="fully_trusted")
        gitdir = Path(self.git(self.worktree, "rev-parse", "--absolute-git-dir"))
        shutil.copyfile(backup / "git-metadata/index", gitdir / "index")
        restored = MODULE.snapshot(self.worktree)
        self.assertEqual(restored["files"], expected["files"])
        self.assertEqual(restored["metadata"]["index"], expected["metadata"]["index"])
        self.assertEqual(outside.read_text(), "preserve")
        self.assertEqual(self.git(self.repo, "rev-parse", "retained-branch"), expected["head"])
        self.assertTrue(manifest["removed"])
        self.assertEqual(os.stat(backup).st_mode & 0o777, 0o700)
        self.assertEqual(os.stat(backup / "files.tar.gz").st_mode & 0o777, 0o600)

    def test_detached_commit_recovery_reference(self):
        self.git(self.worktree, "checkout", "--detach", "-q")
        (self.worktree / "tracked").write_text("detached commit")
        self.git(self.worktree, "commit", "-qam", "Detached")
        head = self.git(self.worktree, "rev-parse", "HEAD")
        done = self.apply(self.preview())
        self.assertEqual(done["counts"]["removed"], 1, done)
        manifest = json.loads((Path(done["rows"][0]["backup"]) / "manifest.json").read_text())
        self.assertEqual(self.git(self.repo, "rev-parse", manifest["recoveryRef"]), head)

    def test_canonical_locked_process_and_shared_links(self):
        self.git(self.repo, "worktree", "lock", str(self.worktree))
        plan = self.preview()
        self.assertIn("Canonical checkout", plan["rows"][0]["reason"])
        self.assertIn("Locked worktree", plan["rows"][1]["reason"])
        self.git(self.repo, "worktree", "unlock", str(self.worktree))
        process = subprocess.Popen(
            ["/usr/bin/python3", "-c", "import sys; sys.stdin.read()"],
            cwd=self.worktree,
            stdin=subprocess.PIPE,
        )
        try:
            references = MODULE.process_references(Path(f"/proc/{process.pid}"))
            self.assertIn(str(self.worktree), references)
            self.assertIn(
                "Process uses worktree",
                self.preview(process_paths=[str(self.worktree)])["rows"][1]["reason"],
            )
        finally:
            process.stdin.close()
            process.wait(timeout=5)
        (self.repo / "shared").symlink_to(self.worktree / "tracked")
        self.assertIn("External symlink", self.preview()["rows"][1]["reason"])

    def test_stale_evidence_active_unknown_and_caller(self):
        self.current["evidence"]["stale"] = True
        stale = self.preview()
        self.assertEqual(stale["counts"]["eligible"], 0)
        self.assertIn("stale or unavailable", stale["next"])
        self.assertIn("new preview", stale["next"])
        self.current["evidence"]["stale"] = False
        self.current["threads"][0]["archived"] = False
        ineligible = self.preview()
        self.assertEqual(ineligible["counts"]["eligible"], 0)
        self.assertIn("No eligible worktrees", ineligible["next"])
        self.assertIn("retained reasons", ineligible["next"])
        self.current["threads"][0]["archived"] = True
        self.current["evidence"]["entries"].append(
            {"kind": "ambiguous", "path": str(self.worktree), "thread": "missing"}
        )
        self.assertEqual(self.preview()["counts"]["eligible"], 0)

    def test_stale_plan_including_ignored_index_and_head(self):
        plan = self.preview()
        (self.worktree / "ignored").write_text("new ignored data")
        done = self.apply(plan)
        self.assertEqual(done["counts"]["removed"], 0)
        self.assertIn("changed since preview", done["rows"][0]["reason"])
        self.assertTrue(self.worktree.exists())

    def test_generic_parent_cwd_does_not_imply_worktree_use(self):
        self.current["threads"][1]["cwd"] = str(self.root)
        self.current["evidence"]["entries"].append(
            {"kind": "use", "path": str(self.root), "thread": "caller"}
        )
        plan = self.preview()
        self.assertEqual(plan["counts"]["eligible"], 1, plan)
        self.current["threads"][1]["cwd"] = str(self.worktree / "subdir")
        self.assertEqual(self.preview()["counts"]["eligible"], 0)

    def test_index_and_head_changes_invalidate_plan(self):
        (self.worktree / "tracked").write_text("unstaged")
        plan = self.preview()
        self.git(self.worktree, "add", "tracked")
        self.assertEqual(self.apply(plan)["counts"]["removed"], 0)
        plan = self.preview()
        self.git(self.worktree, "commit", "-qm", "Changed head")
        self.assertEqual(self.apply(plan)["counts"]["removed"], 0)
        self.assertTrue(self.worktree.exists())


if __name__ == "__main__":
    unittest.main()
