import assert from "node:assert/strict";
import test from "node:test";
import { assertPluginResponsive, getPluginStatus, HEARTBEAT_STALE_THRESHOLD_MS } from "./PluginLiveness";

test("passes for a responsive connection with a recent heartbeat", () => {
    const now = 1_000_000;
    assert.doesNotThrow(() => assertPluginResponsive({ frozen: false, lastHeartbeat: now - 5_000 }, now));
});

test("passes when the heartbeat age is exactly at the threshold", () => {
    const now = 1_000_000;
    const lastHeartbeat = now - HEARTBEAT_STALE_THRESHOLD_MS;
    assert.doesNotThrow(() => assertPluginResponsive({ frozen: false, lastHeartbeat }, now));
});

test("throws a frozen-specific error when the tab reported it is being frozen", () => {
    const now = 1_000_000;
    assert.throws(() => assertPluginResponsive({ frozen: true, lastHeartbeat: now }, now), /has been frozen/);
});

test("throws a suspended error when no heartbeat has arrived within the threshold", () => {
    const now = 1_000_000;
    const lastHeartbeat = now - (HEARTBEAT_STALE_THRESHOLD_MS + 1);
    assert.throws(
        () => assertPluginResponsive({ frozen: false, lastHeartbeat }, now),
        /appears to be suspended by the browser/
    );
});

test("includes the heartbeat age, in seconds, in the suspended error", () => {
    const now = 1_000_000;
    const lastHeartbeat = now - 45_000;
    assert.throws(() => assertPluginResponsive({ frozen: false, lastHeartbeat }, now), /no heartbeat for 45s/);
});

test("honours a custom stale threshold", () => {
    const now = 1_000_000;
    const lastHeartbeat = now - 2_000;

    assert.doesNotThrow(() => assertPluginResponsive({ frozen: false, lastHeartbeat }, now));
    assert.throws(
        () => assertPluginResponsive({ frozen: false, lastHeartbeat }, now, 1_000),
        /appears to be suspended by the browser/
    );
});

test("reports a connection with a recent heartbeat as ready", () => {
    const now = 1_000_000;
    assert.equal(getPluginStatus({ frozen: false, lastHeartbeat: now - 5_000 }, now), "ready");
});

test("reports a connection whose heartbeat is exactly at the threshold as ready", () => {
    const now = 1_000_000;
    const lastHeartbeat = now - HEARTBEAT_STALE_THRESHOLD_MS;
    assert.equal(getPluginStatus({ frozen: false, lastHeartbeat }, now), "ready");
});

test("reports a connection without a heartbeat within the threshold as stale", () => {
    const now = 1_000_000;
    const lastHeartbeat = now - (HEARTBEAT_STALE_THRESHOLD_MS + 1);
    assert.equal(getPluginStatus({ frozen: false, lastHeartbeat }, now), "stale");
});

test("reports a frozen tab as frozen even with a recent heartbeat", () => {
    const now = 1_000_000;
    assert.equal(getPluginStatus({ frozen: true, lastHeartbeat: now }, now), "frozen");
});
