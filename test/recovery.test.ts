import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AppServerManager, type AppServerLaunchOptions } from "../src/app-server.js";
import { ControlSurface } from "../src/tools.js";
const obj = (value: unknown) => value as Record<string, unknown>;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function setup(options: Partial<AppServerLaunchOptions> = {}) {
  const native = new AppServerManager(undefined, {
    executable: process.execPath, prefixArgs: [fileURLToPath(new URL("../../test/recovery-codex.mjs", import.meta.url))],
    requestTimeoutMs: 40, lateResponseTtlMs: 5000, ...options,
  });
  return { native, control: new ControlSurface(native) };
}
async function start(native: AppServerManager, thread = "thread", label = "a") {
  native.runtime.ensureThread(thread);
  await assert.rejects(native.request("turn/start", { threadId: thread, input: [{ type: "text", text: label }] }), /UNKNOWN/);
}
async function ack(native: AppServerManager, status: unknown = "futureState", turnId = "turn-a", label = "a", threadId?: string) {
  await native.request("test/ack", { label, turnId, status, ...(threadId === undefined ? {} : { threadId }) });
}
async function notify(native: AppServerManager, method: string, params: unknown) {
  await native.request("test/notify", { method, params });
}
const terminal = (threadId = "thread", turnId = "turn-a", status: unknown = "completed") =>
  ({ threadId, turn: { id: turnId, status, items: [] } });
const idle = (threadId = "thread", status: unknown = { type: "idle" }) => ({ threadId, status });
const readResult = (threadId = "thread", turnId = "turn-a", status: unknown = "completed", threadStatus: unknown = { type: "idle" }) =>
  ({ thread: { id: threadId, status: threadStatus, turns: [{ id: turnId, status, items: [] }] } });
async function read(native: AppServerManager, result: unknown) {
  await native.request("test/read-result", { result });
  await native.request("thread/read", { threadId: "thread", includeTurns: true });
}
async function unsafe(native: AppServerManager, control: ControlSurface) {
  assert.equal(native.status().native_mutation_outcome_unknown, true);
  assert.equal(native.status().safe_to_restart, false);
  await assert.rejects(control.call("codex_runtime", { action: "restart" }), /RESTART_DENIED/);
}

test("recovery: invalid late ack retains UNKNOWN then matching terminal and idle settle it", async (t) => {
  for (const idleFirst of [false, true]) await t.test(String(idleFirst), async () => {
    const { native, control } = setup();
    try {
      await start(native); await ack(native);
      await unsafe(native, control);
      const before = obj(await control.call("codex_observe", { thread_id: "thread" }));
      assert.equal(before.effective_mode, "diagnostic");
      assert.equal(obj(before.reanchor).required, true);
      if (idleFirst) await notify(native, "thread/status/changed", idle());
      await notify(native, "turn/completed", terminal());
      if (!idleFirst) { await unsafe(native, control); await notify(native, "thread/status/changed", idle()); }
      assert.equal(native.status().native_mutation_outcome_unknown, false);
      assert.equal(native.status().safe_to_restart, true);
      const after = obj(await control.call("codex_observe", { thread_id: "thread" }));
      assert.equal(after.effective_mode, "supervision");
      assert.equal(obj(after.terminal).turn_id, "turn-a");
      assert.ok(Number(after.next_cursor) > Number(before.next_cursor));
      assert.deepEqual(obj(await control.call("codex_observe", { thread_id: "thread" })).events, []);
    } finally { await native.close(); }
  });
});

test("recovery: a later supported same-ID response settles only its original turn", async () => {
  const { native, control } = setup();
  try {
    await start(native); await ack(native);
    await ack(native, "completed", "different-turn"); await unsafe(native, control);
    await ack(native, "completed", "turn-a", "a", "different-thread"); await unsafe(native, control);
    await ack(native, "completed");
    assert.equal(native.status().native_mutation_outcome_unknown, false);
    assert.equal(native.status().safe_to_restart, true);
  } finally { await native.close(); }
});

test("recovery: authoritative scoped thread/read settles without fabricating live history or cursor", async () => {
  const { native, control } = setup();
  try {
    await start(native); await ack(native);
    await notify(native, "turn/started", { threadId: "thread", turn: { id: "turn-a", status: "inProgress" } });
    await unsafe(native, control);
    await control.call("codex_observe", { thread_id: "thread" });
    const cursor = native.runtime.currentCursor("thread");
    await read(native, readResult());
    assert.equal(native.status().native_mutation_outcome_unknown, false);
    assert.equal(native.status().safe_to_restart, true);
    assert.equal(native.runtime.currentCursor("thread"), cursor);
    const observed = obj(await control.call("codex_observe", { thread_id: "thread" }));
    assert.equal(observed.effective_mode, "supervision");
    assert.deepEqual(observed.events, []);
    assert.equal(observed.terminal, null);
  } finally { await native.close(); }
});

