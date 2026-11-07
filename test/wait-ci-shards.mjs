import { setTimeout as delay } from "node:timers/promises";

const attempt = Number(process.env.GITHUB_RUN_ATTEMPT || 1);
const api = `${process.env.GITHUB_API_URL}/repos/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`;
const headers = { authorization: `Bearer ${process.env.GH_TOKEN}` };
const deadline = Date.now() + 120_000;

// A partial rerun starts only the failed shards, so count the shard jobs of this attempt.
async function expectedShards() {
  const response = await fetch(`${api}/attempts/${attempt}/jobs?per_page=100`, {
    headers,
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Cannot list shard jobs: HTTP ${response.status}`);
  const { jobs } = await response.json();
  return jobs.filter((job) => job.name.startsWith("test-shard") && job.run_attempt === attempt)
    .length;
}

let count;
try {
  count = await expectedShards();
  if (!count) throw new Error("No test-shard jobs found for this attempt");
} catch (error) {
  if (attempt <= 1) throw error;
  console.warn(`Skipping shard alignment on rerun attempt ${attempt}: ${error.message}`);
  process.exit(0);
}

while (Date.now() < deadline) {
  const response = await fetch(`${api}/artifacts?per_page=100`, {
    headers,
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Cannot check shard readiness: HTTP ${response.status}`);
  const { artifacts } = await response.json();
  const ready = artifacts.filter(
    (artifact) => !artifact.expired && artifact.name.startsWith(process.env.READY_PREFIX),
  );
  if (ready.length === count) {
    console.log(`All ${count} runners are ready; starting the test windows.`);
    process.exit(0);
  }
  await delay(1000);
}
throw new Error(
  `All ${count} CI runners must finish setup within 120 seconds of the first ready runner.`,
);
