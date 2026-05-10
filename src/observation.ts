import type { Bot } from "mineflayer";
import type { BlockObservation, EntityObservation, SymbolicObservation, Vec3Like } from "./types.js";

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function positionOf(value: Vec3Like): Vec3Like {
  return { x: round(value.x), y: round(value.y), z: round(value.z) };
}

function distance(a: Vec3Like, b: Vec3Like): number {
  return round(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z));
}

export function buildObservation(
  bot: Bot,
  lastActionResult?: SymbolicObservation["lastActionResult"],
  radius = 8,
): SymbolicObservation {
  const position = positionOf(bot.entity.position);
  const blocks = nearbyBlocks(bot, position, radius);
  const entities = nearbyEntities(bot, position, radius);
  const biome = (bot.blockAt(bot.entity.position) as unknown as { biome?: { name?: string } })?.biome?.name;

  return {
    health: round(bot.health),
    food: round(bot.food),
    position,
    biome,
    timeOfDay: bot.time?.timeOfDay,
    inventory: bot.inventory.items()
      .map((item) => ({ name: item.name, count: item.count }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    equippedItem: bot.heldItem?.name,
    nearbyBlocks: blocks,
    nearbyEntities: entities,
    lastActionResult,
  };
}

export function formatObservation(observation: SymbolicObservation): string {
  const inventory = observation.inventory.length
    ? observation.inventory.map((item) => `${item.name} x${item.count}`).join(", ")
    : "empty";
  const blocks = observation.nearbyBlocks.length
    ? observation.nearbyBlocks.map((block) => (
      `${block.name}@${formatPosition(block.position)} d=${block.distance}`
    )).join("; ")
    : "none";
  const entities = observation.nearbyEntities.length
    ? observation.nearbyEntities.map((entity) => (
      `${entity.name}:${entity.type}@${formatPosition(entity.position)} d=${entity.distance}`
    )).join("; ")
    : "none";
  const last = observation.lastActionResult
    ? `${observation.lastActionResult.ok ? "ok" : "error"} ${observation.lastActionResult.message}`
    : "none";

  return [
    `Health: ${observation.health} Food: ${observation.food}`,
    `Position: ${formatPosition(observation.position)} Biome: ${observation.biome ?? "unknown"} Time: ${observation.timeOfDay ?? "unknown"}`,
    `Inventory: ${inventory}`,
    `Equipped: ${observation.equippedItem ?? "none"}`,
    `Nearby blocks: ${blocks}`,
    `Nearby entities: ${entities}`,
    `Last result: ${last}`,
  ].join("\n");
}

function formatPosition(position: Vec3Like): string {
  return `${position.x},${position.y},${position.z}`;
}

function nearbyBlocks(bot: Bot, origin: Vec3Like, radius: number): BlockObservation[] {
  const positions = bot.findBlocks({
    matching: (block) => block.name !== "air" && block.name !== "void_air" && block.name !== "cave_air",
    maxDistance: radius,
    count: 64,
  });

  return positions
    .map((position) => bot.blockAt(position))
    .filter((block): block is NonNullable<ReturnType<Bot["blockAt"]>> => Boolean(block))
    .map((block) => ({
      name: block.name,
      position: positionOf(block.position),
      distance: distance(origin, block.position),
    }))
    .sort(sortByDistanceAndName);
}

function nearbyEntities(bot: Bot, origin: Vec3Like, radius: number): EntityObservation[] {
  return Object.values(bot.entities)
    .filter((entity) => entity !== bot.entity)
    .map((entity) => ({
      name: entity.name ?? entity.username ?? "unknown",
      type: entity.type,
      position: positionOf(entity.position),
      distance: distance(origin, entity.position),
    }))
    .filter((entity) => entity.distance <= radius)
    .sort(sortByDistanceAndName)
    .slice(0, 32);
}

function sortByDistanceAndName<T extends { name: string; distance: number }>(a: T, b: T): number {
  return a.distance - b.distance || a.name.localeCompare(b.name);
}
