import type { BlackboxEvent, Recording, WrapModelOptions } from "./types.js";
import { installNetworkGuard } from "./network-guard.js";
import { requireText } from "./agent.js";
import type { Session } from "./session.js";

interface ToolPlayback {
  name: string;
  output: unknown;
  isError: boolean;
}

export class Replay {
  readonly session: Session;
  private readonly responses: unknown[];
  private readonly tools: ToolPlayback[];

  constructor(session: Session, recording: Recording) {
    this.session = session;
    this.session.enterReplay();
    this.responses = recording.events
      .filter((event) => event.type === "model.response")
      .map((event) => event.data.output);
    this.tools = toolPlaybacks(recording.events);
  }

  wrapModel<TInput, TResult>(
    _model: (input: TInput) => TResult,
    options: WrapModelOptions = {},
  ): (input: TInput) => TResult {
    return ((input: TInput) => {
      const output = this.responses.shift();
      if (output === undefined) {
        this.session.recordReplayError("no recorded model response remains", "ReplayExhausted");
        const error = new Error("no recorded model response remains");
        error.name = "ReplayExhausted";
        throw error;
      }
      this.session.setOrigin("generated");
      const request = this.session.recordModelRequest({
        provider: options.provider,
        model: options.model,
        input,
      });
      this.session.setOrigin("replayed");
      try {
        this.session.recordModelResponse({ output, parentEventId: request.id });
        return output as TResult;
      } finally {
        this.session.setOrigin("generated");
      }
    }) as (input: TInput) => TResult;
  }

  wrapTool<TResult>(name: string, tool: () => TResult): () => TResult;
  wrapTool<TArgs, TResult>(name: string, tool: (args: TArgs) => TResult): (args: TArgs) => TResult;
  wrapTool(name: string, tool: (args?: unknown) => unknown): (args?: unknown) => unknown {
    const toolName = requireText(name, "name");
    return (args?: unknown) => {
      const index = this.tools.findIndex((toolPlayback) => toolPlayback.name === toolName);
      const next = index < 0 ? undefined : this.tools.splice(index, 1)[0];
      if (next) {
        this.session.setOrigin("replayed");
        try {
          const call = this.session.recordToolCall({ name: toolName, arguments: args });
          const callId = typeof call.data.callId === "string" ? call.data.callId : undefined;
          this.session.recordToolResult({
            callId,
            output: next.output,
            isError: next.isError,
            parentEventId: call.id,
          });
          if (next.isError) {
            throw new Error(typeof next.output === "string" ? next.output : "recorded tool failed");
          }
          return next.output;
        } finally {
          this.session.setOrigin("generated");
        }
      }
      this.session.setOrigin("generated");
      const wrapped = this.session.wrapTool(toolName, (value: unknown) => tool(value));
      return wrapped(args);
    };
  }

  async run<T>(fn: (replay: Replay) => Promise<T> | T): Promise<T> {
    const restore = installNetworkGuard(() => {
      this.session.recordReplayError("replay blocked a network call", "ReplayNetworkBlocked");
    });
    try {
      return await fn(this);
    } finally {
      restore();
    }
  }
}

function toolPlaybacks(events: BlackboxEvent[]): ToolPlayback[] {
  const names = new Map<string, string>();
  for (const event of events) {
    if (event.type !== "tool.call" || typeof event.data.name !== "string") continue;
    names.set(event.id, event.data.name);
    if (typeof event.data.callId === "string") names.set(event.data.callId, event.data.name);
  }
  const results: ToolPlayback[] = [];
  for (const event of events) {
    if (event.type !== "tool.result") continue;
    const callId = typeof event.data.callId === "string" ? event.data.callId : undefined;
    const name = (callId ? names.get(callId) : undefined) ?? (event.parentEventId ? names.get(event.parentEventId) : undefined);
    if (!name) continue;
    results.push({ name, output: event.data.output, isError: event.data.isError === true });
  }
  return results;
}
