# M1 Symbolic Survival Primitives Implementation Plan

## 1. Summary

Build a symbolic-only Minecraft agent harness that validates primitive tools, reasoning loops, task scoring, and execution logs on fixed early-survival tasks.

## 2. Project Requirements and Assumptions

- The first milestone is not the final benchmark; it is a diagnostic baseline for tools and planning.
- Use Mineflayer for Minecraft server connection, symbolic world state, inventory, movement, mining, crafting, placing, and smelting.
- Use TypeScript unless project setup later proves a different language is already established.
- Run against a local vanilla Minecraft server in survival mode.
- The LLM receives symbolic world observations, including HUD/inventory and nearby blocks/entities.
- The LLM emits structured tool calls rather than free-form Minecraft commands.
- The task runner's benchmark path must be LLM-driven: the LLM, not a scripted policy, chooses the next tool call from each observation and prior tool result.
- Use Gemma 4 31B as the first LLM candidate for M1 validation. If Gemma 4 31B cannot reliably complete the required tool-call loop after extensive testing, escalate to Gemini 3.1 Flash if available, or the closest Gemini Flash-class model exposed by the selected provider.
- Scripted or deterministic policies may exist only as test fixtures, smoke-test baselines, or debugging controls. They do not satisfy M1 task-runner acceptance on their own.
- All agent decisions, observations, tool calls, tool results, and task scores must be logged.

## 3. In-scope/out-of-scope

In scope:

- Minimal project scaffold for a runnable Mineflayer agent.
- Local configuration for Minecraft host, port, bot username, model provider, and task selection.
- Local configuration for the primary model, fallback model, model escalation order, max LLM retries per step, and whether scripted fixtures are allowed for non-benchmark smoke tests.
- Symbolic observation generation: health, hunger, position, biome if available, time of day, inventory, equipped item, nearby blocks, nearby entities, and last action result.
- Primitive tools: observe state, go to nearest block, mine block, craft item, equip item, place block, smelt item, eat food if available, wait, and stop.
- Fixed task runner for early survival tasks.
- Scoring checks based on inventory and environment state.

Out of scope:

- First-person screenshots or vision models.
- Open-ended survival completion.
- Multiplayer collaboration.
- Advanced UI, dashboards, or hosted service deployment.
- Learning a persistent skill library beyond simple reusable code helpers.

## 4. Tech Stack/App Flow

- Node.js and TypeScript.
- Mineflayer for bot control.
- mineflayer-pathfinder for navigation.
- minecraft-data for item, block, and recipe metadata.
- Provider-neutral LLM adapter interface so model providers can be swapped.
- OpenAI-compatible chat-completions support for local or hosted Gemma deployments.
- Gemini-compatible support for Gemini Flash-class fallback models.
- JSON schema or equivalent runtime validation for tool calls.

App flow:

1. Start or connect to a local Minecraft server.
2. Create a Mineflayer bot.
3. Load pathfinding and utility plugins.
4. Select a fixed task.
5. Build symbolic observation.
6. Ask the active LLM for the next tool call.
7. Validate and execute the tool call.
8. Return structured success/failure feedback.
9. If the LLM response is invalid, log the schema error and retry within the configured retry budget.
10. Repeat until success, timeout, death, or max iterations.
11. Write a run log and final score.

LLM model policy:

1. Primary validation model: Gemma 4 31B.
2. Required Gemma test pass before escalation:
   - Run the real local-server M1 task sequence at least 3 times on deterministic or semi-controlled worlds.
   - Run primitive isolation smoke tests for observe, move, mine, craft, equip, place, smelt, eat, wait, and stop.
   - Capture every prompt or prompt reference, raw model response, parsed tool call, validation error, tool result, task score, elapsed time, and retry count.
3. Gemma is considered insufficient only after extensive testing shows one or more repeatable failures:
   - It cannot emit valid structured tool calls within the retry budget.
   - It repeatedly stalls or loops without improving task score.
   - It cannot complete the required early-sequence task after prompt/schema fixes that do not encode a scripted policy.
   - It produces unsafe or out-of-scope actions that cannot be constrained by schema and prompt changes.
4. Fallback validation model: Gemini 3.1 Flash if available through the provider. If that exact model is unavailable, use the closest current Gemini Flash-class model with structured-output or function-calling support, such as a Gemini 3 Flash preview or later Flash equivalent.
5. The run log must record which model was active, why fallback was used, and the evidence that the primary model was tried first.

Initial fixed tasks:

- Collect 3 logs.
- Craft planks.
- Craft a crafting table.
- Craft sticks.
- Craft a wooden pickaxe.
- Mine cobblestone.
- Craft a stone pickaxe.
- Craft and place a furnace.
- Smelt one iron ingot if iron ore is available or injected by test setup.

## 5. Testing

- Add unit tests for observation formatting, inventory matching, recipe lookup helpers, and tool-call validation.
- Add integration smoke tests with a local server for bot spawn, observe state, move, mine, craft, place, and smelt.
- Add provider tests for prompt construction, structured-output parsing, schema retry feedback, and model fallback selection.
- Add real LLM validation runs for Gemma 4 31B before any fallback run is accepted.
- Add fallback validation runs with Gemini 3.1 Flash or the nearest Gemini Flash-class model only after Gemma failure evidence is present.
- Store logs for every benchmark run under a local ignored output directory such as `runs/`.
- For each task, gather evidence from final inventory/state, task status, total iterations, total elapsed time, and tool error counts.
- Include a deterministic or semi-controlled seed for repeatable early tests where practical.

## 6. Acceptance Criteria

- `npm install` and the documented start command work on a clean checkout.
- A bot can connect to a local Minecraft server and produce a symbolic observation.
- The primitive tools execute successfully in isolation against a local server.
- The task runner can complete at least these tasks in sequence using LLM-selected tool calls: collect logs, craft planks, craft sticks, craft a crafting table, craft a wooden pickaxe.
- The accepted benchmark run must use Gemma 4 31B unless documented extensive testing shows Gemma cannot satisfy the milestone; in that case the accepted run may use Gemini 3.1 Flash or the nearest Gemini Flash-class fallback.
- Scripted providers, deterministic planners, or hard-coded task policies cannot be counted as successful M1 task-runner completion, though they may be used in unit tests and smoke tests.
- Each run writes a machine-readable log containing observations, prompts or prompt references, raw model outputs, validated tool calls, tool results, retry counts, active model, fallback decision if any, and final score.
- Failed tool calls return structured errors that the LLM loop can use for retries.
- The implementation does not require screenshots, a rendered client, or visual perception.
