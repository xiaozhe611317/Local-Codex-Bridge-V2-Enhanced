import { sanitizeForTransport, type RuntimeEvent } from "./runtime.js";

export interface DeltaSummary {
  changes: unknown[];
  commands: unknown[];
  validation: unknown[];
  pending: unknown[];
  unresolved: unknown[];
  next: unknown[];
}
export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function short(value: unknown, limit = 200): string | undefined {
  return typeof value === "string" ? String(sanitizeForTransport(value, { maxStringChars: limit, totalCharBudget: limit + 100 })) : undefined;
}
export function requestReference(value: unknown): Record<string, unknown> {
  const request = object(value);
  const id = request.request_id;
  return {
    ...(typeof id === "number" || (typeof id === "string" && id.length <= 200) ? { request_id: id } : {}),
    method: short(request.method, 300) ?? null,
    thread_id: short(request.thread_id) ?? null,
    turn_id: short(request.turn_id) ?? null,
  };
}

export function deltaSummary(
  events: readonly RuntimeEvent[],
  pending: unknown[],
  unresolved: unknown[],
  next: unknown[],
  statusChange?: unknown,
): DeltaSummary {
  const result: DeltaSummary = { changes: [], commands: [], validation: [], pending, unresolved, next };
  if (statusChange !== undefined) result.changes.push(statusChange);
  for (const event of events) {
    const data = object(event.data);
    const item = object(data.item);
    if (item.type === "commandExecution" || event.method === "item/commandExecution/outputDelta") {
      result.commands.push({
        cursor: event.cursor, source: event.method,
        item_id: short(item.id ?? data.itemId) ?? null,
        command: short(item.command) ?? null,
        status: short(item.status) ?? null,
        output_excerpt: short(data.delta ?? item.aggregatedOutput, 160) ?? null,
      });
      if (event.method === "item/completed" && typeof item.exitCode === "number") {
        result.validation.push({
          source: event.method, item_id: short(item.id) ?? null,
          kind: "reported_command_exit", exit_code: item.exitCode,
        });
      }
    } else if (item.type === "fileChange") {
      result.changes.push({
        cursor: event.cursor, source: event.method, kind: "native_file_change",
        status: short(item.status) ?? null,
        paths: Array.isArray(item.changes) ? item.changes.slice(0, 3).map(change => short(object(change).path) ?? null) : [],
      });
    } else if (event.method === "turn/started" || event.method === "turn/completed" || event.method === "thread/status/changed") {
      result.changes.push({ cursor: event.cursor, source: event.method,
        turn_id: event.turn_id ?? null, status: short(object(data.turn).status ?? object(data.status).type ?? data.status) ?? null });
    } else if (event.method === "warning" || event.method === "error") {
      result.unresolved.push({ cursor: event.cursor, source: event.method, message: short(data.message ?? object(data.error).message) ?? null });
    }
  }
  for (const key of Object.keys(result) as Array<keyof DeltaSummary>) result[key] = result[key].slice(0, 8);
  return result;
}
