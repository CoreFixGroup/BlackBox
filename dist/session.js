import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { normalizeAgent, requireText } from "./agent.js";
import { collectGitStatus } from "./git-status.js";
import { installHttpCapture } from "./http-capture.js";
import { startRecordingProxy } from "./proxy.js";
import { diffSnapshots, snapshotDirectory } from "./snapshot.js";
import { installChildProcessCapture } from "./spawn-capture.js";
export class Session {
    store;
    header;
    id;
    closed = false;
    finishEvent = null;
    lastErrorEventId;
    agents;
    toolCalls = new Map();
    completionCounts = new Map();
    faults = [];
    snapshots = [];
    restoreHttp;
    restoreSpawn;
    flushSpawn;
    processApi;
    closeProxy;
    proxyInfo;
    forcedSource;
    origin;
    constructor(store, header) {
        this.store = store;
        this.header = header;
        this.id = header.id;
        this.agents = [header.agent];
    }
    recordUserMessage(input) {
        return this.record("user.message", { content: requireText(input.content, "content") }, input.parentEventId);
    }
    recordAssistantMessage(input) {
        return this.record("assistant.message", { content: requireText(input.content, "content") }, input.parentEventId);
    }
    recordModelRequest(input) {
        return this.record("model.request", {
            provider: optionalText(input.provider, "provider"),
            model: optionalText(input.model, "model"),
            input: requireValue(input.input, "input"),
        }, input.parentEventId);
    }
    recordModelResponse(input) {
        return this.record("model.response", { output: requireValue(input.output, "output") }, input.parentEventId);
    }
    recordToolCall(input) {
        const callId = input.callId === undefined ? randomUUID() : requireText(input.callId, "callId");
        const event = this.record("tool.call", {
            name: requireText(input.name, "name"),
            callId,
            arguments: input.arguments,
        }, input.parentEventId);
        this.toolCalls.set(callId, event.id);
        return event;
    }
    recordToolResult(input) {
        if (input.isError !== undefined && typeof input.isError !== "boolean") {
            throw new Error("isError must be a boolean");
        }
        const callId = optionalText(input.callId, "callId");
        const parentEventId = optionalParent(input.parentEventId) ?? (callId ? this.toolCalls.get(callId) : undefined);
        return this.record("tool.result", {
            callId,
            output: requireValue(input.output, "output"),
            isError: input.isError ?? false,
        }, parentEventId);
    }
    recordError(input) {
        const event = this.record("error", {
            message: requireText(input.message, "message"),
            name: optionalText(input.name, "name"),
            details: input.details,
        }, input.parentEventId);
        this.lastErrorEventId = event.id;
        return event;
    }
    recordRetry(input) {
        if (!Number.isInteger(input.attempt) || input.attempt < 1) {
            throw new Error("attempt must be an integer starting at 1");
        }
        return this.record("retry", {
            attempt: input.attempt,
            reason: requireText(input.reason, "reason"),
        }, input.parentEventId);
    }
    recordCustom(input) {
        return this.record("custom", {
            name: requireText(input.name, "name"),
            data: input.data,
        }, input.parentEventId);
    }
    wrapModel(model, options = {}) {
        return ((input) => {
            const fault = this.takeFault("model", options.model);
            if (fault)
                this.raiseFault(fault);
            const request = this.recordModelRequest({
                provider: options.provider,
                model: options.model,
                input,
            });
            try {
                const returned = model(input);
                if (isAsyncIterable(returned)) {
                    return this.iterateStream(returned, request.id);
                }
                if (isPromise(returned)) {
                    return returned.then((value) => {
                        if (isAsyncIterable(value))
                            return this.iterateStream(value, request.id);
                        this.recordModelResponse({ output: value, parentEventId: request.id });
                        return value;
                    }, (error) => {
                        this.recordThrown(error, request.id);
                        throw error;
                    });
                }
                this.recordModelResponse({ output: returned, parentEventId: request.id });
                return returned;
            }
            catch (error) {
                this.recordThrown(error, request.id);
                throw error;
            }
        });
    }
    wrapTool(name, tool) {
        const toolName = requireText(name, "name");
        return (args) => {
            const fault = this.takeFault("tool", toolName);
            if (fault)
                this.raiseFault(fault);
            const call = this.recordToolCall({ name: toolName, arguments: args });
            const callId = typeof call.data.callId === "string" ? call.data.callId : undefined;
            const settle = (output, isError) => {
                this.recordToolResult({ callId, output, isError, parentEventId: call.id });
            };
            try {
                const returned = tool(args);
                if (isPromise(returned)) {
                    return returned.then((output) => {
                        settle(output, false);
                        return output;
                    }, (error) => {
                        settle(thrownMessage(error), true);
                        this.recordThrown(error, call.id);
                        throw error;
                    });
                }
                settle(returned, false);
                return returned;
            }
            catch (error) {
                settle(thrownMessage(error), true);
                this.recordThrown(error, call.id);
                throw error;
            }
        };
    }
    async runWithRetry(fn, options) {
        if (!Number.isInteger(options.attempts) || options.attempts < 1) {
            throw new Error("attempts must be an integer starting at 1");
        }
        const reason = requireText(options.reason, "reason");
        let lastError;
        for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
            const errorBefore = this.lastErrorEventId;
            try {
                return await fn();
            }
            catch (error) {
                lastError = error;
                const parentEventId = this.lastErrorEventId !== errorBefore ? this.lastErrorEventId : this.recordThrown(error).id;
                if (attempt === options.attempts)
                    break;
                this.recordRetry({ attempt: attempt + 1, reason, parentEventId });
            }
        }
        throw lastError;
    }
    complete(input = {}) {
        const status = input.status ?? "completed";
        if (status !== "completed" && status !== "failed") {
            throw new Error("status must be completed or failed");
        }
        const agent = this.currentAgent();
        const event = this.record("agent.completed", {
            agent,
            status,
            summary: input.summary,
        });
        this.completionCounts.set(agent.id, (this.completionCounts.get(agent.id) ?? 0) + 1);
        return event;
    }
    async handoff(input) {
        const agent = normalizeAgent(input.agent);
        const handoff = this.record("agent.handoff", {
            agent,
            task: optionalText(input.task, "task"),
        });
        this.agents.push(agent);
        const completionsBefore = this.completionCounts.get(agent.id) ?? 0;
        try {
            const result = await input.run(this);
            this.recordChildCompletion(agent, "completed", handoff.id, completionsBefore);
            return result;
        }
        catch (error) {
            this.recordThrown(error, handoff.id);
            this.recordChildCompletion(agent, "failed", handoff.id, completionsBefore);
            throw error;
        }
        finally {
            this.agents.pop();
        }
    }
    captureHttp() {
        this.assertOpen();
        if (this.restoreHttp)
            return;
        this.restoreHttp = installHttpCapture(this.id, this.protocolHooks());
    }
    async openProxy() {
        this.assertOpen();
        if (this.proxyInfo)
            return this.proxyInfo;
        const proxy = await startRecordingProxy(this.protocolHooks());
        this.proxyInfo = { port: proxy.port, url: proxy.url };
        this.closeProxy = proxy.close;
        return this.proxyInfo;
    }
    wrapMcp(client) {
        this.assertOpen();
        const session = this;
        return new Proxy(client, {
            get(target, prop, receiver) {
                const value = Reflect.get(target, prop, receiver);
                if (typeof value !== "function")
                    return value;
                if (prop === "request") {
                    return (method, params) => session.captureMcp("mcp.request", "mcp.response", { method, params }, () => value.call(target, method, params));
                }
                if (prop === "callTool") {
                    return (name, args) => session.captureMcp("mcp.request", "mcp.response", { method: "tools/call", name, arguments: args }, () => value.call(target, name, args));
                }
                return value.bind(target);
            },
        });
    }
    watchDirectory(root) {
        this.assertOpen();
        const resolved = path.resolve(requireText(root, "root"));
        if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
            throw new Error("watchDirectory requires a directory");
        }
        this.snapshots.push({ root: resolved, files: snapshotDirectory(resolved) });
    }
    wrapSpawn() {
        this.assertOpen();
        if (!this.processApi) {
            const capture = installChildProcessCapture(this.id, (info) => {
                if (this.closed)
                    return;
                this.record("environment.process", {
                    command: info.command,
                    args: info.args,
                    exitCode: info.exitCode,
                    durationMs: info.durationMs,
                }, undefined, "environment");
            });
            this.processApi = capture.api;
            this.restoreSpawn = capture.restore;
            this.flushSpawn = capture.flush;
        }
        return this.processApi;
    }
    injectFault(input) {
        this.assertOpen();
        if (input.target !== "tool" && input.target !== "model") {
            throw new Error("target must be tool or model");
        }
        this.faults.push({
            target: input.target,
            name: requireText(input.name, "name"),
            message: requireText(input.message, "message"),
        });
    }
    enterReplay() {
        this.forcedSource = "replay";
        this.origin = "generated";
    }
    setOrigin(origin) {
        this.origin = this.forcedSource === "replay" ? origin : undefined;
    }
    recordReplayError(message, name) {
        return this.recordError({ message, name });
    }
    finish(input = {}) {
        if (this.closed) {
            throw new Error(`Session ${this.id} is already finished`);
        }
        const status = input.status ?? "completed";
        if (status !== "completed" && status !== "failed") {
            throw new Error("status must be completed or failed");
        }
        try {
            this.recordEnvironment();
            this.flushSpawn?.();
        }
        finally {
            this.restoreCaptures();
        }
        if (!this.finishEvent) {
            this.finishEvent = this.record("session.finished", {
                status,
                summary: input.summary,
            });
        }
        const storedSummary = typeof this.finishEvent.data.summary === "string" ? this.finishEvent.data.summary : null;
        const recordedStatus = this.finishEvent.data.status === "failed" ? "failed" : "completed";
        this.store.finalize(this.id, recordedStatus, storedSummary);
        this.closed = true;
    }
    record(type, data, parentEventId, source) {
        this.assertOpen();
        const payload = { ...data };
        if (this.origin !== undefined && payload.origin === undefined)
            payload.origin = this.origin;
        return this.store.append(this.id, {
            type,
            agentId: this.currentAgent().id,
            parentEventId: optionalParent(parentEventId),
            data: payload,
            source: source ?? this.forcedSource ?? "integration",
        });
    }
    assertOpen() {
        if (this.closed || this.finishEvent) {
            throw new Error(`Session ${this.id} is already finished`);
        }
    }
    currentAgent() {
        return this.agents[this.agents.length - 1] ?? this.header.agent;
    }
    async *iterateStream(source, parentEventId) {
        const parts = [];
        let index = 0;
        let state = "open";
        try {
            for await (const chunk of source) {
                parts.push(chunk);
                this.record("model.stream.delta", { index, delta: chunk }, parentEventId);
                index += 1;
                yield chunk;
            }
            state = "done";
            this.recordModelResponse({ output: assembleStream(parts), parentEventId });
        }
        catch (error) {
            state = "failed";
            this.recordThrown(error, parentEventId);
            throw error;
        }
        finally {
            if (state === "open") {
                this.recordError({
                    message: "model stream ended before completion",
                    name: "StreamClosed",
                    parentEventId,
                });
            }
        }
    }
    recordChildCompletion(agent, status, parentEventId, completionsBefore) {
        if ((this.completionCounts.get(agent.id) ?? 0) !== completionsBefore)
            return;
        this.record("agent.completed", { agent, status }, parentEventId);
    }
    protocolHooks() {
        return {
            record: (type, data, parentEventId) => this.record(type, data, parentEventId, "protocol"),
            fail: (error, parentEventId) => {
                const event = this.record("error", { message: thrownMessage(error), name: thrownName(error) }, parentEventId, "protocol");
                this.lastErrorEventId = event.id;
            },
        };
    }
    captureMcp(requestType, responseType, data, run) {
        const request = this.record(requestType, data, undefined, "protocol");
        try {
            const returned = run();
            if (isPromise(returned)) {
                return returned.then((output) => {
                    this.record(responseType, { output }, request.id, "protocol");
                    return output;
                }, (error) => {
                    this.protocolHooks().fail(error, request.id);
                    throw error;
                });
            }
            this.record(responseType, { output: returned }, request.id, "protocol");
            return returned;
        }
        catch (error) {
            this.protocolHooks().fail(error, request.id);
            throw error;
        }
    }
    recordEnvironment() {
        const watched = this.snapshots.splice(0);
        let gitMissing = false;
        for (const directory of watched) {
            for (const change of diffSnapshots(directory.files, snapshotDirectory(directory.root))) {
                this.record("environment.file", { path: change.path, action: change.action, bytes: change.bytes }, undefined, "environment");
            }
            const git = collectGitStatus(directory.root);
            if (!git.available)
                gitMissing = true;
            else {
                this.record("environment.git", { paths: git.paths, summary: git.inside ? git.summary : "not a git repository" }, undefined, "environment");
            }
        }
        if (gitMissing) {
            this.record("error", { message: "git is not available", name: "GitUnavailable" }, undefined, "environment");
        }
    }
    restoreCaptures() {
        const restores = [this.restoreHttp, this.restoreSpawn, this.closeProxy];
        this.restoreHttp = undefined;
        this.restoreSpawn = undefined;
        this.flushSpawn = undefined;
        this.processApi = undefined;
        this.closeProxy = undefined;
        this.proxyInfo = undefined;
        for (const restore of restores) {
            if (!restore)
                continue;
            try {
                restore();
            }
            catch {
                continue;
            }
        }
    }
    takeFault(target, name) {
        const index = this.faults.findIndex((fault) => fault.target === target && fault.name === name);
        if (index < 0)
            return undefined;
        return this.faults.splice(index, 1)[0];
    }
    raiseFault(fault) {
        this.record("fault.injected", { target: fault.target, name: fault.name, message: fault.message });
        throw new Error(fault.message);
    }
    recordThrown(error, parentEventId) {
        return this.recordError({
            message: thrownMessage(error),
            name: thrownName(error),
            parentEventId,
        });
    }
}
function optionalText(value, label) {
    if (value === undefined)
        return undefined;
    return requireText(value, label);
}
function optionalParent(value) {
    return optionalText(value, "parentEventId");
}
function requireValue(value, label) {
    if (value === undefined)
        throw new Error(`${label} is required`);
    return value;
}
function isPromise(value) {
    return typeof value === "object" && value !== null && typeof value.then === "function";
}
function isAsyncIterable(value) {
    return typeof value === "object" && value !== null && Symbol.asyncIterator in value;
}
function assembleStream(parts) {
    if (parts.every((part) => typeof part === "string"))
        return parts.join("");
    return parts;
}
function thrownMessage(error) {
    if (error instanceof Error && error.message.trim() !== "")
        return error.message;
    return "Unknown error";
}
function thrownName(error) {
    if (error instanceof Error && error.name.trim() !== "")
        return error.name;
    return undefined;
}
//# sourceMappingURL=session.js.map