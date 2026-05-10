import type { Bot } from "mineflayer";
import pathfinderPkg from "mineflayer-pathfinder";
import { Vec3 } from "vec3";
import { errorMessage, failedResult, okResult } from "../errors.js";
import { firstMatchingInventoryItem, itemCandidates } from "../inventory.js";
import { buildObservation } from "../observation.js";
import { recipeLookup } from "../recipes.js";
import type { ToolResult } from "../types.js";
import type { ToolCall } from "./schema.js";

const { goals } = pathfinderPkg;
const PATH_ATTEMPT_TIMEOUT_MS = 12_000;
type PathfinderGoal = InstanceType<typeof goals.Goal>;
type MineableBlock = NonNullable<ReturnType<Bot["blockAt"]>>;
type InventoryItem = ReturnType<Bot["inventory"]["items"]>[number];

type RunnerState = {
  stopRequested: boolean;
  lastActionResult?: ToolResult;
};

const FOOD_NAMES = [
  "apple",
  "bread",
  "cooked_beef",
  "cooked_porkchop",
  "cooked_chicken",
  "baked_potato",
  "carrot",
];

const HARVEST_TOOL_ORDER = [
  "netherite_pickaxe",
  "diamond_pickaxe",
  "iron_pickaxe",
  "stone_pickaxe",
  "wooden_pickaxe",
  "golden_pickaxe",
  "netherite_axe",
  "diamond_axe",
  "iron_axe",
  "stone_axe",
  "wooden_axe",
  "golden_axe",
  "netherite_shovel",
  "diamond_shovel",
  "iron_shovel",
  "stone_shovel",
  "wooden_shovel",
  "golden_shovel",
];

export async function executeTool(
  bot: Bot,
  call: ToolCall,
  state: RunnerState,
): Promise<ToolResult> {
  try {
    switch (call.tool) {
      case "observe":
        return okResult("Observed state.", buildObservation(bot, state.lastActionResult));
      case "go_to_nearest_block":
        return await goToNearestBlock(bot, call.args.block, call.args.maxDistance);
      case "mine_block":
        return await mineBlock(bot, call.args.block, call.args.count, call.args.maxDistance);
      case "craft_item":
        return await craftItem(bot, call.args.item, call.args.count);
      case "equip_item":
        return await equipItem(bot, call.args.item);
      case "place_block":
        return await placeBlock(bot, call.args.item, call.args.referenceBlock, call.args.maxDistance);
      case "smelt_item":
        return await smeltItem(bot, call.args.input, call.args.fuel, call.args.count, call.args.maxDistance);
      case "eat_food":
        return await eatFood(bot, call.args.food);
      case "wait":
        await bot.waitForTicks(call.args.ticks);
        return okResult(`Waited ${call.args.ticks} ticks.`);
      case "stop":
        state.stopRequested = true;
        return okResult(call.args.reason ?? "Stop requested.", { stopped: true });
    }
  } catch (error) {
    return failedResult("tool_exception", errorMessage(error), true);
  }
}

async function goToNearestBlock(bot: Bot, blockQuery: string, maxDistance: number): Promise<ToolResult> {
  const blocks = findMatchingBlocks(bot, blockQuery, maxDistance, 16);
  if (blocks.length === 0) return failedResult("block_not_found", `No ${blockQuery} found within ${maxDistance} blocks.`);

  let lastError: unknown;
  for (const block of blocks) {
    try {
      await gotoWithTimeout(bot, new goals.GoalNearXZ(block.position.x, block.position.z, 2));
      return okResult(`Moved near ${block.name}.`, { block: block.name, position: block.position });
    } catch (error) {
      lastError = error;
    }
  }

  return failedResult("pathing_failed", `Could not path to ${blockQuery}.`, true, {
    attempts: blocks.length,
    cause: errorMessage(lastError),
  });
}

