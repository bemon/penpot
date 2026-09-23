import type { PluginFileInfo } from "@penpot/mcp-common";
import type { PluginLivenessState } from "./PluginLiveness";

/**
 * Maximum length of a text field in a file descriptor reported by a plugin.
 */
const MAX_FILE_INFO_TEXT_LENGTH = 256;

const OPTIONAL_FILE_INFO_FIELDS = ["projectId", "projectName", "teamId", "teamName"] as const;

/**
 * Serializable description of a plugin connection, as used for task routing.
 *
 * Descriptors carry no socket, so they can be shared between server instances.
 */
export interface PluginConnectionDescriptor extends PluginLivenessState {
    /** server-generated ID of the connection. */
    connectionId: string;
    /** the file the plugin operates on; null until the plugin has reported it. */
    file: PluginFileInfo | null;
    /** time at which the connection was established, in ms since epoch. */
    connectedAt: number;
}

/**
 * Validates a file descriptor received from a plugin.
 *
 * The descriptor is client-controlled, so only known string fields are kept and text is truncated.
 *
 * @param value - The descriptor as received
 * @returns The validated descriptor, or null if the file ID or name is missing
 */
export function parsePluginFileInfo(value: unknown): PluginFileInfo | null {
    if (typeof value !== "object" || value === null) {
        return null;
    }
    const fields = value as Record<string, unknown>;
    const text = (key: string): string | undefined => {
        const field = fields[key];
        return typeof field === "string" ? field.slice(0, MAX_FILE_INFO_TEXT_LENGTH) : undefined;
    };

    const fileId = text("fileId");
    const fileName = text("fileName");
    if (!fileId || fileName === undefined) {
        return null;
    }

    const info: PluginFileInfo = { fileId, fileName };
    for (const key of OPTIONAL_FILE_INFO_FIELDS) {
        const field = text(key);
        if (field !== undefined) {
            info[key] = field;
        }
    }
    return info;
}

/**
 * Copies the descriptor fields of a connection, dropping further state such as its socket.
 *
 * @param connection - The connection to describe
 */
export function toConnectionDescriptor(connection: PluginConnectionDescriptor): PluginConnectionDescriptor {
    const { connectionId, file, connectedAt, lastHeartbeat, frozen } = connection;
    return { connectionId, file, connectedAt, lastHeartbeat, frozen };
}
