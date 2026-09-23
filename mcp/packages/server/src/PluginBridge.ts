import { WebSocket, WebSocketServer } from "ws";
import * as http from "http";
import { randomUUID } from "crypto";
import { AbstractPluginTask, PluginTask } from "./PluginTask";
import { RemotePluginTask } from "./RemotePluginTask";
import { PluginTaskRequest, PluginTaskResponse, PluginTaskResult } from "@penpot/mcp-common";
import { createLogger } from "./logger";
import { assertPluginResponsive } from "./PluginLiveness";
import { parsePluginFileInfo, PluginConnectionDescriptor, toConnectionDescriptor } from "./PluginConnection";
import { ConnectedFileSummary, PluginConnectionSelector } from "./PluginConnectionSelector";
import type { PenpotMcpServer } from "./PenpotMcpServer";
import type { RedisBridge } from "./RedisBridge";

/**
 * Interval at which the server asks each plugin for a heartbeat.
 *
 * The plugin answers from its socket message handler. Browsers throttle timers in background tabs,
 * but not WebSocket message delivery, so the server sets the pace rather than the plugin's own timer.
 */
const HEARTBEAT_REQUEST_INTERVAL_MS = 10_000;

/**
 * Maximum number of simultaneous plugin connections (browser tabs) per user token in multi-user mode.
 */
export const MAX_CONNECTIONS_PER_USER = 20;

/**
 * Interval at which local connections are republished to the shared registry (multi-instance mode).
 */
const REGISTRY_REFRESH_INTERVAL_MS = 10_000;

/**
 * Lifetime of a shared registry entry; entries of a crashed instance disappear after it.
 */
const REGISTRY_ENTRY_TTL_MS = 3 * REGISTRY_REFRESH_INTERVAL_MS;

interface ClientConnection extends PluginConnectionDescriptor {
    socket: WebSocket;
    userToken: string | null;
    pingInterval: NodeJS.Timeout;
}

/**
 * Target of a plugin task.
 */
export interface PluginTaskTarget {
    /**
     * ID of the Penpot file in which to run the task; may be omitted if only one file is connected.
     */
    fileId?: string;
}

/**
 * Manages WebSocket connections to Penpot plugin instances and handles plugin tasks
 * over these connections.
 *
 * Each connection belongs to one browser tab running the plugin and reports the Penpot file
 * open in that tab. A user may hold several connections; each task is routed to one of them
 * based on the requested file (see {@link PluginConnectionSelector}).
 */
export class PluginBridge {
    public static readonly MULTIUSER_CONNECTION_ERROR_MESSAGE = `No Penpot instance connected for user token. Please ensure that Penpot is connected and that the MCP client connection is using the correct token.`;

    public static readonly NO_CONNECTION_ERROR_MESSAGE = `No Penpot plugin instances are currently connected. Please ensure the plugin is running and connected.`;

    private readonly logger = createLogger("PluginBridge");
    private readonly wsServer: WebSocketServer;

    private readonly connectedClients: Map<WebSocket, ClientConnection> = new Map();
    private readonly pendingTasks: Map<string, AbstractPluginTask<any, any>> = new Map();
    private readonly taskTimeouts: Map<string, NodeJS.Timeout> = new Map();
    private readonly registryRefreshTimer?: NodeJS.Timeout;

    /**
     * Creates the plugin bridge and starts its WebSocket server.
     *
     * @param mcpServer - The owning MCP server
     * @param port - The port on which to listen for plugin WebSocket connections
     * @param redisBridge - Optional Redis bridge enabling multi-instance task routing.
     *   When provided, tasks handled by this instance are routed to the instance
     *   holding the relevant plugin's WebSocket connection (which may be this same
     *   instance) via Redis, rather than dispatched directly over a local socket.
     * @param taskTimeoutSecs - Timeout, in seconds, for plugin task execution
     *   (defaults to {@link DEFAULT_TASK_TIMEOUT_SECS})
     */
    constructor(
        public readonly mcpServer: PenpotMcpServer,
        private port: number,
        private readonly taskTimeoutSecs: number,
        private readonly redisBridge?: RedisBridge
    ) {
        this.wsServer = new WebSocketServer({ port: port, host: mcpServer.host });
        this.setupWebSocketHandlers();
        if (redisBridge) {
            this.registryRefreshTimer = setInterval(() => this.refreshRegistry(), REGISTRY_REFRESH_INTERVAL_MS);
        }
    }

