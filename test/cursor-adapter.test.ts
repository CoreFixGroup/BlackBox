import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { runCursorSample } from "../examples/cursor-sample.js";
import { cursorHookResponse, handleCursorHook } from "../src/cursor-adapter.js";
import { recordingDirectory } from "../src/cursor-hook.js";
import { Blackbox } from "../src/index.js";
import { tempDirectory } from "./helpers.js";

test("cursor hooks allow the agent action", () => {
  assert.equal(cursorHookResponse("preToolUse").permission, "allow");
  assert.equal(cursorHookResponse("beforeShellExecution").permission, "allow");
  assert.equal(cursorHookResponse("beforeSubmitPrompt").continue, true);
  assert.equal(cursorHookResponse("").permission, "allow");
  assert.equal(cursorHookResponse("").continue, true);
});

test("cursor adapter records a sample agent turn and hides thinking text", () => {
  const directory = tempDirectory();
  runCursorSample(directory);
  const sessions = Blackbox.open({ directory }).listSessions();
  assert.equal(sessions.length, 1);
  const recording = Blackbox.open({ directory }).getSession(sessions[0]?.id ?? "");

  assert.equal(recording.session.status, "completed");
  assert.equal(recording.session.agent.id, "cursor");
  assert.match(recording.session.id, /^cursor-\d{4}-\d{2}-\d{2}-\d{6}(-\d+)?$/);
  assert.equal(recording.integrity.complete, true);
  const types = recording.events.map((event) => event.type);
  assert.equal(types.includes("user.message"), true);
  assert.equal(types.includes("assistant.message"), true);
  assert.equal(types.includes("tool.call"), true);
  assert.equal(types.includes("tool.result"), true);
  assert.equal(types.includes("environment.process"), true);
  assert.equal(types.includes("session.finished"), true);

  const result = recording.events.find((event) => event.type === "tool.result");
  const call = recording.events.find((event) => event.type === "tool.call" && event.data.name === "Write");
  assert.equal(result?.parentEventId, call?.id);

  const raw = fs.readFileSync(path.join(directory, "sessions", recording.session.id, "events.jsonl"), "utf8");
  assert.equal(raw.includes("This hidden reasoning must not be stored."), false);
  assert.equal(raw.includes("sk-test-secret-key-1234567890"), false);
  assert.equal(raw.includes("[REDACTED]"), true);
  assert.equal(raw.includes("cursor.thought"), true);
  const report = fs.readFileSync(path.join(directory, "sessions", recording.session.id, "report.html"), "utf8");
  assert.equal(report.includes("Create hello.txt that says hello, then print it."), true);
  assert.equal(report.includes("node -e"), true);
  assert.equal(report.includes("sk-test-secret-key-1234567890"), false);
  assert.equal(fs.existsSync(path.join(directory, "sessions", recording.session.id, "report.html")), true);
});

test("cursor adapter keeps both tool results when an id is reused", () => {
  const directory = tempDirectory();
  const shared = "call-same\nfc_other";
  handleCursorHook({ hook_event_name: "sessionStart", conversation_id: "reuse", cursor_version: "t" }, directory);
  handleCursorHook(
    { hook_event_name: "preToolUse", conversation_id: "reuse", tool_name: "Read", tool_use_id: shared, tool_input: { path: "a.ts" } },
    directory,
  );
  handleCursorHook(
    { hook_event_name: "preToolUse", conversation_id: "reuse", tool_name: "Write", tool_use_id: shared, tool_input: { path: "b.ts" } },
    directory,
  );
  handleCursorHook(
    { hook_event_name: "postToolUse", conversation_id: "reuse", tool_name: "Read", tool_use_id: shared, tool_output: "read" },
    directory,
  );
  handleCursorHook(
    { hook_event_name: "postToolUse", conversation_id: "reuse", tool_name: "Write", tool_use_id: shared, tool_output: "wrote" },
    directory,
  );
  const recording = Blackbox.open({ directory }).getSession(Blackbox.open({ directory }).listSessions()[0]?.id ?? "");
  const calls = recording.events.filter((event) => event.type === "tool.call");
  const results = recording.events.filter((event) => event.type === "tool.result");
  assert.equal(results[0]?.parentEventId, calls[0]?.id);
  assert.equal(results[1]?.parentEventId, calls[1]?.id);
  assert.equal(calls[0]?.data.callId, "call-same");
  assert.equal(String(calls[0]?.data.callId).includes("\n"), false);
});

