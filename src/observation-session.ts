import { createHash } from "node:crypto";
import { sanitizeForTransport } from "./runtime.js";

export const AUTO_THREAD_LIMIT = 128;
export const AUTO_PENDING_LIMIT = 128;

export interface ObservationState {
  generation: number;
  cursor: number;
  pending: Map<string, Record<string, unknown>>;
  terminalStamp: string | null;
  statusStamp: string | null;
  diagnosticCursor: number;
  connectionDiagnosticCursor: number;
  anomalies: string[];
}
export interface ConnectionDiagnostic {
  sequence: number;
  source: "mcp_error_response";
  code: "protocol_error";
  data: unknown;
}
export interface ObservationLease {
  state: ObservationState;
  generationChanged: boolean;
  cursorUnavailable: boolean;
  commit(next: ObservationState): void;
  release(): void;
}
export interface ObservationDelivery {
  commit(): void;
  rollback(): void;
}
export interface ControlCallContext {
  observationSession?: ObservationSession;
  deferObservation?: (delivery: ObservationDelivery) => void;
}

export function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value) ?? "undefined").digest("hex");
}

function fresh(generation: number): ObservationState {
  return { generation, cursor: 0, pending: new Map(), terminalStamp: null, statusStamp: null,
    diagnosticCursor: 0, connectionDiagnosticCursor: 0, anomalies: [] };
}

// One connection's bounded delivery metadata. No event/transcript/job storage.
export class ObservationSession {
  readonly #states = new Map<string, ObservationState>();
  readonly #busy = new Set<string>();
  readonly #diagnostics: ConnectionDiagnostic[] = [];
  #diagnosticSequence = 0;
  #evicted = false;
  #epoch = 0;

  constructor(private readonly limit = AUTO_THREAD_LIMIT) {
    if (!Number.isInteger(limit) || limit < 1 || limit > AUTO_THREAD_LIMIT) throw new Error("Invalid auto cursor session limit");
  }

  acquire(threadId: string, generation: number): ObservationLease {
    if (this.#busy.has(threadId)) throw new Error("OBSERVE_IN_PROGRESS: automatic observation already active for this connection/thread");
    const previous = this.#states.get(threadId);
    if (!previous && this.#states.size >= this.limit) {
      const oldest = [...this.#states.keys()].find(id => !this.#busy.has(id));
      if (oldest === undefined) throw new Error("OBSERVE_CAPACITY: all bounded connection cursors are in use");
      this.#states.delete(oldest);
      this.#evicted = true;
    }
    const generationChanged = previous !== undefined && previous.generation !== generation;
    const state = previous && !generationChanged
      ? { ...previous, pending: new Map(previous.pending), anomalies: [...previous.anomalies] }
      : { ...fresh(generation),
          diagnosticCursor: previous?.diagnosticCursor ?? 0,
          connectionDiagnosticCursor: previous?.connectionDiagnosticCursor ?? 0 };
    this.#busy.add(threadId);
    this.#states.delete(threadId);
    // Reserve the slot, but never consume evidence until delivery commits.
    this.#states.set(threadId, previous ?? fresh(generation));
    const epoch = this.#epoch;
    let finished = false;
    const release = (): void => {
      if (finished) return;
      finished = true;
      if (epoch === this.#epoch) this.#busy.delete(threadId);
    };
    return {
      state,
      generationChanged,
      cursorUnavailable: previous === undefined && this.#evicted,
      commit: next => {
        if (!finished && epoch === this.#epoch) this.#states.set(threadId, next);
        release();
      },
      release,
    };
  }

  recordProtocolError(code: number, message: string): void {
    this.#diagnosticSequence += 1;
    this.#diagnostics.push({
      sequence: this.#diagnosticSequence, source: "mcp_error_response", code: "protocol_error",
      data: sanitizeForTransport({ code, message }, { maxStringChars: 500, totalCharBudget: 1000 }),
    });
    if (this.#diagnostics.length > 32) this.#diagnostics.shift();
  }

  diagnosticsAfter(cursor: number): ConnectionDiagnostic[] {
    return this.#diagnostics.filter(item => item.sequence > cursor);
  }

  clear(): void {
    this.#epoch += 1;
    this.#states.clear();
    this.#busy.clear();
    this.#diagnostics.length = 0;
  }
}
