import { getPluginStatus, HEARTBEAT_STALE_THRESHOLD_MS, PluginStatus } from "./PluginLiveness";
import type { PluginConnectionDescriptor } from "./PluginConnection";

const STATUS_RANK: Record<PluginStatus, number> = { ready: 2, stale: 1, frozen: 0 };

/**
 * Summary of a connected Penpot file, as reported to MCP clients.
 */
export interface ConnectedFileSummary {
    /** ID of the file; null for a plugin that has not reported its file yet. */
    fileId: string | null;
    fileName: string | null;
    projectName: string | null;
    teamName: string | null;
    /** number of plugin connections (browser tabs) that have the file open. */
    connections: number;
    /** best liveness status among these connections. */
    status: PluginStatus;
}

/**
 * Chooses the plugin connection that runs a task and describes the connected files.
 *
 * Without a target file, the choice is only made when all candidates operate on the same file.
 * Among several connections for one file (the file being open in several tabs), the one with the
 * best liveness status wins, then the most recently established one.
 */
export class PluginConnectionSelector {
    /**
     * @param noConnectionMessage - The error message to use when there are no candidates
     * @param now - The current time, in ms since epoch
     * @param staleThresholdMs - The heartbeat age beyond which a connection is stale
     */
    constructor(
        private readonly noConnectionMessage: string,
        private readonly now: number = Date.now(),
        private readonly staleThresholdMs: number = HEARTBEAT_STALE_THRESHOLD_MS
    ) {}

    /**
     * Selects the connection that shall run a task.
     *
     * @param candidates - The connections owned by the requesting user
     * @param fileId - The ID of the target file; may be omitted if only one file is connected
     * @throws Error with guidance for the caller if nothing matches or the choice is ambiguous
     */
    public select<T extends PluginConnectionDescriptor>(candidates: T[], fileId?: string): T {
        if (candidates.length === 0) {
            throw new Error(this.noConnectionMessage);
        }

        let pool = candidates;
        if (fileId !== undefined) {
            pool = candidates.filter((candidate) => candidate.file?.fileId === fileId);
            if (pool.length === 0) {
                throw new Error(`No connected Penpot file has the ID '${fileId}'. ${this.describe(candidates)}`);
            }
        } else {
            const fileCount = new Set(candidates.map(PluginConnectionSelector.fileKey)).size;
            if (fileCount > 1) {
                throw new Error(
                    `${fileCount} Penpot files are connected, so the target file is ambiguous; ` +
                        `pass the \`fileId\` argument to choose one. ${this.describe(candidates)}`
                );
            }
        }

        return pool.reduce((best, candidate) => (this.isPreferred(candidate, best) ? candidate : best));
    }

    /**
     * Summarizes the given connections per file, sorted by project and file name.
     *
     * @param candidates - The connections owned by the requesting user
     */
    public summarize(candidates: PluginConnectionDescriptor[]): ConnectedFileSummary[] {
        const groups = new Map<string, PluginConnectionDescriptor[]>();
        for (const candidate of candidates) {
            const key = PluginConnectionSelector.fileKey(candidate);
            groups.set(key, [...(groups.get(key) ?? []), candidate]);
        }
        return [...groups.values()]
            .map((group) => this.summarizeGroup(group))
            .sort(
                (a, b) =>
                    (a.projectName ?? "").localeCompare(b.projectName ?? "") ||
                    (a.fileName ?? "").localeCompare(b.fileName ?? "")
            );
    }

    private summarizeGroup(group: PluginConnectionDescriptor[]): ConnectedFileSummary {
        const file = group[0].file;
        const best = group.reduce((a, b) => (this.isPreferred(b, a) ? b : a));
        return {
            fileId: file?.fileId ?? null,
            fileName: file?.fileName ?? null,
            projectName: file?.projectName ?? null,
            teamName: file?.teamName ?? null,
            connections: group.length,
            status: this.statusOf(best),
        };
    }

    private describe(candidates: PluginConnectionDescriptor[]): string {
        const lines = this.summarize(candidates).map((file) => `- ${PluginConnectionSelector.formatFile(file)}`);
        return `Connected files:\n${lines.join("\n")}`;
    }

    private static formatFile(file: ConnectedFileSummary): string {
        if (file.fileId === null) {
            return "(a plugin that has not reported its file yet)";
        }
        const project = file.projectName ? `, project '${file.projectName}'` : "";
        return `'${file.fileName}' (fileId: ${file.fileId}${project})`;
    }

    private isPreferred(candidate: PluginConnectionDescriptor, current: PluginConnectionDescriptor): boolean {
        const rankDifference = STATUS_RANK[this.statusOf(candidate)] - STATUS_RANK[this.statusOf(current)];
        if (rankDifference !== 0) {
            return rankDifference > 0;
        }
        return candidate.connectedAt > current.connectedAt;
    }

    private statusOf(connection: PluginConnectionDescriptor): PluginStatus {
        return getPluginStatus(connection, this.now, this.staleThresholdMs);
    }

    private static fileKey(connection: PluginConnectionDescriptor): string {
        return connection.file?.fileId ?? `connection:${connection.connectionId}`;
    }
}
