export interface GitStatus {
    available: boolean;
    inside: boolean;
    paths: string[];
    summary: string;
}
export declare function collectGitStatus(root: string, command?: string): GitStatus;
export declare function porcelainPaths(text: string): string[];
