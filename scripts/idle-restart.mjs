// Deploy a release of agent-console without the server's help (works on any version), run detached by `bin/agent-console deploy`
// (alias restart-when-idle) or `rollback`; log goes to $RUN/idle-restart.log. Usage: idle-restart.mjs [deploy [ref]|rollback]
//   deploy:   build a release of the source repo first (failure aborts, the old server is untouched), wait until every thread is
//             idle, point $APP/current at the release and hand the port over: a standby supervisor starts the new server, which
//             loads its modules and waits; then the old supervisor and server stop and the standby gets `go` (a gap well under 1 s).
//   rollback: the same handoff to $APP/previous, no build.
// Newest wins (#495): a new run reads $RUN/idle-restart.state, SIGTERMs a live older run (it exits unless it is already switching, then
// the new one queues behind it on idle-restart.lock) and reports the outcome in $RUN/idle-restart.claim-<pid> for the wrapper.
// Phases: building (no lock) -> queued (blocking on the lock) -> waiting (holds it, waiting for idle) -> switching (flip to exit).
// Source repo: $AGENT_CONSOLE_REPO, else the `repo` field of RELEASE.json of the running release, else the git tree of this script.

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { makeToken } from "../server/auth.ts";

// Servers before #350 read ac_session and newer ones read __Host-ac_session; a deploy talks to both.
const bothCookies = () => {
  const token = makeToken();
  return `ac_session=${token}; __Host-ac_session=${token}`;
};

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUN = process.env.AGENT_CONSOLE_RUN || path.join(os.homedir(), ".cache", "agent-console");
const APP =
  process.env.AGENT_CONSOLE_HOME || path.join(os.homedir(), ".local", "share", "agent-console");
const PORT = process.env.PORT || "7070";
const MODE = process.argv[2] === "rollback" ? "rollback" : "deploy";
const REF = process.argv[3] || "HEAD";
const CURRENT = path.join(APP, "current");
const PREVIOUS = path.join(APP, "previous");
const PID_FILE = path.join(RUN, "pid");
const SUPERVISOR_FILE = path.join(RUN, "supervisor");
const READY_FILE = path.join(RUN, "standby-ready");
const LOCK_FILE = path.join(RUN, "idle-restart.lock");
const STATE_FILE = path.join(RUN, "idle-restart.state");
const RELEASE_SCRIPT =
  process.env.AGENT_CONSOLE_RELEASE_SCRIPT || path.join(ROOT, "scripts", "release.mjs");
const HANDOFF_MARKER = path.join(RUN, "handoff");
const STANDBY_WAIT_MS = 5000;
const GO_WAIT_MS = 8000; // the old server gets 3 s before SIGKILL
const HELLO_WAIT_MS = 20_000; // hello is slow under load; the full wait is only spent on a genuine failure
const IDLE_MS = Number(process.env.AGENT_CONSOLE_IDLE_MS) || 1500; // a queued message may start the next turn right after one ends (env: tests)
const MAX_ATTEMPTS = 3;
const AUTH = { origin: `http://127.0.0.1:${PORT}`, cookie: bothCookies() };
const WS_URL = `ws://127.0.0.1:${PORT}/ws`;
const began = performance.now();

const log = (message) =>
  console.log(
    `[${new Date().toISOString()}] +${Math.round(performance.now() - began)}ms ${message}`,
  );
const give = (why, code) => {
  log(why);
  process.exit(code);
};
const readText = (file) => {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
};
const realOrNull = (file) => {
  try {
    return fs.realpathSync(file);
  } catch {
    return null;
  }
};
const cmdline = (pid) => (pid ? readText(`/proc/${pid}/cmdline`) : "");
const isServer = (pid) => cmdline(pid).includes("server/index.ts");
const isAlive = (pid) => {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
};
const killQuietly = (pid, signal) => {
  try {
    process.kill(Number(pid), signal);
  } catch {}
};
// background subagents run inside the agent process: a restart kills them even though their thread looks idle
const busy = (thread) => thread.status === "running" || thread.background > 0;

