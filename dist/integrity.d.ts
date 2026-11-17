import type { BlackboxEvent, Integrity, SessionHeader } from "./types.js";
export declare function assessIntegrity(session: SessionHeader, events: BlackboxEvent[], parseGaps: string[]): Integrity;
