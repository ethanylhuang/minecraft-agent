import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Bot } from "mineflayer";
import {
  benchmarkAccepted,
  benchmarkRunUsername,
  benchmarkSummary,
  assertM1BenchmarkConfig,
  numberArg,
  stringArg,
  validateGemmaFailureEvidence,
  type BenchmarkRun,
} from "./benchmarkPolicy.js";
import { loadConfig, type AppConfig } from "./config.js";
import { errorMessage, failedResult, structuredError } from "./errors.js";
import { createMinecraftBot } from "./minecraft.js";
import { buildObservation } from "./observation.js";
import { runSummary, runTask } from "./runner.js";
import { scoreTask } from "./tasks.js";
import type { SymbolicObservation, TaskName, TaskScore } from "./types.js";

type RunLog = {
  benchmarkEvidence?: {
    accepted?: boolean;
    caveat?: string;
  };
  summary?: {
    acceptedModelCalls?: Array<{
      provider?: string;
      model?: string;
      fixture?: boolean;
      fallback?: boolean;
    }>;
  };
};

export type BenchmarkFailureLogOptions = {
  config: AppConfig;
  index: number;
  runTimeoutMs: number;
  startedAt: Date;
  error: unknown;
  partialLogPath?: string;
  bot?: Bot;
};

export type BenchmarkFailureLogResult = {
  logPath: string;
  score: TaskScore;
  caveat: string;
};

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const config = loadConfig(["--allow-scripted-fixtures", "false", ...argv]);
  const runs = numberArg(argv, "--runs", 3);
  const runTimeoutMs = numberArg(argv, "--run-timeout-ms", 600_000);
  const gemmaFailureEvidencePath = stringArg(argv, "--gemma-failure-evidence");
  const gemmaFailureEvidencePresent = gemmaFailureEvidencePath
    ? await evidenceFileAccepted(gemmaFailureEvidencePath)
    : false;
  const acceptanceOptions = { gemmaFailureEvidencePath, gemmaFailureEvidencePresent };
  const effectiveConfig = {
    ...config,
    lockFallbackAfterUse: gemmaFailureEvidencePresent && Boolean(config.fallbackModel),
  };

  assertM1BenchmarkConfig(effectiveConfig, runs);

  const startedAt = new Date();
  const results: BenchmarkRun[] = [];

  for (let index = 0; index < runs; index += 1) {
    const runStartedAt = new Date();
    const runConfig = {
      ...effectiveConfig,
      username: benchmarkRunUsername(effectiveConfig.username, index),
    };
    const partialLogPath = join(runConfig.logDir, `${new Date().toISOString().replace(/[:.]/g, "-")}_${runConfig.task}_run_${index + 1}.json`);
    let bot: Awaited<ReturnType<typeof createMinecraftBot>> | undefined;
    console.error(`m1 benchmark run ${index + 1}/${runs} starting as ${runConfig.username}`);
    try {
      bot = await createMinecraftBot(runConfig);
      const result = await withRunTimeout(
        runTask(bot, runConfig, { logPath: partialLogPath }),
        runTimeoutMs,
        `M1 benchmark run ${index + 1} exceeded ${runTimeoutMs}ms.`,
      );
      const log = JSON.parse(await readFile(result.logPath, "utf8")) as RunLog;
      const acceptedModelCalls = log.summary?.acceptedModelCalls ?? [];
      const runResult = {
        index,
        logPath: result.logPath,
        complete: result.score.complete,
        score: result.score.score,
        benchmarkAccepted: Boolean(log.benchmarkEvidence?.accepted),
        usedFallback: acceptedModelCalls.some((call) => call.fallback),
        caveat: log.benchmarkEvidence?.caveat,
      };
      results.push(runResult);
      console.error(`m1 benchmark run ${index + 1}/${runs} complete=${runResult.complete} accepted=${runResult.benchmarkAccepted} log=${runResult.logPath}`);
    } catch (error) {
      const failure = await writeBenchmarkFailureLog({
        config: runConfig,
        index,
        runTimeoutMs,
        startedAt: runStartedAt,
        error,
        partialLogPath,
        bot,
      });
      const runResult = {
        index,
        logPath: failure.logPath,
        complete: false,
        score: failure.score.score,
        benchmarkAccepted: false,
        caveat: failure.caveat,
      };
      results.push(runResult);
      console.error(`m1 benchmark run ${index + 1}/${runs} failed: ${runResult.caveat} log=${runResult.logPath}`);
    } finally {
      bot?.quit();
    }
  }

  const endedAt = new Date();
  const accepted = benchmarkAccepted(results, runs, acceptanceOptions);
  await mkdir(effectiveConfig.logDir, { recursive: true });
  const summaryPath = join(effectiveConfig.logDir, `${new Date().toISOString().replace(/[:.]/g, "-")}_m1_benchmark_summary.json`);
  await writeFile(summaryPath, `${JSON.stringify(
    benchmarkSummary(effectiveConfig, runs, results, startedAt, endedAt, acceptanceOptions),
    null,
    2,
  )}\n`, "utf8");

  console.log(JSON.stringify({ accepted, summaryPath, runs: results }, null, 2));
  return accepted ? 0 : 1;
}