async function mineBlock(
  bot: Bot,
  blockQuery: string,
  count: number,
  maxDistance: number,
): Promise<ToolResult> {
  const mined: string[] = [];
  const toolsUsed = new Set<string>();
  const dropQuery = expectedDropQuery(blockQuery);
  const initialDropCount = countInventoryFromBot(bot, dropQuery);
  let attempts = 0;
  let lastError: unknown;
  const maxAttempts = Math.max(count, count * 4);

  while (countInventoryFromBot(bot, dropQuery) - initialDropCount < count && attempts < maxAttempts) {
    attempts += 1;
    const block = await findReachableBlock(bot, blockQuery, maxDistance);
    if (!block) {
      await collectNearbyItems(bot, 12);
      const collected = countInventoryFromBot(bot, dropQuery) - initialDropCount;
      if (collected >= count) {
        return okResult(`Mined ${mined.length} block(s).`, {
          mined,
          collected,
          drop: dropQuery,
          attempts,
          toolsUsed: [...toolsUsed],
        });
      }
      if (mined.length > 0) {
        return failedResult("insufficient_drops", `Only collected ${collected}/${count} ${dropQuery}.`, true, {
          mined,
          collected,
          requested: count,
          drop: dropQuery,
          attempts,
          toolsUsed: [...toolsUsed],
        });
      }
      return failedResult("block_not_found", `No ${blockQuery} found within ${maxDistance} blocks.`);
    }

    const harvestTool = await ensureHarvestTool(bot, block);
    if (!harvestTool.ok) {
      return failedResult("missing_harvest_tool", `No suitable tool to harvest ${block.name}.`, true, {
        block: block.name,
        availableTools: harvestTool.availableTools,
      });
    }
    if (harvestTool.item) toolsUsed.add(harvestTool.item);

    if (!bot.canDigBlock(block)) {
      lastError = new Error(`Cannot dig ${block.name}.`);
      continue;
    }

    try {
      await bot.dig(block);
      mined.push(block.name);
    } catch (error) {
      lastError = error;
      await collectNearbyItems(bot, 8);
      const collected = countInventoryFromBot(bot, dropQuery) - initialDropCount;
      if (collected >= count) {
        return okResult(`Mined ${mined.length} block(s).`, {
          mined,
          collected,
          drop: dropQuery,
          attempts,
          toolsUsed: [...toolsUsed],
        });
      }
      continue;
    }
    await bot.waitForTicks(5);
    await collectNearbyItems(bot, 8);
    await bot.waitForTicks(5);

  }

  await collectNearbyItems(bot, 12);
  const collected = countInventoryFromBot(bot, dropQuery) - initialDropCount;
  if (collected < count) {
    return failedResult("insufficient_drops", `Only collected ${collected}/${count} ${dropQuery}.`, true, {
      mined,
      collected,
      requested: count,
      drop: dropQuery,
      attempts,
      toolsUsed: [...toolsUsed],
      cause: errorMessage(lastError),
    });
  }
  return okResult(`Mined ${mined.length} block(s).`, {
    mined,
    collected,
    drop: dropQuery,
    attempts,
    toolsUsed: [...toolsUsed],
  });
}

async function craftItem(bot: Bot, itemQuery: string, count: number): Promise<ToolResult> {
  const data = bot.registry;
  const itemNames = craftItemCandidates(bot, itemQuery);
  if (itemNames.length === 0) return failedResult("unknown_item", `Unknown craft item ${itemQuery}.`, false);

  const initialOutputCount = countInventoryFromBot(bot, itemQuery);
  let craftedCount = 0;
  const crafts: Array<{ item: string; count: number }> = [];

  while (craftedCount < count) {
    const beforeCount = countInventoryFromBot(bot, itemQuery);
    const step = await craftOneAvailableRecipe(bot, itemNames);
    if (!step) {
      const inventory = bot.inventory.items().map((item) => ({ name: item.name, count: item.count }));
      const plan = recipeLookup(data, itemQuery, inventory, Math.max(1, count - craftedCount));
      return failedResult("recipe_not_found", `No available recipe for ${itemQuery}.`, true, {
        craftedCount,
        requestedCount: count,
        ingredients: plan?.ingredients,
      });
    }

    await bot.waitForTicks(5);
    const afterCount = countInventoryFromBot(bot, itemQuery);
    const produced = Math.max(0, afterCount - beforeCount);
    craftedCount = afterCount - initialOutputCount;
    if (produced > 0) crafts.push({ item: step.item, count: produced });
  }

  return okResult(`Crafted ${craftedCount} ${itemQuery}.`, { item: itemQuery, craftedCount, crafts });
}

function craftItemCandidates(bot: Bot, itemQuery: string): string[] {
  return itemCandidates(itemQuery)
    .filter((name) => Boolean(bot.registry.itemsByName[name]));
}

