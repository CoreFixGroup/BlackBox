import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

import { once } from "node:events";
import { createRequire } from "node:module";
import { collectGitStatus, porcelainPaths } from "../src/git-status.js";
import { Blackbox } from "../src/index.js";
import { projectRoot, TEST_AGENT, tempDirectory } from "./helpers.js";

test("watchDirectory records created, modified, and deleted files", () => {
  const directory = tempDirectory();
  const work = path.join(directory, "work");
  fs.mkdirSync(work);
  fs.writeFileSync(path.join(work, "keep.txt"), "before");
  const blackbox = Blackbox.open({ directory: path.join(directory, "recordings") });
  const session = blackbox.startSession({ agent: TEST_AGENT });
  session.watchDirectory(work);
  fs.writeFileSync(path.join(work, "keep.txt"), "after");
  fs.writeFileSync(path.join(work, "new.txt"), "created");
  fs.writeFileSync(path.join(work, "gone.txt"), "temporary");
  fs.unlinkSync(path.join(work, "gone.txt"));
  session.finish();

  const files = blackbox
    .getSession(session.id)
    .events.filter((event) => event.type === "environment.file");
  assert.equal(files.every((event) => event.source === "environment"), true);
  const modified = files.find((event) => event.data.path === "keep.txt");
  const created = files.find((event) => event.data.path === "new.txt");
  assert.equal(modified?.data.action, "modified");
  assert.equal(modified?.data.bytes, Buffer.byteLength("after"));
  assert.equal(created?.data.action, "created");
  assert.equal(
    files.some((event) => event.data.path === "gone.txt"),
    false,
  );
});

test("deleted files are recorded", () => {
  const directory = tempDirectory();
  const work = path.join(directory, "work");
  fs.mkdirSync(work);
  fs.writeFileSync(path.join(work, "gone.txt"), "temporary");
  const blackbox = Blackbox.open({ directory: path.join(directory, "recordings") });
  const session = blackbox.startSession({ agent: TEST_AGENT });
  session.watchDirectory(work);
  fs.unlinkSync(path.join(work, "gone.txt"));
  session.finish();
  const deleted = blackbox
    .getSession(session.id)
    .events.find((event) => event.type === "environment.file" && event.data.path === "gone.txt");
  assert.equal(deleted?.data.action, "deleted");
  assert.equal(deleted?.data.bytes, Buffer.byteLength("temporary"));
  const git = blackbox.getSession(session.id).events.find((event) => event.type === "environment.git");
  assert.equal(git?.data.summary, "not a git repository");
});

test("snapshots include node_modules and a symlink inside the directory", () => {
  const directory = tempDirectory();
  const work = path.join(directory, "work");
  fs.mkdirSync(path.join(work, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(work, "target.txt"), "body");
  const blackbox = Blackbox.open({ directory: path.join(directory, "recordings") });
  const session = blackbox.startSession({ agent: TEST_AGENT });
  session.watchDirectory(work);
  fs.writeFileSync(path.join(work, "node_modules", "pkg.txt"), "dep");
  let linked = true;
  try {
    fs.symlinkSync(path.join(work, "target.txt"), path.join(work, "link.txt"));
  } catch {
    linked = false;
  }
  session.finish();
  const files = blackbox.getSession(session.id).events.filter((event) => event.type === "environment.file");
  assert.equal(files.some((event) => event.data.path === "node_modules/pkg.txt" && event.data.action === "created"), true);
  if (linked) {
    assert.equal(files.some((event) => event.data.path === "link.txt" && event.data.action === "created"), true);
  }
});

test("git rename lines keep both paths", () => {
  assert.deepEqual(porcelainPaths("R  old.ts -> new.ts"), ["old.ts", "new.ts"]);
  assert.deepEqual(porcelainPaths('?? "a b.txt"'), ["a b.txt"]);
});

test("a git repository records changed paths", () => {
  const probe = childProcess.spawnSync("git", ["--version"], { encoding: "utf8" });
  if (probe.status !== 0) return;
  const directory = tempDirectory();
  const work = path.join(directory, "work");
  fs.mkdirSync(work);
  childProcess.spawnSync("git", ["init"], { cwd: work });
  fs.writeFileSync(path.join(work, "note.txt"), "one");
  const blackbox = Blackbox.open({ directory: path.join(directory, "recordings") });
  const session = blackbox.startSession({ agent: TEST_AGENT });
  session.watchDirectory(work);
  fs.writeFileSync(path.join(work, "note.txt"), "two");
  session.finish();
  const git = blackbox.getSession(session.id).events.find((event) => event.type === "environment.git");
  assert.equal(git?.source, "environment");
  assert.equal(Array.isArray(git?.data.paths), true);
  assert.equal((git?.data.paths as string[]).some((item) => item.includes("note.txt")), true);
  assert.equal(typeof git?.data.summary, "string");
});

test("missing git records one error and still finishes", () => {
  const status = collectGitStatus(tempDirectory(), path.join(tempDirectory(), "missing-git"));
  assert.equal(status.available, false);

  const directory = tempDirectory();
  const work = path.join(directory, "work");
  fs.mkdirSync(work);
  const script = `
    import fs from "node:fs";
    import { Blackbox } from ${JSON.stringify(pathToFileURL(path.join(projectRoot, "src", "index.ts")).href)};
    const blackbox = Blackbox.open({ directory: ${JSON.stringify(path.join(directory, "recordings"))} });
    const session = blackbox.startSession({ agent: { id: "git-agent", name: "Git Agent" } });
    session.watchDirectory(${JSON.stringify(work)});
    session.finish();
    const events = blackbox.getSession(session.id).events.filter((event) => event.type === "error" || event.type === "session.finished");
    process.stdout.write(JSON.stringify(events.map((event) => ({ type: event.type, name: event.data.name, status: event.data.status }))));
  `;
  const scriptPath = path.join(directory, "run.ts");
  fs.writeFileSync(scriptPath, script);
  const empty = path.join(directory, "empty-path");
  fs.mkdirSync(empty);
  const result = childProcess.spawnSync(process.execPath, ["--import", "tsx", scriptPath], {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...process.env, PATH: empty, Path: empty },
  });
  assert.equal(result.status, 0, result.stderr);
  const events = JSON.parse(result.stdout) as { type: string; name?: string; status?: string }[];
  assert.equal(events.filter((event) => event.name === "GitUnavailable").length, 1);
  assert.equal(events.some((event) => event.type === "session.finished" && event.status === "completed"), true);
});