export async function writeBenchmarkFailureLog(
  options: BenchmarkFailureLogOptions,
): Promise<BenchmarkFailureLogResult> {
  const { config, index, runTimeoutMs, startedAt, error, bot } = options;
  const endedAt = new Date();
  const elapsedMs = endedAt.getTime() - startedAt.getTime();
  const caveat = errorMessage(error);
  const lastActionResult = failedResult("benchmark_run_failed", caveat, false, { index, runTimeoutMs });
  let finalObservation: SymbolicObservation | undefined;
  let observationError: ReturnType<typeof structuredError> | undefined;

  if (bot) {
    try {
      finalObservation = buildObservation(bot, lastActionResult);
    } catch (observationFailure) {
      observationError = structuredError(
        "benchmark_observation_failed",
        errorMessage(observationFailure),
        false,
      );
    }
  }

  const observedScore = finalObservation ? scoreTask(config.task, finalObservation) : undefined;
  const finalScore = incompleteFailureScore(config.task, observedScore, caveat);
  const failure = structuredError("benchmark_run_failed", caveat, false, {
      index,
      runTimeoutMs,
      partialLogPath: options.partialLogPath,
      observationError,
      observedScore,
    });
  const log = {
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    elapsedMs,
    config: benchmarkLogConfig(config),
    benchmarkEvidence: {
      accepted: false,
      caveat,
    },
    failure,
    summary: runSummary([], finalScore, elapsedMs),
    events: [],
    finalObservation,
    finalScore,
  };

  await mkdir(config.logDir, { recursive: true });
  const logPath = join(config.logDir, `${new Date().toISOString().replace(/[:.]/g, "-")}_${config.task}_run_${index + 1}_failure.json`);
  await writeFile(logPath, `${JSON.stringify(log, null, 2)}\n`, "utf8");
  return { logPath, score: finalScore, caveat };
}

if (isMain()) {
  process.exit(await main());
}

async function evidenceFileAccepted(path: string): Promise<boolean> {
  let text: string;
  try {
    await access(path);
    text = await readFile(path, "utf8");
  } catch {
    throw new Error(`Gemma failure evidence file not found: ${path}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Gemma failure evidence file must be JSON: ${path}`);
  }

  const check = validateGemmaFailureEvidence(parsed);
  if (!check.accepted) {
    throw new Error(`Gemma failure evidence rejected: ${check.reason}`);
  }
  return true;
}

function withRunTimeout<T>(work: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  return new Promise<T>((resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    work.then(resolve, reject).finally(() => {
      if (timeout) clearTimeout(timeout);
    });
  });
}

function incompleteFailureScore(task: TaskName, observedScore: TaskScore | undefined, caveat: string): TaskScore {
  return {
    task,
    complete: false,
    score: observedScore?.score ?? 0,
    evidence: {
      ...(observedScore?.evidence ?? {}),
      failure: caveat,
    },
  };
}

function benchmarkLogConfig(config: AppConfig) {
  return {
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
  };
}

function isMain(): boolean {
  const entry = process.argv[1];
  return Boolean(entry) && import.meta.url === pathToFileURL(resolve(entry)).href;
}
