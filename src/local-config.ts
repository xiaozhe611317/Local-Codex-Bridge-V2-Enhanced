import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { parseTargetingConfig, type TargetingConfig } from "./targeting.js";

// Project-only launch overrides. Never writes the user's global Codex config.
export function localCodexPrefixArgs(environment: NodeJS.ProcessEnv = process.env): string[] {
  const path = environment.LOCAL_CODEX_BRIDGE_CONFIG_OVERRIDES_FILE;
  if (!path) return [];
  const value: unknown = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  if (!Array.isArray(value) || value.length > 100 || value.some(v => typeof v !== "string" || !v.includes("=") || v.length > 1000)) {
    throw new Error("Invalid project Codex config overrides");
  }
  return value.flatMap(v => ["-c", v as string]);
}

export const LOCAL_SETTINGS_ENV = "LOCAL_CODEX_BRIDGE_LOCAL_SETTINGS_FILE";

// Explicit opt-in, including the existing ignored Windows local-settings.json.
// Consume only targeting; never project Tunnel or Codex configuration.
export function localTargetingConfig(environment: NodeJS.ProcessEnv = process.env): TargetingConfig {
  const file = environment[LOCAL_SETTINGS_ENV];
  if (file === undefined || file === "") return {};
  if (!isAbsolute(file)) throw new Error("Local settings file must be absolute");
  let value: unknown;
  try {
    const contents = readFileSync(file, "utf8");
    if (Buffer.byteLength(contents) > 128 * 1024) throw new Error("oversized");
    value = JSON.parse(contents.replace(/^\uFEFF/, ""));
  } catch {
    throw new Error("Unable to read a valid bounded local settings document");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Local settings must be an object");
  const targeting = (value as Record<string, unknown>).targeting;
  return targeting === undefined ? {} : parseTargetingConfig(targeting);
}
