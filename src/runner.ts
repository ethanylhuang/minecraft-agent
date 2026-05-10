import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Bot } from "mineflayer";
import type { AppConfig } from "./config.js";
import { errorMessage, failedResult, structuredError } from "./errors.js";
import { countInventory } from "./inventory.js";
import { buildObservation, formatObservation } from "./observation.js";
import {
  createProvider,
  resolveModelRoutes,
  type ModelProvider,
  type ModelRoute,
  type ProviderInput,
  type ProviderRunTarget,
} from "./provider.js";
import { scoreTask } from "./tasks.js";
import { withTimeout } from "./timeout.js";
import type { RunControlState, StructuredError, SymbolicObservation, TaskName, TaskScore, ToolResult } from "./types.js";
import { executeTool } from "./tools/execute.js";
import { validateToolCall, type ToolCall } from "./tools/schema.js";

export type LlmAttemptEvent = {
  attempt: number;
  retry: number;
  provider: ModelRoute["provider"];
  model: string;
  fallback: boolean;
  fixture: boolean;
  accepted: boolean;
  promptReference?: unknown;
  rawOutput?: unknown;
  normalization?: ToolCallNormalization;
  validationError?: StructuredError;
  providerError?: StructuredError;
  elapsedMs: number;
};

export type ToolCallNormalization = {
  applied: true;
  source: "args_only_semantic_output";
  reason: string;
  rawValidationError: StructuredError;
  normalizedToolCall: ToolCall;
};

export type FallbackDecision = {
  used: boolean;
  from: ModelRoute;
  to: ModelRoute;
  reason: string;
  failedAttempts: number;
};

export type LlmToolCallDecision = {
  toolCall?: ToolCall;
  toolResult?: ToolResult;
  promptReference?: unknown;
  providerOutput?: unknown;
  normalization?: ToolCallNormalization;
  llmAttempts: LlmAttemptEvent[];
  retryCount: number;
  validationErrors: StructuredError[];
  fallbackDecision?: FallbackDecision;
  activeProvider?: ModelRoute["provider"];
  activeModel?: string;
  activeFixture?: boolean;
};

export type ProviderFactory = (config: AppConfig, route: ModelRoute) => ModelProvider;

type RunEvent = {
  iteration: number;
  observation?: unknown;
  observationText?: string;
  score?: TaskScore;
  scoreAfter?: TaskScore;
  inventoryBefore?: unknown;
  inventoryAfter?: unknown;
  promptReference?: unknown;
  providerOutput?: unknown;
  normalization?: ToolCallNormalization;
  activeProvider?: ModelRoute["provider"];
  activeModel?: string;
  activeFixture?: boolean;
  retryCount?: number;
  validationErrors?: StructuredError[];
  fallbackDecision?: FallbackDecision;
  llmAttempts?: LlmAttemptEvent[];
  toolCall?: unknown;
  toolResult?: ToolResult;
  toolElapsedMs?: number;
};

export type RunTaskOptions = {
  logPath?: string;
  controlState?: RunControlState;
};

