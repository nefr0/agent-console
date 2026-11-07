// Newest deploy wins (#495) through the real bin/agent-console wrapper and scripts/idle-restart.mjs, on scratch RUN/APP dirs with a fake
// release script and a fake server (WebSocket hello only). Never touches the live server.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "bin", "agent-console");
const wsUrl = import.meta.resolve("ws");
const port = await new Promise<number>((resolve) => {
  const probe = net.createServer();
  probe.listen(0, "127.0.0.1", () => {
    const { port: free } = probe.address() as net.AddressInfo;
    probe.close(() => resolve(free));
  });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function eventually(check: () => boolean, what: string, ms = 10_000) {
  const end = Date.now() + ms;
  while (!check()) {
    assert.ok(Date.now() < end, `timed out waiting for ${what}`);
    await sleep(25);
  }
}

class Scenario {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ac-supersede-"));
  run = path.join(this.scratch, "run");
  app = path.join(this.scratch, "app");
  fake = path.join(this.scratch, "fake");
  env: NodeJS.ProcessEnv;
  constructor() {
    for (const dir of [this.run, this.app, path.join(this.fake, "server")])
      fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(this.fake, "server", "index.ts"), this.serverSource());
    fs.writeFileSync(path.join(this.fake, "release.mjs"), this.releaseSource());
    fs.writeFileSync(path.join(this.fake, "ctl.mjs"), this.ctlSource());
    this.env = {
      ...process.env,
      HOME: this.scratch,
      PORT: String(port),
      AGENT_CONSOLE_RUN: this.run,
      AGENT_CONSOLE_HOME: this.app,
      AGENT_CONSOLE_REPO: this.scratch,
      AGENT_CONSOLE_RELEASE_SCRIPT: path.join(this.fake, "release.mjs"),
      AGENT_CONSOLE_IDLE_MS: "150",
      AGENT_CONSOLE_DATA: path.join(this.scratch, "data"),
      AGENT_CONSOLE_PASSWORD: "supersede-test",
    };
  }
  // serves hello with its build name; replaced by the next release's server on handoff
  serverSource() {
    return `import fs from "node:fs";
import { WebSocketServer } from ${JSON.stringify(wsUrl)};
const build = process.argv[2];
const server = new WebSocketServer({ host: "127.0.0.1", port: Number(process.env.PORT) }, () =>
  fs.writeFileSync(process.env.AGENT_CONSOLE_RUN + "/pid", String(process.pid)));
server.on("connection", (socket) =>
  socket.send(JSON.stringify({ t: "hello", build, threads: [], queues: {}, features: { queueEditing: true } })));
process.on("SIGTERM", () => process.exit(0));
`;
  }
  // bin/agent-console of a fake release: start (cold) and supervise --handoff, each after the delay in $RUN/switch-delay
  ctlSource() {
    return `import { spawn } from "node:child_process";
import fs from "node:fs";
const [verb, , build] = process.argv.slice(2);
const run = process.env.AGENT_CONSOLE_RUN;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const delay = Number(fs.existsSync(run + "/switch-delay") ? fs.readFileSync(run + "/switch-delay", "utf8") : 0);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
fs.rmSync(run + "/switch-delay", { force: true }); // only the first switch is slow
await wait(delay);
const old = Number(fs.existsSync(run + "/pid") ? fs.readFileSync(run + "/pid", "utf8") : 0);
if (verb === "supervise") { fs.writeFileSync(run + "/standby-ready", ""); fs.writeFileSync(run + "/handoff", ""); }
if (old && alive(old)) { process.kill(old, "SIGTERM"); while (alive(old)) await wait(10); }
fs.rmSync(run + "/pid", { force: true });
spawn(process.execPath, [${JSON.stringify(path.join(this.fake, "server", "index.ts"))}, build], { detached: true, stdio: "ignore" }).unref();
while (!fs.existsSync(run + "/pid")) await wait(10);
fs.rmSync(run + "/handoff", { force: true }); // go: the new server is listening
`;
  }
  // fake release.mjs <ref> --repo <repo>: builds releases/<ref> after the delay in $RUN/build-delay-<ref>; marks start and end
  releaseSource() {
    const ctl = path.join(this.fake, "ctl.mjs");
    return `import fs from "node:fs";
import path from "node:path";
const ref = process.argv[2];
const run = process.env.AGENT_CONSOLE_RUN;
const dest = path.join(process.env.AGENT_CONSOLE_HOME, "releases", ref);
const file = run + "/build-delay-" + ref;
fs.writeFileSync(run + "/build-started-" + ref, "");
await new Promise((resolve) => setTimeout(resolve, Number(fs.existsSync(file) ? fs.readFileSync(file, "utf8") : 0)));
fs.mkdirSync(path.join(dest, "bin"), { recursive: true });
fs.writeFileSync(path.join(dest, "bin", "agent-console"),
  "#!/bin/sh\\nexec " + process.execPath + " " + ${JSON.stringify(ctl)} + " \\"$1\\" \\"$2\\" " + ref + "\\n", { mode: 0o755 });
fs.writeFileSync(run + "/build-finished-" + ref, "");
console.log(dest);
`;
  }
  release(ref: string) {
    const dest = path.join(this.app, "releases", ref);
    fs.mkdirSync(path.join(dest, "bin"), { recursive: true });
    fs.writeFileSync(
      path.join(dest, "bin", "agent-console"),
      `#!/bin/sh\nexec ${process.execPath} ${path.join(this.fake, "ctl.mjs")} "$1" "$2" ${ref}\n`,
      { mode: 0o755 },
    );
    return dest;
  }
  file(name: string) {
    return path.join(this.run, name);
  }
  put(name: string, text: string) {
    fs.writeFileSync(this.file(name), text);
  }
  has(name: string) {
    return fs.existsSync(this.file(name));
  }
  log() {
    return fs.existsSync(this.file("idle-restart.log"))
      ? fs.readFileSync(this.file("idle-restart.log"), "utf8")
      : "";
  }
  state() {
    return JSON.parse(fs.readFileSync(this.file("idle-restart.state"), "utf8"));
  }
  verb(...args: string[]) {
    return execFileSync(cli, args, { env: this.env, encoding: "utf8" }).trim();
  }
  current() {
    return path.basename(fs.realpathSync(path.join(this.app, "current")));
  }
  done(pid: number) {
    return eventually(() => !alive(pid), `pid ${pid} to exit`);
  }
  cleanup() {
    for (const name of fs.readdirSync("/proc").filter((entry) => /^\d+$/.test(entry))) {
      try {
        const line = fs.readFileSync(`/proc/${name}/cmdline`, "utf8");
        if (line.includes(this.scratch) && Number(name) !== process.pid)
          process.kill(Number(name), "SIGKILL");
      } catch {}
    }
    fs.rmSync(this.scratch, { recursive: true, force: true });
  }
}

async function scenario(name: string, body: (s: Scenario) => Promise<void>) {
  const began = Date.now();
  const s = new Scenario();
  try {
    await body(s);
    console.log(`ok - ${name} ${Date.now() - began}ms`);
    if (process.env.SHOW_LOG) console.log(s.log());
  } catch (failure) {
    console.error(s.log());
    throw failure;
  } finally {
    s.cleanup();
  }
}

await scenario("second deploy supersedes the first while it is building", async (s) => {
  s.put("build-delay-A", "60000");
  const first = s.verb("deploy", "A");
  assert.match(first, /deploy started \(pid \d+\)/);
  const firstPid = s.state().pid;
  await eventually(() => s.has("build-started-A"), "first build to start");
  const second = s.verb("deploy", "B");
  assert.match(second, new RegExp(`superseded pid ${firstPid} \\(A, building\\)`));
  await s.done(firstPid);
  assert.match(s.log(), /superseded by pid \d+/);
  await eventually(() => s.has("idle-restart.state") && s.state().ref === "B", "B to own state");
  await eventually(() => /Started and answering/.test(s.log()), "B to start");
  assert.equal(s.current(), "B");
  assert.ok(!s.has("build-finished-A"), "the killed build must not finish");
});

await scenario("SIGTERM during switching is deferred and the newest ends up current", async (s) => {
  s.put("switch-delay", "800");
  assert.match(s.verb("deploy", "A"), /deploy started/);
  const firstPid = s.state().pid;
  await eventually(() => s.state().phase === "switching", "A to switch");
  const second = s.verb("deploy", "B");
  assert.match(second, new RegExp(`queued behind pid ${firstPid} \\(switching\\)`));
  await eventually(() => /supersede deferred until switch ends/.test(s.log()), "deferral log");
  await s.done(firstPid);
  assert.match(s.log(), /Started and answering \(build A\)/);
  await eventually(
    () => /Restarted and answering \(build B\)/.test(s.log()),
    "B to switch",
    20_000,
  );
  assert.equal(s.current(), "B");
});

await scenario("a rollback queued behind a deploy resolves previous after the flip", async (s) => {
  const base = s.release("R0");
  fs.symlinkSync(base, path.join(s.app, "current"));
  s.put("switch-delay", "800");
  assert.match(s.verb("deploy", "D"), /deploy started/);
  const deployPid = s.state().pid;
  await eventually(() => s.state().phase === "switching", "D to switch");
  assert.match(s.verb("rollback"), /queued behind pid \d+ \(switching\)/);
  await s.done(deployPid);
  await eventually(() => /Restarted and answering \(build R0\)/.test(s.log()), "rollback", 20_000);
  assert.equal(s.current(), "R0");
});

await scenario("a stale state pid is ignored", async (s) => {
  const bystander = spawn("sleep", ["30"], { stdio: "ignore" });
  try {
    s.put(
      "idle-restart.state",
      JSON.stringify({ pid: bystander.pid, verb: "deploy", ref: "X", phase: "waiting" }),
    );
    assert.match(s.verb("deploy", "A"), /deploy started \(pid \d+\)/);
    assert.ok(alive(bystander.pid as number), "an unrelated live pid must not be signalled");
    await eventually(() => /Started and answering/.test(s.log()), "A to start");
  } finally {
    bystander.kill("SIGKILL");
  }
});
console.log("idle-restart supersede ok");
process.exit(0);
