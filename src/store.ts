import fs from "node:fs";

import { appendLine, fsyncFile, writeJsonAtomic } from "./atomic.js";
import { normalizeAgent } from "./agent.js";
import { assessIntegrity } from "./integrity.js";
import { assertSafeSessionId, eventsPath, sessionDirectory, sessionHeaderPath, sessionsRoot, verificationPath } from "./paths.js";
import { applyCapturePolicy, dropUndefined, isPlainObject, redactValue } from "./redact.js";
import {
  SCHEMA_VERSION,
  isEventSource,
  type AgentInfo,
  type BlackboxEvent,
  type EventSource,
  type FinishInput,
  type OutcomeCheck,
  type Recording,
  type SessionHeader,
  type SessionStartInput,
  type SessionStatus,
  type SessionSummary,
} from "./types.js";

export interface AppendEventInput {
  type: string;
  agentId: string;
  parentEventId?: string;
  data: Record<string, unknown>;
  source?: EventSource;
}

export class SessionStore {
  readonly directory: string;
  private readonly redactSecrets: boolean;
  private readonly captureContent: boolean;
  private readonly sequences = new Map<string, number>();
  private headerWriteFailures = 0;

  constructor(options: { directory: string; redactSecrets: boolean; captureContent: boolean }) {
    this.directory = options.directory;
    this.redactSecrets = options.redactSecrets;
    this.captureContent = options.captureContent;
  }

  startSession(input: SessionStartInput): SessionHeader {
    const agent = normalizeAgent(input.agent);
    if (input.metadata !== undefined && !isPlainObject(input.metadata)) {
      throw new Error("metadata must be an object");
    }

    const id = input.id ?? crypto.randomUUID();
    assertSafeSessionId(id);
    if (fs.existsSync(sessionDirectory(this.directory, id))) {
      throw new Error(`Session ${id} already exists`);
    }
    const startedAt = new Date().toISOString();
    const metadata = this.protect(input.metadata ?? {});
    const header: SessionHeader = {
      schemaVersion: SCHEMA_VERSION,
      id,
      agent,
      status: "running",
      startedAt,
      finishedAt: null,
      metadata,
      captureContent: this.captureContent,
      redactSecrets: this.redactSecrets,
      eventCount: 0,
      lastSequence: 0,
      finishSummary: null,
    };

    fs.mkdirSync(sessionDirectory(this.directory, id), { recursive: true });
    this.writeHeader(header);
    this.sequences.set(id, 0);
    this.append(id, {
      type: "session.started",
      agentId: agent.id,
      data: { agent, metadata },
    });
    return header;
  }

  append(sessionId: string, input: AppendEventInput): BlackboxEvent {
    const header = this.readHeader(sessionId);
    if (header.status !== "running") {
      throw new Error(`Session ${sessionId} is already ${header.status}`);
    }

    const sequence = this.nextSequence(sessionId);
    const event: BlackboxEvent = {
      schemaVersion: SCHEMA_VERSION,
      id: crypto.randomUUID(),
      sessionId,
      sequence,
      type: input.type,
      timestamp: new Date().toISOString(),
      source: input.source ?? "integration",
      agentId: input.agentId,
      data: this.prepareData(input.data),
    };
    if (input.parentEventId !== undefined) {
      event.parentEventId = input.parentEventId;
    }

    appendLine(eventsPath(this.directory, sessionId), JSON.stringify(event));
    this.sequences.set(sessionId, sequence);
    return event;
  }

  failNextHeaderWrite(): void {
    this.headerWriteFailures += 1;
  }

  finalize(sessionId: string, status: NonNullable<FinishInput["status"]>, summary: string | null): SessionHeader {
    const filePath = eventsPath(this.directory, sessionId);
    fsyncFile(filePath);
    const parsed = readEventLines(filePath, sessionId);
    const header = this.readHeader(sessionId);
    if (header.status !== "running") {
      throw new Error(`Session ${sessionId} is already ${header.status}`);
    }

    const updated: SessionHeader = {
      ...header,
      status,
      finishedAt: new Date().toISOString(),
      eventCount: parsed.events.length,
      lastSequence: parsed.events.at(-1)?.sequence ?? 0,
      finishSummary: summary,
    };
    this.writeHeader(updated);
    return updated;
  }

