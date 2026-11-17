import type { SessionStore } from "./store.js";
import type { OutcomeCheck, VerificationCheck } from "./types.js";
export declare function verifySession(store: SessionStore, sessionId: string, checks: VerificationCheck[]): Promise<OutcomeCheck[]>;
