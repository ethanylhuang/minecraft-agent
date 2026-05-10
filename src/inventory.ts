import type { ItemStack } from "./types.js";

const LOGS = [
  "oak_log",
  "spruce_log",
  "birch_log",
  "jungle_log",
  "acacia_log",
  "dark_oak_log",
  "mangrove_log",
  "cherry_log",
  "crimson_stem",
  "warped_stem",
];

const PLANKS = [
  "oak_planks",
  "spruce_planks",
  "birch_planks",
  "jungle_planks",
  "acacia_planks",
  "dark_oak_planks",
  "mangrove_planks",
  "cherry_planks",
  "crimson_planks",
  "warped_planks",
];

const WOODEN_PICKAXES = [
  "wooden_pickaxe",
];

export const ITEM_ALIASES: Record<string, string[]> = {
  log: LOGS,
  logs: LOGS,
  plank: PLANKS,
  planks: PLANKS,
  wooden_pick: WOODEN_PICKAXES,
  wooden_pickaxe: WOODEN_PICKAXES,
};

export function normalizeItemName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/^minecraft:/, "")
    .replace(/[\s-]+/g, "_");
}

export function itemCandidates(query: string): string[] {
  const normalized = normalizeItemName(query);
  return [normalized, ...(ITEM_ALIASES[normalized] ?? [])].filter(
    (name, index, all) => all.indexOf(name) === index,
  );
}

export function isItemMatch(itemName: string, query: string): boolean {
  const item = normalizeItemName(itemName);
  return itemCandidates(query).includes(item);
}

export function countInventory(inventory: ItemStack[], query: string): number {
  return inventory
    .filter((item) => isItemMatch(item.name, query))
    .reduce((sum, item) => sum + item.count, 0);
}

export function hasInventory(inventory: ItemStack[], query: string, count = 1): boolean {
  return countInventory(inventory, query) >= count;
}

export function firstMatchingInventoryItem<T extends { name: string }>(
  items: T[],
  query: string,
): T | undefined {
  return items.find((item) => isItemMatch(item.name, query));
}
