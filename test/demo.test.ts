import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { DEMO_API_KEY, DEMO_BEARER, DEMO_ERROR, runDemoAgent } from "../examples/demo-agent.js";
import { Blackbox, INTEGRATION_NOTICE } from "../src/index.js";
import { eventsPath } from "../src/paths.js";
import { tempDirectory } from "./helpers.js";

test("demo agent records a full local execution without network imports", () => {
  const source = fs.readFileSync(fileURLToPath(new URL("../examples/demo-agent.ts", import.meta.url)), "utf8");
  assert.equal(/\bfetch\s*\(/.test(source), false);
  for (const specifier of ["node:http", "node:https", "node:net", "node:tls", "node:dns"]) {
    assert.equal(source.includes(specifier), false, specifier);
  }

  const directory = tempDirectory();
  const blackbox = Blackbox.open({ directory });
  const restoreNetwork = blockNetwork();
  let sessionId = "";
  try {
    sessionId = runDemoAgent(blackbox);
  } finally {
    restoreNetwork();
  }
  const recording = Blackbox.open({ directory }).getSession(sessionId);
  const types = recording.events.map((event) => event.type);

  assert.equal(types.includes("user.message"), true);
  assert.equal(types.includes("model.request"), true);
  assert.equal(types.includes("model.response"), true);
  assert.ok(types.filter((type) => type === "tool.call").length >= 2);
  assert.ok(types.filter((type) => type === "tool.result").length >= 2);
  assert.equal(types.includes("error"), true);
  assert.equal(types.includes("retry"), true);
  assert.equal(types.includes("assistant.message"), true);
  assert.equal(recording.session.status, "completed");
  assert.equal(recording.integrity.complete, true);
  assert.equal(recording.events.every((event) => event.source === "integration"), true);

  const request = recording.events.find((event) => event.type === "model.request");
  const response = recording.events.find((event) => event.type === "model.response");
  const passedCall = recording.events.find(
    (event) => event.type === "tool.call" && event.data.callId === "call-run-tests-2",
  );
  const passedResult = recording.events.find(
    (event) => event.type === "tool.result" && event.data.callId === "call-run-tests-2",
  );
  const failure = recording.events.find((event) => event.type === "error");
  const retry = recording.events.find((event) => event.type === "retry");
  assert.equal(response?.parentEventId, request?.id);
  assert.equal(retry?.parentEventId, failure?.id);
  assert.equal(passedResult?.parentEventId, passedCall?.id);

  const raw = fs.readFileSync(eventsPath(directory, sessionId), "utf8");
  assert.equal(raw.includes(DEMO_API_KEY), false);
  assert.equal(raw.includes("super-secret-token"), false);
  assert.equal(raw.includes(DEMO_BEARER), false);
  assert.equal(raw.includes("[REDACTED]"), true);

  const exported = blackbox.exportSession(sessionId);
  const exportRaw = fs.readFileSync(exported.path, "utf8");
  assert.equal(exportRaw.includes(DEMO_API_KEY), false);
  assert.equal(exportRaw.includes("super-secret-token"), false);
  assert.deepEqual(
    exported.document.events.map((event) => event.sequence),
    recording.events.map((event) => event.sequence),
  );

  const html = fs.readFileSync(blackbox.reportSession(sessionId), "utf8");
  assert.equal(html.includes(sessionId), true);
  assert.equal(html.includes(DEMO_ERROR), true);
  assert.equal(html.includes(INTEGRATION_NOTICE), false);
  assert.equal(html.includes("Recording complete"), true);
  assert.equal(/https?:\/\//i.test(html), false);
  assert.equal(html.includes(DEMO_API_KEY), false);

  assert.equal(path.basename(exported.path), "export.json");
});

function blockNetwork(): () => void {
  const originals = {
    fetch: globalThis.fetch,
    httpRequest: http.request,
    httpsRequest: https.request,
    netConnect: net.connect,
  };
  const block = (label: string) => () => {
    throw new Error(`network blocked: ${label}`);
  };
  globalThis.fetch = block("fetch") as typeof globalThis.fetch;
  http.request = block("http.request") as typeof http.request;
  https.request = block("https.request") as typeof https.request;
  net.connect = block("net.connect") as typeof net.connect;
  return () => {
    globalThis.fetch = originals.fetch;
    http.request = originals.httpRequest;
    https.request = originals.httpsRequest;
    net.connect = originals.netConnect;
  };
}
