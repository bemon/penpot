import assert from "node:assert/strict";
import test from "node:test";
import { parsePluginFileInfo } from "./PluginConnection";

test("parses a complete file descriptor", () => {
    const file = {
        fileId: "f1",
        fileName: "Landing page",
        projectId: "p1",
        projectName: "Website",
        teamId: "t1",
        teamName: "Acme",
    };
    assert.deepEqual(parsePluginFileInfo(file), file);
});

test("keeps only the required fields when optional fields are absent", () => {
    assert.deepEqual(parsePluginFileInfo({ fileId: "f1", fileName: "Landing page" }), {
        fileId: "f1",
        fileName: "Landing page",
    });
});

test("drops unknown and non-string fields", () => {
    const parsed = parsePluginFileInfo({ fileId: "f1", fileName: "Landing page", projectName: 42, extra: "x" });
    assert.deepEqual(parsed, { fileId: "f1", fileName: "Landing page" });
});

test("truncates overlong text fields to 256 characters", () => {
    const parsed = parsePluginFileInfo({ fileId: "f1", fileName: "n".repeat(1000) });
    assert.equal(parsed?.fileName.length, 256);
});

test("rejects a descriptor without a file ID", () => {
    assert.equal(parsePluginFileInfo({ fileName: "Landing page" }), null);
});

test("rejects a descriptor with an empty file ID", () => {
    assert.equal(parsePluginFileInfo({ fileId: "", fileName: "Landing page" }), null);
});

test("rejects a value that is not an object", () => {
    assert.equal(parsePluginFileInfo("f1"), null);
    assert.equal(parsePluginFileInfo(null), null);
});
