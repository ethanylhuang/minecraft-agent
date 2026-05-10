import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Bot } from "mineflayer";
import { loadConfig, type AppConfig } from "./config.js";
import { failedResult } from "./errors.js";
import { resetBotState, type ResetResult } from "./demoReset.js";
import { createMinecraftBot } from "./minecraft.js";
import { buildObservation } from "./observation.js";
import { runTask } from "./runner.js";
import { smokeSteps, type SmokeProfile } from "./smokePlan.js";
import { scoreTask, TASKS } from "./tasks.js";
import { withTimeout } from "./timeout.js";
import type { RunControlState, SymbolicObservation, TaskName, TaskScore, ToolResult } from "./types.js";
import { executeTool } from "./tools/execute.js";
import { validateToolCall, type ToolCall } from "./tools/schema.js";

type ViewerAttach = (bot: unknown, options: { port: number; firstPerson?: boolean; viewDistance?: number }) => void;

type DemoMode = "llm" | "smoke";

type SmokeEvent = {
  step: number;
  name: string;
  toolCall: ToolCall;
  toolResult: ToolResult;
  observationBefore: unknown;
  observationAfter: unknown;
  scoreBefore?: TaskScore;
  scoreAfter?: TaskScore;
  elapsedMs: number;
};

type DashboardActivity = {
  status: "idle" | "resetting" | "running" | "stopping" | "stopped" | "complete" | "failed";
  kind?: "llm_task" | "smoke_plan" | "tool_call" | "reset";
  label?: string;
  message?: string;
  logPath?: string;
  startedAt?: string;
  endedAt?: string;
};

type DashboardControlEvent = {
  iteration: number;
  source: "dashboard";
  name: string;
  score: TaskScore;
  scoreBefore: TaskScore;
  scoreAfter: TaskScore;
  toolCall: ToolCall;
  toolResult: ToolResult;
  observationBefore: SymbolicObservation;
  observationAfter: SymbolicObservation;
  inventoryBefore: SymbolicObservation["inventory"];
  inventoryAfter: SymbolicObservation["inventory"];
  elapsedMs: number;
};

type DashboardResetEvent = {
  iteration: number;
  source: "dashboard";
  name: string;
  toolResult: ResetResult;
  observationAfter?: SymbolicObservation;
  elapsedMs: number;
};

type DashboardContext = {
  bot: Bot;
  config: AppConfig;
  mode: DemoMode;
  profile: SmokeProfile;
  logPath: string;
  controlLogPath: string;
  viewerPort: number;
  startedAt: Date;
  selectedTask: TaskName;
  stepDelayMs: number;
  controlState: RunControlState;
  controlEvents: DashboardControlEvent[];
  resetEvents: DashboardResetEvent[];
  activity: DashboardActivity;
  activeOperation?: Promise<void>;
  lastActivityAt: number;
};

const require = createRequire(import.meta.url);
const { mineflayer: attachViewer } = require("prismarine-viewer") as { mineflayer: ViewerAttach };

const argv = process.argv.slice(2);
const mode = parseMode(argv);
const config = loadConfig(mode === "llm"
  ? ["--provider", "gemini-compatible", "--primary-model", "gemma-4-31b-it", ...argv]
  : argv);
const viewerPort = numberArg("--viewer-port", 3007);
const dashboardPort = numberArg("--dashboard-port", 3008);
const stepDelayMs = numberArg("--step-delay-ms", 1500);
const holdOpenMs = numberArg("--hold-open-ms", 300000);
const autoRun = booleanArg("--auto-run", true);
const profile = stringArg("--profile", "full") === "early" ? "early" : "full";
const logPath = join(config.logDir, `${new Date().toISOString().replace(/[:.]/g, "-")}_demo_${mode}.json`);
const controlLogPath = join(config.logDir, `${new Date().toISOString().replace(/[:.]/g, "-")}_demo_controls.json`);

const bot = await createMinecraftBot(config);
attachViewer(bot, { port: viewerPort, firstPerson: true, viewDistance: 6 });
const context: DashboardContext = {
  bot,
  config,
  mode,
  profile,
  logPath,
  controlLogPath,
  viewerPort,
  startedAt: new Date(),
  selectedTask: config.task,
  stepDelayMs,
  controlState: { stopRequested: false },
  controlEvents: [],
  resetEvents: [],
  activity: { status: "idle", message: "Ready." },
  lastActivityAt: Date.now(),
};
const dashboard = createDashboardServer(context);
await listen(dashboard, dashboardPort);

console.log(`Viewer: http://localhost:${viewerPort}`);
console.log(`Dashboard: http://localhost:${dashboardPort}`);
console.log(`Bot: ${config.username} connected to ${config.host}:${config.port}`);
console.log(`Mode: ${mode}`);
console.log(`Auto-run: ${autoRun}`);

try {
  if (autoRun) {
    if (mode === "llm") {
      beginLlmTask(context, config.task, config.maxIterations);
    } else {
      beginSmokePlan(context, profile);
    }
  }
  await holdDashboardOpen(context, holdOpenMs);
} finally {
  dashboard.close();
  bot.quit();
}

