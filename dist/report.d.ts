import type { SessionStore } from "./store.js";
import { type Recording } from "./types.js";
export declare function renderReport(recording: Recording): string;
export declare function writeReport(store: SessionStore, sessionId: string, outPath?: string): string;
