import path from "node:path";

export function assertSafeSessionId(sessionId: string): void {
  if (
    sessionId.length === 0 ||
    sessionId === "." ||
    sessionId === ".." ||
    sessionId.includes("/") ||
    sessionId.includes("\\") ||
    sessionId.includes("..")
  ) {
    throw new Error("Invalid session id");
  }
}

export function sessionsRoot(directory: string): string {
  return path.join(directory, "sessions");
}

export function sessionDirectory(directory: string, sessionId: string): string {
  assertSafeSessionId(sessionId);
  return path.join(sessionsRoot(directory), sessionId);
}

export function sessionHeaderPath(directory: string, sessionId: string): string {
  return path.join(sessionDirectory(directory, sessionId), "session.json");
}

export function eventsPath(directory: string, sessionId: string): string {
  return path.join(sessionDirectory(directory, sessionId), "events.jsonl");
}

export function verificationPath(directory: string, sessionId: string): string {
  return path.join(sessionDirectory(directory, sessionId), "verification.jsonl");
}
