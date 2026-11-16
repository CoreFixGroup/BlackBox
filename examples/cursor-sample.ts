import { handleCursorHook } from "../src/cursor-adapter.js";
import { isDirectRun } from "../src/direct.js";

const CONVERSATION = "cursor-sample-hello";

const HOOKS: unknown[] = [
  {
    hook_event_name: "sessionStart",
    conversation_id: CONVERSATION,
    session_id: CONVERSATION,
    is_background_agent: false,
    composer_mode: "agent",
    cursor_version: "sample",
    model: "local-sim",
    workspace_roots: ["."],
  },
  {
    hook_event_name: "beforeSubmitPrompt",
    conversation_id: CONVERSATION,
    prompt: "Create hello.txt that says hello, then print it.",
    attachments: [],
  },
  {
    hook_event_name: "preToolUse",
    conversation_id: CONVERSATION,
    tool_name: "Write",
    tool_use_id: "tool-write",
    tool_input: { path: "hello.txt", contents: "hello" },
    cwd: ".",
  },
  {
    hook_event_name: "afterFileEdit",
    conversation_id: CONVERSATION,
    file_path: "hello.txt",
    edits: [{ old_string: "", new_string: "hello" }],
  },
  {
    hook_event_name: "postToolUse",
    conversation_id: CONVERSATION,
    tool_name: "Write",
    tool_use_id: "tool-write",
    tool_input: { path: "hello.txt" },
    tool_output: "{\"wrote\":true}",
    duration: 12,
  },
  {
    hook_event_name: "afterShellExecution",
    conversation_id: CONVERSATION,
    command: "node -e \"console.log('hello')\"",
    output: "hello\nsk-test-secret-key-1234567890\n",
    duration: 40,
    sandbox: false,
  },
  {
    hook_event_name: "afterAgentThought",
    conversation_id: CONVERSATION,
    text: "This hidden reasoning must not be stored.",
    duration_ms: 15,
  },
  {
    hook_event_name: "afterAgentResponse",
    conversation_id: CONVERSATION,
    text: "Created hello.txt and printed hello.",
  },
  {
    hook_event_name: "stop",
    conversation_id: CONVERSATION,
    status: "completed",
    loop_count: 0,
  },
  {
    hook_event_name: "sessionEnd",
    conversation_id: CONVERSATION,
    session_id: CONVERSATION,
    reason: "completed",
    duration_ms: 500,
    is_background_agent: false,
    final_status: "completed",
  },
];

export function runCursorSample(directory: string): string {
  for (const hook of HOOKS) handleCursorHook(hook, directory);
  return CONVERSATION;
}

if (isDirectRun(import.meta.url)) {
  const directory = ".blackbox";
  runCursorSample(directory);
  process.stdout.write(`Conversation ${CONVERSATION}\n`);
  process.stdout.write(`Directory ${directory}\n`);
}
