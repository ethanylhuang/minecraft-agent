import { describe, expect, it } from "vitest";
import { smokeSteps } from "../src/smokePlan.js";
import { TOOL_NAMES } from "../src/tools/schema.js";

describe("primitive smoke plan", () => {
  it("covers every primitive tool in the full local-server smoke pass", () => {
    const tools = new Set(smokeSteps("full").map((step) => step.call.tool));

    for (const tool of TOOL_NAMES) expect(tools.has(tool)).toBe(true);
  });

  it("keeps the early smoke profile focused on wooden-pickaxe setup", () => {
    const names = smokeSteps("early").map((step) => step.name);

    expect(names).toContain("mine logs");
    expect(names).toContain("craft wooden pickaxe");
    expect(names).not.toContain("smelt cobblestone");
  });
});
