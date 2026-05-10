import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { buildResetCommands, parseResetSpawn, resetBotState } from "../src/demoReset.js";
import type { RunControlState } from "../src/types.js";

describe("demo reset", () => {
  it("builds default and configured reset commands", () => {
    const config = loadConfig([
      "--username", "webdemo",
      "--reset-spawn", "10,64,-3",
      "--reset-commands", "fill 0 60 0 4 64 4 air,setblock 1 64 1 crafting_table",
    ], {});

    expect(parseResetSpawn(config.resetSpawn)).toEqual({ x: 10, y: 64, z: -3 });
    expect(buildResetCommands(config)).toEqual([
      "/clear webdemo",
      "/effect clear webdemo",
      "/gamemode survival webdemo",
      "/tp webdemo 10 64 -3",
      "/fill 0 60 0 4 64 4 air",
      "/setblock 1 64 1 crafting_table",
    ]);
  });

  it("fails reset when configured spawn is invalid", async () => {
    const config = loadConfig(["--reset-spawn", "bad"], {});
    const bot = {
      pathfinder: { stop: vi.fn() },
    };
    const state: RunControlState = { stopRequested: false };

    const result = await resetBotState(bot as never, config, state);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("invalid_reset_spawn");
    expect(state.stopRequested).toBe(false);
    expect(state.stopReason).toBeUndefined();
    expect(state.lastActionResult).toBe(result);
  });

  it("runs reset commands and validates empty inventory", async () => {
    const config = loadConfig(["--username", "webdemo", "--reset-spawn", "0 64 0", "--reset-wait-ticks", "0"], {});
    const chats: string[] = [];
    const bot = {
      pathfinder: { stop: vi.fn() },
      chat: vi.fn((command: string) => chats.push(command)),
      waitForTicks: vi.fn(async () => undefined),
      health: 20,
      food: 20,
      entity: { position: { x: 0, y: 64, z: 0 } },
      blockAt: vi.fn(() => ({ biome: { name: "plains" } })),
      inventory: { items: vi.fn(() => []) },
      findBlocks: vi.fn(() => []),
      entities: {},
      time: { timeOfDay: 1000 },
    };
    const state: RunControlState = { stopRequested: false };

    const result = await resetBotState(bot as never, config, state);

    expect(result.ok).toBe(true);
    expect(chats).toEqual([
      "/clear webdemo",
      "/effect clear webdemo",
      "/gamemode survival webdemo",
      "/tp webdemo 0 64 0",
    ]);
    expect(state.stopRequested).toBe(false);
  });
});