export async function runTask(
  bot: Bot,
  config: AppConfig,
  options: RunTaskOptions = {},
): Promise<{ logPath: string; score: TaskScore; status: "complete" | "stopped" }> {
  const startedAt = new Date();
  const startedMs = Date.now();
  const state: RunControlState = options.controlState ?? { stopRequested: false };
  const events: RunEvent[] = [];
  let finalScore: TaskScore | undefined;
  let finalStatus: "complete" | "stopped" = "complete";
  let lockedFallback: FallbackDecision | undefined;
  const initialObservation = buildObservation(bot, state.lastActionResult);
  const runTarget = runTargetForTask(config.task, initialObservation);
  await mkdir(config.logDir, { recursive: true });
  const logPath = options.logPath
    ?? join(config.logDir, `${new Date().toISOString().replace(/[:.]/g, "-")}_${config.task}.json`);

  for (let iteration = 0; iteration < config.maxIterations; iteration += 1) {
    const observation = iteration === 0 ? initialObservation : buildObservation(bot, state.lastActionResult);
    const score = scoreRunTask(config.task, observation, runTarget);
    finalScore = score;
    const event: RunEvent = {
      iteration,
      observation,
      observationText: formatObservation(observation),
      score,
      inventoryBefore: observation.inventory,
    };
    events.push(event);
    await writeRunLogSnapshot(logPath, config, startedAt, startedMs, events, state, bot, "running", runTarget);

    if (score.complete || bot.health <= 0) break;
    if (state.stopRequested) {
      finalStatus = "stopped";
      state.lastActionResult = failedResult(
        "stopped",
        state.stopReason ?? "Run stopped.",
        false,
        { stopped: true },
      );
      event.toolResult = state.lastActionResult;
      break;
    }

    const providerInput = { task: config.task, observation, iteration, runTarget };
    const decisionTimeoutMs = llmDecisionBudgetMs(config, lockedFallback);
    const decision = await withTimeout(
      chooseToolCallWithPolicy(config, providerInput, createProvider, lockedFallback),
      decisionTimeoutMs,
      () => modelTimeoutDecision(decisionTimeoutMs),
    );
    if (config.lockFallbackAfterUse && decision.fallbackDecision?.used) {
      lockedFallback = decision.fallbackDecision;
    }

    event.promptReference = decision.promptReference;
    event.providerOutput = decision.providerOutput;
    event.normalization = decision.normalization;
    event.activeProvider = decision.activeProvider;
    event.activeModel = decision.activeModel;
    event.activeFixture = decision.activeFixture;
    event.retryCount = decision.retryCount;
    event.validationErrors = decision.validationErrors;
    event.fallbackDecision = decision.fallbackDecision;
    event.llmAttempts = decision.llmAttempts;

    if (state.stopRequested) {
      finalStatus = "stopped";
      state.lastActionResult = failedResult(
        "stopped",
        state.stopReason ?? "Run stopped.",
        false,
        { stopped: true },
      );
      event.toolResult = state.lastActionResult;
      break;
    }

    if (!decision.toolCall) {
      state.lastActionResult = decision.toolResult ?? failedResult("model_policy_error", "No valid tool call produced.", true);
      event.toolResult = state.lastActionResult;
      continue;
    }

    event.toolCall = decision.toolCall;
    const toolStartedMs = Date.now();
    state.lastActionResult = await withTimeout(
      executeTool(bot, decision.toolCall, state),
      config.toolExecutionTimeoutMs,
      () => {
        bot.pathfinder?.stop();
        return failedResult(
          "tool_timeout",
          `Tool ${decision.toolCall?.tool ?? "unknown"} exceeded ${config.toolExecutionTimeoutMs}ms.`,
          true,
        );
      },
    );
    event.toolElapsedMs = Date.now() - toolStartedMs;
    event.toolResult = state.lastActionResult;
    const observationAfter = buildObservation(bot, state.lastActionResult);
    event.inventoryAfter = observationAfter.inventory;
    event.scoreAfter = scoreRunTask(config.task, observationAfter, runTarget);
    await writeRunLogSnapshot(logPath, config, startedAt, startedMs, events, state, bot, "running", runTarget);

    if (state.stopRequested || state.lastActionResult.error?.code === "stopped") {
      finalStatus = "stopped";
      break;
    }
  }

  finalScore = await writeRunLogSnapshot(logPath, config, startedAt, startedMs, events, state, bot, finalStatus, runTarget);

  return { logPath, score: finalScore, status: finalStatus };
}

function runTargetForTask(task: TaskName, observation: SymbolicObservation): ProviderRunTarget | undefined {
  if (task !== "mine_cobblestone") return undefined;

  const startingCount = countInventory(observation.inventory, "cobblestone");
  if (startingCount < 1) return undefined;

  return {
    kind: "inventory_increment",
    task,
    item: "cobblestone",
    startingCount,
    requiredCount: startingCount + 1,
    increment: 1,
  };
}

