import type { AgentInfo } from "./types.js";

export function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  return value;
}

export function normalizeAgent(agent: AgentInfo): AgentInfo {
  const id = requireText(agent?.id, "agent.id");
  const name = requireText(agent?.name, "agent.name");
  if (agent.version !== undefined && typeof agent.version !== "string") {
    throw new Error("agent.version must be a string");
  }

  const normalized: AgentInfo = { id, name };
  if (typeof agent.version === "string" && agent.version.trim() !== "") {
    normalized.version = agent.version;
  }
  return normalized;
}

export function agentLabel(agent: AgentInfo): string {
  const version = agent.version ? ` ${agent.version}` : "";
  return `${agent.name} (${agent.id})${version}`;
}
