import type { ChildProcess, SpawnOptions, SpawnSyncOptions, ExecSyncOptions, ExecFileSyncOptions, ForkOptions } from "node:child_process";
import * as childProcess from "node:child_process";
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
export declare function installChildProcessCapture(ownerId: string, onNote: (record: ProcessRecord) => void): {
    api: RecordedProcesses;
    restore: () => void;
    flush: () => void;
};
