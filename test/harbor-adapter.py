"""Offline fixture proof; optional tests against pinned Harbor's real API."""

import asyncio
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
HARBOR_AVAILABLE = importlib.util.find_spec("harbor") is not None
if "--require-harbor" in sys.argv:
    sys.argv.remove("--require-harbor")
    if not HARBOR_AVAILABLE:
        raise SystemExit("Pinned Harbor is required; install evals/harbor/requirements.txt")
if HARBOR_AVAILABLE:
    from harbor.agents.factory import AgentFactory
    from harbor.environments.docker.docker_unix import UnixOps
    from harbor.models.agent.context import AgentContext
    from harbor.models.job.config import JobConfig
    from harbor.models.task.config import TaskConfig

    from evals.harbor.agent_console import AgentConsoleAgent


class FixtureTests(unittest.TestCase):
    def test_broken_baseline_fails_and_oracle_passes(self):
        for task in sorted((ROOT / "evals/harbor/tasks").iterdir()):
            with self.subTest(task=task.name), tempfile.TemporaryDirectory() as temporary:
                scratch = Path(temporary)
                application = scratch / "app"
                shutil.copytree(task / "environment", application)
                environment = {
                    **os.environ,
                    "TASK_APP": str(application),
                    "REWARD_DIR": str(scratch / "reward"),
                }
                baseline = subprocess.run(
                    ["sh", str(task / "tests/test.sh")], env=environment, capture_output=True
                )
                self.assertNotEqual(baseline.returncode, 0)
                self.assertEqual((scratch / "reward/reward.txt").read_text(), "0\n")
                subprocess.run(["sh", str(task / "solution/solve.sh")], env=environment, check=True)
                oracle = subprocess.run(
                    ["sh", str(task / "tests/test.sh")], env=environment, capture_output=True
                )
                self.assertEqual(oracle.returncode, 0, oracle.stderr.decode())
                self.assertEqual((scratch / "reward/reward.txt").read_text(), "1\n")


class FakeEnvironment:
    default_user = None

    def __init__(self, failure=False, timeout=False, status="completed"):
        self.commands = []
        self.uploads = []
        self.downloads = []
        self.failure = failure
        self.timeout = timeout
        self.status = status

    async def exec(self, **kwargs):
        self.commands.append(kwargs)
        if self.timeout and "--provider codex" in kwargs["command"]:
            raise TimeoutError("simulated timeout")
        failed = self.failure and "--provider codex" in kwargs["command"]
        return SimpleNamespace(
            return_code=1 if failed else 0,
            stdout="1000\n" if "id -u" in kwargs["command"] else "",
            stderr="simulated failure" if failed else "",
        )

    async def upload_file(self, source_path, target_path):
        self.uploads.append((Path(source_path).read_text(), target_path))

    async def download_dir(self, source_dir, target_dir):
        self.downloads.append(source_dir)
        target = Path(target_dir)
        target.mkdir(parents=True, exist_ok=True)
        trajectory = {
            "schema_version": "ATIF-v1.8",
            "agent": {"name": "agent-console", "version": "test"},
            "steps": [{"step_id": 1, "source": "user", "message": "fixture"}],
        }
        (target / "trajectory.json").write_text(json.dumps(trajectory))
        (target / "result.json").write_text(json.dumps({"status": self.status}))


