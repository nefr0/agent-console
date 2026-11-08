import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import express from "express";
import { fileEnv } from "./providers/env.ts";

// The autofund dashboard lives on another host. This server only talks to it over SSH with a forced-command key:
// the relay reads SSH_ORIGINAL_COMMAND and accepts dashboard | approve N | reject N | ack | kill | revenue SRC AMT
// | session ID | secrets | secret NAME (value on stdin, never in argv).
const CACHE_TTL = 30_000;
const STALE_MAX = 10 * 60_000;
const SSH_TIMEOUT = 15_000;
const MAX_BUFFER = 4 * 1024 * 1024;
const INT_ARG = /^\d{1,9}$/;
const SRC_ARG = /^[a-z_]{1,32}$/;
const AMT_ARG = /^\d{1,9}(\.\d{1,8})?$/;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const SESSION_TTL = 3_000;
const SESSION_CACHE_MAX = 100;
const ACCOUNTS_TTL = 60_000;
const SECRET_NAMES = ["apify-token", "hackerone", "play-sa"];
const SECRET_MAX = 65_536;
const SECRET_BODY_LIMIT = "96kb";

const ARG_RULES: Record<string, RegExp[]> = {
  approve: [INT_ARG],
  reject: [INT_ARG],
  ack: [],
  kill: [],
  revenue: [SRC_ARG, AMT_ARG],
};

const setting = (name: string) => process.env[name] || fileEnv()[name] || "";
const target = () => setting("AUTOFUND_SSH_TARGET");
const keyFile = () => setting("AUTOFUND_SSH_KEY") || path.join(os.homedir(), ".ssh", "id_autofund");
const sshBin = () => setting("AUTOFUND_SSH_BIN") || "ssh";

class RelayError extends Error {
  status?: number;
  refused = false;
}

/* One forced-command call. Resolves with parsed JSON; rejects with a short message that is safe to show.
   `input` goes to the remote stdin only (secret values): never argv, never logged. */
