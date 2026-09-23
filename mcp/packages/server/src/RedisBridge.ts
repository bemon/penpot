import Redis from "ioredis";
import { PluginTaskRequest, PluginTaskResponse } from "@penpot/mcp-common";
import { createLogger } from "./logger";
import type { PluginConnectionDescriptor } from "./PluginConnection";

/**
 * Handler invoked for a task request arriving on a subscribed request channel.
 */
export type TaskRequestHandler = (request: PluginTaskRequest) => void;

/**
 * Handler invoked for a task response arriving on a subscribed response channel.
 */
export type TaskResponseHandler = (response: PluginTaskResponse<any>) => void;

/**
 * Entry of the shared plugin connection registry, as stored in Redis.
 */
interface RegistryEntry {
    descriptor: PluginConnectionDescriptor;
    /** time after which the entry is disregarded unless refreshed, in ms since epoch. */
    expiresAt: number;
}

/**
 * Plugin connection registry of a user token, split into usable and stale entries.
 */
export interface ParsedRegistry {
    live: PluginConnectionDescriptor[];
    /** IDs of expired or unreadable entries. */
    staleIds: string[];
}

/**
 * Provides a Redis-backed transport for routing plugin task requests and responses
 * between MCP server instances.
 *
 * The bridge is a pure, stateless transport: it moves already-serialized
 * `PluginTaskRequest` and `PluginTaskResponse` objects between instances and does not
 * interpret their contents, correlate requests with responses, or impose timeouts.
 * Correlation and timeout handling remain the responsibility of the caller (see
 * `PluginBridge`, which routes Redis-delivered responses through the same
 * pending-task machinery used for direct WebSocket dispatch).
 *
 * It enables a tool call handled on one instance to be executed against a plugin
 * whose WebSocket connection lives on another instance. Every instance publishes its
 * plugin connections to a registry hash keyed by user token, so that any instance can
 * choose the target connection. The request is published on a channel keyed by user
 * token and connection ID (to which the instance holding that connection is subscribed),
 * and the response on a channel keyed by task ID (to which the issuing instance subscribes).
 *
 * Two Redis connections are used, as ioredis requires a dedicated connection while
 * subscribed: one for commands and publishing, and one for subscriptions.
 */
export class RedisBridge {
    private readonly logger = createLogger("RedisBridge");
    private readonly publisher: Redis;
    private readonly subscriber: Redis;
    private readonly tenant: string;

    /**
     * Message handlers keyed by channel name.
     *
     * ioredis exposes a single, global message event for all subscribed channels, so
     * incoming messages are dispatched to the correct handler by channel name. Both
     * request-channel and response-channel handlers are stored here.
     */
    private readonly handlers = new Map<string, (rawMessage: string) => void>();

    /**
     * Creates a Redis bridge connected to the given Redis instance.
     *
     * @param redisUri - The Redis connection URI (e.g. `redis://host:6379`)
     * @param tenant - The tenant identifier, used to qualify Redis channel names so that
     *   multiple environments sharing a Redis instance do not interfere.
     */
    constructor(redisUri: string, tenant: string) {
        this.tenant = tenant;
        this.publisher = new Redis(redisUri);
        this.subscriber = new Redis(redisUri);

        this.subscriber.on("message", (channel: string, rawMessage: string) => {
            const handler = this.handlers.get(channel);
            if (handler) {
                handler(rawMessage);
            } else {
                this.logger.warn(`Received message on channel with no registered handler: ${channel}`);
            }
        });
    }

    /** Builds the Redis Pub/Sub channel name for task requests addressed to one plugin connection. */
    private requestChannel(userToken: string, connectionId: string): string {
        return `penpot.mcp.${this.tenant}.task.req.${userToken}.${connectionId}`;
    }

    /** Builds the Redis key of the hash that registers the plugin connections of a user token. */
    private registryKey(userToken: string): string {
        return `penpot.mcp.${this.tenant}.plugins.${userToken}`;
    }

    /** Builds the Redis Pub/Sub channel name for a task response keyed by task ID. */
    private responseChannel(taskId: string): string {
        return `penpot.mcp.${this.tenant}.task.res.${taskId}`;
    }

    /**
     * Subscribes to the response channel for the given task ID and publishes the task
     * request to the given user token's request channel.
     *
     * The response subscription is established *before* the request is published, to
     * avoid a race in which the response would be published before the subscription is
     * in place. The response handler is invoked at most once and the subscription is
     * removed automatically upon delivery (response channels are single-use).
     *
     * @param userToken - The user token identifying the target plugin's request channel
     * @param connectionId - The ID of the target plugin connection
     * @param request - The serialized plugin task request, passed through verbatim
     * @param onResponse - Handler invoked with the response when it arrives
     * @returns The number of instances that received the request. A count of 0 means the
     *   target connection is no longer subscribed anywhere (i.e. the plugin has disconnected); the request was dropped, no response will ever arrive, and
     *   the response subscription has already been released.
     */
    async sendTaskRequest(
        userToken: string,
        connectionId: string,
        request: PluginTaskRequest,
        onResponse: TaskResponseHandler
    ): Promise<number> {
        const responseChannel = this.responseChannel(request.id);
        const requestChannel = this.requestChannel(userToken, connectionId);

        this.handlers.set(responseChannel, (rawMessage) => {
            // a response channel is single-use: remove the handler and unsubscribe on delivery
            this.handlers.delete(responseChannel);
            void this.subscriber.unsubscribe(responseChannel);
            try {
                onResponse(JSON.parse(rawMessage) as PluginTaskResponse<any>);
            } catch (error) {
                this.logger.error(error, "Failed to parse task response message");
            }
        });

        await this.subscriber.subscribe(responseChannel);
        // publish only once the response subscription is confirmed
        let receiverCount: number;
        try {
            receiverCount = await this.publisher.publish(requestChannel, JSON.stringify(request));
        } catch (error) {
            // the request was never delivered, so no response can arrive
            await this.unsubscribeFromResponse(request.id);
            throw error;
        }
        if (receiverCount === 0) {
            // no subscriber received the request, so no response can arrive
            await this.unsubscribeFromResponse(request.id);
        }
        return receiverCount;
    }

