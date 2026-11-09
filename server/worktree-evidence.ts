import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { parse } from "shell-quote";
import type { WorktreeEvidence, WorktreeEvidenceSnapshot } from "./worktree-contracts.ts";

type ShellLocation = { cwd?: string; trusted: boolean };
type Candidate = { kind: WorktreeEvidence["kind"]; path: string; repo?: string };
type EvidenceThread = { id: string; cwd?: string; archived?: boolean; status?: string };
const MAX_LINE = 8 * 1024 * 1024;
const EXECUTION_TOOL = /(?:^|[.:_])(?:bash|exec_command|shell_command|shell|terminal|exec)$/i;

function absolute(value: unknown, cwd?: string): string | undefined {
  if (typeof value !== "string" || !value || /[\0\n\r$`]/.test(value)) return;
  const expanded = value === "~" ? os.homedir() : value.replace(/^~\//, `${os.homedir()}/`);
  if (!path.isAbsolute(expanded) && !cwd) return;
  return path.resolve(cwd || "/", expanded);
}

function objectInput(input: any): any {
  if (typeof input !== "string") return input;
  try {
    return JSON.parse(input);
  } catch {
    return { code: input };
  }
}

/** Preserve only literal path metadata from opaque execution, never its source. */
function mentionedPaths(source: string): Candidate[] {
  const matches = source.matchAll(
    /(?:["'](\/[^"'\n]+)["'])|(?:^|[\s=(,:])((?:~\/|\/)[^\s"'`$;|&)\]}]+)/g,
  );
  const paths = new Set<string>();
  for (const match of matches) {
    const resolved = absolute(match[1] || match[2]);
    if (resolved) paths.add(resolved);
    if (paths.size >= 100) break;
  }
  return [...paths].map((entry) => ({ kind: "ambiguous", path: entry }));
}

