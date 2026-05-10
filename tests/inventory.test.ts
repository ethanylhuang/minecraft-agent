import { describe, expect, it } from "vitest";
import { countInventory, hasInventory, isItemMatch, normalizeItemName } from "../src/inventory.js";

describe("inventory helpers", () => {
  it("normalizes names and matches aliases", () => {
    expect(normalizeItemName("minecraft:Oak Log")).toBe("oak_log");
    expect(isItemMatch("birch_log", "logs")).toBe(true);
    expect(isItemMatch("oak_planks", "plank")).toBe(true);
    expect(isItemMatch("stick", "logs")).toBe(false);
  });

  it("counts matching stacks", () => {
    const inventory = [
      { name: "oak_log", count: 2 },
      { name: "birch_log", count: 1 },
      { name: "stick", count: 4 },
    ];

    expect(countInventory(inventory, "log")).toBe(3);
    expect(hasInventory(inventory, "stick", 4)).toBe(true);
    expect(hasInventory(inventory, "stick", 5)).toBe(false);
  });
});
