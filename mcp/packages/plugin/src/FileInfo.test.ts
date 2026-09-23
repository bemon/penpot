import assert from "node:assert/strict";
import test from "node:test";
import { buildFileInfo } from "./FileInfo.ts";

test("returns null when no file is open", () => {
    assert.equal(buildFileInfo(null), null);
});

test("builds the descriptor from the current file alone", () => {
    assert.deepEqual(buildFileInfo({ id: "f1", name: "Landing page" }), { fileId: "f1", fileName: "Landing page" });
});

test("adds project and team from the file context", () => {
    const context = { projectId: "p1", projectName: "Website", teamId: "t1", teamName: "Acme" };
    assert.deepEqual(buildFileInfo({ id: "f1", name: "Landing page" }, context), {
        fileId: "f1",
        fileName: "Landing page",
        projectId: "p1",
        projectName: "Website",
        teamId: "t1",
        teamName: "Acme",
    });
});

test("leaves out context fields that are null", () => {
    const context = { projectId: "p1", projectName: null, teamId: null, teamName: null };
    assert.deepEqual(buildFileInfo({ id: "f1", name: "Landing page" }, context), {
        fileId: "f1",
        fileName: "Landing page",
        projectId: "p1",
    });
});
