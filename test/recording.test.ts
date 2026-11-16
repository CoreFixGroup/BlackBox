import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { Blackbox, INTEGRATION_NOTICE } from "../src/index.js";
import { eventsPath, sessionHeaderPath } from "../src/paths.js";
import { Session } from "../src/session.js";
import { SessionStore } from "../src/store.js";
import { TEST_AGENT, tempDirectory } from "./helpers.js";

function openTemp(): { directory: string; blackbox: Blackbox } {
  const directory = tempDirectory();
  return { directory, blackbox: Blackbox.open({ directory }) };
}

test("assigns a monotonic sequence and reloads it from disk", () => {
  const { directory, blackbox } = openTemp();
  const session = blackbox.startSession({ agent: TEST_AGENT });
  const message = session.recordUserMessage({ content: "hello" });
  session.finish();

  const reopened = Blackbox.open({ directory }).getSession(session.id);
  assert.deepEqual(
    reopened.events.map((event) => event.sequence),
    reopened.events.map((_, index) => index + 1),
  );
  assert.deepEqual(
    reopened.events.map((event) => event.type),
    ["session.started", "user.message", "session.finished"],
  );
  assert.equal(reopened.events[1]?.id, message.id);
  assert.equal(reopened.integrity.complete, true);
  assert.equal(reopened.session.status, "completed");
  assert.equal(reopened.events.every((event) => event.source === "integration"), true);
  assert.equal(blackbox.listSessions().some((item) => item.id === session.id), true);
});

test("an unfinished session is not presented as complete", () => {
  const { blackbox } = openTemp();
  const session = blackbox.startSession({ agent: TEST_AGENT });
  session.recordUserMessage({ content: "still running" });

  const recording = blackbox.getSession(session.id);
  assert.equal(recording.session.status, "running");
  assert.equal(recording.integrity.complete, false);
  assert.ok(recording.integrity.gaps.some((gap) => gap.includes("session was not finished")));
  assert.equal(recording.events.at(-1)?.type, "user.message");
});

test("a truncated final line is excluded and flagged", () => {
  const { directory, blackbox } = openTemp();
  const session = blackbox.startSession({ agent: TEST_AGENT });
  session.recordUserMessage({ content: "kept" });
  session.finish();

  fs.appendFileSync(eventsPath(directory, session.id), "{\"id\":\"broken\"");
  const recording = blackbox.getSession(session.id);
  assert.equal(JSON.stringify(recording.events).includes("broken"), false);
  assert.equal(recording.events.some((event) => event.type === "user.message"), true);
  assert.equal(recording.integrity.complete, false);
  assert.ok(recording.integrity.gaps.some((gap) => gap.includes("truncated final line")));
});

test("a mismatched event count is not presented as complete", () => {
  const { directory, blackbox } = openTemp();
  const session = blackbox.startSession({ agent: TEST_AGENT });
  session.finish();

  const headerPath = sessionHeaderPath(directory, session.id);
  const header = JSON.parse(fs.readFileSync(headerPath, "utf8")) as { eventCount: number };
  header.eventCount += 5;
  fs.writeFileSync(headerPath, JSON.stringify(header));

  const recording = Blackbox.open({ directory }).getSession(session.id);
  assert.equal(recording.integrity.complete, false);
  assert.ok(recording.integrity.gaps.some((gap) => gap.includes("event count mismatch")));
});

test("redacts secret keys and token shapes from the recording and the export", () => {
  const apiKey = "sk-test-secret-key-1234567890";
  const bearer = "Bearer super-secret-token";
  const { directory, blackbox } = openTemp();
  const session = blackbox.startSession({ agent: TEST_AGENT });
  const awsKey = "AKIAIOSFODNN7EXAMPLE";
  const githubToken = `ghp_${"a".repeat(20)}`;
  session.recordUserMessage({
    content: `token in text ${apiKey} and ${bearer} ${awsKey} ${githubToken}`,
  });
  session.recordToolResult({
    callId: "call-1",
    output: { apiKey, authorization: bearer, note: "visible" },
  });
  session.finish();

  const recording = blackbox.getSession(session.id);
  const exported = blackbox.exportSession(session.id);
  const rawEvents = fs.readFileSync(eventsPath(directory, session.id), "utf8");
  const rawExport = fs.readFileSync(exported.path, "utf8");

  for (const raw of [rawEvents, rawExport, JSON.stringify(recording.events)]) {
    assert.equal(raw.includes(apiKey), false);
    assert.equal(raw.includes("super-secret-token"), false);
    assert.equal(raw.includes(awsKey), false);
    assert.equal(raw.includes(githubToken), false);
  }
  assert.equal(JSON.stringify(recording.events).includes("[REDACTED]"), true);
  assert.equal(JSON.stringify(recording.events).includes("visible"), true);
});

test("can keep secrets when redaction is turned off", () => {
  const apiKey = "sk-test-secret-key-1234567890";
  const directory = tempDirectory();
  const blackbox = Blackbox.open({ directory, redactSecrets: false });
  const session = blackbox.startSession({ agent: TEST_AGENT });
  session.recordUserMessage({ content: apiKey });
  session.finish();

  const raw = fs.readFileSync(eventsPath(directory, session.id), "utf8");
  assert.equal(raw.includes(apiKey), true);
});

