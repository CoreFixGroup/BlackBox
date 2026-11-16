import fs from "node:fs";
import path from "node:path";

import { writeJsonAtomic } from "./atomic.js";
import { sessionDirectory } from "./paths.js";
import { writeReport } from "./report.js";
import { SessionStore } from "./store.js";
import type { BlackboxEvent } from "./types.js";

const AGENT = { id: "cursor", name: "Cursor Agent" };
const TEXT_LIMIT = 8000;

interface PendingShell {
  command: string;
  output: string;
  durationMs?: number;
  sandbox: boolean;
  callEventId?: string;
}

interface CursorLink {
  sessionId: string;
  tools: Record<string, string[]>;
  subagents: Record<string, string>;
  shellCalls: string[];
  lastThought?: string;
  pendingShell?: PendingShell;
}
interface CursorMap {
  conversations: Record<string, CursorLink>;
}

export function cursorHookResponse(eventName: string): Record<string, unknown> {
  if (eventName === "") return allowAgent();
  switch (eventName) {
    case "preToolUse":
    case "beforeShellExecution":
    case "beforeMCPExecution":
    case "beforeReadFile":
    case "beforeTabFileRead":
    case "subagentStart":
      return { permission: "allow" };
    case "beforeSubmitPrompt":
      return { continue: true };
    default:
      return {};
  }
}

function allowAgent(): Record<string, unknown> {
  return { permission: "allow", continue: true };
}

export function handleCursorHook(input: unknown, directory: string): Record<string, unknown> {
  const event = asObject(input) ?? {};
  const eventName = text(event.hook_event_name) ?? "";
  try {
    withLock(directory, () => applyHook(event, directory));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`blackbox cursor hook: ${message}\n`);
  }
  return cursorHookResponse(eventName);
}

function applyHook(event: Record<string, unknown>, directory: string): void {
  const eventName = text(event.hook_event_name) ?? "";
  const conversationId = text(event.conversation_id) ?? text(event.session_id);
  if (conversationId === undefined) return;

  const store = openStore(directory);
  const map = readMap(directory);
  let link = map.conversations[conversationId];
  const running = link !== undefined && isRunning(store, link.sessionId);
  if (!running && eventName !== "sessionEnd") {
    link = startCursorSession(store, directory, map, conversationId, event);
  }
  if (link === undefined) return;

  try {
    if (eventName !== "postToolUse" || !isShell(event)) flushPendingShell(store, directory, map, conversationId, link);
    switch (eventName) {
      case "sessionStart":
        return;
      case "beforeSubmitPrompt": {
        const content = clip(text(event.prompt) ?? text(event.text) ?? "");
        if (content.length > 0) {
          store.append(link.sessionId, {
            type: "user.message",
            agentId: AGENT.id,
            data: { content, hook: eventName },
          });
        }
        return;
      }
      case "afterAgentResponse":
        store.append(link.sessionId, {
          type: "assistant.message",
          agentId: AGENT.id,
          data: { content: clip(text(event.text) ?? ""), hook: eventName },
        });
        return;
      case "afterAgentThought":
        recordThought(store, directory, map, conversationId, link, event);
        return;
      case "beforeReadFile":
        recordFileRead(store, link.sessionId, event);
        return;
      case "preToolUse":
        rememberTool(directory, map, conversationId, link, recordToolCall(store, link.sessionId, event));
        return;
      case "postToolUse":
        recordToolResult(store, directory, map, link, event);
        return;
      case "postToolUseFailure":
        store.append(link.sessionId, {
          type: "error",
          agentId: AGENT.id,
          parentEventId: parentTool(link, event),
          data: {
            name: text(event.failure_type) ?? "ToolFailure",
            message: clip(text(event.error_message) ?? "tool failed"),
            hook: eventName,
          },
        });
        return;
      case "afterFileEdit":
        store.append(link.sessionId, {
          type: "tool.call",
          agentId: AGENT.id,
          data: {
            name: "file.edit",
            arguments: { path: text(event.file_path), edits: clipEdits(event.edits) },
            hook: eventName,
          },
        });
        return;
      case "afterShellExecution":
        link.pendingShell = {
          command: clip(text(event.command) ?? ""),
          output: clip(text(event.output) ?? ""),
          durationMs: numberValue(event.duration),
          sandbox: event.sandbox === true,
          callEventId: link.shellCalls.shift(),
        };
        writeMap(directory, map);
        return;
      case "afterMCPExecution":
        store.append(link.sessionId, {
          type: "mcp.response",
          agentId: AGENT.id,
          data: {
            name: text(event.tool_name),
            server: text(event.mcp_server_name),
            input: clipValue(parseMaybe(event.tool_input)),
            output: clipValue(parseMaybe(event.result_json)),
            durationMs: numberValue(event.duration),
            hook: eventName,
          },
        });
        return;
      case "subagentStart": {
        const child = childAgent(event);
        const handoff = store.append(link.sessionId, {
          type: "agent.handoff",
          agentId: AGENT.id,
          data: { agent: child, task: clip(text(event.task) ?? ""), hook: eventName },
        });
        const subagentId = text(event.subagent_id);
        if (subagentId !== undefined) {
          link.subagents[subagentId] = handoff.id;
          writeMap(directory, map);
        }
        return;
      }
      case "subagentStop": {
        const child = childAgent(event);
        const status = event.status === "error" || event.status === "aborted" ? "failed" : "completed";
        const subagentId = text(event.subagent_id);
        store.append(link.sessionId, {
          type: "agent.completed",
          agentId: child.id,
          parentEventId: subagentId === undefined ? undefined : link.subagents[subagentId],
          data: {
            agent: child,
            status,
            summary: clip(text(event.summary) ?? ""),
            hook: eventName,
          },
        });
        return;
      }
      case "preCompact":
        store.append(link.sessionId, {
          type: "custom",
          agentId: AGENT.id,
          data: {
            name: "cursor.compact",
            data: {
              trigger: text(event.trigger),
              contextTokens: numberValue(event.context_tokens),
              contextWindowSize: numberValue(event.context_window_size),
            },
          },
        });
        return;
      case "stop":
        store.append(link.sessionId, {
          type: "custom",
          agentId: AGENT.id,
          data: {
            name: "cursor.turn",
            data: { status: text(event.status), loopCount: numberValue(event.loop_count) },
          },
        });
        return;
      case "sessionEnd":
        finishCursorSession(store, link.sessionId, event);
        return;
      default:
        return;
    }
  } finally {
    refreshReport(store, link.sessionId);
  }
}