test("recovery: unrelated, active and malformed notification evidence cannot clear UNKNOWN", async () => {
  const { native, control } = setup();
  try {
    await start(native); await ack(native);
    for (const [method, params] of [
      ["thread/status/changed", idle("other")],
      ["thread/status/changed", idle()],
      ["turn/completed", terminal("other")],
      ["turn/completed", terminal("thread", "other-turn")],
      ["turn/started", { threadId: "thread", turn: { id: "turn-a", status: "inProgress" } }],
      ["thread/status/changed", idle("thread", { type: "active" })],
      ["turn/completed", terminal("thread", "turn-a", { type: "completed" })],
      ["turn/completed", { threadId: "thread", turn: { id: "turn-a", turnId: "other-turn", status: "completed" } }],
      ["thread/status/changed", idle()],
      ["thread/status/changed", idle("thread", { type: "active" })],
      ["turn/completed", terminal()],
      ["thread/status/changed", idle("thread", { type: ["idle"] })],
    ] as const) { await notify(native, method, params); await unsafe(native, control); }
    const prior = native.runtime.observe("thread", 0, 100)!.terminal;
    await ack(native, { type: "completed" });
    assert.deepEqual(native.runtime.observe("thread", 0, 100)!.terminal, prior);
    await unsafe(native, control);
    await notify(native, "thread/status/changed", idle());
    assert.equal(native.status().native_mutation_outcome_unknown, false);
  } finally { await native.close(); }
});

test("recovery: malformed, mismatched and ambiguous thread/read is insufficient", async () => {
  const { native, control } = setup();
  try {
    await start(native); await ack(native);
    for (const result of [
      {}, readResult("other"), readResult("thread", "other-turn"),
      { thread: { id: "thread", status: { type: "idle" }, turns: [{ id: "turn-a", turnId: "other-turn", status: "completed" }] } },
      readResult("thread", "turn-a", "futureState"), readResult("thread", "turn-a", "inProgress"),
      readResult("thread", "turn-a", { type: "completed" }),
      readResult("thread", "turn-a", "completed", ["idle"]),
      readResult("thread", "turn-a", "completed", { type: ["idle"] }),
      { thread: { id: "thread", status: { type: "idle" }, turns: [
        { id: "turn-a", status: "completed" }, { id: "turn-a", status: "completed" },
      ] } },
      { thread: { id: "thread", status: { type: "idle" }, turns: [
        { id: "turn-a", status: "inProgress" }, { id: "newer-turn", status: "completed" },
      ] } },
    ]) { await read(native, result); await unsafe(native, control); }
    await read(native, readResult());
    assert.equal(native.status().native_mutation_outcome_unknown, false);
  } finally { await native.close(); }
});

test("recovery: stale read cannot overwrite later native activity", async () => {
  const { native, control } = setup({ requestTimeoutMs: 200 });
  try {
    await start(native); await ack(native);
    await native.request("test/read-result", { result: readResult(), hold: true });
    const pending = native.request("thread/read", { threadId: "thread", includeTurns: true });
    await native.request("test/barrier", {});
    await notify(native, "turn/started", { threadId: "thread", turn: { id: "turn-a", status: "inProgress" } });
    await native.request("test/release-read", {}); await pending;
    await unsafe(native, control);
    assert.equal(native.runtime.observe("thread", 0, 100)!.active_turn_id, "turn-a");
    await read(native, readResult());
    assert.equal(native.status().safe_to_restart, true);
  } finally { await native.close(); }
});

test("recovery: simultaneous UNKNOWN mutations settle independently and retain pending guards", async () => {
  const { native, control } = setup();
  try {
    await start(native, "thread", "a"); await ack(native);
    await start(native, "other", "b"); await ack(native, "futureState", "turn-b", "b");
    await notify(native, "turn/completed", terminal());
    await notify(native, "thread/status/changed", idle());
    await unsafe(native, control);
    native.runtime.recordServerRequest(0, "item/tool/requestUserInput", { threadId: "other", questions: [] });
    await ack(native, "completed", "turn-b", "b");
    assert.equal(native.status().native_mutation_outcome_unknown, false);
    assert.equal(native.status().safe_to_restart, false);
    assert.ok(native.status().restart_denied_reasons.includes("pending_requests"));
    await assert.rejects(control.call("codex_runtime", { action: "restart" }), /RESTART_DENIED/);
    await notify(native, "serverRequest/resolved", { requestId: 0 });
    assert.equal(native.status().safe_to_restart, true);
  } finally { await native.close(); }
});

test("recovery: ambiguous duplicate turn bindings cannot settle from indirect evidence", async () => {
  const { native, control } = setup();
  try {
    await start(native, "thread", "a"); await ack(native);
    await start(native, "thread", "b"); await ack(native, "futureState", "turn-a", "b");
    await notify(native, "turn/completed", terminal()); await notify(native, "thread/status/changed", idle());
    await read(native, readResult()); await unsafe(native, control);
    await ack(native, "completed", "turn-a", "a");
    await unsafe(native, control);
    await read(native, readResult());
    assert.equal(native.status().safe_to_restart, true);
  } finally { await native.close(); }
});