async function pollUntil(test, timeoutMs, stepMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (test()) return true;
    await delay(stepMs);
  }
  return test();
}

// ---- newest wins: state, claim, lock ------------------------------------------------------------------------------------

let phase = "building";
let releaseChild = null;
let lockHolder = null;

const readState = () => {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return null;
  }
};
const ownsState = () => readState()?.pid === process.pid;

// tmp + rename so a reader never sees half a file; later phases are only written while the file still names this process
function writeState(next, force) {
  phase = next;
  if (!force && !ownsState()) return;
  const tmp = `${STATE_FILE}.tmp-${process.pid}`;
  const state = { pid: process.pid, verb: MODE, ref: REF, phase, since: new Date().toISOString() };
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, STATE_FILE);
}
const setPhase = (next) => writeState(next, false);

const isPeer = (state) =>
  !!state &&
  state.pid !== process.pid &&
  isAlive(state.pid) &&
  cmdline(state.pid).includes("idle-restart.mjs");

function claimResult(previous) {
  if (!isPeer(previous)) return `deploy started (pid ${process.pid})`;
  killQuietly(previous.pid, "SIGTERM"); // the pid only, never its group
  return previous.phase === "switching"
    ? `queued behind pid ${previous.pid} (switching)`
    : `superseded pid ${previous.pid} (${previous.ref}, ${previous.phase})`;
}

function claim() {
  const result = claimResult(readState());
  writeState("building", true);
  log(result);
  const file = path.join(RUN, `idle-restart.claim-${process.pid}`);
  fs.writeFileSync(`${file}.tmp`, `${result}\n`);
  fs.renameSync(`${file}.tmp`, file);
}

function releaseLock() {
  lockHolder?.stdin.end();
  lockHolder?.kill("SIGTERM");
  lockHolder = null;
}

function onSupersede() {
  if (phase === "switching") {
    log("supersede deferred until switch ends");
    return;
  }
  log(`superseded by pid ${readState()?.pid}`);
  if (releaseChild?.pid) killQuietly(-releaseChild.pid, "SIGTERM");
  releaseLock();
  process.exit(0);
}

// Node has no flock: `flock` holds the lock on a child that lives until our stdin closes, so it is released when we exit, however we exit.
function acquireLock() {
  return new Promise((resolve, reject) => {
    const holder = spawn("flock", [LOCK_FILE, "sh", "-c", "echo held; cat >/dev/null"], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    lockHolder = holder;
    holder.once("error", reject);
    holder.once("exit", (code) => reject(new Error(`lock holder exited ${code}`)));
    holder.stdout.once("data", () => resolve());
  });
}

async function takeLock() {
  setPhase("queued");
  log("Queued for the deploy lock.");
  await acquireLock();
  if (!ownsState()) give("Superseded while queued; exiting.", 0);
  setPhase("waiting");
  log("Holding the deploy lock.");
}

// ---- release selection -------------------------------------------------------------------------------------------------

function repoOf(releaseDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(releaseDir, "RELEASE.json"), "utf8")).repo;
  } catch {
    return undefined;
  }
}

function resolveRepo() {
  if (process.env.AGENT_CONSOLE_REPO) return process.env.AGENT_CONSOLE_REPO;
  const known = repoOf(ROOT) ?? repoOf(CURRENT);
  if (known && fs.existsSync(known)) return known;
  return execFileSync("git", ["-C", ROOT, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
}

function runRelease(repo) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [RELEASE_SCRIPT, REF, "--repo", repo], {
      stdio: ["ignore", "pipe", "inherit"],
      detached: true, // own group, so superseding kills the build and the flock/npm below it
    });
    releaseChild = child;
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve(out.trim().split("\n").pop())
        : reject(new Error(`release exited ${code}`)),
    );
  });
}

