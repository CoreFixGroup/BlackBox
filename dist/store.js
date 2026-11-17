import fs from "node:fs";
import { appendLine, fsyncFile, writeJsonAtomic } from "./atomic.js";
import { normalizeAgent } from "./agent.js";
import { assessIntegrity } from "./integrity.js";
import { assertSafeSessionId, eventsPath, sessionDirectory, sessionHeaderPath, sessionsRoot, verificationPath } from "./paths.js";
import { applyCapturePolicy, dropUndefined, isPlainObject, redactValue } from "./redact.js";
import { SCHEMA_VERSION, isEventSource, } from "./types.js";
export class SessionStore {
    directory;
    redactSecrets;
    captureContent;
    sequences = new Map();
    headerWriteFailures = 0;
    constructor(options) {
        this.directory = options.directory;
        this.redactSecrets = options.redactSecrets;
        this.captureContent = options.captureContent;
    }
    startSession(input) {
        const agent = normalizeAgent(input.agent);
        if (input.metadata !== undefined && !isPlainObject(input.metadata)) {
            throw new Error("metadata must be an object");
        }
        const id = input.id ?? crypto.randomUUID();
        assertSafeSessionId(id);
        if (fs.existsSync(sessionDirectory(this.directory, id))) {
            throw new Error(`Session ${id} already exists`);
        }
        const startedAt = new Date().toISOString();
        const metadata = this.protect(input.metadata ?? {});
        const header = {
            schemaVersion: SCHEMA_VERSION,
            id,
            agent,
            status: "running",
            startedAt,
            finishedAt: null,
            metadata,
            captureContent: this.captureContent,
            redactSecrets: this.redactSecrets,
            eventCount: 0,
            lastSequence: 0,
            finishSummary: null,
        };
        fs.mkdirSync(sessionDirectory(this.directory, id), { recursive: true });
        this.writeHeader(header);
        this.sequences.set(id, 0);
        this.append(id, {
            type: "session.started",
            agentId: agent.id,
            data: { agent, metadata },
        });
        return header;
    }
    append(sessionId, input) {
        const header = this.readHeader(sessionId);
        if (header.status !== "running") {
            throw new Error(`Session ${sessionId} is already ${header.status}`);
        }
        const sequence = this.nextSequence(sessionId);
        const event = {
            schemaVersion: SCHEMA_VERSION,
            id: crypto.randomUUID(),
            sessionId,
            sequence,
            type: input.type,
            timestamp: new Date().toISOString(),
            source: input.source ?? "integration",
            agentId: input.agentId,
            data: this.prepareData(input.data),
        };
        if (input.parentEventId !== undefined) {
            event.parentEventId = input.parentEventId;
        }
        appendLine(eventsPath(this.directory, sessionId), JSON.stringify(event));
        this.sequences.set(sessionId, sequence);
        return event;
    }
    failNextHeaderWrite() {
        this.headerWriteFailures += 1;
    }
    finalize(sessionId, status, summary) {
        const filePath = eventsPath(this.directory, sessionId);
        fsyncFile(filePath);
        const parsed = readEventLines(filePath, sessionId);
        const header = this.readHeader(sessionId);
        if (header.status !== "running") {
            throw new Error(`Session ${sessionId} is already ${header.status}`);
        }
        const updated = {
            ...header,
            status,
            finishedAt: new Date().toISOString(),
            eventCount: parsed.events.length,
            lastSequence: parsed.events.at(-1)?.sequence ?? 0,
            finishSummary: summary,
        };
        this.writeHeader(updated);
        return updated;
    }
    list() {
        const root = sessionsRoot(this.directory);
        if (!fs.existsSync(root))
            return [];
        const summaries = [];
        for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
            if (!entry.isDirectory())
                continue;
            const headerPath = sessionHeaderPath(this.directory, entry.name);
            if (!fs.existsSync(headerPath))
                continue;
            try {
                const recording = this.readRecording(entry.name);
                summaries.push(toSummary(recording));
            }
            catch {
                summaries.push({
                    id: entry.name,
                    agent: { id: "unknown", name: "unreadable session" },
                    status: "running",
                    startedAt: "",
                    finishedAt: null,
                    eventCount: 0,
                    complete: false,
                });
            }
        }
        summaries.sort((left, right) => {
            const byTime = left.startedAt.localeCompare(right.startedAt);
            return byTime === 0 ? left.id.localeCompare(right.id) : byTime;
        });
        return summaries;
    }
    readRecording(sessionId) {
        const loaded = this.loadHeader(sessionId);
        const parsed = readEventLines(eventsPath(this.directory, sessionId), sessionId);
        if (!loaded.header) {
            if (loaded.missing)
                throw new Error(loaded.error);
            const session = unreadableSession(sessionId);
            return {
                session,
                events: parsed.events,
                integrity: assessIntegrity(session, parsed.events, [loaded.error, ...parsed.gaps]),
                verification: this.readVerification(sessionId),
            };
        }
        return {
            session: loaded.header,
            events: parsed.events,
            integrity: assessIntegrity(loaded.header, parsed.events, parsed.gaps),
            verification: this.readVerification(sessionId),
        };
    }
    readVerification(sessionId) {
        const filePath = verificationPath(this.directory, sessionId);
        if (!fs.existsSync(filePath))
            return [];
        const checks = [];
        for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
            if (line.length === 0)
                continue;
            try {
                const parsed = JSON.parse(line);
                if (isOutcomeCheck(parsed))
                    checks.push(parsed);
            }
            catch {
                continue;
            }
        }
        return checks;
    }
    appendVerification(sessionId, check) {
        this.readHeader(sessionId);
        appendLine(verificationPath(this.directory, sessionId), JSON.stringify(check));
    }
    prepareData(data) {
        const captured = applyCapturePolicy(dropUndefined(data), this.captureContent);
        return this.protect(captured);
    }
    protect(value) {
        const redacted = this.redactSecrets ? redactValue(value) : value;
        return JSON.parse(JSON.stringify(redacted));
    }
    nextSequence(sessionId) {
        const current = this.sequences.get(sessionId);
        if (current !== undefined)
            return current + 1;
        const parsed = readEventLines(eventsPath(this.directory, sessionId), sessionId);
        return (parsed.events.at(-1)?.sequence ?? 0) + 1;
    }
    writeHeader(header) {
        if (this.headerWriteFailures > 0) {
            this.headerWriteFailures -= 1;
            throw new Error("header write failed");
        }
        writeJsonAtomic(sessionHeaderPath(this.directory, header.id), header);
    }
    readHeader(sessionId) {
        const loaded = this.loadHeader(sessionId);
        if (!loaded.header)
            throw new Error(loaded.error);
        return loaded.header;
    }
    loadHeader(sessionId) {
        const filePath = sessionHeaderPath(this.directory, sessionId);
        if (!fs.existsSync(filePath)) {
            return { header: null, error: `Session not found: ${sessionId}`, missing: true };
        }
        let parsed;
        try {
            parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
        }
        catch {
            return { header: null, error: `invalid session.json for ${sessionId}`, missing: false };
        }
        if (!isSessionHeader(parsed) || parsed.id !== sessionId) {
            return { header: null, error: `invalid session.json for ${sessionId}`, missing: false };
        }
        return { header: parsed, error: "", missing: false };
    }
}
function toSummary(recording) {
    return {
        id: recording.session.id,
        agent: recording.session.agent,
        status: recording.session.status,
        startedAt: recording.session.startedAt,
        finishedAt: recording.session.finishedAt,
        eventCount: recording.integrity.eventCount,
        complete: recording.integrity.complete,
    };
}
function unreadableSession(sessionId) {
    return {
        schemaVersion: SCHEMA_VERSION,
        id: sessionId,
        agent: { id: "unknown", name: "unreadable session" },
        status: "running",
        startedAt: "",
        finishedAt: null,
        metadata: {},
        captureContent: false,
        redactSecrets: true,
        eventCount: 0,
        lastSequence: 0,
        finishSummary: null,
    };
}
function readEventLines(filePath, sessionId) {
    if (!fs.existsSync(filePath)) {
        return { events: [], gaps: ["events.jsonl is missing"] };
    }
    const raw = fs.readFileSync(filePath, "utf8");
    if (raw.length === 0)
        return { events: [], gaps: [] };
    const endsWithNewline = raw.endsWith("\n");
    const lines = raw.split("\n");
    if (endsWithNewline)
        lines.pop();
    const events = [];
    const gaps = [];
    lines.forEach((line, index) => {
        if (line.length === 0) {
            gaps.push(`blank line at ${index + 1}`);
            return;
        }
        try {
            const parsed = JSON.parse(line);
            if (!isEvent(parsed)) {
                gaps.push(`invalid event at line ${index + 1}`);
                return;
            }
            if (parsed.sessionId !== sessionId) {
                gaps.push(`event ${parsed.sequence} belongs to session ${parsed.sessionId}`);
            }
            if (!isEventSource(parsed.source)) {
                gaps.push(`event ${parsed.sequence} source is not recognized`);
            }
            events.push(parsed);
        }
        catch {
            const isLast = index === lines.length - 1;
            gaps.push(isLast && !endsWithNewline
                ? "truncated final line discarded"
                : `invalid JSON at line ${index + 1}`);
        }
    });
    return { events, gaps };
}
function isEvent(value) {
    if (!isPlainObject(value))
        return false;
    return (value.schemaVersion === SCHEMA_VERSION &&
        typeof value.id === "string" &&
        typeof value.sessionId === "string" &&
        typeof value.sequence === "number" &&
        Number.isInteger(value.sequence) &&
        typeof value.type === "string" &&
        value.type.length > 0 &&
        typeof value.timestamp === "string" &&
        typeof value.source === "string" &&
        typeof value.agentId === "string" &&
        isPlainObject(value.data) &&
        (value.parentEventId === undefined || typeof value.parentEventId === "string"));
}
function isSessionHeader(value) {
    if (!isPlainObject(value))
        return false;
    const agent = value.agent;
    return (value.schemaVersion === SCHEMA_VERSION &&
        typeof value.id === "string" &&
        isAgent(agent) &&
        isStatus(value.status) &&
        typeof value.startedAt === "string" &&
        (value.finishedAt === null || typeof value.finishedAt === "string") &&
        isPlainObject(value.metadata) &&
        typeof value.captureContent === "boolean" &&
        typeof value.redactSecrets === "boolean" &&
        typeof value.eventCount === "number" &&
        typeof value.lastSequence === "number" &&
        (value.finishSummary === null || typeof value.finishSummary === "string"));
}
function isAgent(value) {
    return isPlainObject(value) && typeof value.id === "string" && typeof value.name === "string";
}
function isStatus(value) {
    return value === "running" || value === "completed" || value === "failed";
}
function isOutcomeCheck(value) {
    if (!isPlainObject(value))
        return false;
    return (typeof value.id === "string" &&
        typeof value.timestamp === "string" &&
        value.type === "outcome.check" &&
        typeof value.name === "string" &&
        (value.status === "passed" || value.status === "failed") &&
        value.basis === "verified" &&
        typeof value.message === "string");
}
//# sourceMappingURL=store.js.map