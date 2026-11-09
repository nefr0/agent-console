import { realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { callTool } from "../server/providers/console-tools.mjs";
import type { WorktreeJob } from "../server/worktree-contracts.ts";

export const CONSOLE_TOOL_USAGE = [
  "console-tool search TERMS [--provider claude|codex|pi] [--limit N]   past sessions (BM25)",
  "console-tool read SESSION LINE [--limit N]                           bounded range of a session found by search",
  "console-tool cli TERMS...                                            find command-line tools",
  'console-tool research "TASK" [--folder DIR]                          Pi research subagent; takes up to 11 min: run with run_in_background',
  "console-tool redact scan|apply|verify|status [--job ID]             transcript credential cleanup",
  "console-tool worktrees [preview] --repo PATH                         preview stale worktrees",
  "console-tool worktrees apply --plan ID --path PATH...                remove selected archived worktrees",
  "console-tool worktrees status --job ID                               inspect cleanup job",
  "Needs an Agent Console session (tool URL/token). Output is clipped to 20000 chars.",
].join("\n");

export const OUTPUT_LIMIT = 20_000;
const PROVIDERS = ["claude", "codex", "pi"];
const REDACT_ACTIONS = ["scan", "apply", "verify", "status"];
const WORKTREE_ACTIONS = ["preview", "apply", "status"];
const WORKTREE_WAIT_MS = 120_000;
const WORKTREE_ROW_LIMIT = 40;

type ToolRequest = { tool: string; input: Record<string, unknown>; timeoutMs: number };
function wholeNumber(text: string | undefined, label: string): number | undefined {
  if (text === undefined) return undefined;
  if (!/^[1-9]\d{0,5}$/.test(text)) throw new Error(`${label} must be a positive integer.`);
  return Number(text);
}

function withDefined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function requireWords(words: string[], what: string): string[] {
  if (words.length === 0 || words.some((word) => word.trim() === ""))
    throw new Error(`Give ${what}.\n${CONSOLE_TOOL_USAGE}`);
  return words;
}

export function parseConsoleToolArgs(args: string[]): ToolRequest | undefined {
  const { positionals, values } = parseArgs({
    args,
    options: {
      help: { type: "boolean", short: "h" },
      provider: { type: "string" },
      limit: { type: "string" },
      folder: { type: "string" },
      job: { type: "string" },
      repo: { type: "string" },
      plan: { type: "string" },
      path: { type: "string", multiple: true },
    },
    allowPositionals: true,
  });
  if (values.help || positionals.length === 0) return;
  const [verb, ...rest] = positionals;
  const limit = wholeNumber(values.limit, "--limit");
  if (verb === "search") {
    if (values.provider !== undefined && !PROVIDERS.includes(values.provider))
      throw new Error(`--provider must be one of ${PROVIDERS.join(", ")}.`);
    const query = requireWords(rest, "search terms").join(" ");
    return {
      tool: "session_search",
      input: withDefined({ query, provider: values.provider, limit }),
      timeoutMs: 30_000,
    };
  }
  if (verb === "read") {
    if (rest.length !== 2) throw new Error(`read needs SESSION and LINE.\n${CONSOLE_TOOL_USAGE}`);
    const start = wholeNumber(rest[1], "LINE");
    return {
      tool: "session_read",
      input: withDefined({ thread: rest[0], start, limit }),
      timeoutMs: 30_000,
    };
  }
  if (verb === "cli")
    return {
      tool: "cli_search",
      input: {
        terms: requireWords(rest, "CLI search terms").slice(0, 10),
        ...withDefined({ limit }),
      },
      timeoutMs: 30_000,
    };
  if (verb === "research") {
    if (rest.length !== 1 || rest[0].trim() === "")
      throw new Error(`research needs one quoted TASK.\n${CONSOLE_TOOL_USAGE}`);
    return {
      tool: "pi_research",
      input: withDefined({ task: rest[0], folder: values.folder }),
      timeoutMs: 11 * 60_000,
    };
  }
  if (verb === "redact") {
    if (rest.length !== 1 || !REDACT_ACTIONS.includes(rest[0]))
      throw new Error(`redact needs one of ${REDACT_ACTIONS.join("|")}.`);
    return {
      tool: "session_redact",
      input: withDefined({ action: rest[0], job: values.job }),
      timeoutMs: 30_000,
    };
  }
  if (verb === "worktrees") {
    const action = rest[0] ?? "preview";
    if (rest.length > 1 || !WORKTREE_ACTIONS.includes(action))
      throw new Error(`worktrees accepts preview, apply or status.\n${CONSOLE_TOOL_USAGE}`);
    if (values.limit !== undefined || values.provider !== undefined || values.folder !== undefined)
      throw new Error("worktrees does not accept --limit, --provider or --folder.");
    if (action === "preview") {
      if (
        !values.repo?.trim() ||
        !path.isAbsolute(values.repo) ||
        values.plan !== undefined ||
        values.job !== undefined ||
        values.path
      )
        throw new Error("worktrees preview needs --repo PATH only.");
      return { tool: "worktree_preview", input: { repo: values.repo }, timeoutMs: 30_000 };
    }
    if (action === "apply") {
      if (
        !values.plan?.trim() ||
        !values.path?.length ||
        values.repo !== undefined ||
        values.job !== undefined
      )
        throw new Error("worktrees apply needs --plan ID and one or more --path PATH values.");
      if (
        new Set(values.path).size !== values.path.length ||
        values.path.some(
          (entry) => !entry.trim() || !path.isAbsolute(entry) || path.normalize(entry) !== entry,
        )
      )
        throw new Error("worktrees apply paths must be unique, absolute, and normalized.");
      return {
        tool: "worktree_apply",
        input: { plan: values.plan, paths: values.path },
        timeoutMs: 30_000,
      };
    }
    if (
      !values.job?.trim() ||
      values.repo !== undefined ||
      values.plan !== undefined ||
      values.path
    )
      throw new Error("worktrees status needs --job ID only.");
    return { tool: "worktree_status", input: { job: values.job }, timeoutMs: 30_000 };
  }
  throw new Error(CONSOLE_TOOL_USAGE);
}

function parseToolResponse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(text.replace(/^Error:\s*/, ""));
  }
}

