const SECRET_KEYS = new Set([
    "authorization",
    "apikey",
    "token",
    "password",
    "secret",
    "accesstoken",
]);
const PAYLOAD_KEYS = [
    "content",
    "input",
    "output",
    "arguments",
    "details",
    "data",
    "message",
    "reason",
    "summary",
    "delta",
    "task",
    "body",
    "headers",
];
function normalizeKey(key) {
    return key.toLowerCase().replace(/[_-]/g, "");
}
function redactString(input) {
    const patterns = [
        /sk-[A-Za-z0-9_-]{8,}/g,
        /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi,
        /\bAKIA[0-9A-Z]{16}\b/g,
        /ghp_[A-Za-z0-9]{20,}/g,
    ];
    let output = input;
    for (const pattern of patterns) {
        output = output.replace(pattern, "[REDACTED]");
    }
    return output;
}
export function redactValue(value) {
    if (typeof value === "string")
        return redactString(value);
    if (Array.isArray(value))
        return value.map((item) => redactValue(item));
    if (!isPlainObject(value))
        return value;
    const output = {};
    for (const [key, child] of Object.entries(value)) {
        output[key] = SECRET_KEYS.has(normalizeKey(key)) ? "[REDACTED]" : redactValue(child);
    }
    return output;
}
export function jsonByteLength(value) {
    const json = JSON.stringify(value);
    return Buffer.byteLength(json ?? "null", "utf8");
}
export function applyCapturePolicy(data, captureContent) {
    if (captureContent)
        return data;
    const next = { ...data };
    for (const key of PAYLOAD_KEYS) {
        if (key in next) {
            next[key] = { omitted: true, byteLength: jsonByteLength(next[key]) };
        }
    }
    return next;
}
export function isPlainObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function dropUndefined(data) {
    const output = {};
    for (const [key, value] of Object.entries(data)) {
        if (value !== undefined)
            output[key] = value;
    }
    return output;
}
//# sourceMappingURL=redact.js.map