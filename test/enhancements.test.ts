import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AppServerManager } from "../src/app-server.js";
import { RuntimeStore, type RuntimeObservation } from "../src/runtime.js";
import { ControlSurface, TOOL_DEFINITIONS } from "../src/tools.js";
import { WINDOWS_PLATFORM_POLICY } from "../src/platform.js";
import { TargetingPolicy, type TargetingFilesystem } from "../src/targeting.js";

function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
class Stub extends AppServerManager {
  readonly calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  constructor(private readonly handler: (method: string, params: Record<string, unknown>) => unknown) {
    super(new RuntimeStore(), { executable: "unused-test-executable" });
  }
  override async request(method: string, value: unknown): Promise<unknown> {
    const params = object(value);
    this.calls.push({ method, params });
    return await this.handler(method, params);
  }
}
const fixture = fileURLToPath(new URL("../../test/runtime-codex.mjs", import.meta.url));
function manager(environment: NodeJS.ProcessEnv = {}): AppServerManager {
  return new AppServerManager(undefined, {
    executable: process.execPath, prefixArgs: [fixture], environment,
    requestTimeoutMs: 150,
  });
}
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

test("bridge_status is content-free, read-only and identifies this process/build", async () => {
  const native = manager();
  const surface = new ControlSurface(native);
  try {
    const first = object(await surface.call("bridge_status", {}));
    const bridge = object(first.bridge);
    assert.equal(bridge.version, "2.1.3");
    assert.equal(bridge.pid, process.pid);
    assert.ok(Number(bridge.uptime_seconds) >= 0);
    const identity = object(bridge.build_identity);
    assert.equal(identity.status, "available");
    assert.match(String(identity.sha256), /^[a-f0-9]{64}$/);
    assert.equal(object(first.app_server).state, "not_started");
    assert.equal(object(first.app_server).pid, null);
    assert.deepEqual(Object.keys(first).sort(), ["app_server", "bridge", "source"]);
    native.runtime.markTurnAccepted("thread", "turn");
    native.runtime.recordServerRequest(0, "item/tool/requestUserInput", { threadId: "thread", turnId: "turn", private_content: "not-in-status" });
    const active = object(await surface.call("bridge_status", {}));
    const live = object(object(active.app_server).live);
    assert.equal(live.active_turns, 1);
    assert.equal(live.pending_requests, 1);
    assert.equal(object(active.app_server).safe_to_restart, false);
    assert.equal(JSON.stringify(active).includes("not-in-status"), false);
    await assert.rejects(surface.call("bridge_status", { detail: true }), /Unknown argument/);
  } finally { await native.close(); }
});

test("runtime status/restart validation and annotations are conservative", async () => {
  const native = manager();
  const surface = new ControlSurface(native);
  try {
    assert.equal(object(await surface.call("codex_runtime", { action: "status" })).state, "not_started");
    for (const args of [{}, { action: "kill" }, { action: "status", force: true }]) {
      await assert.rejects(surface.call("codex_runtime", args));
    }
    assert.equal(TOOL_DEFINITIONS.length, 10);
    assert.equal(TOOL_DEFINITIONS.find(t => t.name === "bridge_status")?.annotations.readOnlyHint, true);
    assert.equal(TOOL_DEFINITIONS.find(t => t.name === "codex_runtime")?.annotations.readOnlyHint, false);
    assert.equal(TOOL_DEFINITIONS.find(t => t.name === "codex_runtime")?.annotations.destructiveHint, true);
  } finally { await native.close(); }
});

test("explicit restart changes only the fake child, repeats handshake, and clears live state", async () => {
  const native = manager();
  const surface = new ControlSurface(native);
  try {
    const first = object(await native.request("test/handshake", {}));
    assert.equal(first.initialized, true);
    const bridgePid = process.pid;
    native.runtime.recordNotification("turn/completed", { threadId: "old", turn: { id: "done", status: "completed" } });
    const cursor = native.runtime.currentCursor("old");
    const waiting = surface.call("codex_runtime", { action: "restart" });
    assert.equal(native.status().state, "restarting");
    await assert.rejects(native.restart(), /RESTART_DENIED/);
    await assert.rejects(native.request("test/handshake", {}), /restarting/);
    const restarted = object(await waiting);
    assert.equal(restarted.restarted, true);
    assert.equal(restarted.initialized, true);
    assert.notEqual(restarted.pid, first.pid);
    assert.equal(process.pid, bridgePid);
    assert.equal(native.runtime.observe("old", undefined, 10), null);
    assert.equal(native.status().live.generation, 1);
    const second = object(await native.request("test/handshake", {}));
    assert.equal(second.initialized, true);
    native.runtime.recordNotification("thread/status/changed", { threadId: "old", status: "idle" });
    const current = native.runtime.observe("old", cursor, 10)!;
    assert.equal(current.cursor_lost, true);
    assert.ok(current.next_cursor > cursor);
    assert.equal(current.events.length, 1);
  } finally { await native.close(); }
  assert.equal(native.status().state, "closed");
  await assert.rejects(native.restart(), /RESTART_DENIED/);
});