function scoreRunTask(
  task: TaskName,
  observation: SymbolicObservation,
  runTarget: ProviderRunTarget | undefined,
): TaskScore {
  if (!runTarget) return scoreTask(task, observation);

  const count = countInventory(observation.inventory, runTarget.item);
  const progress = count - runTarget.startingCount;
  return {
    task,
    complete: count >= runTarget.requiredCount,
    score: Math.max(0, Math.min(1, progress / runTarget.increment)),
    evidence: {
      item: runTarget.item,
      count,
      startingCount: runTarget.startingCount,
      required: runTarget.requiredCount,
      increment: runTarget.increment,
    },
  };
}

async function writeRunLogSnapshot(
  logPath: string,
  config: AppConfig,
  startedAt: Date,
  startedMs: number,
  events: RunEvent[],
  state: { lastActionResult?: ToolResult },
  bot: Bot,
  status: "running" | "complete" | "stopped",
  runTarget?: ProviderRunTarget,
): Promise<TaskScore> {
  const finalObservation = buildObservation(bot, state.lastActionResult);
  const finalScore = scoreRunTask(config.task, finalObservation, runTarget);
  const elapsedMs = Date.now() - startedMs;
  const endedAt = new Date();
  const summary = runSummary(events, finalScore, elapsedMs);
  const log = {
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    elapsedMs,
    status,
    config: {
      host: config.host,
      port: config.port,
      username: config.username,
      provider: config.provider,
      primaryModel: config.primaryModel,
      fallbackProvider: config.fallbackProvider,
      fallbackModel: config.fallbackModel,
      modelEscalationOrder: config.modelEscalationOrder,
      lockFallbackAfterUse: config.lockFallbackAfterUse,
      maxLlmRetriesPerStep: config.maxLlmRetriesPerStep,
      llmDecisionTimeoutMs: config.llmDecisionTimeoutMs,
      toolExecutionTimeoutMs: config.toolExecutionTimeoutMs,
      allowScriptedFixtures: config.allowScriptedFixtures,
      task: config.task,
      maxIterations: config.maxIterations,
    },
    runTarget,
    benchmarkEvidence: benchmarkEvidence(events, finalScore),
    summary,
    events,
    finalObservation,
    finalScore,
  };
  await writeFile(logPath, `${JSON.stringify(log, null, 2)}\n`, "utf8");
  return finalScore;
}

function modelTimeoutDecision(timeoutMs: number): LlmToolCallDecision {
  const error = structuredError(
    "model_timeout",
    `LLM decision exceeded ${timeoutMs}ms.`,
    true,
  );
  return {
    toolResult: {
      ok: false,
      message: error.message,
      error,
    },
    llmAttempts: [],
    retryCount: 0,
    validationErrors: [error],
  };
}

