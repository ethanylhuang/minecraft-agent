import type { ToolCall } from "./tools/schema.js";

export type SmokeProfile = "early" | "full";

export type PrimitiveSmokeStep = {
  name: string;
  call: ToolCall;
};

const earlySteps: PrimitiveSmokeStep[] = [
  { name: "observe state", call: { tool: "observe", args: {} } },
  { name: "wait for world ticks", call: { tool: "wait", args: { ticks: 20 } } },
  { name: "move near logs", call: { tool: "go_to_nearest_block", args: { block: "log", maxDistance: 128 } } },
  { name: "mine logs", call: { tool: "mine_block", args: { block: "log", count: 3, maxDistance: 128 } } },
  { name: "collect drops", call: { tool: "wait", args: { ticks: 80 } } },
  { name: "craft planks", call: { tool: "craft_item", args: { item: "planks", count: 12 } } },
  { name: "craft sticks", call: { tool: "craft_item", args: { item: "stick", count: 4 } } },
  { name: "craft table", call: { tool: "craft_item", args: { item: "crafting_table", count: 1 } } },
  { name: "place table", call: { tool: "place_block", args: { item: "crafting_table", maxDistance: 4 } } },
  { name: "craft wooden pickaxe", call: { tool: "craft_item", args: { item: "wooden_pickaxe", count: 1 } } },
  { name: "equip wooden pickaxe", call: { tool: "equip_item", args: { item: "wooden_pickaxe" } } },
];

const fullOnlySteps: PrimitiveSmokeStep[] = [
  { name: "mine stone", call: { tool: "mine_block", args: { block: "stone", count: 12, maxDistance: 128 } } },
  { name: "collect cobblestone", call: { tool: "wait", args: { ticks: 80 } } },
  { name: "craft furnace", call: { tool: "craft_item", args: { item: "furnace", count: 1 } } },
  { name: "place furnace", call: { tool: "place_block", args: { item: "furnace", maxDistance: 4 } } },
  { name: "smelt cobblestone", call: { tool: "smelt_item", args: { input: "cobblestone", fuel: "planks", count: 1, maxDistance: 8 } } },
  { name: "eat food", call: { tool: "eat_food", args: {} } },
];

const stopStep: PrimitiveSmokeStep = {
  name: "stop smoke run",
  call: { tool: "stop", args: { reason: "primitive smoke complete" } },
};

export function smokeSteps(profile: SmokeProfile): PrimitiveSmokeStep[] {
  return profile === "full"
    ? [...earlySteps, ...fullOnlySteps, stopStep]
    : [...earlySteps, stopStep];
}
