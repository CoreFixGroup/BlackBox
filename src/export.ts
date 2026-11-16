import fs from "node:fs";
import path from "node:path";

import { writeJsonAtomic } from "./atomic.js";
import { sessionDirectory } from "./paths.js";
import type { SessionStore } from "./store.js";
import { SCHEMA_VERSION, type ExportDocument, type Recording } from "./types.js";

export function buildExport(recording: Recording, exportedAt: string): ExportDocument {
  return {
    schemaVersion: SCHEMA_VERSION,
    exportedAt,
    session: recording.session,
    events: recording.events,
    integrity: recording.integrity,
  };
}

export function writeExport(
  store: SessionStore,
  sessionId: string,
  outPath?: string,
): { path: string; document: ExportDocument } {
  const recording = store.readRecording(sessionId);
  const document = buildExport(recording, new Date().toISOString());
  const target = outPath
    ? path.resolve(outPath)
    : path.join(sessionDirectory(store.directory, sessionId), "export.json");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  writeJsonAtomic(target, document);
  return { path: target, document };
}
