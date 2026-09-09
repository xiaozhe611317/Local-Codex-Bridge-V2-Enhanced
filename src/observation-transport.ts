import type { AppServerStatus } from "./app-server.js";
import { sanitizeForTransport, type RuntimeDiagnostic, type RuntimeEvent, type RuntimeObservation } from "./runtime.js";
import { AUTO_PENDING_LIMIT, fingerprint, type ConnectionDiagnostic, type ObservationState } from "./observation-session.js";
import { deltaSummary, object, requestReference, short } from "./observation-summary.js";
import { supervisionObservation } from "./supervision.js";

export type ObserveMode = "auto" | "supervision" | "raw";
interface Anomaly { code: string; key: string; turn_id?: string; item_id?: string; cursor?: number; }
export interface AutomaticObservationInput {
  snapshot: RuntimeObservation | null;
  previous: ObservationState;
  mode: ObserveMode;
  generation: number;
  generationChanged: boolean;
  cursorUnavailable: boolean;
  runtimeDiagnostics: RuntimeDiagnostic[];
  connectionDiagnostics: ConnectionDiagnostic[];
  recentEvents: RuntimeEvent[];
  supportedRequests: ReadonlySet<string>;
  appServerStatus?: AppServerStatus;
}
const KNOWN_STATES = new Set(["idle", "active", "inProgress", "notLoaded", "completed", "failed", "interrupted", "appServerExited"]);
const REANCHOR_CODES = new Set(["cursor_lost", "runtime_generation_changed", "connection_cursor_unavailable",
  "live_unreconstructable", "turn_terminal_conflict", "app_server_unavailable", "app_server_unexpected_exit", "restart_failure", "mutation_outcome_unknown", "pending_state_limit"]);

function boundedRaw(events: RuntimeEvent[]): unknown[] {
  const evidence: unknown[] = [];
  let budget = 6000;
  for (const event of events.slice(-6)) {
    const entry = { cursor: event.cursor, at: event.at, method: short(event.method, 300),
      turn_id: event.turn_id ?? null,
      data: sanitizeForTransport(event.data, { maxStringChars: 800, maxDepth: 5, maxArrayItems: 6, maxObjectKeys: 16, totalCharBudget: 1600 }) };
    const size = JSON.stringify(entry).length;
    if (size <= budget) { evidence.push(entry); budget -= size; }
  }
  return evidence;
}

function compactCompletion(snapshot: RuntimeObservation, terminalChanged: boolean): RuntimeObservation {
  return {
    ...snapshot,
    events: snapshot.events.map(event => {
      const data = object(event.data);
      const turn = object(data.turn);
      const item = object(data.item);
      if (event.method === "turn/completed" && Object.hasOwn(turn, "items")) {
        const { items: _items, ...fields } = turn;
        return { ...event, data: { ...data, turn: { ...fields, items_omitted: true } } };
      }
      if (snapshot.terminal !== null && event.method === "item/completed" && item.type === "agentMessage" &&
          event.turn_id === snapshot.terminal?.turn_id && item.text === snapshot.terminal.final_result) {
        const { text: _text, ...fields } = item;
        return { ...event, data: { ...data, item: { ...fields,
          text_ref: terminalChanged ? "terminal.final_result" : "previously_delivered_terminal.final_result" } } };
      }
      return event;
    }),
  };
}

