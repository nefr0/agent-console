import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WorktreeEvidenceIndex, worktreeToolCandidates } from "../server/worktree-evidence.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-evidence-"));
const database = new DatabaseSync(path.join(root, "index.sqlite"));
const index = new WorktreeEvidenceIndex(database, root);
const threads = [
  { id: "archived", cwd: "/repos/project", archived: true },
  { id: "active", cwd: "/repos/project" },
];
fs.mkdirSync(path.join(root, "logs"));
const file = (thread = "archived") => path.join(root, "logs", `${thread}.jsonl`);
const call = (toolId: string, input: unknown, name = "Bash") => ({
  type: "assistant",
  message: { content: [{ type: "tool_use", id: toolId, name, input }] },
});
const result = (toolId: string, extra: object = {}) => ({
  type: "user",
  message: { content: [{ type: "tool_result", tool_use_id: toolId, content: "", ...extra }] },
});
const append = (events: unknown[], thread = "archived") =>
  fs.appendFileSync(file(thread), events.map((event) => JSON.stringify(event)).join("\n") + "\n");
const creates = () => index.snapshot().entries.filter((entry) => entry.kind === "create");

try {
  assert.equal(index.snapshot().stale, true, "never trust an unfinished initial backfill");
  append([
    call("quoted", {
      cwd: "/repos/project",
      command: 'cd "../project space" && git -C sub worktree add -b topic "../../feature space"',
    }),
    result("quoted"),
    call("failed", { command: "git worktree add /worktrees/failed" }),
    result("failed", { is_error: true }),
    call("nested-failed", { command: "git worktree add /worktrees/nested-failed" }),
    result("nested-failed", {
      is_error: false,
      content: [{ type: "text", text: '{"exit_code":1,"output":"sensitive-command"}' }],
    }),
    call("text-failed", { command: "git worktree add /worktrees/text-failed" }),
    result("text-failed", { is_error: false, content: "Process exited with code 1" }),
    call(
      "split",
      JSON.stringify({
        cmd: "git -C /repos/other worktree add ../split",
        workdir: "/repos/project",
      }),
      "functions.exec_command",
    ),
    {
      type: "assistant",
      message: { content: [{ type: "text", text: "git worktree add /worktrees/prose" }] },
    },
    call("listing", { command: "git worktree list /worktrees/listing" }),
    result("listing"),
    call("search", { command: 'rg "git worktree add /worktrees/search" .' }),
    result("search"),
    call("dynamic", { command: "git worktree add /worktrees/$DYNAMIC" }),
    result("dynamic"),
    call("loop", {
      command: "for item in /worktrees/loop; do git worktree add /worktrees/loop; done",
    }),
    result("loop"),
    call("pipeline", { command: "git worktree add /worktrees/pipeline | cat" }),
    result("pipeline"),
    call("substitution", { command: "git worktree add $(echo /worktrees/substitution)" }),
    result("substitution"),
    call(
      "opaque",
      {
        code: 'await tools.exec_command({cmd: "git worktree add /worktrees/opaque --secret sensitive-command"})',
      },
      "functions.exec",
    ),
    result("opaque"),
  ]);
  await index.refresh(threads);
  assert.equal(index.snapshot().stale, false);
  assert.deepEqual(
    creates().map((entry) => [entry.path, entry.repo, entry.line, entry.resultLine]),
    [["/repos/feature space", "/repos/project space/sub", 1, 2]],
  );
  assert.ok(
    index
      .snapshot()
      .entries.some((entry) => entry.path === "/repos/split" && entry.kind === "ambiguous"),
    "unanswered call cannot prove creation",
  );
  assert.ok(
    index
      .snapshot()
      .entries.some((entry) => entry.path === "/worktrees/opaque" && entry.kind === "ambiguous"),
    "opaque execution protects exact known path without proving creation",
  );
  assert.ok(
    !JSON.stringify(index.snapshot()).includes("sensitive-command"),
    "snapshot contains no commands or output",
  );
  const initialVersion = index.snapshot().version;
  await index.refresh(threads);
  assert.deepEqual(index.snapshot().traversal, { logsRead: 0, bytesRead: 0, eventsRead: 0 });
  assert.equal(
    index.snapshot().version,
    initialVersion,
    "unchanged refresh has stable evidence version",
  );

  const resultBytes = JSON.stringify(result("split", { is_error: false })) + "\n";
  fs.appendFileSync(file(), resultBytes);
  await index.refresh(threads);
  assert.ok(creates().some((entry) => entry.path === "/repos/split"));
  assert.equal(
    index.snapshot().traversal.bytesRead,
    Buffer.byteLength(resultBytes),
    "refresh reads appended bytes only",
  );
  assert.equal(index.snapshot().traversal.eventsRead, 1);
  assert.notEqual(index.snapshot().version, initialVersion);
  append(
    [
      call("reuse", { cmd: "npm test", cwd: "/repos/split" }, "exec_command"),
      result("reuse", { is_error: false }),
    ],
    "active",
  );
  await index.refresh(threads);
  assert.ok(
    index
      .snapshot()
      .entries.some(
        (entry) =>
          entry.thread === "active" && entry.kind === "use" && entry.path === "/repos/split",
      ),
    "active execution reuses archived candidate",
  );
  append([call("git-use", { command: "git -C /repos/split status" }), result("git-use")], "active");
  await index.refresh(threads);
  assert.ok(
    index
      .snapshot()
      .entries.some(
        (entry) =>
          entry.thread === "active" &&
          entry.kind === "use" &&
          entry.path === "/repos/split" &&
          entry.toolId === "git-use",
      ),
  );

  const stored = database.prepare("SELECT * FROM worktree_calls").all();
  assert.ok(
    !JSON.stringify(stored).includes("sensitive-command"),
    "durable evidence rows contain no command or output",
  );
  append([
    call("mutable-cwd", { command: "git worktree add ../mutable" }),
    result("mutable-cwd"),
    call("explicit-cwd", { command: "git worktree add ../trusted", cwd: "/repos/project" }),
    result("explicit-cwd"),
    call("literal-cd", { command: "cd /repos/project && git worktree add ../trusted-cd" }),
    result("literal-cd"),
    call("absolute-target", { command: "git worktree add /worktrees/absolute-target" }),
    result("absolute-target"),
    call("invalid-cwd", { command: "git worktree add /worktrees/invalid-cwd", cwd: "$UNKNOWN" }),
    result("invalid-cwd"),
  ]);
  await index.refresh(threads);
  assert.equal(
    creates().some((entry) => entry.path === "/repos/mutable"),
    false,
    "mutable catalog cwd cannot prove a historical relative destination",
  );
  assert.ok(
    index
      .snapshot()
      .entries.some((entry) => entry.path === "/repos/mutable" && entry.kind === "ambiguous"),
  );
  assert.ok(
    creates().some((entry) => entry.path === "/repos/trusted" && entry.repo === "/repos/project"),
  );
  assert.ok(creates().some((entry) => entry.path === "/repos/trusted-cd"));
  assert.equal(
    creates().find((entry) => entry.path === "/worktrees/absolute-target")?.repo,
    undefined,
    "absolute destination proves creation without inventing a historical repository",
  );
  assert.equal(
    creates().some((entry) => entry.path === "/worktrees/invalid-cwd"),
    false,
  );
  const oldContextVersion = index.snapshot().version;
  threads[0].cwd = "/repos/changed";
  await index.refresh(threads);
  assert.notEqual(
    index.snapshot().version,
    oldContextVersion,
    "cwd changes invalidate the evidence context version",
  );
  assert.deepEqual(index.snapshot().traversal, { logsRead: 0, bytesRead: 0, eventsRead: 0 });
  assert.equal(
    creates().some((entry) => entry.path.endsWith("/mutable")),
    false,
  );
  const restarted = new WorktreeEvidenceIndex(database, root);
  append([call("restart-split", { command: "git worktree add /worktrees/restart" })]);
  await restarted.refresh(threads);
  const restartedAgain = new WorktreeEvidenceIndex(database, root);
  append([result("restart-split", { is_error: false })]);
  await restartedAgain.refresh(threads);
  assert.ok(
    restartedAgain
      .snapshot()
      .entries.some((entry) => entry.kind === "create" && entry.path === "/worktrees/restart"),
    "pending correlation survives restart",
  );

  fs.writeFileSync(file(), JSON.stringify({ type: "user_input", text: "truncated" }) + "\n");
  await index.refresh(threads);
  assert.equal(creates().length, 0, "truncation invalidates old ownership");
  append([call("rotation", { command: "git worktree add /worktrees/rotate" }), result("rotation")]);
  await index.refresh(threads);
  assert.equal(creates().length, 1);
  fs.renameSync(file(), `${file()}.old`);
  fs.writeFileSync(file(), JSON.stringify({ type: "user_input", text: "replacement" }) + "\n");
  await index.refresh(threads);
  assert.equal(creates().length, 0, "rotation invalidates old ownership");
  await index.refresh([]);
  assert.equal(index.snapshot().entries.length, 0, "removed threads lose evidence");

  assert.deepEqual(
    worktreeToolCandidates({ name: "Read", input: { file_path: "/worktrees/not-execution" } }),
    [],
  );
  for (const command of [
    'git worktree add "~/quoted"',
    "git worktree add ~someone/other",
    "git worktree add \\~/escaped",
  ]) {
    assert.equal(
      worktreeToolCandidates({ name: "Bash", input: { command } }, "/repos/project").some(
        (entry) => entry.kind === "create",
      ),
      false,
      "unresolved shell tildes cannot prove an expanded path",
    );
  }
  assert.ok(
    worktreeToolCandidates(
      { name: "Bash", input: { command: "/worktrees/direct/bin/check" } },
      "/repos/project",
    ).some((entry) => entry.kind === "use" && entry.path === "/worktrees/direct/bin/check"),
  );
  console.log(
    "PASS worktree-evidence: literal ownership, successful correlation, incremental refresh, reuse, invalidation, metadata privacy",
  );
} finally {
  database.close();
  fs.rmSync(root, { recursive: true, force: true });
}
