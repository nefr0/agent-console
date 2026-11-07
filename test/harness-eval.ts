import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "harness-eval-test-"));
const script = path.resolve("scripts/harness-eval.ts");
const host = path.join(scratch, "host");
const binary = path.join(scratch, "bin");
fs.mkdirSync(binary);
fs.mkdirSync(host);
fs.mkdirSync(path.join(host, ".codex"));
fs.writeFileSync(path.join(host, ".codex", "config.toml"), "production-secret-sentinel");
fs.writeFileSync(path.join(scratch, "env"), "ANTHROPIC_API_KEY=production-secret-sentinel");
fs.writeFileSync(
  path.join(binary, "codex"),
  `#!${process.execPath}
const fs = require('node:fs');
let buffer='', requests=[];
const send=record=>console.log(JSON.stringify(record));
const note=(method,params)=>send({method,params:{threadId:'fixture',...params}});
process.stdin.on('data',chunk=>{buffer+=chunk;let newline;
while((newline=buffer.indexOf('\\n'))>=0){const message=JSON.parse(buffer.slice(0,newline));buffer=buffer.slice(newline+1);requests.push(message);
if(message.method==='initialize') send({id:message.id,result:{}});
if(message.method==='thread/start') send({id:message.id,result:{thread:{id:'fixture'},model:'resolved-fixture'}});
if(message.method!=='turn/start')continue;
const prompt=message.params.input[0].text;
fs.writeFileSync('pid-'+prompt,String(process.pid));
send({id:message.id,result:{turn:{id:'turn'}}});
note('turn/started',{turn:{id:'turn'}});
if(prompt==='signal'){process.on('SIGTERM',()=>{});process.on('SIGINT',()=>{});process.kill(process.ppid,'SIGTERM');continue;}
if(prompt==='escaped'){const child=require('node:child_process').spawn(process.execPath,['-e',"setInterval(()=>{},1000)"],{detached:true,stdio:['ignore',1,2]});fs.writeFileSync('escaped-pid',String(child.pid));continue;}
if(prompt==='timeout')continue;
if(prompt==='exit')process.exit(7);
if(prompt==='question'){send({id:900,method:'item/tool/requestUserInput',params:{threadId:'fixture',turnId:'turn',itemId:'ask',questions:[{id:'choice',header:'Choice',question:'Which?',options:[{label:'One',description:'one'},{label:'Two',description:'two'}]}]}});continue;}
if(prompt==='stderr'){process.stderr.write('x'.repeat(2*1024*1024));continue;}
if(prompt==='overflow'){process.stdout.write('x'.repeat(2*1024*1024));continue;}
note('item/started',{item:{id:'command',type:'commandExecution',command:'echo fixture'}});
note('item/completed',{item:{id:'command',type:'commandExecution',command:'echo fixture',aggregatedOutput:'fixture',exitCode:0,status:'completed'}});
const total={inputTokens:100,cachedInputTokens:50,outputTokens:20,totalTokens:120};
const earlier={inputTokens:60,cachedInputTokens:30,outputTokens:10,totalTokens:70};
note('thread/tokenUsage/updated',{tokenUsage:{last:earlier,total:earlier,modelContextWindow:1000}});
note('thread/tokenUsage/updated',{tokenUsage:{last:total,total,modelContextWindow:1000}});
note('item/completed',{item:{id:'answer',type:'agentMessage',text:JSON.stringify({requests,args:process.argv.slice(2),env:process.env,hostConfig:fs.existsSync(process.env.CODEX_HOME+'/config.toml'),pid:process.pid})}});
note('turn/completed',{turn:{id:'turn',status:'completed'}});
}});
`,
  { mode: 0o700 },
);
let sequence = 0;
function run(prompt: string, extra: string[] = []) {
  const output = path.join(scratch, `output-${++sequence}`);
  const promptFile = path.join(scratch, `prompt-${sequence}`);
  fs.writeFileSync(promptFile, prompt);
  const flags = new Map<string, string>();
  for (let index = 0; index < extra.length; index += 2) flags.set(extra[index], extra[index + 1]);
  const execution = spawnSync(
    process.execPath,
    [
      script,
      "--provider",
      flags.get("--provider") ?? "codex",
      "--model",
      flags.get("--model") ?? "fixture-model",
      "--effort",
      "low",
      "--cwd",
      scratch,
      "--prompt-file",
      promptFile,
      "--output-dir",
      output,
      "--timeout-sec",
      "1.5",
    ],
    {
      env: {
        ...process.env,
        PATH: binary + path.delimiter + process.env.PATH,
        HOME: host,
        CODEX_HOME: path.join(host, ".codex"),
        AGENT_CONSOLE_ENV_FILES: path.join(scratch, "env"),
        AGENT_CONSOLE_TOOL_TOKEN: "production-secret-sentinel",
        ANTHROPIC_API_KEY: "production-secret-sentinel",
        OPENAI_BASE_URL: "http://production-secret-sentinel",
        CLAUDE_CONFIG_DIR: host,
        OPENAI_API_KEY: "explicit-openai-fixture",
      },
      encoding: "utf8",
      timeout: 4000,
    },
  );
  assert.equal(execution.error, undefined, String(execution.error));
  const resultFile = path.join(output, "result.json");
  return {
    execution,
    output,
    result: fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, "utf8")) : null,
  };
}
try {
  const success = run("success");
  assert.equal(success.execution.status, 0, success.execution.stderr + success.execution.stdout);
  assert.equal(success.result.status, "completed");
  assert.equal(success.result.task_solved, null);
  assert.equal(success.result.resolved_model, "resolved-fixture");
  assert.deepEqual(success.result.token_usage, {
    input_tokens: 100,
    cached_input_tokens: 50,
    output_tokens: 20,
  });
  const answer = JSON.parse(fs.readFileSync(path.join(success.output, "answer.txt"), "utf8"));
  const thread = answer.requests.find((request: any) => request.method === "thread/start");
  assert.equal(thread.params.model, "fixture-model");
  assert.equal(thread.params.config.model_reasoning_effort, "low");
  assert.ok(thread.params.developerInstructions.includes("# Agent Console"));
  assert.ok(!thread.params.developerInstructions.includes("Shared brain"));
  assert.equal(answer.hostConfig, false);
  assert.equal(answer.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(answer.env.AGENT_CONSOLE_TOOL_TOKEN, undefined);
  assert.equal(answer.env.OPENAI_BASE_URL, undefined);
  assert.equal(answer.env.CLAUDE_CONFIG_DIR, undefined);
  assert.equal(answer.env.OPENAI_API_KEY, "explicit-openai-fixture");
  assert.equal(answer.env.AGENT_CONSOLE_HEADROOM, "0");
  assert.ok(!JSON.stringify(answer).includes("production-secret-sentinel"));
  assert.ok(!answer.args.some((argument: string) => argument.includes("mcp_servers")));
  assert.throws(() => process.kill(answer.pid, 0));
  const trajectory = JSON.parse(
    fs.readFileSync(path.join(success.output, "trajectory.json"), "utf8"),
  );
  assert.equal(trajectory.steps[0].source, "user");
  assert.equal(trajectory.steps[1].tool_calls[0].tool_call_id, "command");
  assert.equal(trajectory.steps[1].observation.results[0].source_call_id, "command");
  assert.equal(trajectory.final_metrics.total_prompt_tokens, 100);
  assert.equal(trajectory.final_metrics.total_cached_tokens, 50);
  for (const [prompt, status] of [
    ["timeout", "timeout"],
    ["exit", "failed"],
    ["question", "needs_input"],
    ["overflow", "failed"],
    ["stderr", "failed"],
    ["signal", "failed"],
    ["escaped", "timeout"],
  ]) {
    const trial = run(prompt);
    assert.equal(
      trial.result?.status,
      status,
      prompt + trial.execution.stderr + trial.execution.stdout,
    );
    assert.notEqual(trial.execution.status, 0);
    if (prompt === "signal") assert.match(trial.result.error, /SIGTERM/);
    if (prompt === "escaped") {
      assert.ok(trial.result.elapsed_ms < 2700, "Cleanup must finish despite retained pipes.");
      const escapedPid = Number(fs.readFileSync(path.join(scratch, "escaped-pid"), "utf8"));
      process.kill(-escapedPid, "SIGKILL");
    }
    const childPid = Number(fs.readFileSync(path.join(scratch, `pid-${prompt}`), "utf8"));
    assert.throws(() => process.kill(childPid, 0));
  }
  for (const extra of [
    ["--provider", "claude"],
    ["--model", "default"],
    ["--provider", "pi"],
  ]) {
    const rejected = run("success", extra);
    assert.equal(rejected.execution.status, 2);
    assert.equal(rejected.result, null);
  }
  console.log(
    "PASS isolated Codex evaluation: protocol, artifacts, ATIF pairing, flags, questions, exits, timeout, output cap and no Claude usage",
  );
} finally {
  const escapedFile = path.join(scratch, "escaped-pid");
  if (fs.existsSync(escapedFile)) {
    try {
      process.kill(-Number(fs.readFileSync(escapedFile, "utf8")), "SIGKILL");
    } catch {}
  }
  fs.rmSync(scratch, { recursive: true, force: true });
}