    /**
     * Unsubscribes from the response channel for the given task ID.
     *
     * Used to release a response subscription when no response will be processed (e.g.
     * the awaiting task has timed out), since in that case the self-unsubscribe on
     * delivery never occurs.
     *
     * @param taskId - The task ID whose response channel to unsubscribe from
     */
    async unsubscribeFromResponse(taskId: string): Promise<void> {
        const responseChannel = this.responseChannel(taskId);
        this.handlers.delete(responseChannel);
        await this.subscriber.unsubscribe(responseChannel);
    }

    /**
     * Publishes a task response on the response channel for the given task ID.
     *
     * Used by the instance executing a forwarded task to return its outcome to the
     * issuing instance.
     *
     * @param taskId - The ID of the originally requested task
     * @param response - The serialized plugin task response, passed through verbatim
     */
    publishTaskResponse(taskId: string, response: PluginTaskResponse<any>): void {
        const responseChannel = this.responseChannel(taskId);
        void this.publisher.publish(responseChannel, JSON.stringify(response));
    }

    /**
     * Subscribes to task requests for one plugin connection.
     *
     * @param userToken - The user token owning the connection
     * @param connectionId - The ID of the connection
     * @param handler - The handler to invoke for incoming requests
     */
    async subscribeToTasks(userToken: string, connectionId: string, handler: TaskRequestHandler): Promise<void> {
        const requestChannel = this.requestChannel(userToken, connectionId);
        this.handlers.set(requestChannel, (rawMessage) => {
            try {
                handler(JSON.parse(rawMessage) as PluginTaskRequest);
            } catch (error) {
                this.logger.error(error, "Failed to parse task request message");
            }
        });
        await this.subscriber.subscribe(requestChannel);
    }

    /**
     * Unsubscribes from task requests for one plugin connection.
     *
     * @param userToken - The user token owning the connection
     * @param connectionId - The ID of the connection
     */
    async unsubscribeFromTasks(userToken: string, connectionId: string): Promise<void> {
        const requestChannel = this.requestChannel(userToken, connectionId);
        this.handlers.delete(requestChannel);
        await this.subscriber.unsubscribe(requestChannel);
    }

    /**
     * Registers or refreshes a plugin connection in the registry of its user token.
     *
     * Readers disregard entries not refreshed within the given lifetime, so the connections
     * of a crashed instance disappear on their own.
     *
     * @param userToken - The user token owning the connection
     * @param descriptor - The connection descriptor
     * @param ttlMs - The lifetime of the entry, in ms
     */
    async registerConnection(userToken: string, descriptor: PluginConnectionDescriptor, ttlMs: number): Promise<void> {
        const key = this.registryKey(userToken);
        const entry: RegistryEntry = { descriptor, expiresAt: Date.now() + ttlMs };
        await this.publisher
            .multi()
            .hset(key, descriptor.connectionId, JSON.stringify(entry))
            .pexpire(key, ttlMs)
            .exec();
    }

    /**
     * Removes a plugin connection from the registry of its user token.
     *
     * @param userToken - The user token owning the connection
     * @param connectionId - The ID of the connection
     */
    async unregisterConnection(userToken: string, connectionId: string): Promise<void> {
        await this.publisher.hdel(this.registryKey(userToken), connectionId);
    }

    /**
     * Lists the live plugin connections of a user token across all instances, deleting stale entries.
     *
     * @param userToken - The user token whose connections to list
     */
    async listConnections(userToken: string): Promise<PluginConnectionDescriptor[]> {
        const key = this.registryKey(userToken);
        const { live, staleIds } = RedisBridge.parseRegistry(await this.publisher.hgetall(key), Date.now());
        if (staleIds.length > 0) {
            await this.publisher.hdel(key, ...staleIds);
        }
        return live;
    }

    /**
     * Splits the raw fields of a registry hash into live descriptors and IDs of stale entries.
     *
     * @param fields - The hash fields, keyed by connection ID
     * @param now - The current time, in ms since epoch
     */
    static parseRegistry(fields: Record<string, string>, now: number): ParsedRegistry {
        const result: ParsedRegistry = { live: [], staleIds: [] };
        for (const [connectionId, rawEntry] of Object.entries(fields)) {
            try {
                const entry = JSON.parse(rawEntry) as RegistryEntry;
                if (entry.expiresAt > now) {
                    result.live.push(entry.descriptor);
                    continue;
                }
            } catch {
                // unreadable entries are dropped like expired ones
            }
            result.staleIds.push(connectionId);
        }
        return result;
    }

    /**
     * Closes both Redis connections. Call on server shutdown.
     */
    async close(): Promise<void> {
        await this.subscriber.quit();
        await this.publisher.quit();
    }
}
