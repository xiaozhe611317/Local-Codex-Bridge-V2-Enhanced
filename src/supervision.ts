import type { RuntimeObservation } from "./runtime.js";

// Exact notification names only: unfamiliar events and all server requests stay visible.
const SUPPRESSED_METHODS = new Set([
  "item/agentMessage/delta",
  "thread/tokenUsage/updated",
]);

export function supervisionObservation(snapshot: RuntimeObservation): RuntimeObservation & {
  mode: "supervision";
  suppressed_events: { count: number; by_method: Record<string, number>; scope: "consumed_page" };
} {
  const byMethod: Record<string, number> = {};
  const events = snapshot.events.filter((event) => {
    // Requests carry request_id, including native numeric id 0.
    const data = event.data;
    if (!SUPPRESSED_METHODS.has(event.method) ||
        (data !== null && typeof data === "object" && Object.hasOwn(data, "request_id"))) return true;
    byMethod[event.method] = (byMethod[event.method] ?? 0) + 1;
    return false;
  });
  return {
    ...snapshot,
    events,
    mode: "supervision",
    suppressed_events: {
      count: snapshot.events.length - events.length,
      by_method: byMethod,
      scope: "consumed_page",
    },
  };
}
