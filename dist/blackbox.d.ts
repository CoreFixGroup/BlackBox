import { Replay } from "./replay.js";
import { Session } from "./session.js";
import type { Comparison, ExportDocument, OpenOptions, OutcomeCheck, Recording, SessionStartInput, SessionSummary, VerificationCheck } from "./types.js";
export declare class Blackbox {
    private readonly store;
    private constructor();
    static open(options?: OpenOptions): Blackbox;
    startSession(input: SessionStartInput): Session;
    listSessions(): SessionSummary[];
    getSession(sessionId: string): Recording;
    exportSession(sessionId: string, outPath?: string): {
        path: string;
        document: ExportDocument;
    };
    reportSession(sessionId: string, outPath?: string): string;
    replay(sessionId: string): Replay;
    compare(leftId: string, rightId: string): Comparison;
    verify(sessionId: string, checks: VerificationCheck[]): Promise<OutcomeCheck[]>;
}
