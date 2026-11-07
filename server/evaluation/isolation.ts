import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function prepareIsolation() {
  const privateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "console-eval-"));
  const preserved: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "LANG", "LC_ALL", "TZ", "OPENAI_API_KEY"])
    if (process.env[name]) preserved[name] = process.env[name];
  for (const name of Object.keys(process.env)) delete process.env[name];
  Object.assign(process.env, preserved, {
    HOME: privateRoot,
    CODEX_HOME: path.join(privateRoot, "codex"),
    XDG_CONFIG_HOME: path.join(privateRoot, "config"),
    XDG_DATA_HOME: path.join(privateRoot, "data"),
    XDG_CACHE_HOME: path.join(privateRoot, "cache"),
    AGENT_CONSOLE_DATA: path.join(privateRoot, "console-data"),
    AGENT_CONSOLE_RUN: path.join(privateRoot, "run"),
    AGENT_CONSOLE_ENV_FILES: path.join(privateRoot, "absent-env"),
    AGENT_CONSOLE_BRAIN: path.join(privateRoot, "absent-brain"),
    AGENT_CONSOLE_BRAIN_INDEX: path.join(privateRoot, "absent-index"),
    AGENT_CONSOLE_STYLE: path.join(privateRoot, "absent-style"),
    AGENT_CONSOLE_PERSONA_DIR: path.join(privateRoot, "absent-personas"),
    AGENT_CONSOLE_HEADROOM: "0",
  });
  fs.mkdirSync(process.env.CODEX_HOME!, { mode: 0o700 });
  return () => fs.rmSync(privateRoot, { recursive: true, force: true });
}

function within(root: string, target: string) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function validatePaths(cwd: string, output: string, promptFile: string) {
  if (![cwd, output, promptFile].every(path.isAbsolute))
    throw new Error("cwd, output-dir and prompt-file must be absolute paths.");
  const workdir = fs.realpathSync(cwd);
  if (!fs.statSync(workdir).isDirectory()) throw new Error("cwd must be a directory.");
  const home = os.homedir();
  const protectedRoots = ["/", home, path.join(home, "repos", "agent-console")];
  const stores = [
    path.join(home, "repos", "agent-console"),
    process.env.AGENT_CONSOLE_DATA,
    process.env.AGENT_CONSOLE_RUN,
    process.env.CODEX_HOME,
    path.join(home, ".config", "agent-console"),
    path.join(home, ".codex"),
    path.join(home, "repos", "brain"),
  ].filter(Boolean) as string[];
  for (const target of [workdir, path.resolve(output)]) {
    if (protectedRoots.includes(target) || stores.some((store) => within(store, target)))
      throw new Error("Evaluation paths must not target production state.");
  }
  // Resolve existing ancestors before creating anything, so symlinks cannot redirect writes.
  let ancestor = path.resolve(output);
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  if (fs.realpathSync(ancestor) !== ancestor)
    throw new Error("output-dir cannot traverse symlinks.");
  if (fs.existsSync(output) && fs.readdirSync(output).length)
    throw new Error("output-dir must be empty.");
  const prompt = fs.readFileSync(promptFile, "utf8");
  if (!prompt.trim() || Buffer.byteLength(prompt) > 1024 * 1024)
    throw new Error("Prompt must contain 1 byte to 1 MiB of text.");
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  return { workdir, prompt };
}
