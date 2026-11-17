import { isPlainObject } from "./redact.js";
export function beginHttpCall(hooks, input) {
    const request = hooks.record("http.request", {
        method: input.method,
        url: input.url,
        headers: input.headers,
        body: input.body,
    });
    const call = { requestId: request.id };
    if (isModelRequestBody(input.body)) {
        call.modelRequestId = hooks.record("model.request", { model: input.body.model, input: input.body }, request.id).id;
    }
    if (isJsonRpc(input.body)) {
        call.rpcRequestId = hooks.record("jsonrpc.request", { body: input.body }, request.id).id;
    }
    return call;
}
export function finishHttpCall(hooks, call, input) {
    hooks.record("http.response", { status: input.status, headers: input.headers, body: input.body }, call.requestId);
    if (call.modelRequestId !== undefined) {
        hooks.record("model.response", { output: input.body }, call.requestId);
    }
    if (call.rpcRequestId !== undefined && isJsonRpc(input.body)) {
        hooks.record("jsonrpc.response", { body: input.body }, call.rpcRequestId);
    }
}
export function decodeBody(value) {
    if (value === undefined || value === null || value === "")
        return undefined;
    if (typeof value === "string" || Buffer.isBuffer(value) || value instanceof Uint8Array) {
        const text = typeof value === "string" ? value : Buffer.from(value).toString("utf8");
        if (text.length === 0)
            return undefined;
        try {
            return JSON.parse(text);
        }
        catch {
            return text;
        }
    }
    if (value instanceof URLSearchParams)
        return value.toString();
    return { unread: true };
}
export function isModelRequestBody(value) {
    return isPlainObject(value) && typeof value.model === "string" && Array.isArray(value.messages);
}
export function isJsonRpc(value) {
    return isPlainObject(value) && "jsonrpc" in value;
}
//# sourceMappingURL=protocol.js.map