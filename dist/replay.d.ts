import type { Recording, WrapModelOptions } from "./types.js";
import type { Session } from "./session.js";
export declare class Replay {
    readonly session: Session;
    private readonly responses;
    private readonly tools;
    constructor(session: Session, recording: Recording);
    wrapModel<TInput, TResult>(_model: (input: TInput) => TResult, options?: WrapModelOptions): (input: TInput) => TResult;
    wrapTool<TResult>(name: string, tool: () => TResult): () => TResult;
    wrapTool<TArgs, TResult>(name: string, tool: (args: TArgs) => TResult): (args: TArgs) => TResult;
    run<T>(fn: (replay: Replay) => Promise<T> | T): Promise<T>;
}
