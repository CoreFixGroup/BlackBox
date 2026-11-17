import fs from "node:fs";
import path from "node:path";
import { compareRecordings } from "./compare.js";
import { Replay } from "./replay.js";
import { writeReport } from "./report.js";
import { Session } from "./session.js";
import { SessionStore } from "./store.js";
import { writeExport } from "./export.js";
import { verifySession } from "./verify.js";
export class Blackbox {
    store;
    constructor(store) {
        this.store = store;
    }
    static open(options = {}) {
        const directory = path.resolve(options.directory ?? ".blackbox");
        fs.mkdirSync(directory, { recursive: true });
        return new Blackbox(new SessionStore({
            directory,
            redactSecrets: options.redactSecrets ?? true,
            captureContent: options.captureContent ?? true,
        }));
    }
    startSession(input) {
        const header = this.store.startSession(input);
        return new Session(this.store, header);
    }
    listSessions() {
        return this.store.list();
    }
    getSession(sessionId) {
        return this.store.readRecording(sessionId);
    }
    exportSession(sessionId, outPath) {
        return writeExport(this.store, sessionId, outPath);
    }
    reportSession(sessionId, outPath) {
        return writeReport(this.store, sessionId, outPath);
    }
    replay(sessionId) {
        const recording = this.getSession(sessionId);
        const session = this.startSession({
            agent: recording.session.agent,
            metadata: { replayOf: sessionId },
        });
        return new Replay(session, recording);
    }
    compare(leftId, rightId) {
        return compareRecordings(this.getSession(leftId), this.getSession(rightId));
    }
    verify(sessionId, checks) {
        return verifySession(this.store, sessionId, checks);
    }
}
//# sourceMappingURL=blackbox.js.map