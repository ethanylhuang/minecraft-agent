export type VerifyIssue = {
  code: string;
  message: string;
  path?: string;
};

export type VerifyResult = {
  ok: boolean;
  issues: VerifyIssue[];
};

export type RunLogReader = (logPath: string) => unknown;

export function verifyM1BenchmarkSummary(summary: unknown, readRunLog: RunLogReader): VerifyResult {
  const issues: VerifyIssue[] = [];
  if (!isObject(summary)) return fail("summary_invalid", "Benchmark summary must be a JSON object.");

  const requiredRuns = numberField(summary.requiredRuns);
  if (summary.accepted !== true) {
    issues.push(issue("summary_not_accepted", "Benchmark summary accepted must be true."));
  }
  if (requiredRuns < 3) {
    issues.push(issue("required_runs_low", "M1 requires at least 3 benchmark runs."));
  }

  const config = objectField(summary.config);
  if (!config) {
    issues.push(issue("config_missing", "Benchmark summary must include config."));
  } else {
    if (config.task !== "early_sequence") {
      issues.push(issue("task_invalid", "M1 benchmark task must be early_sequence."));
    }
    if (config.provider === "scripted") {
      issues.push(issue("provider_scripted", "Scripted provider cannot be accepted M1 evidence."));
    }
    if (!firstRouteIsGemma(config)) {
      issues.push(issue("gemma_first_missing", "First configured model route must be Gemma 4 31B."));
    }
  }

  const policy = objectField(summary.policy);
  const runs = arrayField(summary.runs);
  if (runs.length < requiredRuns) {
    issues.push(issue("run_count_low", `Expected at least ${requiredRuns} benchmark runs.`));
  }

  const fallbackUsed = Boolean(policy?.fallbackUsed ?? runs.some((run) => isObject(run) && run.usedFallback === true));
  if (fallbackUsed) {
    if (!policy?.gemmaFailureEvidencePresent || typeof policy.gemmaFailureEvidencePath !== "string") {
      issues.push(issue("fallback_evidence_missing", "Fallback-completed runs require Gemma failure evidence."));
    }
  }

  for (const [index, run] of runs.entries()) {
    verifyRunSummary(run, index, readRunLog, issues);
  }

  return { ok: issues.length === 0, issues };
}

function verifyRunSummary(
  run: unknown,
  index: number,
  readRunLog: RunLogReader,
  issues: VerifyIssue[],
): void {
  const prefix = `runs[${index}]`;
  if (!isObject(run)) {
    issues.push(issue("run_invalid", "Benchmark run entry must be an object.", prefix));
    return;
  }

  if (run.complete !== true) {
    issues.push(issue("run_incomplete", "Benchmark run must be complete.", prefix));
  }
  if (run.benchmarkAccepted !== true) {
    issues.push(issue("run_not_accepted", "Benchmark run must have benchmarkAccepted=true.", prefix));
  }
  if (typeof run.logPath !== "string" || run.logPath.length === 0) {
    issues.push(issue("run_log_missing", "Benchmark run must include logPath.", prefix));
    return;
  }

  let log: unknown;
  try {
    log = readRunLog(run.logPath);
  } catch (error) {
    issues.push(issue("run_log_unreadable", `Could not read run log: ${errorMessage(error)}`, run.logPath));
    return;
  }

  verifyRunLog(log, run.logPath, Boolean(run.usedFallback), issues);
}