test("captureContent false keeps the tool name and drops the payload", () => {
  const directory = tempDirectory();
  const blackbox = Blackbox.open({ directory, captureContent: false });
  const session = blackbox.startSession({ agent: TEST_AGENT });
  const call = session.recordToolCall({
    name: "read_file",
    arguments: { path: "secret.txt", body: "do not store" },
  });
  const failure = session.recordError({ name: "TestFailure", message: "secret failure text" });
  const retry = session.recordRetry({ attempt: 2, reason: "secret retry reason" });
  session.finish({ summary: "secret summary" });

  assert.equal(call.type, "tool.call");
  assert.equal(call.data.name, "read_file");
  assert.deepEqual(call.data.arguments, {
    omitted: true,
    byteLength: Buffer.byteLength(JSON.stringify({ path: "secret.txt", body: "do not store" }), "utf8"),
  });
  assert.equal(failure.data.name, "TestFailure");
  assert.deepEqual(failure.data.message, {
    omitted: true,
    byteLength: Buffer.byteLength(JSON.stringify("secret failure text"), "utf8"),
  });
  assert.equal(retry.data.attempt, 2);
  assert.deepEqual(retry.data.reason, {
    omitted: true,
    byteLength: Buffer.byteLength(JSON.stringify("secret retry reason"), "utf8"),
  });
  const recording = blackbox.getSession(session.id);
  assert.equal(recording.session.finishSummary, null);
  const raw = fs.readFileSync(eventsPath(directory, session.id), "utf8");
  for (const secret of ["secret.txt", "do not store", "secret failure text", "secret retry reason", "secret summary"]) {
    assert.equal(raw.includes(secret), false, secret);
  }
});

test("links a tool result to its call by callId and preserves parent links", () => {
  const { blackbox } = openTemp();
  const session = blackbox.startSession({ agent: TEST_AGENT });
  const request = session.recordModelRequest({ model: "local-sim", input: "ping" });
  const response = session.recordModelResponse({ output: "pong", parentEventId: request.id });
  const call = session.recordToolCall({ name: "read_file", callId: "call-read", arguments: { path: "a.txt" } });
  const result = session.recordToolResult({ callId: "call-read", output: "contents" });
  session.finish();

  assert.equal(response.parentEventId, request.id);
  assert.equal(result.parentEventId, call.id);
  const recording = blackbox.getSession(session.id);
  const storedResult = recording.events.find((event) => event.id === result.id);
  assert.equal(storedResult?.parentEventId, call.id);
});

test("a failed session can still be a complete recording", () => {
  const { blackbox } = openTemp();
  const session = blackbox.startSession({ agent: TEST_AGENT });
  session.recordError({ message: "boom" });
  session.finish({ status: "failed", summary: "stopped" });

  const recording = blackbox.getSession(session.id);
  assert.equal(recording.session.status, "failed");
  assert.equal(recording.session.finishSummary, "stopped");
  assert.equal(recording.integrity.complete, true);
});

test("rejects further events after finish", () => {
  const { blackbox } = openTemp();
  const session = blackbox.startSession({ agent: TEST_AGENT });
  session.finish();
  assert.throws(() => session.recordUserMessage({ content: "too late" }), /already finished/);
  assert.throws(() => session.finish(), /already finished/);
});

test("round-trips an unknown event type", () => {
  const directory = tempDirectory();
  const sessionId = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const event = {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    sessionId,
    sequence: 1,
    type: "future.event",
    timestamp,
    source: "integration",
    agentId: TEST_AGENT.id,
    data: { hello: "world" },
  };
  const sessionDir = path.join(directory, "sessions", sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, "events.jsonl"), `${JSON.stringify(event)}\n`);
  fs.writeFileSync(
    path.join(sessionDir, "session.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: sessionId,
      agent: TEST_AGENT,
      status: "completed",
      startedAt: timestamp,
      finishedAt: timestamp,
      metadata: {},
      captureContent: true,
      redactSecrets: true,
      eventCount: 1,
      lastSequence: 1,
      finishSummary: null,
    }),
  );

  const recording = Blackbox.open({ directory }).getSession(sessionId);
  assert.equal(recording.events[0]?.type, "future.event");
  assert.equal(recording.events[0]?.data.hello, "world");
  assert.equal(recording.integrity.complete, true);
  assert.equal(INTEGRATION_NOTICE.length > 0, true);
});

test("a second open sees events recorded before finish", () => {
  const { directory, blackbox } = openTemp();
  const session = blackbox.startSession({ agent: TEST_AGENT });
  session.recordUserMessage({ content: "partial" });

  const midway = Blackbox.open({ directory }).getSession(session.id);
  assert.equal(midway.session.status, "running");
  assert.equal(midway.integrity.complete, false);
  assert.deepEqual(
    midway.events.map((event) => event.type),
    ["session.started", "user.message"],
  );

  session.recordAssistantMessage({ content: "done" });
  session.finish();
  const finished = Blackbox.open({ directory }).getSession(session.id);
  assert.deepEqual(
    finished.events.map((event) => event.sequence),
    [1, 2, 3, 4],
  );
  assert.equal(finished.integrity.complete, true);
});

