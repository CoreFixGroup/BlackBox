import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function isDirectRun(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    const entryPath = fs.realpathSync(path.resolve(entry));
    const modulePath = fs.realpathSync(fileURLToPath(metaUrl));
    return process.platform === "win32"
      ? entryPath.toLowerCase() === modulePath.toLowerCase()
      : entryPath === modulePath;
  } catch {
    return false;
  }
}