async function holdDashboardOpen(context: DashboardContext, holdOpenMs: number): Promise<void> {
  while (Date.now() - context.lastActivityAt < holdOpenMs || context.activeOperation) {
    await context.bot.waitForTicks(20);
  }
}

function beginLlmTask(context: DashboardContext, task: TaskName, maxIterations: number): boolean {
  if (context.activeOperation) return false;
  const runConfig: AppConfig = { ...context.config, task, maxIterations };
  const logPath = demoLogPath(runConfig.logDir, `demo_llm_${task}`);
  context.logPath = logPath;
  context.selectedTask = task;

  return beginOperation(context, {
    kind: "llm_task",
    label: `LLM task: ${task}`,
    logPath,
  }, async () => {
    const result = await runTask(context.bot, runConfig, { logPath, controlState: context.controlState });
    console.log(`Demo log: ${result.logPath}`);
    console.log(result.score.complete ? "Demo complete." : "Demo failed at: llm task");
    if (result.status === "stopped") {
      return {
        ok: false,
        status: "stopped",
        message: context.controlState.stopReason ?? "Task stopped.",
        logPath: result.logPath,
      };
    }
    return {
      ok: result.score.complete,
      message: result.score.complete ? "Task complete." : "Task incomplete.",
      logPath: result.logPath,
    };
  });
}

function beginSmokePlan(context: DashboardContext, profile: SmokeProfile): boolean {
  if (context.activeOperation) return false;
  const logPath = demoLogPath(context.config.logDir, `demo_smoke_${profile}`);
  context.logPath = logPath;

  return beginOperation(context, {
    kind: "smoke_plan",
    label: `Smoke plan: ${profile}`,
    logPath,
  }, async () => {
    const result = await runSmokeDemo(
      context.bot,
      context.config,
      profile,
      context.stepDelayMs,
      logPath,
      context.controlState,
    );
    console.log(`Demo log: ${result.logPath}`);
    console.log(result.ok ? "Demo complete." : `Demo failed at: ${result.failedStep ?? "smoke plan"}`);
    return {
      ok: result.ok,
      status: result.stopped ? "stopped" : undefined,
      message: result.stopped
        ? "Smoke plan stopped."
        : (result.ok ? "Smoke plan complete." : `Smoke plan failed at ${result.failedStep ?? "unknown step"}.`),
      logPath: result.logPath,
    };
  });
}

function beginToolCall(context: DashboardContext, toolCall: ToolCall, name?: string): boolean {
  if (context.activeOperation) return false;
  const label = name ?? toolCall.tool;
  return beginOperation(context, {
    kind: "tool_call",
    label: `Tool call: ${label}`,
    logPath: context.controlLogPath,
  }, async () => {
    const startedMs = Date.now();
    const observationBefore = buildObservation(context.bot, context.controlState.lastActionResult);
    const scoreBefore = scoreTask(context.selectedTask, observationBefore);
    const toolResult = await withTimeout(
      executeTool(context.bot, toolCall, context.controlState),
      context.config.toolExecutionTimeoutMs,
      () => {
        context.bot.pathfinder?.stop();
        return failedResult(
          "tool_timeout",
          `Tool ${toolCall.tool} exceeded ${context.config.toolExecutionTimeoutMs}ms.`,
          true,
        );
      },
    );
    context.controlState.lastActionResult = toolResult;
    const observationAfter = buildObservation(context.bot, context.controlState.lastActionResult);
    const scoreAfter = scoreTask(context.selectedTask, observationAfter);
    const event: DashboardControlEvent = {
      iteration: context.controlEvents.length,
      source: "dashboard",
      name: label,
      score: scoreAfter,
      scoreBefore,
      scoreAfter,
      toolCall,
      toolResult,
      observationBefore,
      observationAfter,
      inventoryBefore: observationBefore.inventory,
      inventoryAfter: observationAfter.inventory,
      elapsedMs: Date.now() - startedMs,
    };
    context.controlEvents.push(event);
    context.controlEvents = context.controlEvents.slice(-200);
    await writeControlLog(context);
    return {
      ok: toolResult.ok,
      status: toolResult.error?.code === "stopped" ? "stopped" : undefined,
      message: toolResult.message,
      logPath: context.controlLogPath,
    };
  });
}

function beginReset(context: DashboardContext): boolean {
  if (context.activeOperation) return false;
  return beginOperation(context, {
    kind: "reset",
    label: "Reset State",
    logPath: context.controlLogPath,
  }, async () => runReset(context, "Manual reset"));
}

