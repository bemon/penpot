interface McpFileContext {
    projectId?: string | null;
    projectName?: string | null;
    teamId?: string | null;
    teamName?: string | null;
}

interface McpOptions {
    getToken(): string;
    getServerUrl(): string;
    /** Project and team of the current file; absent in Penpot versions without multi-file MCP support. */
    getFileContext?(): McpFileContext;
    setMcpStatus(status: string);
    on(eventType: "disconnect" | "connect", cb: () => void);
}

declare global {
    const mcp: undefined | McpOptions;
}

export {};
