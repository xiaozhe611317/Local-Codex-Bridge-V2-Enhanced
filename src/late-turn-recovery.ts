// Bounded facts attached to one existing late-response correlation, not a
// second thread/job registry. Native payloads are validated without coercion.
import { consistentNativeScope, id, idleStatus, nativeTurnReferences, object, responseTurn, terminalStatus, type TerminalStatus } from "./native-evidence.js";
export { responseTurn } from "./native-evidence.js";
export interface LateTurnEvidence {
  turnId: string;
  boundSequence: number;
  lastSequence: number;
  terminal: TerminalStatus | null;
  idle: boolean;
}
export function observeRecoveryNotification(
  evidence: LateTurnEvidence, threadId: string, method: string, params: unknown, sequence: number,
): void {
  const data = object(params);
  if (data?.threadId !== threadId) {
    // Contradictory scope may invalidate an older read, never prove recovery.
    if (nativeTurnReferences(data).includes(evidence.turnId)) {
      evidence.lastSequence = sequence;
      evidence.idle = false;
    }
    return;
  }
  evidence.lastSequence = sequence;
  if (!consistentNativeScope(data, { threadId })) {
    evidence.idle = false;
    if (method === "turn/started" || method === "turn/completed") evidence.terminal = null;
    return;
  }
  if (method === "turn/started") {
    const startedId = id(object(data.turn)?.id ?? data.turnId);
    if (!startedId || startedId === evidence.turnId) evidence.terminal = null;
    evidence.idle = false;
  } else if (method === "thread/status/changed") {
    evidence.idle = idleStatus(data.status);
  } else if (method === "turn/completed") {
    const turn = object(data.turn);
    if (turn?.id === evidence.turnId) {
      const scoped = responseTurn(data, threadId, evidence.turnId);
      evidence.terminal = scoped && terminalStatus(scoped.status) ? scoped.status : null;
    }
  }
}
export function terminalThreadRead(value: unknown, threadId: string, turnId: string): boolean {
  const result = object(value);
  if (!result || !consistentNativeScope(result, { threadId, turnId })) return false;
  const thread = object(result.thread);
  if (thread?.id !== threadId || !idleStatus(thread.status) || !Array.isArray(thread.turns) ||
      thread.turns.length === 0 || thread.turns.length > 1000) return false;
  const ids = new Set<string>();
  for (const value of thread.turns) {
    const turn = object(value);
    const turnId = id(turn?.id);
    if (!turn || !turnId || ids.has(turnId) || !terminalStatus(turn.status) ||
        !consistentNativeScope({ turn }, { threadId, turnId })) return false;
    ids.add(turnId);
  }
  return ids.has(turnId);
}