export function automaticObservation(input: AutomaticObservationInput): { result: Record<string, unknown>; state: ObservationState } {
  const { snapshot, mode } = input;
  const previous = input.generationChanged ? { ...input.previous, cursor: 0,
    pending: new Map<string, Record<string, unknown>>(), terminalStamp: null, statusStamp: null, anomalies: [] } : input.previous;
  const anomalies: Anomaly[] = [];
  const add = (code: string, key = code, turnId?: string, itemId?: string, cursor?: number): void => {
    anomalies.push({ code, key, ...(turnId ? { turn_id: turnId } : {}),
      ...(itemId ? { item_id: itemId } : {}), ...(cursor === undefined ? {} : { cursor }) });
  };
  if (!snapshot) add("live_unreconstructable");
  if (input.appServerStatus?.native_mutation_outcome_unknown) add("mutation_outcome_unknown", "native-unknown-outcome");
  if (input.appServerStatus && ["unavailable", "exited"].includes(input.appServerStatus.state)) add("app_server_unavailable");
  if (input.generationChanged || (previous.cursor === 0 && input.generation > 0)) add("runtime_generation_changed", "generation:" + input.generation);
  if (input.cursorUnavailable) add("connection_cursor_unavailable");
  if (snapshot?.cursor_lost) add("cursor_lost", "floor:" + snapshot.cursor_floor);
  if (snapshot && !KNOWN_STATES.has(snapshot.runtime_status)) add("unknown_state", "state:" + snapshot.runtime_status);
  if (snapshot?.runtime_status === "appServerExited") add("app_server_unexpected_exit");
  if (snapshot?.terminal && (snapshot.active_turn_id !== null || ["active", "inProgress"].includes(snapshot.runtime_status))) {
    add("turn_terminal_conflict", "terminal:" + snapshot.terminal.turn_id, snapshot.terminal.turn_id);
  }
  const allPending = snapshot?.pending_requests ?? [];
  if (allPending.length > AUTO_PENDING_LIMIT) add("pending_state_limit");
  const nextPending = new Map<string, Record<string, unknown>>();
  const newPending: unknown[] = [];
  const pendingChanges: unknown[] = [];
  for (const request of allPending.slice(0, AUTO_PENDING_LIMIT)) {
    const ref = requestReference(request);
    const key = fingerprint([object(request).request_id, ref.method, ref.thread_id, ref.turn_id]);
    nextPending.set(key, ref);
    if (!previous.pending.has(key)) {
      newPending.push(request);
      pendingChanges.push({ ...ref, status: "pending" });
    }
    if (typeof object(request).method !== "string" || !input.supportedRequests.has(object(request).method as string)) {
      add("unknown_pending_request", "pending:" + key);
    }
  }
  for (const [key, ref] of previous.pending) {
    if (!nextPending.has(key)) pendingChanges.push({ ...ref, status: "no_longer_pending" });
  }
  const consumed = snapshot?.events ?? [];
  for (const event of consumed) {
    const item = object(object(event.data).item);
    if (event.method === "item/completed" && item.type === "commandExecution" && typeof item.exitCode === "number" && item.exitCode !== 0) {
      const output = typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : "";
      if (!output.trim() || output.length > 160 || output.includes("[truncated")) {
        add("command_failure_summary_incomplete", "command:" + event.cursor, event.turn_id, typeof item.id === "string" ? item.id : undefined, event.cursor);
      }
    }
  }
  for (const item of input.runtimeDiagnostics) add(item.code, "runtime:" + item.sequence, item.turn_id);
  for (const item of input.connectionDiagnostics) add(item.code, "connection:" + item.sequence);
  const newAnomalies = anomalies.filter(item => !previous.anomalies.includes(item.key));
  const codes = [...new Set(anomalies.map(item => item.code))];
  const reanchor = codes.filter(code => REANCHOR_CODES.has(code));
  const diagnostic = mode === "auto" && anomalies.length > 0;
  const terminalStamp = snapshot?.terminal ? fingerprint([snapshot.terminal.turn_id, snapshot.terminal.status, snapshot.terminal.completed_at]) : null;
  const statusStamp = snapshot ? fingerprint([snapshot.runtime_status, snapshot.active_turn_id]) : null;
  const terminalChanged = terminalStamp !== previous.terminalStamp;
  const projected = snapshot ? (mode === "raw" ? snapshot : compactCompletion(supervisionObservation(snapshot), terminalChanged)) : null;
  const terminalDelta = terminalChanged && snapshot?.terminal
    ? (mode === "raw" ? snapshot.terminal : { ...snapshot.terminal, turn: null, turn_payload_omitted: true })
    : null;
  const next: unknown[] = reanchor.length
    ? [{ action: "re_anchor", sources: ["codex_checkpoint.read_if_used", "codex_threads.read"] }]
    : allPending.length ? [{ action: "inspect_pending_requests" }]
    : newAnomalies.length ? [{ action: "inspect_local_evidence" }]
    : snapshot?.has_more ? [{ action: "observe_remaining_delta" }] : [];
  const candidates = [...new Map([...input.recentEvents, ...consumed].map(event => [event.cursor, event])).values()].sort((a, b) => a.cursor - b.cursor);
  const rawAnomalies = newAnomalies.filter(item => ["cursor_lost", "unknown_state", "unknown_pending_request",
    "turn_terminal_conflict", "command_failure_summary_incomplete", "app_server_unexpected_exit"].includes(item.code));
  const relevantRaw = candidates.filter(event => {
    if (!rawAnomalies.length && !input.runtimeDiagnostics.some(item => item.thread_id && ["mutation_outcome_unknown", "turn_terminal_conflict"].includes(item.code))) return false;
    if (rawAnomalies.length && rawAnomalies.every(item => item.code === "command_failure_summary_incomplete")) {
      const eventData = object(event.data);
      const id = object(eventData.item).id ?? eventData.itemId;
      if (!rawAnomalies.some(item => item.cursor === event.cursor || (item.item_id && item.item_id === id))) return false;
    }
    if (event.cursor > (snapshot?.next_cursor ?? 0)) return false;
    if (["item/agentMessage/delta", "thread/tokenUsage/updated"].includes(event.method)) return false;
    const scoped = newAnomalies.map(item => item.turn_id).filter(Boolean);
    if (scoped.length && !newAnomalies.some(item => !item.turn_id)) return !!event.turn_id && scoped.includes(event.turn_id);
    return true;
  });
  const diagnostics = diagnostic ? {
    triggers: codes.slice(0, 12),
    raw_evidence: newAnomalies.length ? boundedRaw(relevantRaw) : [],
    runtime_evidence: sanitizeForTransport(input.runtimeDiagnostics.slice(-4), { maxStringChars: 500, totalCharBudget: 3000, maxArrayItems: 4 }),
    connection_evidence: input.connectionDiagnostics.slice(-4),
    authoritative_process_status: input.appServerStatus ? {
      state: input.appServerStatus.state,
      native_mutation_outcome_unknown: input.appServerStatus.native_mutation_outcome_unknown,
    } : null,
    scope: "related_recent_runtime_only",
    advances_event_cursor: false,
  } : null;
  const result: Record<string, unknown> = {
    ...(projected ?? {
      runtime_available: false, live_state_reconstructable: false, runtime_status: "not_reconstructable",
      active_turn_id: null, events: [], next_cursor: null, current_cursor: null,
      cursor_floor: null, cursor_lost: false, has_more: false,
      pending_requests: [], terminal: null,
      source: "bridge_runtime_unavailable",
    }),
    ...(mode === "raw" || snapshot ? {} : { suppressed_events: { count: 0, by_method: {}, scope: "consumed_page" } }),
    mode, effective_mode: mode === "raw" ? "raw" : diagnostic ? "diagnostic" : "supervision",
    cursor_control: "automatic",
    runtime_generation: input.generation,
    pending_requests: newPending,
    pending_request_count: allPending.length,
    pending_state_truncated: allPending.length > AUTO_PENDING_LIMIT,
    terminal: terminalDelta,
    terminal_unchanged: !!snapshot?.terminal && !terminalChanged,
    reanchor: { required: reanchor.length > 0, reasons: reanchor,
      note: reanchor.length ? "Re-anchor supervisor intent from the checkpoint if used and read native thread evidence. Bridge does not infer restored context." : null },
    diagnostics,
    delta_summary: deltaSummary(projected?.events ?? [], pendingChanges,
      newAnomalies.map(item => ({ code: item.code })), next,
      statusStamp !== previous.statusStamp && snapshot
        ? { source: "bridge_runtime", status: snapshot.runtime_status, active_turn_id: snapshot.active_turn_id } : undefined),
  };
  return {
    result,
    state: {
      generation: input.generation,
      cursor: snapshot ? Math.max(previous.cursor, snapshot.next_cursor) : previous.cursor,
      pending: nextPending, terminalStamp, statusStamp,
      diagnosticCursor: input.runtimeDiagnostics.at(-1)?.sequence ?? previous.diagnosticCursor,
      connectionDiagnosticCursor: input.connectionDiagnostics.at(-1)?.sequence ?? previous.connectionDiagnosticCursor,
      anomalies: anomalies.map(item => item.key).slice(-32),
    },
  };
}
