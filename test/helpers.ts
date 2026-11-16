import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const TEST_AGENT = { id: "test-agent", name: "Test Agent", version: "0.0.1" };

export function tempDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "blackbox-"));
}