test("restart denies an active turn and any pending request including turnless numeric id zero", async () => {
  const native = manager();
  try {
    await native.ensureReady();
    const pid = native.status().pid;
    native.runtime.markTurnAccepted("thread", "turn");
    await assert.rejects(native.restart(), /RESTART_DENIED: active_turns/);
    native.runtime.recordNotification("turn/completed", { threadId: "thread", turn: { id: "turn", status: "completed" } });
    await native.request("test/pending", {});
    assert.equal(native.status().live.pending_requests, 1);
    await assert.rejects(native.restart(), /RESTART_DENIED: pending_requests/);
    assert.equal(native.status().pid, pid);
    assert.equal(native.runtime.pendingForThread("thread").length, 1);
  } finally { await native.close(); }
});

test("restart denies whole turn transactions, not only outstanding individual RPCs", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const native = new Stub(async method => {
    if (method === "thread/start") { await gate; return { thread: { id: "thread" } }; }
    return { turn: { id: "turn" } };
  });
  const surface = new ControlSurface(native, undefined, WINDOWS_PLATFORM_POLICY);
  const started = surface.call("codex_turn", { text: "test", cwd: "D:\\Example" });
  await assert.rejects(native.restart(), /RESTART_DENIED.*native_operations_in_flight/);
  release();
  await started;
  await assert.rejects(native.restart(), /RESTART_DENIED.*active_turns/);
});

test("restart denies pending RPCs and uncertain mutation timeouts without retry", async () => {
  const native = manager();
  try {
    await native.ensureReady();
    const pending = native.request("test/delay", {});
    await assert.rejects(native.restart(), /RESTART_DENIED/);
    await pending;
    await assert.rejects(native.request("turn/start", {}), /outcome is UNKNOWN/);
    assert.equal(native.status().native_mutation_outcome_unknown, true);
    assert.ok(native.runtime.diagnosticsAfter("thread", 0).some(item => item.code === "mutation_outcome_unknown"));
    await assert.rejects(native.restart(), /RESTART_DENIED.*native_mutation_outcome_unknown/);
  } finally { await native.close(); }
});

test("unexpected death stays latched; only explicit restart recovers", async () => {
  const native = manager();
  try {
    await assert.rejects(native.request("test/exit", {}), /exited unexpectedly/);
    assert.equal(native.status().state, "exited");
    assert.equal(native.status().pid, null);
    await assert.rejects(native.request("test/handshake", {}), /will not be auto-restarted/);
    await native.restart();
    assert.equal(object(await native.request("test/handshake", {})).initialized, true);
  } finally { await native.close(); }
});

test("failed restart handshake remains unavailable and never automatically retries", async () => {
  const native = manager({ BRIDGE_TEST_BAD_INIT: "1" });
  try {
    await assert.rejects(native.restart(), /initialization failed|initialize failed/);
    assert.ok(native.runtime.diagnosticsAfter("thread", 0).some(item => item.code === "restart_failure"));
    assert.equal(native.status().initialized, false);
    await assert.rejects(native.request("test/handshake", {}), /will not be auto-restarted/);
  } finally { await native.close(); }
});

test("close during restart waits for the controlled attempt and reaps the child", async () => {
  const native = manager();
  await native.ensureReady();
  const restarting = native.restart();
  const closing = native.close();
  await assert.rejects(restarting, /closing/);
  await closing;
  assert.equal(native.status().pid, null);
  assert.equal(native.status().state, "closed");
});

