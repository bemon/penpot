import assert from "node:assert/strict";
import { once } from "node:events";
import { afterEach, beforeEach, test } from "node:test";
import { WebSocket } from "ws";
import type { PluginFileInfo, PluginPageInfo, PluginTaskRequest } from "@penpot/mcp-common";
import { MAX_CONNECTIONS_PER_USER } from "./PluginBridge";
import { PenpotMcpServer } from "./PenpotMcpServer";
import { HEARTBEAT_STALE_THRESHOLD_MS } from "./PluginLiveness";
import { ExecuteCodePluginTask } from "./tasks/ExecuteCodePluginTask";

let nextPort = 19_500;
let server: PenpotMcpServer | undefined;
let previousEnv: NodeJS.ProcessEnv;
const sockets: WebSocket[] = [];

beforeEach(() => {
    previousEnv = { ...process.env };
});

afterEach(async () => {
    for (const socket of sockets.splice(0)) {
        socket.terminate();
    }
    await server?.stop();
    server = undefined;
    process.env = previousEnv;
});

async function startServer(multiUser: boolean): Promise<PenpotMcpServer> {
    process.env.PENPOT_MCP_SERVER_HOST = "127.0.0.1";
    process.env.PENPOT_MCP_SERVER_PORT = String(nextPort++);
    process.env.PENPOT_MCP_WEBSOCKET_PORT = String(nextPort++);
    process.env.PENPOT_MCP_DEVENV = "false";
    process.env.PENPOT_MCP_REPL_ENABLE = "false";
    delete process.env.PENPOT_MCP_REDIS_URI;
    server = new PenpotMcpServer(multiUser);
    await server.start();
    return server;
}

function openSocket(userToken?: string): WebSocket {
    const query = userToken ? `?userToken=${userToken}` : "";
    const socket = new WebSocket(`ws://127.0.0.1:${server!.webSocketPort}${query}`);
    sockets.push(socket);
    return socket;
}

/** page last reported by each fake plugin; fake plugins answer tasks with it. */
const shownPages = new WeakMap<WebSocket, PluginPageInfo>();

/**
 * Connects a fake plugin that registers the given file and page and answers every task with the ID
 * of the page it shows, or of its file if it shows no page.
 */
async function connectPlugin(
    file: PluginFileInfo | null,
    userToken?: string,
    page?: PluginPageInfo
): Promise<WebSocket> {
    const socket = openSocket(userToken);
    if (page) {
        shownPages.set(socket, page);
    }
    socket.on("message", (raw) => {
        const request = JSON.parse(raw.toString()) as PluginTaskRequest;
        if (!request.task) {
            return;
        }
        const result = shownPages.get(socket)?.pageId ?? file?.fileId ?? null;
        socket.send(JSON.stringify({ id: request.id, success: true, data: { result, log: "" } }));
    });
    await once(socket, "open");
    if (file) {
        socket.send(JSON.stringify({ type: "register", file, page: page ?? null }));
    }
    return socket;
}

/** Makes a fake plugin report that its tab now shows the given page. */
function showPage(socket: WebSocket, file: PluginFileInfo, page: PluginPageInfo): void {
    shownPages.set(socket, page);
    socket.send(JSON.stringify({ type: "register", file, page }));
}

async function waitUntilRegistered(connectionCount: number, userToken?: string): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt++) {
        const files = await server!.runWithSessionContext({ userToken }, () =>
            server!.pluginBridge.listConnectedFiles()
        );
        const registered = files
            .filter((file) => file.fileId !== null)
            .reduce((sum, file) => sum + file.connections, 0);
        if (registered === connectionCount) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`server did not register ${connectionCount} plugin connections`);
}

function runCode(fileId?: string, userToken?: string, pageId?: string) {
    return server!.runWithSessionContext({ userToken }, () =>
        server!.pluginBridge.executePluginTask(new ExecuteCodePluginTask({ code: "return 1;" }), { fileId, pageId })
    );
}

const alpha: PluginFileInfo = { fileId: "alpha", fileName: "File alpha", projectName: "Project A" };
const beta: PluginFileInfo = { fileId: "beta", fileName: "File beta", projectName: "Project B" };
const gamma: PluginFileInfo = { fileId: "gamma", fileName: "File gamma", projectName: "Project C" };

test("routes a task to the plugin of the requested file", async () => {
    await startServer(false);
    await connectPlugin(alpha);
    await connectPlugin(beta);
    await waitUntilRegistered(2);

    const result = await runCode("beta");

    assert.equal(result.data?.result, "beta");
});

test("rejects a task without file ID when several files are connected", async () => {
    await startServer(false);
    await connectPlugin(alpha);
    await connectPlugin(beta);
    await waitUntilRegistered(2);

    await assert.rejects(runCode(), /2 Penpot files are connected/);
});

test("runs a task without file ID when only one file is connected", async () => {
    await startServer(false);
    await connectPlugin(alpha);
    await waitUntilRegistered(1);

    const result = await runCode();

    assert.equal(result.data?.result, "alpha");
});

test("runs a task without file ID when one file is open in two tabs", async () => {
    await startServer(false);
    await connectPlugin(alpha);
    await connectPlugin(alpha);
    await waitUntilRegistered(2);

    const result = await runCode();

    assert.equal(result.data?.result, "alpha");
});

