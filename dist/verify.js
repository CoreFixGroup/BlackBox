import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
export async function verifySession(store, sessionId, checks) {
    store.readRecording(sessionId);
    const results = [];
    for (const check of checks) {
        const outcome = await runCheck(check);
        const stored = {
            id: randomUUID(),
            timestamp: new Date().toISOString(),
            ...outcome,
        };
        store.appendVerification(sessionId, stored);
        results.push(stored);
    }
    return results;
}
async function runCheck(check) {
    if (check.type === "file.exists") {
        const exists = fs.existsSync(check.path);
        return outcome("file.exists", exists, exists ? `${check.path} exists` : `${check.path} is missing`);
    }
    if (check.type === "file.sha256") {
        if (!fs.existsSync(check.path) || !fs.statSync(check.path).isFile()) {
            return outcome("file.sha256", false, `${check.path} is missing`);
        }
        const digest = createHash("sha256").update(fs.readFileSync(check.path)).digest("hex");
        const matches = digest === check.sha256.toLowerCase();
        return outcome("file.sha256", matches, matches ? "hash matches" : "hash does not match");
    }
    if (check.type === "git.head") {
        try {
            const head = execFileSync("git", ["rev-parse", "HEAD"], {
                cwd: check.path,
                encoding: "utf8",
                stdio: ["ignore", "pipe", "pipe"],
            }).trim();
            const matches = head === check.commit;
            return outcome("git.head", matches, matches ? "HEAD matches" : "HEAD does not match");
        }
        catch (error) {
            const missing = typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
            return outcome("git.head", false, missing ? "git is not available" : "HEAD does not match");
        }
    }
    try {
        const result = await check.run();
        if (typeof result === "boolean")
            return outcome(check.name, result, result ? "passed" : "failed");
        return outcome(check.name, result.ok, result.message ?? (result.ok ? "passed" : "failed"));
    }
    catch (error) {
        const message = error instanceof Error && error.message.trim() !== "" ? error.message : "failed";
        return outcome(check.name, false, message);
    }
}
function outcome(name, ok, message) {
    return {
        type: "outcome.check",
        name,
        status: ok ? "passed" : "failed",
        basis: "verified",
        message,
    };
}
//# sourceMappingURL=verify.js.map