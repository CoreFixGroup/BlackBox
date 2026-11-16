import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface FileStamp {
  bytes: number;
  hash: string;
}

export interface FileChange {
  path: string;
  action: "created" | "modified" | "deleted";
  bytes: number;
}

export function snapshotDirectory(root: string): Map<string, FileStamp> {
  const files = new Map<string, FileStamp>();
  let rootReal = root;
  try {
    rootReal = fs.realpathSync(root);
  } catch {
    return files;
  }
  walk(root, rootReal, root, files, new Set<string>());
  return files;
}

export function diffSnapshots(before: Map<string, FileStamp>, after: Map<string, FileStamp>): FileChange[] {
  const changes: FileChange[] = [];
  for (const [relativePath, stamp] of after) {
    const previous = before.get(relativePath);
    if (!previous) changes.push({ path: relativePath, action: "created", bytes: stamp.bytes });
    else if (previous.hash !== stamp.hash) {
      changes.push({ path: relativePath, action: "modified", bytes: stamp.bytes });
    }
  }
  for (const [relativePath, stamp] of before) {
    if (!after.has(relativePath)) changes.push({ path: relativePath, action: "deleted", bytes: stamp.bytes });
  }
  changes.sort((left, right) => left.path.localeCompare(right.path));
  return changes;
}

function walk(
  root: string,
  rootReal: string,
  current: string,
  files: Map<string, FileStamp>,
  seen: Set<string>,
): void {
  let realCurrent: string;
  try {
    realCurrent = fs.realpathSync(current);
  } catch {
    return;
  }
  if (!isInside(rootReal, realCurrent) || seen.has(realCurrent)) return;
  seen.add(realCurrent);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(current, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(current, entry.name);
    let real: string;
    try {
      real = fs.realpathSync(full);
    } catch {
      continue;
    }
    if (!isInside(rootReal, real)) continue;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(real);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      walk(root, rootReal, full, files, seen);
      continue;
    }
    if (!stat.isFile()) continue;
    const content = fs.readFileSync(real);
    files.set(path.relative(root, full).split(path.sep).join("/"), {
      bytes: content.byteLength,
      hash: createHash("sha256").update(content).digest("hex"),
    });
  }
}

function isInside(rootReal: string, target: string): boolean {
  const relative = path.relative(rootReal, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
