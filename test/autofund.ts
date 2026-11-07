// Autofund relay API: session gate, same-origin POSTs, allowlist, cache and stale fallback. Run: node test/autofund.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";
import { mountAutofund } from "../server/autofund.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autofund-"));
const FIXTURE = { state: "running", pending: [{ id: 7, kind: "spend" }], balance: 12.5 };
fs.writeFileSync(path.join(dir, "dashboard"), JSON.stringify(FIXTURE));
process.env.STUB_DIR = dir;
process.env.AUTOFUND_SSH_BIN = path.join(import.meta.dirname, "autofund-stub.sh");
process.env.AUTOFUND_SSH_KEY = "/tmp/no-such-key";
delete process.env.AUTOFUND_SSH_TARGET;

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

  let r = await fetch(`${base}/api/autofund`, { headers: authed });
  assert.equal(r.status, 503);
  assert.deepEqual(await r.json(), { error: "not configured" });
  assert.equal((await post({ verb: "ack", args: [] })).status, 503);
  assert.equal(calls().length, 0, "unconfigured never calls ssh");

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

  r = await fetch(`${base}/api/autofund`, { headers: authed });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), FIXTURE);
  assert.match(
    calls()[0],
    /^-i \/tmp\/no-such-key -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=5 -o IdentitiesOnly=yes autofund-relay@test\.invalid dashboard$/,
  );
  await fetch(`${base}/api/autofund`, { headers: authed });
  assert.equal(calls().length, 1, "dashboard cached for 30 s");

  r = await post({ verb: "revenue", args: ["ad_sense", "12.50"] });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, ran: "revenue ad_sense 12.50" });
  assert.equal((await post({ verb: "approve", args: ["42"] })).status, 200);
  assert.equal(calls().at(-1)?.endsWith("autofund-relay@test.invalid approve 42"), true);

  // The action invalidated the cache, so the next read hits the relay again; then the relay dies.
  fs.writeFileSync(path.join(dir, "dashboard"), JSON.stringify({ ...FIXTURE, balance: 13 }));
  {
    const before = calls().filter((c) => c.endsWith(" dashboard")).length;
    assert.equal(
      ((await (await fetch(`${base}/api/autofund`, { headers: authed })).json()) as any).balance,
      13,
    );
    assert.equal(
      calls().filter((c) => c.endsWith(" dashboard")).length,
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
  r = await fetch(`${base}/api/autofund`, { headers: authed });
  const failure: any = await r.json();
  assert.equal(r.status, 502);
  assert.equal(typeof failure.error, "string");
  assert.equal(failure.stack, undefined);
  console.log("autofund ok");
} finally {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
