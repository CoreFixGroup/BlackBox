import path from "node:path";
import { pathToFileURL } from "node:url";

export function isDirectRun(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return pathToFileURL(path.resolve(entry)).href.toLowerCase() === metaUrl.toLowerCase();
}
