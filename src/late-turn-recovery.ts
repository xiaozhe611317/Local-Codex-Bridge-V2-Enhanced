// Bounded facts attached to one existing late-response correlation, not a
// second thread/job registry. Native payloads are validated without coercion.
import { consistentNativeScope, id, idleStatus, nativeThreadReferences, nativeTurnReferences, object, responseTurn, terminalStatus, type TerminalStatus } from "./native-evidence.js";
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
  const threadReferences = nativeThreadReferences(data);
  if (!threadReferences.includes(threadId) && !nativeTurnReferences(data).includes(evidence.turnId)) return;
  evidence.lastSequence = sequence;
  // All supported aliases can invalidate freshness. Contradictory or missing
  // thread scope supplies no positive evidence, and invalidates the old pair.
  if (!threadReferences.includes(threadId) || !consistentNativeScope(data, { threadId })) {
    evidence.idle = false;
    evidence.terminal = null;
    return;
  }
  if (method === "turn/started") {
    const turn = responseTurn(data, threadId);
    if (!turn || turn.status !== "inProgress" || turn.id === evidence.turnId) evidence.terminal = null;
    evidence.idle = false;
  } else if (method === "thread/status/changed") {
    evidence.idle = idleStatus(data?.status);
  } else if (method === "turn/completed") {
    const turn = responseTurn(data, threadId);
    if (!turn || !terminalStatus(turn.status)) {
      evidence.terminal = null;
      evidence.idle = false;
    } else if (turn.id === evidence.turnId) evidence.terminal = turn.status;
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
