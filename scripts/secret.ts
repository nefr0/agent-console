import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { FILES, fileEnv, parseEnv } from "../server/providers/env.ts";

export const SECRET_USAGE = [
  "secret list                              key names and source file, never values",
  "secret run NAME[,NAME...] -- CMD ARGS    run CMD with only the named keys added to its env",
  "No command prints a value.",
].join("\n");

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function sourceOf(): Map<string, string> {
  const sources = new Map<string, string>();
  for (const file of FILES) {
    try {
      for (const key of Object.keys(parseEnv(fs.readFileSync(file, "utf8")))) sources.set(key, file);
    } catch {}
  }
  return sources;
}

function list(): number {
  const sources = sourceOf();
  for (const key of Object.keys(fileEnv()).sort()) console.log(`${key}\t${sources.get(key) ?? "?"}`);
  return 0;
}

function run(args: string[]): number {
  const split = args.indexOf("--");
  if (split !== 1 || split === args.length - 1) {
    console.error(SECRET_USAGE);
    return 2;
  }
  const names = args[0].split(",").filter(Boolean);
  const values = fileEnv();
  for (const name of names) {
    if (!NAME.test(name) || !(name in values)) {
      console.error(`secret: unknown name ${name}`);
      return 2;
    }
  }
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of names) env[name] = values[name];
  const [cmd, ...rest] = args.slice(split + 1);
  const result = spawnSync(cmd, rest, { env, stdio: "inherit" });
  if (result.error) {
    console.error(`secret: cannot run ${cmd}: ${result.error.message}`);
    return 127;
  }
  return result.status ?? 128;
}

export function main(argv: string[]): number {
  const [command, ...rest] = argv;
  if (command === "list" && rest.length === 0) return list();
  if (command === "run") return run(rest);
  console.log(SECRET_USAGE);
  return command === "--help" || command === "-h" ? 0 : 2;
}

process.exit(main(process.argv.slice(2)));
