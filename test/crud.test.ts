import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import {
  CREATED_TEXT,
  NOTE_NAME,
  OLD_NOTE_NAME,
  OLD_TEXT,
  UPDATED_TEXT,
  USER_TASK,
  runCrudAgent,
} from "../examples/crud-agent.js";
import { Blackbox } from "../src/index.js";
import { eventsPath, verificationPath } from "../src/paths.js";
import { tempDirectory } from "./helpers.js";

test("crud agent records create, read, update, and delete end to end", async () => {
  const directory = tempDirectory();
  const recordings = path.join(directory, "recordings");
  const workspace = path.join(directory, "workspace");
  const blackbox = Blackbox.open({ directory: recordings });
  const sessionId = await runCrudAgent(blackbox, workspace);
  const recording = blackbox.getSession(sessionId);

  assert.equal(fs.readFileSync(path.join(workspace, NOTE_NAME), "utf8"), UPDATED_TEXT);
  assert.equal(fs.existsSync(path.join(workspace, OLD_NOTE_NAME)), false);
  assert.equal(recording.session.status, "completed");
  assert.equal(recording.integrity.complete, true);
  assert.equal(recording.integrity.gaps.length, 0);
  assert.deepEqual(
    recording.verification.map((check) => check.name),
    ["file.exists", "file.sha256", "old note deleted"],
  );
  assert.equal(recording.verification.every((check) => check.status === "passed"), true);

  const toolCalls = recording.events.filter((event) => event.type === "tool.call");
  assert.deepEqual(
    toolCalls.map((event) => event.data.name),
    ["create_file", "read_file", "update_file", "delete_file"],
  );
  assert.equal(toolCalls[0]?.data.arguments && (toolCalls[0].data.arguments as { content: string }).content, CREATED_TEXT);
  const readResult = recording.events.find(
    (event) => event.type === "tool.result" && event.parentEventId === toolCalls[1]?.id,
  );
  const updateResult = recording.events.find(
    (event) => event.type === "tool.result" && event.parentEventId === toolCalls[2]?.id,
  );
  assert.equal((readResult?.data.output as { content: string }).content, CREATED_TEXT);
  assert.equal((updateResult?.data.output as { bytes: number }).bytes, Buffer.byteLength(UPDATED_TEXT));

  const user = recording.events.find((event) => event.type === "user.message");
  assert.equal(user?.data.content, USER_TASK);
  assert.equal(user?.source, "integration");

  const files = recording.events.filter((event) => event.type === "environment.file");
  assert.equal(
    files.some(
      (event) =>
        event.data.path === NOTE_NAME &&
        event.data.action === "created" &&
        event.data.bytes === Buffer.byteLength(UPDATED_TEXT),
    ),
    true,
  );
  assert.equal(
    files.some(
      (event) =>
        event.data.path === OLD_NOTE_NAME &&
        event.data.action === "deleted" &&
        event.data.bytes === Buffer.byteLength(OLD_TEXT),
    ),
    true,
  );
  assert.equal(files.every((event) => event.source === "environment"), true);
  const git = recording.events.find((event) => event.type === "environment.git");
  assert.equal(git?.data.summary, "not a git repository");

  const eventFile = fs.readFileSync(eventsPath(recordings, sessionId), "utf8");
  assert.equal(eventFile.includes("outcome.check"), false);
  const checks = fs.readFileSync(verificationPath(recordings, sessionId), "utf8").trim().split("\n");
  assert.equal(checks.length, 3);
  assert.equal(checks.every((line) => line.includes('"status":"passed"')), true);
});
