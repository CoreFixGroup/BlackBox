#!/usr/bin/env node
interface CliArgs {
    command: "help" | "list" | "show" | "export" | "report" | "compare" | "verify";
    dir: string;
    sessionIds: string[];
    out?: string;
    exists: string[];
    sha256: string[];
    gitHead: string[];
}
export declare function main(argv?: string[]): Promise<number>;
export declare function parseArgs(argv: string[]): CliArgs;
export {};
