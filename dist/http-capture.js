import http from "node:http";
import https from "node:https";
import { isPlainObject } from "./redact.js";
import { beginHttpCall, decodeBody, finishHttpCall } from "./protocol.js";
let active;
export function installHttpCapture(ownerId, hooks) {
    if (active?.ownerId === ownerId)
        return active.restore;
    if (active)
        throw new Error("HTTP capture is already active");
    const original = {
        fetch: globalThis.fetch,
        httpRequest: http.request,
        httpsRequest: https.request,
        httpGet: http.get,
        httpsGet: https.get,
    };
    globalThis.fetch = patchedFetch(original.fetch, hooks);
    http.request = patchedRequest(original.httpRequest, "http:", hooks);
    https.request = patchedRequest(original.httpsRequest, "https:", hooks);
    http.get = patchedGet(http.request);
    https.get = patchedGet(https.request);
    const restore = () => {
        if (active?.ownerId !== ownerId)
            return;
        globalThis.fetch = original.fetch;
        http.request = original.httpRequest;
        https.request = original.httpsRequest;
        http.get = original.httpGet;
        https.get = original.httpsGet;
        active = undefined;
    };
    active = { ownerId, restore };
    return restore;
}
function patchedFetch(original, hooks) {
    return (async (...args) => {
        const described = describeFetch(args[0], args[1]);
        try {
            const response = await original(...args);
            let responseBody;
            try {
                responseBody = decodeBody(await response.clone().text());
            }
            catch {
                responseBody = undefined;
            }
            const call = beginHttpCall(hooks, described);
            finishHttpCall(hooks, call, {
                status: response.status,
                headers: headersFrom(response.headers),
                body: responseBody,
            });
            return response;
        }
        catch (error) {
            const call = beginHttpCall(hooks, described);
            hooks.fail(error, call.requestId);
            throw error;
        }
    });
}
function patchedRequest(original, protocol, hooks) {
    return function patched(...args) {
        const req = original.apply(this, args);
        watchClientRequest(req, describeClientRequest(args, protocol), hooks);
        return req;
    };
}
function patchedGet(request) {
    return (...args) => {
        const req = request(...args);
        req.end();
        return req;
    };
}
function watchClientRequest(req, described, hooks) {
    const chunks = [];
    let started = false;
    let failed = false;
    const write = req.write;
    const end = req.end;
    const ensure = () => {
        if (started)
            return;
        started = true;
        const call = beginHttpCall(hooks, {
            method: described.method,
            url: described.url,
            headers: described.headers,
            body: decodeBody(Buffer.concat(chunks)),
        });
        req.on("response", (res) => {
            const responseChunks = [];
            res.on("data", (chunk) => {
                responseChunks.push(Buffer.from(chunk));
            });
            res.on("end", () => {
                finishHttpCall(hooks, call, {
                    status: res.statusCode ?? 0,
                    headers: headerRecord(res.headers),
                    body: decodeBody(Buffer.concat(responseChunks)),
                });
            });
        });
        return call;
    };
    req.write = function patchedWrite(chunk, ...rest) {
        const buffered = bufferChunk(chunk, rest[0]);
        if (buffered)
            chunks.push(buffered);
        return write.apply(this, [chunk, ...rest]);
    };
    req.end = function patchedEnd(...endArgs) {
        const buffered = bufferChunk(endArgs[0], endArgs[1]);
        if (buffered)
            chunks.push(buffered);
        const call = ensure();
        req.on("error", (error) => {
            if (failed)
                return;
            failed = true;
            hooks.fail(error, call?.requestId);
        });
        return end.apply(this, endArgs);
    };
}
function describeFetch(input, init) {
    const request = typeof Request !== "undefined" && input instanceof Request ? input : undefined;
    const method = String(init?.method ?? request?.method ?? "GET").toUpperCase();
    const url = request?.url ?? (input instanceof URL ? input.href : String(input));
    return {
        method,
        url,
        headers: headersFrom(init?.headers ?? request?.headers),
        body: decodeBody(init?.body),
    };
}
function describeClientRequest(args, protocol) {
    const values = args.filter((arg) => typeof arg !== "function");
    let options = {};
    let url;
    if (typeof values[0] === "string" || values[0] instanceof URL) {
        url = new URL(String(values[0]));
        if (isPlainObject(values[1]))
            options = values[1];
    }
    else if (isPlainObject(values[0])) {
        options = values[0];
    }
    const method = String(options.method ?? "GET").toUpperCase();
    const headers = headerRecord(options.headers);
    if (url)
        return { method, url: url.href, headers };
    const proto = String(options.protocol ?? protocol);
    const hostname = String(options.hostname ?? options.host ?? "localhost");
    const port = options.port === undefined || String(hostname).includes(":") ? "" : `:${options.port}`;
    const pathName = String(options.path ?? "/");
    return { method, url: `${proto}//${hostname}${port}${pathName}`, headers };
}
function headersFrom(headers) {
    if (headers === undefined || headers === null)
        return {};
    if (typeof Headers !== "undefined" && headers instanceof Headers) {
        const output = {};
        headers.forEach((value, key) => {
            output[key] = value;
        });
        return output;
    }
    if (Array.isArray(headers)) {
        const output = {};
        for (const entry of headers) {
            if (Array.isArray(entry) && entry.length >= 2)
                output[String(entry[0])] = String(entry[1]);
        }
        return output;
    }
    if (isPlainObject(headers))
        return headerRecord(headers);
    return {};
}
function headerRecord(headers) {
    if (!headers)
        return {};
    const output = {};
    for (const [key, value] of Object.entries(headers)) {
        if (value !== undefined)
            output[key] = value;
    }
    return output;
}
function bufferChunk(chunk, encoding) {
    if (chunk === undefined || chunk === null || typeof chunk === "function")
        return undefined;
    if (typeof chunk === "string") {
        return Buffer.from(chunk, typeof encoding === "string" ? encoding : "utf8");
    }
    if (Buffer.isBuffer(chunk))
        return chunk;
    if (chunk instanceof Uint8Array)
        return Buffer.from(chunk);
    return undefined;
}
//# sourceMappingURL=http-capture.js.map