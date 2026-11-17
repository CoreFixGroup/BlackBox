export interface HttpHooks {
    record(type: string, data: Record<string, unknown>, parentEventId?: string): {
        id: string;
    };
    fail(error: unknown, parentEventId?: string): void;
}
export interface HttpCall {
    requestId: string;
    modelRequestId?: string;
    rpcRequestId?: string;
}
export declare function beginHttpCall(hooks: HttpHooks, input: {
    method: string;
    url: string;
    headers?: unknown;
    body?: unknown;
}): HttpCall;
export declare function finishHttpCall(hooks: HttpHooks, call: HttpCall, input: {
    status: number;
    headers?: unknown;
    body?: unknown;
}): void;
export declare function decodeBody(value: unknown): unknown;
export declare function isModelRequestBody(value: unknown): value is {
    model: string;
    messages: unknown[];
};
export declare function isJsonRpc(value: unknown): value is Record<string, unknown>;
