import { EmptyToolArgs, Tool } from "../Tool";
import "reflect-metadata";
import type { ToolResponse } from "../ToolResponse";
import { TextResponse } from "../ToolResponse";
import { PenpotMcpServer } from "../PenpotMcpServer";

/**
 * Tool for listing the Penpot files that are connected via the Penpot MCP plugin
 */
export class ListConnectedFilesTool extends Tool<EmptyToolArgs> {
    constructor(mcpServer: PenpotMcpServer) {
        super(mcpServer, EmptyToolArgs.schema);
    }

    public getToolName(): string {
        return "list_connected_files";
    }

    public getToolDescription(): string {
        return (
            "Lists the Penpot files that are currently connected (each browser tab running the Penpot MCP plugin " +
            "connects the file open in it), with their IDs, names and projects. " +
            "Pass a file's `fileId` to other Penpot tools to choose the file they operate on. " +
            "`status` is `ready` for a live tab, `stale` for a tab that has not answered recently " +
            "(suspended by the browser) and `frozen` for a tab the browser froze; " +
            "tools fail for such tabs until the user focuses them."
        );
    }

    protected async executeCore(args: EmptyToolArgs): Promise<ToolResponse> {
        const files = await this.mcpServer.pluginBridge.listConnectedFiles();
        if (files.length === 0) {
            return new TextResponse("No Penpot files are currently connected.");
        }
        return new TextResponse(JSON.stringify(files, null, 2));
    }
}
