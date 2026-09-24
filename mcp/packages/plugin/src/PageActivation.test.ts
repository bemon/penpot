import assert from "node:assert/strict";
import test from "node:test";
import { activatePage } from "./PageActivation.ts";

function fakePenpot(currentPageId: string | null) {
    const opened: string[] = [];
    return {
        opened,
        currentPage: currentPageId === null ? null : { id: currentPageId },
        async openPage(pageId: string): Promise<void> {
            opened.push(pageId);
        },
    };
}

test("opens the requested page when another page is active", async () => {
    const penpot = fakePenpot("p1");
    await activatePage(penpot, "p2");
    assert.deepEqual(penpot.opened, ["p2"]);
});

test("does not reopen the page that is already active", async () => {
    const penpot = fakePenpot("p1");
    await activatePage(penpot, "p1");
    assert.deepEqual(penpot.opened, []);
});

test("does nothing when no page is requested", async () => {
    const penpot = fakePenpot("p1");
    await activatePage(penpot, undefined);
    assert.deepEqual(penpot.opened, []);
});
