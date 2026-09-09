import type { AppServerManager } from "./app-server.js";
import { BUILD_IDENTITY } from "./build-identity.js";
import { VERSION } from "./version.js";

export function bridgeStatus(manager: AppServerManager): unknown {
  return {
    source: "running_bridge_process",
    bridge: {
      version: VERSION,
      version_source: "compiled_version_constant",
      build_identity: { ...BUILD_IDENTITY },
      pid: process.pid,
      uptime_seconds: process.uptime(),
    },
    app_server: manager.status(),
  };
}
