import fs from "node:fs";
import path from "node:path";

import { compareRecordings } from "./compare.js";
import { Replay } from "./replay.js";
import { writeReport } from "./report.js";
import { Session } from "./session.js";
import { SessionStore } from "./store.js";
import type {
  Comparison,
  ExportDocument,
  OpenOptions,
  OutcomeCheck,
  Recording,
  SessionStartInput,
  SessionSummary,
  VerificationCheck,
} from "./types.js";
import { writeExport } from "./export.js";
import { verifySession } from "./verify.js";

export class Blackbox {
  private constructor(private readonly store: SessionStore) {}

  static open(options: OpenOptions = {}): Blackbox {
    const directory = path.resolve(options.directory ?? ".blackbox");
    fs.mkdirSync(directory, { recursive: true });
    return new Blackbox(
      new SessionStore({
        directory,
        redactSecrets: options.redactSecrets ?? true,
        captureContent: options.captureContent ?? true,
      }),
    );
  }

  startSession(input: SessionStartInput): Session {
    const header = this.store.startSession(input);
    return new Session(this.store, header);
  }

  listSessions(): SessionSummary[] {
    return this.store.list();
  }

  getSession(sessionId: string): Recording {
    return this.store.readRecording(sessionId);
  }

  exportSession(sessionId: string, outPath?: string): { path: string; document: ExportDocument } {
    return writeExport(this.store, sessionId, outPath);
  }

  reportSession(sessionId: string, outPath?: string): string {
    return writeReport(this.store, sessionId, outPath);
  }

  replay(sessionId: string): Replay {
    const recording = this.getSession(sessionId);
    const session = this.startSession({
      agent: recording.session.agent,
      metadata: { replayOf: sessionId },
    });
    return new Replay(session, recording);
  }

  compare(leftId: string, rightId: string): Comparison {
    return compareRecordings(this.getSession(leftId), this.getSession(rightId));
  }

  verify(sessionId: string, checks: VerificationCheck[]): Promise<OutcomeCheck[]> {
    return verifySession(this.store, sessionId, checks);
  }
}
