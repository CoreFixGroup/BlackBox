export function requireText(value, label) {
    if (typeof value !== "string" || value.trim() === "") {
        throw new Error(`${label} is required`);
    }
    return value;
}
export function normalizeAgent(agent) {
    const id = requireText(agent?.id, "agent.id");
    const name = requireText(agent?.name, "agent.name");
    if (agent.version !== undefined && typeof agent.version !== "string") {
        throw new Error("agent.version must be a string");
    }
    const normalized = { id, name };
    if (typeof agent.version === "string" && agent.version.trim() !== "") {
        normalized.version = agent.version;
    }
    return normalized;
}
export function agentLabel(agent) {
    const version = agent.version ? ` ${agent.version}` : "";
    return `${agent.name} (${agent.id})${version}`;
}
//# sourceMappingURL=agent.js.map