import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isDirectRun } from "./direct.js";

const HOOK_NAMES = [
  "sessionStart",
  "sessionEnd",
  "beforeSubmitPrompt",
  "afterAgentResponse",
  "afterAgentThought",
  "beforeReadFile",
  "preToolUse",
  "postToolUse",
  "postToolUseFailure",
  "afterFileEdit",
  "afterShellExecution",
  "afterMCPExecution",
  "subagentStart",
  "subagentStop",
  "preCompact",
  "stop",
] as const;

interface HookCommand {
  command: string;
  timeout?: number;
}

interface HooksFile {
  version: number;
  hooks: Record<string, HookCommand[]>;
}

export function installCursorProjectHooks(hookScript: string, projectDirectory: string): string {
  if (!fs.existsSync(hookScript)) {
    throw new Error(`Build Blackbox first. Missing ${hookScript}`);
  }
  const project = path.resolve(projectDirectory);
  const hooksFile = path.join(project, ".cursor", "hooks.json");
  const command = hookCommand(hookScript, project);
  const current = readHooksFile(hooksFile);
  for (const name of HOOK_NAMES) {
    const list = current.hooks[name] ?? [];
    const existing = list.find((item) => item.command.includes("cursor-hook.js"));
    if (existing) existing.command = command;
    else list.push({ command, timeout: 15 });
    current.hooks[name] = list;
  }
  fs.mkdirSync(path.dirname(hooksFile), { recursive: true });
  fs.writeFileSync(hooksFile, `${JSON.stringify(current, null, 2)}\n`, "utf8");
  return hooksFile;
}

export function removeCursorUserHooks(hooksFile: string): boolean {
  if (!fs.existsSync(hooksFile)) return false;
  const current = readHooksFile(hooksFile);
  let removed = false;
  for (const [name, list] of Object.entries(current.hooks)) {
    const kept = list.filter((item) => !item.command.includes("cursor-hook.js"));
    if (kept.length !== list.length) removed = true;
    if (kept.length === 0) delete current.hooks[name];
    else current.hooks[name] = kept;
  }
  if (!removed) return false;
  if (Object.keys(current.hooks).length === 0) fs.rmSync(hooksFile);
  else fs.writeFileSync(hooksFile, `${JSON.stringify(current, null, 2)}\n`, "utf8");
  return true;
}

function hookCommand(hookScript: string, projectDirectory: string): string {
  const relative = path.join(projectDirectory, "dist", "cursor-hook.js");
  if (path.resolve(hookScript) === path.resolve(relative)) return "node dist/cursor-hook.js";
  return `node ${quoteCommand(path.resolve(hookScript))}`;
}

function readHooksFile(hooksFile: string): HooksFile {
  if (!fs.existsSync(hooksFile)) return { version: 1, hooks: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(hooksFile, "utf8"));
  } catch {
    throw new Error(`Could not read ${hooksFile}. It is not valid JSON, so it was left unchanged.`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Could not read ${hooksFile}. It was left unchanged.`);
  }
  const record = parsed as { version?: unknown; hooks?: unknown };
  const version = typeof record.version === "number" ? record.version : 1;
  const hooks: Record<string, HookCommand[]> = {};
  if (record.hooks !== undefined) {
    if (typeof record.hooks !== "object" || record.hooks === null || Array.isArray(record.hooks)) {
      throw new Error(`Could not read ${hooksFile}. It was left unchanged.`);
    }
    for (const [name, value] of Object.entries(record.hooks)) {
      if (!Array.isArray(value)) throw new Error(`Could not read ${hooksFile}. It was left unchanged.`);
      hooks[name] = value.map((item) => {
        if (typeof item !== "object" || item === null || typeof (item as { command?: unknown }).command !== "string") {
          throw new Error(`Could not read ${hooksFile}. It was left unchanged.`);
        }
        const command = item as { command: string; timeout?: unknown };
        return typeof command.timeout === "number" ? { command: command.command, timeout: command.timeout } : { command: command.command };
      });
    }
  }
  return { version, hooks };
}

function quoteCommand(filePath: string): string {
  return `"${filePath.replaceAll('"', '\\"')}"`;
}

export function installBlackboxOnCommand(installScript: string, binDir: string): string {
  if (!fs.existsSync(installScript)) {
    throw new Error(`Build Blackbox first. Missing ${installScript}`);
  }
  fs.mkdirSync(binDir, { recursive: true });
  const script = path.resolve(installScript);
  const windows = process.platform === "win32";
  const target = path.join(binDir, windows ? "blackbox-on.cmd" : "blackbox-on");
  const body = windows
    ? `@echo off\r\nnode ${quoteCommand(script)} %*\r\n`
    : `#!/bin/sh\nexec node ${quoteCommand(script)} "$@"\n`;
  fs.writeFileSync(target, body);
  if (!windows) fs.chmodSync(target, 0o755);
  return target;
}

function npmBinDir(): string {
  if (process.platform === "win32" && process.env.APPDATA) return path.join(process.env.APPDATA, "npm");
  return path.join(os.homedir(), ".local", "bin");
}

function projectRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

if (isDirectRun(import.meta.url)) {
  try {
    const root = projectRoot();
    const installScript = path.join(root, "dist", "install-cursor-hooks.js");
    if (process.argv[2] === "--install-command") {
      const command = installBlackboxOnCommand(installScript, npmBinDir());
      process.stdout.write(`Installed ${command}\nIn a project folder, run: blackbox-on\n`);
    } else {
      const hookScript = path.join(root, "dist", "cursor-hook.js");
      const project = path.resolve(process.argv[2] ?? process.cwd());
      const written = installCursorProjectHooks(hookScript, project);
      removeCursorUserHooks(path.join(os.homedir(), ".cursor", "hooks.json"));
      const command = installBlackboxOnCommand(installScript, npmBinDir());
      process.stdout.write(`Cursor will record only ${project}\n${written}\n`);
      process.stdout.write(`In any project folder, run: blackbox-on\n${command}\n`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
