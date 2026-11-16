import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { test } from "node:test";

import { Blackbox } from "../src/index.js";
import { TEST_AGENT, tempDirectory } from "./helpers.js";

test("the local proxy records HTTP and a CONNECT target", async () => {
  const stub = http.createServer((_req, res) => {
    res.end("local");
  });
  stub.listen(0, "127.0.0.1");
  await once(stub, "listening");
  const stubAddress = stub.address();
  const stubPort = typeof stubAddress === "object" && stubAddress ? stubAddress.port : 0;
  const blackbox = Blackbox.open({ directory: tempDirectory() });
  const session = blackbox.startSession({ agent: TEST_AGENT });
  const proxy = await session.openProxy();

  const forwarded = await new Promise<string>((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: proxy.port,
        method: "GET",
        path: `http://127.0.0.1:${stubPort}/hello`,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      },
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(forwarded, "local");

  const tunneled = await new Promise<string>((resolve, reject) => {
    const socket = net.connect(proxy.port, "127.0.0.1");
    let buffer = "";
    let tunneledResponse = false;
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (!tunneledResponse) {
        const split = buffer.indexOf("\r\n\r\n");
        if (split < 0) return;
        assert.equal(buffer.startsWith("HTTP/1.1 200"), true);
        tunneledResponse = true;
        buffer = buffer.slice(split + 4);
        socket.write(`GET /hello HTTP/1.1\r\nHost: 127.0.0.1:${stubPort}\r\nConnection: close\r\n\r\n`);
      }
      if (buffer.includes("local")) {
        socket.end();
        resolve(buffer);
      }
    });
    socket.on("error", reject);
    socket.write(`CONNECT 127.0.0.1:${stubPort} HTTP/1.1\r\nHost: 127.0.0.1:${stubPort}\r\n\r\n`);
  });
  assert.equal(tunneled.includes("local"), true);
  session.finish();
  stub.close();

  const events = blackbox.getSession(session.id).events;
  const request = events.find((event) => event.type === "http.request");
  assert.equal(request?.source, "protocol");
  assert.equal(request?.data.url, `http://127.0.0.1:${stubPort}/hello`);
  const connect = events.find((event) => event.type === "http.connect");
  assert.equal(connect?.data.host, "127.0.0.1");
  assert.equal(connect?.data.port, stubPort);
  assert.equal(events.filter((event) => event.type === "http.request").length, 1);

  await new Promise<void>((resolve, reject) => {
    const socket = net.connect(proxy.port, "127.0.0.1");
    socket.on("error", () => resolve());
    socket.on("connect", () => reject(new Error("proxy stayed open")));
  });
});
