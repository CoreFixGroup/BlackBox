import { type HttpHooks } from "./protocol.js";
export declare function installHttpCapture(ownerId: string, hooks: HttpHooks): () => void;
