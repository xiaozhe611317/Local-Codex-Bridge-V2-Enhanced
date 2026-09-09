// Bounded facts attached to one existing late-response correlation, not a
// second thread/job registry. Native payloads are validated without coercion.
export type TerminalStatus = "completed" | "failed" | "interrupted";
export interface LateTurnEvidence {
  turnId: string;
  boundSequence: number;
  lastSequence: number;
  terminal: TerminalStatus | null;
  idle: boolean;
}
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function id(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 200 ? value : undefined;
}
export function terminalStatus(value: unknown): value is TerminalStatus {
  return value === "completed" || value === "failed" || value === "interrupted";
}
export function idleStatus(value: unknown): boolean {
  const status = object(value);
  return value === "idle" || (!!status && status.type === "idle" && Object.keys(status).length === 1);
}
export function responseTurn(value: unknown, threadId: string, boundTurnId?: string): Record<string, unknown> | undefined {
  const result = object(value);
  const turn = object(result?.turn);
  const turnId = id(turn?.id);
  if (!result || !turn || !turnId || (boundTurnId !== undefined && boundTurnId !== turnId)) return undefined;
  for (const record of [result, turn]) {
    if (Object.hasOwn(record, "threadId") && record.threadId !== threadId) return undefined;
    if (Object.hasOwn(record, "turnId") && record.turnId !== turnId) return undefined;
  }
  return turn;
}
export function observeRecoveryNotification(
  evidence: LateTurnEvidence, threadId: string, method: string, params: unknown, sequence: number,
): void {
  const data = object(params);
  if (data?.threadId !== threadId) return;
  evidence.lastSequence = sequence;
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
  if (!result || (Object.hasOwn(result, "threadId") && result.threadId !== threadId) ||
      (Object.hasOwn(result, "turnId") && result.turnId !== turnId)) return false;
  const thread = object(result.thread);
  if (thread?.id !== threadId || !idleStatus(thread.status) || !Array.isArray(thread.turns) ||
      thread.turns.length === 0 || thread.turns.length > 1000) return false;
  const ids = new Set<string>();
  for (const value of thread.turns) {
    const turn = object(value);
    const turnId = id(turn?.id);
    if (!turn || !turnId || ids.has(turnId) || !terminalStatus(turn.status) ||
        (Object.hasOwn(turn, "threadId") && turn.threadId !== threadId) ||
        (Object.hasOwn(turn, "turnId") && turn.turnId !== turnId)) return false;
    ids.add(turnId);
  }
  return ids.has(turnId);
}
