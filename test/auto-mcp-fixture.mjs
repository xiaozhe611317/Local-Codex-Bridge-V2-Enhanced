import { fileURLToPath } from "node:url";
import { AppServerManager } from "../dist/src/app-server.js";
import { RuntimeStore } from "../dist/src/runtime.js";
import { ControlSurface } from "../dist/src/tools.js";
import { McpStdioServer } from "../dist/src/mcp.js";

const runtime = new RuntimeStore();
runtime.markTurnAccepted("transport-thread", "transport-turn");
runtime.recordNotification("item/agentMessage/delta", { threadId: "transport-thread", turnId: "transport-turn", delta: "fixture noise" });
runtime.recordNotification("item/started", { threadId: "transport-thread", turnId: "transport-turn", item: { type: "commandExecution", id: "cmd", command: "fixture-only", status: "inProgress" } });
const manager = new AppServerManager(runtime, {
  executable: process.execPath,
  prefixArgs: [fileURLToPath(new URL("./runtime-codex.mjs", import.meta.url))],
});
const server = new McpStdioServer(new ControlSurface(manager), {
  onClose: async () => { await server.close(); await manager.close(); },
});
server.start();
