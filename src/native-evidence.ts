// Validate only native identity/status fields at the transport boundary.
// Redundant identities must agree; absent fields never become proof by coercion.
export function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
export function id(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 200 ? value : undefined;
}
export type TerminalStatus = "completed" | "failed" | "interrupted";
export function terminalStatus(value: unknown): value is TerminalStatus {
  return value === "completed" || value === "failed" || value === "interrupted";
}
// These references are routing candidates only, never evidence of completion.
// The fixed set also lets rejected contradictory scopes use known live owners.
export function nativeTurnReferences(value: unknown): string[] {
  const data = object(value);
  const turn = object(data?.turn);
  return [data?.turnId, turn?.id, turn?.turnId, object(data?.item)?.turnId, object(data?.thread)?.turnId]
    .map(id).filter((value): value is string => value !== undefined);
}

export function nativeThreadReferences(value: unknown): string[] {
  const data = object(value);
  return [data?.threadId, data?.conversationId, object(data?.thread)?.id,
    ...["thread", "turn", "item"].flatMap(key => {
      const record = object(data?.[key]);
      return [record?.threadId, record?.conversationId];
    })].map(id).filter((value): value is string => value !== undefined);
}

interface NativeScope { threadId?: string; turnId?: string; }
export function consistentNativeScope(value: unknown, expected: NativeScope = {}): boolean {
  const data = object(value);
  if (!data) return false;
  let threadId = expected.threadId;
  let turnId = expected.turnId;
  if ((threadId !== undefined && !id(threadId)) || (turnId !== undefined && !id(turnId))) return false;
  const records: Array<[Record<string, unknown>, string | undefined]> = [[data, undefined]];
  for (const key of ["thread", "turn", "item"]) {
    if (!Object.hasOwn(data, key)) continue;
    const nested = object(data[key]);
    if (!nested) return false;
    records.push([nested, key]);
  }
  for (const [record, kind] of records) {
    for (const key of ["threadId", "conversationId", ...(kind === "thread" ? ["id"] : [])]) {
      if (!Object.hasOwn(record, key)) continue;
      const value = id(record[key]);
      if (!value || (threadId !== undefined && value !== threadId)) return false;
      threadId = value;
    }
    for (const key of ["turnId", ...(kind === "turn" ? ["id"] : [])]) {
      if (!Object.hasOwn(record, key)) continue;
      const value = id(record[key]);
      if (!value || (turnId !== undefined && value !== turnId)) return false;
      turnId = value;
    }
  }
  return true;
}
const THREAD_STATUSES = new Set(["idle", "active", "inProgress", "notLoaded", "completed", "failed", "interrupted"]);
export function nativeThreadStatus(value: unknown): string | undefined {
  if (typeof value === "string") return THREAD_STATUSES.has(value) ? value : undefined;
  const status = object(value);
  if (!status || typeof status.type !== "string" || !THREAD_STATUSES.has(status.type)) return undefined;
  if (status.type === "active") {
    if (Object.keys(status).some(key => key !== "type" && key !== "activeFlags")) return undefined;
    if (Object.hasOwn(status, "activeFlags") && (!Array.isArray(status.activeFlags) ||
        status.activeFlags.length > 32 || status.activeFlags.some(flag => typeof flag !== "string"))) return undefined;
  } else if (Object.keys(status).length !== 1) return undefined;
  return status.type;
}
export function idleStatus(value: unknown): boolean {
  return nativeThreadStatus(value) === "idle";
}
export function responseTurn(value: unknown, threadId: string, boundTurnId?: string): (Record<string, unknown> & { id: string }) | undefined {
  const result = object(value);
  const turn = object(result?.turn);
  const turnId = id(turn?.id);
  if (!result || !turn || !turnId || (boundTurnId !== undefined && boundTurnId !== turnId) ||
      !consistentNativeScope(result, { threadId, turnId })) return undefined;
  return turn as Record<string, unknown> & { id: string };
}

export function consistentNativeAcknowledgement(value: unknown, expected: NativeScope, kind: "thread" | "turn"): boolean {
  if (!consistentNativeScope(value, expected)) return false;
  const data = object(value)!;
  const statusOf = (status: unknown, type: "thread" | "turn"): string | undefined =>
    type === "thread" ? nativeThreadStatus(status) : status === "inProgress" || terminalStatus(status) ? status : undefined;
  for (const [record, type] of [[data, kind], [object(data.thread), "thread"], [object(data.turn), "turn"]] as const) {
    if (record && Object.hasOwn(record, "status") && statusOf(record.status, type) === undefined) return false;
  }
  const nested = object(data[kind]);
  return !Object.hasOwn(data, "status") || !nested || !Object.hasOwn(nested, "status") ||
    statusOf(data.status, kind) === statusOf(nested.status, kind);
}