function startCursorSession(
  store: SessionStore,
  directory: string,
  map: CursorMap,
  conversationId: string,
  event: Record<string, unknown>,
): CursorLink {
  const version = text(event.cursor_version);
  const header = store.startSession({
    id: cursorSessionId(directory),
    agent: version === undefined ? AGENT : { ...AGENT, version },
    metadata: {
      adapter: "cursor",
      conversationId,
      composerMode: text(event.composer_mode),
      cursorVersion: version,
      workspaceRoots: Array.isArray(event.workspace_roots) ? event.workspace_roots : undefined,
    },
  });
  const link = { sessionId: header.id, tools: {}, subagents: {}, shellCalls: [] as string[] };
  map.conversations[conversationId] = link;
  writeMap(directory, map);
  return link;
}

function finishCursorSession(store: SessionStore, sessionId: string, event: Record<string, unknown>): void {
  const recording = store.readRecording(sessionId);
  if (recording.session.status !== "running") return;
  const reason = text(event.reason) ?? text(event.final_status) ?? text(event.status) ?? "completed";
  const finalStatus = text(event.final_status);
  const status = reason === "error" || reason === "aborted" || finalStatus === "error" || finalStatus === "aborted" ? "failed" : "completed";
  const summary = `Cursor session ${reason}`;
  store.append(sessionId, {
    type: "session.finished",
    agentId: AGENT.id,
    data: { status, summary, hook: "sessionEnd" },
  });
  store.finalize(sessionId, status, summary);
}

function recordFileRead(store: SessionStore, sessionId: string, event: Record<string, unknown>): void {
  const content = typeof event.content === "string" ? event.content : "";
  const filePath = text(event.file_path);
  if (filePath === undefined && content.length === 0) return;
  store.append(sessionId, {
    type: "tool.call",
    agentId: AGENT.id,
    data: {
      name: "file.read",
      arguments: {
        path: filePath,
        byteLength: Buffer.byteLength(content, "utf8"),
        preview: clip(content),
      },
      hook: "beforeReadFile",
    },
  });
}

function recordToolCall(store: SessionStore, sessionId: string, event: Record<string, unknown>): BlackboxEvent {
  return store.append(sessionId, {
    type: "tool.call",
    agentId: AGENT.id,
    data: {
      name: text(event.tool_name) ?? "tool",
      callId: toolCallId(event.tool_use_id),
      arguments: clipValue(event.tool_input),
      note: text(event.agent_message),
      cwd: text(event.cwd),
      hook: "preToolUse",
    },
  });
}

function rememberTool(
  directory: string,
  map: CursorMap,
  conversationId: string,
  link: CursorLink,
  recorded: BlackboxEvent,
): void {
  const id = text(recorded.data.callId);
  if (id !== undefined) {
    const queue = link.tools[id] ?? [];
    queue.push(recorded.id);
    link.tools[id] = queue;
  }
  if (recorded.data.name === "Shell" || recorded.data.name === "shell") link.shellCalls.push(recorded.id);
  map.conversations[conversationId] = link;
  writeMap(directory, map);
}

