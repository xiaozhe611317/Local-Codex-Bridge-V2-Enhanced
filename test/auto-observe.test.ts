import assert from "node:assert/strict";
import test from "node:test";
import { AppServerManager } from "../src/app-server.js";
import { RuntimeStore } from "../src/runtime.js";
import { ControlSurface } from "../src/tools.js";
import { ObservationSession, type ControlCallContext, type ObservationDelivery } from "../src/observation-session.js";

function obj(value: unknown): Record<string, unknown> { return value as Record<string, unknown>; }
function setup(ring = 256) {
  const runtime = new RuntimeStore(ring);
  const manager = new AppServerManager(runtime, { executable: "unused-test-executable" });
  return { runtime, manager, control: new ControlSurface(manager) };
}
function event(runtime: RuntimeStore, method: string, item: unknown = {}, thread = "thread") {
  runtime.recordNotification(method, { threadId: thread, turnId: "turn", item });
}
const events = (result: unknown) => obj(result).events as Array<Record<string, unknown>>;

test("default auto delivers only unseen low-noise events and consumes suppressed cursors", async () => {
  const { runtime, control } = setup();
  runtime.markTurnAccepted("thread", "turn");
  runtime.recordNotification("item/agentMessage/delta", { threadId: "thread", delta: "noise" });
  runtime.recordNotification("thread/tokenUsage/updated", { threadId: "thread" });
  event(runtime, "item/started", { type: "commandExecution", id: "cmd", command: "test-command" });
  const first = obj(await control.call("codex_observe", { thread_id: "thread", limit: 2 }));
  assert.equal(first.mode, "auto");
  assert.equal(first.effective_mode, "supervision");
  assert.deepEqual(first.events, []);
  assert.equal(first.next_cursor, 2);
  assert.equal(obj(first.suppressed_events).count, 2);
  assert.equal(first.has_more, true);
  const second = obj(await control.call("codex_observe", { thread_id: "thread" }));
  assert.deepEqual(events(second).map(e => e.cursor), [3]);
  assert.equal(second.next_cursor, 3);
  const third = obj(await control.call("codex_observe", { thread_id: "thread" }));
  assert.deepEqual(third.events, []);
  assert.equal(third.next_cursor, 3);
  assert.deepEqual(Object.keys(obj(third.delta_summary)), ["changes", "commands", "validation", "pending", "unresolved", "next"]);
  assert.ok(Object.values(obj(third.delta_summary)).every(value => Array.isArray(value) && value.length === 0));
});

test("manual cursor is independent and omitted/auto manual modes preserve raw pagination", async () => {
  const { runtime, control } = setup();
  event(runtime, "item/agentMessage/delta");
  event(runtime, "item/started", { type: "commandExecution", id: "cmd" });
  const manual = obj(await control.call("codex_observe", { thread_id: "thread", cursor: 0, limit: 1 }));
  assert.equal(manual.mode, "raw");
  assert.equal(manual.cursor_control, "manual");
  assert.equal(events(manual).length, 1);
  assert.deepEqual(await control.call("codex_observe", { thread_id: "thread", mode: "auto", cursor: 0, limit: 1 }), manual);
  const auto = obj(await control.call("codex_observe", { thread_id: "thread" }));
  assert.deepEqual(events(auto).map(e => e.cursor), [2]);
  await control.call("codex_observe", { thread_id: "thread", mode: "raw", cursor: 0 });
  assert.deepEqual(events(await control.call("codex_observe", { thread_id: "thread" })), []);
});

test("raw and supervision explicitly select projection while automatic cursors continue across modes", async () => {
  const { runtime, control } = setup();
  event(runtime, "item/agentMessage/delta");
  assert.equal(events(await control.call("codex_observe", { thread_id: "thread", mode: "raw" })).length, 1);
  event(runtime, "item/agentMessage/delta");
  assert.equal(events(await control.call("codex_observe", { thread_id: "thread", mode: "supervision" })).length, 0);
  assert.equal(events(await control.call("codex_observe", { thread_id: "thread", mode: "raw" })).length, 0);
});

test("connection and thread cursors are isolated, bounded and require re-anchor after eviction", async () => {
  const { runtime, control } = setup();
  event(runtime, "item/started");
  event(runtime, "item/started", {}, "other");
  const one = { observationSession: new ObservationSession(1) };
  const two = { observationSession: new ObservationSession() };
  const read = (id: string, context: ControlCallContext) => control.call("codex_observe", { thread_id: id }, undefined, context);
  assert.equal(events(await read("thread", one)).length, 1);
  assert.equal(events(await read("thread", two)).length, 1);
  assert.equal(events(await read("other", one)).length, 1);
  const evicted = obj(await read("thread", one));
  assert.equal(obj(evicted.reanchor).required, true);
  assert.ok((obj(evicted.reanchor).reasons as string[]).includes("connection_cursor_unavailable"));
  assert.equal(events(await read("thread", two)).length, 0);
});

