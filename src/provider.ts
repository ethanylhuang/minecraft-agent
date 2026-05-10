import { countInventory } from "./inventory.js";
import { formatObservation } from "./observation.js";
import type { AppConfig, ProviderKind } from "./config.js";
import type { StructuredError, SymbolicObservation, TaskName } from "./types.js";
import type { ToolCall } from "./tools/schema.js";

export type ProviderInput = {
  task: TaskName;
  observation: SymbolicObservation;
  iteration: number;
  retry?: number;
  validationErrors?: StructuredError[];
  previousOutputs?: unknown[];
};

export type PromptMessage = {
  role: "system" | "user";
  content: string;
};

export type GeminiContent = {
  role: "user";
  parts: Array<{ text: string }>;
};

export type ModelRoute = {
  provider: ProviderKind;
  model: string;
};

export type PromptReference = {
  provider: ProviderKind;
  model: string;
  templateId: string;
  fixture?: boolean;
  benchmarkEvidence?: boolean;
  messages?: PromptMessage[];
  systemInstruction?: string;
  geminiContents?: GeminiContent[];
  observationText?: string;
};

export interface ModelProvider {
  provider: ProviderKind;
  model: string;
  fixture: boolean;
  promptReference(input: ProviderInput): PromptReference;
  nextToolCall(input: ProviderInput): Promise<unknown>;
}

export function createProvider(config: AppConfig, route = primaryModelRoute(config)): ModelProvider {
  if (route.provider === "scripted") {
    if (!config.allowScriptedFixtures) {
      throw new Error("Scripted provider is disabled by ALLOW_SCRIPTED_FIXTURES=false.");
    }
    return new ScriptedProvider(route.model);
  }
  if (route.provider === "gemini-compatible") return new GeminiCompatibleProvider(config, route.model);
  return new OpenAICompatibleProvider(config, route.model);
}

export function primaryModelRoute(config: AppConfig): ModelRoute {
  return { provider: config.provider, model: config.primaryModel };
}

export function resolveModelRoutes(config: AppConfig): ModelRoute[] {
  if (config.modelEscalationOrder.length > 0) {
    return config.modelEscalationOrder.map((entry) => parseModelRoute(entry, config.provider));
  }

  const routes = [primaryModelRoute(config)];
  if (config.fallbackModel) {
    routes.push({
      provider: config.fallbackProvider ?? config.provider,
      model: config.fallbackModel,
    });
  }
  return routes;
}

export class ScriptedProvider implements ModelProvider {
  readonly provider = "scripted";
  readonly fixture = true;

  constructor(readonly model = "scripted") {}

  promptReference(input: ProviderInput): PromptReference {
    return {
      provider: "scripted",
      model: this.model,
      templateId: "scripted-survival-policy-v1",
      fixture: true,
      benchmarkEvidence: false,
      observationText: formatObservation(input.observation),
    };
  }

  async nextToolCall(input: ProviderInput): Promise<ToolCall> {
    return scriptedCall(input.task, input.observation);
  }
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly provider = "openai-compatible";
  readonly fixture = false;

  constructor(private readonly config: AppConfig, readonly model = config.primaryModel) {}

  promptReference(input: ProviderInput): PromptReference {
    return {
      provider: "openai-compatible",
      model: this.model,
      templateId: "openai-compatible-chat-json-tool-v1",
      benchmarkEvidence: true,
      messages: buildOpenAIMessages(input),
    };
  }

