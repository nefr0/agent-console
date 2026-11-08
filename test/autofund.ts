// Autofund relay API: session gate, same-origin POSTs, allowlist, cache and stale fallback. Run: node test/autofund.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autofund-"));
const SESSION = { schema: 1, task_id: "plan-1", status: "running", events: [], subagents: [] };
const ACCOUNTS = {
  ok: true,
  accounts: [
    { name: "apify-token", present: false, fingerprint: null, stored_at: null, settable: true },
    { name: "polar-token", present: false, fingerprint: null, stored_at: null, settable: true },
    {
      name: "cloudflare-tunnel",
      present: false,
      fingerprint: null,
      stored_at: null,
      settable: true,
    },
    {
      name: "play-keystore",
      present: true,
      fingerprint: "0f1e2d3c",
      stored_at: null,
      settable: false,
    },
  ],
};
const VENTURE = {
  stage: "launched",
  product: { title: "Prompt pack" },
  report_date: "2026-11-08",
  revenue: { gross: 12, net: 10.5 },
  sales: 3,
  best_source: "reddit",
  next_action: "Post the launch draft",
};
const FIXTURE = {
  state: "running",
  pending: [{ id: 7, kind: "spend" }],
  balance: 12.5,
  venture: VENTURE,
};
fs.writeFileSync(path.join(dir, "dashboard"), JSON.stringify(FIXTURE));
fs.writeFileSync(path.join(dir, "session-plan-1"), JSON.stringify(SESSION));
fs.writeFileSync(path.join(dir, "secrets"), JSON.stringify(ACCOUNTS));
process.env.STUB_DIR = dir;
process.env.AUTOFUND_SSH_BIN = path.join(import.meta.dirname, "autofund-stub.sh");
process.env.AUTOFUND_SSH_KEY = "/tmp/no-such-key";
delete process.env.AUTOFUND_SSH_TARGET;
const envFile = path.join(dir, "env");
fs.writeFileSync(envFile, "");
process.env.AGENT_CONSOLE_ENV_FILES = envFile;
// env.ts reads AGENT_CONSOLE_ENV_FILES at module load, so autofund.ts must be imported after it is set.
const { mountAutofund } = await import("../server/autofund.ts");

const app = express();
// Stand-in for the session gate that index.ts installs before every mount.
app.use((req, res, next) =>
  req.headers.cookie === "session=ok" ? next() : void res.sendStatus(401),
);
mountAutofund(app, (req, res, next) =>
  req.headers.origin && new URL(String(req.headers.origin)).host !== req.headers.host
    ? void res.status(403).json({ error: "cross-site" })
    : next(),
);
const server = http.createServer(app).listen(0);
const base = `http://127.0.0.1:${(server.address() as any).port}`;
const calls = () => {
  const file = path.join(dir, "argv.log");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n") : [];
};
const authed = { cookie: "session=ok" };
const SECRET_VALUE = "s3cr3t-VALUE-0123456789";
const postSecret = (body: unknown, headers: Record<string, string> = {}, raw?: string) =>
  fetch(`${base}/api/autofund/secret`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authed, ...headers },
    body: raw ?? JSON.stringify(body),
  });