async function craftOneAvailableRecipe(
  bot: Bot,
  itemNames: string[],
): Promise<{ item: string } | null> {
  const nearbyTable = nearbyCraftingTable(bot, 4);
  const localCraft = await tryCraftWithTable(bot, itemNames, nearbyTable);
  if (localCraft) return localCraft;

  const craftingTable = await goToCraftingTable(bot).catch(() => null);
  const tableCraft = await tryCraftWithTable(bot, itemNames, craftingTable);
  if (tableCraft) return tableCraft;

  return null;
}

async function tryCraftWithTable(
  bot: Bot,
  itemNames: string[],
  craftingTable: NonNullable<ReturnType<Bot["blockAt"]>> | null,
): Promise<{ item: string } | null> {
  for (const itemName of itemNames) {
    const item = bot.registry.itemsByName[itemName];
    const recipes = bot.recipesFor(item.id, null, 1, craftingTable);
    if (recipes.length === 0) continue;

    await bot.craft(recipes[0], 1, craftingTable ?? undefined);
    return { item: itemName };
  }

  return null;
}

function countInventoryFromBot(bot: Bot, itemQuery: string): number {
  return bot.inventory.items()
    .filter((item) => itemCandidates(itemQuery).includes(item.name))
    .reduce((sum, item) => sum + item.count, 0);
}

function nearbyCraftingTable(bot: Bot, maxDistance: number) {
  return bot.findBlock({
    matching: bot.registry.blocksByName.crafting_table?.id ?? -1,
    maxDistance,
  }) ?? null;
}

async function equipItem(bot: Bot, itemQuery: string): Promise<ToolResult> {
  const item = firstMatchingInventoryItem(bot.inventory.items(), itemQuery);
  if (!item) return failedResult("item_not_found", `No ${itemQuery} in inventory.`);
  await bot.equip(item, "hand");
  return okResult(`Equipped ${item.name}.`, { item: item.name });
}

async function placeBlock(
  bot: Bot,
  itemQuery: string,
  referenceQuery: string | undefined,
  maxDistance: number,
): Promise<ToolResult> {
  const item = firstMatchingInventoryItem(bot.inventory.items(), itemQuery);
  if (!item) return failedResult("item_not_found", `No ${itemQuery} in inventory.`);
  await bot.equip(item, "hand");

  const references = findPlaceReferences(bot, maxDistance, referenceQuery);
  if (references.length === 0) return failedResult("reference_block_not_found", "No nearby reference block for placement.");

  let lastError: unknown;
  for (const candidate of references.slice(0, 8)) {
    try {
      await gotoWithTimeout(bot, new goals.GoalNear(candidate.position.x, candidate.position.y, candidate.position.z, 2));
      const reference = bot.blockAt(candidate.position);
      if (!reference || !canPlaceOnReference(bot, reference)) continue;

      const target = reference.position.offset(0, 1, 0);
      await bot.lookAt(target.offset(0.5, 0.5, 0.5), true);
      await bot.placeBlock(reference, new Vec3(0, 1, 0));
      return okResult(`Placed ${item.name}.`, { item: item.name, reference: reference.name, position: target });
    } catch (error) {
      lastError = error;
    }
  }

  return failedResult("placement_failed", `Could not place ${item.name}.`, true, { cause: errorMessage(lastError) });
}

async function smeltItem(
  bot: Bot,
  inputQuery: string,
  fuelQuery: string,
  count: number,
  maxDistance: number,
): Promise<ToolResult> {
  const data = bot.registry;
  const furnaceBlock = bot.findBlock({
    matching: data.blocksByName.furnace?.id ?? -1,
    maxDistance,
  });
  if (!furnaceBlock) return failedResult("furnace_not_found", `No furnace within ${maxDistance} blocks.`);

  const input = firstMatchingInventoryItem(bot.inventory.items(), inputQuery);
  if (!input) return failedResult("item_not_found", `No ${inputQuery} in inventory.`);
  const fuel = firstMatchingInventoryItem(bot.inventory.items(), fuelQuery)
    ?? firstMatchingInventoryItem(bot.inventory.items(), "planks")
    ?? firstMatchingInventoryItem(bot.inventory.items(), "log");
  if (!fuel) return failedResult("fuel_not_found", `No ${fuelQuery} or fallback fuel in inventory.`);

  const furnace = await bot.openFurnace(furnaceBlock);
  try {
    await furnace.putInput(input.type, null, count);
    await furnace.putFuel(fuel.type, null, 1);
    await bot.waitForTicks(220);
    await furnace.takeOutput();
  } finally {
    furnace.close();
  }
  return okResult(`Smelted ${input.name}.`, { input: input.name, fuel: fuel.name });
}

