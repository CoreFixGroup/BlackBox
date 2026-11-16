import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";

import { Blackbox } from "../src/index.js";
import { projectRoot, TEST_AGENT, tempDirectory } from "./helpers.js";

test("compare reports the first divergence and model differences", () => {
  const directory = tempDirectory();
  const blackbox = Blackbox.open({ directory });
  const left = blackbox.startSession({ agent: TEST_AGENT });
  left.recordToolCall({ name: "read_file", arguments: { path: "a" } });
  left.recordModelResponse({ output: "same" });
  left.recordModelResponse({ output: "left answer" });
  left.finish();
  const right = blackbox.startSession({ agent: TEST_AGENT });
  right.recordToolCall({ name: "read_file", arguments: { path: "a" } });
  right.recordModelResponse({ output: "same" });
  right.recordModelResponse({ output: "right answer" });
  right.finish();

  const comparison = blackbox.compare(left.id, right.id);
  assert.equal(comparison.divergence?.leftType, "model.response");
  assert.equal(comparison.divergence?.rightType, "model.response");
  assert.equal(comparison.toolDifferences.length, 0);
  assert.equal(comparison.modelDifferences.length, 1);
  assert.equal(comparison.environmentDifferences.length, 0);

  const same = blackbox.compare(left.id, left.id);
  assert.equal(same.divergence, null);

  const shifted = blackbox.startSession({ agent: TEST_AGENT });
  shifted.recordUserMessage({ content: "extra" });
  shifted.recordModelResponse({ output: "same answer" });
  shifted.finish();
  const plain = blackbox.startSession({ agent: TEST_AGENT });
  plain.recordModelResponse({ output: "same answer" });
  plain.finish();
  const shiftedComparison = blackbox.compare(shifted.id, plain.id);
  assert.equal(shiftedComparison.divergence?.leftType, "user.message");
  assert.equal(shiftedComparison.modelDifferences.length, 0);

  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", path.join(projectRoot, "src", "cli.ts"), "compare", left.id, right.id, "--dir", directory],
    { cwd: projectRoot, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.includes("Divergence: event"), true);
  assert.equal(result.stdout.includes("model response 2:"), true);
  assert.equal(result.stdout.includes("Tool differences:\n- none"), true);
});

test("a fault fires once on the next matching wrapper", async () => {
  const blackbox = Blackbox.open({ directory: tempDirectory() });
  const session = blackbox.startSession({ agent: TEST_AGENT });
  session.injectFault({ target: "tool", name: "read_file", message: "tool blocked" });
  session.injectFault({ target: "model", name: "local-sim", message: "model blocked" });
  const tool = session.wrapTool("read_file", (_args: { path: string }) => "ok");
  assert.throws(() => tool({ path: "a" }), /tool blocked/);
  assert.equal(tool({ path: "a" }), "ok");
  const model = session.wrapModel(async () => "ok", { model: "local-sim" });
  assert.throws(() => model("ping"), /model blocked/);
  assert.equal(await model("ping"), "ok");
  session.finish();

  const faults = blackbox.getSession(session.id).events.filter((event) => event.type === "fault.injected");
  assert.equal(faults.length, 2);
  assert.equal(faults[0]?.data.target, "tool");
  assert.equal(faults[1]?.data.message, "model blocked");
  const toolCalls = blackbox.getSession(session.id).events.filter((event) => event.type === "tool.call");
  assert.equal(toolCalls.length, 1);
});
