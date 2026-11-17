import { type BlackboxEvent, type EventSource, type FinishInput, type OutcomeCheck, type Recording, type SessionHeader, type SessionStartInput, type SessionSummary } from "./types.js";
export interface AppendEventInput {
    type: string;
    agentId: string;
    parentEventId?: string;
    data: Record<string, unknown>;
    source?: EventSource;
}
export declare class SessionStore {
    readonly directory: string;
    private readonly redactSecrets;
    private readonly captureContent;
    private readonly sequences;
    private headerWriteFailures;
    constructor(options: {
        directory: string;
        redactSecrets: boolean;
        captureContent: boolean;
    });
    startSession(input: SessionStartInput): SessionHeader;
    append(sessionId: string, input: AppendEventInput): BlackboxEvent;
    failNextHeaderWrite(): void;
    finalize(sessionId: string, status: NonNullable<FinishInput["status"]>, summary: string | null): SessionHeader;
    list(): SessionSummary[];
    readRecording(sessionId: string): Recording;
    readVerification(sessionId: string): OutcomeCheck[];
    appendVerification(sessionId: string, check: OutcomeCheck): void;
    private prepareData;
    private protect;
    private nextSequence;
    private writeHeader;
    private readHeader;
    private loadHeader;
}
