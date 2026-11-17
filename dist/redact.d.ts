export declare function redactValue(value: unknown): unknown;
export declare function jsonByteLength(value: unknown): number;
export declare function applyCapturePolicy(data: Record<string, unknown>, captureContent: boolean): Record<string, unknown>;
export declare function isPlainObject(value: unknown): value is Record<string, unknown>;
export declare function dropUndefined(data: Record<string, unknown>): Record<string, unknown>;
