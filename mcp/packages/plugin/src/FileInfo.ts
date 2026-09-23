import type { PluginFileInfo } from "../../common/src";

/**
 * Project and team of the current file, as provided by the Penpot-integrated MCP extension.
 */
export interface FileContext {
    projectId?: string | null;
    projectName?: string | null;
    teamId?: string | null;
    teamName?: string | null;
}

/**
 * Builds the descriptor of the file the plugin operates on, as reported to the MCP server.
 *
 * @param file - the current Penpot file, or null if no file is open
 * @param context - the file's project and team, if known
 * @returns the descriptor, or null if no file is open
 */
export function buildFileInfo(file: { id: string; name: string } | null, context?: FileContext): PluginFileInfo | null {
    if (!file) {
        return null;
    }
    const info: PluginFileInfo = { fileId: file.id, fileName: file.name };
    if (context?.projectId) info.projectId = context.projectId;
    if (context?.projectName) info.projectName = context.projectName;
    if (context?.teamId) info.teamId = context.teamId;
    if (context?.teamName) info.teamName = context.teamName;
    return info;
}