@unittest.skipUnless(HARBOR_AVAILABLE, "Install pinned Harbor for adapter API tests")
class AdapterTests(unittest.TestCase):
    def test_docker_download_copies_directory_contents(self):
        class FakeDockerEnvironment:
            @staticmethod
            def runtime():
                return SimpleNamespace(supports_compose_cp=False)

        transfer = UnixOps(FakeDockerEnvironment())
        transfer._download_via_engine_cp = AsyncMock()
        with tempfile.TemporaryDirectory() as temporary:
            asyncio.run(transfer.download_dir("/logs/agent/console-run", temporary))
            transfer._download_via_engine_cp.assert_awaited_once_with(
                "/logs/agent/console-run/.", temporary, "main"
            )

    def test_real_factory_constructs_import_path(self):
        config = JobConfig.model_validate(
            {
                "agents": [
                    {
                        "name": "evals.harbor.agent_console:AgentConsoleAgent",
                        "model_name": "gpt-test",
                        "env": {"OPENAI_API_KEY": "offline-fixture"},
                        "kwargs": {"timeout_sec": 9},
                    }
                ]
            }
        ).agents[0]
        with tempfile.TemporaryDirectory() as temporary:
            agent = AgentFactory.create_agent_from_config(config, logs_dir=Path(temporary))
            self.assertIsInstance(agent, AgentConsoleAgent)
            self.assertEqual(agent.timeout_sec, 9)
            self.assertEqual(agent._extra_env, {"OPENAI_API_KEY": "offline-fixture"})

    def test_runtime_prompt_arguments_and_atif(self):
        with tempfile.TemporaryDirectory() as temporary:
            agent = AgentConsoleAgent(
                Path(temporary), model_name="gpt-test'; touch /tmp/nope", timeout_sec=7
            )
            environment = FakeEnvironment()
            instruction = "Keep $(false) and 'quotes' private\nnext line"
            asyncio.run(agent.setup(environment))
            context = AgentContext()
            asyncio.run(agent.run(instruction, environment, context))
            self.assertEqual(environment.uploads[0][0], instruction)
            runner = next(
                item for item in environment.commands if "--provider codex" in item["command"]
            )
            import shlex

            arguments = shlex.split(runner["command"])
            self.assertEqual(arguments[arguments.index("--model") + 1], agent.model_name)
            self.assertNotIn(instruction, runner["command"])
            self.assertEqual(runner["timeout_sec"], 22)
            self.assertIn("env -i", runner["command"])
            self.assertIn("chmod 600", str(environment.commands))
            self.assertIn("chown 1000", str(environment.commands))
            self.assertEqual(runner["env"], {"OPENAI_API_KEY": ""})
            self.assertEqual(
                arguments[arguments.index("--output-dir") + 1], "/logs/agent/console-run"
            )
            self.assertIsNone(context.metadata["verifier_success"])
            self.assertEqual(agent.convert_trajectory(Path(temporary)).schema_version, "ATIF-v1.8")

    def test_error_still_downloads_artifacts(self):
        with tempfile.TemporaryDirectory() as temporary:
            agent = AgentConsoleAgent(Path(temporary), model_name="gpt-test")
            environment = FakeEnvironment(failure=True)
            with self.assertRaises(RuntimeError):
                asyncio.run(agent.run("task", environment, AgentContext()))
            self.assertEqual(environment.downloads, ["/logs/agent/console-run"])

    def test_timeout_and_incomplete_results_fail(self):
        for environment, error in [
            (FakeEnvironment(timeout=True), TimeoutError),
            (FakeEnvironment(status="needs_input"), RuntimeError),
        ]:
            with self.subTest(error=error), tempfile.TemporaryDirectory() as temporary:
                agent = AgentConsoleAgent(Path(temporary), model_name="gpt-test")
                with self.assertRaises(error):
                    asyncio.run(agent.run("task", environment, AgentContext()))
                self.assertEqual(environment.downloads, ["/logs/agent/console-run"])

    def test_invalid_trajectory_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            agent = AgentConsoleAgent(Path(temporary), model_name="gpt-test")
            (Path(temporary) / "trajectory.json").write_text('{"steps":[]}')
            with self.assertRaises(ValueError):
                agent.convert_trajectory(Path(temporary))

    def test_rejects_unsafe_configuration(self):
        for options in [
            {},
            {"model_name": "claude"},
            {"model_name": "gpt", "timeout_sec": 0},
            {"model_name": "gpt", "extra_env": {"ANTHROPIC_API_KEY": "fake"}},
            {"model_name": "gpt", "mcp_servers": ["fake"]},
        ]:
            with self.subTest(options=options), self.assertRaises(ValueError):
                AgentConsoleAgent(Path("/tmp"), **options)

    def test_task_configuration_validates(self):
        import tomllib

        for task in (ROOT / "evals/harbor/tasks").iterdir():
            config = TaskConfig.model_validate(tomllib.loads((task / "task.toml").read_text()))
            self.assertEqual(config.agent.timeout_sec, 120)


if __name__ == "__main__":
    unittest.main()