function requestStop(context: DashboardContext, reason = "Stop requested from dashboard."): boolean {
  context.controlState.stopRequested = true;
  context.controlState.stopReason = reason;
  context.bot.pathfinder?.stop();
  context.lastActivityAt = Date.now();
  if (!context.activeOperation) {
    context.activity = {
      status: "stopped",
      kind: context.activity.kind,
      label: context.activity.label ?? "Stop Agent",
      message: reason,
      logPath: context.activity.logPath,
      startedAt: context.activity.startedAt,
      endedAt: new Date().toISOString(),
    };
    return true;
  }
  context.activity = {
    ...context.activity,
    status: "stopping",
    message: reason,
  };
  return true;
}

async function runReset(
  context: DashboardContext,
  label: string,
): Promise<{ ok: boolean; status?: DashboardActivity["status"]; message: string; logPath: string }> {
  const priorActivity = context.activity;
  context.activity = {
    ...priorActivity,
    status: "resetting",
    label,
    message: "Resetting bot and configured world state.",
    logPath: context.controlLogPath,
  };

  const startedMs = Date.now();
  const result = await resetBotState(context.bot, context.config, context.controlState);
  const observationAfter = safeObservation(context.bot, context.controlState.lastActionResult);
  context.resetEvents.push({
    iteration: context.resetEvents.length,
    source: "dashboard",
    name: label,
    toolResult: result,
    observationAfter,
    elapsedMs: Date.now() - startedMs,
  });
  context.resetEvents = context.resetEvents.slice(-50);
  await writeControlLog(context);
  context.lastActivityAt = Date.now();

  return {
    ok: result.ok,
    status: result.ok ? "complete" : "failed",
    message: result.message,
    logPath: context.controlLogPath,
  };
}

function beginOperation(
  context: DashboardContext,
  activity: Omit<DashboardActivity, "status" | "startedAt">,
  work: () => Promise<{
    ok: boolean;
    status?: DashboardActivity["status"];
    message: string;
    logPath?: string;
  }>,
): boolean {
  if (context.activeOperation) return false;

  const startedAt = new Date().toISOString();
  context.lastActivityAt = Date.now();
  context.controlState.stopRequested = false;
  context.controlState.stopReason = undefined;
  context.activity = { ...activity, status: "running", startedAt };
  context.activeOperation = (async () => {
    try {
      const result = await work();
      const status = result.status ?? (result.ok ? "complete" : "failed");
      context.activity = {
        ...activity,
        status,
        startedAt,
        endedAt: new Date().toISOString(),
        message: result.message,
        logPath: result.logPath ?? activity.logPath,
      };
    } catch (error) {
      context.activity = {
        ...activity,
        status: "failed",
        startedAt,
        endedAt: new Date().toISOString(),
        message: error instanceof Error ? error.message : String(error),
        logPath: activity.logPath,
      };
    } finally {
      if (activity.kind === "tool_call" || activity.kind === "reset") {
        await writeControlLog(context).catch(() => undefined);
      }
      context.activeOperation = undefined;
      context.lastActivityAt = Date.now();
    }
  })();
  return true;
}

function demoLogPath(logDir: string, suffix: string): string {
  return join(logDir, `${new Date().toISOString().replace(/[:.]/g, "-")}_${suffix}.json`);
}

async function runSmokeDemo(
  bot: Bot,
  config: AppConfig,
  profile: SmokeProfile,
  delayMs: number,
  logPath: string,
  state: RunControlState,
): Promise<{ ok: boolean; failedStep?: string; logPath: string; stopped?: boolean }> {
  const events: SmokeEvent[] = [];
  let failedStep: string | undefined;
  let stopped = false;

  for (const [index, step] of smokeSteps(profile).entries()) {
    if (state.stopRequested) {
      stopped = true;
      failedStep = step.name;
      state.lastActionResult = failedResult("stopped", state.stopReason ?? "Smoke plan stopped.", false, {
        stopped: true,
      });
      break;
    }
    await sleep(delayMs);
    console.log(`[${index + 1}] ${step.name}: ${step.call.tool}`);
    const startedMs = Date.now();
    const observationBefore = buildObservation(bot, state.lastActionResult);
    const scoreBefore = scoreTask(config.task, observationBefore);
    const result = await executeTool(bot, step.call, state);
    state.lastActionResult = result;
    const observationAfter = buildObservation(bot, state.lastActionResult);
    const scoreAfter = scoreTask(config.task, observationAfter);
    const plannedStop = step.call.tool === "stop";
    if (plannedStop && result.ok) {
      state.stopRequested = false;
      state.stopReason = undefined;
    }
    stopped = !plannedStop && (result.error?.code === "stopped" || state.stopRequested);
    events.push({
      step: index,
      name: step.name,
      toolCall: step.call,
      toolResult: result,
      observationBefore,
      observationAfter,
      scoreBefore,
      scoreAfter,
      elapsedMs: Date.now() - startedMs,
    });
    await writeSmokeLog(config, profile, logPath, events, "running");
    console.log(`    ${result.ok ? "ok" : "error"}: ${result.message}`);

    if (!result.ok || stopped) {
      failedStep = step.name;
      break;
    }
  }

  await writeSmokeLog(config, profile, logPath, events, stopped ? "stopped" : (failedStep ? "failed" : "complete"), failedStep);
  return { ok: !failedStep, failedStep, logPath, stopped };
}