  list(): SessionSummary[] {
    const root = sessionsRoot(this.directory);
    if (!fs.existsSync(root)) return [];

    const summaries: SessionSummary[] = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const headerPath = sessionHeaderPath(this.directory, entry.name);
      if (!fs.existsSync(headerPath)) continue;
      try {
        const recording = this.readRecording(entry.name);
        summaries.push(toSummary(recording));
      } catch {
        summaries.push({
          id: entry.name,
          agent: { id: "unknown", name: "unreadable session" },
          status: "running",
          startedAt: "",
          finishedAt: null,
          eventCount: 0,
          complete: false,
        });
      }
    }

    summaries.sort((left, right) => {
      const byTime = left.startedAt.localeCompare(right.startedAt);
      return byTime === 0 ? left.id.localeCompare(right.id) : byTime;
    });
    return summaries;
  }

  readRecording(sessionId: string): Recording {
    const loaded = this.loadHeader(sessionId);
    const parsed = readEventLines(eventsPath(this.directory, sessionId), sessionId);
    if (!loaded.header) {
      if (loaded.missing) throw new Error(loaded.error);
      const session = unreadableSession(sessionId);
      return {
        session,
        events: parsed.events,
        integrity: assessIntegrity(session, parsed.events, [loaded.error, ...parsed.gaps]),
        verification: this.readVerification(sessionId),
      };
    }
    return {
      session: loaded.header,
      events: parsed.events,
      integrity: assessIntegrity(loaded.header, parsed.events, parsed.gaps),
      verification: this.readVerification(sessionId),
    };
  }

  readVerification(sessionId: string): OutcomeCheck[] {
    const filePath = verificationPath(this.directory, sessionId);
    if (!fs.existsSync(filePath)) return [];
    const checks: OutcomeCheck[] = [];
    for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
      if (line.length === 0) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (isOutcomeCheck(parsed)) checks.push(parsed);
      } catch {
        continue;
      }
    }
    return checks;
  }

  appendVerification(sessionId: string, check: OutcomeCheck): void {
    this.readHeader(sessionId);
    appendLine(verificationPath(this.directory, sessionId), JSON.stringify(check));
  }

  private prepareData(data: Record<string, unknown>): Record<string, unknown> {
    const captured = applyCapturePolicy(dropUndefined(data), this.captureContent);
    return this.protect(captured);
  }

  private protect(value: Record<string, unknown>): Record<string, unknown> {
    const redacted = this.redactSecrets ? redactValue(value) : value;
    return JSON.parse(JSON.stringify(redacted)) as Record<string, unknown>;
  }

  private nextSequence(sessionId: string): number {
    const current = this.sequences.get(sessionId);
    if (current !== undefined) return current + 1;
    const parsed = readEventLines(eventsPath(this.directory, sessionId), sessionId);
    return (parsed.events.at(-1)?.sequence ?? 0) + 1;
  }

  private writeHeader(header: SessionHeader): void {
    if (this.headerWriteFailures > 0) {
      this.headerWriteFailures -= 1;
      throw new Error("header write failed");
    }
    writeJsonAtomic(sessionHeaderPath(this.directory, header.id), header);
  }

  private readHeader(sessionId: string): SessionHeader {
    const loaded = this.loadHeader(sessionId);
    if (!loaded.header) throw new Error(loaded.error);
    return loaded.header;
  }

  private loadHeader(sessionId: string): { header: SessionHeader | null; error: string; missing: boolean } {
    const filePath = sessionHeaderPath(this.directory, sessionId);
    if (!fs.existsSync(filePath)) {
      return { header: null, error: `Session not found: ${sessionId}`, missing: true };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      return { header: null, error: `invalid session.json for ${sessionId}`, missing: false };
    }
    if (!isSessionHeader(parsed) || parsed.id !== sessionId) {
      return { header: null, error: `invalid session.json for ${sessionId}`, missing: false };
    }
    return { header: parsed, error: "", missing: false };
  }
}

