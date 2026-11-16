import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { normalizeAgent, requireText } from "./agent.js";
import { collectGitStatus } from "./git-status.js";
import { installHttpCapture } from "./http-capture.js";
import { startRecordingProxy } from "./proxy.js";
import type { HttpHooks } from "./protocol.js";
import { diffSnapshots, snapshotDirectory, type FileStamp } from "./snapshot.js";
import { installChildProcessCapture, type RecordedProcesses } from "./spawn-capture.js";
import type { SessionStore } from "./store.js";
import type {
  AgentCompletionInput,
  AgentInfo,
  AssistantMessageInput,
  BlackboxEvent,
  CustomEventInput,
  ErrorInput,
  EventSource,
  FaultInjection,
  FinishInput,
  ModelRequestInput,
  ModelResponseInput,
  RetryInput,
  RunWithRetryOptions,
  SessionHeader,
  ToolCallInput,
  ToolResultInput,
  UserMessageInput,
  WrapModelOptions,
} from "./types.js";

export class Session {
  readonly id: string;
  private closed = false;
  private finishEvent: BlackboxEvent | null = null;
  private lastErrorEventId: string | undefined;
  private readonly agents: AgentInfo[];
  private readonly toolCalls = new Map<string, string>();
  private readonly completionCounts = new Map<string, number>();
  private readonly faults: FaultInjection[] = [];
  private readonly snapshots: { root: string; files: Map<string, FileStamp> }[] = [];
  private restoreHttp: (() => void) | undefined;
  private restoreSpawn: (() => void) | undefined;
  private flushSpawn: (() => void) | undefined;
  private processApi: RecordedProcesses | undefined;
  private closeProxy: (() => void) | undefined;
  private proxyInfo: { port: number; url: string } | undefined;
  private forcedSource: EventSource | undefined;
  private origin: "replayed" | "generated" | undefined;

  constructor(
    private readonly store: SessionStore,
    private readonly header: SessionHeader,
  ) {
    this.id = header.id;
    this.agents = [header.agent];
  }

  recordUserMessage(input: UserMessageInput): BlackboxEvent {
    return this.record(
      "user.message",
      { content: requireText(input.content, "content") },
      input.parentEventId,
    );
  }

  recordAssistantMessage(input: AssistantMessageInput): BlackboxEvent {
    return this.record(
      "assistant.message",
      { content: requireText(input.content, "content") },
      input.parentEventId,
    );
  }

  recordModelRequest(input: ModelRequestInput): BlackboxEvent {
    return this.record(
      "model.request",
      {
        provider: optionalText(input.provider, "provider"),
        model: optionalText(input.model, "model"),
        input: requireValue(input.input, "input"),
      },
      input.parentEventId,
    );
  }

  recordModelResponse(input: ModelResponseInput): BlackboxEvent {
    return this.record(
      "model.response",
      { output: requireValue(input.output, "output") },
      input.parentEventId,
    );
  }

  recordToolCall(input: ToolCallInput): BlackboxEvent {
    const callId = input.callId === undefined ? randomUUID() : requireText(input.callId, "callId");
    const event = this.record(
      "tool.call",
      {
        name: requireText(input.name, "name"),
        callId,
        arguments: input.arguments,
      },
      input.parentEventId,
    );
    this.toolCalls.set(callId, event.id);
    return event;
  }

  recordToolResult(input: ToolResultInput): BlackboxEvent {
    if (input.isError !== undefined && typeof input.isError !== "boolean") {
      throw new Error("isError must be a boolean");
    }
    const callId = optionalText(input.callId, "callId");
    const parentEventId = optionalParent(input.parentEventId) ?? (callId ? this.toolCalls.get(callId) : undefined);
    return this.record(
      "tool.result",
      {
        callId,
        output: requireValue(input.output, "output"),
        isError: input.isError ?? false,
      },
      parentEventId,
    );
  }

  recordError(input: ErrorInput): BlackboxEvent {
    const event = this.record(
      "error",
      {
        message: requireText(input.message, "message"),
        name: optionalText(input.name, "name"),
        details: input.details,
      },
      input.parentEventId,
    );
    this.lastErrorEventId = event.id;
    return event;
  }

  recordRetry(input: RetryInput): BlackboxEvent {
    if (!Number.isInteger(input.attempt) || input.attempt < 1) {
      throw new Error("attempt must be an integer starting at 1");
    }
    return this.record(
      "retry",
      {
        attempt: input.attempt,
        reason: requireText(input.reason, "reason"),
      },
      input.parentEventId,
    );
  }

