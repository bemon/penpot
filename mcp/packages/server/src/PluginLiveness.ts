/**
 * Maximum plugin heartbeat age before a connection is stale.
 *
 * This uses plugin heartbeats rather than WebSocket pongs because the browser can answer
 * protocol pings while the tab's JavaScript event loop is frozen.
 */
export const HEARTBEAT_STALE_THRESHOLD_MS = 30000;

/**
 * Observable liveness state of a plugin connection.
 */
export interface PluginLivenessState {
    /** timestamp of the last plugin message, in ms since epoch. */
    lastHeartbeat: number;
    /** whether the plugin reported a browser freeze. */
    frozen: boolean;
}

/**
 * Liveness status of a plugin connection.
 *
 * `ready` means the plugin sent a message recently; `stale` means it did not, which happens
 * when the browser suspends the tab; `frozen` means the tab reported that the browser froze it.
 */
export type PluginStatus = "ready" | "stale" | "frozen";

/**
 * Determines the liveness status of a plugin connection.
 *
 * @param state - The liveness state of the connection
 * @param now - The current time, in ms since epoch
 * @param staleThresholdMs - The heartbeat age beyond which the connection is stale
 */
export function getPluginStatus(
    state: PluginLivenessState,
    now: number,
    staleThresholdMs: number = HEARTBEAT_STALE_THRESHOLD_MS
): PluginStatus {
    if (state.frozen) {
        return "frozen";
    }
    return now - state.lastHeartbeat > staleThresholdMs ? "stale" : "ready";
}

/**
 * Throws if the plugin tab cannot currently run tasks.
 *
 * A socket can stay open while the page event loop is paused, so task dispatch must check
 * plugin-level liveness before sending work.
 */
export function assertPluginResponsive(
    state: PluginLivenessState,
    now: number,
    staleThresholdMs: number = HEARTBEAT_STALE_THRESHOLD_MS
): void {
    if (state.frozen) {
        throw new Error(
            `The Penpot plugin tab has been frozen by the browser and cannot run tasks. ` +
                `Please click/focus the Penpot tab to wake it, then retry.`
        );
    }

    const heartbeatAge = now - state.lastHeartbeat;
    if (heartbeatAge > staleThresholdMs) {
        throw new Error(
            `The Penpot plugin tab appears to be suspended by the browser (no heartbeat for ` +
                `${Math.round(heartbeatAge / 1000)}s). Please click/focus the Penpot tab to wake it, ` +
                `then retry.`
        );
    }
}