async function buildTarget() {
  const repo = resolveRepo();
  log(`Building a release of ${REF} from ${repo} before waiting for idle.`);
  try {
    const dir = await runRelease(repo);
    log(`Release ready: ${dir}`);
    return dir;
  } catch (failure) {
    return give(`Release build failed; the old server is untouched: ${failure.message}`, 1);
  }
}

function rollbackTarget() {
  const previous = realOrNull(PREVIOUS);
  if (!previous) give(`No ${PREVIOUS} release to roll back to.`, 1);
  return previous;
}

// ---- current/previous links --------------------------------------------------------------------------------------------

// symlink to a temp name, then rename over the link: readers see the old or the new target, never neither
function setLink(link, target) {
  const tmp = `${link}.tmp-${process.pid}`;
  fs.rmSync(tmp, { force: true });
  fs.symlinkSync(target, tmp);
  fs.renameSync(tmp, link);
}

function flip(newDir) {
  const undo = { current: realOrNull(CURRENT), previous: realOrNull(PREVIOUS) };
  if (undo.current && undo.current !== newDir) setLink(PREVIOUS, undo.current);
  setLink(CURRENT, newDir);
  log(`current -> ${newDir}`);
  return undo;
}

function revert(undo) {
  if (undo.current) setLink(CURRENT, undo.current);
  if (undo.previous) setLink(PREVIOUS, undo.previous);
  else fs.rmSync(PREVIOUS, { force: true });
  log(`current reverted to ${undo.current}`);
}

// ---- watching threads --------------------------------------------------------------------------------------------------

function applyMessage(watcher, message) {
  if (message.t === "hello") {
    watcher.threads = new Map(message.threads.map((thread) => [thread.id, thread]));
    watcher.queues = new Map(Object.entries(message.queues || {}));
    watcher.durableQueues = !!message.features?.queueEditing; // queues survive a restart on newer servers
    watcher.build = message.build;
    watcher.onHello(message);
  }
  if (message.t === "thread") watcher.threads?.set(message.thread.id, message.thread);
  if (message.t === "removed") {
    watcher.threads?.delete(message.thread);
    watcher.queues.delete(message.thread);
  }
  if (message.t === "queue") watcher.queues.set(message.thread, message.items || []);
}

function watchServer() {
  const watcher = { threads: null, queues: new Map(), durableQueues: false, build: "" };
  watcher.socket = new WebSocket(WS_URL, { headers: AUTH });
  watcher.hello = new Promise((resolve, reject) => {
    watcher.onHello = resolve;
    watcher.socket.once("error", reject);
  });
  watcher.socket.on("message", (raw) => applyMessage(watcher, JSON.parse(String(raw))));
  watcher.hello.then(() => watcher.socket.on("error", () => {}));
  return watcher;
}

const isBusy = (watcher) =>
  !watcher.threads ||
  [...watcher.threads.values()].some(busy) ||
  (!watcher.durableQueues && [...watcher.queues.values()].some((queue) => queue.length));

function waitIdle(watcher, original) {
  return new Promise((resolve) => {
    let idleSince = 0;
    const timer = setInterval(
      () => {
        if (!ownsState()) give("Superseded while waiting; exiting.", 0);
        if (readText(PID_FILE) !== original)
          give("Server was already restarted; nothing to do.", 0);
        if (isBusy(watcher)) {
          idleSince = 0;
          return;
        }
        idleSince ||= Date.now();
        if (Date.now() - idleSince < IDLE_MS) return;
        clearInterval(timer);
        resolve();
      },
      Math.min(500, IDLE_MS / 3),
    );
  });
}

// ---- handoff -----------------------------------------------------------------------------------------------------------

// Detached (own session) so neither the old server's shutdown nor this script's exit takes it down.
function startSupervisor() {
  fs.rmSync(READY_FILE, { force: true });
  const bin = path.join(CURRENT, "bin", "agent-console");
  const env = { ...process.env, AGENT_CONSOLE_RUN: RUN, AGENT_CONSOLE_HOME: APP, PORT };
  const child = spawn(bin, ["supervise", "--handoff"], { detached: true, stdio: "ignore", env });
  const handle = { pid: child.pid, gone: false };
  child.on("exit", () => {
    handle.gone = true;
  });
  child.unref();
  return handle;
}

