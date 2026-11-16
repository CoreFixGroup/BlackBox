import { isPlainObject } from "./redact.js";
import type { BlackboxEvent, Comparison, Recording } from "./types.js";

export function compareRecordings(left: Recording, right: Recording): Comparison {
  return {
    divergence: firstDivergence(left.events, right.events),
    toolDifferences: zipDifferences(
      values(left, "tool.call", "name"),
      values(right, "tool.call", "name"),
      "tool",
    ),
    modelDifferences: zipDifferences(
      left.events.filter((event) => event.type === "model.response").map((event) => stable(event.data.output)),
      right.events.filter((event) => event.type === "model.response").map((event) => stable(event.data.output)),
      "model response",
    ),
    environmentDifferences: zipDifferences(
      left.events.filter((event) => event.type.startsWith("environment.")).map((event) => `${event.type} ${stable(event.data)}`),
      right.events.filter((event) => event.type.startsWith("environment.")).map((event) => `${event.type} ${stable(event.data)}`),
      "environment",
    ),
  };
}

function firstDivergence(left: BlackboxEvent[], right: BlackboxEvent[]): Comparison["divergence"] {
  const queues = new Map<string, BlackboxEvent[]>();
  for (const event of right) {
    const queue = queues.get(event.type) ?? [];
    queue.push(event);
    queues.set(event.type, queue);
  }
  for (const event of left) {
    const match = queues.get(event.type)?.shift();
    if (match === undefined || stable(comparableData(event)) !== stable(comparableData(match))) {
      return { index: event.sequence - 1, leftType: event.type, rightType: match?.type };
    }
  }
  for (const queue of queues.values()) {
    const extra = queue[0];
    if (extra) return { index: extra.sequence - 1, rightType: extra.type };
  }
  return null;
}

function values(recording: Recording, type: string, field: string): string[] {
  return recording.events
    .filter((event) => event.type === type)
    .map((event) => (typeof event.data[field] === "string" ? event.data[field] : ""));
}

function zipDifferences(left: string[], right: string[], label: string): string[] {
  const differences: string[] = [];
  const limit = Math.max(left.length, right.length);
  for (let index = 0; index < limit; index += 1) {
    if (left[index] !== right[index]) {
      differences.push(`${label} ${index + 1}: ${left[index] ?? "missing"} vs ${right[index] ?? "missing"}`);
    }
  }
  return differences;
}

function comparableData(event: BlackboxEvent): Record<string, unknown> {
  const data = { ...event.data };
  delete data.callId;
  return data;
}

function stable(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sortValue(item));
  if (!isPlainObject(value)) return value;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) output[key] = sortValue(value[key]);
  return output;
}
