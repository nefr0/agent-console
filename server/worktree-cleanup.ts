import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  WorktreeCaller,
  WorktreeCleanupOptions,
  WorktreeEvidenceSnapshot,
  WorktreeJob,
  WorktreeThread,
} from "./worktree-contracts.ts";

const engine = fileURLToPath(new URL("../scripts/worktree-cleanup-engine.py", import.meta.url));
const identifier = /^[a-f0-9-]{36}$/;
const rowLimit = 40;
const contextDeadlineMs = 90_000;
const firstRetryMs = 200;
const maximumRetryMs = 2_000;
type JobOwner = { pid: number; startTicks?: string; instanceId: string };
type JobRecord = WorktreeJob & { owner?: JobOwner };

function waitFor(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });
}

function staleEvidence(): WorktreeEvidenceSnapshot {
  return {
    stale: true,
    version: "",
    entries: [],
    traversal: { logsRead: 0, bytesRead: 0, eventsRead: 0 },
  };
}

function processStartTicks(): string | undefined {
  try {
    const record = fs.readFileSync(`/proc/${process.pid}/stat`, "utf8");
    return record
      .slice(record.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/)[19];
  } catch {
    return undefined;
  }
}

/** Durable, serialized jobs. Filesystem traversal and archives run in a separate process. */
export class WorktreeCleanup {
  private options: WorktreeCleanupOptions;
  private directory: string;
  private jobs = new Map<string, JobRecord>();
  private owner: JobOwner = {
    pid: process.pid,
    startTicks: processStartTicks(),
    instanceId: randomUUID(),
  };
  private pending: Array<{ job: JobRecord; input: object }> = [];
  private child?: ChildProcessWithoutNullStreams;
  private contextWaiters = new Map<ChildProcessWithoutNullStreams, Set<AbortController>>();
  private closed = false;

  constructor(options: WorktreeCleanupOptions) {
    this.options = options;
    this.directory = path.join(options.stateDir, "worktree-cleanup");
    fs.mkdirSync(path.join(this.directory, "jobs"), { recursive: true, mode: 0o700 });
    fs.chmodSync(this.directory, 0o700);
    fs.chmodSync(path.join(this.directory, "jobs"), 0o700);
    this.recover();
  }

  private recover() {
    for (const name of fs.readdirSync(path.join(this.directory, "jobs"))) {
      if (!name.endsWith(".json") || !identifier.test(name.slice(0, -5))) continue;
      try {
        const job = this.load(name.slice(0, -5));
        this.jobs.set(job.job, job);
      } catch {
        /* Foreign or unreadable jobs never authorize mutations. */
      }
    }
  }

  private load(jobId: string): JobRecord {
    if (!identifier.test(jobId)) throw new Error("Unknown worktree job");
    const filename = path.join(this.directory, "jobs", `${jobId}.json`);
    try {
      const metadata = fs.lstatSync(filename);
      if (!metadata.isFile() || metadata.size > 1024 * 1024) throw new Error("Invalid job state");
      const job = JSON.parse(fs.readFileSync(filename, "utf8")) as JobRecord;
      if (
        job.job !== jobId ||
        !Array.isArray(job.rows) ||
        !job.counts ||
        !["queued", "running", "complete", "incomplete", "failed"].includes(job.status)
      )
        throw new Error("Invalid job state");
      return job;
    } catch {
      throw new Error("Unreadable worktree job state");
    }
  }

  private summary(job: JobRecord): WorktreeJob {
    const result = structuredClone(job);
    delete result.owner;
    result.rows = result.rows.slice(0, rowLimit);
    return result;
  }

  private save(job: JobRecord) {
    const target = path.join(this.directory, "jobs", `${job.job}.json`);
    const temporary = `${target}.${this.owner.instanceId}.tmp`;
    const descriptor = fs.openSync(temporary, "w", 0o600);
    try {
      fs.fchmodSync(descriptor, 0o600);
      fs.writeFileSync(descriptor, `${JSON.stringify(job)}\n`);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporary, target);
    const directory = fs.openSync(path.dirname(target), "r");
    try {
      fs.fsyncSync(directory);
    } finally {
      fs.closeSync(directory);
    }
  }

  preview(input: { repo: string }, caller: WorktreeCaller): WorktreeJob {
    if (!input || typeof input.repo !== "string" || !path.isAbsolute(input.repo))
      throw new Error("Absolute repository path required");
    return this.enqueue("preview", input, caller);
  }

  apply(input: { plan: string; paths: string[] }, caller: WorktreeCaller): WorktreeJob {
    const thread = this.options.getThreads().find((entry) => entry.id === caller?.id);
    if (!thread || thread.archived || caller.archived || caller.issueRun)
      throw new Error("Apply requires a live interactive caller");
    if (
      !input ||
      !identifier.test(input.plan) ||
      !Array.isArray(input.paths) ||
      !input.paths.length ||
      input.paths.some(
        (entry) =>
          typeof entry !== "string" || !path.isAbsolute(entry) || path.normalize(entry) !== entry,
      )
    )
      throw new Error("Explicit plan and absolute selected paths required");
    return this.enqueue("apply", { plan: input.plan, paths: [...new Set(input.paths)] }, caller);
  }

  status(input: { job: string }): WorktreeJob {
    const job = this.load(input?.job);
    this.jobs.set(job.job, job);
    return this.summary(job);
  }