async function writeSmokeLog(
  config: AppConfig,
  profile: SmokeProfile,
  logPath: string,
  events: SmokeEvent[],
  status: "running" | "complete" | "failed" | "stopped",
  failedStep?: string,
): Promise<void> {
  await mkdir(config.logDir, { recursive: true });
  await writeFile(logPath, `${JSON.stringify({
    startedAt: new Date().toISOString(),
    status,
    profile,
    events,
    ok: status !== "failed",
    failedStep,
  }, null, 2)}\n`);
}

async function writeControlLog(context: DashboardContext): Promise<void> {
  await mkdir(context.config.logDir, { recursive: true });
  const finalObservation = buildObservation(context.bot, context.controlState.lastActionResult);
  await writeFile(context.controlLogPath, `${JSON.stringify({
    startedAt: context.startedAt.toISOString(),
    endedAt: new Date().toISOString(),
    status: context.activity.status,
    selectedTask: context.selectedTask,
    resetEvents: context.resetEvents,
    events: context.controlEvents,
    finalObservation,
    finalScore: scoreTask(context.selectedTask, finalObservation),
  }, null, 2)}\n`);
}

function createDashboardServer(context: DashboardContext) {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        sendHtml(response, dashboardHtml(context.viewerPort));
        return;
      }
      if (request.method === "GET" && url.pathname === "/state") {
        sendJson(response, await dashboardState(context));
        return;
      }
      if (request.method === "POST" && await handleControlRequest(context, request, response, url.pathname)) {
        return;
      }
      sendText(response, 404, "Not found");
    } catch (error) {
      sendJson(response, { error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });
}

async function handleControlRequest(
  context: DashboardContext,
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (pathname === "/control/task") {
    const body = objectField(await readRequestJson(request));
    const task = parseTaskName(body?.task) ?? context.selectedTask;
    const maxIterations = parsePositiveInt(body?.maxIterations, context.config.maxIterations, 500);
    const accepted = beginLlmTask(context, task, maxIterations);
    sendJson(response, { accepted, activity: context.activity }, accepted ? 202 : 409);
    return true;
  }

  if (pathname === "/control/smoke") {
    const body = objectField(await readRequestJson(request));
    const profile = body?.profile === "early" ? "early" : "full";
    const accepted = beginSmokePlan(context, profile);
    sendJson(response, { accepted, activity: context.activity }, accepted ? 202 : 409);
    return true;
  }

  if (pathname === "/control/tool") {
    const body = objectField(await readRequestJson(request));
    const toolInput = body?.toolCall ?? body;
    const parsed = validateToolCall(toolInput);
    if (!parsed.ok) {
      sendJson(response, { accepted: false, error: parsed.error }, 400);
      return true;
    }

    const accepted = beginToolCall(context, parsed.value, typeof body?.name === "string" ? body.name : undefined);
    sendJson(response, { accepted, activity: context.activity }, accepted ? 202 : 409);
    return true;
  }

  if (pathname === "/control/reset") {
    await readRequestJson(request);
    const accepted = beginReset(context);
    sendJson(response, { accepted, activity: context.activity }, accepted ? 202 : 409);
    return true;
  }

  if (pathname === "/control/stop") {
    const body = objectField(await readRequestJson(request));
    const reason = typeof body?.reason === "string" ? body.reason : undefined;
    const accepted = requestStop(context, reason);
    sendJson(response, { accepted, activity: context.activity }, 202);
    return true;
  }

  return false;
}

async function dashboardState(context: DashboardContext) {
  const log = await readJsonFile(context.logPath);
  const observation = safeObservation(context.bot, context.controlState.lastActionResult);
  const score = observation ? scoreTask(context.selectedTask, observation) : undefined;
  const logEvents = arrayField((log as { events?: unknown[] } | undefined)?.events);
  const actions = smokeSteps("full").map((step, index) => ({
    id: String(index),
    name: step.name,
    toolCall: step.call,
  }));
  const resetTimeline = context.resetEvents.map((event) => ({
    iteration: `reset-${event.iteration}`,
    name: event.name,
    toolCall: { tool: "reset_state", args: { configured: true } },
    toolResult: event.toolResult,
    observationAfter: event.observationAfter,
    inventoryAfter: event.observationAfter?.inventory,
    elapsedMs: event.elapsedMs,
  }));

  return {
    mode: context.mode,
    profile: context.profile,
    selectedTask: context.selectedTask,
    uptimeMs: Date.now() - context.startedAt.getTime(),
    viewerPort: context.viewerPort,
    logPath: context.logPath,
    controlLogPath: context.controlLogPath,
    activity: context.activity,
    reset: {
      configuredCommands: context.config.resetCommands.length,
      resetSpawn: context.config.resetSpawn,
      resetWaitTicks: context.config.resetWaitTicks,
      lastResult: context.resetEvents.at(-1)?.toolResult,
    },
    bot: {
      username: context.config.username,
      host: context.config.host,
      port: context.config.port,
      provider: context.config.provider,
      primaryModel: context.config.primaryModel,
      task: context.selectedTask,
    },
    inventory: observation?.inventory ?? [],
    observation,
    score,
    runStatus: context.activity.status === "idle" ? objectField(log)?.status : context.activity.status,
    finalScore: objectField(log)?.finalScore,
    llmTrace: logEvents.map(llmTraceEvent).filter(Boolean),
    toolCalls: [...logEvents, ...context.controlEvents, ...resetTimeline].map(toolCallEvent).filter(Boolean),
    controls: {
      busy: Boolean(context.activeOperation),
      stopping: context.activity.status === "stopping",
      tasks: TASKS,
      smokeProfiles: ["early", "full"],
      actions,
    },
    log,
  };
}

