import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
export function snapshotDirectory(root) {
    const files = new Map();
    let rootReal = root;
    try {
        rootReal = fs.realpathSync(root);
    }
    catch {
        return files;
    }
    walk(root, rootReal, root, files, new Set());
    return files;
}
export function diffSnapshots(before, after) {
    const changes = [];
    for (const [relativePath, stamp] of after) {
        const previous = before.get(relativePath);
        if (!previous)
            changes.push({ path: relativePath, action: "created", bytes: stamp.bytes });
        else if (previous.hash !== stamp.hash) {
            changes.push({ path: relativePath, action: "modified", bytes: stamp.bytes });
        }
    }
    for (const [relativePath, stamp] of before) {
        if (!after.has(relativePath))
            changes.push({ path: relativePath, action: "deleted", bytes: stamp.bytes });
    }
    changes.sort((left, right) => left.path.localeCompare(right.path));
    return changes;
}
function walk(root, rootReal, current, files, seen) {
    let realCurrent;
    try {
        realCurrent = fs.realpathSync(current);
    }
    catch {
        return;
    }
    if (!isInside(rootReal, realCurrent) || seen.has(realCurrent))
        return;
    seen.add(realCurrent);
    let entries;
    try {
        entries = fs.readdirSync(current, { withFileTypes: true });
    }
    catch {
        return;
    }
    for (const entry of entries) {
        const full = path.join(current, entry.name);
        let real;
        try {
            real = fs.realpathSync(full);
        }
        catch {
            continue;
        }
        if (!isInside(rootReal, real))
            continue;
        let stat;
        try {
            stat = fs.statSync(real);
        }
        catch {
            continue;
        }
        if (stat.isDirectory()) {
            walk(root, rootReal, full, files, seen);
            continue;
        }
        if (!stat.isFile())
            continue;
        const content = fs.readFileSync(real);
        files.set(path.relative(root, full).split(path.sep).join("/"), {
            bytes: content.byteLength,
            hash: createHash("sha256").update(content).digest("hex"),
        });
    }
}
function isInside(rootReal, target) {
    const relative = path.relative(rootReal, target);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
//# sourceMappingURL=snapshot.js.map