import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Bot } from "mineflayer";
import { loadConfig, type AppConfig } from "./config.js";
import { createMinecraftBot } from "./minecraft.js";
import { failedResult } from "./errors.js";
import { buildObservation } from "./observation.js";
import { smokeSteps, type SmokeProfile } from "./smokePlan.js";
import { withTimeout } from "./timeout.js";
import type { ToolResult } from "./types.js";
import { executeTool } from "./tools/execute.js";

type SmokeEvent = {
  step: number;
  name: string;
  toolCall: unknown;
  observationBefore: unknown;
  toolResult: ToolResult;
  observationAfter: unknown;
};

const SMOKE_STEP_TIMEOUT_MS = 120_000;

export async function runPrimitiveSmoke(
  bot: Bot,
  config: AppConfig,
  profile: SmokeProfile,
): Promise<{ ok: boolean; failedStep?: string; logPath: string }> {
  const startedAt = new Date();
  const startedMs = Date.now();
  const state: { stopRequested: boolean; lastActionResult?: ToolResult } = { stopRequested: false };
  const events: SmokeEvent[] = [];
  let failedStep: string | undefined;

  for (const [index, step] of smokeSteps(profile).entries()) {
    const observationBefore = buildObservation(bot, state.lastActionResult);
    const toolResult = await executeSmokeStep(bot, step.call, state);
    state.lastActionResult = toolResult;
    const observationAfter = buildObservation(bot, state.lastActionResult);

    events.push({
      step: index,
      name: step.name,
      toolCall: step.call,
      observationBefore,
      toolResult,
      observationAfter,
    });

    if (!toolResult.ok) {
      failedStep = step.name;
      break;
    }
  }

  await mkdir(config.logDir, { recursive: true });
  const logPath = join(config.logDir, `${new Date().toISOString().replace(/[:.]/g, "-")}_smoke_${profile}.json`);
  const endedAt = new Date();
  const elapsedMs = Date.now() - startedMs;
  await writeFile(logPath, `${JSON.stringify({
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    elapsedMs,
    profile,
    config: {
      host: config.host,
      port: config.port,
      username: config.username,
      version: config.version,
      logDir: config.logDir,
    },
    summary: {
      totalSteps: events.length,
      elapsedMs,
      toolErrorCount: events.filter((event) => !event.toolResult.ok).length,
    },
    events,
    ok: !failedStep,
    failedStep,
  }, null, 2)}\n`, "utf8");

  return { ok: !failedStep, failedStep, logPath };
}

async function executeSmokeStep(
  bot: Bot,
  call: SmokeEvent["toolCall"],
  state: { stopRequested: boolean; lastActionResult?: ToolResult },
): Promise<ToolResult> {
  return await withTimeout(
    executeTool(bot, call as Parameters<typeof executeTool>[1], state),
    SMOKE_STEP_TIMEOUT_MS,
    () => failedResult(
      "smoke_step_timeout",
      `Smoke step exceeded ${SMOKE_STEP_TIMEOUT_MS}ms.`,
      true,
    ),
  );
}

function parseProfile(argv: string[]): SmokeProfile {
  const profileArg = argv.find((arg) => arg.startsWith("--profile="));
  const profile = profileArg?.split("=", 2)[1];
  return profile === "early" ? "early" : "full";
}

const config = loadConfig();
const profile = parseProfile(process.argv.slice(2));
const bot = await createMinecraftBot(config);

try {
  const result = await runPrimitiveSmoke(bot, config, profile);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
} finally {
  bot.quit();
}