// SIGTERM makes the standby supervisor kill its server and clean up; the explicit kill is only a backstop.
async function abortStandby(handle) {
  killQuietly(handle.pid, "SIGTERM");
  const standby = readText(READY_FILE);
  if (standby && isAlive(standby)) killQuietly(standby, "SIGTERM");
  await pollUntil(() => handle.gone, 1000, 20);
  fs.rmSync(READY_FILE, { force: true });
  fs.rmSync(HANDOFF_MARKER, { force: true });
}

// Only the supervisor, never the server: the standby supervisor stops the old server itself once it holds the lock.
function killOldSupervisor(standbyPid) {
  const pid = readText(SUPERVISOR_FILE);
  const line = cmdline(pid);
  if (
    !pid ||
    Number(pid) === standbyPid ||
    !line.includes("agent-console") ||
    !line.includes("supervise")
  )
    return;
  killQuietly(pid, "SIGTERM");
  log(`old supervisor ${pid} stopped`);
}

// Reconnects only while the server is not up yet (connect error, close, unexpected response). An open socket waits for hello
// until the deadline: hello is slow when the host is loaded, and cutting the wait short rolled a healthy server back.
async function probeHello(wantBuild, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const attempt = await helloBuild(end - Date.now());
    if (attempt.build !== null) return { ok: attempt.build === wantBuild, build: attempt.build };
    if (!attempt.retry) break;
    await delay(50);
  }
  return { ok: false, build: null };
}

// Resolves { build } once hello arrives; { build: null, retry: true } when the server is not up yet; { build: null, retry: false }
// when the socket opened but no hello came within timeoutMs.
function helloBuild(timeoutMs) {
  return new Promise((resolve) => {
    const probe = new WebSocket(WS_URL, { headers: AUTH });
    const finish = (result) => {
      clearTimeout(timer);
      probe.removeAllListeners();
      probe.on("error", () => {});
      probe.terminate();
      resolve(result);
    };
    const notUp = () => finish({ build: null, retry: true });
    const timer = setTimeout(() => finish({ build: null, retry: false }), timeoutMs);
    probe.on("error", notUp);
    probe.on("close", notUp);
    probe.on("unexpected-response", notUp);
    probe.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      if (message.t === "hello") finish({ build: message.build ?? "" });
    });
  });
}

// One attempt. retry: the old server was never touched, so the caller may wait for idle again and retry.
async function handoffTo(wantBuild, watcher) {
  const started = performance.now();
  const lap = () => `${Math.round(performance.now() - started)}ms`;
  const handle = startSupervisor();
  log(`standby supervisor ${handle.pid} started`);
  const ready = await pollUntil(() => fs.existsSync(READY_FILE) || handle.gone, STANDBY_WAIT_MS, 5);
  if (!ready || !fs.existsSync(READY_FILE)) {
    const why = handle.gone
      ? "standby server died before it was ready"
      : `no standby-ready after ${STANDBY_WAIT_MS}ms`;
    await abortStandby(handle);
    return { ok: false, retry: true, why };
  }
  log(`standby ready after ${lap()}`);
  if (watcher && isBusy(watcher)) {
    await abortStandby(handle);
    return { ok: false, retry: true, why: "a turn started while the standby loaded" };
  }
  killOldSupervisor(handle.pid);
  if (!(await pollUntil(() => !fs.existsSync(HANDOFF_MARKER), GO_WAIT_MS, 10)))
    return { ok: false, retry: false, why: `no go after ${GO_WAIT_MS}ms` };
  log(`go sent ${lap()} after the standby supervisor started`);
  const probe = await probeHello(wantBuild, HELLO_WAIT_MS);
  log(
    `new server ${probe.ok ? "answered hello" : `did not answer hello (last build ${probe.build})`} ${lap()} after start`,
  );
  return probe.ok
    ? { ok: true, build: probe.build }
    : { ok: false, retry: false, why: `hello build ${probe.build} is not ${wantBuild}` };
}

