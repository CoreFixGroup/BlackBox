import type { SessionStore } from "./store.js";
import { type ExportDocument, type Recording } from "./types.js";
export declare function buildExport(recording: Recording, exportedAt: string): ExportDocument;
export declare function writeExport(store: SessionStore, sessionId: string, outPath?: string): {
    path: string;
    document: ExportDocument;
};
