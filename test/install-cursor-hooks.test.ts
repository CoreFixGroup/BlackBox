import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { installCursorProjectHooks, removeCursorUserHooks } from "../src/install-cursor-hooks.js";
import { tempDirectory } from "./helpers.js";

test("setup writes hooks into one project and keeps other hooks", () => {
  const blackbox = tempDirectory();
  const hookScript = path.join(blackbox, "dist", "cursor-hook.js");
  fs.mkdirSync(path.dirname(hookScript), { recursive: true });
  fs.writeFileSync(hookScript, "");
  const project = tempDirectory();
  const hooksFile = path.join(project, ".cursor", "hooks.json");
  fs.mkdirSync(path.dirname(hooksFile), { recursive: true });
  fs.writeFileSync(
    hooksFile,
    JSON.stringify({
      version: 1,
      hooks: {
        stop: [{ command: "node \"D:\\old\\cursor-hook.js\"", timeout: 15 }, { command: "echo keep-me" }],
      },
    }),
  );

  installCursorProjectHooks(hookScript, project);
  const written = JSON.parse(fs.readFileSync(hooksFile, "utf8")) as {
    hooks: Record<string, { command: string }[]>;
  };

  assert.equal(written.hooks.stop?.[0]?.command.includes(hookScript), true);
  assert.equal(written.hooks.stop?.[1]?.command, "echo keep-me");
  assert.equal(written.hooks.sessionStart?.[0]?.command.startsWith("node \""), true);
  assert.equal(fs.existsSync(path.join(blackbox, ".cursor", "hooks.json")), false);
});

test("setup inside Blackbox uses a relative hook command", () => {
  const blackbox = tempDirectory();
  const hookScript = path.join(blackbox, "dist", "cursor-hook.js");
  fs.mkdirSync(path.dirname(hookScript), { recursive: true });
  fs.writeFileSync(hookScript, "");

  installCursorProjectHooks(hookScript, blackbox);
  const written = JSON.parse(fs.readFileSync(path.join(blackbox, ".cursor", "hooks.json"), "utf8")) as {
    hooks: { stop: { command: string }[] };
  };
  assert.equal(written.hooks.stop[0]?.command, "node dist/cursor-hook.js");
});

test("setup removes the all-projects hook file when it only contains Blackbox", () => {
  const directory = tempDirectory();
  const hooksFile = path.join(directory, "hooks.json");
  fs.writeFileSync(
    hooksFile,
    JSON.stringify({
      version: 1,
      hooks: { stop: [{ command: "node \"D:\\blackbox\\dist\\cursor-hook.js\"", timeout: 15 }] },
    }),
  );

  assert.equal(removeCursorUserHooks(hooksFile), true);
  assert.equal(fs.existsSync(hooksFile), false);
});

test("setup refuses to replace a broken hooks file", () => {
  const directory = tempDirectory();
  const hookScript = path.join(directory, "cursor-hook.js");
  fs.writeFileSync(hookScript, "");
  const project = tempDirectory();
  const hooksFile = path.join(project, ".cursor", "hooks.json");
  fs.mkdirSync(path.dirname(hooksFile), { recursive: true });
  fs.writeFileSync(hooksFile, "{");

  assert.throws(() => installCursorProjectHooks(hookScript, project), /left unchanged/);
  assert.equal(fs.readFileSync(hooksFile, "utf8"), "{");
});
