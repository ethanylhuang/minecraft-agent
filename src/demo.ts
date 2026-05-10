import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Bot } from "mineflayer";
import { loadConfig, type AppConfig } from "./config.js";
import { failedResult } from "./errors.js";
import { createMinecraftBot } from "./minecraft.js";
import { buildObservation } from "./observation.js";
import { runTask } from "./runner.js";
import { smokeSteps, type SmokeProfile } from "./smokePlan.js";
import { scoreTask, TASKS } from "./tasks.js";
import { withTimeout } from "./timeout.js";
import type { SymbolicObservation, TaskName, TaskScore, ToolResult } from "./types.js";
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
};

type DashboardActivity = {
  status: "idle" | "running" | "complete" | "failed";
  kind?: "llm_task" | "smoke_plan" | "tool_call";
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
  toolCall: ToolCall;
  toolResult: ToolResult;
  observationBefore: SymbolicObservation;
  observationAfter: SymbolicObservation;
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
  controlState: { stopRequested: boolean; lastActionResult?: ToolResult };
  controlEvents: DashboardControlEvent[];
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
    const result = await runTask(context.bot, runConfig, { logPath });
    console.log(`Demo log: ${result.logPath}`);
    console.log(result.score.complete ? "Demo complete." : "Demo failed at: llm task");
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
    const result = await runSmokeDemo(context.bot, context.config, profile, context.stepDelayMs, logPath);
    console.log(`Demo log: ${result.logPath}`);
    console.log(result.ok ? "Demo complete." : `Demo failed at: ${result.failedStep ?? "smoke plan"}`);
    return {
      ok: result.ok,
      message: result.ok ? "Smoke plan complete." : `Smoke plan failed at ${result.failedStep ?? "unknown step"}.`,
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
    const score = scoreTask(context.selectedTask, observationAfter);
    const event: DashboardControlEvent = {
      iteration: context.controlEvents.length,
      source: "dashboard",
      name: label,
      score,
      toolCall,
      toolResult,
      observationBefore,
      observationAfter,
      elapsedMs: Date.now() - startedMs,
    };
    context.controlEvents.push(event);
    context.controlEvents = context.controlEvents.slice(-200);
    await writeControlLog(context);
    return {
      ok: toolResult.ok,
      message: toolResult.message,
      logPath: context.controlLogPath,
    };
  });
}