function verifyRunLog(log: unknown, logPath: string, usedFallback: boolean, issues: VerifyIssue[]): void {
  if (!isObject(log)) {
    issues.push(issue("run_log_invalid", "Run log must be a JSON object.", logPath));
    return;
  }

  const config = objectField(log.config);
  if (!config) {
    issues.push(issue("run_config_missing", "Run log must include config.", logPath));
  } else {
    if (config.task !== "early_sequence") {
      issues.push(issue("run_task_invalid", "Run log task must be early_sequence.", logPath));
    }
    if (config.provider === "scripted" || config.allowScriptedFixtures === true) {
      issues.push(issue("run_fixture_enabled", "Accepted run log cannot use scripted fixtures.", logPath));
    }
  }

  const benchmarkEvidence = objectField(log.benchmarkEvidence);
  if (benchmarkEvidence?.accepted !== true) {
    issues.push(issue("run_evidence_not_accepted", "Run log benchmarkEvidence.accepted must be true.", logPath));
  }

  const finalScore = objectField(log.finalScore);
  if (finalScore?.complete !== true) {
    issues.push(issue("run_final_score_incomplete", "Run log finalScore.complete must be true.", logPath));
  }
  if (!isObject(log.finalObservation)) {
    issues.push(issue("run_final_observation_missing", "Run log must include finalObservation.", logPath));
  }

  const summary = objectField(log.summary);
  const acceptedModelCalls = arrayField(summary?.acceptedModelCalls);
  if (acceptedModelCalls.length === 0) {
    issues.push(issue("run_no_accepted_model_calls", "Run log must include accepted non-fixture model calls.", logPath));
  }
  if (acceptedModelCalls.some((call) => isObject(call) && call.fixture === true)) {
    issues.push(issue("run_fixture_model_call", "Accepted model calls must not be fixtures.", logPath));
  }
  if (!acceptedModelCalls.some((call) => isObject(call) && call.fixture === false)) {
    issues.push(issue("run_no_non_fixture_call", "Run log must include at least one accepted non-fixture model call.", logPath));
  }

  const events = arrayField(log.events);
  if (events.length === 0) {
    issues.push(issue("run_events_missing", "Run log must include events.", logPath));
    return;
  }
  if (!events.some((event) => isObject(event) && isObject(event.observation))) {
    issues.push(issue("run_observations_missing", "Run log events must include observations.", logPath));
  }

  const decisionEvents = events.filter((event) => isObject(event) && arrayField(event.llmAttempts).length > 0);
  if (decisionEvents.length === 0) {
    issues.push(issue("run_decisions_missing", "Run log must include LLM decision events.", logPath));
  }

  for (const [index, event] of decisionEvents.entries()) {
    verifyDecisionEvent(event, `${logPath}:events[${index}]`, issues);
  }

  if (usedFallback && !events.some((event) => isObject(event) && objectField(event.fallbackDecision)?.used === true)) {
    issues.push(issue("run_fallback_decision_missing", "Fallback run must include fallbackDecision.", logPath));
  }
}

function verifyDecisionEvent(event: unknown, path: string, issues: VerifyIssue[]): void {
  if (!isObject(event)) return;
  if (!isObject(event.promptReference)) {
    issues.push(issue("event_prompt_missing", "Decision event must include promptReference.", path));
  }
  if (!isObject(event.toolResult)) {
    issues.push(issue("event_tool_result_missing", "Decision event must include toolResult.", path));
  }
  if (typeof event.retryCount !== "number") {
    issues.push(issue("event_retry_count_missing", "Decision event must include retryCount.", path));
  }
  if (typeof event.activeProvider !== "string" || typeof event.activeModel !== "string") {
    issues.push(issue("event_active_model_missing", "Decision event must include active provider and model.", path));
  }

  const acceptedAttempts = arrayField(event.llmAttempts)
    .filter((attempt) => isObject(attempt) && attempt.accepted === true);
  if (acceptedAttempts.length > 0) {
    if (event.providerOutput === undefined) {
      issues.push(issue("event_raw_output_missing", "Accepted decision event must include raw providerOutput.", path));
    }
    if (!isObject(event.toolCall)) {
      issues.push(issue("event_tool_call_missing", "Accepted decision event must include validated toolCall.", path));
    }
  }
  if (acceptedAttempts.some((attempt) => isObject(attempt) && attempt.rawOutput === undefined)) {
    issues.push(issue("event_attempt_raw_output_missing", "Accepted LLM attempts must include rawOutput.", path));
  }
}

function issue(code: string, message: string, path?: string): VerifyIssue {
  return { code, message, path };
}

function fail(code: string, message: string): VerifyResult {
  return { ok: false, issues: [issue(code, message)] };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectField(value: unknown): Record<string, unknown> | undefined {
  return isObject(value) ? value : undefined;
}

function arrayField(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function numberField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function firstRouteIsGemma(config: Record<string, unknown>): boolean {
  const escalationOrder = arrayField(config.modelEscalationOrder);
  const firstEntry = escalationOrder.find((entry): entry is string => typeof entry === "string");
  const model = firstEntry ? firstEntry.split(":").at(-1) ?? "" : stringField(config.primaryModel);
  return isGemma4_31b(model);
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isGemma4_31b(model: string): boolean {
  const normalized = model.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return normalized.includes("gemma") && normalized.includes("4") && normalized.includes("31b");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