test("automatic observations do not consume on cancellation, rollback or failed delivery", async () => {
  const { runtime, control } = setup();
  runtime.markTurnAccepted("thread", "turn");
  const session = new ObservationSession();
  const abort = new AbortController();
  const waiting = control.call("codex_observe", { thread_id: "thread", wait_ms: 1000 }, abort.signal, { observationSession: session });
  await assert.rejects(control.call("codex_observe", { thread_id: "thread" }, undefined, { observationSession: session }), /OBSERVE_IN_PROGRESS/);
  abort.abort();
  await assert.rejects(waiting, /cancelled/);
  event(runtime, "item/started");
  let delivery!: ObservationDelivery;
  const context = { observationSession: session, deferObservation: (value: ObservationDelivery) => { delivery = value; } };
  assert.equal(events(await control.call("codex_observe", { thread_id: "thread" }, undefined, context)).length, 1);
  delivery.rollback();
  assert.equal(events(await control.call("codex_observe", { thread_id: "thread" }, undefined, context)).length, 1);
  delivery.commit();
  delivery.rollback();
  assert.equal(events(await control.call("codex_observe", { thread_id: "thread" }, undefined, context)).length, 0);
  delivery.rollback();
});

test("cursor loss expands only bounded local raw evidence then returns to normal without replay", async () => {
  const { runtime, control } = setup(4);
  for (let i = 0; i < 10; i++) event(runtime, "item/started", { type: "commandExecution", id: "cmd-" + i, command: "x".repeat(5000) });
  const first = obj(await control.call("codex_observe", { thread_id: "thread" }));
  assert.equal(first.cursor_lost, true);
  assert.equal(first.effective_mode, "diagnostic");
  assert.equal(obj(first.reanchor).required, true);
  assert.ok(JSON.stringify(obj(first.diagnostics).raw_evidence).length <= 6002);
  assert.equal(first.next_cursor, 10);
  const next = obj(await control.call("codex_observe", { thread_id: "thread" }));
  assert.equal(next.effective_mode, "supervision");
  assert.equal(next.diagnostics, null);
  assert.deepEqual(next.events, []);
});

test("supervision never expands raw diagnostics even when re-anchor is required", async () => {
  const { runtime, control } = setup(2);
  for (let i = 0; i < 5; i++) event(runtime, "item/started");
  const result = obj(await control.call("codex_observe", { thread_id: "thread", mode: "supervision" }));
  assert.equal(result.effective_mode, "supervision");
  assert.equal(result.diagnostics, null);
  assert.equal(obj(result.reanchor).required, true);
});

test("each real runtime anomaly gets one bounded expansion and normal auto resumes", async (t) => {
  for (const code of ["mutation_outcome_unknown", "app_server_unexpected_exit", "restart_failure", "protocol_error", "native_rpc_error", "turn_terminal_conflict"]) {
    await t.test(code, async () => {
      const { runtime, control } = setup();
      runtime.ensureThread("thread");
      await control.call("codex_observe", { thread_id: "thread" });
      runtime.recordDiagnostic(code, { method: "synthetic-contract-event", detail: "x".repeat(10000) }, "thread");
      const first = obj(await control.call("codex_observe", { thread_id: "thread", wait_ms: 1000 }));
      assert.equal(first.effective_mode, "diagnostic");
      assert.ok(JSON.stringify(first.diagnostics).length < 12000);
      assert.equal((obj(first.diagnostics).runtime_evidence as unknown[]).length, 1);
      const next = obj(await control.call("codex_observe", { thread_id: "thread" }));
      assert.equal(next.effective_mode, "supervision");
      assert.deepEqual(events(next), []);
    });
  }
});

test("unknown pending requests and states expand once; resolving them restores supervision", async () => {
  const { runtime, control } = setup();
  runtime.ensureThread("thread");
  runtime.recordServerRequest(0, "future/request", { threadId: "thread", details: "native" });
  const first = obj(await control.call("codex_observe", { thread_id: "thread" }));
  assert.equal(first.effective_mode, "diagnostic");
  assert.equal((first.pending_requests as unknown[]).length, 1);
  const repeated = obj(await control.call("codex_observe", { thread_id: "thread" }));
  assert.deepEqual(repeated.pending_requests, []);
  assert.deepEqual(obj(repeated.diagnostics).raw_evidence, []);
  runtime.recordNotification("serverRequest/resolved", { requestId: 0 });
  const resolved = obj(await control.call("codex_observe", { thread_id: "thread" }));
  assert.equal(resolved.effective_mode, "supervision");
  assert.equal(obj((obj(resolved.delta_summary).pending as unknown[])[0]).status, "no_longer_pending");
  runtime.recordNotification("thread/status/changed", { threadId: "thread", status: "futureState" });
  assert.equal(obj(await control.call("codex_observe", { thread_id: "thread" })).effective_mode, "diagnostic");
  runtime.recordNotification("thread/status/changed", { threadId: "thread", status: "idle" });
  assert.equal(obj(await control.call("codex_observe", { thread_id: "thread" })).effective_mode, "supervision");
});

