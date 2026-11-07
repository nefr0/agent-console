import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

/** CLI-only guard installed before importing the provider's named spawn binding. */
export function guardProcesses(onLimit: () => void, maxBytes: number) {
  const original = childProcess.spawn;
  const children = new Set<ReturnType<typeof original>>();
  const closed: Promise<void>[] = [];
  childProcess.spawn = ((command: string, args: string[], options: any) => {
    const child = original(command, args, { ...options, detached: true });
    children.add(child);
    closed.push(new Promise((resolve) => child.once("close", () => resolve())));
    let bytes = 0;
    const account = (chunk: string | Buffer) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes <= maxBytes) return;
      child.stdout?.removeAllListeners("data");
      child.stderr?.removeAllListeners("data");
      child.kill("SIGKILL");
      onLimit();
    };
    child.stdout?.on("data", account);
    child.stderr?.on("data", account);
    return child;
  }) as typeof childProcess.spawn;
  syncBuiltinESMExports();
  return async () => {
    let deadline: NodeJS.Timeout | undefined;
    try {
      for (const child of children) {
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {}
      }
      await Promise.race([
        Promise.all(closed),
        new Promise<void>((resolve) => {
          deadline = setTimeout(resolve, 500);
        }),
      ]);
    } finally {
      clearTimeout(deadline);
      for (const child of children) {
        child.stdin?.destroy();
        child.stdout?.destroy();
        child.stderr?.destroy();
      }
      childProcess.spawn = original;
      syncBuiltinESMExports();
    }
  };
}
