import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorktreeCleanup } from "../server/worktree-cleanup.ts";
import type { WorktreeJob, WorktreeThread } from "../server/worktree-contracts.ts";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-facade-"));
const repo = path.join(temporary, "repo");
const stateDir = path.join(temporary, "state");
fs.mkdirSync(repo);
const git = (...arguments_: string[]) =>
  execFileSync("git", ["-C", repo, ...arguments_], { stdio: "pipe" })
    .toString()
    .trim();
git("init", "-q");
git("config", "user.name", "Test");
git("config", "user.email", "test@example.invalid");
fs.writeFileSync(path.join(repo, "tracked"), "initial");
git("add", ".");
git("commit", "-qm", "Initial");
const old = path.join(temporary, "old");
git("worktree", "add", "-qb", "preserved", old);
const threads: WorktreeThread[] = [
  { id: "owner", archived: true, cwd: old, status: "idle" },
  { id: "caller", archived: false, cwd: repo, status: "running" },
];
let contextRequests = 0;
const options = {
  dataDir: temporary,
  home: temporary,
  stateDir,
  getThreads: () => threads,
  evidence: async () => {
    contextRequests++;
    return {
      stale: false,
      version: "fresh",
      entries: [{ kind: "create" as const, path: old, thread: "owner", line: 1 }],
      traversal: { logsRead: 1, bytesRead: 1, eventsRead: 1 },
    };
  },
};
let cleanup = new WorktreeCleanup(options);
const jobsDirectory = path.join(stateDir, "worktree-cleanup", "jobs");
const peers = new Set<WorktreeCleanup>();
function completed(
  job: WorktreeJob,
  service = cleanup,
  directory = jobsDirectory,
): Promise<WorktreeJob> {
  return new Promise((resolve, reject) => {
    const watcher = fs.watch(directory, check);
    const deadline = setTimeout(() => {
      watcher.close();
      reject(new Error("Cleanup job deadline"));
    }, 12000);
    function check() {
      const result = service.status({ job: job.job });
      if (["queued", "running"].includes(result.status)) return;
      watcher.close();
      clearTimeout(deadline);
      resolve(result);
    }
    check();
  });
}
try {
  assert.throws(() => cleanup.preview({ repo: "relative" }, { id: "caller" }), /Absolute/);
  assert.throws(
    () => cleanup.apply({ plan: "../escape", paths: [old] }, { id: "caller" }),
    /Explicit/,
  );
  assert.throws(
    () => cleanup.apply({ plan: "a".repeat(36), paths: [old] }, { id: "missing" }),
    /live interactive/,
  );
  assert.throws(
    () => cleanup.apply({ plan: "a".repeat(36), paths: [old] }, { id: "caller", issueRun: true }),
    /live interactive/,
  );
  threads[1].archived = true;
  assert.throws(
    () => cleanup.apply({ plan: "a".repeat(36), paths: [old] }, { id: "caller" }),
    /live interactive/,
  );
  threads[1].archived = false;
  const first = cleanup.preview({ repo }, { id: "caller" });
  const second = cleanup.preview({ repo }, { id: "caller" });
  assert.equal(first.status, "queued");
  const plan = await completed(first);
  const next = await completed(second);
  assert.equal(plan.counts.eligible, 1, JSON.stringify(plan));
  assert.equal(next.status, "complete");
  assert.equal(contextRequests, 2, "Serialized preview jobs request their own context");
  assert.equal(fs.statSync(jobsDirectory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(jobsDirectory, `${first.job}.json`)).mode & 0o777, 0o600);
  plan.rows.length = 0;
  assert.ok(
    cleanup.status({ job: first.job }).rows.length,
    "Status copies cannot mutate private jobs",
  );
  const applied = await completed(
    cleanup.apply({ plan: first.job, paths: [old] }, { id: "caller" }),
  );
  assert.equal(applied.counts.removed, 1, JSON.stringify(applied));
  assert.ok(
    contextRequests >= 5,
    "Apply refreshes context at start and immediately before each removal",
  );
  let staleCalls = 0;
  const waitingFacade = new WorktreeCleanup({
    ...options,
    evidence: async () => {
      staleCalls++;
      if (staleCalls === 2) threads[0].archived = false;
      if (staleCalls < 3) return { ...(await options.evidence()), stale: true, version: "" };
      return options.evidence();
    },
  });
  peers.add(waitingFacade);
  const waitingJob = waitingFacade.preview({ repo }, { id: "caller" });
  const freshResult = await completed(waitingJob, waitingFacade);
  assert.ok(staleCalls >= 3, "Stale evidence retries until a fresh snapshot arrives");
  assert.equal(freshResult.counts.eligible, 0, "Threads are read after the freshness wait");
  threads[0].archived = true;
  cleanup.close();
  cleanup = new WorktreeCleanup(options);
  assert.equal(
    cleanup.status({ job: applied.job }).status,
    "complete",
    "Completed jobs survive restart",
  );
  cleanup.close();
  const started = Promise.withResolvers<void>();
  const hanging = {
    ...options,
    evidence: () => {
      started.resolve();
      return new Promise<never>(() => {});
    },
  };
  cleanup = new WorktreeCleanup(hanging);
  const interrupted = cleanup.preview({ repo }, { id: "caller" });
  await started.promise;
  cleanup.close();
  assert.equal(cleanup.status({ job: interrupted.job }).status, "incomplete");
  cleanup = new WorktreeCleanup(options);
  assert.equal(
    cleanup.status({ job: interrupted.job }).status,
    "incomplete",
    "Interrupted jobs are durable",
  );
  const filename = path.join(jobsDirectory, `${interrupted.job}.json`);
  const running = JSON.parse(fs.readFileSync(filename, "utf8"));
  running.status = "running";
  running.owner = { pid: 999999999, startTicks: "1", instanceId: "dead-instance" };
  fs.writeFileSync(filename, JSON.stringify(running));
  cleanup.close();
  cleanup = new WorktreeCleanup(options);
  assert.equal(
    cleanup.status({ job: interrupted.job }).status,
    "running",
    "Construction is read-only even for dead owners",
  );
  cleanup.close();
  assert.equal(
    JSON.parse(fs.readFileSync(filename, "utf8")).status,
    "running",
    "Closing another instance never mutates foreign jobs",
  );
  cleanup = new WorktreeCleanup(options);
  await completed(cleanup.preview({ repo }, { id: "caller" }));
  assert.equal(
    cleanup.status({ job: interrupted.job }).status,
    "incomplete",
    "Lease holder recovers a positively dead owner",
  );
  assert.equal(
    "owner" in cleanup.status({ job: interrupted.job }),
    false,
    "Internal ownership stays private",
  );

  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const ownerFacade = new WorktreeCleanup({
    ...options,
    evidence: async () => {
      entered.resolve();
      await released.promise;
      return options.evidence();
    },
  });
  peers.add(ownerFacade);
  const active = ownerFacade.preview({ repo }, { id: "caller" });
  await entered.promise;
  const standby = new WorktreeCleanup(options);
  peers.add(standby);
  assert.equal(
    standby.status({ job: active.job }).status,
    "running",
    "Standby reads the live persisted status",
  );
  standby.close();
  assert.equal(
    ownerFacade.status({ job: active.job }).status,
    "running",
    "Standby close preserves the live owner's job",
  );
  const competing = new WorktreeCleanup(options);
  peers.add(competing);
  const busy = await completed(competing.preview({ repo }, { id: "caller" }), competing);
  assert.equal(busy.status, "failed");
  assert.match(busy.next, /busy/);
  assert.equal(ownerFacade.status({ job: active.job }).status, "running");
  const scratchState = path.join(temporary, "scratch-data", "private-state");
  const scratch = new WorktreeCleanup({ ...options, stateDir: scratchState });
  peers.add(scratch);
  const scratchDone = await completed(
    scratch.preview({ repo }, { id: "caller" }),
    scratch,
    path.join(scratchState, "worktree-cleanup", "jobs"),
  );
  assert.equal(scratchDone.status, "complete", "Scratch data uses a separate state and lease");
  assert.throws(
    () => scratch.status({ job: active.job }),
    /Unreadable/,
    "Scratch cannot read production jobs",
  );
  assert.equal(ownerFacade.status({ job: active.job }).status, "running");
  released.resolve();
  assert.equal((await completed(active, ownerFacade)).status, "complete");
  assert.equal(
    standby.status({ job: active.job }).status,
    "complete",
    "Status reload observes another owner's persisted completion",
  );
  const corrupt = path.join(jobsDirectory, `${active.job}.json`);
  const preserved = fs.readFileSync(corrupt);
  fs.writeFileSync(corrupt, "unreadable JSON");
  assert.throws(() => cleanup.status({ job: active.job }), /Unreadable/);
  fs.writeFileSync(corrupt, preserved);
  console.log(
    "worktree cleanup facade: serialized jobs, private persistence, caller validation, fresh context and interruption recovery passed",
  );
} finally {
  cleanup.close();
  for (const peer of peers) peer.close();
  fs.rmSync(temporary, { recursive: true, force: true });
}