// Last resort when even the handoff back fails: the classic stop and start, from whatever `current` points at.
async function hardRestart(wantBuild) {
  const bin = path.join(CURRENT, "bin", "agent-console");
  log("Falling back to stop and start.");
  execFileSync(bin, ["stop"], { stdio: "inherit" });
  await pollUntil(() => !isServer(readText(PID_FILE)), 10_000, 100);
  execFileSync(bin, ["start"], { stdio: "inherit" });
  return probeHello(wantBuild, HELLO_WAIT_MS);
}

async function recover(undo, why) {
  log(`Handoff failed (${why}); returning to the previous release.`);
  if (!undo.current) give("There is no previous release; nothing to return to.", 1);
  revert(undo);
  const wantBuild = path.basename(undo.current);
  const back = (await handoffTo(wantBuild, null)).ok || (await hardRestart(wantBuild)).ok;
  give(
    back ? "Previous release is serving again; the new release failed." : "Rollback failed too.",
    1,
  );
}

// ---- main --------------------------------------------------------------------------------------------------------------

async function coldStart(target, wantBuild) {
  setPhase("switching");
  log("No server is running; pointing current at the release and starting it.");
  flip(target);
  execFileSync(path.join(CURRENT, "bin", "agent-console"), ["start"], { stdio: "inherit" });
  const probe = await probeHello(wantBuild, HELLO_WAIT_MS);
  give(
    probe.ok ? `Started and answering (build ${probe.build}).` : "Start failed.",
    probe.ok ? 0 : 1,
  );
}

async function connectWatcher(original) {
  const watcher = watchServer();
  await watcher.hello.catch((failure) => give(`Could not connect: ${failure.message}`, 1));
  const count = [...watcher.threads.values()].filter(busy).length;
  log(
    `Waiting for ${count} busy thread(s) (running turns or background subagents) before switching pid ${original}.`,
  );
  return watcher;
}

async function attemptLoop(target, wantBuild, watcher, original) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await waitIdle(watcher, original);
    log(`All threads idle (attempt ${attempt}/${MAX_ATTEMPTS}); handing over to ${wantBuild}.`);
    setPhase("switching");
    const undo = flip(target);
    const result = await handoffTo(wantBuild, watcher);
    if (result.ok) return give(`Restarted and answering (build ${result.build}).`, 0);
    if (!result.retry) return recover(undo, result.why);
    revert(undo);
    setPhase("waiting");
    log(`Handoff aborted (${result.why}); the old server keeps serving.`);
  }
  return give(`Gave up after ${MAX_ATTEMPTS} attempts; the old server keeps serving.`, 1);
}

async function main() {
  process.on("SIGTERM", onSupersede);
  claim();
  const built = MODE === "rollback" ? null : await buildTarget();
  await takeLock();
  const target = built ?? rollbackTarget(); // a rollback queued behind a deploy means the release that deploy replaced
  const wantBuild = path.basename(target);
  const original = readText(PID_FILE); // the baseline is the server running now, not the one at launch
  if (!isServer(original)) return coldStart(target, wantBuild);
  const watcher = await connectWatcher(original);
  if (watcher.build === wantBuild) give(`Build ${wantBuild} is already running; nothing to do.`, 0);
  // outlast the server's sweep, which ends a hung turn after 30 minutes of silence and hung background work after 135
  setTimeout(() => give("Waited 150 minutes; server left running.", 1), 150 * 60_000);
  return attemptLoop(target, wantBuild, watcher, original);
}

export { probeHello };

if (process.argv[1] === fileURLToPath(import.meta.url))
  main().catch((failure) => give(`Deploy failed: ${failure?.stack ?? failure}`, 1));
