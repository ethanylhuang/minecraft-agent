import type { AppConfig } from "./config.js";

export type BenchmarkRun = {
  index: number;
  logPath: string;
  complete: boolean;
  score: number;
  benchmarkAccepted: boolean;
  usedFallback?: boolean;
  caveat?: string;
};

export type BenchmarkAcceptanceOptions = {
  gemmaFailureEvidencePresent?: boolean;
};

export type BenchmarkSummaryOptions = BenchmarkAcceptanceOptions & {
  gemmaFailureEvidencePath?: string;
};

export type GemmaFailureEvidenceCheck = {
  accepted: boolean;
  reason?: string;
};

export function assertM1BenchmarkConfig(config: AppConfig, runs: number): void {
  if (runs < 3) {
    throw new Error("M1 benchmark requires at least 3 runs.");
  }
  if (config.task !== "early_sequence") {
    throw new Error("M1 benchmark must run task early_sequence.");
  }
  if (config.provider === "scripted") {
    throw new Error("M1 benchmark requires a real LLM provider, not scripted.");
  }
  if (config.allowScriptedFixtures) {
    throw new Error("M1 benchmark requires allowScriptedFixtures=false.");
  }
  const firstRoute = firstConfiguredRoute(config);
  if (firstRoute.provider === "scripted") {
    throw new Error("M1 benchmark requires the first model route to be a real LLM provider.");
  }
  if (!isGemma4_31b(firstRoute.model)) {
    throw new Error("M1 benchmark requires Gemma 4 31B as the first model route.");
  }
}

export function benchmarkAccepted(
  results: BenchmarkRun[],
  requiredRuns = 1,
  options: BenchmarkAcceptanceOptions = {},
): boolean {
  return results.length >= requiredRuns
    && results.every((result) => result.complete && result.benchmarkAccepted)
    && (!results.some((result) => result.usedFallback) || Boolean(options.gemmaFailureEvidencePresent));
}

export function benchmarkSummary(
  config: AppConfig,
  runs: number,
  results: BenchmarkRun[],
  startedAt: Date,
  endedAt: Date,
  options: BenchmarkSummaryOptions = {},
) {
  return {
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    elapsedMs: endedAt.getTime() - startedAt.getTime(),
    accepted: benchmarkAccepted(results, runs, options),
    requiredRuns: runs,
    policy: {
      gemmaFailureEvidencePath: options.gemmaFailureEvidencePath,
      gemmaFailureEvidencePresent: Boolean(options.gemmaFailureEvidencePresent),
      fallbackUsed: results.some((result) => result.usedFallback),
    },
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
      task: config.task,
    },
    runs: results,
  };
}

export function numberArg(argv: string[], name: string, fallback: number): number {
  const inline = argv.find((value) => value.startsWith(`${name}=`));
  if (inline) return positiveInteger(inline.split("=", 2)[1], fallback);

  const index = argv.indexOf(name);
  if (index >= 0) return positiveInteger(argv[index + 1], fallback);
  return fallback;
}

export function stringArg(argv: string[], name: string): string | undefined {
  const inline = argv.find((value) => value.startsWith(`${name}=`));
  if (inline) return nonEmptyString(inline.split("=", 2)[1]);

  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  return nonEmptyString(argv[index + 1]);
}

export function benchmarkRunUsername(baseUsername: string, index: number): string {
  const suffix = String(index + 1);
  return `${baseUsername.slice(0, Math.max(1, 16 - suffix.length))}${suffix}`;
}

export function validateGemmaFailureEvidence(value: unknown): GemmaFailureEvidenceCheck {
  if (!isObject(value)) return rejectEvidence("Evidence must be a JSON object.");

  const manifest = value;
  const evidenceLogs = stringArray(manifest.evidenceLogs);
  if (isGemma4_31b(stringField(manifest.primaryModel))
    && numberField(manifest.failedRuns) >= 3
    && evidenceLogs.length >= 3
    && stringArray(manifest.repeatableFailures).length >= 1) {
    return { accepted: true };
  }

  return rejectEvidence(
    "Evidence must be a manifest with Gemma 4 31B primaryModel, at least 3 failedRuns, at least 3 evidenceLogs, and repeatableFailures.",
  );
}

function rejectEvidence(reason: string): GemmaFailureEvidenceCheck {
  return { accepted: false, reason };
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonEmptyString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function firstConfiguredRoute(config: AppConfig): { provider: AppConfig["provider"]; model: string } {
  const firstEntry = config.modelEscalationOrder[0];
  if (!firstEntry) return { provider: config.provider, model: config.primaryModel };

  const separator = firstEntry.indexOf(":");
  if (separator < 0) return { provider: config.provider, model: firstEntry };

  const provider = firstEntry.slice(0, separator);
  const model = firstEntry.slice(separator + 1);
  if (!isProviderKind(provider) || model.trim().length === 0) {
    throw new Error(`Invalid model escalation entry: ${firstEntry}`);
  }
  return { provider, model };
}

function isProviderKind(value: string): value is AppConfig["provider"] {
  return value === "scripted" || value === "openai-compatible" || value === "gemini-compatible";
}

function isGemma4_31b(model: string): boolean {
  const normalized = model.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return normalized.includes("gemma") && normalized.includes("4") && normalized.includes("31b");
}
