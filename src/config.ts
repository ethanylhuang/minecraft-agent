import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { TASKS } from "./tasks.js";
import type { TaskName } from "./types.js";

const ProviderSchema = z.enum(["scripted", "openai-compatible", "gemini-compatible"]);

const ConfigSchema = z.object({
  host: z.string().min(1).default("localhost"),
  port: z.coerce.number().int().positive().max(65535).default(25565),
  username: z.string().min(1).max(16).default("symbolic_agent"),
  version: z.string().optional(),
  provider: ProviderSchema.default("scripted"),
  primaryModel: z.string().min(1).default("scripted"),
  fallbackProvider: ProviderSchema.optional(),
  fallbackModel: z.string().min(1).optional(),
  modelEscalationOrder: z.array(z.string().min(1)).default([]),
  lockFallbackAfterUse: z.boolean().default(false),
  maxLlmRetriesPerStep: z.coerce.number().int().min(0).max(20).default(2),
  llmDecisionTimeoutMs: z.coerce.number().int().positive().max(600_000).default(60_000),
  toolExecutionTimeoutMs: z.coerce.number().int().positive().max(600_000).default(120_000),
  allowScriptedFixtures: z.boolean().default(true),
  task: z.enum(TASKS as [TaskName, ...TaskName[]]).default("early_sequence"),
  maxIterations: z.coerce.number().int().positive().max(500).default(80),
  logDir: z.string().min(1).default("runs"),
  resetCommands: z.array(z.string().min(1)).default([]),
  resetSpawn: z.string().min(1).optional(),
  resetWaitTicks: z.coerce.number().int().min(0).max(1200).default(20),
  openaiBaseUrl: z.string().url().default("https://api.openai.com/v1"),
  openaiApiKey: z.string().optional(),
  geminiBaseUrl: z.string().url().default("https://generativelanguage.googleapis.com/v1beta"),
  geminiApiKey: z.string().optional(),
});

export type AppConfig = z.infer<typeof ConfigSchema>;
export type ProviderKind = AppConfig["provider"];

export function loadConfig(argv = process.argv.slice(2), env = process.env): AppConfig {
  const effectiveEnv = env === process.env ? { ...readDotEnv(), ...env } : env;
  const args = parseArgs(argv);
  const provider = stringValue(args.provider ?? effectiveEnv.MODEL_PROVIDER);
  return ConfigSchema.parse({
    host: args.host ?? effectiveEnv.MC_HOST,
    port: args.port ?? effectiveEnv.MC_PORT,
    username: args.username ?? effectiveEnv.MC_USERNAME,
    version: args.version ?? effectiveEnv.MC_VERSION,
    provider,
    primaryModel: args["primary-model"] ?? effectiveEnv.PRIMARY_MODEL ?? args.model ?? effectiveEnv.MODEL ?? defaultPrimaryModel(provider),
    fallbackProvider: args["fallback-provider"] ?? effectiveEnv.FALLBACK_PROVIDER,
    fallbackModel: args["fallback-model"] ?? effectiveEnv.FALLBACK_MODEL,
    modelEscalationOrder: parseList(args["model-escalation-order"] ?? effectiveEnv.MODEL_ESCALATION_ORDER),
    lockFallbackAfterUse: parseBoolean(args["lock-fallback-after-use"] ?? effectiveEnv.LOCK_FALLBACK_AFTER_USE, false),
    maxLlmRetriesPerStep: args["max-llm-retries-per-step"]
      ?? args["max-llm-retries"]
      ?? effectiveEnv.MAX_LLM_RETRIES_PER_STEP
      ?? effectiveEnv.MAX_LLM_RETRIES,
    llmDecisionTimeoutMs: args["llm-timeout-ms"] ?? effectiveEnv.LLM_TIMEOUT_MS,
    toolExecutionTimeoutMs: args["tool-timeout-ms"] ?? effectiveEnv.TOOL_TIMEOUT_MS,
    allowScriptedFixtures: parseBoolean(args["allow-scripted-fixtures"] ?? effectiveEnv.ALLOW_SCRIPTED_FIXTURES, true),
    task: args.task ?? effectiveEnv.TASK,
    maxIterations: args["max-iterations"] ?? effectiveEnv.MAX_ITERATIONS,
    logDir: args["log-dir"] ?? effectiveEnv.LOG_DIR,
    resetCommands: parseList(args["reset-commands"] ?? effectiveEnv.RESET_COMMANDS),
    resetSpawn: args["reset-spawn"] ?? effectiveEnv.RESET_SPAWN,
    resetWaitTicks: args["reset-wait-ticks"] ?? effectiveEnv.RESET_WAIT_TICKS,
    openaiBaseUrl: args["openai-base-url"] ?? effectiveEnv.OPENAI_BASE_URL,
    openaiApiKey: args["openai-api-key"] ?? effectiveEnv.OPENAI_API_KEY,
    geminiBaseUrl: args["gemini-base-url"] ?? effectiveEnv.GEMINI_BASE_URL,
    geminiApiKey: args["gemini-api-key"] ?? effectiveEnv.GEMINI_API_KEY,
  });
}

function readDotEnv(): NodeJS.ProcessEnv {
  if (!existsSync(".env")) return {};
  const values: NodeJS.ProcessEnv = {};
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = unquoteEnvValue(trimmed.slice(separator + 1).trim());
    values[key] = value;
  }
  return values;
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const parsed: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;

    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    const next = argv[index + 1];
    if (inlineValue !== undefined) {
      parsed[rawKey] = inlineValue;
    } else if (next && !next.startsWith("--")) {
      parsed[rawKey] = next;
      index += 1;
    } else {
      parsed[rawKey] = true;
    }
  }
  return parsed;
}

function defaultPrimaryModel(provider?: string): string {
  if (provider === "openai-compatible") return "gemma-4-31b";
  if (provider === "gemini-compatible") return "gemini-3.1-flash";
  return "scripted";
}

function parseList(value: string | boolean | undefined): string[] | undefined {
  if (typeof value !== "string") return undefined;
  const entries = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  return entries.length > 0 ? entries : undefined;
}

function parseBoolean(value: string | boolean | undefined, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function stringValue(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function unquoteEnvValue(value: string): string {
  if ((value.startsWith("\"") && value.endsWith("\""))
    || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}