    /**
     * Sets up WebSocket connection handlers for plugin communication.
     *
     * Manages client connections and provides bidirectional communication
     * channel between the MCP mcpServer and Penpot plugin instances.
     */
    private setupWebSocketHandlers(): void {
        this.wsServer.on("connection", (ws: WebSocket, request: http.IncomingMessage) => {
            // extract userToken from query parameters
            const url = new URL(request.url!, `ws://${request.headers.host}`);
            const userToken = url.searchParams.get("userToken");

            // require userToken if running in multi-user mode
            if (this.mcpServer.isMultiUserMode() && !userToken) {
                this.logger.warn("Connection attempt without userToken in multi-user mode - rejecting");
                ws.close(1008, "Missing userToken parameter");
                return;
            }

            const admissionError = this.getAdmissionError(userToken);
            if (admissionError) {
                this.logger.warn("Rejecting plugin connection: %s", admissionError);
                ws.close(1008, admissionError);
                return;
            }

            const connection: ClientConnection = {
                connectionId: randomUUID(),
                file: null,
                connectedAt: Date.now(),
                lastHeartbeat: Date.now(),
                frozen: false,
                socket: ws,
                userToken,
                pingInterval: setInterval(() => {
                    ws.ping();
                    ws.send(JSON.stringify({ type: "ping" }));
                }, HEARTBEAT_REQUEST_INTERVAL_MS),
            };
            this.connectedClients.set(ws, connection);
            this.logger.info(
                "New WebSocket connection %s established (token provided: %s)",
                connection.connectionId,
                userToken !== null
            );

            // In multi-instance mode, subscribe to this connection's Redis request channel and
            // publish the connection, so that other instances can route tasks to it.
            if (userToken && this.redisBridge) {
                this.redisBridge
                    .subscribeToTasks(userToken, connection.connectionId, (request) =>
                        this.dispatchForwardedTask(connection, request)
                    )
                    .catch((error) => this.logger.error(error, "Failed to subscribe to Redis task channel"));
                this.publishToRegistry(connection);
            }

            ws.on("message", (data: Buffer) => this.handlePluginMessage(connection, data));

            ws.on("close", () => {
                this.logger.info("WebSocket connection %s closed", connection.connectionId);
                this.removeConnection(ws);
            });

            ws.on("error", (error) => {
                this.logger.error(error, "WebSocket connection error");
                this.removeConnection(ws);
            });
        });

        this.logger.info("WebSocket mcpServer started on port %d", this.port);
    }

    /**
     * Determines why a new plugin connection must be rejected, if at all.
     *
     * @param userToken - The user token of the new connection
     * @returns The rejection reason (used as WebSocket close reason), or null to admit the connection
     */
    private getAdmissionError(userToken: string | null): string | null {
        if (!this.mcpServer.isMultiUserMode()) {
            return null;
        }
        if (this.getLocalConnections(userToken).length >= MAX_CONNECTIONS_PER_USER) {
            return `Too many plugin connections for this user (maximum: ${MAX_CONNECTIONS_PER_USER}).`;
        }
        return null;
    }

