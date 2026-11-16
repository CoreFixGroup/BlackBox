import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { runDemoAgent } from "../examples/demo-agent.js";
import { Blackbox, INTEGRATION_NOTICE } from "../src/index.js";
import { projectRoot, tempDirectory, TEST_AGENT } from "./helpers.js";

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", path.join(projectRoot, "src", "cli.ts"), ...args],
    { cwd: projectRoot, encoding: "utf8" },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("cli lists, shows, exports, and reports a finished recording", () => {
  const directory = tempDirectory();
  const sessionId = runDemoAgent(Blackbox.open({ directory }));

  const list = runCli(["list", "--dir", directory]);
  assert.equal(list.status, 0, list.stderr);
  assert.equal(list.stdout.includes(sessionId), true);
  assert.equal(list.stdout.includes("  complete  "), true);

  const show = runCli(["show", sessionId, "--dir", directory]);
  assert.equal(show.status, 0, show.stderr);
  assert.equal(show.stdout.includes(sessionId), true);
  assert.equal(show.stdout.includes("Complete: yes"), true);
  assert.equal(show.stdout.includes(INTEGRATION_NOTICE), true);
  assert.equal(show.stdout.includes("tool.call"), true);
  assert.equal(show.stdout.includes("error"), true);

  const exportRun = runCli(["export", sessionId, "--dir", directory]);
  assert.equal(exportRun.status, 0, exportRun.stderr);
  const exportPath = exportRun.stdout.trim();
  assert.equal(fs.existsSync(exportPath), true);
  const exported = JSON.parse(fs.readFileSync(exportPath, "utf8")) as { integrity: { complete: boolean } };
  assert.equal(exported.integrity.complete, true);

  const report = runCli(["report", sessionId, "--dir", directory]);
  assert.equal(report.status, 0, report.stderr);
  const reportPath = report.stdout.trim();
  assert.equal(fs.existsSync(reportPath), true);
  const html = fs.readFileSync(reportPath, "utf8");
  assert.equal(html.includes(sessionId), true);
  assert.equal(html.includes("Recording complete"), true);
});

test("cli export and report write to --out", () => {
  const directory = tempDirectory();
  const sessionId = runDemoAgent(Blackbox.open({ directory }));
  const outDir = tempDirectory();
  const exportOut = path.join(outDir, "copy.json");
  const reportOut = path.join(outDir, "copy.html");

  const exportRun = runCli(["export", sessionId, "--dir", directory, "--out", exportOut]);
  assert.equal(exportRun.status, 0, exportRun.stderr);
  assert.equal(path.resolve(exportRun.stdout.trim()), path.resolve(exportOut));
  const exported = JSON.parse(fs.readFileSync(exportOut, "utf8")) as { session: { id: string } };
  assert.equal(exported.session.id, sessionId);

  const reportRun = runCli(["report", sessionId, "--dir", directory, "--out", reportOut]);
  assert.equal(reportRun.status, 0, reportRun.stderr);
  assert.equal(path.resolve(reportRun.stdout.trim()), path.resolve(reportOut));
  assert.equal(fs.readFileSync(reportOut, "utf8").includes(sessionId), true);
});

test("cli show marks an unfinished session incomplete", () => {
  const directory = tempDirectory();
  const session = Blackbox.open({ directory }).startSession({ agent: TEST_AGENT });
  session.recordUserMessage({ content: "not finished" });

  const show = runCli(["show", session.id, "--dir", directory]);
  assert.equal(show.status, 0, show.stderr);
  assert.equal(show.stdout.includes("Status: running"), true);
  assert.equal(show.stdout.includes("Complete: no"), true);
  assert.equal(show.stdout.includes("session was not finished"), true);
});

test("cli returns an error for an unknown session", () => {
  const directory = tempDirectory();
  const show = runCli(["show", "missing-session", "--dir", directory]);
  assert.equal(show.status, 1);
  assert.equal(show.stderr.includes("Session not found"), true);
});