async function eatFood(bot: Bot, requestedFood?: string): Promise<ToolResult> {
  if (!requestedFood && bot.food >= 20) {
    return okResult("Food is full; no eating needed.", { skipped: true, food: bot.food });
  }

  const items = bot.inventory.items();
  const food = requestedFood
    ? firstMatchingInventoryItem(items, requestedFood)
    : items.find((item) => FOOD_NAMES.includes(item.name));
  if (!food && !requestedFood) {
    return okResult("No edible food available.", { skipped: true, food: bot.food });
  }
  if (!food) return failedResult("food_not_found", "No edible food found.");

  await bot.equip(food, "hand");
  await bot.consume();
  return okResult(`Ate ${food.name}.`, { item: food.name });
}

function findNearestBlock(bot: Bot, query: string, maxDistance: number) {
  return findMatchingBlocks(bot, query, maxDistance, 1)[0] ?? null;
}

function findMatchingBlocks(bot: Bot, query: string, maxDistance: number, count: number) {
  const ids = itemCandidates(query)
    .map((name) => bot.registry.blocksByName[name]?.id)
    .filter((id): id is number => Number.isInteger(id));

  if (ids.length === 0) return [];
  const positions = bot.findBlocks({
    matching: ids,
    maxDistance,
    count,
  });

  return positions
    .map((position) => bot.blockAt(position))
    .filter((block): block is NonNullable<ReturnType<Bot["blockAt"]>> => Boolean(block))
    .sort((a, b) => (
      blockPathPenalty(bot, a) - blockPathPenalty(bot, b)
    ));
}

async function findReachableBlock(bot: Bot, query: string, maxDistance: number) {
  const blocks = findMatchingBlocks(bot, query, maxDistance, 16);
  if (blocks.length === 0) return null;

  for (const block of blocks) {
    try {
      await gotoWithTimeout(bot, new goals.GoalNearXZ(block.position.x, block.position.z, 2));
      const refreshed = bot.blockAt(block.position);
      if (!refreshed || !itemCandidates(query).includes(refreshed.name)) continue;
      if (!bot.canDigBlock(refreshed)) continue;
      return refreshed;
    } catch {
      continue;
    }
  }

  return null;
}

async function collectNearbyItems(bot: Bot, maxDistance: number): Promise<void> {
  const drops = Object.values(bot.entities)
    .filter((entity) => entity.name === "item")
    .filter((entity) => entity.position.distanceTo(bot.entity.position) <= maxDistance)
    .sort((a, b) => (
      a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position)
    ));

  for (const drop of drops) {
    try {
      await gotoWithTimeout(bot, new goals.GoalNear(drop.position.x, drop.position.y, drop.position.z, 1));
      await bot.waitForTicks(5);
    } catch {
      continue;
    }
  }
}

function expectedDropQuery(blockQuery: string): string {
  return itemCandidates(blockQuery).includes("stone") ? "cobblestone" : blockQuery;
}

async function ensureHarvestTool(
  bot: Bot,
  block: MineableBlock,
): Promise<{ ok: true; item?: string } | { ok: false; availableTools: string[] }> {
  if (blockCanHarvest(block, bot.heldItem?.type ?? null)) {
    return { ok: true, item: bot.heldItem?.name };
  }

  const tool = bestHarvestTool(bot, block);
  if (!tool) {
    return { ok: false, availableTools: harvestToolNames(bot) };
  }

  await bot.equip(tool, "hand");
  if (!blockCanHarvest(block, tool.type)) {
    return { ok: false, availableTools: harvestToolNames(bot) };
  }

  return { ok: true, item: tool.name };
}

function bestHarvestTool(bot: Bot, block: MineableBlock): InventoryItem | undefined {
  return bot.inventory.items()
    .filter((item) => blockCanHarvest(block, item.type))
    .sort((a, b) => (
      blockDigTime(block, a) - blockDigTime(block, b)
      || harvestToolPreference(a.name) - harvestToolPreference(b.name)
    ))[0];
}