export async function chooseToolCallWithPolicy(
  config: AppConfig,
  input: ProviderInput,
  providerFactory: ProviderFactory = createProvider,
  lockedFallback?: FallbackDecision,
): Promise<LlmToolCallDecision> {
  const routes = lockedFallback ? [lockedFallback.to] : resolveModelRoutes(config);
  const llmAttempts: LlmAttemptEvent[] = [];
  const validationErrors: StructuredError[] = [];
  const previousOutputs: unknown[] = [];
  let fallbackDecision: FallbackDecision | undefined = lockedFallback
    ? {
      used: true,
      from: lockedFallback.from,
      to: lockedFallback.to,
      reason: `Locked fallback after prior primary failure: ${lockedFallback.reason}`,
      failedAttempts: lockedFallback.failedAttempts,
    }
    : undefined;

  for (let routeIndex = 0; routeIndex < routes.length; routeIndex += 1) {
    const route = routes[routeIndex];
    const provider = providerFactory(config, route);
    const isFallback = Boolean(lockedFallback) || routeIndex > 0;

    if (!lockedFallback && isFallback) {
      const primary = routes[0];
      fallbackDecision = {
        used: true,
        from: primary,
        to: route,
        reason: `Prior route(s) before ${route.provider}/${route.model} exhausted ${llmAttempts.length} attempt(s).`,
        failedAttempts: llmAttempts.length,
      };
    }

    for (let retry = 0; retry <= config.maxLlmRetriesPerStep; retry += 1) {
      const attemptInput: ProviderInput = {
        ...input,
        retry,
        validationErrors: validationErrors.length > 0 ? [...validationErrors] : undefined,
        previousOutputs: previousOutputs.length > 0 ? [...previousOutputs] : undefined,
      };
      const attempt: LlmAttemptEvent = {
        attempt: llmAttempts.length,
        retry,
        provider: provider.provider,
        model: provider.model,
        fallback: isFallback,
        fixture: provider.fixture,
        accepted: false,
        promptReference: provider.promptReference(attemptInput),
        elapsedMs: 0,
      };
      const attemptStartedMs = Date.now();

      let rawOutput: unknown;
      try {
        rawOutput = await providerCallWithTimeout(
          provider.nextToolCall(attemptInput),
          config.llmDecisionTimeoutMs,
          provider,
        );
      } catch (error) {
        attempt.elapsedMs = Date.now() - attemptStartedMs;
        const providerError = structuredError(
          "provider_error",
          errorMessage(error),
          true,
          { provider: provider.provider, model: provider.model },
        );
        attempt.providerError = providerError;
        validationErrors.push(providerError);
        llmAttempts.push(attempt);
        continue;
      }

      attempt.elapsedMs = Date.now() - attemptStartedMs;
      attempt.rawOutput = rawOutput;
      previousOutputs.push(rawOutput);

      const parsed = validateToolCall(rawOutput);
      if (!parsed.ok) {
        const normalized = normalizeArgsOnlyToolCall(rawOutput, parsed.error);
        if (!normalized) {
          attempt.validationError = parsed.error;
          validationErrors.push(parsed.error);
          llmAttempts.push(attempt);
          continue;
        }

        attempt.accepted = true;
        attempt.normalization = normalized;
        llmAttempts.push(attempt);
        return {
          toolCall: normalized.normalizedToolCall,
          normalization: normalized,
          promptReference: attempt.promptReference,
          providerOutput: rawOutput,
          llmAttempts,
          retryCount: Math.max(0, llmAttempts.length - 1),
          validationErrors,
          fallbackDecision,
          activeProvider: provider.provider,
          activeModel: provider.model,
          activeFixture: provider.fixture,
        };
      }

      attempt.accepted = true;
      llmAttempts.push(attempt);
      return {
        toolCall: parsed.value,
        promptReference: attempt.promptReference,
        providerOutput: rawOutput,
        llmAttempts,
        retryCount: Math.max(0, llmAttempts.length - 1),
        validationErrors,
        fallbackDecision,
        activeProvider: provider.provider,
        activeModel: provider.model,
        activeFixture: provider.fixture,
      };
    }
  }

  const lastError = validationErrors.at(-1)
    ?? structuredError("model_policy_error", "No model routes are configured.", true);
  const lastAttempt = llmAttempts.at(-1);
  return {
    toolResult: {
      ok: false,
      message: lastError.message,
      error: lastError,
    },
    promptReference: lastAttempt?.promptReference,
    providerOutput: previousOutputs.at(-1),
    llmAttempts,
    retryCount: Math.max(0, llmAttempts.length - 1),
    validationErrors,
    fallbackDecision,
    activeProvider: lastAttempt?.provider,
    activeModel: lastAttempt?.model,
    activeFixture: lastAttempt?.fixture,
  };
}

function llmDecisionBudgetMs(config: AppConfig, lockedFallback?: FallbackDecision): number {
  const routeCount = lockedFallback ? 1 : Math.max(1, resolveModelRoutes(config).length);
  return config.llmDecisionTimeoutMs * routeCount * (config.maxLlmRetriesPerStep + 1);
}

async function providerCallWithTimeout(
  work: Promise<unknown>,
  timeoutMs: number,
  provider: ModelProvider,
): Promise<unknown> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          timeout = undefined;
          reject(new Error(`Model route ${provider.provider}/${provider.model} exceeded ${timeoutMs}ms.`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    work.catch(() => undefined);
  }
}

