import { confirmResult, createTestRunner, draftReply, INSTRUCTION, readProjectFile, runExistingAgent } from "./existing-agent.js";
import { Blackbox } from "../src/index.js";
import { isDirectRun } from "../src/direct.js";

export async function runInstrumentedAgent(blackbox: Blackbox): Promise<string> {
  const session = blackbox.startSession({
    agent: { id: "lead-agent", name: "Lead Agent", version: "0.2.0" },
  });
  session.recordUserMessage({ content: INSTRUCTION });

  const reply = await runExistingAgent({
    model: session.wrapModel(draftReply, { provider: "simulated", model: "local-sim" }),
    readFile: session.wrapTool("read_file", readProjectFile),
    runTests: session.wrapTool("run_tests", createTestRunner()),
    retry: (operation) =>
      session.runWithRetry(operation, {
        attempts: 2,
        reason: "Retrying tests after the simulated failure",
      }),
    specialist: (task) =>
      session.handoff({
        agent: { id: "specialist-agent", name: "Specialist Agent" },
        task,
        run: async (child) => {
          const confirm = child.wrapModel(confirmResult, { provider: "simulated", model: "local-sim" });
          return confirm(task);
        },
      }),
  });

  session.recordAssistantMessage({ content: reply });
  session.complete({ summary: "Lead agent finished the task" });
  session.finish({ status: "completed", summary: "Instrumented demo finished" });
  return session.id;
}

if (isDirectRun(import.meta.url)) {
  const directory = ".blackbox";
  const blackbox = Blackbox.open({ directory });
  const sessionId = await runInstrumentedAgent(blackbox);
  process.stdout.write(`Recording ${sessionId}\n`);
  process.stdout.write(`Directory ${directory}\n`);
}
