# Harbor adapter

Pinned integration: Python 3.12+, Harbor 0.25.0, Node 24.11.1, Codex CLI 0.163.0.
The adapter runs Console's provider layer through `scripts/harness-eval.ts`. It never
selects Claude, installs host MCP configuration, or reads host credential files.
Only an explicitly scoped `extra_env.OPENAI_API_KEY` is accepted. Supply a dedicated
benchmark key through your secret manager; never mount production HOME or data.
The runner also creates isolated provider configuration. The task environment has
network access for inference; the verifiers require no network or extra packages.

Install with `uv venv --python 3.12 /tmp/console-harbor` then
`uv pip install --python /tmp/console-harbor/bin/python -r evals/harbor/requirements.txt`.
Run `PYTHONPATH=. /tmp/console-harbor/bin/python test/harbor-adapter.py`.

Build the prebaked image from a clean, tracked source archive (including the committed
runner), never the working directory containing secrets:

```sh
mkdir /tmp/console-eval-image
git archive HEAD | tar -x -C /tmp/console-eval-image
docker build -f /tmp/console-eval-image/evals/harbor/Dockerfile -t agent-console-eval:harbor-v1 /tmp/console-eval-image
```

The fixture Dockerfiles use this local versioned image. For published measurements,
replace `EVAL_IMAGE` with its immutable registry digest and record it with the source
commit and exact dependency versions. The local tag is mutable: record the image ID
and use the same exact image in both benchmark arms. Install validates Node's major version, Codex,
and the runner path, failing instead of silently downloading a different runtime.
Configure Harbor's custom import path as `evals.harbor.agent_console:AgentConsoleAgent`,
with an explicit `model_name`, `reasoning_effort`, `timeout_sec`, and scoped key.
For example, set `EVAL_MODEL` to the explicit Codex model to measure, then run:

```sh
PYTHONPATH=. secret run benchmark-openai -- /tmp/console-harbor/bin/harbor run \
  --agent evals.harbor.agent_console:AgentConsoleAgent --model "$EVAL_MODEL" \
  --agent-env 'OPENAI_API_KEY=${OPENAI_API_KEY}' \
  --agent-kwarg reasoning_effort=low --agent-kwarg timeout_sec=120 \
  --path evals/harbor/tasks --n-attempts 3 --n-concurrent 1
```

`benchmark-openai` must be a dedicated secret exporting `OPENAI_API_KEY`.
The single-quoted Harbor template resolves the value internally, without putting it
in command arguments. The CLI/import path and template resolver are verified against
0.25.0. Use `harbor run --help` and `harbor job schema` for other configuration; Harbor 0.25 uses `install`/`run`, not older command-template hooks.
Run the fixed directory `evals/harbor/tasks`, three attempts, one concurrent trial.

Artifacts synchronize from Harbor's agent log directory even on execution failure:
`events.jsonl`, validated `trajectory.json` (ATIF-v1.8), and `result.json`.
A completed runner is not a passing task; Harbor runs the independent verifier and
reads numeric `/logs/verifier/reward.txt`. Timeouts and nonzero exits fail the trial.
The local tests prove API compatibility, quoting, artifacts, and fixture baseline/oracle
behavior. They do not prove Docker or live inference execution.
