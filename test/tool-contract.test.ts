import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { TOOL_DEFINITIONS } from "../src/tools.js";

test("all eight original MCP contracts are unchanged except the explicit turn/observe extensions", () => {
  const baseline = JSON.parse(readFileSync(new URL("../../test/tool-contract-v213.json", import.meta.url), "utf8")) as Array<Record<string, unknown>>;
  assert.equal(baseline.length, 8);
  const current = structuredClone(TOOL_DEFINITIONS).filter(t => !["bridge_status", "codex_runtime"].includes(t.name));
  assert.equal(current.length, 8);
  for (const tool of current) {
    const original = baseline.find(t => t.name === tool.name)!;
    const props = tool.inputSchema.properties as Record<string, unknown>;
    if (tool.name === "codex_turn") {
      tool.description = original.description as string;
      delete props.project_alias;
      delete tool.inputSchema.not;
      tool.inputSchema.anyOf = [{ required: ["thread_id"] }, { required: ["cwd"] }];
      const originalSchema = original.inputSchema as Record<string, unknown>;
      const originalProps = originalSchema.properties as Record<string, unknown>;
      props.cwd = originalProps.cwd;
    }
    if (tool.name === "codex_observe") {
      delete props.mode;
      tool.description = original.description as string;
      props.cursor = ((original.inputSchema as Record<string, unknown>).properties as Record<string, unknown>).cursor;
    }
    if (tool.name === "codex_checkpoint") tool.description = original.description as string;
    assert.deepEqual(tool, original, tool.name);
  }
});