  recordCustom(input: CustomEventInput): BlackboxEvent {
    return this.record(
      "custom",
      {
        name: requireText(input.name, "name"),
        data: input.data,
      },
      input.parentEventId,
    );
  }

  wrapModel<TInput, TResult>(
    model: (input: TInput) => TResult,
    options: WrapModelOptions = {},
  ): (input: TInput) => TResult {
    return ((input: TInput) => {
      const fault = this.takeFault("model", options.model);
      if (fault) this.raiseFault(fault);
      const request = this.recordModelRequest({
        provider: options.provider,
        model: options.model,
        input,
      });
      try {
        const returned = model(input);
        if (isAsyncIterable(returned)) {
          return this.iterateStream(returned, request.id) as TResult;
        }
        if (isPromise(returned)) {
          return returned.then(
            (value) => {
              if (isAsyncIterable(value)) return this.iterateStream(value, request.id);
              this.recordModelResponse({ output: value, parentEventId: request.id });
              return value;
            },
            (error: unknown) => {
              this.recordThrown(error, request.id);
              throw error;
            },
          ) as TResult;
        }
        this.recordModelResponse({ output: returned, parentEventId: request.id });
        return returned;
      } catch (error) {
        this.recordThrown(error, request.id);
        throw error;
      }
    }) as (input: TInput) => TResult;
  }

  wrapTool<TResult>(name: string, tool: () => TResult): () => TResult;
  wrapTool<TArgs, TResult>(name: string, tool: (args: TArgs) => TResult): (args: TArgs) => TResult;
  wrapTool(name: string, tool: (args?: unknown) => unknown): (args?: unknown) => unknown {
    const toolName = requireText(name, "name");
    return (args?: unknown) => {
      const fault = this.takeFault("tool", toolName);
      if (fault) this.raiseFault(fault);
      const call = this.recordToolCall({ name: toolName, arguments: args });
      const callId = typeof call.data.callId === "string" ? call.data.callId : undefined;
      const settle = (output: unknown, isError: boolean) => {
        this.recordToolResult({ callId, output, isError, parentEventId: call.id });
      };
      try {
        const returned = tool(args);
        if (isPromise(returned)) {
          return returned.then(
            (output) => {
              settle(output, false);
              return output;
            },
            (error: unknown) => {
              settle(thrownMessage(error), true);
              this.recordThrown(error, call.id);
              throw error;
            },
          );
        }
        settle(returned, false);
        return returned;
      } catch (error) {
        settle(thrownMessage(error), true);
        this.recordThrown(error, call.id);
        throw error;
      }
    };
  }

