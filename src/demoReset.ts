import type { Bot } from "mineflayer";
import type { AppConfig } from "./config.js";
import { errorMessage, failedResult, okResult } from "./errors.js";
import { buildObservation } from "./observation.js";
import type { RunControlState, ToolResult, Vec3Like } from "./types.js";

export type ResetResult = ToolResult & {
  data?: {
    commands: string[];
    spawn?: Vec3Like;
    inventoryCount?: number;
    position?: Vec3Like;
  };
};

export async function resetBotState(
  bot: Bot,
  config: AppConfig,
  state: RunControlState,
): Promise<ResetResult> {
  state.stopRequested = true;
  state.stopReason = "reset requested";
  bot.pathfinder?.stop();

  const spawn = parseResetSpawn(config.resetSpawn);
  const commands = buildResetCommands(config, config.username);
  if (config.resetSpawn && !spawn) {
    const result = failedResult(
      "invalid_reset_spawn",
      `Invalid reset spawn "${config.resetSpawn}". Use "x,y,z" or "x y z".`,
      false,
    ) as ResetResult;
    state.stopRequested = false;
    state.stopReason = undefined;
    state.lastActionResult = result;
    return result;
  }

  try {
    for (const command of commands) {
      bot.chat(command);
      await bot.waitForTicks(2);
    }
    if (config.resetWaitTicks > 0) await bot.waitForTicks(config.resetWaitTicks);
  } catch (error) {
    const result = failedResult("reset_command_failed", errorMessage(error), true, { commands }) as ResetResult;
    state.lastActionResult = result;
    return result;
  } finally {
    state.stopRequested = false;
    state.stopReason = undefined;
  }

  const observation = buildObservation(bot);
  const inventoryCount = observation.inventory.reduce((sum, item) => sum + item.count, 0);
  if (inventoryCount > 0) {
    const result = failedResult(
      "reset_inventory_not_empty",
      "Reset did not clear bot inventory. Check server command permissions or reset commands.",
      true,
      { commands, inventory: observation.inventory },
    ) as ResetResult;
    state.lastActionResult = result;
    return result;
  }
  if (spawn && distance(observation.position, spawn) > 3) {
    const result = failedResult(
      "reset_spawn_not_reached",
      "Reset did not move bot to the configured spawn position.",
      true,
      { commands, expected: spawn, actual: observation.position },
    ) as ResetResult;
    state.lastActionResult = result;
    return result;
  }

  const result = okResult("Reset completed.", {
    commands,
    spawn,
    inventoryCount,
    position: observation.position,
  }) as ResetResult;
  state.lastActionResult = result;
  return result;
}

export function buildResetCommands(config: AppConfig, username = config.username): string[] {
  const spawn = parseResetSpawn(config.resetSpawn);
  const defaults = [
    `/clear ${username}`,
    `/effect clear ${username}`,
    `/gamemode survival ${username}`,
    ...(spawn ? [`/tp ${username} ${spawn.x} ${spawn.y} ${spawn.z}`] : []),
  ];
  return [...defaults, ...config.resetCommands]
    .map((command) => renderResetCommand(command, username, spawn))
    .filter((command) => command.length > 0);
}

export function parseResetSpawn(value: string | undefined): Vec3Like | undefined {
  if (!value) return undefined;
  const parts = value.trim().split(/[,\s]+/).filter(Boolean).map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return undefined;
  return { x: parts[0], y: parts[1], z: parts[2] };
}

function renderResetCommand(command: string, username: string, spawn: Vec3Like | undefined): string {
  const rendered = command
    .replaceAll("{username}", username)
    .replaceAll("{x}", String(spawn?.x ?? ""))
    .replaceAll("{y}", String(spawn?.y ?? ""))
    .replaceAll("{z}", String(spawn?.z ?? ""))
    .trim();
  if (!rendered) return "";
  return rendered.startsWith("/") ? rendered : `/${rendered}`;
}

function distance(a: Vec3Like, b: Vec3Like): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
