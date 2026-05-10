import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { benchmarkEvidence, chooseToolCallWithPolicy, type ProviderFactory } from "../src/runner.js";
import type { SymbolicObservation } from "../src/types.js";

const observation: SymbolicObservation = {
  health: 20,
  food: 20,
  position: { x: 0, y: 64, z: 0 },
  inventory: [],
  nearbyBlocks: [],
  nearbyEntities: [],
};

describe("runner model policy", () => {
  it("normalizes args-only semantic outputs while preserving raw provider output", async () => {
    const config = loadConfig([
      "--provider", "gemini-compatible",
      "--primary-model", "gemma-4-31b-it",
      "--max-llm-retries", "0",
    ], {});
    const cases = [
      {
        raw: { block: "log", count: 1, maxDistance: 128 },
        expected: { tool: "mine_block", args: { block: "log", count: 1, maxDistance: 128 } },
      },
      {
        raw: { block: "log", maxDistance: 128 },
        expected: { tool: "go_to_nearest_block", args: { block: "log", maxDistance: 128 } },
      },
      {
        raw: { item: "planks", count: 4 },
        expected: { tool: "craft_item", args: { item: "planks", count: 4 } },
      },
      {
        raw: { item: "crafting_table", referenceBlock: "grass_block", maxDistance: 4 },
        expected: {
          tool: "place_block",
          args: { item: "crafting_table", referenceBlock: "grass_block", maxDistance: 4 },
        },
      },
      {
        raw: { ticks: 20 },
        expected: { tool: "wait", args: { ticks: 20 } },
      },
    ];

    for (const { raw, expected } of cases) {
      const providerFactory: ProviderFactory = (_config, route) => ({
        provider: route.provider,
        model: route.model,
        fixture: false,
        promptReference: () => ({
          provider: route.provider,
          model: route.model,
          templateId: "test-provider",
        }),
        nextToolCall: async () => raw,
      });

      const decision = await chooseToolCallWithPolicy(
        config,
        { task: "early_sequence", observation, iteration: 0 },
        providerFactory,
      );

      expect(decision.toolCall).toEqual(expected);
      expect(decision.providerOutput).toEqual(raw);
      expect(decision.validationErrors).toEqual([]);
      expect(decision.normalization).toMatchObject({
        applied: true,
        source: "args_only_semantic_output",
        normalizedToolCall: expected,
      });
      expect(decision.normalization?.rawValidationError.code).toBe("invalid_tool_call");
      expect(decision.llmAttempts[0]).toMatchObject({
        accepted: true,
        rawOutput: raw,
        normalization: {
          applied: true,
          source: "args_only_semantic_output",
          normalizedToolCall: expected,
        },
      });
    }
  });

  it("exhausts primary retries before selecting fallback", async () => {
    const config = loadConfig([
      "--provider", "openai-compatible",
      "--primary-model", "primary-model",
      "--fallback-provider", "gemini-compatible",
      "--fallback-model", "fallback-model",
      "--max-llm-retries", "1",
    ], {});
    const calls: Record<string, number> = {};

    const providerFactory: ProviderFactory = (_config, route) => ({
      provider: route.provider,
      model: route.model,
      fixture: route.provider === "scripted",
      promptReference: (input) => ({
        provider: route.provider,
        model: route.model,
        templateId: "test-provider",
        observationText: `retry=${input.retry ?? 0};errors=${input.validationErrors?.length ?? 0}`,
      }),
      nextToolCall: async (input) => {
        calls[route.model] = (calls[route.model] ?? 0) + 1;
        if (route.model === "primary-model" && input.retry === 0) throw new Error("upstream unavailable");
        if (route.model === "primary-model") {
          return { tool: "mine_block", args: { block: "log", count: 999, maxDistance: 32 } };
        }
        return { tool: "stop", args: { reason: "fallback accepted" } };
      },
    });

    const decision = await chooseToolCallWithPolicy(
      config,
      { task: "collect_logs", observation, iteration: 0 },
      providerFactory,
    );

    expect(calls["primary-model"]).toBe(2);
    expect(calls["fallback-model"]).toBe(1);
    expect(decision.toolCall).toEqual({ tool: "stop", args: { reason: "fallback accepted" } });
    expect(decision.retryCount).toBe(2);
    expect(decision.validationErrors.map((error) => error.code)).toEqual([
      "provider_error",
      "invalid_tool_call",
    ]);
    expect(decision.fallbackDecision).toMatchObject({
      used: true,
      failedAttempts: 2,
      from: { provider: "openai-compatible", model: "primary-model" },
      to: { provider: "gemini-compatible", model: "fallback-model" },
    });
    expect(decision.llmAttempts.map((attempt) => ({
      model: attempt.model,
      retry: attempt.retry,
      fallback: attempt.fallback,
      accepted: attempt.accepted,
      elapsedMs: typeof attempt.elapsedMs,
    }))).toEqual([
      { model: "primary-model", retry: 0, fallback: false, accepted: false, elapsedMs: "number" },
      { model: "primary-model", retry: 1, fallback: false, accepted: false, elapsedMs: "number" },
      { model: "fallback-model", retry: 0, fallback: true, accepted: true, elapsedMs: "number" },
    ]);
    expect(decision.llmAttempts[1].promptReference).toMatchObject({ observationText: "retry=1;errors=1" });
    expect(decision.llmAttempts[2].promptReference).toMatchObject({ observationText: "retry=0;errors=2" });
  });

  it("times out a slow primary attempt and still tries fallback", async () => {
    const config = loadConfig([
      "--provider", "gemini-compatible",
      "--primary-model", "gemma-4-31b-it",
      "--fallback-provider", "gemini-compatible",
      "--fallback-model", "gemini-flash-lite-latest",
      "--max-llm-retries", "0",
      "--llm-timeout-ms", "10",
    ], {});

    const providerFactory: ProviderFactory = (_config, route) => ({
      provider: route.provider,
      model: route.model,
      fixture: false,
      promptReference: () => ({
        provider: route.provider,
        model: route.model,
        templateId: "test-provider",
      }),
      nextToolCall: async () => {
        if (route.model === "gemma-4-31b-it") return await new Promise(() => undefined);
        return { tool: "stop", args: { reason: "fallback accepted" } };
      },
    });

    const decision = await chooseToolCallWithPolicy(
      config,
      { task: "collect_logs", observation, iteration: 0 },
      providerFactory,
    );

    expect(decision.toolCall).toEqual({ tool: "stop", args: { reason: "fallback accepted" } });
    expect(decision.validationErrors[0]).toMatchObject({
      code: "provider_error",
      message: "Model route gemini-compatible/gemma-4-31b-it exceeded 10ms.",
    });
    expect(decision.llmAttempts.map((attempt) => ({
      model: attempt.model,
      fallback: attempt.fallback,
      accepted: attempt.accepted,
      error: attempt.providerError?.code,
    }))).toEqual([
      { model: "gemma-4-31b-it", fallback: false, accepted: false, error: "provider_error" },
      { model: "gemini-flash-lite-latest", fallback: true, accepted: true, error: undefined },
    ]);
  });

  it("records the accepted route in multi-step fallback decisions", async () => {
    const config = loadConfig([
      "--provider", "openai-compatible",
      "--primary-model", "primary-model",
      "--model-escalation-order",
      "openai-compatible:primary-model,gemini-compatible:fallback-a,gemini-compatible:fallback-b",
      "--max-llm-retries", "0",
    ], {});

    const providerFactory: ProviderFactory = (_config, route) => ({
      provider: route.provider,
      model: route.model,
      fixture: false,
      promptReference: () => ({
        provider: route.provider,
        model: route.model,
        templateId: "test-provider",
      }),
      nextToolCall: async () => {
        if (route.model === "fallback-b") return { tool: "stop", args: { reason: "accepted" } };
        return { tool: "mine_block", args: { block: "log", count: 999, maxDistance: 32 } };
      },
    });

    const decision = await chooseToolCallWithPolicy(
      config,
      { task: "collect_logs", observation, iteration: 0 },
      providerFactory,
    );

    expect(decision.activeModel).toBe("fallback-b");
    expect(decision.fallbackDecision).toMatchObject({
      used: true,
      failedAttempts: 2,
      from: { provider: "openai-compatible", model: "primary-model" },
      to: { provider: "gemini-compatible", model: "fallback-b" },
    });
    expect(decision.llmAttempts.map((attempt) => attempt.model)).toEqual([
      "primary-model",
      "fallback-a",
      "fallback-b",
    ]);
  });

  it("can keep using a documented fallback route without retrying primary", async () => {
    const config = loadConfig([
      "--provider", "gemini-compatible",
      "--primary-model", "gemma-4-31b-it",
      "--fallback-provider", "gemini-compatible",
      "--fallback-model", "gemini-flash-lite-latest",
      "--max-llm-retries", "0",
    ], {});
    const calls: string[] = [];

    const providerFactory: ProviderFactory = (_config, route) => ({
      provider: route.provider,
      model: route.model,
      fixture: false,
      promptReference: () => ({
        provider: route.provider,
        model: route.model,
        templateId: "test-provider",
      }),
      nextToolCall: async () => {
        calls.push(route.model);
        return { tool: "stop", args: { reason: "accepted" } };
      },
    });

    const decision = await chooseToolCallWithPolicy(
      config,
      { task: "collect_logs", observation, iteration: 0 },
      providerFactory,
      {
        used: true,
        from: { provider: "gemini-compatible", model: "gemma-4-31b-it" },
        to: { provider: "gemini-compatible", model: "gemini-flash-lite-latest" },
        reason: "Gemma failure evidence present.",
        failedAttempts: 1,
      },
    );

    expect(calls).toEqual(["gemini-flash-lite-latest"]);
    expect(decision.llmAttempts[0]).toMatchObject({
      model: "gemini-flash-lite-latest",
      fallback: true,
      accepted: true,
    });
    expect(decision.fallbackDecision).toMatchObject({
      used: true,
      to: { provider: "gemini-compatible", model: "gemini-flash-lite-latest" },
    });
  });

  it("does not accept incomplete or scripted runs as benchmark evidence", () => {
    const completeScore = {
      task: "early_sequence" as const,
      complete: true,
      score: 1,
      evidence: {},
    };
    const incompleteScore = {
      task: "early_sequence" as const,
      complete: false,
      score: 0,
      evidence: {},
    };

    expect(benchmarkEvidence([{
      iteration: 0,
      llmAttempts: [{
        attempt: 0,
        retry: 0,
        provider: "openai-compatible",
        model: "gemma-4-31b",
        fallback: false,
        fixture: false,
        accepted: false,
        elapsedMs: 0,
      }],
    }], incompleteScore)).toMatchObject({
      accepted: false,
      caveat: "Run did not complete the selected task and is not accepted M1 benchmark evidence.",
    });

    expect(benchmarkEvidence([{
      iteration: 0,
      llmAttempts: [{
        attempt: 0,
        retry: 0,
        provider: "scripted",
        model: "scripted",
        fallback: false,
        fixture: true,
        accepted: true,
        elapsedMs: 0,
      }],
    }], completeScore)).toMatchObject({
      accepted: false,
      caveat: "Scripted provider is a fixture/control and is not accepted M1 benchmark evidence.",
    });

    expect(benchmarkEvidence([{
      iteration: 0,
      llmAttempts: [{
        attempt: 0,
        retry: 0,
        provider: "openai-compatible",
        model: "gemma-4-31b",
        fallback: false,
        fixture: false,
        accepted: true,
        elapsedMs: 0,
      }],
    }], completeScore)).toEqual({ accepted: true, caveat: undefined });
  });
});
