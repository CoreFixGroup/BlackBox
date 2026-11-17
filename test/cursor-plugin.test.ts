import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { handleCursorHook } from "../src/cursor-adapter.js";
import { main } from "../src/cursor-hook.js";
import { Blackbox } from "../src/index.js";
import { tempDirectory } from "./helpers.js";

function payload(project: string): string {
  return JSON.stringify({
    hook_event_name: "beforeSubmitPrompt",
    conversation_id: "plugin-test",
    prompt: "hello",
    workspace_roots: [project],
  });
}

async function* stdin(text: string): AsyncGenerator<Buffer> {
  yield Buffer.from(text);
}

async function withPluginFlag(run: () => Promise<void>): Promise<void> {
  const original = process.argv;
  process.argv = [...original, "--plugin"];
  try {
    await run();
  } finally {
    process.argv = original;
  }
}

function sessionCount(project: string): number {
  const directory = path.join(project, ".blackbox");
  if (!fs.existsSync(directory)) return 0;
  return Blackbox.open({ directory }).listSessions().length;
}

function installProjectHook(project: string): void {
  fs.mkdirSync(path.join(project, ".cursor"), { recursive: true });
  fs.writeFileSync(
    path.join(project, ".cursor", "hooks.json"),
    JSON.stringify({ version: 1, hooks: { stop: [{ command: "node dist/cursor-hook.js" }] } }),
  );
}

async function quiet(run: () => Promise<void>): Promise<void> {
  const write = process.stdout.write;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    await run();
  } finally {
    process.stdout.write = write;
  }
}

test("plugin only records one session", async () => {
  const project = tempDirectory();
  await quiet(() => withPluginFlag(() => main(stdin(payload(project)))));
  assert.equal(sessionCount(project), 1);
});

test("blackbox-on only records one session", () => {
  const project = tempDirectory();
  installProjectHook(project);
  handleCursorHook(JSON.parse(payload(project)) as Record<string, unknown>, path.join(project, ".blackbox"));
  assert.equal(sessionCount(project), 1);
});

test("plugin stays quiet when blackbox-on is already installed", async () => {
  const project = tempDirectory();
  installProjectHook(project);
  handleCursorHook(JSON.parse(payload(project)) as Record<string, unknown>, path.join(project, ".blackbox"));
  await quiet(() => withPluginFlag(() => main(stdin(payload(project)))));
  assert.equal(sessionCount(project), 1);
});