function relay(cmd: string, input?: string): Promise<any> {
  const args = [
    "-i",
    keyFile(),
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "ConnectTimeout=5",
    "-o",
    "IdentitiesOnly=yes",
    target(),
    cmd,
  ];
  return new Promise((resolve, reject) => {
    const child = execFile(
      sshBin(),
      args,
      { timeout: SSH_TIMEOUT, maxBuffer: MAX_BUFFER },
      (err, stdout) => {
        let parsed: any;
        try {
          parsed = JSON.parse(stdout);
        } catch {}
        if (err || parsed === undefined) {
          const remoteText = typeof parsed?.error === "string" ? parsed.error.slice(0, 200) : "";
          const failure = new RelayError(relayFailureText(err, remoteText));
          if (typeof parsed?.status === "number") failure.status = parsed.status;
          failure.refused = (err as any)?.code === 2 && Boolean(remoteText);
          return reject(failure);
        }
        resolve(parsed);
      },
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
}

function relayFailureText(err: Error | null, remoteText: string): string {
  if (remoteText) return remoteText;
  if (err && (err as any).killed) return "The autofund host did not answer in time.";
  return err
    ? "Could not reach the autofund host over SSH."
    : "The autofund host sent an unreadable answer.";
}

/* Small TTL cache for per-key relay reads; failures are never cached. */
const sessionCache = new Map<string, { until: number; value: any }>();
let accountsCache: { until: number; value: any } | null = null;

async function sessionDetail(id: string): Promise<any> {
  const hit = sessionCache.get(id);
  if (hit && Date.now() < hit.until) return hit.value;
  const value = await relay(`session ${id}`);
  sessionCache.delete(id);
  if (sessionCache.size >= SESSION_CACHE_MAX)
    sessionCache.delete(sessionCache.keys().next().value as string);
  sessionCache.set(id, { until: Date.now() + SESSION_TTL, value });
  return value;
}

async function accounts(): Promise<any> {
  if (accountsCache && Date.now() < accountsCache.until) return accountsCache.value;
  const value = await relay("secrets");
  accountsCache = { until: Date.now() + ACCOUNTS_TTL, value };
  return value;
}

type Snapshot = { at: number; value: any };
let lastGood: Snapshot | null = null;
let freshUntil = 0;
let pending: Promise<any> | null = null;

export function resetAutofundCache() {
  lastGood = null;
  freshUntil = 0;
  pending = null;
  sessionCache.clear();
  accountsCache = null;
}

function staleCopy(snap: Snapshot) {
  const base = snap.value && typeof snap.value === "object" ? snap.value : { data: snap.value };
  return { ...base, stale: true, stale_since: new Date(snap.at).toISOString() };
}

async function dashboard(): Promise<any> {
  if (lastGood && Date.now() < freshUntil) return lastGood.value;
  pending ||= relay("dashboard")
    .then((value) => {
      lastGood = { at: Date.now(), value };
      freshUntil = lastGood.at + CACHE_TTL;
      return value;
    })
    .finally(() => {
      pending = null;
    });
  try {
    return await pending;
  } catch (error) {
    if (lastGood && Date.now() - lastGood.at < STALE_MAX) return staleCopy(lastGood);
    throw error;
  }
}

function validAction(body: any): string | null {
  const verb = body?.verb;
  const args = body?.args ?? [];
  if (typeof verb !== "string" || !Object.hasOwn(ARG_RULES, verb)) return null;
  const rules = ARG_RULES[verb];
  if (!Array.isArray(args) || args.length !== rules.length) return null;
  if (!args.every((arg, i) => typeof arg === "string" && rules[i].test(arg))) return null;
  return [verb, ...args].join(" ");
}

function validSecret(body: any): { name: string; value: string } | null {
  const name = body?.name;
  const value = body?.value;
  if (typeof name !== "string" || !SECRET_NAMES.includes(name)) return null;
  if (typeof value !== "string" || value.length < 1 || value.length > SECRET_MAX) return null;
  return { name, value };
}

/* Body-parser errors can quote the body; answer with a fixed text instead. */
const secretBodyError: express.ErrorRequestHandler = (err, _req, res, _next) => {
  const tooLarge = err?.status === 413;
  res
    .status(tooLarge ? 413 : 400)
    .json({ error: tooLarge ? "Secret too large." : "Invalid secret." });
};

const configured: express.RequestHandler = (_req, res, next) =>
  target() ? next() : void res.status(503).json({ error: "not configured" });

export function mountAutofund(app: express.Express, sameOrigin: express.RequestHandler) {
  app.get("/api/autofund", configured, async (_req, res) => {
    try {
      res.json(await dashboard());
    } catch (error) {
      res.status(502).json({ error: (error as Error).message });
    }
  });
  app.post(
    "/api/autofund/action",
    sameOrigin,
    express.json({ limit: "2kb" }),
    configured,
    async (req, res) => {
      const cmd = validAction(req.body);
      if (!cmd) return void res.status(400).json({ error: "Invalid action." });
      try {
        const out = await relay(cmd);
        freshUntil = 0;
        res.json(out);
      } catch (error) {
        res.status(502).json({ error: (error as Error).message });
      }
    },
  );
  app.get("/api/autofund/session/:id", configured, async (req, res) => {
    const id = String(req.params.id);
    if (!TASK_ID.test(id)) return void res.status(400).json({ error: "Invalid session id." });
    try {
      res.json(await sessionDetail(id));
    } catch (error) {
      if ((error as RelayError).status === 404)
        return void res.status(404).json({ error: "not found" });
      res.status(502).json({ error: (error as Error).message });
    }
  });
  app.get("/api/autofund/accounts", configured, async (_req, res) => {
    try {
      res.json(await accounts());
    } catch (error) {
      res.status(502).json({ error: (error as Error).message });
    }
  });
  app.post(
    "/api/autofund/secret",
    sameOrigin,
    express.json({ limit: SECRET_BODY_LIMIT }),
    secretBodyError,
    configured,
    async (req, res) => {
      const secret = validSecret(req.body);
      if (!secret) return void res.status(400).json({ error: "Invalid secret." });
      try {
        const out = await relay(`secret ${secret.name}`, secret.value);
        accountsCache = null;
        res.json(out);
      } catch (error) {
        const failure = error as RelayError;
        res.status(failure.refused ? 400 : 502).json({ error: failure.message });
      }
    },
  );
}