    /**
     * Processes a message received on a plugin connection.
     *
     * @param connection - The connection the message arrived on
     * @param data - The raw message
     */
    private handlePluginMessage(connection: ClientConnection, data: Buffer): void {
        this.logger.debug("Received WebSocket message: %s", data.toString());
        try {
            // any plugin message proves the page event loop is running
            connection.lastHeartbeat = Date.now();

            const message = JSON.parse(data.toString());
            if (message?.type === "freeze") {
                connection.frozen = true;
                this.logger.info("Plugin tab reported it is being frozen by the browser");
                this.publishToRegistry(connection);
                return;
            }
            if (connection.frozen) {
                connection.frozen = false;
                this.publishToRegistry(connection);
            }
            if (message?.type === "heartbeat") {
                return;
            }
            if (message?.type === "register") {
                this.registerFile(connection, message.file);
                this.publishToRegistry(connection);
                return;
            }
            this.handlePluginTaskResponse(message as PluginTaskResponse<any>);
        } catch (error) {
            this.logger.error(error, "Failure while processing WebSocket message");
        }
    }

    /**
     * Records the Penpot file that a plugin connection operates on.
     *
     * @param connection - The connection whose file is reported
     * @param rawFile - The file descriptor as sent by the plugin
     */
    private registerFile(connection: ClientConnection, rawFile: unknown): void {
        const file = parsePluginFileInfo(rawFile);
        if (!file) {
            this.logger.warn("Ignoring malformed register message on connection %s", connection.connectionId);
            return;
        }
        connection.file = file;
        this.logger.info("Connection %s operates on file %s", connection.connectionId, file.fileId);
    }

    /**
     * Removes a client connection and releases all resources associated with it.
     *
     * Safe to call with a socket that is not (or no longer) registered.
     *
     * @param ws - The WebSocket whose connection state should be removed
     */
    private removeConnection(ws: WebSocket): void {
        const connection = this.connectedClients.get(ws);
        if (!connection) {
            return;
        }
        clearInterval(connection.pingInterval);
        this.connectedClients.delete(ws);
        if (connection.userToken && this.redisBridge) {
            const { userToken, connectionId } = connection;
            this.redisBridge
                .unsubscribeFromTasks(userToken, connectionId)
                .catch((error) => this.logger.error(error, "Failed to unsubscribe from Redis task channel"));
            this.redisBridge
                .unregisterConnection(userToken, connectionId)
                .catch((error) => this.logger.error(error, "Failed to remove plugin connection from Redis registry"));
        }
    }

    /**
     * Publishes a local connection to the shared registry (multi-instance mode only).
     *
     * @param connection - The connection to publish
     */
    private publishToRegistry(connection: ClientConnection): void {
        if (!this.redisBridge || !connection.userToken) {
            return;
        }
        this.redisBridge
            .registerConnection(connection.userToken, toConnectionDescriptor(connection), REGISTRY_ENTRY_TTL_MS)
            .catch((error) => this.logger.error(error, "Failed to publish plugin connection to Redis registry"));
    }

    /**
     * Republishes all local connections, which keeps their registry entries from expiring.
     */
    private refreshRegistry(): void {
        for (const connection of this.connectedClients.values()) {
            this.publishToRegistry(connection);
        }
    }

    /**
     * Handles responses from the plugin for completed tasks.
     *
     * Finds the pending task by ID and resolves or rejects its promise
     * based on the execution result.
     *
     * @param response - The plugin task response containing ID and result
     */
    private handlePluginTaskResponse(response: PluginTaskResponse<any>): void {
        const task = this.pendingTasks.get(response.id);
        if (!task) {
            this.logger.info(`Received response for unknown task ID: ${response.id}`);
            return;
        }

        // Clear the timeout and remove the task from pending tasks
        const timeoutHandle = this.taskTimeouts.get(response.id);
        if (timeoutHandle) {
            clearTimeout(timeoutHandle);
            this.taskTimeouts.delete(response.id);
        }
        this.pendingTasks.delete(response.id);

        // Resolve or reject the task's promise based on the result
        if (response.success) {
            task.resolveWithResult({ data: response.data });
        } else {
            const error = new Error(response.error || "Task execution failed (details not provided)");
            task.rejectWithError(error);
        }

        this.logger.info(`Task ${response.id} completed: success=${response.success}`);
    }