const post = (body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/autofund/action`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authed, ...headers },
    body: JSON.stringify(body),
  });

try {
  assert.equal((await fetch(`${base}/api/autofund`)).status, 401, "GET needs a session");
  assert.equal(
    (await post({ verb: "ack", args: [] }, { cookie: "" })).status,
    401,
    "POST needs a session",
  );
  assert.equal(
    (await post({ verb: "ack", args: [] }, { origin: "https://evil.example" })).status,
    403,
    "cross-origin POST refused",
  );

  let response = await fetch(`${base}/api/autofund`, { headers: authed });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "not configured" });
  assert.equal((await post({ verb: "ack", args: [] })).status, 503);
  assert.equal(calls().length, 0, "unconfigured never calls ssh");

  // A target that only lives in the env file configures the route. An invalid action returns 400 only when
  // configured (the config gate runs first and 503s otherwise), and it never reaches ssh.
  fs.writeFileSync(envFile, "AUTOFUND_SSH_TARGET=autofund-relay@test.invalid\n");
  assert.equal((await post({ verb: "rm", args: [] })).status, 400, "env-file target configures");
  assert.equal(calls().length, 0, "env-file check never calls ssh");

  process.env.AUTOFUND_SSH_TARGET = "autofund-relay@test.invalid";
  for (const bad of [
    { verb: "rm", args: ["-rf"] },
    { verb: "approve", args: ["1; ls"] },
    { verb: "approve", args: [] },
    { verb: "approve", args: ["1", "2"] },
    { verb: "reject", args: ["1234567890"] },
    { verb: "ack", args: ["x"] },
    { verb: "revenue", args: ["Bad", "1"] },
    { verb: "revenue", args: ["ads", "1."] },
    { verb: "revenue", args: ["ads"] },
    { verb: "toString", args: [] },
    { verb: "approve", args: [5] },
    { args: [] },
  ])
    assert.equal((await post(bad)).status, 400, JSON.stringify(bad));
  assert.equal(calls().length, 0, "rejected actions never reach ssh");

  response = await fetch(`${base}/api/autofund`, { headers: authed });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), FIXTURE);
  assert.match(
    calls()[0],
    /^-i \/tmp\/no-such-key -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=5 -o IdentitiesOnly=yes autofund-relay@test\.invalid dashboard$/,
  );
  await fetch(`${base}/api/autofund`, { headers: authed });
  assert.equal(calls().length, 1, "dashboard cached for 30 s");

  // Sessions: id regex, relay verb, 3 s cache, 404 mapping.
  const sessionUrl = (id: string) => `${base}/api/autofund/session/${id}`;
  assert.equal((await fetch(sessionUrl("plan-1"))).status, 401, "session needs a login");
  assert.equal((await fetch(`${base}/api/autofund/accounts`)).status, 401, "accounts need a login");
  const callsBeforeSessions = calls().length;
  for (const bad of ["..%2Fetc%2Fpasswd", ".hidden", "-x", "a%20b", "a%2Fb", "x".repeat(65)])
    assert.equal((await fetch(sessionUrl(bad), { headers: authed })).status, 400, bad);
  assert.equal(calls().length, callsBeforeSessions, "bad session ids never reach ssh");
  response = await fetch(sessionUrl("plan-1"), { headers: authed });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), SESSION);
  assert.equal(calls().at(-1)?.endsWith("autofund-relay@test.invalid session plan-1"), true);
  await fetch(sessionUrl("plan-1"), { headers: authed });
  assert.equal(calls().length, callsBeforeSessions + 1, "session cached for 3 s");
  response = await fetch(sessionUrl("nope-1"), { headers: authed });
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "not found" });

  // Accounts: relay `secrets`, cached.
  const callsBeforeAccounts = calls().length;
  response = await fetch(`${base}/api/autofund/accounts`, { headers: authed });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), ACCOUNTS);
  assert.equal(calls().at(-1)?.endsWith("autofund-relay@test.invalid secrets"), true);
  await fetch(`${base}/api/autofund/accounts`, { headers: authed });
  assert.equal(calls().length, callsBeforeAccounts + 1, "accounts cached");

  // Secret POST: value goes to stdin only; refused shapes never reach ssh.
  const callsBeforeSecrets = calls().length;
  assert.equal((await postSecret({ name: "apify-token", value: "x" }, { cookie: "" })).status, 401);
  assert.equal(
    (
      await postSecret(
        { name: "apify-token", value: SECRET_VALUE },
        { origin: "https://evil.example" },
      )
    ).status,
    403,
    "cross-origin secret refused",
  );
  for (const bad of [
    { name: "other", value: "x" },
    { name: "play-keystore", value: "x" },
    { name: "../apify-token", value: "x" },
    { name: "apify-token; ls", value: "x" },
    { name: "__proto__", value: "x" },
    { value: "x" },
    { name: "apify-token" },
    { name: "apify-token", value: "" },
    { name: "apify-token", value: 5 },
    { name: "apify-token", value: "a".repeat(65_537) },
  ])
    assert.equal((await postSecret(bad)).status, 400, JSON.stringify(bad).slice(0, 60));
  response = await postSecret(null, {}, `{"name":"apify-token","value":"${"a".repeat(100_000)}"}`);
  assert.equal(response.status, 413, "body over 96 kb");
  response = await postSecret(null, {}, `{"name":"apify-token","value":"${SECRET_VALUE}`);
  assert.equal(response.status, 400, "malformed json");
  assert.equal((await response.text()).includes(SECRET_VALUE), false, "parse error never echoes");
  assert.equal(calls().length, callsBeforeSecrets, "refused secrets never reach ssh");

  response = await postSecret({ name: "apify-token", value: SECRET_VALUE });
  assert.equal(response.status, 200);
  const stored: any = await response.json();
  assert.equal(stored.ok, true);
  assert.equal(stored.fingerprint, "ab12cd34");
  assert.equal(fs.readFileSync(path.join(dir, "stdin-apify-token"), "utf8"), SECRET_VALUE);
  assert.equal(calls().at(-1)?.endsWith("autofund-relay@test.invalid secret apify-token"), true);
  assert.equal(fs.readFileSync(path.join(dir, "argv.log"), "utf8").includes(SECRET_VALUE), false);
  assert.equal(
    JSON.stringify(stored).includes(SECRET_VALUE),
    false,
    "reply never echoes the value",
  );
  const accountCalls = () => calls().filter((line) => line.endsWith(" secrets")).length;
  const accountsBefore = accountCalls();
  await fetch(`${base}/api/autofund/accounts`, { headers: authed });
  assert.equal(accountCalls(), accountsBefore + 1, "secret POST cleared the accounts cache");
  const hackerone = JSON.stringify({ username: "bob", token: "t".repeat(24) });
  assert.equal((await postSecret({ name: "hackerone", value: hackerone })).status, 200);
  assert.equal(fs.readFileSync(path.join(dir, "stdin-hackerone"), "utf8"), hackerone);
  for (const name of ["polar-token", "cloudflare-tunnel"]) {
    response = await postSecret({ name, value: SECRET_VALUE });
    assert.equal(response.status, 200, `${name} accepted`);
    assert.equal(fs.readFileSync(path.join(dir, `stdin-${name}`), "utf8"), SECRET_VALUE);
    assert.equal(calls().at(-1)?.endsWith(`autofund-relay@test.invalid secret ${name}`), true);
  }
  assert.equal((await postSecret({ name: "polar-token-x", value: "x" })).status, 400);
  assert.equal((await postSecret({ name: "unknown-token", value: "x" })).status, 400);
  response = await postSecret({ name: "play-sa", value: "refuse-me" });
  assert.equal(response.status, 400, "relay refusal maps to 400");
  assert.deepEqual(await response.json(), { error: "invalid format" });

  response = await post({ verb: "revenue", args: ["ad_sense", "12.50"] });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, ran: "revenue ad_sense 12.50" });
  assert.equal((await post({ verb: "approve", args: ["42"] })).status, 200);
  assert.equal(calls().at(-1)?.endsWith("autofund-relay@test.invalid approve 42"), true);

  // The action invalidated the cache, so the next read hits the relay again; then the relay dies.
  fs.writeFileSync(path.join(dir, "dashboard"), JSON.stringify({ ...FIXTURE, balance: 13 }));
  {
    const before = calls().filter((line) => line.endsWith(" dashboard")).length;
    assert.equal(
      ((await (await fetch(`${base}/api/autofund`, { headers: authed })).json()) as any).balance,
      13,
    );
    assert.equal(
      calls().filter((line) => line.endsWith(" dashboard")).length,
      before + 1,
      "action invalidated cache",
    );
  }
  assert.equal((await post({ verb: "kill", args: [] })).status, 200);
  fs.writeFileSync(path.join(dir, "down"), "");
  const stale: any = await (await fetch(`${base}/api/autofund`, { headers: authed })).json();
  assert.equal(stale.stale, true);
  assert.equal(stale.balance, 13);
  assert.ok(Date.now() - Date.parse(stale.stale_since) < 60_000);
  assert.equal(
    (await post({ verb: "ack", args: [] })).status,
    502,
    "actions never fall back to stale",
  );

  // Nothing good cached: failure is a plain 502 with text only.
  const { resetAutofundCache } = await import("../server/autofund.ts");
  resetAutofundCache();
  response = await fetch(`${base}/api/autofund`, { headers: authed });
  const failure: any = await response.json();
  assert.equal(response.status, 502);
  assert.equal(typeof failure.error, "string");
  assert.equal(failure.stack, undefined);
  console.log("autofund ok");
} finally {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
