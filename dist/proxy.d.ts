import { type HttpHooks } from "./protocol.js";
export interface RecordingProxy {
    port: number;
    url: string;
    close: () => void;
}
export declare function startRecordingProxy(hooks: HttpHooks): Promise<RecordingProxy>;
