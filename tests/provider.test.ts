import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import {
  buildGeminiContents,
  buildOpenAIMessages,
  OpenAICompatibleProvider,
  parseGeminiCompatibleResponse,
  parseJsonText,
  parseOpenAICompatibleResponse,
  resolveModelRoutes,
  ScriptedProvider,
} from "../src/provider.js";
import type { SymbolicObservation } from "../src/types.js";

const observation: SymbolicObservation = {
  health: 20,
  food: 20,
  position: { x: 0, y: 64, z: 0 },
  inventory: [],
  nearbyBlocks: [],
  nearbyEntities: [],
};

describe("provider prompts", () => {
  it("builds OpenAI-compatible messages from symbolic observations", () => {
    const messages = buildOpenAIMessages({ task: "collect_logs", observation, iteration: 0 });

    expect(messages).toHaveLength(2);
    expect(messages[0].content).toContain("Return exactly");
    expect(messages[0].content).toContain("never return args-only JSON");
    expect(messages[0].content).toContain("never use coordinates");
    expect(messages[0].content).toContain("mine_block {\"block\":\"log\",\"count\":3,\"maxDistance\":128}");
    expect(messages[0].content).toContain("craft_item {\"item\":\"stick\",\"count\":4}");
    expect(messages[0].content).toContain("craft_item {\"item\":\"crafting_table\",\"count\":1}");
    expect(messages[0].content).toContain("craft_item {\"item\":\"wooden_pickaxe\",\"count\":1}");
    expect(messages[1].content).toContain("Task: collect_logs");
    expect(messages[1].content).toContain("Objective:");
    expect(messages[1].content).toContain("Health: 20 Food: 20");
  });

  it("spells out early sequence completion constraints", () => {
    const messages = buildOpenAIMessages({ task: "early_sequence", observation, iteration: 0 });

    expect(messages[1].content).toContain("retain");
    expect(messages[1].content).toContain(">=3 logs");
    expect(messages[1].content).toContain("Efficient order");
    expect(messages[1].content).toContain("batches of 3");
    expect(messages[1].content).toContain("Prefer mine_block for logs");
    expect(messages[1].content).toContain("planks are below 3");
    expect(messages[1].content).toContain("craft_item wooden_pickaxe");
    expect(messages[1].content).toContain("Stop only when all required evidence is satisfied.");
  });

  it("adds schema retry feedback to prompts", () => {
    const messages = buildOpenAIMessages({
      task: "collect_logs",
      observation,
      iteration: 0,
      retry: 1,
      validationErrors: [{
        code: "invalid_tool_call",
        message: "Tool call failed runtime validation.",
        retryable: true,
      }],
      previousOutputs: [{ tool: "mine_block", args: { count: 1 } }],
    });

    expect(messages[1].content).toContain("Retry 1");
    expect(messages[1].content).toContain("invalid_tool_call");
    expect(messages[1].content).toContain("do not return args-only JSON");
    expect(messages[1].content).toContain("do not use coordinates");
    expect(messages[1].content).toContain("Raw rejected outputs");
  });

  it("builds Gemini-compatible contents from symbolic observations", () => {
    const contents = buildGeminiContents({ task: "collect_logs", observation, iteration: 0 });

    expect(contents).toHaveLength(1);
    expect(contents[0].role).toBe("user");
    expect(contents[0].parts[0].text).toContain("Task: collect_logs");
  });

  it("exposes a prompt reference for scripted calls", () => {
    const provider = new ScriptedProvider();
    const reference = provider.promptReference({ task: "collect_logs", observation, iteration: 0 });

    expect(reference).toMatchObject({
      provider: "scripted",
      model: "scripted",
      templateId: "scripted-survival-policy-v1",
      fixture: true,
      benchmarkEvidence: false,
    });
    expect(reference.observationText).toContain("Inventory: empty");
  });

  it("loads model-policy config and escalation order", () => {
    const config = loadConfig([
      "--provider", "openai-compatible",
      "--primary-model", "gemma-4-31b",
      "--fallback-provider", "gemini-compatible",
      "--fallback-model", "gemini-3.1-flash",
      "--model-escalation-order", "openai-compatible:gemma-4-31b,gemini-compatible:gemini-3.1-flash",
      "--lock-fallback-after-use", "true",
      "--max-llm-retries", "3",
      "--llm-timeout-ms", "30000",
      "--tool-timeout-ms", "45000",
      "--allow-scripted-fixtures", "false",
    ], {});

    expect(config.primaryModel).toBe("gemma-4-31b");
    expect(config.fallbackProvider).toBe("gemini-compatible");
    expect(config.fallbackModel).toBe("gemini-3.1-flash");
    expect(config.lockFallbackAfterUse).toBe(true);
    expect(config.maxLlmRetriesPerStep).toBe(3);
    expect(config.llmDecisionTimeoutMs).toBe(30000);
    expect(config.toolExecutionTimeoutMs).toBe(45000);
    expect(config.allowScriptedFixtures).toBe(false);
    expect(resolveModelRoutes(config)).toEqual([
      { provider: "openai-compatible", model: "gemma-4-31b" },
      { provider: "gemini-compatible", model: "gemini-3.1-flash" },
    ]);
  });

  it("rejects Minecraft usernames longer than 16 characters", () => {
    expect(() => loadConfig(["--username", "m1_audit_early_current"], {})).toThrow();
  });
});

