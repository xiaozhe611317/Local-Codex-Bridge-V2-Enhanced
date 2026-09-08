import { readFileSync } from "node:fs";

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
