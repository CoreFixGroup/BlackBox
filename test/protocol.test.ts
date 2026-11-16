import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { test } from "node:test";

import { Blackbox } from "../src/index.js";
import { TEST_AGENT, tempDirectory } from "./helpers.js";

test("captureHttp records fetch, http.request, model calls, and jsonrpc", async () => {
  const stub = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      if (req.url === "/chat") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ choices: [{ message: { content: "hello" } }] }));
        return;
      }
      if (req.url === "/rpc") {
        res.end(JSON.stringify({ jsonrpc: "2.0", result: { ok: true }, id: 1 }));
        return;
      }
      res.end("plain");
    });
  });
  stub.listen(0, "127.0.0.1");
  await once(stub, "listening");
  const address = stub.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const blackbox = Blackbox.open({ directory: tempDirectory() });
  const session = blackbox.startSession({ agent: TEST_AGENT });
  session.captureHttp();
  try {
    const plain = await fetch(`http://127.0.0.1:${port}/plain`, { method: "POST", body: "hello" });
    assert.equal(await plain.text(), "plain");
    await fetch(`http://127.0.0.1:${port}/chat`, {
      method: "POST",
      headers: { authorization: "Bearer super-secret-token", "content-type": "application/json" },
      body: JSON.stringify({
        model: "local-sim",
        messages: [{ role: "user", content: "ping" }],
        apiKey: "sk-test-secret-key-1234567890",
      }),
    });
    await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
    });
    await new Promise<void>((resolve, reject) => {
      const req = http.request({ hostname: "127.0.0.1", port, path: "/plain", method: "POST" }, (res) => {
        res.resume();
        res.on("end", () => resolve());
      });
      req.on("error", reject);
      req.end("via-http");
    });
    await assert.rejects(fetch("http://127.0.0.1:1/missing", { signal: AbortSignal.timeout(2000) }));
    session.finish();
    const restored = await fetch(`http://127.0.0.1:${port}/plain`);
    assert.equal(restored.status, 200);
  } finally {
    stub.close();
  }

  const events = blackbox.getSession(session.id).events;
  const requests = events.filter((event) => event.type === "http.request");
  assert.ok(requests.length >= 4);
  assert.equal(requests.every((event) => event.source === "protocol"), true);
  const chat = requests.find((event) => event.data.url === `http://127.0.0.1:${port}/chat`);
  const chatResponse = events.find((event) => event.type === "http.response" && event.parentEventId === chat?.id);
  assert.equal(chatResponse?.data.status, 200);
  const headers = chat?.data.headers as { authorization?: string };
  assert.equal(headers.authorization, "[REDACTED]");
  const body = chat?.data.body as { apiKey?: string };
  assert.equal(body.apiKey, "[REDACTED]");
  const modelRequest = events.find((event) => event.type === "model.request" && event.source === "protocol");
  const modelResponse = events.find((event) => event.type === "model.response" && event.source === "protocol");
  assert.equal(modelRequest?.parentEventId, chat?.id);
  assert.equal(modelResponse?.parentEventId, chat?.id);
  assert.equal(modelRequest?.data.model, "local-sim");
  assert.equal(events.some((event) => event.type === "jsonrpc.request"), true);
  assert.equal(events.some((event) => event.type === "jsonrpc.response"), true);
  assert.equal(
    events.some((event) => event.type === "error" && event.source === "protocol"),
    true,
  );
  const plainRequest = requests.find((event) => String(event.data.url).endsWith("/plain") && event.data.body === "via-http");
  assert.equal(plainRequest !== undefined, true);
});

test("wrapMcp records request and callTool", async () => {
  const blackbox = Blackbox.open({ directory: tempDirectory() });
  const session = blackbox.startSession({ agent: TEST_AGENT });
  const client = {
    async request(method: string, params: unknown) {
      return { method, params, ok: true };
    },
    callTool(name: string, args: unknown) {
      return { name, args };
    },
  };
  const wrapped = session.wrapMcp(client);
  assert.deepEqual(await wrapped.request("tools/list", { cursor: "start" }), {
    method: "tools/list",
    params: { cursor: "start" },
    ok: true,
  });
  assert.deepEqual(wrapped.callTool("read", { path: "a.txt" }), { name: "read", args: { path: "a.txt" } });
  session.finish();

  const events = blackbox.getSession(session.id).events.filter((event) => event.type.startsWith("mcp."));
  assert.deepEqual(
    events.map((event) => event.type),
    ["mcp.request", "mcp.response", "mcp.request", "mcp.response"],
  );
  assert.equal(events.every((event) => event.source === "protocol"), true);
  assert.equal(events[1]?.parentEventId, events[0]?.id);
  assert.equal(events[2]?.data.method, "tools/call");
});

test("captureContent false omits protocol bodies", async () => {
  const stub = http.createServer((_req, res) => {
    res.end("secret body");
  });
  stub.listen(0, "127.0.0.1");
  await once(stub, "listening");
  const address = stub.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const blackbox = Blackbox.open({ directory: tempDirectory(), captureContent: false });
  const session = blackbox.startSession({ agent: TEST_AGENT });
  session.captureHttp();
  try {
    await fetch(`http://127.0.0.1:${port}/hidden`, { method: "POST", body: "secret body" });
  } finally {
    session.finish();
    stub.close();
  }
  const request = blackbox.getSession(session.id).events.find((event) => event.type === "http.request");
  assert.deepEqual(request?.data.body, {
    omitted: true,
    byteLength: Buffer.byteLength(JSON.stringify("secret body"), "utf8"),
  });
  const raw = JSON.stringify(blackbox.getSession(session.id).events);
  assert.equal(raw.includes("secret body"), false);
});
