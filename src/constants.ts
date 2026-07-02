import { homedir } from "node:os";
import { resolve } from "node:path";

export const CONFIG_DIR = resolve(homedir(), ".omp", "agent", "omp-langfuse");
export const CONFIG_PATH = resolve(CONFIG_DIR, "config.json");
export const DEFAULT_LANGFUSE_HOST = "https://cloud.langfuse.com";

/** Prices in the bundled table are USD per 1_000_000 tokens. */
export const PRICE_PER_MILLION = 1_000_000;

export const MAX_STRING_LENGTH = 12_000;
export const MAX_TOOL_PAYLOAD_LENGTH = 24_000;
export const MAX_DEPTH = 6;
export const MAX_ARRAY_ITEMS = 50;
export const MAX_OBJECT_KEYS = 80;
export const MAX_PAYLOAD_NODES = 2_000;
