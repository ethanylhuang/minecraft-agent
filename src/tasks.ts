import { countInventory } from "./inventory.js";
import type { SymbolicObservation, TaskName, TaskScore } from "./types.js";

export const TASKS: TaskName[] = [
  "early_sequence",
  "collect_logs",
  "craft_planks",
  "craft_sticks",
  "craft_crafting_table",
  "craft_wooden_pickaxe",
  "mine_cobblestone",
  "craft_stone_pickaxe",
  "place_furnace",
  "smelt_iron_ingot",
];

export function scoreTask(task: TaskName, observation: SymbolicObservation): TaskScore {
  switch (task) {
    case "early_sequence": {
      const checks = {
        logs: countInventory(observation.inventory, "log") >= 3,
        planks: countInventory(observation.inventory, "planks") >= 1,
        sticks: countInventory(observation.inventory, "stick") >= 2,
        craftingTable: countInventory(observation.inventory, "crafting_table") >= 1
          || observation.nearbyBlocks.some((block) => block.name === "crafting_table"),
        woodenPickaxe: countInventory(observation.inventory, "wooden_pickaxe") >= 1,
      };
      const completeCount = Object.values(checks).filter(Boolean).length;
      return {
        task,
        complete: completeCount === Object.keys(checks).length,
        score: completeCount / Object.keys(checks).length,
        evidence: checks,
      };
    }
    case "collect_logs":
      return inventoryScore(task, observation, "log", 3);
    case "craft_planks":
      return inventoryScore(task, observation, "planks", 4);
    case "craft_sticks":
      return inventoryScore(task, observation, "stick", 4);
    case "craft_crafting_table":
      return inventoryScore(task, observation, "crafting_table", 1);
    case "craft_wooden_pickaxe":
      return inventoryScore(task, observation, "wooden_pickaxe", 1);
    case "mine_cobblestone":
      return inventoryScore(task, observation, "cobblestone", 1);
    case "craft_stone_pickaxe":
      return inventoryScore(task, observation, "stone_pickaxe", 1);
    case "place_furnace": {
      const placed = observation.nearbyBlocks.some((block) => block.name === "furnace");
      return { task, complete: placed, score: placed ? 1 : 0, evidence: { placed } };
    }
    case "smelt_iron_ingot":
      return inventoryScore(task, observation, "iron_ingot", 1);
  }
}

function inventoryScore(
  task: TaskName,
  observation: SymbolicObservation,
  item: string,
  required: number,
): TaskScore {
  const count = countInventory(observation.inventory, item);
  return {
    task,
    complete: count >= required,
    score: Math.min(1, count / required),
    evidence: { item, count, required },
  };
}
