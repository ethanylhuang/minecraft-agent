import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeBenchmarkFailureLog } from "../src/benchmark.js";
import { loadConfig } from "../src/config.js";
import {
  assertM1BenchmarkConfig,
  benchmarkAccepted,
  benchmarkRunUsername,
  benchmarkSummary,
  numberArg,
  stringArg,
  validateGemmaFailureEvidence,
  type BenchmarkRun,
} from "../src/benchmarkPolicy.js";

describe("M1 benchmark policy", () => {
  it("rejects scripted, short, fixture-enabled, and non-M1 benchmark configs", () => {
    expect(() => assertM1BenchmarkConfig(loadConfig([], {}), 3))
      .toThrow("real LLM provider");

    const realConfig = loadConfig([
      "--provider", "openai-compatible",
      "--primary-model", "gemma-4-31b",
      "--allow-scripted-fixtures", "false",
    ], {});

    expect(() => assertM1BenchmarkConfig(realConfig, 2))
      .toThrow("at least 3 runs");

    expect(() => assertM1BenchmarkConfig(loadConfig([
      "--provider", "openai-compatible",
      "--task", "collect_logs",
      "--allow-scripted-fixtures", "false",
    ], {}), 3)).toThrow("early_sequence");

    expect(() => assertM1BenchmarkConfig(loadConfig([
      "--provider", "openai-compatible",
      "--allow-scripted-fixtures", "true",
    ], {}), 3)).toThrow("allowScriptedFixtures=false");

    expect(() => assertM1BenchmarkConfig(loadConfig([
      "--provider", "gemini-compatible",
      "--primary-model", "gemini-3.1-flash",
      "--allow-scripted-fixtures", "false",
    ], {}), 3)).toThrow("Gemma 4 31B");

    expect(() => assertM1BenchmarkConfig(loadConfig([
      "--provider", "openai-compatible",
      "--primary-model", "gemma-4-31b",
      "--model-escalation-order", "gemini-compatible:gemini-3.1-flash,openai-compatible:gemma-4-31b",
      "--allow-scripted-fixtures", "false",
    ], {}), 3)).toThrow("first model route");

    expect(() => assertM1BenchmarkConfig(loadConfig([
      "--provider", "openai-compatible",
      "--primary-model", "gemma-4-31b",
      "--model-escalation-order", "openai-compatible:gemma-4-31b,gemini-compatible:gemini-3.1-flash",
      "--allow-scripted-fixtures", "false",
    ], {}), 3)).not.toThrow();

    expect(() => assertM1BenchmarkConfig(realConfig, 3)).not.toThrow();
  });

  it("accepts only complete benchmark-accepted run sets", () => {
    const acceptedRuns: BenchmarkRun[] = [
      run(0, true, true),
      run(1, true, true),
      run(2, true, true),
    ];

    expect(benchmarkAccepted([])).toBe(false);
    expect(benchmarkAccepted(acceptedRuns)).toBe(true);
    expect(benchmarkAccepted([run(0, true, true), run(1, true, true)], 3))
      .toBe(false);
    expect(benchmarkAccepted([run(0, true, true), run(1, false, true), run(2, true, true)]))
      .toBe(false);
    expect(benchmarkAccepted([run(0, true, true), run(1, true, false), run(2, true, true)]))
      .toBe(false);
    expect(benchmarkAccepted([
      run(0, true, true),
      run(1, true, true, true),
      run(2, true, true),
    ], 3)).toBe(false);
    expect(benchmarkAccepted([
      run(0, true, true),
      run(1, true, true, true),
      run(2, true, true),
    ], 3, { gemmaFailureEvidencePresent: true })).toBe(true);
  });

  it("builds an auditable summary and parses run counts", () => {
    const config = loadConfig([
      "--provider", "openai-compatible",
      "--primary-model", "gemma-4-31b",
      "--fallback-provider", "gemini-compatible",
      "--fallback-model", "gemini-3.1-flash",
      "--allow-scripted-fixtures", "false",
    ], {});
    const startedAt = new Date("2026-05-10T00:00:00.000Z");
    const endedAt = new Date("2026-05-10T00:00:03.000Z");
    const summary = benchmarkSummary(config, 3, [
      run(0, true, true),
      run(1, true, true),
      run(2, true, true),
    ], startedAt, endedAt);

    expect(summary).toMatchObject({
      startedAt: "2026-05-10T00:00:00.000Z",
      endedAt: "2026-05-10T00:00:03.000Z",
      elapsedMs: 3000,
      accepted: true,
      requiredRuns: 3,
      config: {
        provider: "openai-compatible",
        primaryModel: "gemma-4-31b",
        fallbackProvider: "gemini-compatible",
        fallbackModel: "gemini-3.1-flash",
        task: "early_sequence",
      },
    });

    const lockedSummary = benchmarkSummary({ ...config, lockFallbackAfterUse: true }, 3, [
      run(0, true, true, true),
      run(1, true, true, true),
      run(2, true, true, true),
    ], startedAt, endedAt, {
      gemmaFailureEvidencePath: "runs/gemma-failure.json",
      gemmaFailureEvidencePresent: true,
    });
    expect(lockedSummary.config.lockFallbackAfterUse).toBe(true);
    expect(lockedSummary.policy).toMatchObject({
      gemmaFailureEvidencePath: "runs/gemma-failure.json",
      gemmaFailureEvidencePresent: true,
      fallbackUsed: true,
    });

    expect(numberArg(["--runs", "4"], "--runs", 3)).toBe(4);
    expect(numberArg(["--runs=5"], "--runs", 3)).toBe(5);
    expect(numberArg(["--runs", "bad"], "--runs", 3)).toBe(3);
    expect(stringArg(["--gemma-failure-evidence", "runs/gemma-failure.json"], "--gemma-failure-evidence"))
      .toBe("runs/gemma-failure.json");
    expect(stringArg(["--gemma-failure-evidence=runs/gemma-failure.json"], "--gemma-failure-evidence"))
      .toBe("runs/gemma-failure.json");
    expect(benchmarkRunUsername("m1flash", 0)).toBe("m1flash1");
    expect(benchmarkRunUsername("sixteen_char_bot", 11)).toHaveLength(16);
  });

  it("keeps failed run entries from being accepted", () => {
    expect(benchmarkAccepted([
      {
        index: 0,
        logPath: "",
        complete: false,
        score: 0,
        benchmarkAccepted: false,
        caveat: "Bot spawn exceeded 60000ms.",
      },
    ], 3)).toBe(false);
  });

  it("writes auditable failure logs without accepting failed runs", async () => {
    const logDir = await mkdtemp(join(tmpdir(), "minecraft-agent-m1-"));
    try {
      const config = loadConfig([
        "--provider", "gemini-compatible",
        "--primary-model", "gemma-4-31b-it",
        "--allow-scripted-fixtures", "false",
        "--log-dir", logDir,
      ], {});
      const result = await writeBenchmarkFailureLog({
        config,
        index: 0,
        runTimeoutMs: 10,
        startedAt: new Date("2026-05-10T00:00:00.000Z"),
        error: new Error("M1 benchmark run 1 exceeded 10ms."),
      });

      expect(result.logPath.length).toBeGreaterThan(0);
      expect(result.score.complete).toBe(false);

      const log = JSON.parse(await readFile(result.logPath, "utf8"));
      expect(log).toMatchObject({
        config: {
          provider: "gemini-compatible",
          primaryModel: "gemma-4-31b-it",
          allowScriptedFixtures: false,
          task: "early_sequence",
        },
        benchmarkEvidence: {
          accepted: false,
          caveat: "M1 benchmark run 1 exceeded 10ms.",
        },
        failure: {
          code: "benchmark_run_failed",
          retryable: false,
        },
        summary: {
          complete: false,
          acceptedModelCalls: [],
        },
        events: [],
        finalScore: {
          task: "early_sequence",
          complete: false,
          score: 0,
          evidence: {
            failure: "M1 benchmark run 1 exceeded 10ms.",
          },
        },
      });
      expect(benchmarkAccepted([{
        index: 0,
        logPath: result.logPath,
        complete: false,
        score: result.score.score,
        benchmarkAccepted: false,
      }], 3)).toBe(false);
    } finally {
      await rm(logDir, { recursive: true, force: true });
    }
  });

  it("accepts only concrete Gemma failure evidence", () => {
    expect(validateGemmaFailureEvidence({
      primaryModel: "gemma-4-31b",
      failedRuns: 3,
      evidenceLogs: [
        "runs/gemma-failure-1.json",
        "runs/gemma-failure-2.json",
        "runs/gemma-failure-3.json",
      ],
      repeatableFailures: ["invalid tool calls within retry budget"],
    })).toEqual({ accepted: true });

    expect(validateGemmaFailureEvidence({
      primaryModel: "gemma-4-31b",
      failedRuns: 1,
      evidenceLogs: ["runs/gemma-failure-1.json"],
      repeatableFailures: ["invalid tool calls within retry budget"],
    }).accepted).toBe(false);

    expect(validateGemmaFailureEvidence({
      primaryModel: "gemini-3.1-flash",
      failedRuns: 3,
      evidenceLogs: ["runs/failure.json"],
      repeatableFailures: ["looped"],
    }).accepted).toBe(false);

    expect(validateGemmaFailureEvidence({
      config: { primaryModel: "gemma-4-31b" },
      finalScore: { complete: false },
    }).accepted).toBe(false);
  });
});

function run(index: number, complete: boolean, accepted: boolean, usedFallback = false): BenchmarkRun {
  return {
    index,
    logPath: `runs/run-${index}.json`,
    complete,
    score: complete ? 1 : 0,
    benchmarkAccepted: accepted,
    usedFallback,
  };
}