test("supervision filters only known notification noise and preserves raw page cursors", async () => {
  const native = manager();
  const surface = new ControlSurface(native);
  const methods = ["item/agentMessage/delta", "thread/tokenUsage/updated", "item/started", "item/commandExecution/outputDelta",
    "item/completed", "item/fileChange/outputDelta", "warning", "error", "thread/status/changed", "turn/completed"];
  for (const method of methods) native.runtime.recordNotification(method, { threadId: "thread", delta: "text" });
  native.runtime.recordServerRequest(0, "item/tool/requestUserInput", { threadId: "thread" });
  const args = { thread_id: "thread", cursor: 0, limit: 2 };
  const raw = await surface.call("codex_observe", args) as RuntimeObservation;
  assert.deepEqual(await surface.call("codex_observe", { ...args, mode: "raw" }), raw);
  const filtered = object(await surface.call("codex_observe", { ...args, mode: "supervision" }));
  assert.deepEqual(filtered.events, []);
  assert.equal(object(filtered.suppressed_events).count, 2);
  for (const key of ["next_cursor", "current_cursor", "cursor_floor", "cursor_lost", "has_more"]) {
    assert.equal(filtered[key], object(raw)[key]);
  }
  const next = object(await surface.call("codex_observe", { ...args, cursor: filtered.next_cursor, limit: 100, mode: "supervision" }));
  assert.deepEqual((next.events as Array<{ method: string }>).map(e => e.method), [...methods.slice(2), "item/tool/requestUserInput"]);
  assert.equal(object(next.suppressed_events).count, 0);
  assert.equal(next.has_more, false);
  await assert.rejects(surface.call("codex_observe", { thread_id: "thread", mode: "quiet" }), /mode must be/);
});

test("supervision preserves ring overflow and wait/cancellation semantics", async () => {
  const runtime = new RuntimeStore(3);
  const native = new Stub(() => ({ thread: { id: "missing", turns: [] } }));
  // Separate small ring exercises overflow without altering the manager API.
  for (let i = 0; i < 6; i++) runtime.recordNotification("item/agentMessage/delta", { threadId: "thread", delta: "." });
  const { supervisionObservation } = await import("../src/supervision.js");
  const filtered = supervisionObservation(runtime.observe("thread", 0, 2)!);
  assert.equal(filtered.cursor_lost, true);
  assert.equal(filtered.cursor_floor, 3);
  assert.equal(filtered.next_cursor, 5);
  assert.equal(filtered.has_more, true);
  native.runtime.markTurnAccepted("live", "turn");
  const surface = new ControlSurface(native);
  const waiting = surface.call("codex_observe", { thread_id: "live", cursor: 0, wait_ms: 1000, mode: "supervision" });
  setTimeout(() => native.runtime.recordNotification("item/agentMessage/delta", { threadId: "live", delta: "one" }), 10);
  const woke = object(await waiting);
  assert.deepEqual(woke.events, []);
  assert.equal(woke.next_cursor, 1);
  assert.equal(object(woke.suppressed_events).count, 1);
  const cancelled = new AbortController();
  const pending = surface.call("codex_observe", { thread_id: "live", cursor: 1, wait_ms: 1000, mode: "supervision" }, cancelled.signal);
  cancelled.abort();
  await assert.rejects(pending, /cancelled/);
  const fallback = object(await surface.call("codex_observe", { thread_id: "missing", mode: "supervision" }));
  assert.equal(fallback.runtime_available, false);
  assert.equal(fallback.live_state_reconstructable, false);
  assert.equal(object(fallback.suppressed_events).count, 0);
});

test("requested settings never become proof of effective turn context", async () => {
  const native = new Stub(method => {
    if (method === "model/list") return { data: [{ id: "requested-model", supportedReasoningEfforts: ["high"] }] };
    if (method === "thread/start") return { thread: { id: "thread" }, cwd: "D:\\Native", model: "native-model", reasoningEffort: "low", sandbox: { type: "readOnly" }, approvalPolicy: "never" };
    return { turn: { id: "turn" } };
  });
  const result = object(await new ControlSurface(native, undefined, WINDOWS_PLATFORM_POLICY).call("codex_turn", {
    text: "context", cwd: "D:\\Requested", model: "requested-model", effort: "high", sandbox: "read-only", approval_policy: "never",
  }));
  const context = object(result.context_verification);
  assert.equal(object(context.requested).model, "requested-model");
  const readbacks = object(object(context.native_thread_context).fields);
  assert.equal(object(readbacks.model).value, "native-model");
  assert.equal(object(readbacks.model).verified, true);
  assert.equal(object(readbacks.effort).source, "thread/start.reasoningEffort");
  assert.equal(object(readbacks.cwd).value, "D:\\Native");
  for (const field of Object.values(object(object(context.effective).fields))) {
    assert.equal(object(field).verified, false);
    assert.equal(object(field).value, null);
  }
});

test("missing native context stays unknown and ordinary resume creates no model registry or extra reads", async () => {
  const native = new Stub(method => method === "thread/resume"
    ? { thread: { id: "thread", model: "not-a-stable-readback" }, cwd: 42, approvalPolicy: {}, reasoningEffort: null }
    : { turn: { id: "turn" } });
  const result = object(await new ControlSurface(native).call("codex_turn", { text: "continue", thread_id: "thread" }));
  const context = object(result.context_verification);
  for (const value of Object.values(object(object(context.native_thread_context).fields))) assert.equal(object(value).verified, false);
  assert.deepEqual(native.calls.map(c => c.method), ["thread/resume", "turn/start"]);
  assert.equal(object(context.requested).cwd, null);
});