function parentTool(link: CursorLink, event: Record<string, unknown>): string | undefined {
  const id = toolCallId(event.tool_use_id);
  if (id === undefined) return undefined;
  const queue = link.tools[id];
  if (queue === undefined || queue.length === 0) return undefined;
  return queue.shift();
}

function recordToolResult(
  store: SessionStore,
  directory: string,
  map: CursorMap,
  link: CursorLink,
  event: Record<string, unknown>,
): void {
  const output = clipValue(parseMaybe(event.tool_output));
  const code = exitCodeFrom(output);
  if (isShell(event)) {
    const pending = link.pendingShell;
    store.append(link.sessionId, {
      type: "environment.process",
      agentId: AGENT.id,
      source: "environment",
      parentEventId: pending?.callEventId,
      data: {
        command: pending?.command ?? commandFrom(event),
        args: [],
        exitCode: code,
        durationMs: pending?.durationMs ?? numberValue(event.duration),
        sandbox: pending?.sandbox === true,
        output: pending?.output ?? "",
      },
    });
    link.pendingShell = undefined;
    writeMap(directory, map);
  }
  store.append(link.sessionId, {
    type: "tool.result",
    agentId: AGENT.id,
    parentEventId: parentTool(link, event),
    data: {
      callId: toolCallId(event.tool_use_id),
      output,
      isError: false,
      exitCode: code ?? undefined,
      durationMs: numberValue(event.duration),
      hook: "postToolUse",
    },
  });
  writeMap(directory, map);
}

function recordThought(
  store: SessionStore,
  directory: string,
  map: CursorMap,
  conversationId: string,
  link: CursorLink,
  event: Record<string, unknown>,
): void {
  const byteLength = Buffer.byteLength(text(event.text) ?? "", "utf8");
  const signature = `${text(event.generation_id) ?? ""}:${numberValue(event.duration_ms) ?? ""}:${byteLength}`;
  if (link.lastThought === signature) return;
  link.lastThought = signature;
  map.conversations[conversationId] = link;
  writeMap(directory, map);
  store.append(link.sessionId, {
    type: "custom",
    agentId: AGENT.id,
    data: { name: "cursor.thought", data: { durationMs: numberValue(event.duration_ms), byteLength } },
  });
}

function flushPendingShell(
  store: SessionStore,
  directory: string,
  map: CursorMap,
  conversationId: string,
  link: CursorLink,
): void {
  const pending = link.pendingShell;
  if (pending === undefined) return;
  store.append(link.sessionId, {
    type: "environment.process",
    agentId: AGENT.id,
    source: "environment",
    parentEventId: pending.callEventId,
    data: {
      command: pending.command,
      args: [],
      exitCode: null,
      durationMs: pending.durationMs,
      sandbox: pending.sandbox,
      output: pending.output,
    },
  });
  link.pendingShell = undefined;
  map.conversations[conversationId] = link;
  writeMap(directory, map);
}

function refreshReport(store: SessionStore, sessionId: string): void {
  try {
    writeReport(store, sessionId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`blackbox cursor report: ${message}\n`);
  }
}

function isShell(event: Record<string, unknown>): boolean {
  return (text(event.tool_name) ?? "").toLowerCase() === "shell";
}

function commandFrom(event: Record<string, unknown>): string {
  const input = asObject(parseMaybe(event.tool_input));
  return clip(text(input?.command) ?? "");
}

function exitCodeFrom(output: unknown): number | null {
  const record = asObject(output);
  const code = record?.exitCode ?? record?.exit_code;
  return typeof code === "number" && Number.isFinite(code) ? code : null;
}

function parseMaybe(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

function toolCallId(value: unknown): string | undefined {
  const raw = text(value);
  if (raw === undefined) return undefined;
  const first = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return first;
}

export function cursorSessionId(directory: string, when = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = [
    when.getFullYear(),
    pad(when.getMonth() + 1),
    pad(when.getDate()),
  ].join("-");
  const clock = `${pad(when.getHours())}${pad(when.getMinutes())}${pad(when.getSeconds())}`;
  const base = `cursor-${stamp}-${clock}`;
  if (!fs.existsSync(sessionDirectory(directory, base))) return base;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!fs.existsSync(sessionDirectory(directory, candidate))) return candidate;
  }
  throw new Error("could not choose a cursor session id");
}

