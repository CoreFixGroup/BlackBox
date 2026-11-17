import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
let active;
export function installChildProcessCapture(ownerId, onNote) {
    if (active?.ownerId === ownerId)
        return active;
    if (active)
        throw new Error("Process capture is already active");
    const target = require("node:child_process");
    const original = {
        spawn: target.spawn,
        spawnSync: target.spawnSync,
        exec: target.exec,
        execSync: target.execSync,
        execFile: target.execFile,
        execFileSync: target.execFileSync,
        fork: target.fork,
    };
    const tracked = [];
    const note = (command, args, started, exitCode) => {
        onNote({
            command,
            args: [...(args ?? [])],
            exitCode,
            durationMs: Date.now() - started,
        });
    };
    const track = (child, command, args, started) => {
        const item = { command, args: [...(args ?? [])], started, child, noted: false };
        tracked.push(item);
        child.once("exit", (code) => {
            if (item.noted)
                return;
            item.noted = true;
            note(command, args, started, code);
        });
    };
    const api = {
        spawn(command, args, options) {
            const started = Date.now();
            const child = original.spawn(command, [...(args ?? [])], options ?? {});
            track(child, command, args, started);
            return child;
        },
        spawnSync(command, args, options) {
            const started = Date.now();
            const result = original.spawnSync(command, args ?? [], options);
            note(command, args, started, result.status);
            return result;
        },
        exec(command, options, callback) {
            const started = Date.now();
            const child = original.exec(command, options, callback);
            track(child, command, [], started);
            return child;
        },
        execSync(command, options) {
            const started = Date.now();
            try {
                const result = original.execSync(command, options);
                note(command, [], started, 0);
                return result;
            }
            catch (error) {
                note(command, [], started, exitStatus(error));
                throw error;
            }
        },
        execFile(file, args, options, callback) {
            const started = Date.now();
            const child = original.execFile(file, args, options, callback);
            track(child, file, args, started);
            return child;
        },
        execFileSync(file, args, options) {
            const started = Date.now();
            try {
                const result = original.execFileSync(file, args, options);
                note(file, args, started, 0);
                return result;
            }
            catch (error) {
                note(file, args, started, exitStatus(error));
                throw error;
            }
        },
        fork(modulePath, args, options) {
            const started = Date.now();
            const child = original.fork(modulePath, args, options);
            track(child, modulePath, args, started);
            return child;
        },
    };
    Object.assign(target, api);
    const restore = () => {
        if (active?.ownerId !== ownerId)
            return;
        Object.assign(target, original);
        active = undefined;
    };
    const flush = () => {
        for (const item of tracked) {
            if (item.noted)
                continue;
            item.noted = true;
            note(item.command, item.args, item.started, item.child.exitCode);
        }
    };
    active = { ownerId, restore, flush, api };
    return active;
}
function exitStatus(error) {
    if (typeof error === "object" && error !== null && "status" in error) {
        const status = error.status;
        return status ?? null;
    }
    return null;
}
//# sourceMappingURL=spawn-capture.js.map