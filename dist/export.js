import fs from "node:fs";
import path from "node:path";
import { writeJsonAtomic } from "./atomic.js";
import { sessionDirectory } from "./paths.js";
import { SCHEMA_VERSION } from "./types.js";
export function buildExport(recording, exportedAt) {
    return {
        schemaVersion: SCHEMA_VERSION,
        exportedAt,
        session: recording.session,
        events: recording.events,
        integrity: recording.integrity,
    };
}
export function writeExport(store, sessionId, outPath) {
    const recording = store.readRecording(sessionId);
    const document = buildExport(recording, new Date().toISOString());
    const target = outPath
        ? path.resolve(outPath)
        : path.join(sessionDirectory(store.directory, sessionId), "export.json");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    writeJsonAtomic(target, document);
    return { path: target, document };
}
//# sourceMappingURL=export.js.map