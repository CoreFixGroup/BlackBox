import { execFileSync } from "node:child_process";
import path from "node:path";

export interface GitStatus {
  available: boolean;
  inside: boolean;
  paths: string[];
  summary: string;
}

export function collectGitStatus(root: string, command = "git"): GitStatus {
  const options = gitOptions(root);
  try {
    execFileSync(command, ["rev-parse", "--is-inside-work-tree"], options);
  } catch (error) {
    if (isMissing(error)) return { available: false, inside: false, paths: [], summary: "" };
    return { available: true, inside: false, paths: [], summary: "not a git repository" };
  }

  try {
    const porcelain = execFileSync(command, ["status", "--porcelain"], options);
    const text = porcelain.trim();
    return {
      available: true,
      inside: true,
      paths: text.length === 0 ? [] : porcelainPaths(text),
      summary: text.length === 0 ? "clean" : text.slice(0, 2000),
    };
  } catch (error) {
    if (isMissing(error)) return { available: false, inside: false, paths: [], summary: "" };
    return { available: true, inside: true, paths: [], summary: "git status failed" };
  }
}

export function porcelainPaths(text: string): string[] {
  const paths: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.length < 4) continue;
    const rest = line.slice(3).trim();
    const arrow = rest.indexOf(" -> ");
    if (arrow === -1) {
      paths.push(unquote(rest));
      continue;
    }
    paths.push(unquote(rest.slice(0, arrow).trim()));
    paths.push(unquote(rest.slice(arrow + 4).trim()));
  }
  return paths.filter((item) => item.length > 0);
}

function gitOptions(root: string): { cwd: string; stdio: ["ignore", "pipe", "pipe"]; encoding: "utf8"; env: NodeJS.ProcessEnv } {
  return {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(path.resolve(root)) },
  };
}

function unquote(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return value;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT";
}
