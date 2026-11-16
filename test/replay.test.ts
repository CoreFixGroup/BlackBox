import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { test } from "node:test";

import { Blackbox } from "../src/index.js";
import { TEST_AGENT, tempDirectory } from "./helpers.js";

test("replay serves recorded model responses and blocks the network", async () => {
  const blackbox = Blackbox.open({ directory: tempDirectory() });
  const session = blackbox.startSession({ agent: TEST_AGENT });
  const model = session.wrapModel(async (input: string) => `live ${input}`, { model: "local-sim" });
  assert.equal(await model("one"), "live one");
  assert.equal(await model("two"), "live two");
  session.finish();

  const replay = blackbox.replay(session.id);
  let calls = 0;
  await replay.run(async (handle) => {
    const replayed = handle.wrapModel(async (input: string) => {
      calls += 1;
      return `should not run ${input}`;
    }, { model: "local-sim" });
    assert.equal(await replayed("one"), "live one");
    assert.equal(await replayed("two"), "live two");
    assert.throws(() => replayed("three"), (error: unknown) => {
      assert.equal(error instanceof Error && error.name, "ReplayExhausted");
      return true;
    });
    assert.throws(() => {
      http.request({ hostname: "127.0.0.1", port: 9, method: "GET" });
    }, (error: unknown) => {
      assert.equal(error instanceof Error && error.name, "ReplayNetworkBlocked");
      return true;
    });
    assert.throws(() => fetch("http://127.0.0.1:9/blocked"), (error: unknown) => {
      assert.equal(error instanceof Error && error.name, "ReplayNetworkBlocked");
      return true;
    });
    assert.throws(() => net.connect(9, "127.0.0.1"), (error: unknown) => {
      assert.equal(error instanceof Error && error.name, "ReplayNetworkBlocked");
      return true;
    });
  });
  assert.equal(calls, 0);
  replay.session.finish();

  const events = blackbox.getSession(replay.session.id).events;
  const responses = events.filter((event) => event.type === "model.response");
  const requests = events.filter((event) => event.type === "model.request");
  assert.equal(responses.length, 2);
  assert.equal(responses.every((event) => event.source === "replay" && event.data.origin === "replayed"), true);
  assert.equal(requests.every((event) => event.data.origin === "generated"), true);
  assert.equal(events.filter((event) => event.data.name === "ReplayNetworkBlocked").length, 3);
  assert.equal(
    events.some((event) => event.type === "error" && event.data.name === "ReplayExhausted" && event.data.origin === "generated"),
    true,
  );
  assert.equal(
    events.some((event) => event.type === "error" && event.data.name === "ReplayNetworkBlocked"),
    true,
  );
  assert.equal(blackbox.getSession(session.id).events.some((event) => event.source === "replay"), false);
});

test("replay serves a known tool result and runs an unknown tool", () => {
  const blackbox = Blackbox.open({ directory: tempDirectory() });
  const session = blackbox.startSession({ agent: TEST_AGENT });
  const known = session.wrapTool("known", (value: string) => `stored ${value}`);
  assert.equal(known("a"), "stored a");
  session.finish();

  const replay = blackbox.replay(session.id);
  let knownCalls = 0;
  const replayed = replay.wrapTool("known", (value: string) => {
    knownCalls += 1;
    return `live ${value}`;
  });
  assert.equal(replayed("a"), "stored a");
  assert.equal(knownCalls, 0);
  const generated = replay.wrapTool("other", () => "ran live");
  assert.equal(generated(), "ran live");
  replay.session.finish();

  const events = blackbox.getSession(replay.session.id).events;
  const knownResult = events.find((event) => event.type === "tool.result" && event.data.output === "stored a");
  const otherResult = events.find((event) => event.type === "tool.result" && event.data.output === "ran live");
  assert.equal(knownResult?.source, "replay");
  assert.equal(knownResult?.data.origin, "replayed");
  assert.equal(otherResult?.data.origin, "generated");
});

test("replay matches a stored tool by name when it is not the next result", () => {
  const blackbox = Blackbox.open({ directory: tempDirectory() });
  const session = blackbox.startSession({ agent: TEST_AGENT });
  assert.equal(session.wrapTool("alpha", () => "A")(), "A");
  assert.equal(session.wrapTool("beta", () => "B")(), "B");
  session.finish();

  const replay = blackbox.replay(session.id);
  let calls = 0;
  const beta = replay.wrapTool("beta", () => {
    calls += 1;
    return "live";
  });
  assert.equal(beta(), "B");
  assert.equal(calls, 0);
  replay.session.finish();
});
