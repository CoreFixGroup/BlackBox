import { execFileSync } from "node:child_process";
import path from "node:path";
export function collectGitStatus(root, command = "git") {
    const options = gitOptions(root);
    try {
        execFileSync(command, ["rev-parse", "--is-inside-work-tree"], options);
    }
    catch (error) {
        if (isMissing(error))
            return { available: false, inside: false, paths: [], summary: "" };
        return { available: true, inside: false, paths: [], summary: "not a git repository" };
    }
    try {
        const porcelain = execFileSync(command, ["status", "--porcelain"], options);
        const text = porcelain.trim();
        return {
            available: true,
            inside: true,
            paths: text.length === 0 ? [] : porcelainPaths(text),
            summary: text.length === 0 ? "clean" : text.slice(0, 2000),
        };
    }
    catch (error) {
        if (isMissing(error))
            return { available: false, inside: false, paths: [], summary: "" };
        return { available: true, inside: true, paths: [], summary: "git status failed" };
    }
}
export function porcelainPaths(text) {
    const paths = [];
    for (const line of text.split(/\r?\n/)) {
        if (line.length < 4)
            continue;
        const rest = line.slice(3).trim();
        const arrow = rest.indexOf(" -> ");
        if (arrow === -1) {
            paths.push(unquote(rest));
            continue;
        }
        paths.push(unquote(rest.slice(0, arrow).trim()));
        paths.push(unquote(rest.slice(arrow + 4).trim()));
    }
    return paths.filter((item) => item.length > 0);
}
function gitOptions(root) {
    return {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
        env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(path.resolve(root)) },
    };
}
function unquote(value) {
    if (value.startsWith('"') && value.endsWith('"')) {
        return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
    return value;
}
function isMissing(error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
//# sourceMappingURL=git-status.js.map