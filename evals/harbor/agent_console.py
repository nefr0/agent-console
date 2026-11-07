"""Harbor 0.25 adapter for the isolated Agent Console provider runner."""

import json
import shlex
from pathlib import Path

from harbor.agents.capabilities import AgentCapabilities
from harbor.agents.installed.base import BaseInstalledAgent
from harbor.models.trajectories.trajectory import Trajectory


class AgentConsoleAgent(BaseInstalledAgent):
    """Require a prebaked runtime; never install host configuration or tools."""

    capabilities = AgentCapabilities(atif=True, reasoning_effort=True)

    def __init__(
        self,
        logs_dir,
        *,
        model_name=None,
        timeout_sec=120,
        reasoning_effort="low",
        runner_path="/opt/agent-console/scripts/harness-eval.ts",
        extra_env=None,
        **kwargs,
    ):
        if not model_name or any(name in model_name.lower() for name in ("claude", "anthropic")):
            raise ValueError("An explicit Codex model is required")
        if not 1 <= int(timeout_sec) <= 3600:
            raise ValueError("timeout_sec must be between 1 and 3600")
        if reasoning_effort not in ("low", "medium", "high", "xhigh"):
            raise ValueError("Unsupported reasoning effort")
        if set(extra_env or {}) - {"OPENAI_API_KEY"}:
            raise ValueError("Only explicitly scoped OPENAI_API_KEY is supported")
        if kwargs.get("mcp_servers") or kwargs.get("skills_dir"):
            raise ValueError("Benchmark runtime does not accept MCP servers or host skills")
        self.timeout_sec = int(timeout_sec)
        self.reasoning_effort = reasoning_effort
        self.runner_path = runner_path
        super().__init__(
            logs_dir=logs_dir,
            model_name=model_name,
            extra_env=extra_env,
            skip_model_parsing=True,
            **kwargs,
        )

    @staticmethod
    def name():
        return "agent-console"

    def get_version_command(self):
        return "node --version"

    async def install(self, environment):
        command = (
            "node -e 'if(Number(parseInt(process.versions.node))!==24)process.exit(1)'"
            " && codex --version && test -f " + shlex.quote(self.runner_path)
        )
        await self.exec_as_agent(environment, command, timeout_sec=30)

    async def run(self, instruction, environment, context):
        remote_logs = self.environment_logs_dir.as_posix()
        runner_logs = remote_logs + "/console-run"
        prompt_path = "/installed-agent/agent-console-prompt.txt"
        await self._upload_config_text(
            environment,
            content=self.render_instruction(instruction),
            remote_path=prompt_path,
            filename="prompt.txt",
        )
        identity = await self.exec_as_agent(environment, "id -u", timeout_sec=10)
        agent_uid = identity.stdout.strip()
        if not agent_uid.isdecimal():
            raise RuntimeError("Cannot determine benchmark agent UID")
        await self.exec_as_root(
            environment,
            "chown "
            + agent_uid
            + " "
            + shlex.quote(prompt_path)
            + " && chmod 600 "
            + shlex.quote(prompt_path),
            timeout_sec=10,
        )
        arguments = [
            "node",
            self.runner_path,
            "--provider",
            "codex",
            "--model",
            self.model_name,
            "--effort",
            self.reasoning_effort,
            "--cwd",
            "/app",
            "--prompt-file",
            prompt_path,
            "--output-dir",
            runner_logs,
            "--timeout-sec",
            str(self.timeout_sec),
        ]
        # env -i prevents image/Harbor scoped configuration from leaking into the provider.
        command = (
            "env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/tmp/console-eval-home "
            'OPENAI_API_KEY="${OPENAI_API_KEY:-}" ' + shlex.join(arguments)
        )
        try:
            await self.exec_as_agent(
                environment,
                command,
                env={"OPENAI_API_KEY": self._extra_env.get("OPENAI_API_KEY", "")},
                cwd="/app",
                timeout_sec=self.timeout_sec + 15,
            )
        finally:
            await environment.download_dir(runner_logs, self.logs_dir)
            await self.exec_as_agent(
                environment,
                "if [ -f "
                + shlex.quote(runner_logs + "/trajectory.json")
                + " ]; then cp "
                + shlex.quote(runner_logs + "/trajectory.json")
                + " "
                + shlex.quote(remote_logs + "/trajectory.json")
                + "; fi",
                timeout_sec=10,
            )
        trajectory = self.convert_trajectory(self.logs_dir)
        if trajectory is None:
            raise RuntimeError("Runner did not produce trajectory.json")
        result = json.loads((self.logs_dir / "result.json").read_text())
        if result.get("status") != "completed":
            raise RuntimeError("Runner did not complete: " + str(result.get("status")))
        context.metadata = {"runner_status": result["status"], "verifier_success": None}
        if trajectory.final_metrics:
            metrics = trajectory.final_metrics
            context.n_input_tokens = metrics.total_prompt_tokens
            context.n_output_tokens = metrics.total_completion_tokens
            context.n_cache_tokens = metrics.total_cached_tokens
            context.cost_usd = metrics.total_cost_usd

    def convert_trajectory(self, logs_dir):
        trajectory_path = Path(logs_dir) / "trajectory.json"
        if not trajectory_path.exists():
            return None
        return Trajectory.model_validate_json(trajectory_path.read_text())