test("records a custom event and keeps its parent link", () => {
  const { blackbox } = openTemp();
  const session = blackbox.startSession({ agent: TEST_AGENT });
  const message = session.recordUserMessage({ content: "checkpoint" });
  const custom = session.recordCustom({
    name: "checkpoint",
    data: { step: 1 },
    parentEventId: message.id,
  });
  session.finish();

  assert.equal(custom.type, "custom");
  assert.equal(custom.data.name, "checkpoint");
  assert.deepEqual(custom.data.data, { step: 1 });
  assert.equal(custom.parentEventId, message.id);
  const stored = blackbox.getSession(session.id).events.find((event) => event.id === custom.id);
  assert.equal(stored?.parentEventId, message.id);
});

test("finish closes a session that already has a gap without calling it complete", () => {
  const { directory, blackbox } = openTemp();
  const session = blackbox.startSession({ agent: TEST_AGENT });
  session.recordUserMessage({ content: "kept" });
  fs.appendFileSync(eventsPath(directory, session.id), "{\"id\":\"broken\"}\n");

  session.finish();
  const recording = blackbox.getSession(session.id);
  assert.equal(recording.session.status, "completed");
  assert.equal(recording.integrity.complete, false);
  assert.equal(recording.events.some((event) => event.type === "session.finished"), true);
  assert.equal(JSON.stringify(recording.events).includes("broken"), false);
  assert.ok(recording.integrity.gaps.some((gap) => gap.includes("invalid event")));
});

test("a failed header write can be retried without a second finish event", () => {
  const directory = tempDirectory();
  const store = new SessionStore({ directory, redactSecrets: true, captureContent: true });
  const session = new Session(store, store.startSession({ agent: TEST_AGENT }));
  session.recordUserMessage({ content: "hello" });
  store.failNextHeaderWrite();

  assert.throws(() => session.finish({ summary: "kept" }), /header write failed/);
  assert.equal(store.readRecording(session.id).session.status, "running");
  assert.throws(() => session.recordUserMessage({ content: "too late" }), /already finished/);

  session.finish();
  const recording = store.readRecording(session.id);
  assert.equal(recording.events.filter((event) => event.type === "session.finished").length, 1);
  assert.equal(recording.session.status, "completed");
  assert.equal(recording.session.finishSummary, "kept");
  assert.equal(recording.integrity.complete, true);
});

test("a corrupt session header stays incomplete and does not hide other recordings", () => {
  const { directory, blackbox } = openTemp();
  const good = blackbox.startSession({ agent: TEST_AGENT });
  good.recordUserMessage({ content: "safe" });
  good.finish();

  const badId = crypto.randomUUID();
  fs.mkdirSync(path.join(directory, "sessions", badId));
  fs.writeFileSync(path.join(directory, "sessions", badId, "session.json"), "{");

  const summaries = blackbox.listSessions();
  assert.equal(summaries.some((item) => item.id === good.id && item.complete), true);
  assert.equal(summaries.some((item) => item.id === badId && item.complete === false), true);

  const bad = blackbox.getSession(badId);
  assert.equal(bad.integrity.complete, false);
  assert.ok(bad.integrity.gaps.some((gap) => gap.includes("invalid session.json")));
});

test("a foreign source or session id keeps the recording incomplete", () => {
  const directory = tempDirectory();
  const sessionId = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const base = {
    schemaVersion: 1,
    sessionId,
    timestamp,
    agentId: TEST_AGENT.id,
    data: { hello: "world" },
  };
  const events = [
    { ...base, id: crypto.randomUUID(), sequence: 1, type: "user.message", source: "integration" },
    { ...base, id: crypto.randomUUID(), sequence: 2, type: "custom", source: "watcher" },
    {
      ...base,
      id: crypto.randomUUID(),
      sequence: 3,
      type: "custom",
      source: "integration",
      sessionId: crypto.randomUUID(),
    },
  ];
  const sessionDir = path.join(directory, "sessions", sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, "events.jsonl"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  fs.writeFileSync(
    path.join(sessionDir, "session.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: sessionId,
      agent: TEST_AGENT,
      status: "completed",
      startedAt: timestamp,
      finishedAt: timestamp,
      metadata: {},
      captureContent: true,
      redactSecrets: true,
      eventCount: events.length,
      lastSequence: events.length,
      finishSummary: null,
    }),
  );

  const recording = Blackbox.open({ directory }).getSession(sessionId);
  assert.equal(recording.events.length, 3);
  assert.equal(recording.integrity.complete, false);
  assert.ok(recording.integrity.gaps.some((gap) => gap.includes("source is not recognized")));
  assert.ok(recording.integrity.gaps.some((gap) => gap.includes("belongs to session")));
});
