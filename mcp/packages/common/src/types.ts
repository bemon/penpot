/**
 * Result of a plugin task execution.
 *
 * Contains the outcome status of a task and any additional result data.
 */
export interface PluginTaskResult<T> {
    /**
     * Optional result data from the task execution.
     */
    data?: T;
}

/**
 * Request message sent from server to plugin.
 *
 * Contains a unique identifier, task name, and parameters for execution.
 */
export interface PluginTaskRequest {
    /**
     * Unique identifier for request/response correlation.
     */
    id: string;

    /**
     * The name of the task to execute.
     */
    task: string;

    /**
     * The parameters for task execution.
     */
    params: any;
}

/**
 * Response message sent from plugin back to server.
 *
 * Contains the original request ID and the execution result.
 */
export interface PluginTaskResponse<T> {
    /**
     * Unique identifier matching the original request.
     */
    id: string;

    /**
     * Whether the task completed successfully.
     */
    success: boolean;

    /**
     * Optional error message if the task failed.
     */
    error?: string;

    /**
     * The result of the task execution.
     */
    data?: T;
}

/**
 * Parameters for the executeCode task.
 */
export interface ExecuteCodeTaskParams {
    /**
     * The JavaScript code to be executed.
     */
    code: string;

    /**
     * The ID of the page to make active before the code runs, if any.
     */
    pageId?: string;
}

/**
 * Result data for the executeCode task.
 */
export interface ExecuteCodeTaskResultData<T> {
    /**
     * The result of the executed code, if any.
     */
    result: T;

    /**
     * Captured console output during code execution.
     */
    log: string;
}

/**
 * Descriptor of the Penpot file that a plugin instance operates on.
 *
 * Project and team details are only present when the plugin runs with the
 * Penpot-integrated MCP extension.
 */
export interface PluginFileInfo {
    /**
     * The ID of the Penpot file.
     */
    fileId: string;

    /**
     * The name of the Penpot file.
     */
    fileName: string;

    /**
     * The ID of the project containing the file, if known.
     */
    projectId?: string;

    /**
     * The name of the project containing the file, if known.
     */
    projectName?: string;

    /**
     * The ID of the team owning the project, if known.
     */
    teamId?: string;

    /**
     * The name of the team owning the project, if known.
     */
    teamName?: string;
}

/**
 * Descriptor of the page shown in the browser tab of a plugin instance.
 */
export interface PluginPageInfo {
    /**
     * The ID of the page.
     */
    pageId: string;

    /**
     * The name of the page.
     */
    pageName: string;
}

/**
 * Message sent from plugin to server to announce the file and page the plugin operates on.
 *
 * Sent whenever the WebSocket opens and whenever the file or page changes.
 */
export interface PluginRegisterMessage {
    type: "register";
    file: PluginFileInfo;
    page?: PluginPageInfo | null;
}
