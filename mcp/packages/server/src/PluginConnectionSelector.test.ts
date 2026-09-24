import assert from "node:assert/strict";
import test from "node:test";
import type { PluginConnectionDescriptor } from "./PluginConnection";
import { PluginConnectionSelector } from "./PluginConnectionSelector";

const NOW = 1_000_000;
const NO_CONNECTION = "nothing connected";

function connection(
    connectionId: string,
    fileId: string | null,
    overrides: Partial<PluginConnectionDescriptor> = {}
): PluginConnectionDescriptor {
    return {
        connectionId,
        file: fileId === null ? null : { fileId, fileName: `File ${fileId}`, projectName: `Project ${fileId}` },
        page: null,
        connectedAt: NOW - 60_000,
        lastHeartbeat: NOW - 1_000,
        frozen: false,
        ...overrides,
    };
}

test("throws the configured message when nothing is connected", () => {
    const selector = new PluginConnectionSelector(NO_CONNECTION, NOW);
    assert.throws(() => selector.select([]), { message: NO_CONNECTION });
});

test("selects the only connection when no file ID is given", () => {
    const only = connection("c1", "alpha");
    assert.equal(new PluginConnectionSelector(NO_CONNECTION, NOW).select([only]), only);
});

test("selects the connection of the requested file", () => {
    const alpha = connection("c1", "alpha");
    const beta = connection("c2", "beta");
    assert.equal(new PluginConnectionSelector(NO_CONNECTION, NOW).select([alpha, beta], "beta"), beta);
});

test("lists the connected files when the requested file is not connected", () => {
    const selector = new PluginConnectionSelector(NO_CONNECTION, NOW);
    assert.throws(
        () => selector.select([connection("c1", "alpha")], "gamma"),
        /No connected Penpot file has the ID 'gamma'[\s\S]*'File alpha' \(fileId: alpha, project 'Project alpha'/
    );
});

test("refuses to guess when several files are connected and no file ID is given", () => {
    const selector = new PluginConnectionSelector(NO_CONNECTION, NOW);
    assert.throws(
        () => selector.select([connection("c1", "alpha"), connection("c2", "beta")]),
        /2 Penpot files are connected[\s\S]*`fileId`[\s\S]*fileId: alpha[\s\S]*fileId: beta/
    );
});

test("treats two tabs of the same file as one file and selects the newest tab", () => {
    const older = connection("c1", "alpha", { connectedAt: NOW - 60_000 });
    const newer = connection("c2", "alpha", { connectedAt: NOW - 10_000 });
    assert.equal(new PluginConnectionSelector(NO_CONNECTION, NOW).select([older, newer]), newer);
});

test("prefers a ready tab over a newer frozen tab of the same file", () => {
    const ready = connection("c1", "alpha", { connectedAt: NOW - 60_000 });
    const frozen = connection("c2", "alpha", { connectedAt: NOW - 10_000, frozen: true });
    assert.equal(new PluginConnectionSelector(NO_CONNECTION, NOW).select([ready, frozen], "alpha"), ready);
});

test("prefers a stale tab over a frozen tab of the same file", () => {
    const stale = connection("c1", "alpha", { lastHeartbeat: NOW - 120_000 });
    const frozen = connection("c2", "alpha", { connectedAt: NOW - 10_000, frozen: true });
    assert.equal(new PluginConnectionSelector(NO_CONNECTION, NOW).select([stale, frozen], "alpha"), stale);
});

test("counts a plugin that has not reported its file as a separate file", () => {
    const selector = new PluginConnectionSelector(NO_CONNECTION, NOW);
    assert.throws(
        () => selector.select([connection("c1", "alpha"), connection("c2", null)]),
        /2 Penpot files are connected[\s\S]*has not reported its file/
    );
});

test("selects a plugin that has not reported its file when it is the only connection", () => {
    const unnamed = connection("c1", null);
    assert.equal(new PluginConnectionSelector(NO_CONNECTION, NOW).select([unnamed]), unnamed);
});

test("summarizes connections per file with the best status of its tabs", () => {
    const summary = new PluginConnectionSelector(NO_CONNECTION, NOW).summarize([
        connection("c1", "beta", { frozen: true }),
        connection("c2", "alpha", { lastHeartbeat: NOW - 120_000 }),
        connection("c3", "alpha"),
    ]);
    assert.deepEqual(summary, [
        {
            fileId: "alpha",
            fileName: "File alpha",
            projectName: "Project alpha",
            teamName: null,
            connections: 2,
            status: "ready",
            tabs: [
                { pageId: null, pageName: null, status: "ready" },
                { pageId: null, pageName: null, status: "stale" },
            ],
        },
        {
            fileId: "beta",
            fileName: "File beta",
            projectName: "Project beta",
            teamName: null,
            connections: 1,
            status: "frozen",
            tabs: [{ pageId: null, pageName: null, status: "frozen" }],
        },
    ]);
});

function page(pageId: string): { page: { pageId: string; pageName: string } } {
    return { page: { pageId, pageName: `Page ${pageId}` } };
}

test("selects the tab showing the requested page", () => {
    const onPage1 = connection("c1", "alpha", { ...page("p1"), connectedAt: NOW - 10_000 });
    const onPage2 = connection("c2", "alpha", { ...page("p2"), connectedAt: NOW - 60_000 });
    assert.equal(new PluginConnectionSelector(NO_CONNECTION, NOW).select([onPage1, onPage2], "alpha", "p2"), onPage2);
});

test("selects the tab showing the requested page when no file ID is given", () => {
    const alpha = connection("c1", "alpha", page("p1"));
    const beta = connection("c2", "beta", page("p2"));
    assert.equal(new PluginConnectionSelector(NO_CONNECTION, NOW).select([alpha, beta], undefined, "p2"), beta);
});

test("prefers a ready tab among tabs showing the requested page", () => {
    const ready = connection("c1", "alpha", { ...page("p1"), connectedAt: NOW - 60_000 });
    const frozen = connection("c2", "alpha", { ...page("p1"), connectedAt: NOW - 10_000, frozen: true });
    assert.equal(new PluginConnectionSelector(NO_CONNECTION, NOW).select([ready, frozen], "alpha", "p1"), ready);
});

test("falls back to the best tab of the file when no tab shows the requested page", () => {
    const older = connection("c1", "alpha", { ...page("p1"), connectedAt: NOW - 60_000 });
    const newer = connection("c2", "alpha", { ...page("p2"), connectedAt: NOW - 10_000 });
    assert.equal(new PluginConnectionSelector(NO_CONNECTION, NOW).select([older, newer], "alpha", "p9"), newer);
});

test("refuses to guess the file when no tab shows the requested page", () => {
    const selector = new PluginConnectionSelector(NO_CONNECTION, NOW);
    assert.throws(
        () =>
            selector.select(
                [connection("c1", "alpha", page("p1")), connection("c2", "beta", page("p2"))],
                undefined,
                "p9"
            ),
        /2 Penpot files are connected/
    );
});

test("lists the pages shown in each tab when the requested file is not connected", () => {
    const selector = new PluginConnectionSelector(NO_CONNECTION, NOW);
    assert.throws(
        () => selector.select([connection("c1", "alpha", page("p1"))], "gamma"),
        /'File alpha' \(fileId: alpha, project 'Project alpha'; tabs on pages: 'Page p1' \(pageId: p1\)\)/
    );
});