test("cursor adapter records one thought, a failed abort, a shell exit code, and MCP input", () => {
  const directory = tempDirectory();
  const thought = {
    hook_event_name: "afterAgentThought",
    conversation_id: "details",
    generation_id: "gen-1",
    text: "hidden reasoning",
    duration_ms: 8,
  };
  handleCursorHook({ hook_event_name: "sessionStart", conversation_id: "details", cursor_version: "t" }, directory);
  handleCursorHook(thought, directory);
  handleCursorHook(thought, directory);
  handleCursorHook(
    {
      hook_event_name: "preToolUse",
      conversation_id: "details",
      tool_name: "Shell",
      tool_use_id: "tool-sh",
      tool_input: { command: "npm test" },
    },
    directory,
  );
  handleCursorHook(
    { hook_event_name: "afterShellExecution", conversation_id: "details", command: "npm test", output: "ok\n", duration: 10, sandbox: false },
    directory,
  );
  handleCursorHook(
    {
      hook_event_name: "postToolUse",
      conversation_id: "details",
      tool_name: "Shell",
      tool_use_id: "tool-sh",
      tool_output: "{\"exitCode\":0}",
      duration: 10,
    },
    directory,
  );
  handleCursorHook(
    {
      hook_event_name: "afterMCPExecution",
      conversation_id: "details",
      tool_name: "search",
      mcp_server_name: "docs",
      tool_input: { path: "readme.md" },
      result_json: { ok: true },
    },
    directory,
  );
  handleCursorHook({ hook_event_name: "sessionEnd", conversation_id: "details", reason: "aborted" }, directory);

  const recording = Blackbox.open({ directory }).getSession(Blackbox.open({ directory }).listSessions()[0]?.id ?? "");
  const thoughts = recording.events.filter((event) => event.type === "custom" && event.data.name === "cursor.thought");
  const processEvent = recording.events.find((event) => event.type === "environment.process");
  const shellCall = recording.events.find((event) => event.type === "tool.call" && event.data.name === "Shell");
  const mcp = recording.events.find((event) => event.type === "mcp.response");
  assert.equal(thoughts.length, 1);
  assert.equal(processEvent?.data.exitCode, 0);
  assert.equal(processEvent?.parentEventId, shellCall?.id);
  assert.equal((mcp?.data.input as { path: string }).path, "readme.md");
  assert.equal(recording.session.status, "failed");
  const raw = fs.readFileSync(path.join(directory, "sessions", recording.session.id, "events.jsonl"), "utf8");
  assert.equal(raw.includes("hidden reasoning"), false);
});

test("cursor adapter stores a clipped preview when Cursor reads a file", () => {
  const directory = tempDirectory();
  const content = `line one\n${"x".repeat(9000)}`;
  const response = handleCursorHook(
    {
      hook_event_name: "beforeReadFile",
      conversation_id: "read-preview",
      file_path: "src/app.ts",
      content,
    },
    directory,
  );
  assert.equal(response.permission, "allow");
  const recording = Blackbox.open({ directory }).getSession(Blackbox.open({ directory }).listSessions()[0]?.id ?? "");
  const read = recording.events.find((event) => event.data.name === "file.read");
  const args = read?.data.arguments as { path: string; preview: string; byteLength: number };
  assert.equal(args.path, "src/app.ts");
  assert.equal(args.preview.includes("line one"), true);
  assert.equal(args.preview.includes("[truncated]"), true);
  assert.equal(args.preview.length < content.length, true);
  assert.equal(args.byteLength, Buffer.byteLength(content, "utf8"));
});

test("a user hook records a new project and skips one that already has hooks", () => {
  const project = tempDirectory();
  const home = tempDirectory();
  const fresh = recordingDirectory({ workspace_roots: [project] }, { cwd: home });
  assert.equal(fresh, path.join(project, ".blackbox"));

  fs.mkdirSync(path.join(project, ".cursor"), { recursive: true });
  fs.writeFileSync(path.join(project, ".cursor", "hooks.json"), '{"hooks":{"stop":[{"command":"node dist/cursor-hook.js"}]}}');
  const drive = project.slice(0, 1).toLowerCase();
  const gitBash = `/${drive}:${project.slice(2).replaceAll("\\", "/")}`;
  assert.equal(recordingDirectory({ workspace_roots: [gitBash] }, { cwd: home }), undefined);
  assert.equal(recordingDirectory({ workspace_roots: [project] }, { cwd: project }), path.join(project, ".blackbox"));
});

test("a cursor hook with no conversation id does not create a session", () => {
  const directory = tempDirectory();
  const response = handleCursorHook({ hook_event_name: "stop" }, directory);
  assert.deepEqual(response, {});
  assert.equal(fs.existsSync(path.join(directory, "sessions")), false);
});
