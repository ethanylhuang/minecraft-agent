# Minecraft Agent

Symbolic-only Mineflayer survival harness for M1 primitives.

## Setup

```sh
npm install
npm test
npm run build
```

## Run

Start a local vanilla Minecraft server in survival mode, then run:

```sh
npm start -- --host localhost --port 25565 --username symbolic_agent --task early_sequence
```

Useful environment variables:

- `MC_HOST`, `MC_PORT`, `MC_USERNAME`, `MC_VERSION`
- `MODEL_PROVIDER` (`scripted`, `openai-compatible`, or `gemini-compatible`)
- `PRIMARY_MODEL` or legacy `MODEL`, `FALLBACK_PROVIDER`, `FALLBACK_MODEL`
- `MODEL_ESCALATION_ORDER` as comma-separated `provider:model` entries, for example `gemini-compatible:gemma-4-31b-it,gemini-compatible:gemini-2.5-flash`
- `LOCK_FALLBACK_AFTER_USE`
- `MAX_LLM_RETRIES_PER_STEP` or `MAX_LLM_RETRIES`
- `LLM_TIMEOUT_MS`, `TOOL_TIMEOUT_MS`
- `ALLOW_SCRIPTED_FIXTURES` (`true` by default; set `false` for benchmark runs)
- `TASK`, `MAX_ITERATIONS`, `LOG_DIR`
- `RESET_COMMANDS`, `RESET_SPAWN`, `RESET_WAIT_TICKS`
- `OPENAI_BASE_URL`, `OPENAI_API_KEY` (optional for local endpoints that do not require auth)
- `GEMINI_BASE_URL`, `GEMINI_API_KEY`

A local `.env` file is loaded automatically when present; keep secrets there rather than in commands.

Equivalent CLI flags use kebab case: `--provider`, `--primary-model`, `--fallback-provider`, `--fallback-model`, `--model-escalation-order`, `--lock-fallback-after-use`, `--max-llm-retries`, `--llm-timeout-ms`, `--tool-timeout-ms`, `--allow-scripted-fixtures`, `--reset-commands`, `--reset-spawn`, `--reset-wait-ticks`, `--openai-base-url`, `--openai-api-key`, `--gemini-base-url`, `--gemini-api-key`, and benchmark-only `--gemma-failure-evidence` / `--run-timeout-ms`.

The default provider is deterministic `scripted`, which can progress early survival tasks through logs, planks, sticks, crafting table, and wooden pickaxe. It is a fixture/control for smoke and debug runs, not accepted M1 benchmark evidence. For benchmark evidence, run a real LLM provider first, normally an OpenAI-compatible Gemma 4 31B route, and escalate to a Gemini Flash-class route only after primary attempts are exhausted and logged.

## Tasks

Supported task names:

- `early_sequence`
- `collect_logs`
- `craft_planks`
- `craft_sticks`
- `craft_crafting_table`
- `craft_wooden_pickaxe`
- `mine_cobblestone`
- `craft_stone_pickaxe`
- `place_furnace`
- `smelt_iron_ingot`

Each run writes a JSON log under `runs/` with observations, prompt references, active provider/model, raw provider outputs, validation errors, retry counts, fallback decisions, validated tool calls, tool results, elapsed time, tool error counts, benchmark caveat, and final score.

## Server Smoke

With a local server running:

```sh
npm run smoke
```

`npm run smoke` runs the full primitive smoke plan: observe, wait, move, mine, craft, equip, place, smelt gathered cobblestone, eat if edible food is available, and stop. Use `npm run smoke:early` for the shorter log-to-wooden-pickaxe pass.

For a fuller integration pass:

```sh
npm start -- --task early_sequence --max-iterations 80
```

For accepted M1 benchmark evidence, run the three-pass benchmark with a real LLM provider. Scripted fixtures are disabled by the benchmark command, and the first configured model route must be Gemma 4 31B:

```sh
npm run benchmark:m1 -- --provider gemini-compatible --primary-model gemma-4-31b-it --runs 3
```

Use `--fallback-provider gemini-compatible --fallback-model gemini-2.5-flash` or `--model-escalation-order` only after Gemma failure evidence has been captured, and pass `--gemma-failure-evidence <path>` for fallback-completed runs to be accepted.

Verify a benchmark summary with:

```sh
npm run verify:m1 -- runs/<timestamp>_m1_benchmark_summary.json
```

The server must allow the bot username to join and should be in survival mode. For the full smoke plan, prepare nearby logs and stone. A controlled seed or prepared test area is recommended for repeatable mining, placing, and smelting checks.

## Web Demo

With a local server running:

```sh
npm run demo -- --mode llm --username webdemo --task early_sequence
```

The demo opens a Prismarine viewer on `http://localhost:3007` and a dashboard on `http://localhost:3008`. The dashboard shows live inventory JSON, score state, LLM prompt/output/attempt trace, tool call/result records, and controls for running tasks, smoke plans, or individual tool calls.

The dashboard also has `Stop Agent` and `Reset State` controls. Stop sets a shared cancellation flag, stops pathfinding, and leaves the active dashboard operation in a stopped state. Reset is manual-only and command-driven: by default it sends `/clear`, `/effect clear`, `/gamemode survival`, and optionally `/tp` when `--reset-spawn "x y z"` is configured. Add arena setup or cleanup commands with comma-separated `--reset-commands`, using `{username}`, `{x}`, `{y}`, and `{z}` placeholders when useful.

Example controlled dashboard run:

```sh
npm run demo -- --mode smoke --auto-run=false --reset-spawn "0 64 0"
```

Use an opped bot or cheats-enabled local server for reset commands. Task, smoke, and manual tool runs do not reset automatically; press `Reset State` only when you explicitly want to clear or rebuild the world state.

Use the deterministic smoke plan instead of the LLM loop with:

```sh
npm run demo -- --mode smoke --profile early
```

Start the dashboard without an automatic run with:

```sh
npm run demo -- --mode smoke --auto-run=false
```

See `docs/M1_VALIDATION_CHECKLIST.md` for the full local-check and accepted-benchmark evidence checklist.
