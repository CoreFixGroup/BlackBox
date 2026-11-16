#!/usr/bin/env node
import { Blackbox } from "./blackbox.js";
import { isDirectRun } from "./direct.js";
import { formatComparison, formatRecording } from "./format.js";
import type { VerificationCheck } from "./types.js";

const USAGE = `Blackbox records observable AI-agent execution on this machine.

Usage:
  blackbox list [--dir <path>]
  blackbox show <sessionId> [--dir <path>]
  blackbox export <sessionId> [--dir <path>] [--out <file>]
  blackbox report <sessionId> [--dir <path>] [--out <file>]
  blackbox compare <sessionId> <sessionId> [--dir <path>]
  blackbox verify <sessionId> [--dir <path>] [--exists <path>] [--sha256 <path>=<hex>] [--git-head <path>=<commit>]

Default directory: .blackbox
`;

interface CliArgs {
  command: "help" | "list" | "show" | "export" | "report" | "compare" | "verify";
  dir: string;
  sessionIds: string[];
  out?: string;
  exists: string[];
  sha256: string[];
  gitHead: string[];
}

export async function main(argv: string[] = process.argv): Promise<number> {
  try {
    const parsed = parseArgs(argv);
    if (parsed.command === "help") {
      process.stdout.write(USAGE);
      return 0;
    }

    const blackbox = Blackbox.open({ directory: parsed.dir });
    if (parsed.command === "list") {
      process.stdout.write(formatList(blackbox.listSessions()));
      return 0;
    }

    if (parsed.command === "compare") {
      const [leftId, rightId] = parsed.sessionIds;
      if (!leftId || !rightId) throw new Error("compare requires two session ids");
      process.stdout.write(formatComparison(blackbox.compare(leftId, rightId)));
      return 0;
    }

    const sessionId = parsed.sessionIds[0];
    if (!sessionId) throw new Error(`${parsed.command} requires a session id`);

    if (parsed.command === "show") {
      process.stdout.write(formatRecording(blackbox.getSession(sessionId)));
      return 0;
    }
    if (parsed.command === "export") {
      const result = blackbox.exportSession(sessionId, parsed.out);
      process.stdout.write(`${result.path}\n`);
      return 0;
    }
    if (parsed.command === "verify") {
      const checks = verificationChecks(parsed);
      if (checks.length === 0) throw new Error("verify requires --exists, --sha256, or --git-head");
      const results = await blackbox.verify(sessionId, checks);
      for (const result of results) {
        process.stdout.write(`${result.status}  ${result.name}  ${result.message}\n`);
      }
      return results.some((result) => result.status === "failed") ? 1 : 0;
    }

    const reportPath = blackbox.reportSession(sessionId, parsed.out);
    process.stdout.write(`${reportPath}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    if (!message.includes("Usage:")) process.stderr.write(`\n${USAGE}`);
    return 1;
  }
}

export function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    return { command: "help", dir: ".blackbox", sessionIds: [], exists: [], sha256: [], gitHead: [] };
  }

  const command = args[0];
  if (
    command !== "list" &&
    command !== "show" &&
    command !== "export" &&
    command !== "report" &&
    command !== "compare" &&
    command !== "verify"
  ) {
    throw new Error(`Unknown command: ${command}\n\n${USAGE}`);
  }

  let dir = ".blackbox";
  let out: string | undefined;
  const exists: string[] = [];
  const sha256: string[] = [];
  const gitHead: string[] = [];
  const positionals: string[] = [];
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--dir" || arg === "--out" || arg === "--exists" || arg === "--sha256" || arg === "--git-head") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${arg} requires a value`);
      }
      if (arg === "--dir") dir = value;
      else if (arg === "--out") out = value;
      else if (arg === "--exists") exists.push(value);
      else if (arg === "--sha256") sha256.push(value);
      else gitHead.push(value);
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) throw new Error(`Unknown option: ${arg}`);
    positionals.push(arg);
  }

  if (command === "list" && positionals.length > 0) {
    throw new Error("list does not take a session id");
  }
  if (command === "compare" && positionals.length !== 2) {
    throw new Error("compare requires two session ids");
  }
  if (command !== "list" && command !== "compare" && positionals.length !== 1) {
    throw new Error(`${command} requires a session id`);
  }
  if (out !== undefined && command !== "export" && command !== "report") {
    throw new Error("--out is only valid for export and report");
  }
  if ((exists.length > 0 || sha256.length > 0 || gitHead.length > 0) && command !== "verify") {
    throw new Error("--exists, --sha256, and --git-head are only valid for verify");
  }

  return { command, dir, out, sessionIds: positionals, exists, sha256, gitHead };
}

function verificationChecks(args: CliArgs): VerificationCheck[] {
  const checks: VerificationCheck[] = [];
  for (const filePath of args.exists) checks.push({ type: "file.exists", path: filePath });
  for (const value of args.sha256) {
    const splitAt = value.lastIndexOf("=");
    if (splitAt <= 0) throw new Error("--sha256 expects path=hex");
    checks.push({ type: "file.sha256", path: value.slice(0, splitAt), sha256: value.slice(splitAt + 1) });
  }
  for (const value of args.gitHead) {
    const splitAt = value.lastIndexOf("=");
    if (splitAt <= 0) throw new Error("--git-head expects path=commit");
    checks.push({ type: "git.head", path: value.slice(0, splitAt), commit: value.slice(splitAt + 1) });
  }
  return checks;
}

function formatList(sessions: ReturnType<Blackbox["listSessions"]>): string {
  if (sessions.length === 0) return "No recordings found.\n";
  return (
    sessions
      .map((session) => {
        const complete = session.complete ? "complete" : "incomplete";
        return `${session.id}  ${session.status}  ${complete}  ${session.agent.name}  ${session.startedAt}  ${session.eventCount} events`;
      })
      .join("\n") + "\n"
  );
}

if (isDirectRun(import.meta.url)) {
  Promise.resolve(main()).then((code) => {
    process.exit(code);
  });
}
