import { describe, expect, it } from "vitest";
import { verifyM1BenchmarkSummary } from "../src/m1Verifier.js";

describe("M1 benchmark verifier", () => {
  it("accepts a complete auditable Gemma benchmark summary", () => {
    const logs = new Map([
      ["runs/run-1.json", runLog()],
      ["runs/run-2.json", runLog()],
      ["runs/run-3.json", runLog()],
    ]);

    const result = verifyM1BenchmarkSummary(summary(), (path) => logs.get(path));

    expect(result).toEqual({ ok: true, issues: [] });
  });

  it("rejects scripted, incomplete, and unauditable summaries", () => {
    const result = verifyM1BenchmarkSummary({
      accepted: false,
      requiredRuns: 2,
      config: {
        provider: "scripted",
        primaryModel: "scripted",
        task: "collect_logs",
        modelEscalationOrder: [],
      },
      runs: [{
        logPath: "runs/bad.json",
        complete: false,
        benchmarkAccepted: false,
      }],
    }, () => ({}));

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "summary_not_accepted",
      "required_runs_low",
      "task_invalid",
      "provider_scripted",
      "run_incomplete",
      "run_not_accepted",
    ]));
  });

  it("rejects non-empty failure logs as benchmark evidence", () => {
    const logs = new Map([
      ["runs/timeout-1.json", failureLog()],
      ["runs/timeout-2.json", failureLog()],
      ["runs/timeout-3.json", failureLog()],
    ]);
    const claimedSummary = {
      ...summary(),
      runs: [
        { logPath: "runs/timeout-1.json", complete: true, benchmarkAccepted: true },
        { logPath: "runs/timeout-2.json", complete: true, benchmarkAccepted: true },
        { logPath: "runs/timeout-3.json", complete: true, benchmarkAccepted: true },
      ],
    };

    const result = verifyM1BenchmarkSummary(claimedSummary, (path) => logs.get(path));

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "run_evidence_not_accepted",
      "run_final_score_incomplete",
      "run_no_accepted_model_calls",
      "run_events_missing",
    ]));
  });
});

function summary() {
  return {
    accepted: true,
    requiredRuns: 3,
    policy: { fallbackUsed: false },
    config: {
      provider: "gemini-compatible",
      primaryModel: "gemma-4-31b-it",
      task: "early_sequence",
      modelEscalationOrder: [],
    },
    runs: [
      { logPath: "runs/run-1.json", complete: true, benchmarkAccepted: true },
      { logPath: "runs/run-2.json", complete: true, benchmarkAccepted: true },
      { logPath: "runs/run-3.json", complete: true, benchmarkAccepted: true },
    ],
  };
}

function runLog() {
  return {
    config: {
      provider: "gemini-compatible",
      primaryModel: "gemma-4-31b-it",
      allowScriptedFixtures: false,
      task: "early_sequence",
    },
    benchmarkEvidence: { accepted: true },
    finalScore: { task: "early_sequence", complete: true, score: 1 },
    finalObservation: { inventory: [] },
    summary: {
      acceptedModelCalls: [{
        provider: "gemini-compatible",
        model: "gemma-4-31b-it",
        fixture: false,
        fallback: false,
      }],
    },
    events: [{
      observation: {},
      promptReference: {},
      providerOutput: { tool: "stop", args: {} },
      toolCall: { tool: "stop", args: {} },
      toolResult: { ok: true, message: "done" },
      retryCount: 0,
      activeProvider: "gemini-compatible",
      activeModel: "gemma-4-31b-it",
      llmAttempts: [{
        accepted: true,
        rawOutput: { tool: "stop", args: {} },
      }],
    }],
  };
}

function failureLog() {
  return {
    config: {
      provider: "gemini-compatible",
      primaryModel: "gemma-4-31b-it",
      allowScriptedFixtures: false,
      task: "early_sequence",
    },
    benchmarkEvidence: {
      accepted: false,
      caveat: "M1 benchmark run exceeded timeout.",
    },
    failure: {
      code: "benchmark_run_failed",
      retryable: false,
    },
    finalScore: {
      task: "early_sequence",
      complete: false,
      score: 0,
      evidence: { failure: "M1 benchmark run exceeded timeout." },
    },
    summary: { acceptedModelCalls: [] },
    events: [],
  };
}
