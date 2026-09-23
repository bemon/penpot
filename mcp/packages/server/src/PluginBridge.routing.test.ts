import assert from "node:assert/strict";
import { once } from "node:events";
import { afterEach, beforeEach, test } from "node:test";
import { WebSocket } from "ws";
import type { PluginFileInfo, PluginTaskRequest } from "@penpot/mcp-common";
import { MAX_CONNECTIONS_PER_USER } from "./PluginBridge";
import { PenpotMcpServer } from "./PenpotMcpServer";
import { ExecuteCodePluginTask } from "./tasks/ExecuteCodePluginTask";

let nextPort = 17_500;
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

/**
 * Connects a fake plugin that registers the given file and answers every task with the file's ID.
 */
async function connectPlugin(file: PluginFileInfo | null, userToken?: string): Promise<WebSocket> {
    const socket = openSocket(userToken);
    socket.on("message", (raw) => {
        const request = JSON.parse(raw.toString()) as PluginTaskRequest;
        if (!request.task) {
            return;
        }
        socket.send(JSON.stringify({ id: request.id, success: true, data: { result: file?.fileId ?? null, log: "" } }));
    });
    await once(socket, "open");
    if (file) {
        socket.send(JSON.stringify({ type: "register", file }));
    }
    return socket;
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

function runCode(fileId?: string, userToken?: string) {
    return server!.runWithSessionContext({ userToken }, () =>
        server!.pluginBridge.executePluginTask(new ExecuteCodePluginTask({ code: "return 1;" }), { fileId })
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
