export type WorktreeEvidence = {
  kind: "create" | "use" | "ambiguous";
  path: string;
  repo?: string;
  thread: string;
  line: number;
  resultLine?: number;
  toolId?: string;
};
export type WorktreeEvidenceSnapshot = {
  stale: boolean;
  version: string;
  entries: WorktreeEvidence[];
  traversal: { logsRead: number; bytesRead: number; eventsRead: number };
};
export type WorktreeThread = {
  id: string;
  archived: boolean;
  cwd: string;
  status: string;
};
export type WorktreeContext = {
  threads: WorktreeThread[];
  evidence: WorktreeEvidenceSnapshot;
};
export type WorktreeCaller = { id: string; issueRun?: unknown; archived?: boolean };
export type WorktreeJob = {
  job: string;
  action: "preview" | "apply";
  status: "queued" | "running" | "complete" | "incomplete" | "failed";
  plan?: string;
  counts: {
    total: number;
    eligible: number;
    skipped: number;
    backedUp: number;
    removed: number;
    failed: number;
  };
  rows: Array<{
    path: string;
    eligible: boolean;
    reason: string;
    dirty?: boolean;
    backup?: string;
  }>;
  report?: string;
  next: string;
};
export type WorktreeCleanupOptions = {
  dataDir: string;
  home: string;
  stateDir: string;
  getThreads: () => WorktreeThread[];
  evidence: () => Promise<WorktreeEvidenceSnapshot>;
};
