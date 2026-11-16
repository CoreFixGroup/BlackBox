import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { runInstrumentedAgent } from "../examples/instrumented-agent.js";
import { formatRecording } from "../src/format.js";
import { Blackbox } from "../src/index.js";
import { renderReport } from "../src/report.js";
import { TEST_AGENT, tempDirectory } from "./helpers.js";

test("the existing agent file does not import Blackbox or the network", () => {
  const source = fs.readFileSync(fileURLToPath(new URL("../examples/existing-agent.ts", import.meta.url)), "utf8");
  assert.equal(source.includes("blackbox"), false);
  assert.equal(source.includes("Blackbox"), false);
  assert.equal(/\bfetch\s*\(/.test(source), false);
  for (const specifier of ["node:http", "node:https", "node:net"]) {
    assert.equal(source.includes(specifier), false);
  }
});

test("wrapped model and tool calls record a stream, a failure, a retry, and a handoff", async () => {
  const directory = tempDirectory();
  const sessionId = await runInstrumentedAgent(Blackbox.open({ directory }));
  const recording = Blackbox.open({ directory }).getSession(sessionId);
  const types = recording.events.map((event) => event.type);

  assert.equal(recording.integrity.complete, true);
  assert.equal(types.includes("user.message"), true);
  assert.equal(types.includes("model.request"), true);
  assert.equal(types.includes("model.stream.delta"), true);
  assert.equal(types.includes("model.response"), true);
  assert.ok(types.filter((type) => type === "tool.call").length >= 2);
  assert.equal(types.includes("error"), true);
  assert.equal(types.includes("retry"), true);
  assert.equal(types.includes("agent.handoff"), true);
  assert.ok(types.filter((type) => type === "agent.completed").length >= 2);
  assert.equal(types.includes("assistant.message"), true);

  const request = recording.events.find((event) => event.type === "model.request");
  const deltas = recording.events.filter((event) => event.type === "model.stream.delta");
  const response = recording.events.find(
    (event) => event.type === "model.response" && event.agentId === "lead-agent",
  );
  assert.equal(deltas.length, 2);
  assert.equal(deltas.every((event) => event.parentEventId === request?.id), true);
  assert.equal(response?.parentEventId, request?.id);
  assert.equal(response?.data.output, "Found a bug. The tests need a retry.");

  const handoff = recording.events.find((event) => event.type === "agent.handoff");
  const childResponse = recording.events.find(
    (event) => event.type === "model.response" && event.agentId === "specialist-agent",
  );
  const childDone = recording.events.find(
    (event) => event.type === "agent.completed" && event.agentId === "specialist-agent",
  );
  assert.equal(handoff?.agentId, "lead-agent");
  assert.equal(childResponse?.parentEventId !== undefined, true);
  assert.equal(childDone?.parentEventId, handoff?.id);
  assert.equal(childDone?.data.status, "completed");

  const failure = recording.events.find((event) => event.type === "error");
  const retry = recording.events.find((event) => event.type === "retry");
  assert.equal(retry?.parentEventId, failure?.id);
  assert.equal(retry?.data.attempt, 2);
  assert.equal(retry?.data.reason, "Retrying tests after the simulated failure");
  assert.equal(recording.events.filter((event) => event.type === "error").length, 1);
  assert.equal(handoff?.data.task, "confirm the test result");

  const calls = recording.events.filter((event) => event.type === "tool.call");
  const read = calls.find((event) => event.data.name === "read_file");
  const results = recording.events.filter((event) => event.type === "tool.result");
  const readResult = results.find((event) => event.data.callId === read?.data.callId);
  assert.deepEqual(read?.data.arguments, { path: "src/math.ts" });
  assert.equal(typeof read?.data.callId, "string");
  assert.equal(readResult?.parentEventId, read?.id);
  assert.equal(readResult?.data.isError, false);
  const testCalls = calls.filter((event) => event.data.name === "run_tests");
  assert.equal(testCalls.length, 2);
  const failedResult = results.find((event) => event.data.callId === testCalls[0]?.data.callId);
  assert.equal(failedResult?.data.isError, true);

  const leadDone = recording.events.find(
    (event) => event.type === "agent.completed" && event.agentId === "lead-agent",
  );
  assert.equal(leadDone?.data.status, "completed");
  assert.equal(leadDone?.data.summary, "Lead agent finished the task");
  assert.equal(formatRecording(recording).includes("lead-agent"), true);
  assert.equal(formatRecording(recording).includes("integration"), true);
  const html = renderReport(recording);
  assert.equal(html.includes("lead-agent"), true);
  assert.equal(html.includes("specialist-agent"), true);
  assert.equal(html.includes('class="source">integration <span class="hint">(reported by the agent)</span>'), true);
});

test("a wrapped model records a promise response and a thrown error", async () => {
  const blackbox = Blackbox.open({ directory: tempDirectory() });
  const session = blackbox.startSession({ agent: TEST_AGENT });
  const model = session.wrapModel(async (input: string) => `echo ${input}`, { model: "local-sim" });
  assert.equal(await model("ping"), "echo ping");

  const failing = session.wrapModel(async () => {
    throw new Error("model unavailable");
  });
  await assert.rejects(failing("ping"), /model unavailable/);
  session.finish();

  const recording = blackbox.getSession(session.id);
  assert.equal(recording.events.filter((event) => event.type === "model.response").length, 1);
  assert.equal(recording.events.some((event) => event.type === "error" && event.data.message === "model unavailable"), true);
});

test("closing a stream early records that it did not finish", async () => {
  const blackbox = Blackbox.open({ directory: tempDirectory() });
  const session = blackbox.startSession({ agent: TEST_AGENT });
  async function* stream(_input: { prompt: string }): AsyncGenerator<string> {
    yield "one";
    yield "two";
  }
  const model = session.wrapModel(stream);
  for await (const chunk of model({ prompt: "ping" })) {
    assert.equal(chunk, "one");
    break;
  }
  session.finish();

  const recording = blackbox.getSession(session.id);
  assert.equal(recording.events.filter((event) => event.type === "model.stream.delta").length, 1);
  assert.equal(
    recording.events.some((event) => event.type === "error" && event.data.name === "StreamClosed"),
    true,
  );
  assert.equal(recording.events.some((event) => event.type === "model.response"), false);
});

test("a failed handoff is recorded and the parent can continue", async () => {
  const blackbox = Blackbox.open({ directory: tempDirectory() });
  const session = blackbox.startSession({ agent: TEST_AGENT });
  await assert.rejects(
    session.handoff({
      agent: { id: "child-agent", name: "Child Agent" },
      task: "inspect",
      run: () => {
        throw new Error("child failed");
      },
    }),
    /child failed/,
  );
  session.recordAssistantMessage({ content: "parent resumed" });
  session.finish();

  const recording = blackbox.getSession(session.id);
  const handoff = recording.events.find((event) => event.type === "agent.handoff");
  const completed = recording.events.find((event) => event.type === "agent.completed");
  assert.equal(completed?.agentId, "child-agent");
  assert.equal(completed?.data.status, "failed");
  assert.equal(completed?.parentEventId, handoff?.id);
  assert.equal(recording.events.at(-2)?.type, "assistant.message");
  assert.equal(recording.events.at(-2)?.agentId, TEST_AGENT.id);
  assert.equal(recording.integrity.complete, true);
});

test("captureContent false omits stream deltas", async () => {
  const blackbox = Blackbox.open({ directory: tempDirectory(), captureContent: false });
  const session = blackbox.startSession({ agent: TEST_AGENT });
  async function* stream(_input: { prompt: string }): AsyncGenerator<string> {
    yield "secret chunk";
  }
  for await (const chunk of session.wrapModel(stream)({ prompt: "ping" })) {
    assert.equal(chunk, "secret chunk");
  }
  session.finish();

  const delta = blackbox.getSession(session.id).events.find((event) => event.type === "model.stream.delta");
  assert.equal(delta?.data.index, 0);
  assert.deepEqual(delta?.data.delta, {
    omitted: true,
    byteLength: Buffer.byteLength(JSON.stringify("secret chunk"), "utf8"),
  });
  const raw = JSON.stringify(blackbox.getSession(session.id).events);
  assert.equal(raw.includes("secret chunk"), false);
});

test("complete leaves the session open until finish", () => {
  const blackbox = Blackbox.open({ directory: tempDirectory() });
  const session = blackbox.startSession({ agent: TEST_AGENT });
  const completed = session.complete({ summary: "still running" });
  session.recordAssistantMessage({ content: "after complete" });
  assert.equal(blackbox.getSession(session.id).session.status, "running");
  session.finish();
  assert.throws(() => session.complete(), /already finished/);
  const recording = blackbox.getSession(session.id);
  assert.equal(recording.events.find((event) => event.id === completed.id)?.data.summary, "still running");
  assert.equal(recording.session.status, "completed");
});

test("a child that completes itself is not completed a second time", async () => {
  const blackbox = Blackbox.open({ directory: tempDirectory() });
  const session = blackbox.startSession({ agent: TEST_AGENT });
  await session.handoff({
    agent: { id: "child-agent", name: "Child Agent" },
    task: "finish once",
    run: (child) => {
      child.complete({ summary: "child done" });
    },
  });
  session.finish();
  const completed = blackbox
    .getSession(session.id)
    .events.filter((event) => event.type === "agent.completed" && event.agentId === "child-agent");
  assert.equal(completed.length, 1);
  assert.equal(completed[0]?.data.summary, "child done");
});

test("a wrapped async generator stays an async generator", async () => {
  const blackbox = Blackbox.open({ directory: tempDirectory() });
  const session = blackbox.startSession({ agent: TEST_AGENT });
  async function* stream(_input: { prompt: string }): AsyncGenerator<string> {
    yield "only";
  }
  const model = session.wrapModel(stream);
  const generated = model({ prompt: "ping" });
  assert.equal(Object.prototype.toString.call(generated), "[object AsyncGenerator]");
  assert.equal(typeof generated.return, "function");
  const chunks: string[] = [];
  for await (const chunk of generated) chunks.push(chunk);
  assert.deepEqual(chunks, ["only"]);
  const promised = session.wrapModel(async (_input: { prompt: string }) => {
    return (async function* inner() {
      yield "later";
    })();
  });
  const pending = promised({ prompt: "ping" });
  assert.equal(typeof pending.then, "function");
  session.finish();
});

test("an unread stream stores the request only", () => {
  const blackbox = Blackbox.open({ directory: tempDirectory() });
  const session = blackbox.startSession({ agent: TEST_AGENT });
  session.wrapModel(async function* unread(_input: { prompt: string }) {
    yield "hidden";
  })({ prompt: "ping" });
  session.finish();
  const events = blackbox.getSession(session.id).events;
  assert.equal(events.some((event) => event.type === "model.request"), true);
  assert.equal(events.some((event) => event.type === "model.response"), false);
  assert.equal(events.some((event) => event.type === "model.stream.delta"), false);
});