    /**
     * Rejects a still-pending task with the given error, releasing its correlation state.
     *
     * Clears the task's timeout (if armed) and removes the task from the pending-task
     * index before rejecting its promise. Safe to call for a task that has already been
     * settled (e.g. by a response or a timeout), in which case nothing happens.
     *
     * @param taskId - The ID of the task to reject
     * @param error - The error with which to reject the task
     * @returns Whether the task was still pending and has been rejected
     */
    private rejectPendingTask(taskId: string, error: Error): boolean {
        const pendingTask = this.pendingTasks.get(taskId);
        if (!pendingTask) {
            return false;
        }

        const timeoutHandle = this.taskTimeouts.get(taskId);
        if (timeoutHandle) {
            clearTimeout(timeoutHandle);
            this.taskTimeouts.delete(taskId);
        }
        this.pendingTasks.delete(taskId);

        pendingTask.rejectWithError(error);
        this.logger.info(`Task ${taskId} rejected: ${error.message}`);
        return true;
    }

    /**
     * Lists the local connections owned by the given user token (all local connections in single-user mode).
     *
     * @param userToken - The user token; ignored in single-user mode
     */
    private getLocalConnections(userToken: string | null): ClientConnection[] {
        const connections = [...this.connectedClients.values()];
        if (!this.mcpServer.isMultiUserMode()) {
            return connections;
        }
        return connections.filter((connection) => connection.userToken === userToken);
    }

    /**
     * Retrieves the user token of the current session.
     *
     * @returns The token in multi-user mode, null in single-user mode
     * @throws Error if the session has no token in multi-user mode
     */
    private getSessionUserToken(): string | null {
        if (!this.mcpServer.isMultiUserMode()) {
            return null;
        }
        const userToken = this.mcpServer.getSessionContext()?.userToken;
        if (!userToken) {
            throw new Error("No userToken found in session context. Multi-user mode requires authentication.");
        }
        return userToken;
    }

    private createSelector(): PluginConnectionSelector {
        return new PluginConnectionSelector(
            this.mcpServer.isMultiUserMode()
                ? PluginBridge.MULTIUSER_CONNECTION_ERROR_MESSAGE
                : PluginBridge.NO_CONNECTION_ERROR_MESSAGE
        );
    }

    /**
     * Lists the Penpot files connected for the current session's user.
     */
    public async listConnectedFiles(): Promise<ConnectedFileSummary[]> {
        const userToken = this.getSessionUserToken();
        const candidates: PluginConnectionDescriptor[] = this.redisBridge
            ? await this.redisBridge.listConnections(userToken!)
            : this.getLocalConnections(userToken);
        return this.createSelector().summarize(candidates);
    }

    /**
     * Executes a plugin task in the Penpot file given by the target, either directly via
     * WebSocket or indirectly via Redis (depending on the configuration), and awaits the result.
     *
     * @param task - The plugin task to execute
     * @param target - The file in which to run the task
     * @throws Error if no suitable plugin connection is available
     */
    public async executePluginTask<TResult extends PluginTaskResult<any>>(
        task: PluginTask<any, TResult>,
        target: PluginTaskTarget = {}
    ): Promise<TResult> {
        const userToken = this.getSessionUserToken();
        if (this.redisBridge) {
            const candidates = await this.redisBridge.listConnections(userToken!);
            const connection = this.createSelector().select(candidates, target.fileId);
            this.sendPluginTaskViaRedis(task, userToken!, connection.connectionId);
        } else {
            const connection = this.createSelector().select(this.getLocalConnections(userToken), target.fileId);
            this.sendPluginTask(task, connection);
        }
        return await task.getResultPromise();
    }

    /**
     * Registers a task for response correlation and sends it over a local plugin connection.
     *
     * @param task - The task to dispatch
     * @param connection - The connection to send the task over
     * @throws Error if the connection is closed or its plugin cannot run tasks
     */
    private sendPluginTask(task: AbstractPluginTask<any, any>, connection: ClientConnection): void {
        if (connection.socket.readyState !== WebSocket.OPEN) {
            throw new Error(`Plugin instance is disconnected. Task could not be sent.`);
        }

        // the socket can be open while browser-throttled plugin JS cannot run tasks
        assertPluginResponsive(connection, Date.now());

        this.pendingTasks.set(task.id, task);
        connection.socket.send(JSON.stringify(task.toRequest()));
        this.armTimeout(task);
        this.logger.info(`Sent task ${task.id} to connection ${connection.connectionId}`);
    }