describe("provider response parsing", () => {
  it("parses OpenAI-compatible content JSON", () => {
    expect(parseOpenAICompatibleResponse({
      choices: [{ message: { content: "{\"tool\":\"wait\",\"args\":{\"ticks\":20}}" } }],
    })).toEqual({ tool: "wait", args: { ticks: 20 } });
  });

  it("parses OpenAI-compatible tool calls", () => {
    expect(parseOpenAICompatibleResponse({
      choices: [{
        message: {
          tool_calls: [{
            function: {
              name: "mine_block",
              arguments: "{\"block\":\"log\",\"count\":1,\"maxDistance\":32}",
            },
          }],
        },
      }],
    })).toEqual({ tool: "mine_block", args: { block: "log", count: 1, maxDistance: 32 } });
  });

  it("parses Gemini-compatible text JSON", () => {
    expect(parseGeminiCompatibleResponse({
      candidates: [{
        content: {
          parts: [{ text: "```json\n{\"tool\":\"stop\",\"args\":{\"reason\":\"done\"}}\n```" }],
        },
      }],
    })).toEqual({ tool: "stop", args: { reason: "done" } });
  });

  it("extracts the first balanced JSON object from extra model text", () => {
    expect(parseJsonText(
      "{\"tool\":\"wait\",\"args\":{\"ticks\":20}}\nI will wait.",
    )).toEqual({ tool: "wait", args: { ticks: 20 } });
    expect(parseJsonText(
      "Use this: {\"tool\":\"mine_block\",\"args\":{\"block\":\"log\",\"count\":1,\"maxDistance\":32}} then continue.",
    )).toEqual({ tool: "mine_block", args: { block: "log", count: 1, maxDistance: 32 } });
  });

  it("parses Gemini-compatible function calls", () => {
    expect(parseGeminiCompatibleResponse({
      candidates: [{
        content: {
          parts: [{ functionCall: { name: "craft_item", args: { item: "planks", count: 4 } } }],
        },
      }],
    })).toEqual({ tool: "craft_item", args: { item: "planks", count: 4 } });
  });
});

describe("OpenAI-compatible provider", () => {
  it("allows unauthenticated local-compatible endpoints", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ headers?: unknown }> = [];
    globalThis.fetch = (async (_url, init) => {
      requests.push({ headers: init?.headers });
      return new Response(JSON.stringify({
        choices: [{ message: { content: "{\"tool\":\"wait\",\"args\":{\"ticks\":20}}" } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    try {
      const config = loadConfig([
        "--provider", "openai-compatible",
        "--primary-model", "gemma-4-31b",
        "--openai-base-url", "http://localhost:8000/v1",
      ], {});
      const provider = new OpenAICompatibleProvider(config);

      await expect(provider.nextToolCall({ task: "collect_logs", observation, iteration: 0 }))
        .resolves.toEqual({ tool: "wait", args: { ticks: 20 } });
      expect(requests[0].headers).toEqual({ "content-type": "application/json" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