const filesystem: TargetingFilesystem = { realpath: value => value, isDirectory: () => true, isLink: () => false, sameDirectory: (a, b) => a.toLowerCase() === b.toLowerCase() };
function targeted(handler: (method: string, params: Record<string, unknown>) => unknown) {
  const native = new Stub(handler);
  const policy = new TargetingPolicy({ allowed_roots: ["D:\\Allowed"], project_aliases: { project: "D:\\Allowed\\Project", outside: "D:\\Outside" } }, WINDOWS_PLATFORM_POLICY, filesystem);
  return { native, surface: new ControlSurface(native, undefined, WINDOWS_PLATFORM_POLICY, policy) };
}

test("fresh and resumed aliases resolve only cwd; ambiguity and disallowed aliases fail before native calls", async () => {
  const { native, surface } = targeted((method, params) => method === "thread/start" || method === "thread/resume"
    ? { thread: { id: "thread" }, cwd: params.cwd } : { turn: { id: "turn" } });
  await surface.call("codex_turn", { text: "fresh", project_alias: "project" });
  assert.deepEqual(native.calls[0]?.params, { cwd: "D:\\Allowed\\Project", serviceName: "local-codex-bridge" });
  assert.equal(native.calls[1]?.params.cwd, "D:\\Allowed\\Project");
  native.runtime.recordNotification("turn/completed", { threadId: "thread", turn: { id: "turn", status: "completed" } });
  await surface.call("codex_turn", { text: "resume", thread_id: "thread", project_alias: "project" });
  for (const args of [
    { project_alias: "project", cwd: "D:\\Allowed" },
    { project_alias: "outside" }, { project_alias: "missing" }, { cwd: "D:\\Outside" },
  ]) {
    const before = native.calls.length;
    await assert.rejects(surface.call("codex_turn", { text: "reject", ...args }));
    assert.equal(native.calls.length, before);
  }
});

test("restricted resume verifies inherited native cwd before resume and checks native effective cwd again", async () => {
  const { native, surface } = targeted((method, params) => {
    if (method === "thread/read") return { thread: { id: params.threadId, cwd: "D:\\Allowed\\Project" } };
    if (method === "thread/resume") return { thread: { id: params.threadId }, cwd: "D:\\Allowed\\Project" };
    return { turn: { id: "turn" } };
  });
  await surface.call("codex_turn", { text: "continue", thread_id: "thread" });
  assert.deepEqual(native.calls.map(c => c.method), ["thread/read", "thread/resume", "turn/start"]);
  assert.equal("cwd" in native.calls[1]!.params, false);
  assert.equal("cwd" in native.calls[2]!.params, false);
  for (const readback of [{ id: "thread" }, { id: "different", cwd: "D:\\Allowed" }, { id: "thread", cwd: "D:\\Outside" }]) {
    const { native: denied, surface: control } = targeted(() => ({ thread: readback }));
    await assert.rejects(control.call("codex_turn", { text: "continue", thread_id: "thread" }), /TARGETING_DENIED/);
    assert.deepEqual(denied.calls.map(c => c.method), ["thread/read"]);
  }
  for (const cwd of [undefined, "D:\\Outside", "D:\\Allowed\\Other"]) {
    const { native: denied, surface: control } = targeted(() => ({ thread: { id: "thread" }, cwd }));
    await assert.rejects(control.call("codex_turn", { text: "fresh", project_alias: "project" }), /TARGETING_DENIED/);
    assert.deepEqual(denied.calls.map(c => c.method), ["thread/start"]);
  }
});

test("restricted explicit resume checks its target before any native mutation", async () => {
  const { native, surface } = targeted(() => { throw new Error("must not call native"); });
  await assert.rejects(surface.call("codex_turn", { text: "resume", thread_id: "thread", cwd: "D:\\Outside" }), /TARGETING_DENIED/);
  assert.equal(native.calls.length, 0);
});

test("active thread status without a turn id also denies restart until native exit", async () => {
  const native = manager();
  try {
    await native.ensureReady();
    native.runtime.recordNotification("thread/status/changed", { threadId: "unscoped", status: { type: "active" } });
    assert.equal(native.status().live.unscoped_active_threads, 1);
    await assert.rejects(native.restart(), /RESTART_DENIED.*unscoped_active_threads/);
    await assert.rejects(native.request("test/exit", {}), /exited unexpectedly/);
    assert.equal(native.status().live.unscoped_active_threads, 0);
    await native.restart();
  } finally { await native.close(); }
});

