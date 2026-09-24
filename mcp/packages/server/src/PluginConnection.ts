import type { PluginFileInfo, PluginPageInfo } from "@penpot/mcp-common";
import type { PluginLivenessState } from "./PluginLiveness";

/**
 * Maximum length of a text field in a file or page descriptor reported by a plugin.
 */
const MAX_DESCRIPTOR_TEXT_LENGTH = 256;

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
    /** the page shown in the plugin's browser tab; null until the plugin has reported it. */
    page: PluginPageInfo | null;
    /** time at which the connection was established, in ms since epoch. */
    connectedAt: number;
}

/**
 * Creates a reader for the string fields of a client-controlled object, truncating overlong text.
 *
 * @param value - The object as received
 * @returns The reader, or null if the value is not an object
 */
function textReader(value: unknown): ((key: string) => string | undefined) | null {
    if (typeof value !== "object" || value === null) {
        return null;
    }
    const fields = value as Record<string, unknown>;
    return (key) => {
        const field = fields[key];
        return typeof field === "string" ? field.slice(0, MAX_DESCRIPTOR_TEXT_LENGTH) : undefined;
    };
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
    const text = textReader(value);
    const fileId = text?.("fileId");
    const fileName = text?.("fileName");
    if (!text || !fileId || fileName === undefined) {
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
 * Validates a page descriptor received from a plugin.
 *
 * @param value - The descriptor as received
 * @returns The validated descriptor, or null if the page ID or name is missing
 */
export function parsePluginPageInfo(value: unknown): PluginPageInfo | null {
    const text = textReader(value);
    const pageId = text?.("pageId");
    const pageName = text?.("pageName");
    if (!pageId || pageName === undefined) {
        return null;
    }
    return { pageId, pageName };
}

/**
 * Copies the descriptor fields of a connection, dropping further state such as its socket.
 *
 * @param connection - The connection to describe
 */
export function toConnectionDescriptor(connection: PluginConnectionDescriptor): PluginConnectionDescriptor {
    const { connectionId, file, page, connectedAt, lastHeartbeat, frozen } = connection;
    return { connectionId, file, page, connectedAt, lastHeartbeat, frozen };
}