test("nonzero command with insufficient summary expands only evidence for that command", async () => {
  const { runtime, control } = setup();
  event(runtime, "item/started", { type: "commandExecution", id: "unrelated", command: "other" });
  event(runtime, "item/started", { type: "commandExecution", id: "failed", command: "fixture-test" });
  event(runtime, "item/completed", { type: "commandExecution", id: "failed", exitCode: 2, aggregatedOutput: "" });
  const result = obj(await control.call("codex_observe", { thread_id: "thread" }));
  assert.equal(result.effective_mode, "diagnostic");
  assert.equal(JSON.stringify(obj(result.diagnostics).raw_evidence).includes("unrelated"), false);
  const validation = obj(result.delta_summary).validation as Array<Record<string, unknown>>;
  assert.equal(validation[0]?.exit_code, 2);
  assert.equal(validation[0]?.kind, "reported_command_exit");
  assert.equal(JSON.stringify(result.delta_summary).includes("passed"), false);
  event(runtime, "item/completed", { type: "commandExecution", id: "known-failure", exitCode: 1, aggregatedOutput: "specific native error" });
  assert.equal(obj(await control.call("codex_observe", { thread_id: "thread" })).effective_mode, "supervision");
});

test("automatic terminal and pending results are deltas; manual reads keep snapshots", async () => {
  const { runtime, control } = setup();
  runtime.recordNotification("turn/completed", { threadId: "thread", turn: { id: "turn", status: "completed", items: [{ type: "agentMessage", text: "FINAL" }] } });
  const first = obj(await control.call("codex_observe", { thread_id: "thread" }));
  assert.equal(obj(first.terminal).final_result, "FINAL");
  const second = obj(await control.call("codex_observe", { thread_id: "thread" }));
  assert.equal(second.terminal, null);
  assert.equal(second.terminal_unchanged, true);
  assert.equal(obj(obj(await control.call("codex_observe", { thread_id: "thread", cursor: 0 })).terminal).final_result, "FINAL");
});

test("runtime restart and unavailable live state demand re-anchor without persisted replay", async () => {
  const { runtime, control } = setup();
  event(runtime, "item/started");
  const old = obj(await control.call("codex_observe", { thread_id: "thread" }));
  runtime.resetAfterRestart();
  const absent = obj(await control.call("codex_observe", { thread_id: "thread" }));
  assert.equal(absent.runtime_available, false);
  assert.equal(absent.live_state_reconstructable, false);
  assert.equal(obj(absent.reanchor).required, true);
  assert.equal(absent.stored_thread, undefined);
  assert.equal(absent.next_cursor, null);
  assert.equal(absent.current_cursor, null);
  assert.deepEqual(absent.events, []);
  event(runtime, "item/started");
  const newGeneration = obj(await control.call("codex_observe", { thread_id: "thread" }));
  assert.ok(Number(newGeneration.next_cursor) > Number(old.next_cursor));
  assert.equal(events(newGeneration).length, 1);
});

test("connection protocol errors carry only their bounded error response, then clear from the delta", async () => {
  const { runtime, control } = setup();
  event(runtime, "item/started", { id: "unrelated-old-command" });
  const session = new ObservationSession();
  await control.call("codex_observe", { thread_id: "thread" }, undefined, { observationSession: session });
  session.recordProtocolError(-32600, "Malformed request");
  const error = obj(await control.call("codex_observe", { thread_id: "thread" }, undefined, { observationSession: session }));
  assert.equal(error.effective_mode, "diagnostic");
  assert.deepEqual(obj(error.diagnostics).raw_evidence, []);
  assert.equal((obj(error.diagnostics).connection_evidence as unknown[]).length, 1);
  const normal = obj(await control.call("codex_observe", { thread_id: "thread" }, undefined, { observationSession: session }));
  assert.equal(normal.effective_mode, "supervision");
});

