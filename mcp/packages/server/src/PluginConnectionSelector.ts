import { getPluginStatus, HEARTBEAT_STALE_THRESHOLD_MS, PluginStatus } from "./PluginLiveness";
import type { PluginConnectionDescriptor } from "./PluginConnection";

const STATUS_RANK: Record<PluginStatus, number> = { ready: 2, stale: 1, frozen: 0 };

/**
 * Summary of one browser tab running the plugin, as reported to MCP clients.
 */
export interface ConnectedTabSummary {
    /** ID of the page shown in the tab; null if the plugin has not reported it. */
    pageId: string | null;
    pageName: string | null;
    status: PluginStatus;
}

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
    /** the tabs that have the file open, the one preferred for tasks first. */
    tabs: ConnectedTabSummary[];
}

/**
 * Chooses the plugin connection that runs a task and describes the connected files.
 *
 * A requested page is served by a tab showing it; if no tab does, the choice falls back to the file,
 * whose chosen tab then has to switch to the page. Without a target file, the choice is only made when
 * all candidates operate on the same file. Among several suitable tabs, the one with the best liveness
 * status wins, then the most recently established one.
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
     * @param pageId - The ID of the target page, if any
     * @throws Error with guidance for the caller if nothing matches or the choice is ambiguous
     */
    public select<T extends PluginConnectionDescriptor>(candidates: T[], fileId?: string, pageId?: string): T {
        if (candidates.length === 0) {
            throw new Error(this.noConnectionMessage);
        }

        let pool = candidates;
        if (fileId !== undefined) {
            pool = candidates.filter((candidate) => candidate.file?.fileId === fileId);
            if (pool.length === 0) {
                throw new Error(`No connected Penpot file has the ID '${fileId}'. ${this.describe(candidates)}`);
            }
        }

        if (pageId !== undefined) {
            const onPage = pool.filter((candidate) => candidate.page?.pageId === pageId);
            if (onPage.length > 0) {
                return this.best(onPage);
            }
        }

        if (fileId === undefined) {
            const fileCount = new Set(candidates.map(PluginConnectionSelector.fileKey)).size;
            if (fileCount > 1) {
                const pageNote = pageId !== undefined ? ` and no tab shows the page '${pageId}'` : "";
                throw new Error(
                    `${fileCount} Penpot files are connected${pageNote}, so the target file is ambiguous; ` +
                        `pass the \`fileId\` argument to choose one. ${this.describe(candidates)}`
                );
            }
        }

        return this.best(pool);
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
        const tabs = [...group].sort((a, b) => (this.isPreferred(a, b) ? -1 : this.isPreferred(b, a) ? 1 : 0));
        return {
            fileId: file?.fileId ?? null,
            fileName: file?.fileName ?? null,
            projectName: file?.projectName ?? null,
            teamName: file?.teamName ?? null,
            connections: group.length,
            status: this.statusOf(tabs[0]),
            tabs: tabs.map((tab) => ({
                pageId: tab.page?.pageId ?? null,
                pageName: tab.page?.pageName ?? null,
                status: this.statusOf(tab),
            })),
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
        const pages = file.tabs
            .filter((tab) => tab.pageId !== null)
            .map((tab) => `'${tab.pageName}' (pageId: ${tab.pageId})`);
        const tabs = pages.length > 0 ? `; tabs on pages: ${pages.join(", ")}` : "";
        return `'${file.fileName}' (fileId: ${file.fileId}${project}${tabs})`;
    }

    private best<T extends PluginConnectionDescriptor>(pool: T[]): T {
        return pool.reduce((best, candidate) => (this.isPreferred(candidate, best) ? candidate : best));
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