  private enqueue(action: "preview" | "apply", input: object, caller: WorktreeCaller) {
    if (this.closed) throw new Error("Worktree cleanup is closed");
    const job: JobRecord = {
      owner: this.owner,
      job: randomUUID(),
      action,
      status: "queued",
      counts: { total: 0, eligible: 0, skipped: 0, backedUp: 0, removed: 0, failed: 0 },
      rows: [],
      next: "Poll status with this job identifier.",
    };
    this.jobs.set(job.job, job);
    this.save(job);
    this.pending.push({
      job,
      input: {
        ...input,
        caller: { id: caller?.id, archived: caller?.archived, issueRun: Boolean(caller?.issueRun) },
      },
    });
    queueMicrotask(() => this.drain());
    return this.summary(job);
  }

  private drain() {
    if (this.closed || this.child || !this.pending.length) return;
    const task = this.pending.shift();
    if (!task) return;
    task.job.status = "running";
    task.job.next = "Waiting for ownership index";
    this.save(task.job);
    const child = spawn("/usr/bin/python3", ["-I", engine], {
      cwd: this.directory,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: this.options.home,
        LANG: "C.UTF-8",
        PYTHONUNBUFFERED: "1",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    let buffer = "";
    let finished = false;
    child.stdin.on("error", () => {});
    child.stderr.resume();
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (buffer.length > 2 * 1024 * 1024) {
        child.kill("SIGKILL");
        return;
      }
      let boundary = buffer.indexOf("\n");
      while (boundary !== -1) {
        const line = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 1);
        finished = this.receive(child, task.job, line) || finished;
        boundary = buffer.indexOf("\n");
      }
    });
    const finish = () => {
      this.cancelContexts(child);
      if (this.child !== child) return;
      this.child = undefined;
      if (!finished && !this.closed) {
        task.job.status = "incomplete";
        task.job.next = "Worker interrupted. Inspect preserved archives before a new preview.";
        this.save(task.job);
      }
      this.drain();
    };
    child.once("error", finish);
    child.once("close", finish);
    child.stdin.write(
      `${JSON.stringify({ action: task.job.action, job: task.job.job, state: this.directory, owner: this.owner, home: this.options.home, ...task.input })}\n`,
    );
  }

  private receive(child: ChildProcessWithoutNullStreams, job: JobRecord, line: string) {
    if (this.closed) return false;
    try {
      const message = JSON.parse(line);
      if (message.type === "context") this.context(child, job, message.requestId);
      const result = message.result;
      if (
        !["progress", "result"].includes(message.type) ||
        result?.job !== job.job ||
        !Array.isArray(result.rows) ||
        !result.counts
      )
        return false;
      Object.assign(job, result, {
        rows: result.rows.slice(0, rowLimit),
        job: job.job,
        action: job.action,
      });
      this.save(job);
      return message.type === "result";
    } catch {
      child.kill("SIGKILL");
      return false;
    }
  }

  private cancelContexts(child: ChildProcessWithoutNullStreams) {
    for (const controller of this.contextWaiters.get(child) ?? []) controller.abort();
  }

  private async context(child: ChildProcessWithoutNullStreams, job: JobRecord, requestId: string) {
    const controller = new AbortController();
    const waiters = this.contextWaiters.get(child) ?? new Set<AbortController>();
    waiters.add(controller);
    this.contextWaiters.set(child, waiters);
    let evidence = staleEvidence();
    const deadline = performance.now() + contextDeadlineMs;
    const expired = Symbol("context deadline");
    let deadlineTimer: NodeJS.Timeout | undefined;
    let retryMs = firstRetryMs;
    try {
      let aborted = false;
      const abortWait = new Promise<undefined>((resolve) => {
        controller.signal.addEventListener("abort", () => resolve(undefined), { once: true });
      });
      const deadlineWait = new Promise<typeof expired>((resolve) => {
        deadlineTimer = setTimeout(() => resolve(expired), contextDeadlineMs);
      });
      while (!this.closed && !child.killed && performance.now() < deadline) {
        try {
          const current = await Promise.race([this.options.evidence(), abortWait, deadlineWait]);
          if (!current) {
            aborted = true;
            break;
          }
          if (current === expired) break;
          evidence = current;
          if (!current.stale && current.version) break;
        } catch {
          evidence = staleEvidence();
        }
        if (this.closed || child.killed || performance.now() >= deadline) break;
        job.next = "Waiting for ownership index";
        this.save(job);
        await waitFor(Math.min(retryMs, deadline - performance.now()), controller.signal);
        retryMs = Math.min(retryMs * 2, maximumRetryMs);
      }
      if (aborted || controller.signal.aborted || this.closed || child.killed) return;
      let threads: WorktreeThread[];
      try {
        threads = this.options.getThreads();
      } catch {
        threads = [];
        evidence = staleEvidence();
      }
      job.next = "Checking worktree protection";
      this.save(job);
      child.stdin.write(`${JSON.stringify({ requestId, threads, evidence })}\n`);
    } catch {
      if (!child.killed && !this.closed) {
        child.stdin.write(
          `${JSON.stringify({ requestId, threads: [], evidence: staleEvidence() })}\n`,
        );
      }
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      waiters.delete(controller);
      if (waiters.size === 0) this.contextWaiters.delete(child);
    }
  }

  close(): void {
    this.closed = true;
    if (this.child) this.cancelContexts(this.child);
    this.child?.kill("SIGKILL");
    for (const job of this.jobs.values()) {
      if (job.owner?.instanceId !== this.owner.instanceId) continue;
      if (job.status !== "running" && job.status !== "queued") continue;
      job.status = "incomplete";
      job.next = "Worker interrupted. Inspect preserved archives before a new preview.";
      this.save(job);
    }
    this.pending = [];
  }
}
