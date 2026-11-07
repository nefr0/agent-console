export class EvaluationTrace {
  steps: any[];
  calls = new Map<string, any>();
  answer = "";
  model: string;
  usage: Record<string, number> = {};
  constructor(prompt: string, model: string) {
    this.model = model;
    this.steps = [{ step_id: 1, source: "user", message: prompt }];
  }
  step(message: string) {
    const step = { step_id: this.steps.length + 1, source: "agent", message };
    this.steps.push(step);
    return step;
  }
  event(event: any) {
    if (event.parent_tool_use_id) return;
    if (event.type === "system" && typeof event.model === "string") this.model = event.model;
    if (event.type === "token_usage") {
      for (const name of [
        "input_tokens",
        "output_tokens",
        "cached_input_tokens",
        "reasoning_output_tokens",
      ])
        if (Number.isFinite(event[name])) this.usage[name] = Math.max(0, event[name]);
    }
    for (const block of event.message?.content ?? []) this.block(block, event.type);
  }
  block(block: any, type: string) {
    if (type === "assistant" && block.type === "text") {
      this.step(block.text);
      this.answer += block.text;
    } else if (type === "assistant" && block.type === "tool_use") {
      const step: any = this.step("");
      step.tool_calls = [
        { tool_call_id: block.id, function_name: block.name, arguments: block.input ?? {} },
      ];
      this.calls.set(block.id, step);
    } else if (type === "user" && block.type === "tool_result") {
      this.observation(block);
    }
  }
  observation(block: any) {
    const step = this.calls.get(block.tool_use_id);
    if (!step) return;
    step.observation = {
      results: [
        {
          source_call_id: block.tool_use_id,
          content:
            typeof block.content === "string" ? block.content : JSON.stringify(block.content),
        },
      ],
    };
  }
  trajectory(commit: string, effort: string) {
    return {
      schema_version: "ATIF-v1.8",
      agent: { name: "agent-console-codex-provider", version: commit, model_name: this.model },
      steps: this.steps,
      final_metrics: {
        ...(this.usage.input_tokens !== undefined
          ? { total_prompt_tokens: this.usage.input_tokens }
          : {}),
        ...(this.usage.output_tokens !== undefined
          ? { total_completion_tokens: this.usage.output_tokens }
          : {}),
        ...(this.usage.cached_input_tokens !== undefined
          ? { total_cached_tokens: this.usage.cached_input_tokens }
          : {}),
        total_steps: this.steps.length,
      },
      extra: { effort, scope: "codex-provider-layer" },
    };
  }
}
