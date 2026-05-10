# M4 Open-Ended Survival Campaign Implementation Plan

## 1. Summary

Use the vision-plus-symbolic-HUD agent stack to run an open-ended survival campaign whose long-term objective is to defeat the Ender Dragon.

## 2. Project Requirements and Assumptions

- M3 exists and validates the core visual perception, tool execution, recovery, and milestone scoring stack.
- The final product should let the agent manage its own survival subgoals over long horizons.
- World perception remains visual: blocks, entities, terrain, structures, hazards, and navigation targets must not be given as symbolic oracle facts.
- HUD, inventory, equipped item, armor, coordinates if explicitly allowed, action results, death status, and run memory may remain symbolic.
- The campaign should produce auditable logs and intermediate milestone scores even if the dragon is not defeated.
- It is acceptable to start with controlled seeds before evaluating on random survival worlds.

## 3. In-scope/out-of-scope

In scope:

- Campaign manager for long-running open-ended survival attempts.
- Hierarchical subgoal planning over the survival progression.
- Persistent run memory for inventory goals, known locations, hazards, failures, and completed milestones.
- Checkpointing and resume support for long runs where practical.
- Milestone scoring for the full path to beating Minecraft.
- Budget controls for model calls, elapsed time, deaths, and max iterations.
- Benchmark report for complete and partial campaign progress.

Out of scope:

- Guaranteed completion of Minecraft on all random seeds.
- Using `/locate`, spectator mode, x-ray data, server-side resource coordinates, or other oracle world helpers.
- Full imitation learning or reinforcement learning.
- Custom Minecraft rules that remove core survival challenges.
- Public hosted leaderboard unless requested later.

## 4. Tech Stack/App Flow

- Reuse the M3 TypeScript app, visual observation provider, tool layer, task registry, and logging.
- Add a `CampaignManager` that owns the current phase, subgoal stack, memory, checkpoint state, and scoring.
- Add a planner prompt that asks the LLM to choose or revise subgoals, then emit the next concrete tool call.
- Keep low-level execution tool-based, not raw keyboard and mouse.
- Add optional model roles if useful: planner, executor, and critic. Start with one model unless evidence shows role separation is needed.

Campaign phases:

- Spawn and collect wood.
- Craft basic wooden tools.
- Reach stone tools.
- Secure food and first-night safety.
- Obtain iron tools, shield, bucket, and armor.
- Obtain diamonds and craft diamond pickaxe.
- Build and enter Nether portal.
- Navigate Nether and collect blaze rods.
- Collect ender pearls.
- Craft eyes of ender.
- Locate and enter stronghold.
- Activate End portal.
- Destroy End crystals.
- Defeat Ender Dragon.

App flow:

1. Start a campaign run with seed, model, budget, and allowed observation mode.
2. Initialize bot, visual observation, HUD/meta state, and campaign memory.
3. Ask the LLM to select or continue a subgoal.
4. Ask for the next validated tool call.
5. Execute the tool call and collect result.
6. Update memory and milestone scores.
7. Periodically run self-critique or progress verification.
8. Continue until dragon defeated, death budget exceeded, time budget exceeded, manual stop, or unrecoverable failure.
9. Write final campaign report with partial progress and evidence.

## 5. Testing

- Unit test campaign phase transitions and milestone scoring.
- Unit test checkpoint serialization and resume where implemented.
- Run short campaign smoke tests that stop after wood, stone tools, and iron milestones.
- Run longer controlled-seed trials with fixed budgets and compare progress across models.
- Save evidence: run config, seed, frames, symbolic HUD/meta observations, tool calls, action results, memory snapshots, milestone timestamps, deaths, and final state.
- Review failed long runs for repeated loops, stale memory, unsafe behavior, and hidden oracle leakage.

## 6. Acceptance Criteria

- A campaign can be started from one command with model, seed, and budget configuration.
- The campaign manager tracks progress across the full survival path to the Ender Dragon.
- The agent can autonomously complete the early campaign phases through stone tools using the M2/M3 visual world perception constraints.
- The benchmark records partial progress even when the full campaign fails.
- Logs and reports make it clear which phase failed and why.
- No campaign prompt or observation includes forbidden symbolic world perception such as nearest ore, nearest fortress, nearest stronghold, nearby entity lists, or hidden structure coordinates.
- At least one controlled-seed campaign run produces a complete report with milestone progress, artifacts, and failure analysis.