function llmTraceEvent(event: unknown) {
  if (!isObject(event)) return undefined;
  const attempts = arrayField(event.llmAttempts);
  if (attempts.length === 0 && !event.promptReference && event.providerOutput === undefined) return undefined;

  return {
    iteration: event.iteration,
    score: event.score,
    activeProvider: event.activeProvider,
    activeModel: event.activeModel,
    retryCount: event.retryCount,
    fallbackDecision: event.fallbackDecision,
    validationErrors: event.validationErrors,
    normalization: event.normalization,
    promptReference: event.promptReference,
    providerOutput: event.providerOutput,
    parsedToolCall: event.toolCall,
    toolResult: event.toolResult,
    toolElapsedMs: event.toolElapsedMs,
    attempts,
  };
}

function toolCallEvent(event: unknown) {
  if (!isObject(event)) return undefined;
  const toolCall = event.toolCall ?? event.tool;
  const toolResult = event.toolResult ?? event.result;
  if (!toolCall && !toolResult) return undefined;
  return {
    iteration: event.iteration ?? event.step,
    name: event.name,
    score: event.score,
    scoreBefore: event.scoreBefore,
    scoreAfter: event.scoreAfter,
    toolCall,
    toolResult,
    elapsedMs: event.elapsedMs ?? event.toolElapsedMs,
    inventoryBefore: event.inventoryBefore ?? objectField(event.observationBefore)?.inventory,
    inventoryAfter: event.inventoryAfter ?? objectField(event.observationAfter)?.inventory,
  };
}

