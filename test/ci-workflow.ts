// Issue #20: every CI job bills at least one whole minute, so the workflow keeps few jobs and
// docs/ci.md records the measured billing and the keep/move/remove decision.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const read = (path: string) => fs.readFileSync(new URL(path, import.meta.url), "utf8");
const workflow = read("../.github/workflows/ci.yml");
const doc = read("../docs/ci.md");

const jobsBlock = workflow.slice(workflow.indexOf("\njobs:\n"));
const names = (jobsBlock.match(/^ {2}[a-z][a-z-]*:$/gm) ?? []).map((line) =>
  line.trim().slice(0, -1),
);
assert.deepEqual(
  names.sort(),
  ["release", "telemetry-comment", "test", "test-shard"],
  `jobs: ${names}`,
);

// The Lean proof check shares the release job's runner instead of paying its own billed minute.
const release = workflow.slice(workflow.indexOf("\n  release:\n"), workflow.indexOf("\n  test:\n"));
assert.match(release, /npm run test:formal/, "release job must run the Lean queue proofs");

const queueReadme = read("../formal/queue/README.md");
assert.doesNotMatch(
  queueReadme,
  /formal-queue/,
  "formal/queue/README.md must not name the removed formal-queue job",
);

for (const heading of ["Billed minutes per run", "Decision"])
  assert.ok(doc.includes(`\n## ${heading}\n`), `docs/ci.md needs section: ## ${heading}`);
assert.match(doc, /1,809/, "docs/ci.md must reconcile the 1,809 minutes used");
assert.match(
  doc,
  /GitHub Actions is still needed: yes/i,
  "docs/ci.md must record the yes/no decision",
);

// Partial rerun: the log upload may replace an earlier attempt's artifact, and the wait script
// counts only this attempt's shard jobs.
assert.match(workflow, /name: test-log-\$\{\{ strategy\.job-index \}\}\n\s+overwrite: true/);
assert.match(workflow, /^permissions:\n {2}contents: read\n {2}actions: read$/m);
const waitScript = read("./wait-ci-shards.mjs");
assert.match(waitScript, /attempts\/\$\{attempt\}\/jobs/);
assert.match(waitScript, /GITHUB_RUN_ATTEMPT/);
assert.match(read("./run.mjs"), /Test run attempt: /);

// shard-budget over a mixed-attempt fixture: attempt 1 started 10 minutes before attempt 2, which
// must not count as start skew.
const files = ["test/a.ts", "test/b.ts", "test/c.ts"];
const fixtureLog = (file: string, attempt: number, started: number) =>
  [
    `Test suite files: ${JSON.stringify(files)}`,
    `Test run attempt: ${attempt}`,
    `Test run started: ${started}`,
    `Test executed files: ${JSON.stringify([file])}`,
    `\u2714 ${file} (1000ms)`,
    "\u2139 duration_ms 5000",
    "",
  ].join("\n");
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "shard-budget-"));
try {
  const fixture: [string, number, number][] = [
    ["test/a.ts", 1, 1_000_000],
    ["test/b.ts", 1, 1_001_000],
    ["test/c.ts", 2, 1_600_000],
  ];
  fixture.forEach(([file, attempt, started], index) => {
    fs.mkdirSync(path.join(fixtureDir, `test-log-${index}`));
    fs.writeFileSync(
      path.join(fixtureDir, `test-log-${index}`, "test.log"),
      fixtureLog(file, attempt, started),
    );
  });
  const run = spawnSync(
    process.execPath,
    [new URL("./shard-budget.mjs", import.meta.url).pathname, fixtureDir],
    {
      env: { ...process.env, SHARD_COUNT: "3", TEST_FILE_BUDGET_S: "15", TEST_WALL_BUDGET_S: "25" },
    },
  );
  assert.equal(run.status, 0, `shard-budget mixed attempts: ${run.stderr}${run.stdout}`);
  assert.match(
    fs.readFileSync(path.join(fixtureDir, "combined.log"), "utf8"),
    /duration_ms 6000\n$/,
  );
} finally {
  fs.rmSync(fixtureDir, { recursive: true, force: true });
}
console.log("ci-workflow ok");
