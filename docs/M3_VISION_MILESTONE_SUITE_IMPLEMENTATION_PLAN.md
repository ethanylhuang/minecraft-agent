# M3 Vision Milestone Suite Implementation Plan

## 1. Summary

Extend the vision-plus-symbolic-HUD stack to harder fixed milestones that test recovery, safety, navigation, and multi-step survival progression before open-ended play.

## 2. Project Requirements and Assumptions

- M2 exists and can run fixed early-survival tasks using visual world perception.
- The architecture remains the same: first-person image for world state, symbolic HUD/inventory/meta state, and vision-grounded tools.
- This milestone should improve benchmark coverage without adding open-ended autonomous goal generation yet.
- Tasks should be measurable and independently runnable.
- The benchmark should support controlled seeds or scenario setup when needed to make failures interpretable.

## 3. In-scope/out-of-scope

In scope:

- A milestone task registry with richer fixed tasks.
- Scenario setup helpers when needed for repeatability.
- Better recovery handling for stuck movement, failed mining, missing resources, low health, hunger, night, and death.
- Tool improvements that preserve visual world perception constraints.
- Metrics grouped by milestone category.
- Optional lightweight memory within a run for current subgoal, discovered landmarks, and recent failures.

Out of scope:

- End-to-end "beat Minecraft" campaign.
- Any tool that directly locates hidden resources or structures using server oracle data.
- Training or fine-tuning models.
- Large dashboard UI.
- Multi-agent play.

## 4. Tech Stack/App Flow

- Reuse M2 app, model adapter, visual observation provider, task runner, and logs.
- Add task definitions with setup, allowed tools, success checks, timeout, max iterations, and scoring weights.
- Add run-level memory that is visible to the LLM as text, derived only from previous observations and outcomes.
- Add failure classifiers for debugging, such as perception failure, targeting failure, pathing failure, planning failure, unsafe action, timeout, and death.

Milestone tasks:

- Survive first night.
- Find and mine exposed stone.
- Build a minimal enclosed shelter.
- Recover after falling into a shallow hole.
- Avoid or fight a visible hostile mob.
- Find a cave entrance.
- Craft stone tools from scratch.
- Make and use a furnace.
- Obtain and smelt iron.
- Craft shield and iron pickaxe.
- Enter the Nether from a prepared or partially prepared setup.

App flow:

1. Select milestone task and seed or setup.
2. Spawn bot and initialize visual observation.
3. Provide task objective, HUD/meta state, current memory, and first-person frame to the LLM.
4. Execute validated tool calls.
5. Update memory from observations and action results.
6. Classify failures when a task ends unsuccessfully.
7. Save structured metrics and artifacts.

## 5. Testing

- Unit test task registry parsing and success checks.
- Unit test failure classifier inputs and outputs.
- Run each milestone task at least three times on fixed seeds or setup scenarios.
- Save evidence for each run: final state, inventory, death status, elapsed time, iterations, frames, tool errors, and failure class if unsuccessful.
- Compare milestone results against M1 or M2 where there is an overlapping task.
- Manually review shelter, cave, mob, and Nether-entry frame sequences for scoring sanity.

## 6. Acceptance Criteria

- The benchmark can run each M3 milestone task independently from configuration.
- The agent completes at least three of the M3 milestone tasks end to end using visual world perception.
- Each failed run receives a useful failure classification.
- No milestone task exposes symbolic world perception fields that were forbidden in M2.
- Logs contain enough evidence to replay or audit the agent decision sequence at the observation and tool-call level.
- The implementation includes a concise benchmark summary report for completion rate, median iterations, elapsed time, death rate, and most common failure class.