function toSummary(recording: Recording): SessionSummary {
  return {
    id: recording.session.id,
    agent: recording.session.agent,
    status: recording.session.status,
    startedAt: recording.session.startedAt,
    finishedAt: recording.session.finishedAt,
    eventCount: recording.integrity.eventCount,
    complete: recording.integrity.complete,
  };
}

function unreadableSession(sessionId: string): SessionHeader {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: sessionId,
    agent: { id: "unknown", name: "unreadable session" },
    status: "running",
    startedAt: "",
    finishedAt: null,
    metadata: {},
    captureContent: false,
    redactSecrets: true,
    eventCount: 0,
    lastSequence: 0,
    finishSummary: null,
  };
}

function readEventLines(filePath: string, sessionId: string): { events: BlackboxEvent[]; gaps: string[] } {
  if (!fs.existsSync(filePath)) {
    return { events: [], gaps: ["events.jsonl is missing"] };
  }

  const raw = fs.readFileSync(filePath, "utf8");
  if (raw.length === 0) return { events: [], gaps: [] };

  const endsWithNewline = raw.endsWith("\n");
  const lines = raw.split("\n");
  if (endsWithNewline) lines.pop();

  const events: BlackboxEvent[] = [];
  const gaps: string[] = [];
  lines.forEach((line, index) => {
    if (line.length === 0) {
      gaps.push(`blank line at ${index + 1}`);
      return;
    }
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isEvent(parsed)) {
        gaps.push(`invalid event at line ${index + 1}`);
        return;
      }
      if (parsed.sessionId !== sessionId) {
        gaps.push(`event ${parsed.sequence} belongs to session ${parsed.sessionId}`);
      }
      if (!isEventSource(parsed.source)) {
        gaps.push(`event ${parsed.sequence} source is not recognized`);
      }
      events.push(parsed);
    } catch {
      const isLast = index === lines.length - 1;
      gaps.push(
        isLast && !endsWithNewline
          ? "truncated final line discarded"
          : `invalid JSON at line ${index + 1}`,
      );
    }
  });
  return { events, gaps };
}

function isEvent(value: unknown): value is BlackboxEvent {
  if (!isPlainObject(value)) return false;
  return (
    value.schemaVersion === SCHEMA_VERSION &&
    typeof value.id === "string" &&
    typeof value.sessionId === "string" &&
    typeof value.sequence === "number" &&
    Number.isInteger(value.sequence) &&
    typeof value.type === "string" &&
    value.type.length > 0 &&
    typeof value.timestamp === "string" &&
    typeof value.source === "string" &&
    typeof value.agentId === "string" &&
    isPlainObject(value.data) &&
    (value.parentEventId === undefined || typeof value.parentEventId === "string")
  );
}

function isSessionHeader(value: unknown): value is SessionHeader {
  if (!isPlainObject(value)) return false;
  const agent = value.agent;
  return (
    value.schemaVersion === SCHEMA_VERSION &&
    typeof value.id === "string" &&
    isAgent(agent) &&
    isStatus(value.status) &&
    typeof value.startedAt === "string" &&
    (value.finishedAt === null || typeof value.finishedAt === "string") &&
    isPlainObject(value.metadata) &&
    typeof value.captureContent === "boolean" &&
    typeof value.redactSecrets === "boolean" &&
    typeof value.eventCount === "number" &&
    typeof value.lastSequence === "number" &&
    (value.finishSummary === null || typeof value.finishSummary === "string")
  );
}

function isAgent(value: unknown): value is AgentInfo {
  return isPlainObject(value) && typeof value.id === "string" && typeof value.name === "string";
}

function isStatus(value: unknown): value is SessionStatus {
  return value === "running" || value === "completed" || value === "failed";
}

function isOutcomeCheck(value: unknown): value is OutcomeCheck {
  if (!isPlainObject(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.timestamp === "string" &&
    value.type === "outcome.check" &&
    typeof value.name === "string" &&
    (value.status === "passed" || value.status === "failed") &&
    value.basis === "verified" &&
    typeof value.message === "string"
  );
}
