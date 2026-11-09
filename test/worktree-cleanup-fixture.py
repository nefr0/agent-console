"""Shared scratch fixture for worktree cleanup integration tests."""

import importlib.util
import json
import subprocess
import tempfile
import uuid
from pathlib import Path

ENGINE = Path(__file__).resolve().parents[1] / "scripts/worktree-cleanup-engine.py"
BOOTSTRAP = Path(__file__).resolve().with_name("worktree-cleanup-bootstrap.py")
SPEC = importlib.util.spec_from_file_location("cleanup_engine", ENGINE)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class CleanupFixture:
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="worktree-cleanup-test-")
        self.root = Path(self.temporary.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.state = self.root / "state"
        self.state.mkdir(mode=0o700)
        self.git(self.repo, "init", "-q")
        self.git(self.repo, "config", "user.email", "test@example.invalid")
        self.git(self.repo, "config", "user.name", "Test")
        (self.repo / "tracked").write_text("base\n")
        (self.repo / ".gitignore").write_text("ignored\n")
        self.git(self.repo, "add", ".")
        self.git(self.repo, "commit", "-qm", "Initial")
        self.worktree = self.root / "old"
        self.git(self.repo, "worktree", "add", "-qb", "retained-branch", str(self.worktree))
        self.current = {
            "threads": [
                {"id": "owner", "archived": True, "cwd": str(self.worktree), "status": "idle"},
                {"id": "caller", "archived": False, "cwd": str(self.repo), "status": "running"},
            ],
            "evidence": {
                "stale": False,
                "version": "fresh",
                "entries": [
                    {"kind": "create", "path": str(self.worktree), "thread": "owner", "line": 1}
                ],
            },
        }

    def tearDown(self):
        self.temporary.cleanup()

    def git(self, root, *arguments):
        return (
            subprocess.check_output(["git", "-C", str(root), *arguments], stderr=subprocess.DEVNULL)
            .decode()
            .strip()
        )

    def run_job(
        self,
        action,
        before_context=None,
        disconnect_on_context=None,
        process_paths=None,
        fail_process_scan=False,
        **fields,
    ):
        request = {
            "action": action,
            "job": str(uuid.uuid4()),
            "state": str(self.state),
            "home": str(self.root),
            "caller": {"id": "caller"},
            **fields,
        }
        command = ["/usr/bin/python3", "-I", str(BOOTSTRAP)]
        for process_path in process_paths or []:
            command.extend(("--process-path", process_path))
        if fail_process_scan:
            command.append("--fail-process-scan")
        worker = subprocess.Popen(
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            cwd=self.state,
            env={
                "PATH": "/usr/bin:/bin",
                "HOME": str(self.root),
                "GIT_CONFIG_GLOBAL": "/dev/null",
                "GIT_CONFIG_NOSYSTEM": "1",
            },
        )
        worker.stdin.write(json.dumps(request) + "\n")
        worker.stdin.flush()
        count = 0
        result = None
        for line in worker.stdout:
            message = json.loads(line)
            self.assertIn(message["type"], ("context", "progress", "result"))
            if message["type"] == "context":
                count += 1
                if disconnect_on_context == count:
                    worker.stdin.close()
                    continue
                if before_context:
                    before_context(count)
                worker.stdin.write(
                    json.dumps({"requestId": message["requestId"], **self.current}) + "\n"
                )
                worker.stdin.flush()
            elif message["type"] == "result":
                result = message["result"]
        worker.stdin.close()
        error = worker.stderr.read()
        worker.stdout.close()
        worker.stderr.close()
        worker.wait(timeout=5)
        self.assertEqual(error, "")
        self.assertIsNotNone(result)
        return result

    def preview(self, **fields):
        return self.run_job("preview", repo=str(self.repo), **fields)

    def apply(self, plan, **fields):
        return self.run_job("apply", plan=plan["plan"], paths=[str(self.worktree)], **fields)
