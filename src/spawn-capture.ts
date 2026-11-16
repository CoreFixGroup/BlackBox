import { createRequire } from "node:module";
import type { ChildProcess, SpawnOptions, SpawnSyncOptions, ExecSyncOptions, ExecFileSyncOptions, ForkOptions } from "node:child_process";
import * as childProcess from "node:child_process";

const require = createRequire(import.meta.url);

export interface ProcessRecord {
  command: string;
  args: string[];
  exitCode: number | null;
  durationMs: number;
}

export interface RecordedProcesses {
  spawn: (command: string, args?: readonly string[], options?: SpawnOptions) => ChildProcess;
  spawnSync: (command: string, args?: readonly string[], options?: SpawnSyncOptions) => ReturnType<typeof childProcess.spawnSync>;
  exec: (command: string, options?: unknown, callback?: unknown) => ChildProcess;
  execSync: (command: string, options?: ExecSyncOptions) => string | Buffer;
  execFile: (file: string, args?: readonly string[], options?: unknown, callback?: unknown) => ChildProcess;
  execFileSync: (file: string, args?: readonly string[], options?: ExecFileSyncOptions) => string | Buffer;
  fork: (modulePath: string, args?: readonly string[], options?: ForkOptions) => ChildProcess;
}

interface TrackedChild {
  command: string;
  args: string[];
  started: number;
  child: ChildProcess;
  noted: boolean;
}

interface MutableProcesses extends RecordedProcesses {}

interface ActiveCapture {
  ownerId: string;
  restore: () => void;
  flush: () => void;
  api: RecordedProcesses;
}

let active: ActiveCapture | undefined;

export function installChildProcessCapture(
  ownerId: string,
  onNote: (record: ProcessRecord) => void,
): { api: RecordedProcesses; restore: () => void; flush: () => void } {
  if (active?.ownerId === ownerId) return active;
  if (active) throw new Error("Process capture is already active");

  const target = require("node:child_process") as MutableProcesses;
  const original = {
    spawn: target.spawn,
    spawnSync: target.spawnSync,
    exec: target.exec,
    execSync: target.execSync,
    execFile: target.execFile,
    execFileSync: target.execFileSync,
    fork: target.fork,
  };
  const tracked: TrackedChild[] = [];

  const note = (command: string, args: readonly string[] | undefined, started: number, exitCode: number | null) => {
    onNote({
      command,
      args: [...(args ?? [])],
      exitCode,
      durationMs: Date.now() - started,
    });
  };

  const track = (child: ChildProcess, command: string, args: readonly string[] | undefined, started: number) => {
    const item: TrackedChild = { command, args: [...(args ?? [])], started, child, noted: false };
    tracked.push(item);
    child.once("exit", (code) => {
      if (item.noted) return;
      item.noted = true;
      note(command, args, started, code);
    });
  };

  const api: RecordedProcesses = {
    spawn(command, args, options) {
      const started = Date.now();
      const child = original.spawn(command, [...(args ?? [])], options ?? {}) as ChildProcess;
      track(child, command, args, started);
      return child;
    },
    spawnSync(command, args, options) {
      const started = Date.now();
      const result = original.spawnSync(command, args ?? [], options);
      note(command, args, started, result.status);
      return result;
    },
    exec(command, options, callback) {
      const started = Date.now();
      const child = original.exec(command, options, callback);
      track(child, command, [], started);
      return child;
    },
    execSync(command, options) {
      const started = Date.now();
      try {
        const result = original.execSync(command, options);
        note(command, [], started, 0);
        return result;
      } catch (error) {
        note(command, [], started, exitStatus(error));
        throw error;
      }
    },
    execFile(file, args, options, callback) {
      const started = Date.now();
      const child = original.execFile(file, args, options, callback);
      track(child, file, args, started);
      return child;
    },
    execFileSync(file, args, options) {
      const started = Date.now();
      try {
        const result = original.execFileSync(file, args, options);
        note(file, args, started, 0);
        return result;
      } catch (error) {
        note(file, args, started, exitStatus(error));
        throw error;
      }
    },
    fork(modulePath, args, options) {
      const started = Date.now();
      const child = original.fork(modulePath, args, options);
      track(child, modulePath, args, started);
      return child;
    },
  };

  Object.assign(target, api);

  const restore = (): void => {
    if (active?.ownerId !== ownerId) return;
    Object.assign(target, original);
    active = undefined;
  };
  const flush = (): void => {
    for (const item of tracked) {
      if (item.noted) continue;
      item.noted = true;
      note(item.command, item.args, item.started, item.child.exitCode);
    }
  };
  active = { ownerId, restore, flush, api };
  return active;
}

function exitStatus(error: unknown): number | null {
  if (typeof error === "object" && error !== null && "status" in error) {
    const status = (error as { status?: number | null }).status;
    return status ?? null;
  }
  return null;
}