export function benchmarkEvidence(events: RunEvent[], finalScore: TaskScore) {
  const scriptedAccepted = events.some((event) => event.llmAttempts?.some((attempt) => (
    attempt.fixture && attempt.accepted
  )));
  const nonFixtureAccepted = events.some((event) => event.llmAttempts?.some((attempt) => (
    !attempt.fixture && attempt.accepted
  )));

  let caveat: string | undefined;
  if (scriptedAccepted) {
    caveat = "Scripted provider is a fixture/control and is not accepted M1 benchmark evidence.";
  } else if (!finalScore.complete) {
    caveat = "Run did not complete the selected task and is not accepted M1 benchmark evidence.";
  } else if (!nonFixtureAccepted) {
    caveat = "No non-fixture LLM tool call was accepted, so this is not accepted M1 benchmark evidence.";
  }

  return {
    accepted: !caveat,
    caveat,
  };
}

function normalizeArgsOnlyToolCall(
  rawOutput: unknown,
  rawValidationError: StructuredError,
): ToolCallNormalization | undefined {
  if (!isRecord(rawOutput) || "tool" in rawOutput || "args" in rawOutput) return undefined;

  const candidate = argsOnlyCandidate(rawOutput);
  if (!candidate) return undefined;

  const parsed = validateToolCall(candidate.toolCall);
  if (!parsed.ok) return undefined;

  return {
    applied: true,
    source: "args_only_semantic_output",
    reason: candidate.reason,
    rawValidationError,
    normalizedToolCall: parsed.value,
  };
}

function argsOnlyCandidate(rawOutput: Record<string, unknown>):
  | { reason: string; toolCall: unknown }
  | undefined {
  if (hasOnlyKeys(rawOutput, ["block", "count", "maxDistance"])) {
    return {
      reason: "Args-only block/count/maxDistance output normalized to mine_block.",
      toolCall: { tool: "mine_block", args: pickArgs(rawOutput, ["block", "count", "maxDistance"]) },
    };
  }
  if (hasOnlyKeys(rawOutput, ["block", "maxDistance"])) {
    return {
      reason: "Args-only block/maxDistance output normalized to go_to_nearest_block.",
      toolCall: { tool: "go_to_nearest_block", args: pickArgs(rawOutput, ["block", "maxDistance"]) },
    };
  }
  if (hasOnlyKeys(rawOutput, ["item", "referenceBlock", "maxDistance"])) {
    return {
      reason: "Args-only item/referenceBlock/maxDistance output normalized to place_block.",
      toolCall: { tool: "place_block", args: pickArgs(rawOutput, ["item", "referenceBlock", "maxDistance"]) },
    };
  }
  if (hasOnlyKeys(rawOutput, ["item", "count"])) {
    return {
      reason: "Args-only item/count output normalized to craft_item.",
      toolCall: { tool: "craft_item", args: pickArgs(rawOutput, ["item", "count"]) },
    };
  }
  if (hasOnlyKeys(rawOutput, ["ticks"])) {
    return {
      reason: "Args-only ticks output normalized to wait.",
      toolCall: { tool: "wait", args: pickArgs(rawOutput, ["ticks"]) },
    };
  }
  return undefined;
}

function pickArgs(rawOutput: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.map((key) => [key, rawOutput[key]]));
}

function hasOnlyKeys(rawOutput: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(rawOutput);
  return keys.length === expected.length && expected.every((key) => key in rawOutput);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function runSummary(events: RunEvent[], finalScore: TaskScore, elapsedMs: number) {
  const acceptedAttempts = events.flatMap((event) => event.llmAttempts ?? [])
    .filter((attempt) => attempt.accepted);

  return {
    task: finalScore.task,
    complete: finalScore.complete,
    score: finalScore.score,
    totalIterations: events.length,
    elapsedMs,
    totalLlmAttempts: events.reduce((sum, event) => sum + (event.llmAttempts?.length ?? 0), 0),
    totalLlmRetries: events.reduce((sum, event) => sum + (event.retryCount ?? 0), 0),
    toolErrorCount: events.filter((event) => event.toolResult && !event.toolResult.ok).length,
    validationErrorCount: events.reduce((sum, event) => sum + (event.validationErrors?.length ?? 0), 0),
    acceptedModelCalls: acceptedAttempts.map((attempt) => ({
      provider: attempt.provider,
      model: attempt.model,
      fixture: attempt.fixture,
      fallback: attempt.fallback,
    })),
  };
}
