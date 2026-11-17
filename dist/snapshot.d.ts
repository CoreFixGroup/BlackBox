export interface FileStamp {
    bytes: number;
    hash: string;
}
export interface FileChange {
    path: string;
    action: "created" | "modified" | "deleted";
    bytes: number;
}
export declare function snapshotDirectory(root: string): Map<string, FileStamp>;
export declare function diffSnapshots(before: Map<string, FileStamp>, after: Map<string, FileStamp>): FileChange[];