test("recovery: TTL expiry and capacity eviction never silently settle unresolved mutations", async (t) => {
  await t.test("TTL is not extended by invalid acknowledgements", async () => {
    const { native, control } = setup({ lateResponseTtlMs: 160 });
    try {
      await start(native); await ack(native); await delay(100); await ack(native); await delay(100);
      await ack(native, "completed"); await notify(native, "turn/completed", terminal());
      await notify(native, "thread/status/changed", idle()); await read(native, readResult());
      await unsafe(native, control);
    } finally { await native.close(); }
  });
  await t.test("evicted correlation cannot match later evidence", async () => {
    const { native, control } = setup({ lateResponseLimit: 1 });
    try {
      await start(native, "thread", "a"); await ack(native);
      await start(native, "other", "b"); await ack(native, "futureState", "turn-b", "b");
      await ack(native, "completed", "turn-a", "a");
      await notify(native, "turn/completed", terminal()); await notify(native, "thread/status/changed", idle());
      await ack(native, "completed", "turn-b", "b");
      await unsafe(native, control);
    } finally { await native.close(); }
  });
});

test("recovery: notifications cannot bind a turn without a same-ID native association", async () => {
  const { native, control } = setup();
  try {
    await start(native);
    await notify(native, "turn/completed", terminal()); await notify(native, "thread/status/changed", idle());
    await read(native, readResult()); await unsafe(native, control);
    await ack(native); // first native response establishes only the scoped turn identity
    await unsafe(native, control);
    await read(native, readResult());
    assert.equal(native.status().safe_to_restart, true);
  } finally { await native.close(); }
});

test("recovery: read issued before turn identity binding is not sufficient", async () => {
  const { native, control } = setup({ requestTimeoutMs: 200 });
  try {
    await start(native);
    await native.request("test/read-result", { result: readResult(), hold: true });
    const pending = native.request("thread/read", { threadId: "thread", includeTurns: true });
    await native.request("test/barrier", {});
    await ack(native);
    await native.request("test/release-read", {}); await pending;
    await unsafe(native, control);
    await read(native, readResult());
    assert.equal(native.status().safe_to_restart, true);
  } finally { await native.close(); }
});

test("recovery: multiple turns on one thread reconcile even when the target is not the latest turn", async (t) => {
  for (const mode of ["notifications", "thread/read"]) await t.test(mode, async () => {
    const { native, control } = setup();
    try {
      await start(native, "thread", "a"); await ack(native);
      await start(native, "thread", "b"); await ack(native, "futureState", "turn-b", "b");
      await notify(native, "turn/started", { threadId: "thread", turn: { id: "turn-a", status: "inProgress" } });
      await notify(native, "turn/completed", terminal());
      await notify(native, "turn/started", { threadId: "thread", turn: { id: "turn-b", status: "inProgress" } });
      await unsafe(native, control);
      if (mode === "notifications") {
        await notify(native, "turn/completed", terminal("thread", "turn-b"));
        await notify(native, "thread/status/changed", idle());
      } else {
        await read(native, { thread: { id: "thread", status: { type: "idle" }, turns: [
          { id: "turn-a", status: "completed" }, { id: "turn-b", status: "completed" },
        ] } });
      }
      assert.equal(native.status().native_mutation_outcome_unknown, false);
      assert.equal(native.status().safe_to_restart, true);
    } finally { await native.close(); }
  });
});

test("recovery: proof for a finished turn does not remove a different live active-turn guard", async () => {
  const { native, control } = setup();
  try {
    await start(native); await ack(native);
    await notify(native, "turn/started", { threadId: "thread", turn: { id: "other-active-turn", status: "inProgress" } });
    await read(native, readResult());
    assert.equal(native.status().native_mutation_outcome_unknown, false);
    assert.equal(native.runtime.observe("thread", 0, 100)!.active_turn_id, "other-active-turn");
    assert.equal(native.status().safe_to_restart, false);
    await assert.rejects(control.call("codex_runtime", { action: "restart" }), /RESTART_DENIED.*active_turns/);
  } finally { await native.close(); }
});

test("recovery: later same-ID inProgress confirms acceptance while keeping restart denied", async () => {
  const { native, control } = setup();
  try {
    await start(native); await ack(native); await unsafe(native, control);
    await ack(native, "inProgress");
    assert.equal(native.status().native_mutation_outcome_unknown, false);
    assert.equal(native.runtime.observe("thread", 0, 100)!.active_turn_id, "turn-a");
    assert.equal(native.status().safe_to_restart, false);
    await assert.rejects(control.call("codex_runtime", { action: "restart" }), /RESTART_DENIED.*active_turns/);
    await notify(native, "turn/completed", terminal());
    await notify(native, "thread/status/changed", idle());
    assert.equal(native.status().safe_to_restart, true);
  } finally { await native.close(); }
});
