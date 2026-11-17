import { installNetworkGuard } from "./network-guard.js";
import { requireText } from "./agent.js";
export class Replay {
    session;
    responses;
    tools;
    constructor(session, recording) {
        this.session = session;
        this.session.enterReplay();
        this.responses = recording.events
            .filter((event) => event.type === "model.response")
            .map((event) => event.data.output);
        this.tools = toolPlaybacks(recording.events);
    }
    wrapModel(_model, options = {}) {
        return ((input) => {
            const output = this.responses.shift();
            if (output === undefined) {
                this.session.recordReplayError("no recorded model response remains", "ReplayExhausted");
                const error = new Error("no recorded model response remains");
                error.name = "ReplayExhausted";
                throw error;
            }
            this.session.setOrigin("generated");
            const request = this.session.recordModelRequest({
                provider: options.provider,
                model: options.model,
                input,
            });
            this.session.setOrigin("replayed");
            try {
                this.session.recordModelResponse({ output, parentEventId: request.id });
                return output;
            }
            finally {
                this.session.setOrigin("generated");
            }
        });
    }
    wrapTool(name, tool) {
        const toolName = requireText(name, "name");
        return (args) => {
            const index = this.tools.findIndex((toolPlayback) => toolPlayback.name === toolName);
            const next = index < 0 ? undefined : this.tools.splice(index, 1)[0];
            if (next) {
                this.session.setOrigin("replayed");
                try {
                    const call = this.session.recordToolCall({ name: toolName, arguments: args });
                    const callId = typeof call.data.callId === "string" ? call.data.callId : undefined;
                    this.session.recordToolResult({
                        callId,
                        output: next.output,
                        isError: next.isError,
                        parentEventId: call.id,
                    });
                    if (next.isError) {
                        throw new Error(typeof next.output === "string" ? next.output : "recorded tool failed");
                    }
                    return next.output;
                }
                finally {
                    this.session.setOrigin("generated");
                }
            }
            this.session.setOrigin("generated");
            const wrapped = this.session.wrapTool(toolName, (value) => tool(value));
            return wrapped(args);
        };
    }
    async run(fn) {
        const restore = installNetworkGuard(() => {
            this.session.recordReplayError("replay blocked a network call", "ReplayNetworkBlocked");
        });
        try {
            return await fn(this);
        }
        finally {
            restore();
        }
    }
}
function toolPlaybacks(events) {
    const names = new Map();
    for (const event of events) {
        if (event.type !== "tool.call" || typeof event.data.name !== "string")
            continue;
        names.set(event.id, event.data.name);
        if (typeof event.data.callId === "string")
            names.set(event.data.callId, event.data.name);
    }
    const results = [];
    for (const event of events) {
        if (event.type !== "tool.result")
            continue;
        const callId = typeof event.data.callId === "string" ? event.data.callId : undefined;
        const name = (callId ? names.get(callId) : undefined) ?? (event.parentEventId ? names.get(event.parentEventId) : undefined);
        if (!name)
            continue;
        results.push({ name, output: event.data.output, isError: event.data.isError === true });
    }
    return results;
}
//# sourceMappingURL=replay.js.map