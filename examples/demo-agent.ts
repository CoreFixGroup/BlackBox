import { Blackbox } from "../src/index.js";
import { isDirectRun } from "../src/direct.js";

export const DEMO_API_KEY = "sk-test-secret-key-1234567890";
export const DEMO_BEARER = "Bearer super-secret-token";
export const DEMO_ERROR = "Tests failed: expected add(2, 2) to equal 4, received 0";

const USER_INSTRUCTION =
  "Read the project files, identify a bug, modify the code, and run the tests.";

export function runDemoAgent(blackbox: Blackbox): string {
  const session = blackbox.startSession({
    agent: { id: "demo-agent", name: "Demo Agent", version: "0.1.0" },
  });

  session.recordUserMessage({ content: USER_INSTRUCTION });

  const request = session.recordModelRequest({
    provider: "simulated",
    model: "local-sim",
    input: [{ role: "user", content: USER_INSTRUCTION }],
  });

  const response = session.recordModelResponse({
    parentEventId: request.id,
    output: {
      text: "I will read src/math.ts and then run the tests.",
      toolCalls: [{ name: "read_file", arguments: { path: "src/math.ts" } }],
    },
  });

  const readCall = session.recordToolCall({
    name: "read_file",
    callId: "call-read-file",
    arguments: { path: "src/math.ts" },
    parentEventId: response.id,
  });

  session.recordToolResult({
    callId: "call-read-file",
    parentEventId: readCall.id,
    output: {
      path: "src/math.ts",
      content: `export function add(a, b) { return a - b; }\napiKey=${DEMO_API_KEY}\n${DEMO_BEARER}`,
      apiKey: DEMO_API_KEY,
      authorization: DEMO_BEARER,
    },
  });

  const failedCall = session.recordToolCall({
    name: "run_tests",
    callId: "call-run-tests-1",
    arguments: { command: "npm test" },
  });

  const failure = session.recordError({
    name: "TestFailure",
    message: DEMO_ERROR,
    parentEventId: failedCall.id,
  });

  session.recordToolResult({
    callId: "call-run-tests-1",
    parentEventId: failedCall.id,
    isError: true,
    output: { exitCode: 1, message: DEMO_ERROR },
  });

  const retry = session.recordRetry({
    attempt: 2,
    reason: "Retrying tests after the simulated fix",
    parentEventId: failure.id,
  });

  const passedCall = session.recordToolCall({
    name: "run_tests",
    callId: "call-run-tests-2",
    arguments: { command: "npm test" },
    parentEventId: retry.id,
  });

  session.recordToolResult({
    callId: "call-run-tests-2",
    output: { exitCode: 0, message: "1 passed" },
  });

  session.recordAssistantMessage({
    content:
      "Simulated result: add() subtracted instead of adding. The test run failed, then passed on retry. This demo only reported those events. It did not change files on disk.",
    parentEventId: passedCall.id,
  });

  session.finish({ status: "completed", summary: "Demo task finished" });
  return session.id;
}

if (isDirectRun(import.meta.url)) {
  const directory = ".blackbox";
  const blackbox = Blackbox.open({ directory });
  const sessionId = runDemoAgent(blackbox);
  process.stdout.write(`Recording ${sessionId}\n`);
  process.stdout.write(`Directory ${directory}\n`);
}
