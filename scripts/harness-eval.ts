import { HELP, runEvaluation } from "../server/evaluation/run.ts";

if (process.argv.slice(2).includes("--help")) console.log(HELP);
else {
  try {
    const result = await runEvaluation(process.argv.slice(2));
    console.log(JSON.stringify(result));
    process.exitCode = result.status === "completed" ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