  async nextToolCall(input: ProviderInput): Promise<unknown> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.config.openaiApiKey) headers.authorization = `Bearer ${this.config.openaiApiKey}`;

    const abort = timeoutSignal(this.config.llmDecisionTimeoutMs);
    const response = await fetch(`${this.config.openaiBaseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers,
      signal: abort.signal,
      body: JSON.stringify({
        model: this.model,
        temperature: 0,
        messages: buildOpenAIMessages(input),
      }),
    }).finally(abort.cancel);

    if (!response.ok) {
      throw new Error(`Model request failed: ${response.status} ${await response.text()}`);
    }

    return parseOpenAICompatibleResponse(await response.json());
  }
}

export class GeminiCompatibleProvider implements ModelProvider {
  readonly provider = "gemini-compatible";
  readonly fixture = false;

  constructor(private readonly config: AppConfig, readonly model = config.primaryModel) {}

  promptReference(input: ProviderInput): PromptReference {
    return {
      provider: "gemini-compatible",
      model: this.model,
      templateId: "gemini-generate-content-json-tool-v1",
      benchmarkEvidence: true,
      systemInstruction: buildSystemPrompt(),
      geminiContents: buildGeminiContents(input),
    };
  }

  async nextToolCall(input: ProviderInput): Promise<unknown> {
    if (!this.config.geminiApiKey) {
      throw new Error("GEMINI_API_KEY is required for gemini-compatible provider.");
    }

    const modelPath = this.model.startsWith("models/") ? this.model : `models/${this.model}`;
    const url = new URL(`${this.config.geminiBaseUrl.replace(/\/$/, "")}/${modelPath}:generateContent`);
    url.searchParams.set("key", this.config.geminiApiKey);

    const abort = timeoutSignal(this.config.llmDecisionTimeoutMs);
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: abort.signal,
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: buildSystemPrompt() }] },
        contents: buildGeminiContents(input),
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json",
        },
      }),
    }).finally(abort.cancel);

    if (!response.ok) {
      throw new Error(`Model request failed: ${response.status} ${await response.text()}`);
    }

    return parseGeminiCompatibleResponse(await response.json());
  }
}

function timeoutSignal(timeoutMs: number): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    cancel: () => clearTimeout(timeout),
  };
}

export function buildOpenAIMessages(input: ProviderInput): PromptMessage[] {
  return [
    {
      role: "system",
      content: buildSystemPrompt(),
    },
    {
      role: "user",
      content: buildUserPrompt(input),
    },
  ];
}

export function buildGeminiContents(input: ProviderInput): GeminiContent[] {
  return [{ role: "user", parts: [{ text: buildUserPrompt(input) }] }];
}

export function parseOpenAICompatibleResponse(body: unknown): unknown {
  const response = body as {
    choices?: Array<{
      message?: {
        content?: string | null;
        tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
      };
    }>;
  };
  const message = response.choices?.[0]?.message;
  const toolCall = message?.tool_calls?.[0]?.function;
  if (toolCall?.name) {
    return { tool: toolCall.name, args: parseJsonText(toolCall.arguments || "{}") };
  }
  return parseJsonText(message?.content ?? "{}");
}

export function parseGeminiCompatibleResponse(body: unknown): unknown {
  const response = body as {
    candidates?: Array<{
      content?: {
        parts?: Array<{
          text?: string;
          functionCall?: { name?: string; args?: unknown };
        }>;
      };
    }>;
  };
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  const functionCall = parts.find((part) => part.functionCall?.name)?.functionCall;
  if (functionCall?.name) return { tool: functionCall.name, args: functionCall.args ?? {} };

  const text = parts.map((part) => part.text ?? "").join("").trim();
  return parseJsonText(text || "{}");
}

export function parseJsonText(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const firstObject = firstBalancedJsonObject(candidate);
    if (firstObject) return JSON.parse(firstObject);
    throw new Error("Model response did not contain JSON.");
  }
}

function firstBalancedJsonObject(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start < 0) return undefined;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = inString;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return undefined;
}

function buildSystemPrompt(): string {
  return [
    "You control a Minecraft bot using one JSON tool call only.",
    "Return exactly: {\"tool\":\"name\",\"args\":{...}}.",
    "The only valid top-level keys are tool and args; never return args-only JSON.",
    "Use symbolic names only; never use coordinates, x/y/z, chat, slash commands, or free-form actions.",
    "Valid tools and args:",
    "observe {}",
    "go_to_nearest_block {\"block\":\"log\",\"maxDistance\":128}",
    "mine_block {\"block\":\"log\",\"count\":3,\"maxDistance\":128}",
    "craft_item {\"item\":\"planks\",\"count\":4}",
    "craft_item {\"item\":\"stick\",\"count\":4}",
    "craft_item {\"item\":\"crafting_table\",\"count\":1}",
    "craft_item {\"item\":\"wooden_pickaxe\",\"count\":1}",
    "equip_item {\"item\":\"wooden_pickaxe\"}",
    "place_block {\"item\":\"crafting_table\",\"referenceBlock\":\"grass_block\",\"maxDistance\":4}",
    "smelt_item {\"input\":\"raw_iron\",\"fuel\":\"coal\",\"count\":1,\"maxDistance\":8}",
    "eat_food {}",
    "wait {\"ticks\":20}",
    "stop {\"reason\":\"done\"}",
  ].join("\n");
}

function buildUserPrompt(input: ProviderInput): string {
  const feedback = buildRetryFeedback(input);
  return [
    `Task: ${input.task}`,
    taskObjective(input.task),
    formatObservation(input.observation),
    feedback,
  ].filter(Boolean).join("\n\n");
}

function taskObjective(task: TaskName): string {
  if (task === "early_sequence") {
    return [
      "Objective: satisfy all missing early-survival requirements.",
      "Required evidence: at least 3 logs, planks, at least 2 sticks, a crafted or nearby crafting_table, and a wooden_pickaxe.",
      "Efficient order: mine logs, craft planks, craft sticks, craft crafting_table, place crafting_table if not nearby, craft wooden_pickaxe.",
      "Mine enough logs so inventory still retains >=3 logs after crafting planks, sticks, the crafting_table, and the wooden_pickaxe.",
      "Mine logs in batches of 3; repeat mine_block if more logs are still needed.",
      "Prefer mine_block for logs; it handles movement, so do not call go_to_nearest_block before mining unless mining failed.",
      "If wooden_pickaxe is missing and planks are below 3 while logs are available, craft_item planks before trying the pickaxe.",
      "If a crafting_table is in inventory but not nearby, place_block crafting_table.",
      "If a crafting_table is nearby and you have at least 3 planks and 2 sticks, craft_item wooden_pickaxe.",
      "Stop only when all required evidence is satisfied.",
      "Choose one valid tool call that directly improves a missing requirement.",
    ].join(" ");
  }
  return "Objective: choose one valid tool call that directly improves the task score.";
}

function buildRetryFeedback(input: ProviderInput): string | undefined {
  if (!input.validationErrors?.length) return undefined;
  return [
    `Retry ${input.retry ?? input.validationErrors.length}: previous model output was rejected.`,
    "Return a corrected JSON tool call only. Top-level keys must be tool and args; do not return args-only JSON.",
    "Use block/item names such as log, planks, stick, crafting_table, wooden_pickaxe; do not use coordinates.",
    `Validation errors: ${JSON.stringify(input.validationErrors)}`,
    `Raw rejected outputs: ${JSON.stringify(input.previousOutputs ?? [])}`,
  ].join("\n");
}

function parseModelRoute(entry: string, defaultProvider: ProviderKind): ModelRoute {
  const separator = entry.indexOf(":");
  if (separator < 0) return { provider: defaultProvider, model: entry };

  const provider = entry.slice(0, separator);
  const model = entry.slice(separator + 1);
  if (!isProviderKind(provider) || model.trim().length === 0) {
    throw new Error(`Invalid model escalation entry: ${entry}`);
  }
  return { provider, model };
}

function isProviderKind(value: string): value is ProviderKind {
  return value === "scripted" || value === "openai-compatible" || value === "gemini-compatible";
}

function scriptedCall(task: TaskName, observation: SymbolicObservation): ToolCall {
  const logCount = countInventory(observation.inventory, "log");
  const plankCount = countInventory(observation.inventory, "planks");
  const stickCount = countInventory(observation.inventory, "stick");
  const tableCount = countInventory(observation.inventory, "crafting_table");
  const tablePlaced = observation.nearbyBlocks.some((block) => block.name === "crafting_table");
  const woodenPickaxeCount = countInventory(observation.inventory, "wooden_pickaxe");

  if (task === "collect_logs") return logCount >= 3 ? stop("logs collected") : mine("log");
  if (task === "craft_planks") {
    if (plankCount >= 4) return stop("planks crafted");
    return logCount > 0 ? craft("planks", 4) : mine("log");
  }
  if (task === "craft_sticks") {
    if (stickCount >= 4) return stop("sticks crafted");
    if (plankCount >= 2) return craft("stick", 4);
    return logCount > 0 ? craft("planks", 4) : mine("log");
  }
  if (task === "craft_crafting_table") {
    if (tableCount >= 1) return stop("crafting table crafted");
    if (plankCount >= 4) return craft("crafting_table");
    return logCount > 0 ? craft("planks", 4) : mine("log");
  }
  if (task === "craft_wooden_pickaxe") return pickaxeStep(observation);

  if (task === "mine_cobblestone") return countInventory(observation.inventory, "cobblestone") >= 1
    ? stop("cobblestone mined")
    : mine("stone");
  if (task === "craft_stone_pickaxe") return countInventory(observation.inventory, "stone_pickaxe") >= 1
    ? stop("stone pickaxe crafted")
    : craft("stone_pickaxe");
  if (task === "place_furnace") {
    if (observation.nearbyBlocks.some((block) => block.name === "furnace")) return stop("furnace placed");
    if (countInventory(observation.inventory, "furnace") >= 1) return place("furnace");
    return craft("furnace");
  }
  if (task === "smelt_iron_ingot") return countInventory(observation.inventory, "iron_ingot") >= 1
    ? stop("iron ingot smelted")
    : { tool: "smelt_item", args: { input: "raw_iron", fuel: "coal", count: 1, maxDistance: 8 } };

  if (logCount < 3) return mine("log");
  if (plankCount < 8) return craft("planks", 12);
  if (stickCount < 4) return craft("stick", 4);
  if (tableCount < 1 && !tablePlaced) return craft("crafting_table");
  if (!tablePlaced && tableCount > 0) return place("crafting_table");
  if (woodenPickaxeCount < 1) return craft("wooden_pickaxe");
  return stop("early sequence complete");
}

function pickaxeStep(observation: SymbolicObservation): ToolCall {
  if (countInventory(observation.inventory, "log") < 3 && countInventory(observation.inventory, "planks") < 3) {
    return mine("log");
  }
  if (countInventory(observation.inventory, "planks") < 3) return craft("planks", 8);
  if (countInventory(observation.inventory, "stick") < 2) return craft("stick", 4);
  if (!observation.nearbyBlocks.some((block) => block.name === "crafting_table")) {
    if (countInventory(observation.inventory, "crafting_table") < 1) return craft("crafting_table");
    return place("crafting_table");
  }
  return craft("wooden_pickaxe");
}

function mine(block: string): ToolCall {
  return { tool: "mine_block", args: { block, count: 1, maxDistance: 128 } };
}

function craft(item: string, count = 1): ToolCall {
  return { tool: "craft_item", args: { item, count } };
}

function place(item: string): ToolCall {
  return { tool: "place_block", args: { item, maxDistance: 4 } };
}

function stop(reason: string): ToolCall {
  return { tool: "stop", args: { reason } };
}