export async function waitForWorktreeJob(
  initial: WorktreeJob,
  getStatus: (job: string, timeoutMs: number) => Promise<WorktreeJob>,
  timeoutMs = WORKTREE_WAIT_MS,
): Promise<WorktreeJob | undefined> {
  const deadline = Date.now() + timeoutMs;
  let current = initial;
  let delayMs = 200;
  while (current.status === "queued" || current.status === "running") {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, Math.min(delayMs, remaining)));
    if (Date.now() >= deadline) return;
    try {
      current = await getStatus(initial.job, deadline - Date.now());
    } catch (error) {
      if (Date.now() >= deadline) return;
      throw error;
    }
    delayMs = Math.min(delayMs * 2, 2_000);
  }
  return current;
}

function worktreeSummary(job: WorktreeJob): string {
  const rows = job.rows.slice(0, WORKTREE_ROW_LIMIT);
  const retained = rows
    .filter((row) => !row.eligible)
    .map(({ path, reason }) => ({ path, reason }));
  const eligible = rows.filter((row) => row.eligible).map(({ path }) => path);
  const backups = rows.filter((row) => row.backup).map(({ path, backup }) => ({ path, backup }));
  const recipe =
    job.action === "preview" && job.plan && eligible.length
      ? `console-tool worktrees apply --plan ${job.plan}${eligible.map((value) => ` --path '${value.replaceAll("'", "'\\''")}'`).join("")}`
      : undefined;
  return JSON.stringify(
    {
      job: job.job,
      status: job.status,
      plan: job.plan,
      ...(job.status === "queued" ||
      job.status === "running" ||
      job.status === "incomplete" ||
      job.status === "failed"
        ? { check: `console-tool worktrees status --job ${job.job}` }
        : {}),
      report: job.report,
      next: job.next,
      counts: job.counts,
      eligible,
      retained,
      backups,
      ...(recipe ? { apply: recipe } : {}),
    },
    null,
    2,
  );
}

function assertWorktreeJobSucceeded(job: WorktreeJob): void {
  if (job.status === "failed" || job.status === "incomplete")
    throw new Error(
      `Worktree cleanup ${job.status}; recovery details follow.\n${clipOutput(worktreeSummary(job))}`,
    );
}

export function clipOutput(text: string): string {
  return text.length <= OUTPUT_LIMIT
    ? text
    : `${text.slice(0, OUTPUT_LIMIT)}\n... clipped ${text.length - OUTPUT_LIMIT} chars; narrow the query or use --limit.`;
}

export async function runConsoleTool(args: string[]): Promise<string> {
  const request = parseConsoleToolArgs(args);
  if (!request) return CONSOLE_TOOL_USAGE;
  const text: string = await callTool(
    request.tool,
    request.input,
    AbortSignal.timeout(request.timeoutMs),
  );
  if (text.startsWith("Error:") || text.startsWith("Agent Console is not reachable"))
    throw new Error(text.replace(/^Error:\s*/, ""));
  if (request.tool === "worktree_status") {
    const job = parseToolResponse(text) as WorktreeJob;
    assertWorktreeJobSucceeded(job);
    return clipOutput(worktreeSummary(job));
  }
  if (request.tool === "worktree_preview" || request.tool === "worktree_apply") {
    const started = parseToolResponse(text) as WorktreeJob;
    const completed = await waitForWorktreeJob(started, async (job, timeoutMs) => {
      const result = await callTool(
        "worktree_status",
        { job },
        AbortSignal.timeout(Math.min(30_000, timeoutMs)),
      );
      if (result.startsWith("Error:") || result.startsWith("Agent Console is not reachable"))
        throw new Error(result.replace(/^Error:\s*/, ""));
      return parseToolResponse(result) as WorktreeJob;
    });
    assertWorktreeJobSucceeded(completed ?? started);
    return clipOutput(worktreeSummary(completed ?? started));
  }
  return clipOutput(text);
}

const entry = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : "";
if (entry === import.meta.url) {
  try {
    console.log(await runConsoleTool(process.argv.slice(2)));
  } catch (failure) {
    console.error(
      `console-tool: ${failure instanceof Error ? failure.message : "Command failed."}`,
    );
    process.exitCode = 1;
  }
}
