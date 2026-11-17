import fs from "node:fs";
import path from "node:path";
import { cursorHookResponse, handleCursorHook } from "./cursor-adapter.js";
import { isDirectRun } from "./direct.js";
export async function main(stdin = process.stdin) {
    let response = cursorHookResponse("");
    try {
        const raw = await readStdin(stdin);
        if (raw.trim() !== "") {
            const parsed = JSON.parse(raw);
            response = cursorHookResponse(eventName(parsed));
            const directory = recordingDirectory(parsed, {
                envDir: process.env.BLACKBOX_DIR,
                plugin: process.argv.includes("--plugin"),
            });
            if (directory !== undefined)
                response = handleCursorHook(parsed, directory);
        }
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`blackbox cursor hook: ${message}\n`);
    }
    process.stdout.write(`${JSON.stringify(response)}\n`);
}
export function recordingDirectory(input, options = {}) {
    if (options.envDir !== undefined && options.envDir.length > 0)
        return options.envDir;
    const workspace = workspaceRoot(input);
    if (workspace === undefined)
        return options.plugin ? undefined : ".blackbox";
    if (options.plugin && projectHookInstalled(workspace))
        return undefined;
    const cwd = options.cwd ?? process.cwd();
    if (projectHookInstalled(workspace) && !sameDirectory(cwd, workspace))
        return undefined;
    return path.join(workspace, ".blackbox");
}
function eventName(input) {
    if (typeof input !== "object" || input === null)
        return "";
    const name = input.hook_event_name;
    return typeof name === "string" ? name : "";
}
function workspaceRoot(input) {
    if (typeof input !== "object" || input === null)
        return undefined;
    const roots = input.workspace_roots;
    if (!Array.isArray(roots) || typeof roots[0] !== "string" || roots[0].length === 0)
        return undefined;
    return normalizeWorkspace(roots[0]);
}
function normalizeWorkspace(value) {
    let raw = value.replaceAll("\\", "/");
    if (/^\/[A-Za-z]:\//.test(raw))
        raw = raw.slice(1);
    return path.resolve(raw);
}
function projectHookInstalled(workspace) {
    try {
        return fs.readFileSync(path.join(workspace, ".cursor", "hooks.json"), "utf8").includes("cursor-hook.js");
    }
    catch {
        return false;
    }
}
function sameDirectory(left, right) {
    const a = path.resolve(left);
    const b = path.resolve(right);
    return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
async function readStdin(stdin) {
    const chunks = [];
    for await (const chunk of stdin)
        chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8");
}
if (isDirectRun(import.meta.url)) {
    await main();
}
//# sourceMappingURL=cursor-hook.js.map