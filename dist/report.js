import fs from "node:fs";
import path from "node:path";
import { agentLabel } from "./agent.js";
import { sessionDirectory } from "./paths.js";
import { SOURCE_NOTICES } from "./types.js";
export function renderReport(recording) {
    const { session, events, integrity } = recording;
    const byId = new Map(events.map((event) => [event.id, event]));
    const bannerTitle = integrity.complete ? "Recording complete" : "Recording incomplete";
    const bannerClass = integrity.complete ? "complete" : "incomplete";
    const gaps = integrity.gaps.length === 0
        ? `<p class="gaps">No gaps.</p>`
        : `<ul class="gaps">${integrity.gaps.map((gap) => `<li>${escapeHtml(gap)}</li>`).join("")}</ul>`;
    let ordinal = 0;
    const items = groupEvents(events)
        .map((group) => {
        const rows = group.events
            .map((event) => {
            const row = renderEvent(event, byId.get(event.parentEventId ?? ""), Math.min(ordinal, 10) * 45);
            ordinal += 1;
            return row;
        })
            .join("\n");
        return `  <section class="agent-group">
    <h2><span class="agent-kicker">Agent</span> ${escapeHtml(group.agentId)}</h2>
    <ol>
${rows}
    </ol>
  </section>`;
    })
        .join("\n");
    const verification = renderVerification(recording);
    const lede = session.finishSummary
        ? `<p class="lede">${escapeHtml(session.finishSummary)}</p>`
        : "";
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Blackbox ${escapeHtml(session.id)}</title>
<style>
  :root {
    color-scheme: light;
    --bg: #c5ced8;
    --paper: #f7f5f2;
    --ink: #1c2128;
    --ink-soft: #24303a;
    --muted: #4e5964;
    --line: #c5ced6;
    --line-strong: #8f9bab;
    --accent: #b5524a;
    --accent-soft: #f6e4e0;
    --accent-ink: #8c3e38;
    --sans: "Segoe UI", "Avenir Next", "Helvetica Neue", sans-serif;
    --mono: "Cascadia Mono", "Segoe UI Mono", Consolas, monospace;
    --ease: cubic-bezier(0.16, 1, 0.3, 1);
  }
  * { box-sizing: border-box; }
  html { background: var(--bg); }
  body {
    margin: 0;
    min-height: 100dvh;
    background: var(--bg);
    color: var(--ink);
    font: 16px/1.5 var(--sans);
    overflow-x: clip;
  }
  p, h1, h2, ul, ol, dd { margin: 0; }
  ul, ol { padding: 0; list-style: none; }
  ::selection { background: #f0d9d6; color: var(--ink); }
  .wash, .grain { position: fixed; pointer-events: none; z-index: 0; }
  .wash {
    top: -20vh;
    right: -6vw;
    width: 46vw;
    height: 46vw;
    background: radial-gradient(circle, rgba(181, 82, 74, 0.28), rgba(181, 82, 74, 0) 68%);
    animation: drift 18s var(--ease) infinite alternate;
    will-change: transform;
  }
  .wash-far {
    top: auto;
    right: auto;
    left: -14vw;
    bottom: -24vh;
    width: 34vw;
    height: 34vw;
    opacity: 0.55;
    animation-duration: 22s;
    animation-direction: alternate-reverse;
  }
  .grain { inset: 0; width: 100%; height: 100%; opacity: 0.045; }
  main {
    position: relative;
    z-index: 1;
    max-width: 1120px;
    margin: 0 auto;
    padding: 40px 28px 80px;
  }
  .mast {
    display: grid;
    grid-template-columns: 1.35fr 0.8fr;
    gap: 36px 56px;
    align-items: start;
  }
  .mast-copy {
    padding: 28px 28px 32px;
    border-radius: 28px;
    background: var(--ink-soft);
    color: var(--paper);
    animation: rise 0.6s var(--ease) both;
  }
  .mast-copy .mark,
  .mast-copy .id-label { color: #b7c3cc; }
  .mast-copy h1,
  .mast-copy .session-id,
  .mast-copy .lede { color: var(--paper); }
  .mast-copy .lamp { background: var(--accent); }
  .mast-meta {
    padding-left: 28px;
    border-left: 1px solid var(--line);
    animation: rise 0.7s var(--ease) 90ms both;
  }
  .mark {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 14px;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.16em;
    color: var(--muted);
  }
  .lamp, .pulse {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--ink);
    flex: none;
  }
  body.incomplete .lamp,
  body.incomplete .pulse {
    background: var(--accent);
    animation: breathe 2.4s var(--ease) infinite;
  }
  h1 {
    font-size: 36px;
    line-height: 1.02;
    font-weight: 600;
    letter-spacing: -0.045em;
  }
  .id-label, .section-label, .agent-kicker {
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--muted);
  }
  .id-label { margin-top: 22px; }
  .session-id {
    margin-top: 4px;
    font-family: var(--mono);
    font-size: 15px;
    line-height: 1.4;
    overflow-wrap: anywhere;
  }
  .lede {
    margin-top: 18px;
    max-width: 62ch;
    font-size: 17px;
    line-height: 1.45;
  }
  .notice {
    margin-top: 14px;
    max-width: 68ch;
    padding-left: 12px;
    border-left: 2px solid var(--line-strong);
    color: var(--muted);
    font-size: 14px;
    line-height: 1.5;
  }
  .banner {
    padding: 16px 16px 14px;
    border: 1px solid var(--line);
    border-radius: 18px;
    background: var(--paper);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.9);
  }
  .banner.incomplete {
    background: var(--accent-soft);
    border-color: rgba(181, 82, 74, 0.28);
  }
  .banner h2 {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 8px;
    font-size: 16px;
    font-weight: 600;
    letter-spacing: -0.02em;
  }
  .banner.incomplete h2,
  .banner.incomplete .gaps,
  .banner.incomplete li { color: var(--accent-ink); }
  .gaps, .banner li { color: var(--muted); font-size: 14px; }
  .banner li + li { margin-top: 4px; }
  .facts { margin-top: 18px; }
  .facts div {
    display: grid;
    grid-template-columns: 112px minmax(0, 1fr);
    gap: 8px;
    padding: 8px 0;
    border-top: 1px solid var(--line);
  }
  .facts dt { color: var(--muted); font-size: 13px; }
  .facts dd { font-size: 14px; overflow-wrap: anywhere; }
  .section-label { margin: 40px 0 12px; }
  .metrics {
    display: grid;
    grid-template-columns: 1.5fr 1fr 1fr 0.92fr;
    grid-template-areas:
      "all chat tool problem"
      "all read edit command";
    gap: 14px;
  }
  .slot-all { grid-area: all; }
  .slot-chat { grid-area: chat; }
  .slot-tool { grid-area: tool; }
  .slot-read { grid-area: read; }
  .slot-edit { grid-area: edit; }
  .slot-command { grid-area: command; }
  .slot-problem { grid-area: problem; }
  .slot {
    display: flex;
    min-width: 0;
    animation: rise 0.6s var(--ease) both;
    animation-delay: calc(var(--d) * 1ms);
  }
  .metric {
    position: relative;
    display: flex;
    flex: 1;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
    width: 100%;
    min-height: 112px;
    padding: 16px 18px 20px;
    overflow: hidden;
    border: 1px solid rgba(28, 33, 40, 0.1);
    border-radius: 16px;
    background: var(--paper);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.85);
    cursor: pointer;
    transition: transform 0.3s var(--ease);
  }
  .metric-all {
    justify-content: space-between;
    padding: 24px 24px 28px;
    border-radius: 28px;
    border-color: var(--ink-soft);
    background: var(--ink-soft);
    color: var(--paper);
    box-shadow: 0 22px 44px -28px rgba(28, 33, 40, 0.55);
  }
  .metric-all .metric-kicker,
  .metric-all .metric-note { color: #c5d0d8; }
  .metric-all strong { color: var(--paper); }
  .metric-all:has(input:checked) .metric-kicker { color: #f0c7c3; }
  .metric-chat { background: #f8eeec; }
  .metric-tool { background: #f3e3de; }
  .metric-read {
    background: #d5e2ee;
    border-color: #8eacbf;
  }
  .metric-read .metric-kicker,
  .metric-read strong { color: #1d3344; }
  .metric-read .metric-note { color: #3d5568; }
  .metric-read::after { background: #2f4a5c; }
  .metric-read:has(input:checked) .metric-kicker { color: #1d3344; }
  .metric-edit {
    background: #f0c4bd;
    border-color: rgba(181, 82, 74, 0.55);
  }
  .metric-edit .metric-kicker,
  .metric-edit strong { color: var(--accent-ink); }
  .metric-command { background: #e6cfc8; }
  .metric-problem { border-radius: 22px; border-color: rgba(181, 82, 74, 0.35); background: #f8d7d2; }
  .metric-problem.hot {
    background: #f0c4bd;
    border-color: rgba(181, 82, 74, 0.55);
  }
  .metric input {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
    border: 0;
  }
  .metric strong {
    font-family: var(--mono);
    font-size: 28px;
    font-weight: 600;
    letter-spacing: -0.04em;
    line-height: 0.95;
    font-variant-numeric: tabular-nums;
  }
  .metric-all strong { font-size: 68px; letter-spacing: -0.055em; }
  .metric-problem.hot strong { color: var(--accent-ink); }
  .metric-kicker { font-size: 13px; font-weight: 600; color: var(--muted); }
  .metric-note { font-size: 13px; line-height: 1.35; color: var(--muted); }
  .metric::after {
    content: "";
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 2px;
    background: var(--accent);
    transform: scaleX(0);
    transform-origin: left center;
    transition: transform 0.35s var(--ease);
  }
  .metric:has(input:checked) { border-color: rgba(181, 82, 74, 0.55); }
  .metric:has(input:checked) .metric-kicker { color: var(--accent-ink); }
  .metric:has(input:checked)::after { transform: scaleX(1); }
  .metric:focus-within { outline: 2px solid var(--accent); outline-offset: 3px; }
  @media (hover: hover) {
    .metric:hover { transform: translateY(-2px); }
  }
  .metric:active { transform: scale(0.98); }
  .other-note, .guide {
    max-width: 62ch;
    margin-top: 14px;
    color: var(--muted);
    font-size: 14px;
  }
  .guide { margin-top: 6px; }
  .work {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 0fr);
    gap: 0;
    align-items: stretch;
    margin-top: 16px;
    transition: gap 0.4s var(--ease), grid-template-columns 0.4s var(--ease);
  }
  html.js .work.open {
    grid-template-columns: minmax(280px, 0.9fr) minmax(320px, 1.15fr);
    gap: 16px;
  }
  .listpane, .stage {
    min-height: 0;
    height: min(760px, calc(100dvh - 36px));
    border: 1px solid var(--line);
    border-radius: 18px;
    background: var(--paper);
  }
  .listpane { position: sticky; top: 12px; overflow: auto; padding: 12px 14px 8px; }
  .stage {
    position: sticky;
    top: 12px;
    overflow: auto;
    min-width: 0;
    padding: 8px 18px 20px;
  }
  html.js .work:not(.open) .stage { display: none; }
  html.js .work.open .stage {
    border-color: rgba(181, 82, 74, 0.45);
    background: #fff8f6;
    animation: open-stage 0.42s var(--ease);
  }
  .stage-bar {
    display: flex;
    justify-content: flex-end;
    position: sticky;
    top: 0;
    z-index: 1;
    padding: 6px 0 10px;
    background: #fff8f6;
  }
  .stage-close {
    border: 1px solid var(--line-strong);
    border-radius: 999px;
    background: #fff;
    color: var(--ink);
    padding: 6px 12px;
    font: inherit;
    font-size: 13px;
    cursor: pointer;
  }
  .stage-sheet { animation: rise 0.45s var(--ease); }
  .find { display: block; margin-bottom: 8px; color: var(--muted); font-size: 13px; font-weight: 600; }
  .find input {
    display: block;
    width: 100%;
    margin-top: 6px;
    padding: 11px 12px;
    border: 1px solid var(--line-strong);
    border-radius: 12px;
    background: #fff;
    color: var(--ink);
    font: inherit;
    font-weight: 400;
  }
  .view-label { margin: 0 0 8px; color: var(--muted); font-size: 13px; }
  .stage .step-body { display: block; padding-top: 4px; }
  html.js .step > .step-body { display: none; }
  .step[data-kind="read"] > summary { box-shadow: inset 3px 0 0 #2f4a5c; }
  .step[data-kind="edit"] > summary { box-shadow: inset 3px 0 0 var(--accent); }
  .kind-banner {
    display: inline-block;
    margin-bottom: 10px;
    padding: 3px 8px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .kind-banner.read { background: #d5e2ee; color: #1d3344; }
  .kind-banner.edit { background: #f0c4bd; color: var(--accent-ink); }
  .empty { display: none; max-width: 46ch; margin-top: 28px; padding-top: 22px; border-top: 1px solid var(--line); }
  .empty-title { margin-bottom: 6px; font-size: 18px; font-weight: 600; letter-spacing: -0.03em; }
  .empty p:last-child { color: var(--muted); }
${filterCss()}
  .agent-group { margin-top: 36px; }
  .agent-group h2 {
    display: flex;
    align-items: baseline;
    gap: 10px;
    margin-bottom: 8px;
    font-size: 18px;
    font-weight: 600;
    letter-spacing: -0.03em;
  }
  .step {
    animation: rise 0.55s var(--ease) both;
    animation-delay: calc(var(--d) * 1ms);
  }
  .event { border-top: 1px solid var(--line); }
  .step > summary {
    display: grid;
    grid-template-columns: 52px minmax(0, 1fr) 16px;
    grid-template-areas:
      "seq type chev"
      "seq head chev"
      "seq meta chev";
    column-gap: 14px;
    row-gap: 3px;
    align-items: start;
    padding: 14px 2px 14px 0;
    color: var(--ink);
    cursor: pointer;
    list-style: none;
  }
  .step > summary::-webkit-details-marker,
  .raw > summary::-webkit-details-marker { display: none; }
  .step > summary:focus-visible,
  .raw > summary:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 3px;
    border-radius: 8px;
  }
  .step > summary::before,
  .raw > summary::before {
    content: "";
    width: 8px;
    height: 8px;
    border-right: 1.5px solid var(--muted);
    border-bottom: 1.5px solid var(--muted);
    transform: rotate(-45deg);
    transition: transform 0.3s var(--ease);
  }
  .step > summary::before { grid-area: chev; align-self: start; justify-self: end; margin-top: 6px; }
  .raw > summary::before {
    display: inline-block;
    width: 6px;
    height: 6px;
    margin-right: 8px;
    vertical-align: 1px;
  }
  .step[open] > summary::before,
  .raw[open] > summary::before { transform: rotate(45deg); }
  .bad .step > summary {
    box-shadow: inset 3px 0 0 var(--accent);
    padding-left: 12px;
  }
  .seq {
    grid-area: seq;
    padding-top: 2px;
    color: var(--muted);
    font-family: var(--mono);
    font-size: 13px;
    font-variant-numeric: tabular-nums;
  }
  .type { grid-area: type; min-width: 0; font-weight: 600; letter-spacing: -0.01em; }
  .headline { grid-area: head; min-width: 0; overflow-wrap: anywhere; }
  .headline:empty { display: none; }
  .meta {
    grid-area: meta;
    display: flex;
    flex-wrap: wrap;
    min-width: 0;
    color: var(--muted);
    font-size: 13px;
  }
  .meta > * + *::before { content: " · "; color: var(--line-strong); }
  .meta time { font-family: var(--mono); font-size: 12px; }
  .hint { color: var(--muted); font-weight: 450; }
  .bad .type { color: var(--accent-ink); }
  .step > .step-body { padding: 2px 8px 18px 66px; }
  .step[open] > .step-body { animation: rise 0.35s var(--ease); }
  .parent { margin-top: 4px; color: var(--muted); font-size: 13px; }
  .who { margin-top: 14px; font-weight: 600; }
  .text, .note, pre, .cmd { white-space: pre-wrap; overflow-wrap: anywhere; }
  .text { margin-top: 6px; }
  .note { margin-top: 8px; color: var(--muted); font-size: 14px; }
  .cmd, pre {
    margin-top: 10px;
    padding: 10px 12px;
    border-radius: 12px;
    background: #f7f8fa;
    font-family: var(--mono);
    font-size: 13px;
    line-height: 1.45;
  }
  .terminal { background: var(--ink); color: #f4f6f8; }
  .kv {
    display: grid;
    grid-template-columns: minmax(140px, 220px) minmax(0, 1fr);
    gap: 8px 16px;
    margin-top: 10px;
  }
  .kv dt { color: var(--muted); font-size: 13px; }
  .diff {
    margin-top: 10px;
    overflow: auto;
    border: 1px solid var(--line);
    border-radius: 12px;
    background: #fff;
    font-family: var(--mono);
    font-size: 13px;
    line-height: 1.5;
  }
  .diff + .diff { margin-top: 12px; }
  .diff-row {
    display: grid;
    grid-template-columns: 3.4em 3.4em 1.2em minmax(0, max-content);
    column-gap: 10px;
    padding: 0 12px 0 0;
  }
  .diff-row code { font-family: inherit; white-space: pre; }
  .diff-row.remove { background: #f6e4e0; }
  .diff-row.add { background: #dcecde; }
  .diff-row .ln, .diff-row .mark {
    padding: 0 4px;
    color: var(--muted);
    text-align: right;
    user-select: none;
  }
  .diff-row.remove .mark { color: var(--accent-ink); }
  .diff-row.add .mark { color: #24633a; }
  .raw { margin-top: 16px; }
  .raw > summary { color: var(--muted); font-size: 13px; cursor: pointer; list-style: none; }
  .verify { margin-top: 56px; padding-top: 28px; border-top: 1px solid var(--line); }
  .verify h2 { margin-bottom: 12px; font-size: 22px; font-weight: 600; letter-spacing: -0.03em; }
  .verify ul { margin-top: 16px; }
  .verify li { padding: 10px 0; border-top: 1px solid var(--line); }
  .passed { color: var(--ink); }
  .failed { color: var(--accent-ink); }
  @keyframes rise {
    from { opacity: 0; transform: translateY(12px); }
    to { opacity: 1; transform: translateY(0); }
  }
  @keyframes open-stage {
    from { opacity: 0; transform: translateX(18px); }
    to { opacity: 1; transform: translateX(0); }
  }
  @keyframes drift {
    from { opacity: 0.55; transform: translate3d(0, 0, 0) scale(1); }
    to { opacity: 0.95; transform: translate3d(-6%, 8%, 0) scale(1.06); }
  }
  @keyframes breathe {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.35; transform: scale(0.72); }
  }
  @media (max-width: 960px) {
    .metrics {
      grid-template-columns: 1.4fr 1fr;
      grid-template-areas:
        "all problem"
        "chat tool"
        "read edit"
        "command command";
    }
  }
  @media (max-width: 767px) {
    main { width: 100%; padding: 28px 16px 64px; }
    .mast, .metrics { grid-template-columns: 1fr; }
    .mast { gap: 24px; }
    .mast-meta { padding-left: 0; padding-top: 8px; border-left: 0; border-top: 1px solid var(--line); }
    h1 { font-size: 32px; }
    .metric-all strong { font-size: 52px; }
    .metrics {
      grid-template-areas:
        "all"
        "chat"
        "tool"
        "read"
        "edit"
        "command"
        "problem";
    }
    .facts div, .kv { grid-template-columns: 1fr; }
    .kv dt { margin-top: 8px; }
    .work, html.js .work.open { grid-template-columns: 1fr; gap: 12px; }
    .listpane, .stage { position: static; height: auto; max-height: 70vh; }
    .step > summary { grid-template-columns: 40px minmax(0, 1fr) 16px; column-gap: 10px; }
    .step > .step-body { padding: 2px 0 16px; }
  }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation: none !important;
      transition: none !important;
    }
  }
</style>
</head>
<body class="${bannerClass}">
<div class="wash" aria-hidden="true"></div>
<div class="wash wash-far" aria-hidden="true"></div>
<svg class="grain" aria-hidden="true">
  <filter id="grain-filter">
    <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" stitchTiles="stitch"></feTurbulence>
  </filter>
  <rect width="100%" height="100%" filter="url(#grain-filter)"></rect>
</svg>
<main>
  <header class="mast">
    <div class="mast-copy">
      <p class="mark"><span class="lamp" aria-hidden="true"></span>BLACKBOX</p>
      <h1>Session recording</h1>
      <p class="id-label">Session</p>
      <p class="session-id">${escapeHtml(session.id)}</p>
      ${lede}
    </div>
    <aside class="mast-meta">
      <section class="banner ${bannerClass}">
        <h2><span class="pulse" aria-hidden="true"></span>${bannerTitle}</h2>
        ${gaps}
      </section>
      <dl class="facts">
        <div><dt>Status</dt><dd>${escapeHtml(session.status)}</dd></div>
        <div><dt>Agent</dt><dd>${escapeHtml(agentLabel(session.agent))}</dd></div>
        <div><dt>Started</dt><dd>${escapeHtml(session.startedAt)}</dd></div>
        <div><dt>Finished</dt><dd>${escapeHtml(session.finishedAt ?? "-")}</dd></div>
        <div><dt>Events</dt><dd>${integrity.eventCount}</dd></div>
        <div><dt>Content captured</dt><dd>${session.captureContent ? "yes" : "no"}</dd></div>
        <div><dt>Secrets redacted</dt><dd>${session.redactSecrets ? "yes" : "no"}</dd></div>
      </dl>
    </aside>
  </header>
  ${renderDashboard(events)}
  <p class="guide">Click a count to filter. Click a step and its record slides open beside the list.</p>
  <div class="work" id="work">
    <div class="listpane">
      <label class="find">Search this recording
        <input id="find" type="search" placeholder="A file, a command, or words from the chat">
      </label>
      <p class="view-label" id="view-label">Showing all steps</p>
      <div class="stream">
${items}
    ${renderEmpties()}
      </div>
    </div>
    <article class="stage" id="stage"></article>
  </div>
  ${verification}
</main>
<script>
(function () {
  document.documentElement.classList.add("js");
  var find = document.getElementById("find");
  var label = document.getElementById("view-label");
  var stage = document.getElementById("stage");
  var work = document.getElementById("work");
  var view = "all";
  var names = { all: "all steps", chat: "chat", tool: "tools", read: "reads", edit: "edits", command: "commands", problem: "problems" };
  function rows() { return document.querySelectorAll(".event"); }
  function showCount() {
    var shown = 0;
    rows().forEach(function (row) { if (!row.hidden) shown += 1; });
    label.textContent = "Showing " + shown + " " + (names[view] || "steps");
  }
  function apply() {
    var query = (find.value || "").toLowerCase();
    rows().forEach(function (row) {
      var step = row.querySelector(".step");
      var kind = step ? step.getAttribute("data-kind") : "";
      var kindOk = view === "all" || (view === "problem" ? row.classList.contains("bad") : kind === view);
      var textOk = query.length === 0 || row.textContent.toLowerCase().indexOf(query) !== -1;
      row.hidden = !(kindOk && textOk);
      if (row.hidden && step && step.classList.contains("on")) closeStage();
    });
    document.querySelectorAll(".agent-group").forEach(function (group) {
      var visible = false;
      group.querySelectorAll(".event").forEach(function (row) { if (!row.hidden) visible = true; });
      group.hidden = !visible;
    });
    showCount();
  }
  document.querySelectorAll(".metric input").forEach(function (input) {
    input.addEventListener("change", function () {
      view = input.id.replace("view-", "");
      apply();
    });
  });
  find.addEventListener("input", apply);
  function closeStage() {
    work.classList.remove("open");
    document.querySelectorAll(".step.on").forEach(function (open) { open.classList.remove("on"); });
    stage.replaceChildren();
  }
  function openStage(step, summary) {
    document.querySelectorAll(".step.on").forEach(function (open) { open.classList.remove("on"); });
    step.classList.add("on");
    var body = step.querySelector(".step-body");
    var type = summary.querySelector(".type");
    var title = summary.querySelector(".headline");
    var bits = [];
    if (type && type.textContent) bits.push(type.textContent);
    if (title && title.textContent) bits.push(title.textContent);
    stage.replaceChildren();
    var bar = document.createElement("div");
    bar.className = "stage-bar";
    var close = document.createElement("button");
    close.type = "button";
    close.className = "stage-close";
    close.textContent = "Close";
    close.addEventListener("click", closeStage);
    bar.appendChild(close);
    var sheet = document.createElement("div");
    sheet.className = "stage-sheet";
    var heading = document.createElement("p");
    heading.className = "who";
    heading.textContent = bits.length ? bits.join(" · ") : "Step";
    sheet.appendChild(heading);
    if (body) sheet.appendChild(body.cloneNode(true));
    stage.appendChild(bar);
    stage.appendChild(sheet);
    work.classList.add("open");
  }
  document.querySelectorAll(".step > summary").forEach(function (summary) {
    summary.addEventListener("click", function (event) {
      event.preventDefault();
      var step = summary.parentElement;
      if (step.classList.contains("on")) closeStage();
      else openStage(step, summary);
    });
  });
  apply();
})();
</script>
</body>
</html>
`;
}
export function writeReport(store, sessionId, outPath) {
    const recording = store.readRecording(sessionId);
    const target = outPath
        ? path.resolve(outPath)
        : path.join(sessionDirectory(store.directory, sessionId), "report.html");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, renderReport(recording), "utf8");
    return target;
}
function renderEvent(event, parent, delay) {
    const bad = event.type === "error" || event.data.isError === true;
    const parentHtml = event.parentEventId
        ? parent
            ? `<p class="parent">follows step ${parent.sequence} · ${explainLabel(parent.type)}</p>`
            : `<p class="parent">follows ${escapeHtml(event.parentEventId)}</p>`
        : "";
    const title = headline(event);
    return `    <li class="event${bad ? " bad" : ""}">
      <details class="step" data-kind="${kindOf(event)}" style="--d:${delay}">
        <summary>
          <span class="seq">${escapeHtml(String(event.sequence).padStart(2, "0"))}</span>
          <span class="type">${explainLabel(event.type)}</span>
          <span class="headline">${title.length > 0 ? escapeHtml(title) : ""}</span>
          <span class="meta"><span class="source">${explainLabel(event.source)}</span><span class="agent">${escapeHtml(event.agentId)}</span><time datetime="${escapeHtml(event.timestamp)}">${escapeHtml(event.timestamp)}</time></span>
        </summary>
        <div class="step-body">
          ${parentHtml}
          ${renderBody(event)}
          <details class="raw">
            <summary>Raw record</summary>
            <pre>${escapeHtml(JSON.stringify(event.data, null, 2))}</pre>
          </details>
        </div>
      </details>
    </li>`;
}
function renderDashboard(events) {
    const counts = { all: events.length, chat: 0, tool: 0, read: 0, edit: 0, command: 0, problem: 0, other: 0 };
    for (const event of events) {
        const kind = kindOf(event);
        counts[kind] += 1;
        if (event.type === "error" || event.data.isError === true)
            counts.problem += 1;
    }
    const cards = [
        { id: "all", label: "All steps", note: "Everything recorded", count: counts.all, checked: true },
        { id: "chat", label: "Chat", note: "What you said, and the reply", count: counts.chat, checked: false },
        { id: "tool", label: "Tools", note: "Calls and results", count: counts.tool, checked: false },
        { id: "read", label: "Reads", note: "Files the agent opened", count: counts.read, checked: false },
        { id: "edit", label: "Edits", note: "Files the agent changed", count: counts.edit, checked: false },
        { id: "command", label: "Commands", note: "Shell and processes", count: counts.command, checked: false },
        {
            id: "problem",
            label: "Problems",
            note: counts.problem === 0 ? "None marked failed" : "Marked failed",
            count: counts.problem,
            checked: false,
        },
    ];
    const slots = cards
        .map((card, index) => {
        const hot = card.id === "problem" && card.count > 0 ? " hot" : "";
        return `<div class="slot slot-${card.id}" style="--d:${40 + index * 50}"><label class="metric metric-${card.id}${hot}"><input type="radio" name="view" id="view-${card.id}"${card.checked ? " checked" : ""}><span class="metric-kicker">${escapeHtml(card.label)}</span><strong>${card.count}</strong><span class="metric-note">${escapeHtml(card.note)}</span></label></div>`;
    })
        .join("");
    const otherNote = counts.other === 0
        ? ""
        : `<p class="other-note">${counts.other} ${counts.other === 1 ? "step is" : "steps are"} outside chat, tools, reads, edits, and commands. They stay under All steps.</p>`;
    return `<p class="section-label">In this recording</p><section class="metrics" aria-label="Filter steps">${slots}</section>${otherNote}`;
}
function filterCss() {
    const kinds = ["chat", "tool", "read", "edit", "command"];
    const hideAll = [...kinds, "problem"].map((id) => `  body:has(#view-${id}:checked) .empty-all`).join(",\n");
    const hideRows = kinds
        .map((id) => `  body:has(#view-${id}:checked) .event:not(:has([data-kind="${id}"])) { display: none; }`)
        .join("\n");
    const hideGroups = kinds
        .map((id) => `  body:has(#view-${id}:checked) .agent-group:not(:has([data-kind="${id}"])) { display: none; }`)
        .join("\n");
    const showEmpty = kinds
        .map((id) => `  body:has(#view-${id}:checked) .stream:not(:has([data-kind="${id}"])) .empty-${id}`)
        .join(",\n");
    return `  .stream:not(:has(.event)) .empty-all { display: block; }
${hideAll} { display: none; }
${hideRows}
  body:has(#view-problem:checked) .event:not(.bad) { display: none; }
${hideGroups}
  body:has(#view-problem:checked) .agent-group:not(:has(.event.bad)) { display: none; }
${showEmpty},
  body:has(#view-problem:checked) .stream:not(:has(.event.bad)) .empty-problem { display: block; }`;
}
function renderEmpties() {
    const views = [
        ["all", "No steps yet", "This recording has no events."],
        ["chat", "No chat", "Nothing here was a message from you or the agent."],
        ["tool", "No tools", "The agent did not call a tool in this recording."],
        ["read", "No reads", "No file was opened in this recording."],
        ["edit", "No edits", "No file was changed in this recording."],
        ["command", "No commands", "No shell or process steps were recorded."],
        ["problem", "No problems", "No step is marked as a failure."],
    ];
    return views
        .map(([id, title, copy]) => {
        const tail = id === "all" ? "" : " Choose All steps to see the full list.";
        return `<div class="empty empty-${id}"><p class="empty-title">${title}</p><p>${copy}${tail}</p></div>`;
    })
        .join("\n    ");
}
function kindOf(event) {
    if (event.type === "user.message" || event.type === "assistant.message")
        return "chat";
    if (event.type === "environment.process" || event.data.name === "Shell" || event.data.name === "shell")
        return "command";
    const name = event.data.name;
    if (event.type === "environment.file" || isFileEdit(name))
        return "edit";
    if (isFileRead(name) || isReadReceipt(event))
        return "read";
    if (event.type === "tool.call" || event.type === "tool.result" || event.type.startsWith("mcp."))
        return "tool";
    return "other";
}
function isFileRead(name) {
    return name === "file.read" || name === "Read";
}
function isFileEdit(name) {
    return name === "file.edit" || name === "Write" || name === "StrReplace" || name === "Edit" || name === "Delete";
}
function isReadReceipt(event) {
    if (event.type !== "tool.result")
        return false;
    const output = asObject(event.data.output);
    return output !== undefined && typeof output.content_length === "number" && typeof output.file_path === "string";
}
function headline(event) {
    const data = event.data;
    if (typeof data.content === "string" && data.content.trim().length > 0)
        return clipLine(data.content);
    if (typeof data.message === "string" && data.message.trim().length > 0)
        return clipLine(data.message);
    if (typeof data.command === "string" && data.command.trim().length > 0)
        return clipLine(data.command);
    if (typeof data.name === "string") {
        const args = asObject(data.arguments);
        const target = firstText(args?.file_path, args?.path, args?.command, args?.pattern);
        return target.length > 0 ? clipLine(`${data.name} · ${target}`) : data.name;
    }
    if (typeof data.summary === "string" && data.summary.trim().length > 0)
        return clipLine(data.summary);
    return "";
}
function firstText(...values) {
    for (const value of values) {
        if (typeof value === "string" && value.trim().length > 0)
            return value.trim();
    }
    return "";
}
function clipLine(value) {
    const line = value.replace(/\s+/g, " ").trim();
    return line.length > 90 ? `${line.slice(0, 90)}…` : line;
}
function groupEvents(events) {
    const groups = [];
    for (const event of events) {
        let group = groups.find((item) => item.agentId === event.agentId);
        if (!group) {
            group = { agentId: event.agentId, events: [] };
            groups.push(group);
        }
        group.events.push(event);
    }
    return groups;
}
function renderVerification(recording) {
    const checks = recording.verification;
    const body = checks.length === 0
        ? "<p>Not checked.</p>"
        : `<ul>${checks
            .map((check) => {
            const label = check.status === "passed" ? "Passed" : "Failed";
            return `<li class="${check.status}">${escapeHtml(`${label}: ${check.name} — ${check.message}`)}</li>`;
        })
            .join("")}</ul>`;
    return `<section class="verify">
    <h2>Verification</h2>
    <p class="notice">${escapeHtml(SOURCE_NOTICES.verification)}</p>
    ${body}
  </section>`;
}
function renderBody(event) {
    const data = event.data;
    switch (event.type) {
        case "user.message":
            return speech("You", data.content);
        case "assistant.message":
            return speech("Agent", data.content);
        case "model.request":
            return `${line("Model", data.model ?? data.provider)}${labeledValue("Input", data.input)}`;
        case "model.response":
            return labeledValue("Output", data.output);
        case "tool.call":
            return renderToolCall(data);
        case "tool.result":
            return `${renderToolOutput(data.output)}${showsExit(data.output) ? "" : line("Exit code", data.exitCode)}`;
        case "environment.process":
            return renderProcess(data);
        case "error":
            return `${speech("Error", data.message)}${data.details === undefined ? "" : labeledValue("Details", data.details)}`;
        case "session.started":
            return `<p class="note">Recording started.</p>`;
        case "session.finished":
            return `<p class="note">${escapeHtml(String(data.summary ?? data.status ?? "Recording finished."))}</p>`;
        case "mcp.response":
            return `${line("Tool", data.name)}${line("Server", data.server)}${labeledValue("Input", data.input)}${labeledValue("Output", data.output)}`;
        case "agent.handoff":
            return speech("Handed off", data.task);
        case "agent.completed":
            return `${line("Status", data.status)}${speech("Summary", data.summary)}`;
        case "custom":
            return renderCustom(data);
        default:
            return definitionList(data);
    }
}
function renderToolCall(data) {
    const name = typeof data.name === "string" ? data.name : "tool";
    const note = typeof data.note === "string" ? `<p class="text">${escapeHtml(data.note)}</p>` : "";
    const cwd = line("Folder", data.cwd);
    if (name === "file.read")
        return `${heading(name)}<p class="kind-banner read">Read</p>${renderFileRead(data.arguments)}${note}`;
    if (name === "file.edit")
        return `${heading(name)}<p class="kind-banner edit">Edit</p>${renderFileEdit(data.arguments)}${note}`;
    return `${heading(name)}${cwd}${note}${labeledValue("Input", data.arguments)}`;
}
function renderFileRead(value) {
    const record = asObject(value);
    if (record === undefined)
        return labeledValue("Input", value);
    const preview = typeof record.preview === "string" ? record.preview : "";
    const size = typeof record.byteLength === "number" ? `<p class="note">File size ${record.byteLength} bytes.</p>` : "";
    const body = preview.length > 0
        ? `<p class="who">Preview</p><pre>${escapeHtml(preview)}</pre>`
        : `<p class="note">Cursor did not include the file text.</p>`;
    return `${line("File", record.path)}${size}${body}`;
}
function renderFileEdit(value) {
    const record = asObject(value);
    if (record === undefined)
        return labeledValue("Input", value);
    const edits = Array.isArray(record.edits) ? record.edits : [];
    const blocks = edits
        .map((edit) => {
        const item = asObject(edit);
        if (item === undefined)
            return "";
        const before = typeof item.old_string === "string" ? item.old_string : "";
        const after = typeof item.new_string === "string" ? item.new_string : "";
        return renderLineDiff(before, after);
    })
        .join("");
    return `${line("File", record.path)}${blocks}`;
}
function renderLineDiff(before, after) {
    const rows = lineDiff(before, after);
    if (rows.length === 0)
        return `<p class="note">This edit did not change the file text.</p>`;
    let oldNumber = 1;
    let newNumber = 1;
    const body = rows
        .map((row) => {
        const oldCell = row.kind === "add" ? "" : String(oldNumber);
        const newCell = row.kind === "remove" ? "" : String(newNumber);
        if (row.kind !== "add")
            oldNumber += 1;
        if (row.kind !== "remove")
            newNumber += 1;
        const mark = row.kind === "add" ? "+" : row.kind === "remove" ? "-" : "";
        return `<div class="diff-row ${row.kind}"><span class="ln">${oldCell}</span><span class="ln">${newCell}</span><span class="mark">${mark}</span><code>${escapeHtml(row.text)}</code></div>`;
    })
        .join("");
    return `<div class="diff">${body}</div>`;
}
function lineDiff(before, after) {
    const left = splitLines(before);
    const right = splitLines(after);
    if (left.length * right.length > 250_000) {
        return [
            ...left.map((text) => ({ kind: "remove", text })),
            ...right.map((text) => ({ kind: "add", text })),
        ];
    }
    const next = Array.from({ length: left.length + 1 }, () => new Array(right.length + 1).fill(0));
    for (let i = left.length - 1; i >= 0; i -= 1) {
        const row = next[i];
        const below = next[i + 1];
        if (row === undefined || below === undefined)
            continue;
        for (let j = right.length - 1; j >= 0; j -= 1) {
            const down = below[j] ?? 0;
            const across = row[j + 1] ?? 0;
            row[j] = left[i] === right[j] ? (below[j + 1] ?? 0) + 1 : Math.max(down, across);
        }
    }
    const rows = [];
    let i = 0;
    let j = 0;
    while (i < left.length && j < right.length) {
        const leftLine = left[i] ?? "";
        const rightLine = right[j] ?? "";
        const down = next[i + 1]?.[j] ?? 0;
        const across = next[i]?.[j + 1] ?? 0;
        if (leftLine === rightLine) {
            rows.push({ kind: "same", text: leftLine });
            i += 1;
            j += 1;
        }
        else if (down >= across) {
            rows.push({ kind: "remove", text: leftLine });
            i += 1;
        }
        else {
            rows.push({ kind: "add", text: rightLine });
            j += 1;
        }
    }
    while (i < left.length) {
        rows.push({ kind: "remove", text: left[i] ?? "" });
        i += 1;
    }
    while (j < right.length) {
        rows.push({ kind: "add", text: right[j] ?? "" });
        j += 1;
    }
    return rows;
}
function splitLines(value) {
    if (value.length === 0)
        return [];
    const lines = value.split("\n");
    if (lines[lines.length - 1] === "")
        lines.pop();
    return lines;
}
function renderToolOutput(value) {
    const record = asObject(value);
    if (record !== undefined && typeof record.output === "string") {
        const code = record.exitCode ?? record.exit_code;
        return `${line("Exit code", code)}<pre class="terminal">${escapeHtml(record.output)}</pre>`;
    }
    if (record !== undefined && typeof record.content_length === "number") {
        const where = typeof record.file_path === "string" ? ` for ${record.file_path}` : "";
        return `<p class="note">Cursor sent the file size only${escapeHtml(where)}: ${record.content_length} characters. The file text is on the file read step when that hook runs.</p>`;
    }
    if (record !== undefined && typeof record.pattern === "string" && Object.keys(record).every((key) => ["pattern", "success", "output_mode"].includes(key))) {
        return `<p class="note">Search finished. Cursor did not include the matching lines.</p>${line("Pattern", record.pattern)}`;
    }
    return labeledValue("Output", value);
}
function showsExit(value) {
    const record = asObject(value);
    return record !== undefined && (record.exitCode !== undefined || record.exit_code !== undefined);
}
function renderProcess(data) {
    const args = Array.isArray(data.args) ? data.args.filter((item) => typeof item === "string").join(" ") : "";
    const command = [typeof data.command === "string" ? data.command : "", args].filter((part) => part.length > 0).join(" ");
    const exit = data.exitCode === null || data.exitCode === undefined ? "not reported" : String(data.exitCode);
    const output = typeof data.output === "string" && data.output.length > 0 ? `<pre class="terminal">${escapeHtml(data.output)}</pre>` : "";
    return `<p class="cmd">$ ${escapeHtml(command)}</p><p class="note">Exit code ${escapeHtml(exit)}</p>${output}`;
}
function renderCustom(data) {
    const name = typeof data.name === "string" ? data.name : "";
    const inner = asObject(data.data);
    if (name === "cursor.thought") {
        const duration = inner?.durationMs;
        const size = inner?.byteLength;
        return `<p class="note">The agent paused to think${typeof duration === "number" ? ` for ${duration} ms` : ""}. The thinking text is not stored${typeof size === "number" ? ` (${size} bytes)` : ""}.</p>`;
    }
    if (name === "cursor.turn")
        return `<p class="note">Turn finished${inner?.status ? `: ${escapeHtml(String(inner.status))}` : ""}.</p>`;
    if (name === "cursor.compact")
        return `<p class="note">Cursor compacted the conversation.</p>`;
    return `${heading(name || "custom")}${inner ? definitionList(inner) : ""}`;
}
function speech(who, value) {
    if (typeof value !== "string" || value.length === 0)
        return "";
    return `<p class="who">${escapeHtml(who)}</p><p class="text">${escapeHtml(value)}</p>`;
}
function heading(value) {
    return `<p class="who">${explainLabel(value)}</p>`;
}
function line(label, value) {
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean")
        return "";
    if (value === "")
        return "";
    return `<p class="note">${explainLabel(label)}: ${explainValue(value)}</p>`;
}
function labeledValue(label, value) {
    if (value === undefined)
        return "";
    if (typeof value === "string")
        return `<p class="who">${explainLabel(label)}</p><pre>${escapeHtml(value)}</pre>`;
    const record = asObject(value);
    if (record !== undefined)
        return `<p class="who">${explainLabel(label)}</p>${definitionList(record)}`;
    return `<p class="who">${explainLabel(label)}</p><pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre>`;
}
function definitionList(record) {
    const rows = Object.entries(record)
        .map(([key, value]) => {
        const body = renderScalar(value);
        return `<dt>${explainLabel(key)}</dt><dd>${body}</dd>`;
    })
        .join("");
    return `<dl class="kv">${rows}</dl>`;
}
function renderScalar(value) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
        return explainValue(value);
    }
    return `<pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre>`;
}
const LABELS = {
    "session.started": "the recording opened",
    "session.finished": "the recording closed",
    "user.message": "what you typed",
    "assistant.message": "what the agent replied",
    "model.request": "a question sent to the model",
    "model.response": "the model's answer",
    "tool.call": "the agent started a tool",
    "tool.result": "what the tool returned",
    "model.stream.delta": "one piece of a streaming answer",
    error: "something failed",
    retry: "the agent tried again",
    "agent.handoff": "work was passed to another agent",
    "agent.completed": "the other agent finished",
    custom: "an extra note",
    "http.request": "an outgoing web call",
    "http.response": "the answer to a web call",
    "http.connect": "a secure connection was opened",
    "mcp.request": "a call to an outside tool",
    "mcp.response": "the outside tool's answer",
    "jsonrpc.request": "a structured tool request",
    "jsonrpc.response": "a structured tool answer",
    "environment.file": "a file on disk changed",
    "environment.git": "a git change",
    "environment.process": "a command that ran",
    "fault.injected": "a test fault was inserted",
    "outcome.check": "a check of the result",
    integration: "reported by the agent",
    protocol: "watched on the network",
    environment: "watched on the computer",
    replay: "played back from a saved run",
    verification: "a result check",
    Grep: "search the text inside files",
    Glob: "find files by name",
    Read: "open a file",
    Write: "create or replace a file",
    StrReplace: "replace one piece of a file",
    Edit: "change part of a file",
    Delete: "remove a file",
    Shell: "run a command",
    Task: "ask a helper agent",
    WebSearch: "search the web",
    WebFetch: "open a web page",
    TodoWrite: "update the task list",
    SemanticSearch: "search by meaning",
    LS: "list the files in a folder",
    AwaitShell: "wait for a command to finish",
    GenerateImage: "create an image",
    EditNotebook: "edit a notebook",
    "file.read": "the file text Cursor was about to read",
    "file.edit": "the edit Cursor saved",
    pattern: "the text to look for",
    file_path: "which file or folder",
    path: "which file or folder",
    glob: "which file names to include",
    output_mode: "how to show the result",
    command: "the command to run",
    cwd: "the folder the command runs in",
    working_directory: "the folder the command runs in",
    contents: "the new file text",
    old_string: "the text that was replaced",
    new_string: "the text that replaced it",
    preview: "the start of the file",
    byteLength: "size in bytes",
    content_length: "how many characters were reported",
    callId: "id that links this step to its result",
    durationMs: "how long it took, in milliseconds",
    duration: "how long it took",
    exitCode: "0 means the command succeeded",
    exit_code: "0 means the command succeeded",
    sandbox: "whether the command was kept in a safe box",
    hook: "which Cursor signal this came from",
    isError: "whether this step failed",
    content: "the message text",
    input: "what was sent in",
    output: "what came back",
    provider: "which model company",
    model: "which model",
    status: "how it ended",
    summary: "a short recap",
    server: "which outside tool server",
    task: "what the helper was asked to do",
    arguments: "the details sent to the tool",
    success: "whether it worked",
    offset: "how many results to skip",
    limit: "how many results to keep",
    head_limit: "how many results to keep",
    timeout: "how long to wait before stopping",
    block_until_ms: "how long to wait, in milliseconds",
    description: "a short label",
    url: "the web address",
    query: "the words to search for",
    target_directory: "the folder to look in",
    multiline: "match across more than one line",
    replace_all: "replace every match, not just the first",
    name: "the name of this step",
};
const VALUES = {
    files_with_matches: "only the names of files that matched",
    content: "the matching lines",
    count: "how many matches",
    "**/*": "every file in every folder",
    true: "yes",
    false: "no",
};
function explainLabel(term) {
    return withMeaning(term, LABELS[term]);
}
function explainValue(value) {
    if (value === null)
        return `<span class="hint">(none)</span>`;
    if (value === "")
        return `<span class="hint">(empty)</span>`;
    const text = String(value);
    return withMeaning(text, VALUES[text]);
}
function withMeaning(term, meaning) {
    if (meaning === undefined)
        return escapeHtml(term);
    return `${escapeHtml(term)} <span class="hint">(${escapeHtml(meaning)})</span>`;
}
function asObject(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return undefined;
    return value;
}
function escapeHtml(value) {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}
//# sourceMappingURL=report.js.map