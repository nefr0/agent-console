import assert from "node:assert/strict";
import { derivedToolToken, gateToolCall } from "../server/tool-token.ts";

const master = "worktree-test-master";
const issueToken = derivedToolToken(master, "issue-run");
const issueRun = (thread: string) => thread === "issue-run";
const gate = (token: string, thread: string | undefined, name: string) =>
  gateToolCall(master, token, thread, name, issueRun);

assert.equal(gate(issueToken, "issue-run", "worktree_preview").status, 200);
assert.equal(gate(issueToken, "issue-run", "worktree_status").status, 200);
assert.equal(gate(issueToken, "issue-run", "worktree_apply").status, 400);
assert.equal(gate(master, "issue-run", "worktree_preview").status, 200);
assert.equal(gate(master, "issue-run", "worktree_apply").status, 400);
assert.equal(gate(master, "manual-thread", "worktree_apply").status, 200);
assert.equal(gate("bad", "manual-thread", "worktree_apply").status, 401);

console.log(
  "worktree-tools: preview/status are readable; apply is blocked for derived and issue-run callers",
);