  async runWithRetry<T>(fn: () => Promise<T> | T, options: RunWithRetryOptions): Promise<T> {
    if (!Number.isInteger(options.attempts) || options.attempts < 1) {
      throw new Error("attempts must be an integer starting at 1");
    }
    const reason = requireText(options.reason, "reason");
    let lastError: unknown;
    for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
      const errorBefore = this.lastErrorEventId;
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        const parentEventId = this.lastErrorEventId !== errorBefore ? this.lastErrorEventId : this.recordThrown(error).id;
        if (attempt === options.attempts) break;
        this.recordRetry({ attempt: attempt + 1, reason, parentEventId });
      }
    }
    throw lastError;
  }

  complete(input: AgentCompletionInput = {}): BlackboxEvent {
    const status = input.status ?? "completed";
    if (status !== "completed" && status !== "failed") {
      throw new Error("status must be completed or failed");
    }
    const agent = this.currentAgent();
    const event = this.record("agent.completed", {
      agent,
      status,
      summary: input.summary,
    });
    this.completionCounts.set(agent.id, (this.completionCounts.get(agent.id) ?? 0) + 1);
    return event;
  }

  async handoff<T>(input: {
    agent: AgentInfo;
    task?: string;
    run: (session: Session) => Promise<T> | T;
  }): Promise<T> {
    const agent = normalizeAgent(input.agent);
    const handoff = this.record("agent.handoff", {
      agent,
      task: optionalText(input.task, "task"),
    });
    this.agents.push(agent);
    const completionsBefore = this.completionCounts.get(agent.id) ?? 0;
    try {
      const result = await input.run(this);
      this.recordChildCompletion(agent, "completed", handoff.id, completionsBefore);
      return result;
    } catch (error) {
      this.recordThrown(error, handoff.id);
      this.recordChildCompletion(agent, "failed", handoff.id, completionsBefore);
      throw error;
    } finally {
      this.agents.pop();
    }
  }

  captureHttp(): void {
    this.assertOpen();
    if (this.restoreHttp) return;
    this.restoreHttp = installHttpCapture(this.id, this.protocolHooks());
  }

  async openProxy(): Promise<{ port: number; url: string }> {
    this.assertOpen();
    if (this.proxyInfo) return this.proxyInfo;
    const proxy = await startRecordingProxy(this.protocolHooks());
    this.proxyInfo = { port: proxy.port, url: proxy.url };
    this.closeProxy = proxy.close;
    return this.proxyInfo;
  }

  wrapMcp<T extends object>(client: T): T {
    this.assertOpen();
    const session = this;
    return new Proxy(client, {
      get(target, prop, receiver) {
        const value: unknown = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") return value;
        if (prop === "request") {
          return (method: unknown, params?: unknown) =>
            session.captureMcp("mcp.request", "mcp.response", { method, params }, () =>
              (value as (method: unknown, params?: unknown) => unknown).call(target, method, params),
            );
        }
        if (prop === "callTool") {
          return (name: unknown, args?: unknown) =>
            session.captureMcp(
              "mcp.request",
              "mcp.response",
              { method: "tools/call", name, arguments: args },
              () => (value as (name: unknown, args?: unknown) => unknown).call(target, name, args),
            );
        }
        return (value as (...args: unknown[]) => unknown).bind(target);
      },
    });
  }

  watchDirectory(root: string): void {
    this.assertOpen();
    const resolved = path.resolve(requireText(root, "root"));
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new Error("watchDirectory requires a directory");
    }
    this.snapshots.push({ root: resolved, files: snapshotDirectory(resolved) });
  }

  wrapSpawn(): RecordedProcesses {
    this.assertOpen();
    if (!this.processApi) {
      const capture = installChildProcessCapture(this.id, (info) => {
        if (this.closed) return;
        this.record(
          "environment.process",
          {
            command: info.command,
            args: info.args,
            exitCode: info.exitCode,
            durationMs: info.durationMs,
          },
          undefined,
          "environment",
        );
      });
      this.processApi = capture.api;
      this.restoreSpawn = capture.restore;
      this.flushSpawn = capture.flush;
    }
    return this.processApi;
  }

  injectFault(input: FaultInjection): void {
    this.assertOpen();
    if (input.target !== "tool" && input.target !== "model") {
      throw new Error("target must be tool or model");
    }
    this.faults.push({
      target: input.target,
      name: requireText(input.name, "name"),
      message: requireText(input.message, "message"),
    });
  }

  enterReplay(): void {
    this.forcedSource = "replay";
    this.origin = "generated";
  }

  setOrigin(origin: "replayed" | "generated"): void {
    this.origin = this.forcedSource === "replay" ? origin : undefined;
  }

  recordReplayError(message: string, name: string): BlackboxEvent {
    return this.recordError({ message, name });
  }

  finish(input: FinishInput = {}): void {
    if (this.closed) {
      throw new Error(`Session ${this.id} is already finished`);
    }
    const status = input.status ?? "completed";
    if (status !== "completed" && status !== "failed") {
      throw new Error("status must be completed or failed");
    }

    try {
      this.recordEnvironment();
      this.flushSpawn?.();
    } finally {
      this.restoreCaptures();
    }

    if (!this.finishEvent) {
      this.finishEvent = this.record("session.finished", {
        status,
        summary: input.summary,
      });
    }

    const storedSummary = typeof this.finishEvent.data.summary === "string" ? this.finishEvent.data.summary : null;
    const recordedStatus = this.finishEvent.data.status === "failed" ? "failed" : "completed";
    this.store.finalize(this.id, recordedStatus, storedSummary);
    this.closed = true;
  }

  private record(
    type: string,
    data: Record<string, unknown>,
    parentEventId?: string,
    source?: EventSource,
  ): BlackboxEvent {
    this.assertOpen();
    const payload = { ...data };
    if (this.origin !== undefined && payload.origin === undefined) payload.origin = this.origin;
    return this.store.append(this.id, {
      type,
      agentId: this.currentAgent().id,
      parentEventId: optionalParent(parentEventId),
      data: payload,
      source: source ?? this.forcedSource ?? "integration",
    });
  }

  private assertOpen(): void {
    if (this.closed || this.finishEvent) {
      throw new Error(`Session ${this.id} is already finished`);
    }
  }

  private currentAgent(): AgentInfo {
    return this.agents[this.agents.length - 1] ?? this.header.agent;
  }

  private async *iterateStream(source: AsyncIterable<unknown>, parentEventId: string): AsyncGenerator<unknown> {
    const parts: unknown[] = [];
    let index = 0;
    let state: "open" | "done" | "failed" = "open";
    try {
      for await (const chunk of source) {
        parts.push(chunk);
        this.record("model.stream.delta", { index, delta: chunk }, parentEventId);
        index += 1;
        yield chunk;
      }
      state = "done";
      this.recordModelResponse({ output: assembleStream(parts), parentEventId });
    } catch (error) {
      state = "failed";
      this.recordThrown(error, parentEventId);
      throw error;
    } finally {
      if (state === "open") {
        this.recordError({
          message: "model stream ended before completion",
          name: "StreamClosed",
          parentEventId,
        });
      }
    }
  }

  private recordChildCompletion(
    agent: AgentInfo,
    status: "completed" | "failed",
    parentEventId: string,
    completionsBefore: number,
  ): void {
    if ((this.completionCounts.get(agent.id) ?? 0) !== completionsBefore) return;
    this.record("agent.completed", { agent, status }, parentEventId);
  }

  private protocolHooks(): HttpHooks {
    return {
      record: (type, data, parentEventId) => this.record(type, data, parentEventId, "protocol"),
      fail: (error, parentEventId) => {
        const event = this.record(
          "error",
          { message: thrownMessage(error), name: thrownName(error) },
          parentEventId,
          "protocol",
        );
        this.lastErrorEventId = event.id;
      },
    };
  }

  private captureMcp(
    requestType: string,
    responseType: string,
    data: Record<string, unknown>,
    run: () => unknown,
  ): unknown {
    const request = this.record(requestType, data, undefined, "protocol");
    try {
      const returned = run();
      if (isPromise(returned)) {
        return returned.then(
          (output) => {
            this.record(responseType, { output }, request.id, "protocol");
            return output;
          },
          (error: unknown) => {
            this.protocolHooks().fail(error, request.id);
            throw error;
          },
        );
      }
      this.record(responseType, { output: returned }, request.id, "protocol");
      return returned;
    } catch (error) {
      this.protocolHooks().fail(error, request.id);
      throw error;
    }
  }

  private recordEnvironment(): void {
    const watched = this.snapshots.splice(0);
    let gitMissing = false;
    for (const directory of watched) {
      for (const change of diffSnapshots(directory.files, snapshotDirectory(directory.root))) {
        this.record(
          "environment.file",
          { path: change.path, action: change.action, bytes: change.bytes },
          undefined,
          "environment",
        );
      }
      const git = collectGitStatus(directory.root);
      if (!git.available) gitMissing = true;
      else {
        this.record(
          "environment.git",
          { paths: git.paths, summary: git.inside ? git.summary : "not a git repository" },
          undefined,
          "environment",
        );
      }
    }
    if (gitMissing) {
      this.record(
        "error",
        { message: "git is not available", name: "GitUnavailable" },
        undefined,
        "environment",
      );
    }
  }

  private restoreCaptures(): void {
    const restores = [this.restoreHttp, this.restoreSpawn, this.closeProxy];
    this.restoreHttp = undefined;
    this.restoreSpawn = undefined;
    this.flushSpawn = undefined;
    this.processApi = undefined;
    this.closeProxy = undefined;
    this.proxyInfo = undefined;
    for (const restore of restores) {
      if (!restore) continue;
      try {
        restore();
      } catch {
        continue;
      }
    }
  }

  private takeFault(target: FaultInjection["target"], name: string | undefined): FaultInjection | undefined {
    const index = this.faults.findIndex((fault) => fault.target === target && fault.name === name);
    if (index < 0) return undefined;
    return this.faults.splice(index, 1)[0];
  }

  private raiseFault(fault: FaultInjection): never {
    this.record("fault.injected", { target: fault.target, name: fault.name, message: fault.message });
    throw new Error(fault.message);
  }

  private recordThrown(error: unknown, parentEventId?: string): BlackboxEvent {
    return this.recordError({
      message: thrownMessage(error),
      name: thrownName(error),
      parentEventId,
    });
  }
}

function optionalText(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  return requireText(value, label);
}

function optionalParent(value: string | undefined): string | undefined {
  return optionalText(value, "parentEventId");
}

function requireValue(value: unknown, label: string): unknown {
  if (value === undefined) throw new Error(`${label} is required`);
  return value;
}

function isPromise(value: unknown): value is Promise<unknown> {
  return typeof value === "object" && value !== null && typeof (value as Promise<unknown>).then === "function";
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === "object" && value !== null && Symbol.asyncIterator in value;
}

function assembleStream(parts: unknown[]): unknown {
  if (parts.every((part) => typeof part === "string")) return parts.join("");
  return parts;
}

function thrownMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== "") return error.message;
  return "Unknown error";
}

function thrownName(error: unknown): string | undefined {
  if (error instanceof Error && error.name.trim() !== "") return error.name;
  return undefined;
}
