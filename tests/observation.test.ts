import { describe, expect, it } from "vitest";
import { formatObservation } from "../src/observation.js";
import type { SymbolicObservation } from "../src/types.js";

describe("formatObservation", () => {
  it("formats symbolic state deterministically", () => {
    const observation: SymbolicObservation = {
      health: 20,
      food: 18,
      position: { x: 1, y: 64, z: -2 },
      biome: "plains",
      timeOfDay: 6000,
      inventory: [{ name: "oak_log", count: 3 }],
      equippedItem: "wooden_axe",
      nearbyBlocks: [{ name: "oak_log", position: { x: 2, y: 65, z: -2 }, distance: 1.41 }],
      nearbyEntities: [{ name: "cow", type: "mob", position: { x: 4, y: 64, z: -2 }, distance: 3 }],
      lastActionResult: { ok: true, message: "Mined 1 block." },
    };

    expect(formatObservation(observation)).toBe([
      "Health: 20 Food: 18",
      "Position: 1,64,-2 Biome: plains Time: 6000",
      "Inventory: oak_log x3",
      "Equipped: wooden_axe",
      "Nearby blocks: oak_log@2,65,-2 d=1.41",
      "Nearby entities: cow:mob@4,64,-2 d=3",
      "Last result: ok Mined 1 block.",
    ].join("\n"));
  });
});
