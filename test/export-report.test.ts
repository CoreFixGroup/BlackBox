import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { Blackbox, INTEGRATION_NOTICE } from "../src/index.js";
import { TEST_AGENT, tempDirectory } from "./helpers.js";

test("export preserves order, parent links, and integrity", () => {
  const directory = tempDirectory();
  const blackbox = Blackbox.open({ directory });
  const session = blackbox.startSession({ agent: TEST_AGENT });
  const request = session.recordModelRequest({ model: "local-sim", input: "ping" });
  session.recordModelResponse({ output: "pong", parentEventId: request.id });
  session.finish();

  const recording = blackbox.getSession(session.id);
  const exported = blackbox.exportSession(session.id);
  const onDisk = JSON.parse(fs.readFileSync(exported.path, "utf8")) as typeof exported.document;

  assert.equal(exported.path, path.join(directory, "sessions", session.id, "export.json"));
  assert.equal(onDisk.schemaVersion, 1);
  assert.equal(typeof onDisk.exportedAt, "string");
  assert.deepEqual(
    onDisk.events.map((event) => event.id),
    recording.events.map((event) => event.id),
  );
  assert.equal(onDisk.events.find((event) => event.type === "model.response")?.parentEventId, request.id);
  assert.equal(onDisk.integrity.complete, true);
  assert.deepEqual(onDisk.integrity.gaps, []);
});

test("html report escapes payloads and stays self-contained", () => {
  const directory = tempDirectory();
  const blackbox = Blackbox.open({ directory });
  const session = blackbox.startSession({ agent: TEST_AGENT });
  session.recordUserMessage({ content: `<script>alert("x")</script>` });
  session.recordError({ message: "visible failure" });
  session.finish();

  const reportPath = blackbox.reportSession(session.id);
  const html = fs.readFileSync(reportPath, "utf8");
  assert.equal(reportPath, path.join(directory, "sessions", session.id, "report.html"));
  assert.equal(html.includes(session.id), true);
  assert.equal(html.includes("visible failure"), true);
  assert.equal(html.includes(INTEGRATION_NOTICE), false);
  assert.equal(html.includes("Recording complete"), true);
  assert.equal(html.includes("<script>alert"), false);
  assert.equal(html.includes("&lt;script&gt;"), true);
  assert.equal(html.includes('id="find"'), true);
  assert.equal(/https?:\/\//i.test(html), false);
  assert.match(html, /<li class="event bad">[\s\S]*visible failure/);
});

test("html report shows a tool call in words", () => {
  const directory = tempDirectory();
  const blackbox = Blackbox.open({ directory });
  const session = blackbox.startSession({ agent: TEST_AGENT });
  session.recordUserMessage({ content: "find the bug" });
  const call = session.recordToolCall({
    name: "Read",
    callId: "c1",
    arguments: { file_path: "src/app.ts" },
  });
  session.recordToolResult({
    callId: "c1",
    output: { file_path: "src/app.ts", content_length: 40 },
    parentEventId: call.id,
  });
  session.recordToolCall({
    name: "file.read",
    arguments: { path: "src/app.ts", byteLength: 40, preview: "export const answer = 1;\n" },
  });
  session.recordToolCall({
    name: "Grep",
    callId: "c2",
    arguments: { pattern: "bug", file_path: "src", glob: "**/*", output_mode: "files_with_matches" },
  });
  session.finish();

  const html = fs.readFileSync(blackbox.reportSession(session.id), "utf8");
  assert.equal(html.includes("find the bug"), true);
  assert.equal(html.includes("src/app.ts"), true);
  assert.equal(html.includes("export const answer = 1;"), true);
  assert.equal(html.includes("Cursor sent the file size only"), true);
  assert.equal(html.includes("search the text inside files"), true);
  assert.equal(html.includes("which file names to include"), true);
  assert.equal(html.includes("only the names of files that matched"), true);
  assert.equal(html.includes("the agent started a tool"), true);
  assert.equal(html.includes("<script>alert"), false);
  assert.equal(html.includes('id="stage"'), true);
});

test("html report shows an edit as a line diff", () => {
  const directory = tempDirectory();
  const blackbox = Blackbox.open({ directory });
  const session = blackbox.startSession({ agent: TEST_AGENT });
  session.recordToolCall({
    name: "file.edit",
    arguments: {
      path: "src/hello.js",
      edits: [{ old_string: "return \"hello\";\nkeep\n", new_string: "return \"hello, reader\";\nkeep\n" }],
    },
  });
  session.recordToolCall({
    name: "file.edit",
    arguments: {
      path: "src/mark.js",
      edits: [{ old_string: "a < b", new_string: "a < c" }],
    },
  });
  session.finish();

  const html = fs.readFileSync(blackbox.reportSession(session.id), "utf8");
  assert.equal(html.includes('<div class="diff-row remove"><span class="ln">1</span><span class="ln"></span><span class="mark">-</span><code>return &quot;hello&quot;;</code></div>'), true);
  assert.equal(html.includes('<div class="diff-row add"><span class="ln"></span><span class="ln">1</span><span class="mark">+</span><code>return &quot;hello, reader&quot;;</code></div>'), true);
  assert.equal(html.includes('<div class="diff-row same"><span class="ln">2</span><span class="ln">2</span><span class="mark"></span><code>keep</code></div>'), true);
  assert.equal(html.includes("a &lt; b"), true);
  assert.equal(html.includes("<script>alert"), false);
  assert.equal(/https?:\/\//i.test(html), false);
});

test("an unfinished report is labeled incomplete", () => {
  const directory = tempDirectory();
  const blackbox = Blackbox.open({ directory });
  const session = blackbox.startSession({ agent: TEST_AGENT });
  session.recordError({ message: "stopped early" });

  const html = fs.readFileSync(blackbox.reportSession(session.id), "utf8");
  assert.equal(html.includes("Recording incomplete"), true);
  assert.equal(html.includes("session was not finished"), true);
  assert.equal(html.includes("Recording complete"), false);
});
