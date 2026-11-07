import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EvaluationTrace } from "./atif.ts";
import { prepareIsolation, validatePaths } from "./isolation.ts";
import { guardProcesses } from "./processes.ts";

export const MAX_OUTPUT_BYTES = 1024 * 1024;
export const HELP =
  "Usage: node scripts/harness-eval.ts --provider codex --model MODEL --effort low --cwd /app --prompt-file /tmp/instruction.txt --output-dir /logs/agent --timeout-sec 120";
export function parseArguments(args: string[]) {
  const values: Record<string, string> = {};
  const allowed = [
    "provider",
    "model",
    "effort",
    "cwd",
    "prompt-file",
    "output-dir",
    "timeout-sec",
  ];
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index].replace(/^--/, "");
    if (
      !args[index].startsWith("--") ||
      !allowed.includes(name) ||
      !args[index + 1] ||
      values[name]
    )
      throw new Error(`Invalid or repeated argument: ${args[index]}`);
    values[name] = args[index + 1];
  }
  if (values.provider !== "codex") throw new Error("Only --provider codex is permitted.");
  if (!values.model?.trim() || values.model === "default")
    throw new Error("An explicit --model is required.");
  if (!["minimal", "low", "medium", "high", "xhigh"].includes(values.effort))
    throw new Error("Explicit --effort must be minimal, low, medium, high or xhigh.");
  if (!["cwd", "prompt-file", "output-dir"].every((name) => values[name]))
    throw new Error("cwd, prompt-file and output-dir are required.");
  const timeout = Number(values["timeout-sec"]);
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 86400)
    throw new Error("timeout-sec must be greater than zero and at most 86400.");
  return { ...values, timeout };
}

function consoleCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

function recordEvents(
  eventFile: number,
  trace: EvaluationTrace,
  finish: (status: string, error?: string) => void,
  isSettled: () => boolean,
) {
  let bytes = 0;
  return (record: any) => {
    if (isSettled()) return;
    const line = `${JSON.stringify(record)}\n`;
    bytes += Buffer.byteLength(line);
    if (bytes > MAX_OUTPUT_BYTES) return finish("failed", "Canonical output exceeded 1 MiB.");
    fs.writeSync(eventFile, line);
    trace.event(record);
    if (["question", "permission", "permission_request"].includes(record.type))
      return finish("needs_input");
    if (record.type === "result") return finish(record.is_error ? "failed" : "completed");
    if (record.type === "console_error") finish("failed", String(record.text));
  };
}

export async function runEvaluation(args: string[]) {
  const options = parseArguments(args);
  const { workdir, prompt } = validatePaths(
    options.cwd,
    options["output-dir"],
    options["prompt-file"],
  );
  const commit = consoleCommit();
  const cleanup = prepareIsolation();
  const started = Date.now();
  const trace = new EvaluationTrace(prompt, options.model);
  let status = "failed",
    error: string | undefined,
    settled = false;
  let finish!: (status: string, error?: string) => void;
  const done = new Promise<void>((resolve) => {
    finish = (next, reason) => {
      if (settled) return;
      settled = true;
      status = next;
      error = reason;
      resolve();
    };
  });
  const eventFile = fs.openSync(path.join(options["output-dir"], "events.jsonl"), "wx", 0o600);
  const stopProcesses = guardProcesses(
    () => finish("failed", "Provider output exceeded 1 MiB."),
    MAX_OUTPUT_BYTES,
  );
  const timer = setTimeout(
    () => finish("timeout", "Evaluation deadline exceeded."),
    options.timeout * 1000,
  );
  const interrupted = (signal: NodeJS.Signals) =>
    finish("failed", `Evaluation interrupted by ${signal}.`);
  process.on("SIGINT", interrupted);
  process.on("SIGTERM", interrupted);
  const event = recordEvents(eventFile, trace, finish, () => settled);
  try {
    const { codex } = await import("../providers/codex.ts");
    if (!settled) {
      const agent = codex.start(
        {
          id: "evaluation",
          cwd: workdir,
          mode: "bypassPermissions",
          model: options.model,
          effort: options.effort,
        },
        {
          event,
          commands() {},
          exited(info) {
            finish(
              "failed",
              `Provider exited before completion (code=${info.code}, signal=${info.signal}).`,
            );
          },
        },
      );
      agent.send(prompt);
    }
    await done;
  } catch (failure) {
    finish("failed", String(failure));
  } finally {
    clearTimeout(timer);
    await stopProcesses();
    fs.closeSync(eventFile);
    cleanup();
    process.off("SIGINT", interrupted);
    process.off("SIGTERM", interrupted);
  }
  const result = {
    status,
    ...(error ? { error } : {}),
    provider: "codex",
    scope: "codex-provider-layer",
    requested_model: options.model,
    resolved_model: trace.model,
    effort: options.effort,
    console_commit: commit,
    timeout_sec: options.timeout,
    elapsed_ms: Date.now() - started,
    token_usage: trace.usage,
    task_solved: null,
    max_output_bytes: MAX_OUTPUT_BYTES,
  };
  for (const [name, value] of [
    ["result.json", result],
    ["trajectory.json", trace.trajectory(commit, options.effort)],
  ] as const)
    fs.writeFileSync(
      path.join(options["output-dir"], name),
      JSON.stringify(value, null, 2) + "\n",
      { mode: 0o600 },
    );
  if (trace.answer)
    fs.writeFileSync(path.join(options["output-dir"], "answer.txt"), trace.answer, { mode: 0o600 });
  return result;
}
