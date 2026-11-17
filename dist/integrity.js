export function assessIntegrity(session, events, parseGaps) {
    const gaps = [...parseGaps];
    const contiguous = events.every((event, index) => event.sequence === index + 1);
    if (!contiguous) {
        gaps.push("event sequence is not contiguous starting at 1");
    }
    if (session.status === "running") {
        gaps.push("session was not finished");
    }
    else if (session.eventCount !== events.length) {
        gaps.push(`event count mismatch: session.json says ${session.eventCount}, events.jsonl has ${events.length}`);
    }
    else if (session.lastSequence !== (events.at(-1)?.sequence ?? 0)) {
        gaps.push(`last sequence mismatch: session.json says ${session.lastSequence}, last event is ${events.at(-1)?.sequence ?? 0}`);
    }
    const finished = session.status === "completed" || session.status === "failed";
    return {
        complete: finished && gaps.length === 0,
        eventCount: events.length,
        gaps,
    };
}
//# sourceMappingURL=integrity.js.map