test("normal auto omits embedded turn history and duplicate final text; explicit manual raw retains evidence", async () => {
  const { runtime, control } = setup();
  runtime.recordNotification("item/completed", { threadId: "thread", turnId: "turn", item: { type: "agentMessage", id: "final", text: "FINAL" } });
  runtime.recordNotification("turn/completed", { threadId: "thread", turn: { id: "turn", status: "completed", items: [
    { type: "commandExecution", aggregatedOutput: "OLD_LOG_SHOULD_NOT_REPLAY" },
    { type: "agentMessage", id: "final", text: "FINAL" },
  ] } });
  const result = obj(await control.call("codex_observe", { thread_id: "thread" }));
  assert.equal(JSON.stringify(result).includes("OLD_LOG_SHOULD_NOT_REPLAY"), false);
  assert.equal(obj(result.terminal).final_result, "FINAL");
  assert.equal(obj(result.terminal).turn, null);
  assert.equal(obj(obj(events(result)[0]?.data).item).text, undefined);
  const raw = await control.call("codex_observe", { thread_id: "thread", cursor: 0, mode: "raw" });
  assert.equal(JSON.stringify(raw).includes("OLD_LOG_SHOULD_NOT_REPLAY"), true);
});

test("a contradictory old completion cannot clear the authoritative active turn or its pending request", async () => {
  const { runtime, control, manager } = setup();
  runtime.markTurnAccepted("thread", "current");
  runtime.recordServerRequest(0, "item/tool/requestUserInput", { threadId: "thread", turnId: "current", questions: [] });
  runtime.recordNotification("turn/completed", { threadId: "thread", turn: { id: "old", status: "completed", items: [] } });
  const result = obj(await control.call("codex_observe", { thread_id: "thread" }));
  assert.equal(result.active_turn_id, "current");
  assert.equal(result.terminal, null);
  assert.equal(result.effective_mode, "diagnostic");
  assert.equal(obj(result.reanchor).required, true);
  assert.equal(runtime.pendingForThread("thread").length, 1);
  await assert.rejects(manager.restart(), /RESTART_DENIED/);
});

test("ControlSurface eviction plus repeated delivery rollback preserves explicit cursor-loss reanchor", async () => {
  const { runtime, control } = setup();
  event(runtime, "item/started", { id: "a-command" }, "thread-a");
  event(runtime, "item/started", { id: "b-command" }, "thread-b");
  const session = new ObservationSession(1);
  const delivered = obj(await control.call("codex_observe", { thread_id: "thread-a" }, undefined, { observationSession: session }));
  await control.call("codex_observe", { thread_id: "thread-b" }, undefined, { observationSession: session });
  let delivery!: ObservationDelivery;
  const context = { observationSession: session, deferObservation: (value: ObservationDelivery) => { delivery = value; } };
  for (const mode of ["auto", "supervision", "raw", "auto"]) {
    const retry = obj(await control.call("codex_observe", { thread_id: "thread-a", mode }, undefined, context));
    assert.equal(obj(retry.reanchor).required, true, mode);
    assert.ok((obj(retry.reanchor).reasons as string[]).includes("connection_cursor_unavailable"), mode);
    // With no retained consumption cursor, existing evidence is explicitly
    // unanchored; it must never be presented as an ordinary unseen delta.
    assert.equal(retry.next_cursor, delivered.next_cursor);
    assert.equal(retry.current_cursor, delivered.current_cursor);
    delivery.rollback();
    delivery.commit(); // a stale/rolled-back delivery cannot commit later
  }
  const success = obj(await control.call("codex_observe", { thread_id: "thread-a" }, undefined, context));
  assert.equal(obj(success.reanchor).required, true);
  delivery.commit();
  delivery.rollback();
  const next = obj(await control.call("codex_observe", { thread_id: "thread-a" }, undefined, { observationSession: session }));
  assert.deepEqual(next.events, []);
  assert.equal(obj(next.reanchor).required, false);
  assert.equal(next.next_cursor, delivered.next_cursor);
});

test("uncommitted ControlSurface leases reserve bounded session capacity without storing a cursor", async () => {
  const { runtime, control } = setup();
  runtime.ensureThread("thread-a");
  runtime.ensureThread("thread-b");
  const session = new ObservationSession(1);
  let delivery!: ObservationDelivery;
  await control.call("codex_observe", { thread_id: "thread-a" }, undefined, {
    observationSession: session, deferObservation: value => { delivery = value; },
  });
  await assert.rejects(control.call("codex_observe", { thread_id: "thread-b" }, undefined, { observationSession: session }), /OBSERVE_CAPACITY/);
  delivery.rollback();
  const fresh = obj(await control.call("codex_observe", { thread_id: "thread-b" }, undefined, { observationSession: session }));
  assert.equal(obj(fresh.reanchor).required, false);
});
