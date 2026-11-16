import { agentLabel } from "./agent.js";
import { noticesFor, type Comparison, type Recording } from "./types.js";

export function formatRecording(recording: Recording): string {
  const { session, events, integrity } = recording;
  const lines = [
    `Session: ${session.id}`,
    `Status: ${session.status}`,
    `Complete: ${integrity.complete ? "yes" : "no"}`,
    `Agent: ${agentLabel(session.agent)}`,
    `Started: ${session.startedAt}`,
    `Finished: ${session.finishedAt ?? "-"}`,
    `Events: ${integrity.eventCount}`,
    `Content captured: ${session.captureContent ? "yes" : "no"}`,
    `Secrets redacted: ${session.redactSecrets ? "yes" : "no"}`,
  ];

  if (session.finishSummary) {
    lines.push(`Summary: ${session.finishSummary}`);
  }
  if (integrity.gaps.length === 0) {
    lines.push("Integrity: no gaps");
  } else {
    lines.push("Integrity gaps:");
    for (const gap of integrity.gaps) lines.push(`- ${gap}`);
  }

  lines.push(`Verification: ${verificationLabel(recording)}`);
  lines.push("", ...noticesFor(events.map((event) => event.source)), "");
  for (const event of events) {
    lines.push(`${event.sequence}. ${event.type}  ${event.agentId}  ${event.source}  ${event.timestamp}`);
    if (event.parentEventId) lines.push(`   parent: ${event.parentEventId}`);
    lines.push(indent(JSON.stringify(event.data, null, 2)));
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

export function formatComparison(comparison: Comparison): string {
  const lines = [
    comparison.divergence
      ? `Divergence: event ${comparison.divergence.index + 1} (${comparison.divergence.leftType ?? "missing"} vs ${comparison.divergence.rightType ?? "missing"})`
      : "Divergence: none",
    "Tool differences:",
    ...(comparison.toolDifferences.length === 0 ? ["- none"] : comparison.toolDifferences.map((line) => `- ${line}`)),
    "Model differences:",
    ...(comparison.modelDifferences.length === 0 ? ["- none"] : comparison.modelDifferences.map((line) => `- ${line}`)),
    "Environment differences:",
    ...(comparison.environmentDifferences.length === 0
      ? ["- none"]
      : comparison.environmentDifferences.map((line) => `- ${line}`)),
  ];
  return `${lines.join("\n")}\n`;
}

function verificationLabel(recording: Recording): string {
  if (recording.verification.length === 0) return "not checked";
  const passed = recording.verification.filter((check) => check.status === "passed").length;
  const failed = recording.verification.length - passed;
  return `${passed} passed, ${failed} failed`;
}

function indent(value: string): string {
  return value
    .split("\n")
    .map((line) => `   ${line}`)
    .join("\n");
}
