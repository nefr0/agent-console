import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import express from "express";
import { fileEnv } from "./providers/env.ts";

// The autofund dashboard lives on another host. This server only talks to it over SSH with a forced-command key:
// the relay reads SSH_ORIGINAL_COMMAND and accepts dashboard | approve N | reject N | ack | kill | revenue SRC AMT.
const CACHE_TTL = 30_000;
const STALE_MAX = 10 * 60_000;
const SSH_TIMEOUT = 15_000;
const MAX_BUFFER = 4 * 1024 * 1024;
const INT_ARG = /^\d{1,9}$/;
const SRC_ARG = /^[a-z_]{1,32}$/;
const AMT_ARG = /^\d{1,9}(\.\d{1,8})?$/;

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

class RelayError extends Error {}

/* One forced-command call. Resolves with parsed JSON; rejects with a short message that is safe to show. */
function relay(cmd: string): Promise<any> {
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
    execFile(sshBin(), args, { timeout: SSH_TIMEOUT, maxBuffer: MAX_BUFFER }, (err, stdout) => {
      let parsed: any;
      try {
        parsed = JSON.parse(stdout);
      } catch {}
      if (err || parsed === undefined) {
        const remoteText = typeof parsed?.error === "string" ? parsed.error.slice(0, 200) : "";
        if (remoteText) return reject(new RelayError(remoteText));
        if (err && (err as any).killed)
          return reject(new RelayError("The autofund host did not answer in time."));
        return reject(
          new RelayError(
            err
              ? "Could not reach the autofund host over SSH."
              : "The autofund host sent an unreadable answer.",
          ),
        );
      }
      resolve(parsed);
    });
  });
}

type Snapshot = { at: number; value: any };
let lastGood: Snapshot | null = null;
let freshUntil = 0;
let pending: Promise<any> | null = null;

export function resetAutofundCache() {
  lastGood = null;
  freshUntil = 0;
  pending = null;
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
}