    /**
     * Registers a task for response correlation and publishes it via Redis to the instance
     * holding the target plugin connection.
     *
     * The task is rejected immediately (rather than timing out) if the connection is no longer
     * subscribed anywhere or if publishing fails.
     *
     * @param task - The task to dispatch
     * @param userToken - The user token owning the target connection
     * @param connectionId - The ID of the target connection
     */
    private sendPluginTaskViaRedis(task: AbstractPluginTask<any, any>, userToken: string, connectionId: string): void {
        const redisBridge = this.redisBridge!;
        this.logger.debug("Dispatching task %s via Redis to connection %s", task.id, connectionId);

        this.pendingTasks.set(task.id, task);
        void redisBridge
            .sendTaskRequest(userToken, connectionId, task.toRequest(), (response) =>
                this.handlePluginTaskResponse(response)
            )
            .then((receiverCount) => {
                // the registry can briefly list a connection that has already closed
                if (receiverCount === 0) {
                    this.rejectPendingTask(
                        task.id,
                        new Error(`Plugin instance is disconnected. Task could not be sent.`)
                    );
                }
            })
            .catch((error) => {
                this.rejectPendingTask(task.id, error instanceof Error ? error : new Error(String(error)));
            });

        // on timeout, release the response-channel subscription, since no response
        // will arrive to trigger its self-unsubscribe
        this.armTimeout(task, () => void redisBridge.unsubscribeFromResponse(task.id));
        this.logger.info(`Sent task ${task.id} via Redis`);
    }

    /**
     * Arms a timeout that rejects the task if no response is received in time.
     *
     * @param task - The pending task
     * @param onTimeout - Optional cleanup to run if the timeout rejects the task
     */
    private armTimeout(task: AbstractPluginTask<any, any>, onTimeout?: () => void): void {
        const timeoutHandle = setTimeout(() => {
            const error = new Error(`Task ${task.id} timed out after ${this.taskTimeoutSecs} seconds`);
            if (this.rejectPendingTask(task.id, error)) {
                onTimeout?.();
            }
        }, this.taskTimeoutSecs * 1000);
        this.taskTimeouts.set(task.id, timeoutHandle);
    }

    /**
     * Dispatches a task request received over Redis to a locally-connected plugin.
     *
     * A {@link RemotePluginTask} publishes the plugin's response back to the issuing
     * instance's Redis response channel. On failure to dispatch, an error response is
     * published immediately so the requester need not wait for its timeout.
     *
     * @param connection - The connection on whose request channel the request arrived
     * @param request - The serialized task request, passed through from Redis
     */
    private dispatchForwardedTask(connection: ClientConnection, request: PluginTaskRequest): void {
        if (!this.redisBridge) {
            return;
        }

        // the response is published on the channel keyed by the original request ID
        const task = new RemotePluginTask(request.task, request.params, this.redisBridge, request.id);
        this.logger.debug("Dispatching remote task %s as %s to Penpot via WebSocket", request.id, task.id);

        try {
            this.sendPluginTask(task, connection);
        } catch (error) {
            task.rejectWithError(error instanceof Error ? error : new Error(String(error)));
        }
    }

    /**
     * Closes all plugin connections and the WebSocket server.
     */
    public async close(): Promise<void> {
        clearInterval(this.registryRefreshTimer);
        // ws does not end open client sockets on server close, and the close callback waits for them
        for (const ws of [...this.connectedClients.keys()]) {
            this.removeConnection(ws);
            ws.terminate();
        }
        return new Promise((resolve) => {
            this.wsServer.close(() => {
                this.logger.info("WebSocket server closed");
                resolve();
            });
        });
    }
}
