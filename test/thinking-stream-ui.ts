// Browser regression: Claude thinking summaries stream into an open live box, then settle into one collapsed Reasoning box.
// Run: rtk test node test/thinking-stream-ui.ts   Screenshots: /tmp/ac-518/
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Browser, chromium, type Page } from "playwright";
import { MOCK_THINKING } from "../server/providers/mock.ts";

const base = "http://127.0.0.1:7518";
const shots = "/tmp/ac-518";
const data = fs.mkdtempSync(path.join(os.tmpdir(), "ac-thinking-data-"));
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ac-thinking-cwd-"));
const thread = {
  id: "55555555-5555-4555-8555-555555555518",
  provider: "mock",
  model: "echo",
  effort: "medium",
  mode: "plan",
  title: "Thinking fixture",
  cwd,
  status: "idle",
  cost: 0,
  createdAt: 1,
  updatedAt: 1,
};
fs.mkdirSync(path.join(data, "logs"), { recursive: true });
fs.mkdirSync(shots, { recursive: true });
fs.writeFileSync(path.join(data, "threads.json"), JSON.stringify([thread]));
fs.writeFileSync(path.join(data, "commands.json"), "{}");
process.env.AGENT_CONSOLE_DATA = data;
const { makeToken } = await import("../server/auth.ts");
const session = makeToken();
const server = spawn(process.execPath, ["server/index.ts"], {
  env: {
    ...process.env,
    PORT: "7518",
    AGENT_CONSOLE_DATA: data,
    AGENT_CONSOLE_RUN: path.join(data, "run"),
    AGENT_CONSOLE_PID_FILE: "",
    AGENT_CONSOLE_AUTH: "password",
    AGENT_CONSOLE_MOCK: "1",
    AGENT_CONSOLE_HEADROOM: "0",
    AGENT_CONSOLE_LABELS: "0",
    AGENT_CONSOLE_ENV_FILES: "/dev/null",
  },
  stdio: ["ignore", "ignore", "pipe"],
});
let serverError = "";
server.stderr.on("data", (bytes) => {
  serverError += String(bytes);
});

const waitForServer = () =>
  new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 60_000;
    const probe = async () => {
      if (server.exitCode !== null)
        return reject(new Error(`scratch server exited: ${serverError}`));
      try {
        if ((await fetch(`${base}/login`)).ok) return resolve();
      } catch {}
      if (Date.now() > deadline)
        return reject(new Error(`scratch startup timed out: ${serverError}`));
      setTimeout(probe, 100);
    };
    void probe();
  });

const openPage = async (browser: Browser, width: number, height: number) => {
  const context = await browser.newContext({
    serviceWorkers: "block",
    viewport: { width, height },
  });
  await context.addCookies([
    { name: "__Host-ac_session", value: session, domain: "127.0.0.1", path: "/", secure: true },
  ]);
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  await page.goto(base);
  await page.waitForFunction(
    () => document.getElementById("input")?.getAttribute("aria-disabled") !== "true",
  );
  return page;
};

const send = async (page: Page, text: string) => {
  await page.locator("#input").fill(text);
  await page.click("#send");
};

const liveLength = (page: Page) =>
  page.evaluate(
    () => document.querySelector(".msg.think.live[open] .think-body")?.textContent?.length ?? -1,
  );

const noOverflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

const assertSettled = async (page: Page, label: string) => {
  await page.waitForSelector(".msg.think:not(.live)");
  assert.equal(await page.locator(".msg.think.live").count(), 0, `${label}: no live box left`);
  assert.equal(await page.locator("details.msg.think").count(), 1, `${label}: one reasoning box`);
  assert.equal(
    await page.locator("details.msg.think:not([open])").count(),
    1,
    `${label}: reasoning box is collapsed`,
  );
  assert.equal(await page.locator("details.msg.think .think-body").textContent(), MOCK_THINKING);
};

let browser: Browser | undefined;
try {
  await waitForServer();
  browser = await chromium.launch();
  const mobile = await openPage(browser, 390, 844);
  await send(mobile, "think: plan it");
  await mobile.waitForSelector(".msg.think.live[open] .think-body");
  await mobile.waitForFunction(() => {
    const text = document.querySelector(".msg.think.live .think-body")?.textContent ?? "";
    return text.length > 10;
  });
  const first = await liveLength(mobile);
  await mobile.waitForFunction((before) => {
    const body = document.querySelector(".msg.think.live .think-body");
    return (body?.textContent?.length ?? 0) > before;
  }, first);
  assert.ok((await liveLength(mobile)) > first, "live thinking text grows while streaming");
  assert.ok(await noOverflow(mobile), "no horizontal overflow while live at 390x844");
  await mobile.screenshot({ path: path.join(shots, "thinking-live-mobile.png") });

  await assertSettled(mobile, "after result");
  assert.ok(await noOverflow(mobile), "no horizontal overflow when settled at 390x844");
  await mobile.screenshot({ path: path.join(shots, "thinking-done-mobile.png") });

  await mobile.reload();
  await mobile.waitForSelector("details.msg.think");
  await assertSettled(mobile, "after reload");
  assert.ok(await noOverflow(mobile), "no horizontal overflow after reload at 390x844");

  const desktop = await openPage(browser, 1280, 800);
  await send(desktop, "think: again");
  await desktop.waitForSelector(".msg.think.live[open] .think-body");
  await desktop.waitForFunction(
    () => (document.querySelector(".msg.think.live .think-body")?.textContent?.length ?? 0) > 10,
  );
  await desktop.screenshot({ path: path.join(shots, "thinking-live-desktop.png") });
  console.log(
    "PASS  thinking-stream-ui: live open box grows, settles collapsed once, survives reload, no overflow",
  );
} finally {
  await browser?.close();
  server.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    if (server.exitCode !== null) resolve();
    else server.once("exit", () => resolve());
  });
  fs.rmSync(data, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
}
