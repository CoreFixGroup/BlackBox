import path from "node:path";
export function assertSafeSessionId(sessionId) {
    if (sessionId.length === 0 ||
        sessionId === "." ||
        sessionId === ".." ||
        sessionId.includes("/") ||
        sessionId.includes("\\") ||
        sessionId.includes("..")) {
        throw new Error("Invalid session id");
    }
}
export function sessionsRoot(directory) {
    return path.join(directory, "sessions");
}
export function sessionDirectory(directory, sessionId) {
    assertSafeSessionId(sessionId);
    return path.join(sessionsRoot(directory), sessionId);
}
export function sessionHeaderPath(directory, sessionId) {
    return path.join(sessionDirectory(directory, sessionId), "session.json");
}
export function eventsPath(directory, sessionId) {
    return path.join(sessionDirectory(directory, sessionId), "events.jsonl");
}
export function verificationPath(directory, sessionId) {
    return path.join(sessionDirectory(directory, sessionId), "verification.jsonl");
}
//# sourceMappingURL=paths.js.map