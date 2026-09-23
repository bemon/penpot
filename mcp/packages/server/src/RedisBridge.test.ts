import assert from "node:assert/strict";
import test from "node:test";
import { RedisBridge } from "./RedisBridge";

const descriptor = {
    connectionId: "c1",
    file: { fileId: "f1", fileName: "Landing page" },
    connectedAt: 1,
    lastHeartbeat: 2,
    frozen: false,
};

test("returns registry entries that have not expired", () => {
    const fields = { c1: JSON.stringify({ descriptor, expiresAt: 2_000 }) };
    assert.deepEqual(RedisBridge.parseRegistry(fields, 1_000), { live: [descriptor], staleIds: [] });
});

test("reports expired registry entries as stale", () => {
    const fields = { c1: JSON.stringify({ descriptor, expiresAt: 1_000 }) };
    assert.deepEqual(RedisBridge.parseRegistry(fields, 1_000), { live: [], staleIds: ["c1"] });
});

test("reports unreadable registry entries as stale", () => {
    assert.deepEqual(RedisBridge.parseRegistry({ c1: "not json" }, 1_000), { live: [], staleIds: ["c1"] });
});