test("reaches a plugin that has not reported its file when it is the only connection", async () => {
    await startServer(false);
    await connectPlugin(null);

    const result = await runCode();

    assert.equal(result.data?.result, null);
});

test("accepts several connections for one user token in multi-user mode", async () => {
    await startServer(true);
    await connectPlugin(alpha, "alice");
    await connectPlugin(beta, "alice");
    await waitUntilRegistered(2, "alice");

    const result = await runCode("beta", "alice");

    assert.equal(result.data?.result, "beta");
});

test("does not route a task to a file connected by another user", async () => {
    await startServer(true);
    await connectPlugin(alpha, "alice");
    await connectPlugin(gamma, "bob");
    await waitUntilRegistered(1, "alice");
    await waitUntilRegistered(1, "bob");

    await assert.rejects(runCode("gamma", "alice"), (error: Error) => {
        assert.match(error.message, /No connected Penpot file has the ID 'gamma'/);
        assert.doesNotMatch(error.message, /File gamma/);
        return true;
    });
});

test("rejects connections beyond the per-user limit in multi-user mode", async () => {
    await startServer(true);
    for (let i = 0; i < MAX_CONNECTIONS_PER_USER; i++) {
        await once(openSocket("alice"), "open");
    }

    const [code] = await once(openSocket("alice"), "close");

    assert.equal(code, 1008);
});

test("stopping the server disconnects connected plugins", { timeout: 10_000 }, async () => {
    await startServer(false);
    const socket = await connectPlugin(alpha);
    const closed = once(socket, "close");

    await server!.stop();
    server = undefined;

    await closed;
});

/**
 * Connects a fake plugin that sends no heartbeats of its own, like a tab whose timers the browser throttles.
 */
async function connectThrottledPlugin(file: PluginFileInfo, answersPings: boolean): Promise<WebSocket> {
    const socket = openSocket();
    socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type === "ping") {
            if (answersPings) {
                socket.send(JSON.stringify({ type: "heartbeat" }));
            }
            return;
        }
        socket.send(JSON.stringify({ id: message.id, success: true, data: { result: file.fileId, log: "" } }));
    });
    await once(socket, "open");
    socket.send(JSON.stringify({ type: "register", file }));
    return socket;
}

async function waitForStatus(fileId: string, status: string): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt++) {
        const files = await server!.runWithSessionContext({}, () => server!.pluginBridge.listConnectedFiles());
        if (files.find((file) => file.fileId === fileId)?.status === status) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`file ${fileId} did not reach status ${status}`);
}

test("keeps a throttled tab ready by answering server pings", async (t) => {
    t.mock.timers.enable({ apis: ["Date", "setInterval"], now: Date.now() });
    await startServer(false);
    await connectThrottledPlugin(alpha, true);
    await waitUntilRegistered(1);

    t.mock.timers.tick(HEARTBEAT_STALE_THRESHOLD_MS + 5_000);
    await waitForStatus("alpha", "ready");

    const result = await runCode("alpha");
    assert.equal(result.data?.result, "alpha");
});

test("rejects tasks for a tab that answers no pings", async (t) => {
    t.mock.timers.enable({ apis: ["Date", "setInterval"], now: Date.now() });
    await startServer(false);
    await connectThrottledPlugin(alpha, false);
    await waitUntilRegistered(1);

    t.mock.timers.tick(HEARTBEAT_STALE_THRESHOLD_MS + 5_000);
    await waitForStatus("alpha", "stale");

    await assert.rejects(runCode("alpha"), /appears to be suspended by the browser/);
});

const page1: PluginPageInfo = { pageId: "page-1", pageName: "Page 1" };
const components: PluginPageInfo = { pageId: "page-components", pageName: "Components" };

test("routes a task to the tab showing the requested page", async () => {
    await startServer(false);
    await connectPlugin(alpha, undefined, page1);
    await connectPlugin(alpha, undefined, components);
    await waitUntilRegistered(2);

    assert.equal((await runCode("alpha", undefined, "page-1")).data?.result, "page-1");
    assert.equal((await runCode("alpha", undefined, "page-components")).data?.result, "page-components");
});

test("follows a page change reported by a tab", async () => {
    await startServer(false);
    const first = await connectPlugin(alpha, undefined, page1);
    await connectPlugin(alpha, undefined, page1);
    await waitUntilRegistered(2);

    showPage(first, alpha, components);

    for (let attempt = 0; attempt < 50; attempt++) {
        const files = await server!.pluginBridge.listConnectedFiles();
        if (files[0].tabs.some((tab) => tab.pageId === "page-components")) {
            break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal((await runCode("alpha", undefined, "page-components")).data?.result, "page-components");
});

test("lists the page shown in each tab", async () => {
    await startServer(false);
    await connectPlugin(alpha, undefined, page1);
    await connectPlugin(alpha, undefined, components);
    await waitUntilRegistered(2);

    const [file] = await server!.pluginBridge.listConnectedFiles();

    assert.deepEqual(file.tabs.map((tab) => tab.pageName).sort(), ["Components", "Page 1"]);
});
