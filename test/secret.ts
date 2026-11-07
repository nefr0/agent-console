import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-secret-"));
const file = path.join(dir, "env");
fs.writeFileSync(file, "export FAKE_ONE=value-one-xyz\nFAKE_TWO='value-two-xyz'\n");
const script = path.join(import.meta.dirname, "..", "scripts", "secret.ts");
const secret = (...args: string[]) =>
  spawnSync("node", [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, AGENT_CONSOLE_ENV_FILES: file },
  });
try {
  const listed = secret("list");
  assert.equal(listed.status, 0);
  assert.match(listed.stdout, new RegExp(`FAKE_ONE\\t${file}`));
  assert.ok(!/value-(one|two)-xyz/.test(listed.stdout + listed.stderr), "list leaks no value");

  const ran = secret("run", "FAKE_ONE", "--", "sh", "-c", 'test "$FAKE_ONE" = value-one-xyz && test -z "$FAKE_TWO"');
  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(secret("run", "FAKE_ONE", "--", "sh", "-c", "exit 7").status, 7);

  const unknown = secret("run", "NOPE", "--", "true");
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /NOPE/);
  assert.equal(secret("run", "bad-name", "--", "true").status, 2);
  assert.equal(secret("run", "FAKE_ONE").status, 2);
  assert.equal(secret("get", "FAKE_ONE").status, 2);
  assert.ok(!/value-one-xyz/.test(secret("get", "FAKE_ONE").stdout));
  assert.equal(secret("--help").status, 0);
  console.log("PASS secret: list hides values, run exports only named keys, exit codes");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