function unresolvedTilde(command: string, tokens: unknown[]) {
  // shell-quote intentionally drops quote provenance; quoted or escaped tildes must not expand.
  return (
    (command.includes("~") && /["'\\]/.test(command)) ||
    tokens.some((token) => typeof token === "string" && /^~(?!\/|$)/.test(token))
  );
}

function literalSegments(command: string): string[][] | undefined {
  // Expansions, control flow and pipelines cannot establish literal execution paths.
  if (/[\n\r$`]/.test(command)) return;
  const tokens = parse(command);
  if (unresolvedTilde(command, tokens)) return;
  const segments: string[][] = [[]];
  for (const token of tokens) {
    if (typeof token === "string") segments.at(-1)!.push(token);
    else if ("op" in token && token.op === "&&") segments.push([]);
    else return;
  }
  if (segments.some((segment) => !segment.length)) return;
  if (
    segments.some((segment) =>
      /^(?:for|while|until|if|case|function|eval|source|\.)$/.test(segment[0]),
    )
  )
    return;
  return segments;
}

function gitArguments(tokens: string[], location: ShellLocation) {
  let offset = 1;
  let directory = location.cwd;
  let trusted = location.trusted;
  while (tokens[offset] === "-C") {
    trusted ||= Boolean(absolute(tokens[offset + 1]));
    directory = absolute(tokens[offset + 1], directory);
    if (!directory) return;
    offset += 2;
  }
  return { location: { cwd: directory, trusted }, args: tokens.slice(offset) };
}

function addedTarget(args: string[]): string | undefined {
  if (args[0] !== "worktree" || args[1] !== "add") return;
  let offset = 2;
  while (args[offset]?.startsWith("-")) {
    const option = args[offset++];
    if (option === "--") break;
    if (["-b", "-B", "--reason"].includes(option)) {
      if (!args[offset++]) return;
    } else if (
      !/^(?:-f|--force|-d|--detach|--lock|--checkout|--no-checkout|--guess-remote|--track|--no-track|--orphan)$/.test(
        option,
      )
    )
      return;
  }
  if (args.length - offset > 2) return;
  return args[offset];
}

function gitCandidates(segment: string[], location: ShellLocation): Candidate[] | undefined {
  const git = gitArguments(segment, location);
  if (!git) return;
  const candidates: Candidate[] = git.location.cwd ? [{ kind: "use", path: git.location.cwd }] : [];
  const target = addedTarget(git.args);
  const created = absolute(target, git.location.cwd);
  if (created)
    candidates.push({
      kind: git.location.trusted || absolute(target) ? "create" : "ambiguous",
      path: created,
      ...(git.location.trusted && git.location.cwd ? { repo: git.location.cwd } : {}),
    });
  return candidates;
}

function segmentCandidates(
  segment: string[],
  location: ShellLocation,
): { location: ShellLocation; candidates: Candidate[] } | undefined {
  if (segment[0] === "cd") {
    const directory = absolute(segment[1], location.cwd);
    if (segment.length !== 2 || !directory) return;
    return {
      location: { cwd: directory, trusted: location.trusted || Boolean(absolute(segment[1])) },
      candidates: [{ kind: "use", path: directory }],
    };
  }
  if (segment[0] === "git") {
    const candidates = gitCandidates(segment, location);
    return candidates ? { location, candidates } : undefined;
  }
  if (
    /^(?:node|python[0-9.]*|ruby|perl|bash|sh|zsh)$/.test(path.basename(segment[0])) &&
    segment.some((argument) => /^-(?:[il]*c|e)$|^--eval$/.test(argument))
  )
    return;
  const executable = segment[0].startsWith("/") ? absolute(segment[0], location.cwd) : undefined;
  return { location, candidates: executable ? [{ kind: "use", path: executable }] : [] };
}

function shellCandidates(command: string, location: ShellLocation): Candidate[] {
  const segments = literalSegments(command);
  if (!segments) return mentionedPaths(command);
  const candidates: Candidate[] = [];
  let current = location;
  for (const segment of segments) {
    const parsed = segmentCandidates(segment, current);
    if (!parsed) return mentionedPaths(command);
    current = parsed.location;
    candidates.push(...parsed.candidates);
  }
  return candidates;
}

/** Only canonical execution calls can establish ownership; arbitrary transcript mentions cannot. */
export function worktreeToolCandidates(block: any, threadCwd?: string): Candidate[] {
  if (typeof block?.name !== "string" || !EXECUTION_TOOL.test(block.name)) return [];
  const input = objectInput(block.input);
  if (!input || typeof input !== "object") return [];
  const explicitCwd = input.cwd ?? input.workdir;
  const cwd =
    explicitCwd === undefined ? absolute(threadCwd) : absolute(explicitCwd, absolute(threadCwd));
  if (explicitCwd !== undefined && !cwd)
    return mentionedPaths(String(input.command ?? input.cmd ?? input.code ?? input.source ?? ""));
  const candidates: Candidate[] = cwd ? [{ kind: "use", path: cwd }] : [];
  const command = input.command ?? input.cmd;
  if (typeof command === "string")
    candidates.push(...shellCandidates(command, { cwd, trusted: Boolean(absolute(explicitCwd)) }));
  else {
    const code = input.code ?? input.source;
    if (typeof code === "string") candidates.push(...mentionedPaths(code));
  }
  return [
    ...new Map(
      candidates.map((candidate) => [`${candidate.kind}:${candidate.path}`, candidate]),
    ).values(),
  ];
}

function resultMetadata(value: any, depth = 0): { failed: boolean; pending: boolean } {
  if (depth > 5 || value == null) return { failed: false, pending: false };
  if (typeof value === "string" && failedResultText(value)) return { failed: true, pending: false };
  const parsed = objectInput(value);
  if (!parsed || typeof parsed !== "object") return { failed: false, pending: false };
  const exit = parsed.exit_code ?? parsed.exitCode;
  let failed =
    parsed.is_error === true || parsed.isError === true || (typeof exit === "number" && exit !== 0);
  let pending = parsed.session_id != null && exit == null;
  const children = Array.isArray(parsed)
    ? parsed
    : [parsed.content, parsed.structuredContent, parsed.text];
  for (const child of children) {
    const metadata = resultMetadata(child, depth + 1);
    failed ||= metadata.failed;
    pending ||= metadata.pending;
  }
  return { failed, pending };
}

function failedResultText(value: string) {
  if (/^\s*(?:Error:|Command failed\b)/i.test(value)) return true;
  const exit =
    /(?:^|\n)(?:Process exited with code|Command exited with (?:code|status)|Exit code:)\s*(-?\d+)\b/i.exec(
      value,
    );
  return Boolean(exit && Number(exit[1]) !== 0);
}

function resultSuccess(block: any): boolean | undefined {
  const metadata = resultMetadata(block);
  if (metadata.failed) return false;
  if (metadata.pending) return undefined;
  if (block.is_error === false || block.isError === false) return true;
  const content = objectInput(block.content);
  const exit = block.exit_code ?? block.exitCode ?? content?.exit_code ?? content?.exitCode;
  if (typeof exit === "number") return exit === 0;
  // Claude omits is_error for successful results. An actual canonical result is still required.
  if (typeof block.content === "string" || Array.isArray(block.content)) return true;
  return undefined;
}

/** SQLite holds paths and correlation metadata only. Log offsets make backfill durable and incremental. */
export class WorktreeEvidenceIndex {
  private ready = false;
  private context = "";
  private traversal = { logsRead: 0, bytesRead: 0, eventsRead: 0 };
  private database: DatabaseSync;
  private dataDir: string;
  constructor(database: DatabaseSync, dataDir: string) {
    this.database = database;
    this.dataDir = dataDir;
    database.exec(`CREATE TABLE IF NOT EXISTS worktree_logs (
      thread TEXT PRIMARY KEY, bytes INTEGER NOT NULL, lines INTEGER NOT NULL,
      size INTEGER NOT NULL, mtime REAL NOT NULL, inode TEXT NOT NULL, cwd TEXT
    );
    CREATE TABLE IF NOT EXISTS worktree_calls (
      thread TEXT NOT NULL, tool_id TEXT NOT NULL, line INTEGER NOT NULL, kind TEXT NOT NULL,
      path TEXT NOT NULL, repo TEXT, result_line INTEGER, success INTEGER,
      PRIMARY KEY(thread,tool_id,line,kind,path)
    );
    CREATE INDEX IF NOT EXISTS worktree_calls_pending ON worktree_calls(thread,tool_id,success);`);
  }

  remove(thread: string) {
    this.database.prepare("DELETE FROM worktree_calls WHERE thread=?").run(thread);
    this.database.prepare("DELETE FROM worktree_logs WHERE thread=?").run(thread);
  }

  reset() {
    this.database.exec("DELETE FROM worktree_calls; DELETE FROM worktree_logs;");
    this.ready = false;
  }

  async refresh(threads: EvidenceThread[]) {
    this.ready = false;
    this.context = JSON.stringify(
      threads.map((thread) => [thread.id, thread.cwd, thread.archived, thread.status]),
    );
    this.traversal = { logsRead: 0, bytesRead: 0, eventsRead: 0 };
    const ids = new Set(threads.map((thread) => thread.id));
    for (const row of this.database.prepare("SELECT thread FROM worktree_logs").all())
      if (!ids.has(String(row.thread))) this.remove(String(row.thread));
    for (const thread of threads) await this.refreshThread(thread);
    this.ready = true;
  }

  snapshot(stale = false): WorktreeEvidenceSnapshot {
    const entries = new Map<string, WorktreeEvidence>();
    for (const row of this.database
      .prepare(
        "SELECT * FROM worktree_calls WHERE success=1 OR success IS NULL ORDER BY thread,line,kind,path",
      )
      .all()) {
      const entry: WorktreeEvidence = {
        kind: row.success === null ? "ambiguous" : (row.kind as WorktreeEvidence["kind"]),
        path: String(row.path),
        thread: String(row.thread),
        line: Number(row.line),
        toolId: String(row.tool_id),
        ...(row.repo ? { repo: String(row.repo) } : {}),
        ...(row.result_line !== null ? { resultLine: Number(row.result_line) } : {}),
      };
      entries.set(`${entry.thread}:${entry.kind}:${entry.path}`, entry);
    }
    const evidence = [...entries.values()];
    return {
      stale: stale || !this.ready,
      version: createHash("sha256")
        .update(this.context)
        .update(JSON.stringify(evidence))
        .digest("hex"),
      entries: evidence,
      traversal: { ...this.traversal },
    };
  }

  private track(thread: EvidenceThread, line: number, event: any) {
    const content = event?.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (event.type === "assistant" && block?.type === "tool_use" && typeof block.id === "string")
        this.trackCall(thread, line, block);
      else if (
        event.type === "user" &&
        block?.type === "tool_result" &&
        typeof block.tool_use_id === "string"
      )
        this.trackResult(thread.id, line, block);
    }
  }

  private trackCall(thread: EvidenceThread, line: number, block: any) {
    for (const candidate of worktreeToolCandidates(block, thread.cwd))
      this.database
        .prepare(
          "INSERT OR IGNORE INTO worktree_calls(thread,tool_id,line,kind,path,repo) VALUES(?,?,?,?,?,?)",
        )
        .run(thread.id, block.id, line, candidate.kind, candidate.path, candidate.repo ?? null);
  }

  private trackResult(thread: string, line: number, block: any) {
    const success = resultSuccess(block);
    if (success === undefined) return;
    this.database
      .prepare(`UPDATE worktree_calls SET result_line=?,success=? WHERE thread=? AND tool_id=? AND line=(
      SELECT max(line) FROM worktree_calls WHERE thread=? AND tool_id=? AND success IS NULL
    )`)
      .run(line, Number(success), thread, block.tool_use_id, thread, block.tool_use_id);
  }

  private async refreshThread(thread: EvidenceThread) {
    const file = path.join(this.dataDir, "logs", `${thread.id}.jsonl`);
    let stat: fs.Stats;
    try {
      stat = await fsp.stat(file);
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
      this.remove(thread.id);
      return;
    }
    let old = this.database
      .prepare("SELECT * FROM worktree_logs WHERE thread=?")
      .get(thread.id) as any;
    if (
      old &&
      (old.inode !== String(stat.ino) ||
        stat.size < old.size ||
        (stat.size === old.size && stat.mtimeMs !== old.mtime))
    ) {
      this.remove(thread.id);
      old = undefined;
    }
    if (old && old.size === stat.size && old.mtime === stat.mtimeMs) return;
    const state = {
      bytes: Number(old?.bytes ?? 0),
      lines: Number(old?.lines ?? 0),
      pending: Buffer.alloc(0),
      skipped: 0,
    };
    this.database
      .prepare("DELETE FROM worktree_calls WHERE thread=? AND line>?")
      .run(thread.id, state.lines);
    this.database
      .prepare(
        "UPDATE worktree_calls SET success=NULL,result_line=NULL WHERE thread=? AND result_line>?",
      )
      .run(thread.id, state.lines);
    if (stat.size > state.bytes) {
      this.traversal.logsRead++;
      const stream = fs.createReadStream(file, {
        start: state.bytes,
        end: stat.size - 1,
        highWaterMark: 64 * 1024,
      });
      for await (const chunk of stream) {
        this.traversal.bytesRead += chunk.length;
        this.database.exec("BEGIN");
        try {
          this.scan(thread, state, chunk as Buffer);
          this.database.exec("COMMIT");
        } catch (error) {
          this.database.exec("ROLLBACK");
          throw error;
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    this.database
      .prepare(
        "INSERT OR REPLACE INTO worktree_logs(thread,bytes,lines,size,mtime,inode,cwd) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        thread.id,
        state.bytes,
        state.lines,
        stat.size,
        stat.mtimeMs,
        String(stat.ino),
        thread.cwd ?? null,
      );
  }

  private scan(
    thread: EvidenceThread,
    state: { bytes: number; lines: number; pending: Buffer; skipped: number },
    chunk: Buffer,
  ) {
    const data = state.pending.length ? Buffer.concat([state.pending, chunk]) : chunk;
    let begin = 0;
    let newline: number;
    while ((newline = data.indexOf(10, begin)) >= 0) {
      const raw = data.subarray(begin, newline);
      state.lines++;
      state.bytes += state.skipped + raw.length + 1;
      this.traversal.eventsRead++;
      if (!state.skipped && raw.length <= MAX_LINE) {
        this.trackLine(thread, state.lines, raw);
      }
      state.skipped = 0;
      begin = newline + 1;
    }
    state.pending = data.subarray(begin);
    if (state.pending.length > MAX_LINE) {
      state.skipped += state.pending.length;
      state.pending = Buffer.alloc(0);
    }
  }

  private trackLine(thread: EvidenceThread, line: number, raw: Buffer) {
    let event: unknown;
    try {
      event = JSON.parse(raw.toString("utf8"));
    } catch {
      return;
    }
    this.track(thread, line, event);
  }
}
