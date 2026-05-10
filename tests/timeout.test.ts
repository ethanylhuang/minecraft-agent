import { describe, expect, it, vi } from "vitest";
import { withTimeout } from "../src/timeout.js";

describe("withTimeout", () => {
  it("clears the timeout when work finishes first", async () => {
    vi.useFakeTimers();
    try {
      await expect(withTimeout(Promise.resolve("ok"), 1000, () => "timeout"))
        .resolves.toBe("ok");

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns the timeout value when work does not finish", async () => {
    vi.useFakeTimers();
    try {
      const result = withTimeout(new Promise<string>(() => {}), 1000, () => "timeout");

      await vi.advanceTimersByTimeAsync(1000);

      await expect(result).resolves.toBe("timeout");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