test("wrapSpawn records the child process and skips its environment", () => {
  const blackbox = Blackbox.open({ directory: tempDirectory() });
  const session = blackbox.startSession({ agent: TEST_AGENT });
  const processes = session.wrapSpawn();
  const result = processes.spawnSync(process.execPath, ["-e", "process.exit(3)"], {
    env: { ...process.env, SECRET_TOKEN: "super-secret-value" },
    encoding: "utf8",
  });
  assert.equal(result.status, 3);
  session.finish();
  const processEvent = blackbox.getSession(session.id).events.find((event) => event.type === "environment.process");
  assert.equal(processEvent?.source, "environment");
  assert.equal(processEvent?.data.command, process.execPath);
  assert.deepEqual(processEvent?.data.args, ["-e", "process.exit(3)"]);
  assert.equal(processEvent?.data.exitCode, 3);
  assert.equal(typeof processEvent?.data.durationMs, "number");
  assert.equal(JSON.stringify(blackbox.getSession(session.id).events).includes("super-secret-value"), false);
  assert.equal(JSON.stringify(processEvent?.data).includes("SECRET_TOKEN"), false);
});

test("wrapSpawn records execFileSync and a require() child", () => {
  const blackbox = Blackbox.open({ directory: tempDirectory() });
  const session = blackbox.startSession({ agent: TEST_AGENT });
  const processes = session.wrapSpawn();
  processes.execFileSync(process.execPath, ["-e", "process.exit(0)"]);
  const required = createRequire(import.meta.url)("node:child_process") as {
    spawnSync: typeof childProcess.spawnSync;
  };
  required.spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  session.finish();
  const commands = blackbox
    .getSession(session.id)
    .events.filter((event) => event.type === "environment.process");
  assert.equal(commands.length >= 2, true);
  assert.equal(commands.every((event) => event.data.exitCode === 0), true);
});

test("a child that exits before finish keeps its exit code", async () => {
  const blackbox = Blackbox.open({ directory: tempDirectory() });
  const session = blackbox.startSession({ agent: TEST_AGENT });
  const processes = session.wrapSpawn();
  const child = processes.spawn(process.execPath, ["-e", "process.exit(5)"]);
  await once(child, "exit");
  session.finish();
  const event = blackbox.getSession(session.id).events.find((item) => item.type === "environment.process");
  assert.equal(event?.data.exitCode, 5);
});

test("a child still running at finish is still recorded", () => {
  const blackbox = Blackbox.open({ directory: tempDirectory() });
  const session = blackbox.startSession({ agent: TEST_AGENT });
  const processes = session.wrapSpawn();
  const child = processes.spawn(process.execPath, ["-e", "setTimeout(() => process.exit(6), 5000)"]);
  session.finish();
  child.kill();
  const event = blackbox.getSession(session.id).events.find((item) => item.type === "environment.process");
  assert.equal(event !== undefined, true);
  assert.equal(event?.data.exitCode === null || typeof event?.data.exitCode === "number", true);
});
