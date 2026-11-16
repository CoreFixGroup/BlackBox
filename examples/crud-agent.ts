import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { isDirectRun } from "../src/direct.js";
import { Blackbox } from "../src/index.js";

export const NOTE_NAME = "note.txt";
export const OLD_NOTE_NAME = "old-note.txt";
export const CREATED_TEXT = "hello";
export const UPDATED_TEXT = "hello, updated";
export const OLD_TEXT = "throw this away";
export const USER_TASK = "Create note.txt, read it, update it, and delete old-note.txt.";

export function finalNoteHash(): string {
  return createHash("sha256").update(UPDATED_TEXT).digest("hex");
}

export function prepareWorkspace(root: string): void {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, OLD_NOTE_NAME), OLD_TEXT);
}

interface FileArgs {
  path: string;
  content: string;
}

interface PathArgs {
  path: string;
}

export interface CrudTools {
  createFile(args: FileArgs): { path: string; bytes: number };
  readFile(args: PathArgs): { path: string; content: string };
  updateFile(args: FileArgs): { path: string; bytes: number };
  deleteFile(args: PathArgs): { path: string; deleted: true };
}

export function createCrudTools(root: string): CrudTools {
  const resolvedRoot = path.resolve(root);
  const locate = (relativePath: string): string => {
    const resolved = path.resolve(resolvedRoot, relativePath);
    const prefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
    if (resolved !== resolvedRoot && !resolved.startsWith(prefix)) {
      throw new Error("path escapes the workspace");
    }
    return resolved;
  };

  return {
    createFile(args) {
      const file = locate(args.path);
      if (fs.existsSync(file)) throw new Error("file already exists");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, args.content);
      return { path: args.path, bytes: Buffer.byteLength(args.content) };
    },
    readFile(args) {
      return { path: args.path, content: fs.readFileSync(locate(args.path), "utf8") };
    },
    updateFile(args) {
      const file = locate(args.path);
      if (!fs.existsSync(file)) throw new Error("file does not exist");
      fs.writeFileSync(file, args.content);
      return { path: args.path, bytes: Buffer.byteLength(args.content) };
    },
    deleteFile(args) {
      fs.unlinkSync(locate(args.path));
      return { path: args.path, deleted: true };
    },
  };
}

export type CrudDecision =
  | { text: string; tool: "create_file"; arguments: FileArgs }
  | { text: string; tool: "read_file"; arguments: PathArgs }
  | { text: string; tool: "update_file"; arguments: FileArgs }
  | { text: string; tool: "delete_file"; arguments: PathArgs }
  | { text: string };

export function planCrudStep(input: { step: number; last?: unknown }): CrudDecision {
  switch (input.step) {
    case 0:
      return {
        text: "Create the note.",
        tool: "create_file",
        arguments: { path: NOTE_NAME, content: CREATED_TEXT },
      };
    case 1:
      return { text: "Read the note back.", tool: "read_file", arguments: { path: NOTE_NAME } };
    case 2:
      return {
        text: "Update the note.",
        tool: "update_file",
        arguments: { path: NOTE_NAME, content: UPDATED_TEXT },
      };
    case 3:
      return { text: "Delete the old note.", tool: "delete_file", arguments: { path: OLD_NOTE_NAME } };
    default:
      return { text: "The note was created, read, updated, and the old file was deleted." };
  }
}

export async function runCrudAgent(blackbox: Blackbox, workspace: string): Promise<string> {
  prepareWorkspace(workspace);
  const tools = createCrudTools(workspace);
  const session = blackbox.startSession({
    agent: { id: "crud-agent", name: "CRUD Agent", version: "0.1.0" },
    metadata: { task: "file-crud" },
  });
  session.watchDirectory(workspace);
  session.recordUserMessage({ content: USER_TASK });

  const model = session.wrapModel(planCrudStep, { provider: "simulated", model: "local-sim" });
  const createFile = session.wrapTool("create_file", tools.createFile);
  const readFile = session.wrapTool("read_file", tools.readFile);
  const updateFile = session.wrapTool("update_file", tools.updateFile);
  const deleteFile = session.wrapTool("delete_file", tools.deleteFile);

  let last: unknown;
  for (let step = 0; step < 8; step += 1) {
    const decision = model({ step, last });
    if (!("tool" in decision)) break;
    if (decision.tool === "create_file") last = createFile(decision.arguments);
    else if (decision.tool === "read_file") last = readFile(decision.arguments);
    else if (decision.tool === "update_file") last = updateFile(decision.arguments);
    else last = deleteFile(decision.arguments);
  }

  session.recordAssistantMessage({
    content: "Created note.txt, read it, updated it to the final text, and deleted old-note.txt.",
  });
  session.complete({ summary: "CRUD task finished" });
  session.finish({ status: "completed", summary: "CRUD recording finished" });

  await blackbox.verify(session.id, [
    { type: "file.exists", path: path.join(workspace, NOTE_NAME) },
    { type: "file.sha256", path: path.join(workspace, NOTE_NAME), sha256: finalNoteHash() },
    {
      type: "custom",
      name: "old note deleted",
      run: () => !fs.existsSync(path.join(workspace, OLD_NOTE_NAME)),
    },
  ]);
  return session.id;
}

if (isDirectRun(import.meta.url)) {
  const directory = ".blackbox";
  const workspace = path.join(directory, "crud-workspace");
  const blackbox = Blackbox.open({ directory });
  const sessionId = await runCrudAgent(blackbox, workspace);
  process.stdout.write(`Recording ${sessionId}\n`);
  process.stdout.write(`Directory ${directory}\n`);
  process.stdout.write(`Workspace ${workspace}\n`);
}