function beginOperation(
  context: DashboardContext,
  activity: Omit<DashboardActivity, "status" | "startedAt">,
  work: () => Promise<{ ok: boolean; message: string; logPath?: string }>,
): boolean {
  if (context.activeOperation) return false;

  const startedAt = new Date().toISOString();
  context.lastActivityAt = Date.now();
  context.activity = { ...activity, status: "running", startedAt };
  context.activeOperation = (async () => {
    try {
      const result = await work();
      context.activity = {
        ...activity,
        status: result.ok ? "complete" : "failed",
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
      if (activity.kind === "tool_call") {
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
): Promise<{ ok: boolean; failedStep?: string; logPath: string }> {
  const state: { stopRequested: boolean; lastActionResult?: ToolResult } = { stopRequested: false };
  const events: SmokeEvent[] = [];
  let failedStep: string | undefined;

  for (const [index, step] of smokeSteps(profile).entries()) {
    await sleep(delayMs);
    console.log(`[${index + 1}] ${step.name}: ${step.call.tool}`);
    const observationBefore = buildObservation(bot, state.lastActionResult);
    const result = await executeTool(bot, step.call, state);
    state.lastActionResult = result;
    const observationAfter = buildObservation(bot, state.lastActionResult);
    events.push({
      step: index,
      name: step.name,
      toolCall: step.call,
      toolResult: result,
      observationBefore,
      observationAfter,
    });
    await writeSmokeLog(config, profile, logPath, events, "running");
    console.log(`    ${result.ok ? "ok" : "error"}: ${result.message}`);

    if (!result.ok) {
      failedStep = step.name;
      break;
    }
  }

  await writeSmokeLog(config, profile, logPath, events, failedStep ? "failed" : "complete", failedStep);
  return { ok: !failedStep, failedStep, logPath };
}

async function writeSmokeLog(
  config: AppConfig,
  profile: SmokeProfile,
  logPath: string,
  events: SmokeEvent[],
  status: "running" | "complete" | "failed",
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

  return {
    mode: context.mode,
    profile: context.profile,
    selectedTask: context.selectedTask,
    uptimeMs: Date.now() - context.startedAt.getTime(),
    viewerPort: context.viewerPort,
    logPath: context.logPath,
    controlLogPath: context.controlLogPath,
    activity: context.activity,
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
    toolCalls: [...logEvents, ...context.controlEvents].map(toolCallEvent).filter(Boolean),
    controls: {
      busy: Boolean(context.activeOperation),
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
    toolCall,
    toolResult,
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
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #101214;
      color: #edf0f2;
    }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: #101214; }
    main {
      display: grid;
      grid-template-columns: minmax(420px, 1.15fr) minmax(420px, 0.85fr);
      min-height: 100vh;
    }
    iframe { width: 100%; height: 100vh; border: 0; background: #050607; }
    .side {
      display: grid;
      grid-template-rows: auto auto minmax(180px, 0.75fr) minmax(220px, 1fr) minmax(220px, 1fr);
      min-height: 100vh;
      border-left: 1px solid #2a2f35;
      background: #16191d;
    }
    header {
      display: grid;
      gap: 8px;
      padding: 14px 16px;
      border-bottom: 1px solid #2a2f35;
      background: #1d2228;
    }
    h1 { margin: 0; font-size: 18px; font-weight: 650; letter-spacing: 0; }
    .meta {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      color: #aeb7c1;
      font-size: 12px;
    }
    .pill {
      padding: 3px 7px;
      border: 1px solid #38424c;
      border-radius: 6px;
      background: #15191e;
      white-space: nowrap;
    }
    section {
      min-height: 0;
      overflow: auto;
      padding: 12px 16px;
      border-bottom: 1px solid #2a2f35;
    }
    h2 {
      margin: 0 0 10px;
      font-size: 13px;
      font-weight: 650;
      color: #d9dee4;
      letter-spacing: 0;
    }
    pre {
      margin: 0;
      padding: 10px;
      border: 1px solid #303842;
      border-radius: 6px;
      background: #0f1215;
      color: #dce7ef;
      font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      overflow: auto;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .list { display: grid; gap: 10px; }
    .row {
      border: 1px solid #303842;
      border-radius: 6px;
      background: #11151a;
      overflow: hidden;
    }
    .row-head {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      justify-content: space-between;
      padding: 8px 10px;
      border-bottom: 1px solid #26303a;
      color: #d8dee5;
      font-size: 12px;
    }
    .ok { color: #8fe0a4; }
    .bad { color: #ffb08f; }
    details { padding: 8px 10px; }
    summary {
      cursor: pointer;
      color: #aeb7c1;
      font-size: 12px;
      margin-bottom: 8px;
    }
    .empty { color: #808a95; font-size: 12px; }
    .controls {
      display: grid;
      gap: 10px;
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
      color: #aeb7c1;
      font-size: 12px;
      min-width: 0;
    }
    select, input, textarea, button {
      width: 100%;
      border: 1px solid #38424c;
      border-radius: 6px;
      background: #101419;
      color: #eef2f5;
      font: inherit;
    }
    select, input, button {
      min-height: 32px;
      padding: 5px 8px;
    }
    textarea {
      min-height: 76px;
      resize: vertical;
      padding: 8px;
      font: 12px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    button {
      cursor: pointer;
      background: #24313b;
      font-weight: 650;
      white-space: nowrap;
    }
    button:disabled {
      cursor: not-allowed;
      opacity: 0.55;
    }
    .wide { grid-column: 1 / -1; }
    .status-line {
      color: #aeb7c1;
      font-size: 12px;
      min-height: 18px;
    }
    @media (max-width: 960px) {
      main { grid-template-columns: 1fr; }
      iframe { height: 48vh; }
      .side { min-height: 52vh; border-left: 0; border-top: 1px solid #2a2f35; }
      .control-grid { grid-template-columns: 1fr; }
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
          <label class="wide">Action
            <select id="actionSelect"></select>
          </label>
          <label class="wide">Tool JSON
            <textarea id="toolJson" spellcheck="false"></textarea>
          </label>
          <span></span>
          <span></span>
          <button id="runTool" type="button">Run Tool Call</button>
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
        controlsReady = true;
      }

      const busy = Boolean(state.controls?.busy);
      for (const id of ["taskSelect", "maxIterations", "smokeSelect", "actionSelect", "toolJson", "runTask", "runSmoke", "runTool"]) {
        document.getElementById(id).disabled = busy;
      }
      const activity = state.activity ?? {};
      document.getElementById("controlStatus").textContent = [
        activity.status ?? "idle",
        activity.label,
        activity.message
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
          score: event.score,
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
