import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ac-restart-singleton-"));
const fixture = path.join(scratch, "app");
const fixtureBin = path.join(scratch, "bin");
const runtime = path.join(scratch, "run");
const calls = path.join(scratch, "calls.jsonl");
for (const dir of [path.join(fixture, "bin"), fixtureBin, runtime])
  fs.mkdirSync(dir, { recursive: true });
const cli = path.join(fixture, "bin/agent-console");
fs.copyFileSync(path.join(root, "bin/agent-console"), cli);
fs.chmodSync(cli, 0o700);
fs.writeFileSync(
  path.join(fixtureBin, "node"),
  `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
fs.appendFileSync(process.env.TEST_CALLS, JSON.stringify({ pid:process.pid, args:process.argv.slice(2) }) + "\\n");
if (process.argv[2] === "scripts/idle-restart.mjs") {
  // run the real watcher in this process (the wrapper names the claim file after this pid)
  const script = ${JSON.stringify(path.join(root, "scripts/idle-restart.mjs"))};
  process.argv[1] = script;
  import(script).then(() => {});
} else setInterval(() => {}, 1000);
`,
  { mode: 0o700 },
);
// a release build that never ends: both watchers stay in the building phase
fs.writeFileSync(path.join(scratch, "release.mjs"), "setInterval(() => {}, 1000);\n");
const env = {
  ...process.env,
  HOME: scratch,
  PATH: `${fixtureBin}:${process.env.PATH}`,
  AGENT_CONSOLE_RUN: runtime,
  TEST_CALLS: calls,
  AGENT_CONSOLE_RELEASE_SCRIPT: path.join(scratch, "release.mjs"),
  AGENT_CONSOLE_HOME: path.join(scratch, "home"),
  AGENT_CONSOLE_REPO: scratch,
  AGENT_CONSOLE_DATA: path.join(scratch, "data"),
  AGENT_CONSOLE_PASSWORD: "singleton-test",
};
const children: ChildProcess[] = [];
const recorded = () =>
  fs.existsSync(calls)
    ? fs
        .readFileSync(calls, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
const eventually = async (check: () => boolean) => {
  const deadline = Date.now() + 3000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "Expected fixture process did not start");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};
try {
  for (let i = 0; i < 2; i++)
    children.push(spawn(cli, ["supervise"], { env, detached: true, stdio: "ignore" }));
  await eventually(() => recorded().some((call) => call.args[0] === "server/index.ts"));
  await Promise.all(
    children.map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null) return resolve();
          child.once("exit", () => resolve());
          setTimeout(resolve, 150);
        }),
    ),
  );
  assert.equal(
    recorded().filter((call) => call.args[0] === "server/index.ts").length,
    1,
    "Concurrent supervisors must launch only one server",
  );
  const watchers = () => recorded().filter((call) => call.args[0] === "scripts/idle-restart.mjs");
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  execFileSync(cli, ["restart-when-idle"], { env, stdio: "ignore" });
  const first = watchers()[0].pid;
  const second = execFileSync(cli, ["restart-when-idle"], { env, encoding: "utf8" });
  assert.match(second, new RegExp(`superseded pid ${first}`));
  await eventually(() => !alive(first));
  const live = watchers().filter((call) => alive(call.pid));
  assert.equal(live.length, 1, "Exactly one restart watcher must stay alive");
  assert.match(
    fs.readFileSync(path.join(runtime, "idle-restart.log"), "utf8"),
    /superseded by pid/,
    "The first watcher must log that it was superseded",
  );
  const originalSupervisor = Number(fs.readFileSync(path.join(runtime, "supervisor"), "utf8"));
  process.kill(originalSupervisor, "SIGTERM");
  await eventually(() =>
    children.some(
      (child) =>
        child.pid === originalSupervisor && (child.exitCode !== null || child.signalCode !== null),
    ),
  );
  const originalServer = recorded().find((call) => call.args[0] === "server/index.ts");
  process.kill(originalServer.pid, 0);
  children.push(spawn(cli, ["supervise"], { env, detached: true, stdio: "ignore" }));
  await eventually(
    () => recorded().filter((call) => call.args[0] === "server/index.ts").length === 2,
  );
  console.log("Restart singleton tests passed.");
} finally {
  for (const call of recorded()) {
    try {
      process.kill(call.pid, "SIGKILL");
    } catch {}
  }
  for (const child of children) {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {}
  }
  fs.rmSync(scratch, { recursive: true, force: true });
}