test("supervision does not suppress server requests using notification-like names", async () => {
  const native = manager();
  native.runtime.recordServerRequest(0, "item/agentMessage/delta", { threadId: "thread" });
  const result = object(await new ControlSurface(native).call("codex_observe", { thread_id: "thread", mode: "supervision" }));
  assert.equal((result.events as unknown[]).length, 1);
  assert.equal(object(result.suppressed_events).count, 0);
});

test("native context field validation rejects malformed cwd and unknown policy shapes", async () => {
  const native = new Stub(method => method === "thread/resume"
    ? { thread: { id: "thread" }, cwd: "relative", sandbox: { type: "futurePolicy" }, model: "" }
    : { turn: { id: "turn" } });
  const result = object(await new ControlSurface(native).call("codex_turn", { text: "continue", thread_id: "thread" }));
  const fields = object(object(object(result.context_verification).native_thread_context).fields);
  assert.equal(object(fields.cwd).verified, false);
  assert.equal(object(fields.sandbox).verified, false);
  assert.equal(object(fields.model).verified, false);
});

test("context verification never coerces array fields into valid policy strings", async () => {
  const native = new Stub(method => method === "thread/resume"
    ? { thread: { id: "thread" }, sandbox: { type: ["readOnly"] }, approvalPolicy: ["never"], model: "  " }
    : { turn: { id: "turn" } });
  const result = object(await new ControlSurface(native).call("codex_turn", { text: "continue", thread_id: "thread" }));
  const fields = object(object(object(result.context_verification).native_thread_context).fields);
  for (const field of ["sandbox", "approval_policy", "model"]) assert.equal(object(fields[field]).verified, false);
});

test("native malformed JSON-RPC and RPC errors activate auto diagnostics through the real fake child", async () => {
  for (const method of ["test/rpc-error", "test/malformed"]) {
    const native = manager();
    native.runtime.ensureThread("thread");
    const surface = new ControlSurface(native);
    try {
      await surface.call("codex_observe", { thread_id: "thread" });
      await assert.rejects(native.request(method, { threadId: "thread" }));
      const observed = object(await surface.call("codex_observe", { thread_id: "thread" }));
      assert.equal(observed.effective_mode, "diagnostic");
      const diagnostic = object(observed.diagnostics);
      const codes = diagnostic.triggers as string[];
      assert.ok(codes.includes(method === "test/rpc-error" ? "native_rpc_error" : "protocol_error"));
    } finally { await native.close(); }
  }
});

test("auto remains diagnostic for unresolved native UNKNOWN and recovers only after verified late acknowledgement", async () => {
  const native = manager();
  native.runtime.markTurnAccepted("thread", "turn");
  const surface = new ControlSurface(native);
  try {
    await assert.rejects(native.request("turn/steer", {
      threadId: "thread", expectedTurnId: "turn", input: [{ type: "text", text: "delayed fixture" }],
    }), /UNKNOWN/);
    const first = object(await surface.call("codex_observe", { thread_id: "thread" }));
    assert.equal(first.effective_mode, "diagnostic");
    const stillUnknown = object(await surface.call("codex_observe", { thread_id: "thread" }));
    assert.equal(stillUnknown.effective_mode, "diagnostic");
    assert.deepEqual(object(stillUnknown.diagnostics).raw_evidence, []);
    await delay(180);
    assert.equal(native.status().native_mutation_outcome_unknown, false);
    const recovered = object(await surface.call("codex_observe", { thread_id: "thread" }));
    assert.equal(recovered.effective_mode, "supervision");
  } finally { await native.close(); }
});

test("malformed and wrongly scoped late acknowledgements cannot fabricate reconciliation or settle UNKNOWN", async () => {
  for (const text of ["delayed missing scope", "delayed wrong scope", "delayed malformed error"]) {
    const native = manager();
    native.runtime.markTurnAccepted("thread", "turn");
    try {
      await assert.rejects(native.request("turn/steer", {
        threadId: "thread", expectedTurnId: "turn", input: [{ type: "text", text }],
      }), /UNKNOWN/);
      await delay(180);
      assert.equal(native.status().native_mutation_outcome_unknown, true, text);
      const observation = native.runtime.observe("thread", 0, 100)!;
      assert.equal(observation.active_turn_id, "turn");
      assert.equal(observation.events.some(event => event.method === "appServer/lateResponseReconciled"), false, text);
      await assert.rejects(native.restart(), /RESTART_DENIED/);
    } finally { await native.close(); }
  }
});
