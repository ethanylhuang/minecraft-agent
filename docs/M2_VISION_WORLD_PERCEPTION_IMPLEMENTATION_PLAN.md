# M2 Vision World Perception Implementation Plan

## 1. Summary

Replace symbolic world perception with first-person visual observations while keeping HUD, inventory, equipped item, and action results symbolic.

## 2. Project Requirements and Assumptions

- M1 exists and provides a working Mineflayer agent harness, task runner, logs, and primitive execution layer.
- The final benchmark direction is visual world perception, not full raw keyboard and mouse control.
- HUD and meta state remain symbolic: health, hunger, armor if available, inventory, equipped item, current task, and last action result.
- World perception must come from screenshots or rendered first-person frames: blocks, mobs, terrain, caves, structures, hazards, and navigation targets.
- The implementation may use a real Minecraft client capture, a modded frame stream, Prismarine Viewer, or another renderer, but it must expose an image-like observation to the LLM.
- The same early-survival tasks from M1 should be used first so V1 and V2 are directly comparable.

## 3. In-scope/out-of-scope

In scope:

- Visual observation provider abstraction.
- First-person screenshot or frame capture pipeline.
- Prompt format that includes one visual frame plus symbolic HUD/meta data.
- Removal of symbolic nearby block/entity lists from the LLM observation.
- Vision-grounded tools: look or turn, move, jump, move toward screen point, mine crosshair block or mine screen point, attack crosshair entity or attack screen point, place relative, equip item, craft item, smelt item, eat food, wait, and stop.
- Task replay on the M1 early-survival ladder.
- Side-by-side metric comparison of M1 symbolic performance and M2 visual performance.

Out of scope:

- Open-ended survival completion.
- Stronghold, Nether fortress, or Ender Dragon tasks.
- Fully vision-only inventory reading.
- Pixel-level keyboard and mouse control without tools.
- Perfect photorealistic rendering if an approximate first-person renderer is sufficient for early validation.

## 4. Tech Stack/App Flow

- Reuse the M1 TypeScript app and Mineflayer controller.
- Add a `VisionProvider` interface with methods to initialize, capture the current frame, and cleanly stop.
- Add an observation mode flag: `symbolic`, `vision_hud`, or equivalent.
- Use model adapters that can send multimodal requests when vision mode is enabled.
- Use schema-validated tool calls for all actions.

App flow:

1. Start Minecraft server and bot.
2. Start visual frame provider.
3. Select a fixed task from the M1 ladder.
4. Capture first-person frame.
5. Gather symbolic HUD/meta state only.
6. Ask the multimodal LLM for a vision-grounded tool call.
7. Execute the tool call through the Mineflayer controller.
8. Capture the next frame and action result.
9. Repeat until success, timeout, death, or max iterations.
10. Save frame references, tool calls, tool results, and final task score.

World data not allowed in LLM input:

- nearby block lists.
- nearby entity lists.
- target coordinates for visible resources.
- nearest tree, cave, ore, animal, mob, or structure helpers.

Allowed symbolic data:

- health, hunger, armor, breath if underwater, inventory, equipped item, current task, last action result, death status, and elapsed time.

## 5. Testing

- Unit test observation filtering to ensure forbidden symbolic world fields are not present in vision mode.
- Unit test validation for screen-coordinate tools and relative placement tools.
- Add a visual capture smoke test that saves one frame and verifies it is non-empty.
- Run the M1 early-survival task ladder in M2 vision mode and compare completion rate, iterations, elapsed time, and failure reasons.
- Manually inspect a small sample of saved frames to confirm the visual observation corresponds to the bot perspective.
- Include failure logs for visual misrecognition, bad targeting, path obstruction, and tool execution errors.

## 6. Acceptance Criteria

- Vision mode can produce a valid image observation and symbolic HUD/meta observation in the same loop.
- LLM observations in vision mode do not include nearby block/entity lists or oracle target coordinates.
- The agent can complete at least collect logs, craft planks, craft sticks, and craft a crafting table using visual world perception.
- The same task runner can execute both symbolic and vision modes from configuration.
- Run logs include frame references or saved frame paths for each decision step.
- At least one benchmark report compares M1 symbolic and M2 vision performance on the same task set.
