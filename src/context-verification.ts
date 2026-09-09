import { sanitizeForTransport } from "./runtime.js";
import type { PlatformPolicy } from "./platform.js";

type Fields = "cwd" | "sandbox" | "approval_policy" | "model" | "effort";
interface Verification {
  verified: boolean;
  value: unknown;
  source: string | null;
  status: "available" | "unknown";
}
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
const unknown = (): Verification => ({ verified: false, value: null, source: null, status: "unknown" });

// These are readbacks from thread/start or thread/resume, not proof that turn
// overrides were applied. turn/start currently returns a Turn without settings.
export function contextVerification(requested: Record<string, unknown>, response: unknown, method: string, platform: PlatformPolicy) {
  const native = object(response);
  const fields: Fields[] = ["cwd", "sandbox", "approval_policy", "model", "effort"];
  const keys: Record<Fields, string> = { cwd: "cwd", sandbox: "sandbox", approval_policy: "approvalPolicy", model: "model", effort: "reasoningEffort" };
  const threadContext = {} as Record<Fields, Verification>;
  const effective = {} as Record<Fields, Verification>;
  for (const field of fields) {
    const key = keys[field];
    const value = native[key];
    let usable = typeof value === "string" && value.trim().length > 0 && value.length <= (field === "cwd" ? 1000 : 100);
    if (field === "cwd" && usable) {
      try { platform.validateCwd(value as string); }
      catch { usable = false; }
    }
    if (field === "sandbox") {
      const type = object(value).type;
      usable = typeof type === "string" && ["readOnly", "workspaceWrite", "dangerFullAccess"].includes(type);
    }
    if (field === "approval_policy") usable = typeof value === "string" && ["untrusted", "on-request", "never"].includes(value);
    threadContext[field] = usable
      ? { verified: true, value: sanitizeForTransport(value), source: method + "." + key, status: "available" }
      : unknown();
    effective[field] = unknown();
  }
  return {
    requested: sanitizeForTransport(requested),
    native_thread_context: { scope: "before_turn_start", fields: threadContext },
    effective: { scope: "accepted_turn", fields: effective },
    verification_note: "turn/start provides no authoritative context readback in the supported protocol. Thread settings above are evidence only at thread/start or thread/resume; requested values and acceptance do not verify turn overrides.",
  };
}
