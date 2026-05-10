import { describe, expect, it } from "vitest";
import { getMinecraftData, recipeLookup } from "../src/recipes.js";

describe("recipe helpers", () => {
  const data = getMinecraftData("1.20.4");

  it("finds a plank recipe from a log inventory", () => {
    const plan = recipeLookup(data, "planks", [{ name: "oak_log", count: 1 }], 4);

    expect(plan?.item).toBe("oak_planks");
    expect(plan?.craftsRequired).toBe(1);
    expect(plan?.ingredients).toEqual([{ name: "oak_log", count: 1 }]);
  });

  it("finds multi-craft stick requirements", () => {
    const plan = recipeLookup(data, "stick", [{ name: "oak_planks", count: 2 }], 4);

    expect(plan?.item).toBe("stick");
    expect(plan?.craftsRequired).toBe(1);
    expect(plan?.ingredients).toEqual([{ name: "oak_planks", count: 2 }]);
  });
});
