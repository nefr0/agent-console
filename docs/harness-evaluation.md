# Harness evaluation

This integration measures Agent Console's **Codex provider layer**: the Console instruction builder, Codex app-server adapter, canonical events, and token accounting. It does not measure the UI, thread scheduler, Auto review/recovery, checkpoints, or live Brain memory. A provider completing a turn is not evidence that it solved the task; the benchmark verifier decides that separately.

## Implementation plan

1. Provide an isolated, bounded, Codex-only headless runner with raw events, a result record, and a Harbor-compatible trajectory.
2. Integrate that runner with Harbor and provide two small tasks with independent verifiers and reference solutions.
3. Validate provider execution with a fake Codex app-server, validate the adapter against a pinned Harbor release, and prove that each task fails initially and passes after its reference solution.
4. On a Docker-capable host, run native Codex and the Console adapter under the same conditions before expanding the task set.

Claude and Pi are deliberately unsupported in this first integration. The runner must reject unsupported providers before starting a process. Unit tests use protocol fixtures and do not call a model.

## Headless runner

From a source checkout with Node 24 and dependencies installed:

```sh
node scripts/harness-eval.ts --help
node scripts/harness-eval.ts \
  --provider codex \
  --model YOUR_EXPLICIT_CODEX_MODEL \
  --effort low \
  --cwd /absolute/task/workspace \
  --prompt-file /absolute/instruction.txt \
  --output-dir /absolute/trial-output \
  --timeout-sec 120
```

The task workspace is writable by the agent. Run untrusted benchmark tasks inside the benchmark sandbox, not against a working project. Fresh configuration directories prevent accidental reuse of production Console state; they do not replace an operating-system sandbox.

This profile retains the shared Console instruction block, which can mention Console tools unavailable in this standalone runtime. That is a profile limitation; those tools are not covered by these results.

The runner uses a private Codex configuration and private Console state. It excludes production MCP credentials, rate broker settings, Brain memory, style files, and ambient provider configuration. Authentication and runtime requirements are described in [the Harbor integration instructions](../evals/harbor/README.md). Never copy the host Codex configuration or an entire credential directory into a task image.

The runner enforces the requested provider deadline and a 1 MiB output limit. It terminates its provider process group on completion, timeout, or interruption. Container confinement remains necessary for untrusted processes.

Each run produces:

| Artifact | Purpose |
| --- | --- |
| `events.jsonl` | Canonical provider events for diagnosis. |
| `trajectory.json` | Standardized agent trajectory for Harbor inspection. |
| `result.json` | Provider completion status, configuration, elapsed time, and reported token usage. |

Preserve these artifacts with the verifier reward. Logs can contain task source and model output; handle them as task data. Missing usage or prices must remain unknown rather than being estimated as zero cost.

## Harbor tasks and validation

See [the adapter README](../evals/harbor/README.md) for the pinned Harbor version, installation, image requirements, custom-agent invocation, and task commands.

The local task set is a smoke suite, not a capability leaderboard:

| Task | Acceptance condition |
| --- | --- |
| `repair-empty-input` | Correct Python behavior for the specified empty-input and negative-number cases. |
| `stable-json-output` | Deterministic JSON output with the specified duplicate and missing-field handling. |

The benchmark must install or expose its independent verifier after agent execution. A clean grade must depend on the submitted artifacts, not modifications to the agent's test environment. Keep verifier failures separate from runner failures, authentication errors, and sandbox startup failures.

## Native versus Console protocol

Use Harbor's native `codex` agent as the baseline and the custom Console adapter as the candidate. Pin the following for both arms:

- Exact task version, container image, network policy, and CPU/memory limits.
- Exact Codex version, model, reasoning effort, and wall-clock budget.
- Initial task state and authentication method, with fresh writable state for each independent trial.
- Console revision, instruction profile, and tool configuration for the candidate.

Start with a fixed subset to validate the setup. A proposed first comparison is 20 tasks with three independent attempts per task per arm: 120 trials. Run each attempt as its own trial; do not quietly retry failed attempts or select only the best output. Expand the sample before interpreting small differences.

Report verifier pass rate, elapsed time, input/output/cached tokens, cost per solved task when pricing is available, intervention rate, and infrastructure failures. Include uncertainty and paired per-task outcomes. A zero-solve arm has no finite cost-per-solve estimate. Keep cold and warm runs separate.

Terminal-Bench is a useful first external workload. Harbor-Index broadens coverage; repository-level benchmarks add issue-resolution coverage. Keep suite scores separate rather than averaging unrelated tasks into a single quality number.

After establishing a baseline, disable one Console addition at a time. The provider-layer runner does not currently expose live Brain or full Auto orchestration, so those comparisons require a later integration rather than a flag that silently claims coverage.

## Remaining work

Full thread/Auto evaluation needs an isolated orchestration environment and its own acceptance tests. A universal completion verifier, aggregate child-agent token/dollar limits, and a regression dashboard are separate features. This integration supplies a measurement path; it does not claim those features are implemented.

## Sources

- [Harbor custom agents](https://docs.harborframework.com/agents/custom-agents).
- [Harbor pre-integrated agents](https://docs.harborframework.com/agents/pre-integrated-agents).
- [Harbor trajectory format](https://docs.harborframework.com/agents/atif).
- [Harbor-Index paper](https://arxiv.org/abs/2609.04298).
- [Agent evaluation guidance](https://www.anthropic.com/research/demystifying-evals-for-ai-agents).

Rolling documentation can differ from the pinned release. The installed package's API and schema are the compatibility check.
