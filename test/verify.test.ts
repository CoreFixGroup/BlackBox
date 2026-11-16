import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { Blackbox } from "../src/index.js";
import { renderReport } from "../src/report.js";
import { TEST_AGENT, tempDirectory } from "./helpers.js";

test("verification is stored beside the recording and shown in the report", async () => {
  const directory = tempDirectory();
  const filePath = path.join(directory, "result.txt");
  fs.writeFileSync(filePath, "blackbox");
  const digest = createHash("sha256").update("blackbox").digest("hex");
  const blackbox = Blackbox.open({ directory: path.join(directory, "recordings") });
  const session = blackbox.startSession({ agent: TEST_AGENT });
  session.recordAssistantMessage({ content: "done" });
  session.finish();

  const checks = await blackbox.verify(session.id, [
    { type: "file.exists", path: filePath },
    { type: "file.sha256", path: filePath, sha256: digest },
    { type: "file.sha256", path: filePath, sha256: "abc" },
    { type: "custom", name: "notes", run: () => ({ ok: true, message: "checked locally" }) },
  ]);
  assert.deepEqual(
    checks.map((check) => check.status),
    ["passed", "passed", "failed", "passed"],
  );
  assert.equal(checks.every((check) => check.basis === "verified"), true);

  const recording = blackbox.getSession(session.id);
  assert.equal(recording.integrity.complete, true);
  assert.equal(recording.events.some((event) => event.type === "outcome.check"), false);
  assert.equal(fs.existsSync(path.join(directory, "recordings", "sessions", session.id, "verification.jsonl")), true);
  const html = renderReport(recording);
  assert.equal(html.includes("Passed: file.exists"), true);
  assert.equal(html.includes("Failed: file.sha256"), true);
  assert.equal(html.includes("Not checked."), false);

  const unchecked = renderReport({ ...recording, verification: [] });
  assert.equal(unchecked.includes("Not checked."), true);
  assert.equal(unchecked.includes("Recording complete"), true);
});

test("git HEAD can be verified without changing the recording", () => {
  const probe = childProcess.spawnSync("git", ["--version"], { encoding: "utf8" });
  if (probe.status !== 0) return;
  const directory = tempDirectory();
  const work = path.join(directory, "repo");
  fs.mkdirSync(work);
  childProcess.spawnSync("git", ["init"], { cwd: work });
  childProcess.spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: work });
  childProcess.spawnSync("git", ["config", "user.name", "Blackbox Test"], { cwd: work });
  fs.writeFileSync(path.join(work, "file.txt"), "one");
  childProcess.spawnSync("git", ["add", "."], { cwd: work });
  const commit = childProcess.spawnSync("git", ["commit", "-m", "init"], { cwd: work, encoding: "utf8" });
  if (commit.status !== 0) return;
  const head = childProcess.spawnSync("git", ["rev-parse", "HEAD"], { cwd: work, encoding: "utf8" }).stdout.trim();
  const blackbox = Blackbox.open({ directory: path.join(directory, "recordings") });
  const session = blackbox.startSession({ agent: TEST_AGENT });
  session.finish();
  return blackbox.verify(session.id, [{ type: "git.head", path: work, commit: head }]).then((checks) => {
    assert.equal(checks[0]?.status, "passed");
    assert.equal(checks[0]?.message, "HEAD matches");
    const before = fs.readFileSync(path.join(directory, "recordings", "sessions", session.id, "events.jsonl"), "utf8");
    assert.equal(before.includes("outcome.check"), false);
  });
});
