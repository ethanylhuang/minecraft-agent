import minecraftData from "minecraft-data";
import { countInventory, itemCandidates, normalizeItemName } from "./inventory.js";
import type { ItemStack } from "./types.js";

type IndexedData = ReturnType<typeof minecraftData>;

export type RecipeIngredient = {
  name: string;
  count: number;
};

export type RecipePlan = {
  item: string;
  outputCount: number;
  craftsRequired: number;
  ingredients: RecipeIngredient[];
};

type RecipeLike = {
  result?: { id?: number; count?: number };
  ingredients?: unknown[];
  inShape?: unknown[][];
};

export function getMinecraftData(version = "1.20.4"): IndexedData {
  return minecraftData(version);
}

export function resolveItemName(data: IndexedData, query: string): string | undefined {
  for (const name of itemCandidates(query)) {
    if (data.itemsByName[name]) return name;
  }
  return undefined;
}

export function recipeLookup(
  data: IndexedData,
  query: string,
  inventory: ItemStack[] = [],
  count = 1,
): RecipePlan | undefined {
  const candidates = itemCandidates(query)
    .map((name) => data.itemsByName[name]?.name)
    .filter((name): name is string => Boolean(name));

  for (const itemName of candidates) {
    const item = data.itemsByName[itemName];
    const recipes = ((data.recipes as Record<number, RecipeLike[] | undefined>)[item.id] ?? []);

    for (const recipe of recipes) {
      const outputCount = Math.max(1, recipe.result?.count ?? 1);
      const craftsRequired = Math.max(1, Math.ceil(count / outputCount));
      const ingredients = recipeIngredients(data, recipe).map((ingredient) => ({
        ...ingredient,
        count: ingredient.count * craftsRequired,
      }));

      if (inventory.length === 0 || ingredients.every((ingredient) => (
        countInventory(inventory, ingredient.name) >= ingredient.count
      ))) {
        return { item: itemName, outputCount, craftsRequired, ingredients };
      }
    }
  }

  return undefined;
}

export function recipeIngredients(data: IndexedData, recipe: RecipeLike): RecipeIngredient[] {
  const counts = new Map<number, number>();

  function visit(value: unknown): void {
    if (value == null) return;
    if (typeof value === "number") {
      if (value > 0) counts.set(value, (counts.get(value) ?? 0) + 1);
      return;
    }
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    if (typeof value === "object" && "id" in value) {
      const id = Number((value as { id?: number }).id);
      if (id > 0) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }

  if (recipe.ingredients) visit(recipe.ingredients);
  if (recipe.inShape) visit(recipe.inShape);

  return [...counts.entries()]
    .map(([id, count]) => ({ name: data.items[id]?.name ?? `unknown_${id}`, count }))
    .sort((a, b) => normalizeItemName(a.name).localeCompare(normalizeItemName(b.name)));
}