function childAgent(event: Record<string, unknown>): { id: string; name: string } {
  const id = text(event.subagent_id) ?? text(event.subagent_type) ?? "cursor-subagent";
  const kind = text(event.subagent_type) ?? "subagent";
  return { id, name: `Cursor ${kind}` };
}

function isRunning(store: SessionStore, sessionId: string): boolean {
  try {
    return store.readRecording(sessionId).session.status === "running";
  } catch {
    return false;
  }
}

function openStore(directory: string): SessionStore {
  fs.mkdirSync(directory, { recursive: true });
  return new SessionStore({ directory, redactSecrets: true, captureContent: true });
}

function mapPath(directory: string): string {
  return path.join(directory, "cursor-map.json");
}

function readMap(directory: string): CursorMap {
  const filePath = mapPath(directory);
  if (!fs.existsSync(filePath)) return { conversations: {} };
  try {
    const parsed = asObject(JSON.parse(fs.readFileSync(filePath, "utf8")));
    const conversations = parsed === undefined ? undefined : asObject(parsed.conversations);
    if (conversations === undefined) return { conversations: {} };
    const map: CursorMap = { conversations: {} };
    for (const [id, value] of Object.entries(conversations)) {
      const link = normalizeLink(value);
      if (link !== undefined) map.conversations[id] = link;
    }
    return map;
  } catch {
    return { conversations: {} };
  }
}

function normalizeLink(value: unknown): CursorLink | undefined {
  const record = asObject(value);
  if (record === undefined || typeof record.sessionId !== "string") return undefined;
  const tools: Record<string, string[]> = {};
  for (const [id, queued] of Object.entries(asObject(record.tools) ?? {})) {
    if (typeof queued === "string") tools[toolCallId(id) ?? id] = [queued];
    else if (Array.isArray(queued)) {
      const ids = queued.filter((item): item is string => typeof item === "string");
      if (ids.length > 0) tools[toolCallId(id) ?? id] = ids;
    }
  }
  const shellCalls = Array.isArray(record.shellCalls)
    ? record.shellCalls.filter((item): item is string => typeof item === "string")
    : [];
  const pending = asObject(record.pendingShell);
  return {
    sessionId: record.sessionId,
    tools,
    subagents: stringMap(record.subagents),
    lastThought: text(record.lastThought),
    pendingShell: pending
      ? {
          command: text(pending.command) ?? "",
          output: text(pending.output) ?? "",
          durationMs: numberValue(pending.durationMs),
          sandbox: pending.sandbox === true,
          callEventId: text(pending.callEventId),
        }
      : undefined,
    shellCalls,
  };
}

function stringMap(value: unknown): Record<string, string> {
  const record = asObject(value);
  if (record === undefined) return {};
  const output: Record<string, string> = {};
  for (const [key, child] of Object.entries(record)) {
    if (typeof child === "string") output[key] = child;
  }
  return output;
}

function writeMap(directory: string, map: CursorMap): void {
  writeJsonAtomic(mapPath(directory), map);
}

function withLock(directory: string, fn: () => void): void {
  fs.mkdirSync(directory, { recursive: true });
  const lockPath = path.join(directory, "cursor-adapter.lock");
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const started = Date.now();
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      try {
        fs.writeFileSync(fd, token);
        fn();
      } finally {
        fs.closeSync(fd);
        releaseLock(lockPath, token);
      }
      return;
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
      if (code !== "EEXIST") throw error;
      if (lockIsStale(lockPath)) fs.rmSync(lockPath, { force: true });
      else if (Date.now() - started > 30000) throw new Error("cursor adapter lock timed out");
      else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
}

function releaseLock(lockPath: string, token: string): void {
  try {
    if (fs.readFileSync(lockPath, "utf8") === token) fs.rmSync(lockPath, { force: true });
  } catch {
    return;
  }
}

function lockIsStale(lockPath: string): boolean {
  try {
    const age = Date.now() - fs.statSync(lockPath).mtimeMs;
    if (age < 15000) return false;
    const pid = Number(fs.readFileSync(lockPath, "utf8").split("-")[0]);
    if (!Number.isInteger(pid) || pid <= 0) return true;
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  } catch {
    return true;
  }
}

function clipEdits(value: unknown): unknown {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).map((edit) => {
    const record = asObject(edit);
    return {
      old_string: clip(text(record?.old_string) ?? ""),
      new_string: clip(text(record?.new_string) ?? ""),
    };
  });
}

function clipValue(value: unknown): unknown {
  if (typeof value === "string") return clip(value);
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => clipValue(item));
  const record = asObject(value);
  if (record === undefined) return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) output[key] = clipValue(child);
  return output;
}

function clip(value: string): string {
  if (value.length <= TEXT_LIMIT) return value;
  return `${value.slice(0, TEXT_LIMIT)}\n[truncated]`;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
