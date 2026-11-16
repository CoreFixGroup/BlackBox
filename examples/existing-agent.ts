export const INSTRUCTION = "Read the project files, identify a bug, and run the tests.";

export async function* draftReply(_input: { instruction: string }): AsyncGenerator<string> {
  yield "Found a bug. ";
  yield "The tests need a retry.";
}

export function readProjectFile(args: { path: string }): { path: string; content: string } {
  return {
    path: args.path,
    content: "export function add(a, b) { return a - b; }",
  };
}

export function createTestRunner(): () => { exitCode: number; message: string } {
  let count = 0;
  return () => {
    count += 1;
    if (count === 1) {
      const error = new Error("expected add(2, 2) to equal 4, received 0");
      error.name = "TestFailure";
      throw error;
    }
    return { exitCode: 0, message: "1 passed" };
  };
}

export async function confirmResult(task: string): Promise<string> {
  return `Checked ${task}`;
}

export interface ExistingAgentDependencies {
  model: (input: { instruction: string }) => AsyncIterable<string>;
  readFile: (args: { path: string }) => { path: string; content: string };
  runTests: () => { exitCode: number; message: string };
  specialist: (task: string) => Promise<string>;
  retry: <T>(operation: () => Promise<T> | T) => Promise<T>;
}

export async function runExistingAgent(dependencies: ExistingAgentDependencies): Promise<string> {
  let text = "";
  for await (const chunk of dependencies.model({ instruction: INSTRUCTION })) {
    text += chunk;
  }
  dependencies.readFile({ path: "src/math.ts" });
  await dependencies.retry(() => dependencies.runTests());
  const note = await dependencies.specialist("confirm the test result");
  return `${text} ${note}`;
}
