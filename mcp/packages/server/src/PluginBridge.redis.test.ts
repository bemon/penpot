import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { afterEach, beforeEach, test } from "node:test";
import { WebSocket } from "ws";
import type { PluginFileInfo, PluginTaskRequest } from "@penpot/mcp-common";
import { PenpotMcpServer } from "./PenpotMcpServer";
import { ExecuteCodePluginTask } from "./tasks/ExecuteCodePluginTask";

const redisUri = process.env.PENPOT_MCP_TEST_REDIS_URI;
const skip = redisUri ? false : "set PENPOT_MCP_TEST_REDIS_URI to run the Redis tests";

let nextPort = 18_500;
let previousEnv: NodeJS.ProcessEnv;
const servers: PenpotMcpServer[] = [];
const sockets: WebSocket[] = [];

beforeEach(() => {
    previousEnv = { ...process.env };
});

afterEach(async () => {
    for (const socket of sockets.splice(0)) {
        socket.terminate();
    }
    for (const server of servers.splice(0)) {
        await server.stop();
    }
    process.env = previousEnv;
});

async function startInstance(tenant: string): Promise<PenpotMcpServer> {
    process.env.PENPOT_MCP_SERVER_HOST = "127.0.0.1";
    process.env.PENPOT_MCP_SERVER_PORT = String(nextPort++);
    process.env.PENPOT_MCP_WEBSOCKET_PORT = String(nextPort++);
    process.env.PENPOT_MCP_DEVENV = "false";
    process.env.PENPOT_MCP_REPL_ENABLE = "false";
    process.env.PENPOT_MCP_REDIS_URI = redisUri;
    process.env.PENPOT_TENANT = tenant;
    const server = new PenpotMcpServer(true);
    servers.push(server);
    await server.start();
    return server;
}

async function connectPlugin(server: PenpotMcpServer, file: PluginFileInfo, userToken: string): Promise<WebSocket> {
    const socket = new WebSocket(`ws://127.0.0.1:${server.webSocketPort}?userToken=${userToken}`);
    sockets.push(socket);
    socket.on("message", (raw) => {
        const request = JSON.parse(raw.toString()) as PluginTaskRequest;
        if (!request.task) {
            return;
        }
        socket.send(JSON.stringify({ id: request.id, success: true, data: { result: file.fileId, log: "" } }));
    });
    await once(socket, "open");
    socket.send(JSON.stringify({ type: "register", file }));
    return socket;
}

async function waitForFileCount(server: PenpotMcpServer, count: number, userToken: string): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt++) {
        const files = await server.runWithSessionContext({ userToken }, () => server.pluginBridge.listConnectedFiles());
        if (files.filter((file) => file.fileId !== null).length === count) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`instance did not list ${count} files`);
}

function runCode(server: PenpotMcpServer, userToken: string, fileId?: string) {
    return server.runWithSessionContext({ userToken }, () =>
        server.pluginBridge.executePluginTask(new ExecuteCodePluginTask({ code: "return 1;" }), { fileId })
    );
}

const alpha: PluginFileInfo = { fileId: "alpha", fileName: "File alpha" };
const beta: PluginFileInfo = { fileId: "beta", fileName: "File beta" };

test("routes a task to a plugin connected to another instance", { skip }, async () => {
    const tenant = `test-${randomUUID()}`;
    const a = await startInstance(tenant);
    const b = await startInstance(tenant);
    await connectPlugin(b, alpha, "alice");
    await connectPlugin(a, beta, "alice");
    await waitForFileCount(a, 2, "alice");

    assert.equal((await runCode(a, "alice", "alpha")).data?.result, "alpha");
    assert.equal((await runCode(a, "alice", "beta")).data?.result, "beta");
});

test("refuses to guess across instances when several files are connected", { skip }, async () => {
    const tenant = `test-${randomUUID()}`;
    const a = await startInstance(tenant);
    const b = await startInstance(tenant);
    await connectPlugin(a, alpha, "alice");
    await connectPlugin(b, beta, "alice");
    await waitForFileCount(a, 2, "alice");

    await assert.rejects(runCode(a, "alice"), /2 Penpot files are connected/);
});

test("drops a closed connection from the shared registry", { skip }, async () => {
    const tenant = `test-${randomUUID()}`;
    const a = await startInstance(tenant);
    const b = await startInstance(tenant);
    const socket = await connectPlugin(b, alpha, "alice");
    await waitForFileCount(a, 1, "alice");

    socket.terminate();

    await waitForFileCount(a, 0, "alice");
});