function blockCanHarvest(block: MineableBlock, itemType: number | null): boolean {
  const candidate = block as MineableBlock & {
    canHarvest?: (heldItemType: number | null) => boolean;
    harvestTools?: Record<string, boolean>;
  };
  if (typeof candidate.canHarvest === "function") return candidate.canHarvest(itemType);
  if (!candidate.harvestTools) return true;
  return itemType !== null && Boolean(candidate.harvestTools[String(itemType)]);
}

function blockDigTime(block: MineableBlock, item: InventoryItem): number {
  const candidate = block as MineableBlock & {
    digTime?: (
      heldItemType: number | null,
      creative: boolean,
      inWater: boolean,
      notOnGround: boolean,
      enchantments?: unknown[],
      effects?: Record<string, unknown>,
    ) => number;
  };
  if (typeof candidate.digTime !== "function") return Number.POSITIVE_INFINITY;
  const time = candidate.digTime(item.type, false, false, false, (item as { enchants?: unknown[] }).enchants ?? [], {});
  return Number.isFinite(time) ? time : Number.POSITIVE_INFINITY;
}

function harvestToolPreference(name: string): number {
  const index = HARVEST_TOOL_ORDER.indexOf(name);
  return index >= 0 ? index : HARVEST_TOOL_ORDER.length;
}

function harvestToolNames(bot: Bot): string[] {
  return bot.inventory.items()
    .filter((item) => HARVEST_TOOL_ORDER.includes(item.name))
    .map((item) => item.name);
}

async function goToCraftingTable(bot: Bot) {
  const tableId = bot.registry.blocksByName.crafting_table?.id;
  if (!tableId) return null;

  const table = bot.findBlock({ matching: tableId, maxDistance: 32 });
  if (!table) return null;

  await gotoWithTimeout(bot, new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2));
  return bot.findBlock({ matching: tableId, maxDistance: 4 }) ?? table;
}

function findPlaceReferences(bot: Bot, maxDistance: number, query?: string) {
  const ids = query
    ? itemCandidates(query)
      .map((name) => bot.registry.blocksByName[name]?.id)
      .filter((id): id is number => Number.isInteger(id))
    : undefined;
  if (query && ids?.length === 0) return [];

  const positions = bot.findBlocks({
    matching: ids ?? ((block) => block.boundingBox === "block" && block.name !== "air"),
    maxDistance,
    count: 128,
  });

  return positions
    .map((position) => bot.blockAt(position))
    .filter((block): block is NonNullable<ReturnType<Bot["blockAt"]>> => Boolean(block))
    .filter((block) => canPlaceOnReference(bot, block))
    .sort((a, b) => (
      placeReferencePenalty(a.name) - placeReferencePenalty(b.name)
      || blockPathPenalty(bot, a) - blockPathPenalty(bot, b)
    ));
}

async function gotoWithTimeout(bot: Bot, goal: PathfinderGoal): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const work = bot.pathfinder.goto(goal);

  try {
    await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          timeout = undefined;
          bot.pathfinder?.stop();
          reject(new Error(`Pathfinding exceeded ${PATH_ATTEMPT_TIMEOUT_MS}ms.`));
        }, PATH_ATTEMPT_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    work.catch(() => undefined);
  }
}

function blockPathPenalty(bot: Bot, block: NonNullable<ReturnType<Bot["blockAt"]>>): number {
  return bot.entity.position.distanceTo(block.position)
    + Math.abs(bot.entity.position.y - block.position.y) * 4;
}

function canPlaceOnReference(bot: Bot, block: NonNullable<ReturnType<Bot["blockAt"]>>): boolean {
  const target = block.position.offset(0, 1, 0);
  const targetBlock = bot.blockAt(target);
  if (!targetBlock || targetBlock.name !== "air") return false;
  return bot.entity.position.distanceTo(target.offset(0.5, 0, 0.5)) > 1.25;
}

function placeReferencePenalty(name: string): number {
  if (name.endsWith("_leaves") || name.endsWith("_log")) return 100;
  if (["grass_block", "dirt", "stone", "cobblestone", "sand", "gravel"].includes(name)) return 0;
  return 10;
}