function dashboardHtml(viewerPort: number): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Minecraft Agent Demo</title>
  <style>
    :root {
      color-scheme: dark;
      font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif;
      background: #000;
      color: #fafafa;
      --bg: #000;
      --panel: #050505;
      --panel-raised: #0a0a0a;
      --border: #262626;
      --border-strong: #3f3f46;
      --text: #fafafa;
      --muted: #a1a1aa;
      --faint: #71717a;
      --field: #0a0a0a;
      --field-hover: #111;
      --accent: #fff;
      --danger: #ef4444;
      --success: #22c55e;
    }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: var(--bg); }
    main {
      display: grid;
      grid-template-columns: minmax(420px, 1.15fr) minmax(420px, 0.85fr);
      min-height: 100vh;
    }
    iframe { width: 100%; height: 100vh; border: 0; background: #000; }
    .side {
      display: grid;
      grid-template-rows: auto 240px minmax(105px, 0.5fr) minmax(125px, 0.75fr) minmax(125px, 0.75fr);
      height: 100vh;
      min-height: 0;
      border-left: 1px solid var(--border);
      background: var(--bg);
      overflow: hidden;
    }
    header {
      display: grid;
      gap: 10px;
      padding: 16px 18px 14px;
      border-bottom: 1px solid var(--border);
      background: var(--panel);
    }
    h1 { margin: 0; font-size: 17px; font-weight: 650; letter-spacing: 0; color: var(--text); }
    .meta {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      color: var(--muted);
      font-size: 11px;
    }
    .pill {
      max-width: 100%;
      padding: 3px 8px;
      border: 1px solid var(--border);
      border-radius: 999px;
      background: #000;
      color: #d4d4d8;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    section {
      min-height: 0;
      overflow: auto;
      padding: 14px 18px;
      border-bottom: 1px solid var(--border);
      background: var(--bg);
    }
    h2 {
      margin: 0 0 12px;
      font-size: 12px;
      font-weight: 600;
      color: var(--text);
      letter-spacing: 0;
    }
    pre {
      margin: 0;
      padding: 12px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--panel);
      color: #e4e4e7;
      font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      overflow: auto;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .list { display: grid; gap: 10px; }
    .row {
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--panel);
      overflow: hidden;
    }
    .row-head {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      justify-content: space-between;
      padding: 9px 11px;
      border-bottom: 1px solid var(--border);
      color: #e4e4e7;
      font-size: 12px;
    }
    .ok { color: var(--success); }
    .bad { color: var(--danger); }
    details { padding: 8px 10px; }
    details.manual {
      padding: 0;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--panel);
    }
    summary {
      cursor: pointer;
      color: var(--muted);
      font-size: 12px;
      margin-bottom: 8px;
    }
    .manual summary {
      margin: 0;
      padding: 8px 10px;
      color: #e4e4e7;
      font-weight: 600;
    }
    .manual-grid {
      display: grid;
      gap: 8px;
      padding: 0 10px 10px;
    }
    .empty { color: var(--faint); font-size: 12px; }
    .controls {
      display: grid;
      gap: 12px;
      overflow: auto;
    }
    .control-grid {
      display: grid;
      grid-template-columns: minmax(120px, 1fr) minmax(90px, 0.55fr) auto;
      gap: 8px;
      align-items: end;
    }
    label {
      display: grid;
      gap: 5px;
      color: var(--muted);
      font-size: 12px;
      min-width: 0;
    }
    select, input, textarea, button {
      width: 100%;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--field);
      color: var(--text);
      font: inherit;
    }
    select, input, button {
      min-height: 34px;
      padding: 6px 10px;
    }
    select:hover, input:hover, textarea:hover { background: var(--field-hover); border-color: var(--border-strong); }
    select:focus, input:focus, textarea:focus, button:focus {
      outline: 2px solid #fff;
      outline-offset: 1px;
    }
    textarea {
      min-height: 76px;
      resize: vertical;
      padding: 8px;
      font: 12px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    button {
      cursor: pointer;
      background: var(--accent);
      border-color: var(--accent);
      color: #000;
      font-weight: 600;
      white-space: nowrap;
      transition: background 120ms ease, border-color 120ms ease, color 120ms ease, opacity 120ms ease;
    }
    button:hover:not(:disabled) { background: #e4e4e7; border-color: #e4e4e7; }
    button.secondary {
      background: #000;
      border-color: var(--border-strong);
      color: var(--text);
    }
    button.secondary:hover:not(:disabled) { background: #111; border-color: #a1a1aa; }
    button.danger {
      background: #000;
      border-color: #7f1d1d;
      color: #fca5a5;
    }
    button.danger:hover:not(:disabled) { background: #1f0b0b; border-color: var(--danger); }
    button:disabled {
      cursor: not-allowed;
      opacity: 0.5;
    }
    .wide { grid-column: 1 / -1; }
    .button-row {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
      align-items: center;
    }
    .status-line {
      color: var(--muted);
      font-size: 12px;
      min-height: 18px;
    }
    @media (max-width: 960px) {
      main { grid-template-columns: 1fr; }
      iframe { height: 48vh; }
      .side {
        height: auto;
        min-height: 52vh;
        overflow: visible;
        grid-template-rows: auto;
        border-left: 0;
        border-top: 1px solid var(--border);
      }
      section { max-height: 42vh; }
      section.controls { max-height: none; }
      .control-grid { grid-template-columns: 1fr; }
      .button-row { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main>
    <iframe src="http://localhost:${viewerPort}" title="Minecraft viewer"></iframe>
    <div class="side">
      <header>
        <h1>Minecraft Agent Demo</h1>
        <div id="meta" class="meta"></div>
      </header>
      <section class="controls">
        <h2>Run Controls</h2>
        <div class="control-grid">
          <div class="button-row wide">
            <button id="stopAgent" class="danger" type="button">Stop Agent</button>
            <button id="resetState" class="secondary" type="button">Reset State</button>
          </div>
          <label>Task
            <select id="taskSelect"></select>
          </label>
          <label>Iterations
            <input id="maxIterations" type="number" min="1" max="500" value="80">
          </label>
          <button id="runTask" type="button">Run LLM Task</button>
          <label>Smoke
            <select id="smokeSelect">
              <option value="early">early</option>
              <option value="full">full</option>
            </select>
          </label>
          <span></span>
          <button id="runSmoke" type="button">Run Smoke Plan</button>
          <details class="manual wide">
            <summary>Manual Tool Call</summary>
            <div class="manual-grid">
              <label>Action
                <select id="actionSelect"></select>
              </label>
              <label>Tool JSON
                <textarea id="toolJson" spellcheck="false"></textarea>
              </label>
              <button id="runTool" type="button">Run Tool Call</button>
            </div>
          </details>
        </div>
        <div id="controlStatus" class="status-line"></div>
      </section>
      <section>
        <h2>Inventory JSON</h2>
        <pre id="inventory">{}</pre>
      </section>
      <section>
        <h2>LLM Trace</h2>
        <div id="trace" class="list"></div>
      </section>
      <section>
        <h2>Tool Calls</h2>
        <div id="tools" class="list"></div>
      </section>
    </div>
  </main>
  <script>
    const stateUrl = "/state";
    const format = (value) => JSON.stringify(value ?? null, null, 2);
    let controlsReady = false;
    let actionOptions = [];

    async function refresh() {
      const response = await fetch(stateUrl, { cache: "no-store" });
      const state = await response.json();
      renderMeta(state);
      renderControls(state);
      document.getElementById("inventory").textContent = format({
        inventory: state.inventory,
        score: state.score,
        position: state.observation?.position,
        equippedItem: state.observation?.equippedItem,
        lastActionResult: state.observation?.lastActionResult
      });
      renderTrace(state.llmTrace ?? []);
      renderTools(state.toolCalls ?? []);
    }

    function renderControls(state) {
      if (!controlsReady) {
        const taskSelect = document.getElementById("taskSelect");
        taskSelect.replaceChildren(...(state.controls?.tasks ?? []).map((task) => option(task, task)));
        taskSelect.value = state.selectedTask ?? state.bot?.task ?? "early_sequence";

        const smokeSelect = document.getElementById("smokeSelect");
        smokeSelect.value = state.profile ?? "full";

        actionOptions = state.controls?.actions ?? [];
        const actionSelect = document.getElementById("actionSelect");
        actionSelect.replaceChildren(...actionOptions.map((action) => option(action.id, action.name)));
        if (actionOptions.length > 0) {
          actionSelect.value = actionOptions[0].id;
          document.getElementById("toolJson").value = format(actionOptions[0].toolCall);
        }

        actionSelect.addEventListener("change", () => {
          const selected = actionOptions.find((action) => action.id === actionSelect.value);
          if (selected) document.getElementById("toolJson").value = format(selected.toolCall);
        });
        document.getElementById("runTask").addEventListener("click", runTaskFromControls);
        document.getElementById("runSmoke").addEventListener("click", runSmokeFromControls);
        document.getElementById("runTool").addEventListener("click", runToolFromControls);
        document.getElementById("resetState").addEventListener("click", resetStateFromControls);
        document.getElementById("stopAgent").addEventListener("click", stopAgentFromControls);
        controlsReady = true;
      }

      const busy = Boolean(state.controls?.busy);
      for (const id of ["taskSelect", "maxIterations", "smokeSelect", "actionSelect", "toolJson", "runTask", "runSmoke", "runTool", "resetState"]) {
        document.getElementById(id).disabled = busy;
      }
      document.getElementById("stopAgent").disabled = !busy || state.controls?.stopping;
      const activity = state.activity ?? {};
      document.getElementById("controlStatus").textContent = [
        activity.status ?? "idle",
        activity.label,
        activity.message,
        state.reset?.lastResult?.ok === false ? state.reset.lastResult.message : undefined
      ].filter(Boolean).join(" | ");
    }

    function option(value, label) {
      const item = document.createElement("option");
      item.value = String(value);
      item.textContent = String(label);
      return item;
    }

    async function runTaskFromControls() {
      await postControl("/control/task", {
        task: document.getElementById("taskSelect").value,
        maxIterations: Number(document.getElementById("maxIterations").value)
      });
      await refresh();
    }

    async function runSmokeFromControls() {
      await postControl("/control/smoke", {
        profile: document.getElementById("smokeSelect").value
      });
      await refresh();
    }

    async function runToolFromControls() {
      let toolCall;
      try {
        toolCall = JSON.parse(document.getElementById("toolJson").value);
      } catch (error) {
        document.getElementById("controlStatus").textContent = "Invalid tool JSON.";
        return;
      }
      const selected = actionOptions.find((action) => action.id === document.getElementById("actionSelect").value);
      await postControl("/control/tool", {
        name: selected?.name,
        toolCall
      });
      await refresh();
    }

    async function resetStateFromControls() {
      await postControl("/control/reset", {});
      await refresh();
    }

    async function stopAgentFromControls() {
      await postControl("/control/stop", { reason: "Stop requested from dashboard." });
      await refresh();
    }

    async function postControl(path, body) {
      const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      const payload = await response.json();
      if (!response.ok) {
        document.getElementById("controlStatus").textContent = payload.error?.message ?? payload.activity?.message ?? "Request failed.";
      }
      return payload;
    }

    function renderMeta(state) {
      const entries = [
        state.runStatus ?? "starting",
        state.bot?.task,
        state.bot?.provider,
        state.bot?.primaryModel,
        state.activity?.logPath ?? state.logPath
      ].filter(Boolean);
      document.getElementById("meta").replaceChildren(...entries.map((entry) => {
        const span = document.createElement("span");
        span.className = "pill";
        span.textContent = String(entry);
        return span;
      }));
    }

    function renderTrace(events) {
      const target = document.getElementById("trace");
      if (events.length === 0) {
        target.innerHTML = '<div class="empty">Waiting for model events.</div>';
        return;
      }
      target.replaceChildren(...events.slice(-12).reverse().map((event) => {
        const row = document.createElement("article");
        row.className = "row";
        const accepted = (event.attempts ?? []).some((attempt) => attempt.accepted);
        const errors = (event.attempts ?? []).filter((attempt) => attempt.providerError || attempt.validationError).length;
        row.appendChild(rowHead([
          "iteration " + event.iteration,
          event.activeModel ?? "model pending",
          accepted ? "accepted" : (errors ? "errors: " + errors : "pending")
        ], accepted ? "ok" : (errors ? "bad" : "")));
        row.appendChild(detailsBlock("Prompt / output / attempts", {
          score: event.score,
          retryCount: event.retryCount,
          normalization: event.normalization,
          fallbackDecision: event.fallbackDecision,
          validationErrors: event.validationErrors,
          promptReference: event.promptReference,
          providerOutput: event.providerOutput,
          parsedToolCall: event.parsedToolCall,
          toolResult: event.toolResult,
          timing: {
            toolElapsedMs: event.toolElapsedMs,
            attempts: (event.attempts ?? []).map((attempt) => ({
              provider: attempt.provider,
              model: attempt.model,
              retry: attempt.retry,
              fallback: attempt.fallback,
              accepted: attempt.accepted,
              elapsedMs: attempt.elapsedMs
            }))
          },
          attempts: event.attempts
        }));
        return row;
      }));
    }

    function renderTools(events) {
      const target = document.getElementById("tools");
      if (events.length === 0) {
        target.innerHTML = '<div class="empty">Waiting for tool calls.</div>';
        return;
      }
      target.replaceChildren(...events.slice(-14).reverse().map((event) => {
        const row = document.createElement("article");
        row.className = "row";
        const ok = event.toolResult?.ok;
        const toolName = event.toolCall?.tool ?? event.toolCall?.name ?? event.name ?? "tool";
        row.appendChild(rowHead([
          "iteration " + event.iteration,
          toolName,
          ok === undefined ? "pending" : (ok ? "ok" : "error")
        ], ok === undefined ? "" : (ok ? "ok" : "bad")));
        row.appendChild(detailsBlock("Call / result", {
          tool: event.toolCall?.tool,
          args: event.toolCall?.args,
          resultStatus: event.toolResult?.ok === undefined ? "pending" : (event.toolResult.ok ? "ok" : "error"),
          errorMessage: event.toolResult?.error?.message,
          elapsedMs: event.elapsedMs,
          scoreBefore: event.scoreBefore,
          scoreAfter: event.scoreAfter ?? event.score,
          inventoryBefore: event.inventoryBefore,
          inventoryAfter: event.inventoryAfter,
          toolCall: event.toolCall,
          toolResult: event.toolResult
        }));
        return row;
      }));
    }

    function rowHead(items, statusClass) {
      const head = document.createElement("div");
      head.className = "row-head";
      for (const item of items) {
        const span = document.createElement("span");
        span.textContent = String(item);
        if (item === items.at(-1) && statusClass) span.className = statusClass;
        head.appendChild(span);
      }
      return head;
    }

    function detailsBlock(label, value) {
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      const pre = document.createElement("pre");
      summary.textContent = label;
      pre.textContent = format(value);
      details.append(summary, pre);
      return details;
    }

    refresh().catch(console.error);
    setInterval(() => refresh().catch(console.error), 1000);
  </script>
</body>
</html>`;
}

function sendHtml(response: ServerResponse, html: string): void {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(html);
}

function sendJson(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

function sendText(response: ServerResponse, status: number, text: string): void {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  response.end(text);
}

async function readJsonFile(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

async function readRequestJson(request: IncomingMessage): Promise<unknown> {
  let body = "";
  for await (const chunk of request) {
    body += String(chunk);
    if (body.length > 100_000) throw new Error("Request body too large.");
  }
  return body.trim() ? JSON.parse(body) : {};
}

function safeObservation(
  bot: Bot,
  lastActionResult?: ToolResult,
): ReturnType<typeof buildObservation> | undefined {
  try {
    return buildObservation(bot, lastActionResult);
  } catch {
    return undefined;
  }
}

function objectField(value: unknown): Record<string, unknown> | undefined {
  return isObject(value) ? value : undefined;
}

function arrayField(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTaskName(value: unknown): TaskName | undefined {
  return typeof value === "string" && (TASKS as string[]).includes(value) ? value as TaskName : undefined;
}

function parsePositiveInt(value: unknown, fallback: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function parseMode(argv: string[]): DemoMode {
  return stringArg("--mode", "llm", argv) === "smoke" ? "smoke" : "llm";
}

function numberArg(name: string, fallback: number): number {
  const raw = stringArg(name);
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function booleanArg(name: string, fallback: boolean): boolean {
  const raw = stringArg(name);
  if (!raw) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function stringArg(name: string, fallback = "", values = process.argv.slice(2)): string {
  const arg = values.find((value) => value === name || value.startsWith(`${name}=`));
  if (!arg) return fallback;
  if (arg.includes("=")) return arg.split("=", 2)[1];
  const next = values[values.indexOf(arg) + 1];
  return next && !next.startsWith("--") ? next : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function listen(server: ReturnType<typeof createServer>, port: number): Promise<void> {
  return new Promise((resolve) => {
    server.listen(port, () => {
      const address = server.address() as AddressInfo;
      console.log(`Dashboard listening on ${address.port}`);
      resolve();
    });
  });
}
