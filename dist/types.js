export const SCHEMA_VERSION = 1;
export const INTEGRATION_NOTICE = "These events were reported by the agent integration. Blackbox did not independently observe them.";
export const EVENT_SOURCES = ["integration", "protocol", "environment", "replay", "verification"];
export const SOURCE_NOTICES = {
    integration: INTEGRATION_NOTICE,
    protocol: "These events were observed because the integration turned protocol capture on.",
    environment: "These events were observed in a directory or process the integration named.",
    replay: "These events were produced by offline replay of a stored recording.",
    verification: "These checks were recorded because the integration asked Blackbox to verify an outcome.",
};
export function isEventSource(value) {
    return EVENT_SOURCES.includes(value);
}
export function noticesFor(sources) {
    const seen = new Set();
    const notices = [];
    for (const source of sources) {
        if (seen.has(source) || !isEventSource(source))
            continue;
        seen.add(source);
        notices.push(SOURCE_NOTICES[source]);
    }
    if (notices.length === 0)
        notices.push(INTEGRATION_NOTICE);
    return notices;
}
//# sourceMappingURL=types.js.map