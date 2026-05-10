import { z } from "zod";
import { structuredError } from "../errors.js";

const count = z.number().int().positive().max(64).default(1);
const name = z.string().trim().min(1);

export const ToolCallSchema = z.discriminatedUnion("tool", [
  z.object({ tool: z.literal("observe"), args: z.object({}).default({}) }).strict(),
  z.object({
    tool: z.literal("go_to_nearest_block"),
    args: z.object({
      block: name,
      maxDistance: z.number().int().positive().max(128).default(128),
    }).strict(),
  }).strict(),
  z.object({
    tool: z.literal("mine_block"),
    args: z.object({
      block: name,
      count,
      maxDistance: z.number().int().positive().max(128).default(128),
    }).strict(),
  }).strict(),
  z.object({
    tool: z.literal("craft_item"),
    args: z.object({ item: name, count }).strict(),
  }).strict(),
  z.object({
    tool: z.literal("equip_item"),
    args: z.object({ item: name }).strict(),
  }).strict(),
  z.object({
    tool: z.literal("place_block"),
    args: z.object({
      item: name,
      referenceBlock: name.optional(),
      maxDistance: z.number().int().positive().max(16).default(4),
    }).strict(),
  }).strict(),
  z.object({
    tool: z.literal("smelt_item"),
    args: z.object({
      input: name,
      fuel: name.default("coal"),
      count,
      maxDistance: z.number().int().positive().max(16).default(8),
    }).strict(),
  }).strict(),
  z.object({
    tool: z.literal("eat_food"),
    args: z.object({ food: name.optional() }).default({}),
  }).strict(),
  z.object({
    tool: z.literal("wait"),
    args: z.object({
      ticks: z.number().int().positive().max(1200).default(20),
    }).strict(),
  }).strict(),
  z.object({
    tool: z.literal("stop"),
    args: z.object({ reason: z.string().max(500).optional() }).default({}),
  }).strict(),
]);

export type ToolCall = z.infer<typeof ToolCallSchema>;

export function validateToolCall(input: unknown):
  | { ok: true; value: ToolCall }
  | { ok: false; error: ReturnType<typeof structuredError> } {
  const parsed = ToolCallSchema.safeParse(input);
  if (parsed.success) return { ok: true, value: parsed.data };

  return {
    ok: false,
    error: structuredError(
      "invalid_tool_call",
      "Tool call failed runtime validation.",
      true,
      z.treeifyError(parsed.error),
    ),
  };
}

export const TOOL_NAMES = ToolCallSchema.options.map((schema) => schema.shape.tool.value);
