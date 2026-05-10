export type Vec3Like = {
  x: number;
  y: number;
  z: number;
};

export type ItemStack = {
  name: string;
  count: number;
};

export type BlockObservation = {
  name: string;
  position: Vec3Like;
  distance: number;
};

export type EntityObservation = {
  name: string;
  type: string;
  position: Vec3Like;
  distance: number;
};

export type StructuredError = {
  code: string;
  message: string;
  retryable: boolean;
  details?: unknown;
};

export type ToolResult = {
  ok: boolean;
  message: string;
  data?: unknown;
  error?: StructuredError;
};

export type SymbolicObservation = {
  health: number;
  food: number;
  position: Vec3Like;
  biome?: string;
  timeOfDay?: number;
  inventory: ItemStack[];
  equippedItem?: string;
  nearbyBlocks: BlockObservation[];
  nearbyEntities: EntityObservation[];
  lastActionResult?: ToolResult;
};

export type TaskName =
  | "early_sequence"
  | "collect_logs"
  | "craft_planks"
  | "craft_sticks"
  | "craft_crafting_table"
  | "craft_wooden_pickaxe"
  | "mine_cobblestone"
  | "craft_stone_pickaxe"
  | "place_furnace"
  | "smelt_iron_ingot";

export type TaskScore = {
  task: TaskName;
  complete: boolean;
  score: number;
  evidence: Record<string, unknown>;
};
