import { describe, expect, it, vi } from "vitest";
import { executeTool } from "../src/tools/execute.js";

describe("executeTool mine_block", () => {
  it("fails retryably when mined blocks do not produce requested drops", async () => {
    const block = {
      name: "oak_log",
      position: { x: 0, y: 64, z: 0 },
    };
    const bot = {
      registry: {
        blocksByName: { oak_log: { id: 1 } },
      },
      findBlocks: vi.fn()
        .mockReturnValueOnce([block.position])
        .mockReturnValue([]),
      blockAt: vi.fn((position) => (
        position.x === block.position.x && position.y === block.position.y && position.z === block.position.z
          ? block
          : null
      )),
      entity: { position: { distanceTo: () => 1 } },
      pathfinder: { goto: vi.fn(async () => undefined) },
      canDigBlock: vi.fn(() => true),
      dig: vi.fn(async () => undefined),
      waitForTicks: vi.fn(async () => undefined),
      entities: {},
      inventory: { items: vi.fn(() => []) },
    };
    const state = { stopRequested: false };

    const result = await executeTool(
      bot as never,
      { tool: "mine_block", args: { block: "log", count: 2, maxDistance: 32 } },
      state,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({
      code: "insufficient_drops",
      retryable: true,
      details: {
        collected: 0,
        requested: 2,
        drop: "log",
      },
    });
  });

  it("tries the next matching block when pathing fails", async () => {
    const blocks = [
      { name: "oak_log", position: { x: 2, y: 64, z: 0 } },
      { name: "oak_log", position: { x: 5, y: 64, z: 0 } },
    ];
    const bot = {
      registry: {
        blocksByName: { oak_log: { id: 1 } },
      },
      findBlocks: vi.fn(() => blocks.map((block) => block.position)),
      blockAt: vi.fn((position) => blocks.find((block) => (
        block.position.x === position.x && block.position.y === position.y && block.position.z === position.z
      )) ?? null),
      entity: {
        position: {
          distanceTo: (position: { x: number; y: number; z: number }) => (
            Math.hypot(position.x, position.y - 64, position.z)
          ),
        },
      },
      pathfinder: {
        goto: vi.fn()
          .mockRejectedValueOnce(new Error("unreachable"))
          .mockResolvedValueOnce(undefined),
      },
    };
    const state = { stopRequested: false };

    const result = await executeTool(
      bot as never,
      { tool: "go_to_nearest_block", args: { block: "log", maxDistance: 32 } },
      state,
    );

    expect(result.ok).toBe(true);
    expect(bot.pathfinder.goto).toHaveBeenCalledTimes(2);
  });
});
