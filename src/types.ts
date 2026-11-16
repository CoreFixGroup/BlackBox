export const SCHEMA_VERSION = 1 as const;

export const INTEGRATION_NOTICE =
  "These events were reported by the agent integration. Blackbox did not independently observe them.";

export const EVENT_SOURCES = ["integration", "protocol", "environment", "replay", "verification"] as const;

export type SchemaVersion = typeof SCHEMA_VERSION;

export type SessionStatus = "running" | "completed" | "failed";

export type EventSource = (typeof EVENT_SOURCES)[number];

export const SOURCE_NOTICES: Record<EventSource, string> = {
  integration: INTEGRATION_NOTICE,
  protocol: "These events were observed because the integration turned protocol capture on.",
  environment: "These events were observed in a directory or process the integration named.",
  replay: "These events were produced by offline replay of a stored recording.",
  verification: "These checks were recorded because the integration asked Blackbox to verify an outcome.",
};

export function isEventSource(value: string): value is EventSource {
  return (EVENT_SOURCES as readonly string[]).includes(value);
}

export function noticesFor(sources: Iterable<string>): string[] {
  const seen = new Set<string>();
  const notices: string[] = [];
  for (const source of sources) {
    if (seen.has(source) || !isEventSource(source)) continue;
    seen.add(source);
    notices.push(SOURCE_NOTICES[source]);
  }
  if (notices.length === 0) notices.push(INTEGRATION_NOTICE);
  return notices;
}

export interface AgentInfo {
  id: string;
  name: string;
  version?: string;
}

export interface SessionHeader {
  schemaVersion: SchemaVersion;
  id: string;
  agent: AgentInfo;
  status: SessionStatus;
  startedAt: string;
  finishedAt: string | null;
  metadata: Record<string, unknown>;
  captureContent: boolean;
  redactSecrets: boolean;
  eventCount: number;
  lastSequence: number;
  finishSummary: string | null;
}

export interface BlackboxEvent {
  schemaVersion: SchemaVersion;
  id: string;
  sessionId: string;
  sequence: number;
  type: string;
  timestamp: string;
  source: string;
  agentId: string;
  parentEventId?: string;
  data: Record<string, unknown>;
}

export interface Integrity {
  complete: boolean;
  eventCount: number;
  gaps: string[];
}

export interface OutcomeCheck {
  id: string;
  timestamp: string;
  type: "outcome.check";
  name: string;
  status: "passed" | "failed";
  basis: "verified";
  message: string;
}

export interface Recording {
  session: SessionHeader;
  events: BlackboxEvent[];
  integrity: Integrity;
  verification: OutcomeCheck[];
}

export interface SessionSummary {
  id: string;
  agent: AgentInfo;
  status: SessionStatus;
  startedAt: string;
  finishedAt: string | null;
  eventCount: number;
  complete: boolean;
}

export interface OpenOptions {
  directory?: string;
  redactSecrets?: boolean;
  captureContent?: boolean;
}

export interface SessionStartInput {
  agent: AgentInfo;
  metadata?: Record<string, unknown>;
  id?: string;
}

export interface FinishInput {
  status?: "completed" | "failed";
  summary?: string;
}

export interface ExportDocument {
  schemaVersion: SchemaVersion;
  exportedAt: string;
  session: SessionHeader;
  events: BlackboxEvent[];
  integrity: Integrity;
}

export interface UserMessageInput {
  content: string;
  parentEventId?: string;
}

export interface AssistantMessageInput {
  content: string;
  parentEventId?: string;
}

export interface ModelRequestInput {
  model?: string;
  provider?: string;
  input: unknown;
  parentEventId?: string;
}

export interface ModelResponseInput {
  output: unknown;
  parentEventId?: string;
}

export interface ToolCallInput {
  name: string;
  callId?: string;
  arguments?: unknown;
  parentEventId?: string;
}

export interface ToolResultInput {
  callId?: string;
  output: unknown;
  parentEventId?: string;
  isError?: boolean;
}

export interface ErrorInput {
  message: string;
  name?: string;
  details?: unknown;
  parentEventId?: string;
}

export interface RetryInput {
  attempt: number;
  reason: string;
  parentEventId?: string;
}

export interface CustomEventInput {
  name: string;
  data?: unknown;
  parentEventId?: string;
}

export interface WrapModelOptions {
  provider?: string;
  model?: string;
}

export interface RunWithRetryOptions {
  attempts: number;
  reason: string;
}

export interface AgentCompletionInput {
  status?: "completed" | "failed";
  summary?: string;
}

export interface FaultInjection {
  target: "tool" | "model";
  name: string;
  message: string;
}

export interface Divergence {
  index: number;
  leftType?: string;
  rightType?: string;
}

export interface Comparison {
  divergence: Divergence | null;
  toolDifferences: string[];
  modelDifferences: string[];
  environmentDifferences: string[];
}

export type VerificationCheck =
  | { type: "file.exists"; path: string }
  | { type: "file.sha256"; path: string; sha256: string }
  | { type: "git.head"; path: string; commit: string }
  | {
      type: "custom";
      name: string;
      run: () => boolean | { ok: boolean; message?: string } | Promise<boolean | { ok: boolean; message?: string }>;
    };
