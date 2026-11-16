import http from "node:http";
import https from "node:https";
import type { ClientRequest, IncomingHttpHeaders, RequestOptions } from "node:http";

import { isPlainObject } from "./redact.js";
import { beginHttpCall, decodeBody, finishHttpCall, type HttpHooks } from "./protocol.js";

interface ActiveCapture {
  ownerId: string;
  restore: () => void;
}

let active: ActiveCapture | undefined;

export function installHttpCapture(ownerId: string, hooks: HttpHooks): () => void {
  if (active?.ownerId === ownerId) return active.restore;
  if (active) throw new Error("HTTP capture is already active");

  const original = {
    fetch: globalThis.fetch,
    httpRequest: http.request,
    httpsRequest: https.request,
    httpGet: http.get,
    httpsGet: https.get,
  };

  globalThis.fetch = patchedFetch(original.fetch, hooks);
  http.request = patchedRequest(original.httpRequest as (...args: unknown[]) => http.ClientRequest, "http:", hooks) as typeof http.request;
  https.request = patchedRequest(original.httpsRequest as (...args: unknown[]) => http.ClientRequest, "https:", hooks) as typeof https.request;
  http.get = patchedGet(http.request) as typeof http.get;
  https.get = patchedGet(https.request) as typeof https.get;

  const restore = (): void => {
    if (active?.ownerId !== ownerId) return;
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

function patchedFetch(original: typeof fetch, hooks: HttpHooks): typeof fetch {
  return (async (...args: Parameters<typeof fetch>) => {
    const described = describeFetch(args[0], args[1]);
    try {
      const response = await original(...args);
      let responseBody: unknown;
      try {
        responseBody = decodeBody(await response.clone().text());
      } catch {
        responseBody = undefined;
      }
      const call = beginHttpCall(hooks, described);
      finishHttpCall(hooks, call, {
        status: response.status,
        headers: headersFrom(response.headers),
        body: responseBody,
      });
      return response;
    } catch (error) {
      const call = beginHttpCall(hooks, described);
      hooks.fail(error, call.requestId);
      throw error;
    }
  }) as typeof fetch;
}

function patchedRequest(
  original: (...args: unknown[]) => ClientRequest,
  protocol: "http:" | "https:",
  hooks: HttpHooks,
): (...args: unknown[]) => ClientRequest {
  return function patched(this: unknown, ...args: unknown[]) {
    const req = original.apply(this, args);
    watchClientRequest(req, describeClientRequest(args, protocol), hooks);
    return req;
  };
}

function patchedGet(request: typeof http.request): (...args: unknown[]) => ClientRequest {
  return (...args: unknown[]) => {
    const req = (request as unknown as (...inner: unknown[]) => ClientRequest)(...args);
    req.end();
    return req;
  };
}

function watchClientRequest(
  req: ClientRequest,
  described: { method: string; url: string; headers: Record<string, unknown> },
  hooks: HttpHooks,
): void {
  const chunks: Buffer[] = [];
  let started = false;
  let failed = false;
  const write = req.write;
  const end = req.end;

  const ensure = () => {
    if (started) return;
    started = true;
    const call = beginHttpCall(hooks, {
      method: described.method,
      url: described.url,
      headers: described.headers,
      body: decodeBody(Buffer.concat(chunks)),
    });
    req.on("response", (res) => {
      const responseChunks: Buffer[] = [];
      res.on("data", (chunk: Buffer | string) => {
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

  req.write = function patchedWrite(this: ClientRequest, chunk: unknown, ...rest: unknown[]) {
    const buffered = bufferChunk(chunk, rest[0]);
    if (buffered) chunks.push(buffered);
    return write.apply(this, [chunk, ...rest] as never);
  } as typeof req.write;

  req.end = function patchedEnd(this: ClientRequest, ...endArgs: unknown[]) {
    const buffered = bufferChunk(endArgs[0], endArgs[1]);
    if (buffered) chunks.push(buffered);
    const call = ensure();
    req.on("error", (error) => {
      if (failed) return;
      failed = true;
      hooks.fail(error, call?.requestId);
    });
    return end.apply(this, endArgs as never);
  } as typeof req.end;
}

function describeFetch(
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
): { method: string; url: string; headers: Record<string, unknown>; body?: unknown } {
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

function describeClientRequest(
  args: unknown[],
  protocol: "http:" | "https:",
): { method: string; url: string; headers: Record<string, unknown> } {
  const values = args.filter((arg) => typeof arg !== "function");
  let options: RequestOptions = {};
  let url: URL | undefined;
  if (typeof values[0] === "string" || values[0] instanceof URL) {
    url = new URL(String(values[0]));
    if (isPlainObject(values[1])) options = values[1] as RequestOptions;
  } else if (isPlainObject(values[0])) {
    options = values[0] as RequestOptions;
  }
  const method = String(options.method ?? "GET").toUpperCase();
  const headers = headerRecord(options.headers as IncomingHttpHeaders | undefined);
  if (url) return { method, url: url.href, headers };
  const proto = String(options.protocol ?? protocol);
  const hostname = String(options.hostname ?? options.host ?? "localhost");
  const port = options.port === undefined || String(hostname).includes(":") ? "" : `:${options.port}`;
  const pathName = String(options.path ?? "/");
  return { method, url: `${proto}//${hostname}${port}${pathName}`, headers };
}

function headersFrom(headers: unknown): Record<string, unknown> {
  if (headers === undefined || headers === null) return {};
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    const output: Record<string, string> = {};
    headers.forEach((value, key) => {
      output[key] = value;
    });
    return output;
  }
  if (Array.isArray(headers)) {
    const output: Record<string, string> = {};
    for (const entry of headers) {
      if (Array.isArray(entry) && entry.length >= 2) output[String(entry[0])] = String(entry[1]);
    }
    return output;
  }
  if (isPlainObject(headers)) return headerRecord(headers as IncomingHttpHeaders);
  return {};
}

function headerRecord(headers: IncomingHttpHeaders | Record<string, unknown> | undefined): Record<string, unknown> {
  if (!headers) return {};
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) output[key] = value;
  }
  return output;
}

function bufferChunk(chunk: unknown, encoding: unknown): Buffer | undefined {
  if (chunk === undefined || chunk === null || typeof chunk === "function") return undefined;
  if (typeof chunk === "string") {
    return Buffer.from(chunk, typeof encoding === "string" ? (encoding as BufferEncoding) : "utf8");
  }
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  return undefined;
}
