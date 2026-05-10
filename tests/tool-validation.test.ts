import { describe, expect, it } from "vitest";
import { validateToolCall } from "../src/tools/schema.js";

describe("tool-call validation", () => {
  it("accepts valid primitive calls and applies defaults", () => {
    const calls = [
      { tool: "observe", args: {} },
      { tool: "go_to_nearest_block", args: { block: "oak_log" } },
      { tool: "mine_block", args: { block: "oak_log" } },
      { tool: "craft_item", args: { item: "planks" } },
      { tool: "equip_item", args: { item: "wooden_pickaxe" } },
      { tool: "place_block", args: { item: "crafting_table" } },
      { tool: "smelt_item", args: { input: "raw_iron" } },
      { tool: "eat_food", args: {} },
      { tool: "wait", args: {} },
      { tool: "stop", args: {} },
    ];

    for (const call of calls) expect(validateToolCall(call).ok).toBe(true);

    const mined = validateToolCall({ tool: "mine_block", args: { block: "oak_log" } });
    expect(mined.ok).toBe(true);
    if (mined.ok) expect(mined.value.args).toEqual({ block: "oak_log", count: 1, maxDistance: 128 });
  });

  it("rejects malformed calls with structured errors", () => {
    const result = validateToolCall({ tool: "mine_block", args: { block: "", count: -1 } });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("invalid_tool_call");
      expect(result.error.retryable).toBe(true);
    }
  });
});
